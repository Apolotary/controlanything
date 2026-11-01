/**
 * Malleable edits: apply a Patch to a spec (by id, so untouched items stay byte-identical), and a linear
 * undo/redo history where undo restores an older revision as a NEW revision (nothing is ever lost).
 */
import { Patch, type Gen3dSpec, type PatchOp } from './schema';
import { validateSpec, type Issue } from './validate';

export type PatchResult = { ok: true; spec: Gen3dSpec; warnings: Issue[] } | { ok: false; errors: Issue[]; warnings: Issue[] };

function removePartTree(spec: Gen3dSpec, id: string): void {
  const doomed = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of spec.parts) if (p.parentId && doomed.has(p.parentId) && !doomed.has(p.id)) {
      doomed.add(p.id);
      grew = true;
    }
  }
  spec.parts = spec.parts.filter((p) => !doomed.has(p.id));
  if (spec.behaviors) spec.behaviors = spec.behaviors.filter((b) => !doomed.has(b.partId));
  if (spec.feedback) spec.feedback = spec.feedback.filter((f) => !(f.partId && doomed.has(f.partId)));
}

function removeControl(spec: Gen3dSpec, id: string): void {
  spec.controls = spec.controls.filter((c) => c.id !== id);
  if (spec.behaviors) spec.behaviors = spec.behaviors.filter((b) => b.controlId !== id);
  if (spec.feedback) spec.feedback = spec.feedback.filter((f) => f.controlId !== id);
  for (const p of spec.parts) if (p.controlId === id) delete p.controlId;
}

/** Apply one op in place. Returns an error message or null. */
export function applyOp(spec: Gen3dSpec, op: PatchOp, index = 0): string | null {
  const path = `ops[${index}]`;
  switch (op.op) {
    case 'upsert': {
      const item = op.control ?? op.part ?? op.behavior ?? op.feedback;
      if (!item) return `${path}: upsert needs control, part, behavior or feedback`;
      const col = op.collection ?? (op.control ? 'controls' : op.part ? 'parts' : op.behavior ? 'behaviors' : 'feedback');
      const list = (spec[col] ??= []) as { id: string }[];
      const i = list.findIndex((x) => x.id === item.id);
      if (i >= 0) list[i] = item;
      else list.push(item);
      return null;
    }
    case 'remove': {
      if (!op.collection || !op.id) return `${path}: remove needs collection and id`;
      if (op.collection === 'parts') removePartTree(spec, op.id);
      else if (op.collection === 'controls') removeControl(spec, op.id);
      else {
        const list = (spec[op.collection] ?? []) as { id: string }[];
        (spec as Record<string, unknown>)[op.collection] = list.filter((x) => x.id !== op.id);
      }
      return null;
    }
    case 'set': {
      let touched = false;
      if (op.title !== undefined) (spec.title = op.title), (touched = true);
      if (op.anchor !== undefined) (spec.anchor = op.anchor), (touched = true);
      if (op.state !== undefined) (spec.state = op.state), (touched = true);
      if (op.device !== undefined) (spec.device = op.device), (touched = true);
      if (op.notes !== undefined) (spec.notes = op.notes), (touched = true);
      return touched ? null : `${path}: set needs one of title, anchor, state, device, notes`;
    }
  }
  return `${path}: unknown op`;
}

/** Apply a patch to a spec; the result is validated and carries rev+1. The input spec is not mutated. */
export function applyPatch(base: Gen3dSpec, patchInput: unknown): PatchResult {
  const parsed = Patch.safeParse(patchInput);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => ({ code: `patch.${i.code}`, path: i.path.join('.'), message: i.message })), warnings: [] };
  const patch = parsed.data;
  if (patch.specId !== base.specId) return { ok: false, errors: [{ code: 'patch.spec', path: 'specId', message: `patch is for "${patch.specId}", spec is "${base.specId}"` }], warnings: [] };
  if (patch.baseRev !== base.rev) return { ok: false, errors: [{ code: 'patch.conflict', path: 'baseRev', message: `patch targets rev ${patch.baseRev}, spec is at rev ${base.rev}` }], warnings: [] };
  const next = structuredClone(base);
  const errors: Issue[] = [];
  patch.ops.forEach((op, i) => {
    const e = applyOp(next, op, i);
    if (e) errors.push({ code: 'patch.op', path: `ops[${i}]`, message: e });
  });
  if (errors.length) return { ok: false, errors, warnings: [] };
  next.rev = base.rev + 1;
  const v = validateSpec(next);
  if (!v.ok) return { ok: false, errors: v.errors, warnings: v.warnings };
  return { ok: true, spec: v.spec, warnings: v.warnings };
}

/** Linear revision history with non-destructive undo (undo = re-publish rev-1's content as a new rev). */
export class SpecHistory {
  private revs: Gen3dSpec[] = [];
  /** index into revs of the spec currently shown */
  private cursor = -1;

  constructor(initial?: Gen3dSpec) {
    if (initial) this.push(initial);
  }

  get current(): Gen3dSpec | undefined {
    return this.revs[this.cursor];
  }
  get length(): number {
    return this.revs.length;
  }
  get canUndo(): boolean {
    return this.cursor > 0;
  }
  get canRedo(): boolean {
    return this.cursor < this.revs.length - 1;
  }

  /** Append a revision (drops any redo branch). */
  push(spec: Gen3dSpec): Gen3dSpec {
    this.revs = this.revs.slice(0, this.cursor + 1);
    this.revs.push(spec);
    this.cursor = this.revs.length - 1;
    return spec;
  }

  /** Apply a patch to the current spec and push the result. */
  apply(patch: unknown): PatchResult {
    const cur = this.current;
    if (!cur) return { ok: false, errors: [{ code: 'history.empty', path: '', message: 'no spec to patch' }], warnings: [] };
    const r = applyPatch(cur, patch);
    if (r.ok) this.push(r.spec);
    return r;
  }

  /** Step back; returns the spec to show (same content as the previous rev, numbered rev+1 so clients see a change). */
  undo(): Gen3dSpec | undefined {
    if (!this.canUndo) return undefined;
    this.cursor--;
    const prev = this.revs[this.cursor]!;
    const latest = Math.max(...this.revs.map((r) => r.rev));
    return { ...structuredClone(prev), rev: latest + 1 };
  }

  redo(): Gen3dSpec | undefined {
    if (!this.canRedo) return undefined;
    this.cursor++;
    const next = this.revs[this.cursor]!;
    const latest = Math.max(...this.revs.map((r) => r.rev));
    return { ...structuredClone(next), rev: latest + 1 };
  }
}
