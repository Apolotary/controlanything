/**
 * Semantic validation on top of the zod schema: ids, references, part-tree depth, archetype/control
 * compatibility, target sizes, geometry sanity and the poly budget (after archetype expansion).
 * Order-independent: the Meta constrained decoder emits keys alphabetically (behaviors before controls and
 * parts), so everything is checked after the whole document is parsed.
 */
import { z } from 'zod';
import { ARCHETYPE_CONTROL_KINDS, INTERACTIVE_ARCHETYPES, expandSpec } from './archetypes';
import { Gen3dSpec, LIMITS, type Behavior, type Control, type Part } from './schema';

export interface Issue {
  code: string;
  /** JSON-pointer-ish path, e.g. "parts[3].parentId" */
  path: string;
  message: string;
}

export interface SpecStats {
  controls: number;
  parts: number;
  expandedParts: number;
  behaviors: number;
  feedback: number;
  triangles: number;
  /** bounding box of root-level part positions, metres */
  extent: [number, number, number];
  depth: number;
}

export type ValidationResult =
  | { ok: true; spec: Gen3dSpec; errors: []; warnings: Issue[]; stats: SpecStats }
  | { ok: false; spec?: Gen3dSpec; errors: Issue[]; warnings: Issue[]; stats?: SpecStats };

function zodIssues(error: z.ZodError): Issue[] {
  return error.issues.slice(0, 40).map((i) => ({
    code: `schema.${i.code}`,
    path: i.path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`)).join('').replace(/^\./, '') || '(root)',
    message: i.message,
  }));
}

/** Triangle estimate per primitive, for the budget. */
export function estimateTriangles(part: Part): number {
  if (part.kind === 'text') return 2;
  if (part.kind === 'path') return (part.path?.points?.length ?? 2) * 8 + (part.path?.particles ?? 0) * 2;
  if (part.kind !== 'primitive') return 0;
  const d = part.dims ?? {};
  const seg = d.segments ?? 32;
  switch (part.shape) {
    case 'box':
      return d.radius ? 12 * 6 : 12;
    case 'plane':
      return 2;
    case 'cylinder':
    case 'cone':
      return seg * 4;
    case 'sphere':
      return seg * Math.ceil(seg / 2) * 2;
    case 'capsule':
      return seg * 16;
    case 'torus':
      return seg * 12 * 2;
    case 'ring':
      return seg * 2;
    case 'lathe':
      return (d.profile?.length ?? 4) * seg * 2;
    case 'extrude':
      return (d.profile?.length ?? 4) * 6;
    default:
      return 12;
  }
}

/** Required dims per shape (others get defaults in the renderer). */
const REQUIRED_DIMS: Record<string, string[]> = {
  box: [],
  plane: [],
  cylinder: [],
  sphere: ['r'],
  torus: ['r'],
  capsule: ['r'],
  cone: ['r'],
  ring: ['rOuter'],
  lathe: ['profile'],
  extrude: ['profile'],
};

const BEHAVIOR_KINDS: Record<Behavior['type'], readonly Control['kind'][]> = {
  rotate: ['continuous', 'stepped', 'toggle'],
  slide: ['continuous', 'stepped'],
  press: ['trigger', 'toggle'],
  toggle: ['toggle', 'trigger'],
  pull: ['trigger', 'toggle', 'stepped'],
  xy: ['xy'],
  grab: [],
};

export function validateSpec(input: unknown): ValidationResult {
  const parsed = Gen3dSpec.safeParse(input);
  if (!parsed.success) return { ok: false, errors: zodIssues(parsed.error), warnings: [] };
  const spec = parsed.data;
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const err = (code: string, path: string, message: string) => errors.push({ code, path, message });
  const warn = (code: string, path: string, message: string) => warnings.push({ code, path, message });

  // ids
  const controlIds = new Map<string, Control>();
  spec.controls.forEach((c, i) => {
    if (controlIds.has(c.id)) err('id.duplicate', `controls[${i}].id`, `duplicate control id "${c.id}"`);
    controlIds.set(c.id, c);
  });
  const partIds = new Map<string, Part>();
  spec.parts.forEach((p, i) => {
    if (partIds.has(p.id)) err('id.duplicate', `parts[${i}].id`, `duplicate part id "${p.id}"`);
    if (p.id.startsWith('_')) err('id.reserved', `parts[${i}].id`, `ids starting with "_" are reserved for the renderer`);
    partIds.set(p.id, p);
  });
  const seenB = new Set<string>();
  (spec.behaviors ?? []).forEach((b, i) => {
    if (seenB.has(b.id)) err('id.duplicate', `behaviors[${i}].id`, `duplicate behavior id "${b.id}"`);
    seenB.add(b.id);
  });
  const seenF = new Set<string>();
  (spec.feedback ?? []).forEach((f, i) => {
    if (seenF.has(f.id)) err('id.duplicate', `feedback[${i}].id`, `duplicate feedback id "${f.id}"`);
    seenF.add(f.id);
  });

  // controls
  spec.controls.forEach((c, i) => {
    const path = `controls[${i}]`;
    if (c.range && c.range.min >= c.range.max) err('control.range', `${path}.range`, `min must be < max`);
    if (c.kind === 'stepped' && !(c.range?.step || c.stepLabels?.length)) err('control.step', `${path}.range.step`, `a stepped control needs range.step or stepLabels`);
    if (c.kind === 'xy' && !c.yBinding) warn('control.yBinding', `${path}.yBinding`, `xy control has no y binding; y will be reported but drive nothing`);
    if (c.kind !== 'xy' && c.yBinding) warn('control.yBinding', `${path}.yBinding`, `only xy controls use yBinding`);
    if (typeof c.default === 'number' && c.range && (c.default < c.range.min || c.default > c.range.max)) err('control.default', `${path}.default`, `default ${c.default} outside range`);
  });

  // part tree: parents exist, no cycles, depth
  let maxDepth = 0;
  spec.parts.forEach((p, i) => {
    const path = `parts[${i}]`;
    if (p.parentId && !partIds.has(p.parentId)) err('part.parent', `${path}.parentId`, `parent "${p.parentId}" does not exist`);
    if (p.parentId === p.id) err('part.cycle', `${path}.parentId`, `a part cannot be its own parent`);
    // depth
    let depth = 1;
    let cur: Part | undefined = p;
    const seen = new Set<string>([p.id]);
    while (cur?.parentId) {
      const parent = partIds.get(cur.parentId);
      if (!parent) break;
      if (seen.has(parent.id)) {
        err('part.cycle', `${path}.parentId`, `cycle through "${parent.id}"`);
        break;
      }
      seen.add(parent.id);
      depth++;
      cur = parent;
      if (depth > LIMITS.partDepth + 1) break;
    }
    maxDepth = Math.max(maxDepth, depth);
    if (depth > LIMITS.partDepth) err('part.depth', `${path}.parentId`, `part nests ${depth} levels; max ${LIMITS.partDepth}`);

    // kind-specific
    switch (p.kind) {
      case 'primitive': {
        if (!p.shape) err('part.shape', `${path}.shape`, `a primitive needs a shape`);
        else {
          for (const k of REQUIRED_DIMS[p.shape] ?? []) if ((p.dims as Record<string, unknown> | undefined)?.[k] === undefined) err('part.dims', `${path}.dims.${k}`, `${p.shape} needs dims.${k}`);
        }
        break;
      }
      case 'archetype': {
        if (!p.archetype) {
          err('part.archetype', `${path}.archetype`, `an archetype part needs an archetype name`);
          break;
        }
        const interactive = INTERACTIVE_ARCHETYPES.has(p.archetype);
        if (interactive && !p.controlId) err('archetype.control', `${path}.controlId`, `${p.archetype} needs a controlId`);
        if (p.controlId) {
          const c = controlIds.get(p.controlId);
          if (!c) err('ref.control', `${path}.controlId`, `control "${p.controlId}" does not exist`);
          else {
            const kinds = ARCHETYPE_CONTROL_KINDS[p.archetype];
            if (kinds.length && !kinds.includes(c.kind)) err('archetype.kind', `${path}.controlId`, `${p.archetype} cannot operate a ${c.kind} control (allowed: ${kinds.join(', ')})`);
          }
        }
        const size = p.params?.size;
        if (interactive && size !== undefined && size < LIMITS.minTargetM) warn('size.target', `${path}.params.size`, `${size} m is below the ${LIMITS.minTargetM} m hand target; the renderer will enlarge it`);
        if (p.params?.items) {
          p.params.items.forEach((it, k) => {
            if (it.controlId && !controlIds.has(it.controlId)) err('ref.control', `${path}.params.items[${k}].controlId`, `control "${it.controlId}" does not exist`);
          });
        }
        if ((p.archetype === 'outline' || p.archetype === 'twin') && !p.params?.contour && !p.params?.boxSize) warn('archetype.contour', `${path}.params.contour`, `${p.archetype} without contour or boxSize draws a default rectangle`);
        break;
      }
      case 'text': {
        if (!p.text) err('part.text', `${path}.text`, `a text part needs text`);
        else if ((p.text.heightM ?? 0.009) < LIMITS.minTextM) warn('size.text', `${path}.text.heightM`, `text below ${LIMITS.minTextM} m is unreadable in passthrough`);
        break;
      }
      case 'path': {
        if (!p.path) err('part.path', `${path}.path`, `a path part needs path`);
        else if (!p.path.points && !(p.path.from && p.path.to)) err('part.path', `${path}.path`, `a path needs from+to or points`);
        break;
      }
      case 'group':
        break;
    }
    if (p.controlId && p.kind !== 'archetype' && !controlIds.has(p.controlId)) err('ref.control', `${path}.controlId`, `control "${p.controlId}" does not exist`);
    if (p.material?.flicker && p.material.flicker > 0.6) warn('motion.flicker', `${path}.material.flicker`, `strong flicker; the renderer caps it at ${LIMITS.maxFlashHz} Hz`);
  });

  // behaviors
  (spec.behaviors ?? []).forEach((b, i) => {
    const path = `behaviors[${i}]`;
    if (!partIds.has(b.partId)) err('ref.part', `${path}.partId`, `part "${b.partId}" does not exist`);
    if (b.type === 'grab') {
      if (b.controlId) warn('behavior.grab', `${path}.controlId`, `grab behaviours move the object and ignore controlId`);
    } else if (!b.controlId) err('behavior.control', `${path}.controlId`, `${b.type} needs a controlId`);
    else {
      const c = controlIds.get(b.controlId);
      if (!c) err('ref.control', `${path}.controlId`, `control "${b.controlId}" does not exist`);
      else if (!BEHAVIOR_KINDS[b.type].includes(c.kind)) err('behavior.kind', `${path}.type`, `${b.type} cannot drive a ${c.kind} control`);
    }
    if (b.sweepDeg && b.sweepDeg[0] === b.sweepDeg[1]) err('behavior.sweep', `${path}.sweepDeg`, `sweep has zero length`);
    if (b.travel && b.travel[0] === b.travel[1]) err('behavior.travel', `${path}.travel`, `travel has zero length`);
  });

  // feedback
  (spec.feedback ?? []).forEach((f, i) => {
    const path = `feedback[${i}]`;
    if (!controlIds.has(f.controlId)) err('ref.control', `${path}.controlId`, `control "${f.controlId}" does not exist`);
    if (f.partId && !partIds.has(f.partId)) err('ref.part', `${path}.partId`, `part "${f.partId}" does not exist`);
  });

  // every control has a handle
  const handled = new Set<string>();
  for (const p of spec.parts) if (p.kind === 'archetype' && p.controlId && INTERACTIVE_ARCHETYPES.has(p.archetype!)) handled.add(p.controlId);
  for (const p of spec.parts) for (const it of p.params?.items ?? []) if (it.controlId) handled.add(it.controlId);
  for (const p of spec.parts) if (p.kind === 'archetype' && p.controlId && (p.archetype === 'hack-list' || p.archetype === 'deck' || p.archetype === 'daemon-link')) handled.add(p.controlId);
  for (const b of spec.behaviors ?? []) if (b.controlId) handled.add(b.controlId);
  spec.controls.forEach((c, i) => {
    if (!handled.has(c.id)) warn('control.unhandled', `controls[${i}]`, `control "${c.id}" has no archetype or behaviour operating it`);
  });

  // anchor
  if (spec.anchor.mode === 'device' && !spec.anchor.cardId && !spec.device?.cardId) warn('anchor.card', 'anchor.cardId', `device anchor without a cardId; the renderer will fall back to floating`);
  if (spec.anchor.mode === 'world' && !spec.anchor.position) err('anchor.pose', 'anchor.position', `world anchor needs a position`);

  // budget (after expansion), only when references are sound enough to expand
  let stats: SpecStats | undefined;
  if (!errors.some((e) => e.code.startsWith('part.cycle'))) {
    const ex = expandSpec(spec);
    let tris = 0;
    for (const p of ex.parts) tris += estimateTriangles(p);
    const ext: [number, number, number] = [0, 0, 0];
    for (const p of spec.parts) {
      if (p.parentId) continue;
      const pos = p.transform?.position ?? [0, 0, 0];
      for (let k = 0; k < 3; k++) ext[k] = Math.max(ext[k]!, Math.abs(pos[k]!) + 0.1);
    }
    stats = {
      controls: spec.controls.length,
      parts: spec.parts.length,
      expandedParts: ex.parts.length,
      behaviors: ex.behaviors.length,
      feedback: ex.feedback.length,
      triangles: tris,
      extent: [ext[0] * 2, ext[1] * 2, ext[2] * 2],
      depth: maxDepth,
    };
    if (tris > LIMITS.triangles) err('budget.triangles', 'parts', `~${tris} triangles after expansion; budget ${LIMITS.triangles}`);
    if (ex.parts.length > LIMITS.expandedParts) err('budget.parts', 'parts', `${ex.parts.length} parts after expansion; budget ${LIMITS.expandedParts}`);
    if (Math.max(...stats.extent) > LIMITS.extentM) warn('budget.extent', 'parts', `object spans ~${Math.max(...stats.extent).toFixed(2)} m; keep generated objects under ${LIMITS.extentM} m`);
  }

  if (errors.length) return { ok: false, spec, errors, warnings, ...(stats ? { stats } : {}) };
  return { ok: true, spec, errors: [], warnings, stats: stats! };
}

/**
 * Best-effort repairs for a model's output before validation: drop references to missing ids,
 * enlarge undersized targets, clamp defaults. Returns the repaired object and what changed.
 */
export function repairSpec(input: unknown): { spec: unknown; fixes: string[] } {
  const fixes: string[] = [];
  if (!input || typeof input !== 'object') return { spec: input, fixes };
  const s = structuredClone(input) as Record<string, unknown>;
  if (s.spec === undefined) {
    s.spec = 'ce.gen3d/1';
    fixes.push('set spec version');
  }
  if (typeof s.rev !== 'number') {
    s.rev = 1;
    fixes.push('set rev 1');
  }
  const controls = Array.isArray(s.controls) ? (s.controls as Record<string, unknown>[]) : [];
  const parts = Array.isArray(s.parts) ? (s.parts as Record<string, unknown>[]) : [];
  const controlIds = new Set(controls.map((c) => c.id as string));
  const partIds = new Set(parts.map((p) => p.id as string));
  for (const c of controls) {
    const r = c.range as { min?: number; max?: number; step?: number } | undefined;
    if (typeof c.default === 'number' && r && typeof r.min === 'number' && typeof r.max === 'number') {
      const v = c.default;
      const cl = Math.min(r.max, Math.max(r.min, v));
      if (cl !== v) {
        c.default = cl;
        fixes.push(`clamped default of ${String(c.id)}`);
      }
    }
    if (c.kind === 'stepped' && r && !r.step && !Array.isArray(c.stepLabels)) {
      r.step = 1;
      fixes.push(`added step 1 to ${String(c.id)}`);
    }
    if (typeof c.label === 'string' && c.label.length > 16) {
      c.label = c.label.slice(0, 16);
      fixes.push(`shortened label of ${String(c.id)}`);
    }
  }
  for (const p of parts) {
    if (typeof p.parentId === 'string' && !partIds.has(p.parentId)) {
      delete p.parentId;
      fixes.push(`dropped missing parent of ${String(p.id)}`);
    }
    if (typeof p.controlId === 'string' && !controlIds.has(p.controlId)) {
      delete p.controlId;
      fixes.push(`dropped missing control of ${String(p.id)}`);
    }
    const params = p.params as Record<string, unknown> | undefined;
    if (p.kind === 'archetype' && params && typeof params.size === 'number' && INTERACTIVE_ARCHETYPES.has(p.archetype as never) && params.size < LIMITS.minTargetM) {
      params.size = LIMITS.minTargetM;
      fixes.push(`enlarged ${String(p.id)} to ${LIMITS.minTargetM} m`);
    }
  }
  if (Array.isArray(s.behaviors)) {
    const before = (s.behaviors as Record<string, unknown>[]).length;
    s.behaviors = (s.behaviors as Record<string, unknown>[]).filter((b) => partIds.has(b.partId as string) && (b.type === 'grab' || controlIds.has(b.controlId as string)));
    if ((s.behaviors as unknown[]).length !== before) fixes.push(`dropped ${before - (s.behaviors as unknown[]).length} dangling behaviour(s)`);
  }
  if (Array.isArray(s.feedback)) {
    const before = (s.feedback as Record<string, unknown>[]).length;
    s.feedback = (s.feedback as Record<string, unknown>[]).filter((f) => controlIds.has(f.controlId as string) && (!f.partId || partIds.has(f.partId as string)));
    if ((s.feedback as unknown[]).length !== before) fixes.push(`dropped ${before - (s.feedback as unknown[]).length} dangling feedback`);
  }
  return { spec: s, fixes };
}
