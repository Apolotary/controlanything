/**
 * DRAFT tool-call surface for gen3d-draft/0: the model assembles a spec with add_control / bind / add_hack /
 * add_daemon / add_part / set_material / remove / done. SpecBuilder applies each call as soon as its arguments
 * finish streaming, so the headset can show the object assembling. Arguments are validated here because the
 * Meta API only guides tool arguments by the schema; it does not guarantee them (docs: tool-calling).
 */
import { toJsonSchema } from '@ce/protocol';
import { z } from 'zod';
import { CATALOG, DEFAULT_MATERIAL } from './catalog';
import {
  Anchor,
  Arg,
  Archetype,
  Behaviour,
  ControlKind,
  Daemon,
  DRAFT_VERSION,
  Expect,
  Hack,
  Hex,
  Part,
  Slug,
  type Spec,
  Vec3,
} from './spec';
import type { ToolDef } from '../stream';

export const AddControlArgs = z.object({
  id: Slug,
  label: z.string().min(1).max(16),
  kind: ControlKind,
  min: z.number(),
  max: z.number(),
  step: z.number().min(0),
  default: z.number(),
  unit: z.string().max(8),
  expect: Expect,
  archetype: Archetype,
  position: Vec3,
  scale: z.number().min(0.5).max(2.5),
  rotation: Vec3.optional(),
  behaviour: Behaviour.optional(),
});
export const BindArgs = z.object({ controlId: Slug, action: z.string().max(64), args: z.array(Arg).max(6), valueArg: z.string().max(32) });
export const AddPartArgs = z.object({ objectId: Slug, part: Part });
export const SetMaterialArgs = z.object({
  target: z.string().max(32),
  color: Hex,
  emissive: Hex.optional(),
  metalness: z.number().min(0).max(1).optional(),
  roughness: z.number().min(0).max(1).optional(),
});
export const RemoveArgs = z.object({ target: z.string().max(32) });
export const DoneArgs = z.object({ title: z.string().min(1).max(60), anchor: Anchor, notes: z.string().max(400) });

const TOOL_SCHEMAS = {
  add_control: [AddControlArgs, 'Add or replace a control and its 3D object (same id). Behaviour defaults to the archetype\'s catalog default.'],
  bind: [BindArgs, 'Bind a control to one driver action. valueArg = the param that gets the live value ("" for none).'],
  add_hack: [Hack, 'Add or replace a named one-shot hack: a short sequence of driver actions with the effect the oracle should see.'],
  add_daemon: [Daemon, 'Add or replace a daemon: a signal from one paired device drives an action on another, rate-capped.'],
  add_part: [AddPartArgs, 'Add or replace an extra primitive part on an existing object (decoration, grip, glow).'],
  set_material: [SetMaterialArgs, 'Set the material of an object (or the colour of a part) by id.'],
  remove: [RemoveArgs, 'Remove a control (and its object), hack, daemon, object or part by id.'],
  done: [DoneArgs, 'Finish: title, anchor and a one-line note. Call once, last.'],
} as const satisfies Record<string, readonly [z.ZodType, string]>;

export type ToolName = keyof typeof TOOL_SCHEMAS;
export const TOOL_NAMES = Object.keys(TOOL_SCHEMAS) as ToolName[];

export function toolDefs(names: ToolName[] = TOOL_NAMES): ToolDef[] {
  return names.map((name) => {
    const [schema, description] = TOOL_SCHEMAS[name];
    const { $schema: _drop, ...parameters } = toJsonSchema(schema);
    return { type: 'function', function: { name, description, parameters } };
  });
}

export interface AppliedItem {
  kind: 'control' | 'binding' | 'hack' | 'daemon' | 'part' | 'material' | 'removed' | 'done';
  id: string;
}

export interface ToolOutcome {
  ok: boolean;
  /** what goes back to the model as the tool message */
  result: string;
  item?: AppliedItem;
}

function errs(e: z.ZodError): string[] {
  return e.issues.slice(0, 8).map((i) => `${i.path.length ? i.path.join('.') : '(args)'}: ${i.message}`);
}

/** Holds a spec under construction (or under edit) and applies tool calls to it. */
export class SpecBuilder {
  readonly spec: Spec;
  done = false;
  calls = 0;
  failures = 0;

  constructor(device: { cardId: string; name: string; category?: string }, current?: Spec) {
    this.spec = current
      ? (structuredClone(current) as Spec)
      : {
          version: DRAFT_VERSION,
          title: device.name.slice(0, 60) || 'Controls',
          device: { cardId: device.cardId, name: device.name.slice(0, 80) },
          anchor: { target: device.category === 'lighting' ? 'panel' : 'device', side: 'right', offset: { x: 0, y: 0, z: 0 }, facing: 'user' },
          hacks: [],
          controls: [],
          objects: [],
          daemons: [],
          notes: '',
        };
  }

  apply(name: string, rawArgs: string): ToolOutcome {
    this.calls++;
    let args: unknown;
    try {
      args = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    } catch {
      return this.fail(`arguments are not valid JSON: ${rawArgs.slice(0, 120)}`);
    }
    if (!(name in TOOL_SCHEMAS)) return this.fail(`unknown tool "${name}"; tools: ${TOOL_NAMES.join(', ')}`);
    const [schema] = TOOL_SCHEMAS[name as ToolName];
    const parsed = (schema as z.ZodType).safeParse(args);
    if (!parsed.success) return this.fail(errs(parsed.error).join('; '));
    const a = parsed.data as any;
    const s = this.spec;
    switch (name as ToolName) {
      case 'add_control': {
        const prev = s.controls.find((c) => c.id === a.id);
        const control = {
          id: a.id,
          label: a.label,
          kind: a.kind,
          min: a.min,
          max: a.max,
          step: a.step,
          default: a.default,
          unit: a.unit,
          binding: prev?.binding ?? { action: '', args: [], valueArg: '' },
          expect: a.expect,
        };
        upsert(s.controls, control);
        const prevObj = s.objects.find((o) => o.controlId === a.id || o.id === a.id);
        const archetypeChanged = prevObj && prevObj.archetype !== a.archetype;
        upsert(s.objects, {
          id: prevObj?.id ?? a.id,
          controlId: a.id,
          archetype: a.archetype,
          label: a.label,
          position: a.position,
          rotation: a.rotation ?? prevObj?.rotation ?? { x: 0, y: 0, z: 0 },
          scale: a.scale,
          material: prevObj?.material ?? { ...DEFAULT_MATERIAL },
          behaviour: a.behaviour ?? (archetypeChanged || !prevObj ? { ...CATALOG[a.archetype as keyof typeof CATALOG].behaviour } : prevObj.behaviour),
          parts: archetypeChanged ? [] : (prevObj?.parts ?? []),
        });
        return this.ok({ kind: 'control', id: a.id });
      }
      case 'bind': {
        const c = s.controls.find((x) => x.id === a.controlId);
        if (!c) return this.fail(`no control "${a.controlId}"; call add_control first`);
        c.binding = { action: a.action, args: a.args, valueArg: a.valueArg };
        return this.ok({ kind: 'binding', id: a.controlId });
      }
      case 'add_hack':
        upsert(s.hacks, a);
        return this.ok({ kind: 'hack', id: a.id });
      case 'add_daemon':
        upsert(s.daemons, a);
        return this.ok({ kind: 'daemon', id: a.id });
      case 'add_part': {
        const o = s.objects.find((x) => x.id === a.objectId);
        if (!o) return this.fail(`no object "${a.objectId}"`);
        if (!o.parts.some((p) => p.id === a.part.id) && o.parts.length >= 6) return this.fail(`object "${a.objectId}" already has 6 parts`);
        upsert(o.parts, a.part);
        return this.ok({ kind: 'part', id: a.part.id });
      }
      case 'set_material': {
        const o = s.objects.find((x) => x.id === a.target || x.controlId === a.target);
        if (o) {
          o.material = {
            color: a.color,
            emissive: a.emissive ?? o.material.emissive,
            metalness: a.metalness ?? o.material.metalness,
            roughness: a.roughness ?? o.material.roughness,
          };
          return this.ok({ kind: 'material', id: o.id });
        }
        for (const ob of s.objects) {
          const p = ob.parts.find((x) => x.id === a.target);
          if (p) {
            p.color = a.color;
            return this.ok({ kind: 'material', id: p.id });
          }
        }
        return this.fail(`no object or part "${a.target}"`);
      }
      case 'remove': {
        const id = a.target as string;
        const before = s.controls.length + s.objects.length + s.hacks.length + s.daemons.length;
        s.controls = s.controls.filter((c) => c.id !== id);
        s.objects = s.objects.filter((o) => o.id !== id && o.controlId !== id);
        s.hacks = s.hacks.filter((h) => h.id !== id);
        s.daemons = s.daemons.filter((d) => d.id !== id);
        let removed = before - (s.controls.length + s.objects.length + s.hacks.length + s.daemons.length);
        for (const o of s.objects) {
          const n = o.parts.length;
          o.parts = o.parts.filter((p) => p.id !== id);
          removed += n - o.parts.length;
        }
        return removed ? this.ok({ kind: 'removed', id }) : this.fail(`nothing has id "${id}"`);
      }
      case 'done':
        s.title = a.title;
        s.anchor = a.anchor;
        s.notes = a.notes;
        this.done = true;
        return this.ok({ kind: 'done', id: 'done' });
    }
  }

  private ok(item: AppliedItem): ToolOutcome {
    return { ok: true, result: JSON.stringify({ ok: true }), item };
  }

  private fail(message: string): ToolOutcome {
    this.failures++;
    return { ok: false, result: JSON.stringify({ ok: false, error: message }) };
  }
}

function upsert<T extends { id: string }>(list: T[], item: T): void {
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) list[i] = item;
  else list.push(item);
}
