/**
 * DRAFT gen3d spec ("gen3d-draft/0"), used by the generator until the shared schema in packages/gen3d lands.
 * Two layers:
 *   semantic:      hacks (named one-shot actions), controls (continuous/stepped/toggle/momentary), daemons
 *                  (signal of one device -> action of another), each bound to driver actions with an `expect`
 *                  (the physical effect the camera/mic oracle checks).
 *   presentation:  objects (one 3D object per control: archetype + transform + material + behaviour + extra
 *                  primitive parts) and an anchor (device / panel / hand / world).
 * Every schema here doubles as a Meta `response_format` json_schema: no recursion, depth <= 10.
 */
import { z } from 'zod';

export const DRAFT_VERSION = 'gen3d-draft/0';

const Num = z.number();
export const Vec3 = z.object({ x: Num, y: Num, z: Num });
export type Vec3 = z.infer<typeof Vec3>;
export const Hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
export const Slug = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);

export const ARCHETYPES = ['knob', 'slider', 'lever', 'button', 'switch', 'ring', 'dial', 'pad', 'wheel', 'readout'] as const;
export const Archetype = z.enum(ARCHETYPES);
export type Archetype = z.infer<typeof Archetype>;

export const PRIMITIVES = ['box', 'cylinder', 'sphere', 'torus', 'cone', 'capsule'] as const;
export const CONTROL_KINDS = ['continuous', 'stepped', 'toggle', 'momentary'] as const;
export const ControlKind = z.enum(CONTROL_KINDS);
export type ControlKind = z.infer<typeof ControlKind>;

export const SENSORS = ['camera', 'mic', 'none'] as const;
export const EFFECTS = [
  'brighter',
  'darker',
  'light_on',
  'light_off',
  'warmer',
  'cooler',
  'louder',
  'quieter',
  'pitch_up',
  'pitch_down',
  'timbre_change',
  'sound_starts',
  'sound_stops',
  'screen_change',
  'print_out',
  'none',
] as const;
export type Effect = (typeof EFFECTS)[number];

export const Expect = z.object({
  sensor: z.enum(SENSORS),
  effect: z.enum(EFFECTS),
  detail: z.string().max(120),
});
export type Expect = z.infer<typeof Expect>;

export const Arg = z.object({ name: z.string().max(32), value: z.union([z.string().max(64), z.number(), z.boolean()]) });
export type Arg = z.infer<typeof Arg>;

export const Binding = z.object({
  action: z.string().max(64),
  args: z.array(Arg).max(6),
  /** param of the action that receives the live control value; "" = none */
  valueArg: z.string().max(32),
});
export type Binding = z.infer<typeof Binding>;

export const Material = z.object({
  color: Hex,
  emissive: Hex,
  metalness: z.number().min(0).max(1),
  roughness: z.number().min(0).max(1),
});
export type Material = z.infer<typeof Material>;

export const Behaviour = z.object({
  motion: z.enum(['rotate', 'slide', 'press', 'flip', 'none']),
  axis: z.enum(['x', 'y', 'z']),
  /** travel: degrees for rotate/flip, metres for slide/press */
  from: Num,
  to: Num,
  detents: z.number().int().min(0).max(32),
  springBack: z.boolean(),
});
export type Behaviour = z.infer<typeof Behaviour>;

export const Part = z.object({
  id: Slug,
  primitive: z.enum(PRIMITIVES),
  role: z.enum(['base', 'body', 'handle', 'cap', 'pointer', 'track', 'glow', 'decor']),
  /** extents in metres (cylinder: x = diameter, y = height) */
  size: Vec3,
  /** relative to the object origin */
  position: Vec3,
  rotation: Vec3,
  color: Hex,
  /** moves with the behaviour (e.g. a lever handle) */
  moves: z.boolean(),
});
export type Part = z.infer<typeof Part>;

export const Control = z.object({
  id: Slug,
  label: z.string().min(1).max(16),
  kind: ControlKind,
  min: Num,
  max: Num,
  step: z.number().min(0),
  default: Num,
  unit: z.string().max(8),
  binding: Binding,
  expect: Expect,
});
export type Control = z.infer<typeof Control>;

export const Object3D = z.object({
  id: Slug,
  /** the control this object operates; "" for decoration */
  controlId: z.string().max(32),
  archetype: Archetype,
  label: z.string().max(16),
  /** metres in the anchor frame: +x right, +y up, +z toward the user */
  position: Vec3,
  /** degrees */
  rotation: Vec3,
  scale: z.number().min(0.5).max(2.5),
  material: Material,
  behaviour: Behaviour,
  parts: z.array(Part).max(6),
});
export type Object3D = z.infer<typeof Object3D>;

export const Step = z.object({
  action: z.string().max(64),
  args: z.array(Arg).max(6),
  /** wait before this step */
  delayMs: z.number().int().min(0).max(10_000),
});
export type Step = z.infer<typeof Step>;

export const GLYPHS = ['bolt', 'eye', 'moon', 'sun', 'wave', 'skull', 'lock', 'note', 'power', 'spark'] as const;

export const Hack = z.object({
  id: Slug,
  name: z.string().min(1).max(24),
  blurb: z.string().max(100),
  glyph: z.enum(GLYPHS),
  steps: z.array(Step).min(1).max(8),
  expect: Expect,
});
export type Hack = z.infer<typeof Hack>;

export const Daemon = z.object({
  id: Slug,
  name: z.string().min(1).max(24),
  blurb: z.string().max(100),
  source: z.object({ cardId: z.string().max(64), signal: z.string().max(64) }),
  target: z.object({ cardId: z.string().max(64), action: z.string().max(64), args: z.array(Arg).max(6), valueArg: z.string().max(32) }),
  /** hard cap on how often the target action may fire */
  maxRateHz: z.number().min(0).max(10),
  expect: Expect,
});
export type Daemon = z.infer<typeof Daemon>;

export const ANCHOR_TARGETS = ['device', 'panel', 'hand', 'world'] as const;
export const Anchor = z.object({
  target: z.enum(ANCHOR_TARGETS),
  side: z.enum(['left', 'right', 'above', 'front', 'below']),
  offset: Vec3,
  facing: z.enum(['user', 'device', 'up']),
});
export type Anchor = z.infer<typeof Anchor>;

export const Spec = z.object({
  version: z.literal(DRAFT_VERSION),
  title: z.string().min(1).max(60),
  device: z.object({ cardId: z.string().max(64), name: z.string().max(80) }),
  anchor: Anchor,
  hacks: z.array(Hack).max(8),
  controls: z.array(Control).max(12),
  objects: z.array(Object3D).max(12),
  daemons: z.array(Daemon).max(4),
  notes: z.string().max(400),
});
export type Spec = z.infer<typeof Spec>;

// --- edits ----------------------------------------------------------------------------------

export const PATCH_ACTIONS = ['upsert_control', 'upsert_object', 'upsert_hack', 'upsert_daemon', 'remove', 'set_anchor', 'set_title'] as const;

/** One edit. `target` is the id the op is about; the payload field matching the action carries the new item. */
export const PatchOp = z.object({
  action: z.enum(PATCH_ACTIONS),
  target: z.string().max(32),
  control: Control.optional(),
  object: Object3D.optional(),
  hack: Hack.optional(),
  daemon: Daemon.optional(),
  anchor: Anchor.optional(),
  title: z.string().max(60).optional(),
});
export type PatchOp = z.infer<typeof PatchOp>;

export const Patch = z.object({
  summary: z.string().max(200),
  ops: z.array(PatchOp).min(1).max(12),
});
export type Patch = z.infer<typeof Patch>;

/**
 * The patch shape the MODEL writes: full items to upsert per collection plus ids to remove, every key
 * required (lists may be empty). Live finding: with the flat PatchOp above, whose payload fields are all
 * optional, the constrained decoder let Spark skip the payload (3 of 4 json patches came back as
 * {action, target, title} with no object). Converted to Patch ops server-side.
 */
export const PatchSet = z.object({
  controls: z.array(Control).max(12),
  daemons: z.array(Daemon).max(4),
  hacks: z.array(Hack).max(8),
  objects: z.array(Object3D).max(12),
  remove: z.array(z.string().max(32)).max(24),
  summary: z.string().max(200),
  title: z.string().max(60),
  anchor: Anchor.optional(),
});
export type PatchSet = z.infer<typeof PatchSet>;
