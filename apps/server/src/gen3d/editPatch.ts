/**
 * Edits: the model writes an EditSet (collections of complete items to upsert + ids to remove, every key
 * required). A flat op list with optional payloads lets the Meta decoder skip the payload (research/12,
 * finding 3), so the op list is built here and applied with packages/gen3d's applyPatch (by id, validated,
 * rev+1). Then: driver-binding checks on every control, a byte-identity proof for untouched items, and the
 * hack set is brought in line with the edited controls.
 */
import { applyPatch, Behavior, Collection, Control, Feedback, type Gen3dSpec, Id, Part, type PatchOp } from '@ce/gen3d';
import { z } from 'zod';
import { issue, type Issue } from './issues';
import type { ForgeDriver } from './forgeTypes';
import type { Hack, HackArchetypeName, HackSet } from './hackset';

export const EditSet = z.object({
  behaviors: z.array(Behavior).max(16),
  controls: z.array(Control).max(12),
  feedback: z.array(Feedback).max(16),
  parts: z.array(Part).max(40),
  remove: z.array(z.object({ collection: Collection, id: Id })).max(32),
  summary: z.string().max(120),
  /** "" = keep the title */
  title: z.string().max(40),
});
export type EditSet = z.infer<typeof EditSet>;

export function editSetToOps(e: EditSet): PatchOp[] {
  const ops: PatchOp[] = [
    ...e.remove.map((r) => ({ op: 'remove' as const, collection: r.collection, id: r.id })),
    ...e.controls.map((control) => ({ op: 'upsert' as const, collection: 'controls' as const, control })),
    ...e.parts.map((part) => ({ op: 'upsert' as const, collection: 'parts' as const, part })),
    ...e.behaviors.map((behavior) => ({ op: 'upsert' as const, collection: 'behaviors' as const, behavior })),
    ...e.feedback.map((feedback) => ({ op: 'upsert' as const, collection: 'feedback' as const, feedback })),
  ];
  if (e.title.trim()) ops.push({ op: 'set', title: e.title.trim().slice(0, 40) });
  return ops;
}

export interface AppliedEdit {
  ok: boolean;
  spec?: Gen3dSpec;
  issues: Issue[];
  /** collection:id keys the edit changed (incl. removals and cascades) */
  touched: string[];
  /** every item the edit did not touch serialises exactly as before */
  untouchedIdentical: boolean;
}

const COLLECTIONS = ['controls', 'parts', 'behaviors', 'feedback'] as const;

function itemMap(spec: Gen3dSpec): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of COLLECTIONS) for (const x of (spec[c] ?? []) as { id: string }[]) m.set(`${c}:${x.id}`, JSON.stringify(x));
  for (const k of ['title', 'anchor', 'state', 'device', 'notes'] as const) m.set(k, JSON.stringify(spec[k] ?? null));
  return m;
}

/** Driver checks for edited specs: every control binds to a driver action with a range inside it. */
export function bindingIssues(spec: Gen3dSpec, driver: ForgeDriver): Issue[] {
  const out: Issue[] = [];
  const byId = new Map(driver.actions.map((a) => [a.actionId, a]));
  spec.controls.forEach((c, i) => {
    for (const [key, b] of [['binding', c.binding], ['yBinding', c.yBinding]] as const) {
      if (!b) continue;
      const a = byId.get(b.action);
      const at = `controls[${i}].${key}.action`;
      if (!a) {
        out.push(issue('bindings', 'unknown_action', at, `"${b.action}" is not a driver action; use one of: ${[...byId.keys()].join(', ')}`));
        continue;
      }
      const r = key === 'binding' ? c.range : c.yRange;
      if (a.kind === 'set' && a.range && r && (r.min < a.range.min || r.max > a.range.max)) {
        out.push(issue('bindings', 'value_range', `controls[${i}].${key === 'binding' ? 'range' : 'yRange'}`, `range ${r.min}..${r.max} must lie inside ${a.actionId}'s ${a.range.min}..${a.range.max}`));
      }
      const stepper = b.args?.drive === 'stepper';
      if (a.kind === 'trigger' && c.kind !== 'trigger' && !(stepper && c.kind === 'stepped')) out.push(issue('bindings', 'kind', `controls[${i}].kind`, `${a.actionId} is a trigger: the control kind must be "trigger" (or "stepped" with args.drive "stepper")`));
      if (a.kind === 'toggle' && !['toggle', 'trigger'].includes(c.kind)) out.push(issue('bindings', 'kind', `controls[${i}].kind`, `${a.actionId} is a toggle: the control kind must be "toggle"`));
    }
  });
  return out;
}

export function applyEdit(base: Gen3dSpec, edit: EditSet, driver: ForgeDriver): AppliedEdit {
  const ops = editSetToOps(edit);
  if (!ops.length) return { ok: false, issues: [issue('schema', 'empty_edit', '(root)', 'the edit changes nothing: list the items to change')], touched: [], untouchedIdentical: true };
  const r = applyPatch(base, { specId: base.specId, baseRev: base.rev, ops, reason: edit.summary.slice(0, 120) || undefined });
  if (!r.ok) {
    return { ok: false, issues: r.errors.map((e) => issue(e.code.startsWith('patch') ? 'schema' : 'geometry', e.code, e.path, e.message)), touched: [], untouchedIdentical: true };
  }
  const before = itemMap(base);
  const after = itemMap(r.spec);
  const named = new Set<string>(ops.map((o) => (o.op === 'set' ? 'title' : `${o.collection}:${o.control?.id ?? o.part?.id ?? o.behavior?.id ?? o.feedback?.id ?? o.id}`)));
  const touched = new Set<string>();
  let untouchedIdentical = true;
  for (const [k, v] of before) {
    if (after.get(k) === v) continue;
    touched.add(k);
    // a change the edit did not name is a cascade (e.g. removing a part drops its behaviours) or a bug
    if (!named.has(k) && !k.startsWith('behaviors:') && !k.startsWith('feedback:') && !(k.startsWith('parts:') && !after.has(k))) untouchedIdentical = false;
  }
  for (const k of after.keys()) if (!before.has(k)) touched.add(k);
  const issues = bindingIssues(r.spec, driver);
  return { ok: !issues.some((i) => i.severity === 'error'), spec: r.spec, issues, touched: [...touched], untouchedIdentical };
}

// --- keep the hack set in line with an edited spec -------------------------------------------------

const BACK: Partial<Record<string, HackArchetypeName>> = {
  knob: 'knob',
  fader: 'slider',
  'dimmer-ring': 'ring',
  'xy-orb': 'xy',
  pads: 'pads',
  toggle: 'toggle',
  button: 'button',
  lever: 'lever',
  wheel: 'slider',
  'pull-cord': 'toggle',
};

/** size-"m" defaults of the archetypes' size param (packages/gen3d) */
const DEFAULT_SIZE: Record<string, ['size' | 'length' | 'width', number]> = {
  knob: ['size', 0.064],
  fader: ['length', 0.16],
  lever: ['length', 0.12],
  'dimmer-ring': ['size', 0.14],
  'xy-orb': ['size', 0.16],
  button: ['size', 0.05],
  toggle: ['width', 0.072],
  pads: ['size', 0.06],
  wheel: ['size', 0.14],
};

function sizeOf(part: { archetype?: string; params?: Record<string, unknown> } | undefined): 's' | 'm' | 'l' | undefined {
  const d = part?.archetype ? DEFAULT_SIZE[part.archetype] : undefined;
  const v = d ? part?.params?.[d[0]] : undefined;
  if (!d || typeof v !== 'number') return undefined;
  const ratio = v / d[1];
  return ratio >= 1.2 ? 'l' : ratio <= 0.85 ? 's' : 'm';
}

const ORACLE_FROM_SENSE: Record<string, Hack['oracle']['type']> = { camera: 'camera', audio: 'mic', ack: 'wire', none: 'none' };

function oracleFor(driver: ForgeDriver, action: string, control: boolean): Hack['oracle'] {
  const e = driver.actions.find((a) => a.actionId === action)?.expect;
  if (!e || e.sense === 'none') return { type: 'none', expect: 'serial_ack', reason: 'no observable effect declared' };
  const type = ORACLE_FROM_SENSE[e.sense] ?? 'none';
  const map: Record<string, Hack['oracle']['expect']> = { on: 'on', off: 'off', brighter: 'brighter', dimmer: 'dimmer', warmer: 'warmer', cooler: 'cooler', louder: 'louder', quieter: 'quieter', 'tone-up': 'centroid_up', 'tone-down': 'centroid_down' };
  const expect = control && type === 'camera' ? 'luminance_tracks_param' : (map[e.effect] ?? (type === 'mic' ? 'louder' : 'screen_changed'));
  return { type, expect };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'x';

/** New/changed/removed controls -> the hack set (names, ranges, archetypes, accents follow the spec). */
export function syncHackset(hackset: HackSet, spec: Gen3dSpec, driver: ForgeDriver): HackSet {
  const byControl = new Map(spec.controls.map((c) => [c.id, c]));
  const partOf = new Map(spec.parts.filter((p) => p.kind === 'archetype' && p.controlId).map((p) => [p.controlId!, p]));
  const hacks: Hack[] = [];
  for (const h of hackset.hacks) {
    const c = byControl.get(h.id);
    if (!c) continue; // removed
    const next: Hack = structuredClone(h);
    const part = partOf.get(c.id);
    const arch = part?.archetype ? BACK[part.archetype] : undefined;
    if (next.kind === 'control' && next.control) {
      if (arch) next.control.archetype = arch;
      const size = sizeOf(part);
      if (size) next.control.size = size;
      const p = next.params?.find((x) => x.id === next.control!.param);
      if (p && c.range) Object.assign(p, { min: c.range.min, max: c.range.max, ...(c.range.step ? { step: c.range.step } : {}) });
    }
    hacks.push(next);
  }
  for (const c of spec.controls) {
    if (hackset.hacks.some((h) => h.id === c.id)) continue;
    if (!driver.actions.some((a) => a.actionId === c.binding.action)) continue;
    const isControl = c.kind !== 'trigger';
    const pid = `p_${slug(c.label)}`.slice(0, 32);
    const part = partOf.get(c.id);
    const name = c.label.charAt(0) + c.label.slice(1).toLowerCase();
    const h: Hack = {
      id: /^[a-z][a-z0-9_]{0,31}$/.test(c.id) ? c.id : `h_${slug(c.label)}`.slice(0, 32),
      name: name.slice(0, 14),
      kind: isControl ? 'control' : 'action',
      blurb: (c.description ?? '').slice(0, 40),
      commands: [isControl ? { action: c.binding.action, param: pid } : { action: c.binding.action, value: 0 }],
      oracle: oracleFor(driver, c.binding.action, isControl),
      reversible: true,
      max_rate_hz: 2,
    };
    if (isControl) {
      h.params = [{ id: pid, name: name.slice(0, 16), min: c.range?.min ?? 0, max: c.range?.max ?? 1, default: typeof c.default === 'number' ? c.default : (c.range?.min ?? 0), ...(c.range?.step ? { step: c.range.step } : {}) }];
      h.control = { archetype: (part?.archetype && BACK[part.archetype]) || 'knob', size: 'm', param: pid };
      h.inverse = { restore: pid };
    } else {
      h.inverse = { commands: [{ action: c.binding.action, value: 0 }] };
    }
    hacks.push(h);
  }
  return { ...hackset, hacks: hacks.length ? hacks : hackset.hacks };
}
