/**
 * DRAFT patch application for gen3d-draft/0. Id-based ops only touch the items they name; every other item
 * keeps its exact object (so it serialises byte-identically), which `untouchedIdentical` proves.
 */
import type { Patch, PatchSet, Spec } from './spec';

export interface PatchResult {
  spec: Spec;
  /** ids the patch changed (incl. removed) */
  touched: string[];
  errors: string[];
}

type Keyed = { id: string };

function upsert<T extends Keyed>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const out = list.slice();
  out[i] = item;
  return out;
}

export function applyDraftPatch(base: Spec, patch: Patch): PatchResult {
  // shallow copies: untouched items stay the same objects
  let spec: Spec = { ...base, controls: base.controls.slice(), objects: base.objects.slice(), hacks: base.hacks.slice(), daemons: base.daemons.slice() };
  const touched = new Set<string>();
  const errors: string[] = [];
  patch.ops.forEach((op, i) => {
    const need = <T>(v: T | undefined, field: string): v is T => {
      if (v === undefined) errors.push(`ops[${i}]: ${op.action} needs "${field}"`);
      return v !== undefined;
    };
    switch (op.action) {
      case 'upsert_control':
        if (need(op.control, 'control')) {
          spec.controls = upsert(spec.controls, op.control);
          touched.add(op.control.id);
        }
        break;
      case 'upsert_object':
        if (need(op.object, 'object')) {
          spec.objects = upsert(spec.objects, op.object);
          touched.add(op.object.id);
        }
        break;
      case 'upsert_hack':
        if (need(op.hack, 'hack')) {
          spec.hacks = upsert(spec.hacks, op.hack);
          touched.add(op.hack.id);
        }
        break;
      case 'upsert_daemon':
        if (need(op.daemon, 'daemon')) {
          spec.daemons = upsert(spec.daemons, op.daemon);
          touched.add(op.daemon.id);
        }
        break;
      case 'remove': {
        const id = op.target;
        const n = spec.controls.length + spec.objects.length + spec.hacks.length + spec.daemons.length;
        spec = {
          ...spec,
          controls: spec.controls.filter((x) => x.id !== id),
          objects: spec.objects.filter((x) => x.id !== id && x.controlId !== id),
          hacks: spec.hacks.filter((x) => x.id !== id),
          daemons: spec.daemons.filter((x) => x.id !== id),
        };
        if (n === spec.controls.length + spec.objects.length + spec.hacks.length + spec.daemons.length) errors.push(`ops[${i}]: nothing has id "${id}"`);
        touched.add(id);
        break;
      }
      case 'set_anchor':
        if (need(op.anchor, 'anchor')) {
          spec.anchor = op.anchor;
          touched.add('anchor');
        }
        break;
      case 'set_title':
        if (need(op.title, 'title')) {
          spec.title = op.title;
          touched.add('title');
        }
        break;
    }
  });
  return { spec, touched: [...touched], errors };
}

/** Ids whose serialisation changed between two specs (added, removed or edited). */
export function changedIds(before: Spec, after: Spec): string[] {
  const out = new Set<string>();
  for (const key of ['controls', 'objects', 'hacks', 'daemons'] as const) {
    const a = new Map((before[key] as Keyed[]).map((x) => [x.id, JSON.stringify(x)]));
    const b = new Map((after[key] as Keyed[]).map((x) => [x.id, JSON.stringify(x)]));
    for (const [id, s] of a) if (b.get(id) !== s) out.add(id);
    for (const id of b.keys()) if (!a.has(id)) out.add(id);
  }
  if (JSON.stringify(before.anchor) !== JSON.stringify(after.anchor)) out.add('anchor');
  if (before.title !== after.title) out.add('title');
  return [...out];
}

/** The model-facing PatchSet as id-based ops (removals first, then upserts). title "" = unchanged. */
export function patchSetToPatch(p: PatchSet): Patch {
  const ops: Patch['ops'] = [
    ...p.remove.map((target) => ({ action: 'remove' as const, target })),
    ...p.controls.map((control) => ({ action: 'upsert_control' as const, target: control.id, control })),
    ...p.objects.map((object) => ({ action: 'upsert_object' as const, target: object.id, object })),
    ...p.hacks.map((hack) => ({ action: 'upsert_hack' as const, target: hack.id, hack })),
    ...p.daemons.map((daemon) => ({ action: 'upsert_daemon' as const, target: daemon.id, daemon })),
  ];
  if (p.title) ops.push({ action: 'set_title', target: 'title', title: p.title });
  if (p.anchor) ops.push({ action: 'set_anchor', target: 'anchor', anchor: p.anchor });
  return { summary: p.summary, ops };
}
