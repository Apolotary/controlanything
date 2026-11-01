/**
 * ce.gen3d/1: the generative 3D control spec.
 *
 * Two layers:
 *   (a) the SEMANTIC CONTROL LAYER (`controls`): what each control does, its range and its binding to a
 *       driver action. Every client renders this layer (the Quest in 3D, the Mac/iPhone/DevTerm/Cardputer in 2D).
 *   (b) the 3D PRESENTATION LAYER (`parts`, `behaviors`, `feedback`, `anchor`): a flat, non-recursive object
 *       grammar. Parts form a tree through `parentId` (depth <= MAX_PART_DEPTH). Archetype parts
 *       (knob, fader, hack-menu, ...) expand into primitives + behaviors + feedback in `archetypes.ts`,
 *       so a model can place a working control in one call, and compose novel objects from primitives.
 *
 * Rules for every schema here (they double as Muse `response_format` / tool `parameters` JSON Schema):
 * no recursion, no `.meta({ id })`, nesting depth <= 10, no transforms/dates/bigints, no tuples
 * (fixed-length arrays instead). Units: metres, degrees, seconds. Colours: "#rrggbb".
 */
import { z } from 'zod';

export const GEN3D_SPEC_VERSION = 'ce.gen3d/1' as const;

/** Hard limits the validator enforces (also the budget the renderer is tuned for). */
export const LIMITS = {
  controls: 24,
  parts: 160,
  /** parts after archetype expansion */
  expandedParts: 600,
  behaviors: 64,
  feedback: 64,
  partDepth: 8,
  triangles: 80_000,
  /** largest extent of the whole object, metres */
  extentM: 1.2,
  /** smallest interactive target, metres (Meta: ~22 mm at touch distance; we use 44 mm) */
  minTargetM: 0.044,
  /** smallest readable cap height, metres, at desk distance */
  minTextM: 0.006,
  /** nothing may flash faster than this */
  maxFlashHz: 3,
} as const;

// --- primitives ------------------------------------------------------------------------------

export const Id = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
export type Id = z.infer<typeof Id>;

export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export type HexColor = z.infer<typeof HexColor>;

/** [x, y, z] in metres (positions) or degrees (rotations). A 3-element array, not a tuple, for JSON Schema. */
export const Vec3 = z.array(z.number()).min(3).max(3);
export type Vec3 = z.infer<typeof Vec3>;
export const Vec2 = z.array(z.number()).min(2).max(2);
export type Vec2 = z.infer<typeof Vec2>;

// --- (a) semantic control layer ---------------------------------------------------------------

export const ControlKind = z.enum(['continuous', 'stepped', 'toggle', 'trigger', 'xy']);
export type ControlKind = z.infer<typeof ControlKind>;

export const Range = z.object({
  min: z.number(),
  max: z.number(),
  /** stepped controls: the increment; continuous controls: optional quantisation (e.g. 1 for MIDI) */
  step: z.number().positive().optional(),
});
export type Range = z.infer<typeof Range>;

/**
 * What a control drives. Same shape as @ce/protocol's Binding so the companion can execute
 * "midi.cc" / "midi.note" / "ir.send" without generated code; "sim.*" actions drive the virtual devices
 * in the hardware-free replay mode; anything else names a generated driver's action.
 */
export const Binding = z.object({
  action: z.string().min(1).max(120),
  driverId: Id.optional(),
  /** MIDI channel 1-16 */
  channel: z.number().int().min(1).max(16).optional(),
  cc: z.number().int().min(0).max(127).optional(),
  note: z.number().int().min(0).max(127).optional(),
  args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export type Binding = z.infer<typeof Binding>;

export const XYValue = z.object({ x: z.number(), y: z.number() });
export const ControlValue = z.union([z.number(), z.boolean(), XYValue]);
export type ControlValue = z.infer<typeof ControlValue>;

export const Control = z.object({
  id: Id,
  kind: ControlKind,
  /** short, uppercase-friendly, <= 16 chars ("CUTOFF", "BRIGHTNESS") */
  label: z.string().min(1).max(16),
  description: z.string().max(200).optional(),
  /** continuous/stepped: value range (default 0..1); xy: the x axis */
  range: Range.optional(),
  /** xy only: the y axis */
  yRange: Range.optional(),
  unit: z.string().max(8).optional(),
  default: ControlValue.optional(),
  /** stepped only: a name per step, e.g. ["OFF", "LOW", "HIGH"] */
  stepLabels: z.array(z.string().max(12)).max(32).optional(),
  /** colour of this control's indicator (arc, cap, glow); defaults to the device accent or the theme */
  accent: HexColor.optional(),
  /** words at the ends of the range, rendered at the track ends, e.g. "DARK" / "BRIGHT" */
  minLabel: z.string().max(8).optional(),
  maxLabel: z.string().max(8).optional(),
  /** centre detent at the middle of the range (pan, pitch bend) */
  bipolar: z.boolean().optional(),
  /** value curve for the visual mapping (default linear) */
  curve: z.enum(['linear', 'log']).optional(),
  /** gesture hint shown on hover, e.g. "pinch · drag up" (default from the archetype) */
  hint: z.string().max(24).optional(),
  binding: Binding,
  /** xy only: binding for the y axis */
  yBinding: Binding.optional(),
  /** false = shown but inert until the driver has been verified on the real device (overrides spec.state) */
  armed: z.boolean().optional(),
});
export type Control = z.infer<typeof Control>;

// --- (b) presentation layer: materials and primitives ---------------------------------------------

/**
 * solid: lit PBR surface. holo: additive hologram with fresnel rim + scanlines, legible backplates stay
 * near-opaque. wire: neon edges only. glass: tinted translucent plate. glitch: holo with slow slice offsets.
 */
export const MaterialStyle = z.enum(['solid', 'holo', 'wire', 'glass', 'glitch']);
export type MaterialStyle = z.infer<typeof MaterialStyle>;

export const Material = z.object({
  style: MaterialStyle.optional(),
  color: HexColor.optional(),
  emissive: HexColor.optional(),
  emissiveIntensity: z.number().min(0).max(4).optional(),
  metalness: z.number().min(0).max(1).optional(),
  roughness: z.number().min(0).max(1).optional(),
  opacity: z.number().min(0.05).max(1).optional(),
  /** additive edge/rim glow strength (0 = none) */
  glow: z.number().min(0).max(2).optional(),
  /** fresnel rim power for holo/glass (higher = thinner rim) */
  fresnel: z.number().min(0).max(6).optional(),
  scanlines: z.boolean().optional(),
  /** slow brightness noise amount; the renderer caps its rate at LIMITS.maxFlashHz */
  flicker: z.number().min(0).max(1).optional(),
  /** draw neon edges on boxes/planes/rings */
  edges: z.boolean().optional(),
  edgeColor: HexColor.optional(),
  /** optional image (e.g. a Muse Image faceplate) mapped onto the surface */
  textureUrl: z.string().max(500).optional(),
});
export type Material = z.infer<typeof Material>;

export const Shape = z.enum(['box', 'cylinder', 'sphere', 'torus', 'capsule', 'cone', 'ring', 'plane', 'lathe', 'extrude']);
export type Shape = z.infer<typeof Shape>;

/**
 * Dimensions in metres, one flat bag for every shape:
 *   box/plane: w h d · cylinder: rTop rBottom h · sphere: r · torus: r tube arcDeg · capsule: r h ·
 *   cone: r h · ring: rInner rOuter arcDeg · lathe: profile [[x,y]...] (x = radius) · extrude: profile + depth.
 * `segments` is the radial resolution (default per shape). `radius` rounds box corners.
 */
export const Dims = z.object({
  w: z.number().min(0.0005).max(2).optional(),
  h: z.number().min(0.0005).max(2).optional(),
  d: z.number().min(0.0005).max(2).optional(),
  r: z.number().min(0.0005).max(1).optional(),
  rTop: z.number().min(0).max(1).optional(),
  rBottom: z.number().min(0).max(1).optional(),
  /** ring: inner/outer radii; `r` is accepted as an alias for rOuter / rTop+rBottom */
  rInner: z.number().min(0).max(1).optional(),
  rOuter: z.number().min(0.0005).max(1).optional(),
  tube: z.number().min(0.0005).max(0.5).optional(),
  arcDeg: z.number().min(1).max(360).optional(),
  /** start angle of an arc, degrees, counter-clockwise from +x (default 0) */
  startDeg: z.number().min(-360).max(360).optional(),
  segments: z.number().int().min(3).max(96).optional(),
  profile: z.array(Vec2).min(2).max(32).optional(),
  depth: z.number().min(0.0005).max(1).optional(),
  radius: z.number().min(0).max(0.5).optional(),
});
export type Dims = z.infer<typeof Dims>;

export const Transform = z.object({
  position: Vec3.optional(),
  /** Euler XYZ, degrees */
  rotationDeg: Vec3.optional(),
  scale: z.union([z.number().positive().max(10), Vec3]).optional(),
});
export type Transform = z.infer<typeof Transform>;

export const TextStyle = z.object({
  value: z.string().max(48),
  /** cap height in metres (default 0.009 at desk distance, 0.012 at 1 m) */
  heightM: z.number().min(0.004).max(0.3).optional(),
  color: HexColor.optional(),
  /** backplate colour; omit for naked text (only legible over our own plates) */
  background: HexColor.optional(),
  font: z.enum(['sans', 'display', 'mono']).optional(),
  weight: z.enum(['regular', 'medium', 'bold']).optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  uppercase: z.boolean().optional(),
  /** turn to face the user (yaw only) */
  billboard: z.boolean().optional(),
  /** max characters per line before wrapping (default: no wrap) */
  wrap: z.number().int().min(4).max(64).optional(),
});
export type TextStyle = z.infer<typeof TextStyle>;

/** A line, arc or data beam between two local points, or a polyline through `points` (outline contours). */
export const PathStyle = z.object({
  from: Vec3.optional(),
  to: Vec3.optional(),
  /** polyline (closed when `closed` is true); when present, from/to and arcHeight are ignored */
  points: z.array(Vec3).min(2).max(96).optional(),
  closed: z.boolean().optional(),
  /** two-tone keyline: a wider void line under the neon one (default true) */
  keyline: z.boolean().optional(),
  /** bulge of the arc at its middle, metres (0 = straight) */
  arcHeight: z.number().min(0).max(3).optional(),
  width: z.number().min(0.0005).max(0.05).optional(),
  /** solid (USB/MIDI), dashed, dotted (Wi-Fi), dash-dot (BLE), cone (an IR beam widening toward `to`) */
  lineStyle: z.enum(['solid', 'dashed', 'dotted', 'dash-dot', 'cone']).optional(),
  /** flow: particles travel from -> to; pulse: brightness breathes at <= 1 Hz */
  animate: z.enum(['none', 'flow', 'pulse']).optional(),
  color: HexColor.optional(),
  /** number of data particles for flow (default 8) */
  particles: z.number().int().min(0).max(64).optional(),
  /** particle speed, metres per second (default 0.6) */
  speed: z.number().min(0.01).max(5).optional(),
});
export type PathStyle = z.infer<typeof PathStyle>;

// --- (b) presentation layer: archetypes ----------------------------------------------------------

/**
 * Parametric objects the renderer knows how to build and operate. Interactive ones need `controlId`.
 *
 *   controls   knob fader lever button toggle dimmer-ring pull-cord xy-orb pads keys wheel
 *   SCAN       outline (SAM mask contour as a two-tone line) · tag (name plate + channel glyph + status pip) ·
 *              brackets (four L-corners around the device box) · twin (2.5D hologram of the device: extruded
 *              silhouette) · sweep-plane (the scan sweep band) · reticle (head-ray cursor)
 *   PING       ping-line (route hub -> device with data particles; line style per channel)
 *   LINK       link-matrix (code grid the agent solves while the camera verifies) · oracle-strip
 *              ("SENT x · EXPECT y · SEEN z" with a verdict pip)
 *   HACK       hack-list (per-device actions, items 44 mm) · queue-strip (queued hacks with progress) ·
 *              upload-bar (GEN / CHECK / SEND / SEEN segments, lit per real step)
 *   DAEMON     daemon-link (persistent cross-device automation line + chip)
 *   LEARN      ir-waveform-card (a captured IR pulse train as a card: captured → flying → replaying → seen/no-change) ·
 *              remote-chips (plates over the remote's buttons from its SAM mask)
 *   HUD        deck (palm panel: SCAN · PING · HACKS · DAEMONS · UNDO) · model-chips (Meta model ids, lit while live) ·
 *              worklog (agent steps with evidence + model chips) · handle (grab bar for the whole object)
 */
export const ArchetypeName = z.enum([
  'knob',
  'fader',
  'lever',
  'button',
  'toggle',
  'dimmer-ring',
  'pull-cord',
  'xy-orb',
  'pads',
  'keys',
  'wheel',
  'outline',
  'tag',
  'brackets',
  'twin',
  'sweep-plane',
  'reticle',
  'ping-line',
  'link-matrix',
  'oracle-strip',
  'hack-list',
  'queue-strip',
  'upload-bar',
  'daemon-link',
  'deck',
  'model-chips',
  'worklog',
  'ir-waveform-card',
  'remote-chips',
  'handle',
]);
export type ArchetypeName = z.infer<typeof ArchetypeName>;

/** How a device is reached; sets the tag glyph and the ping-line style (usb solid, ir cone, wifi dotted, ble dash-dot). */
export const Channel = z.enum(['usb', 'midi', 'ir', 'wifi', 'ble', 'serial', 'sim']);
export type Channel = z.infer<typeof Channel>;

/** Lifecycle of a device or a hack as the HUD shows it. */
export const HudStatus = z.enum([
  'idle',
  'scanned',
  'candidate',
  'locked',
  'pinging',
  'linking',
  'linked',
  'uploading',
  'verified',
  'controlled',
  'running',
  'paused',
  'killed',
  'offline',
  'failed',
  // evidence states, always written in words on the HUD: an ack is never success
  'hypothesis',
  'requested',
  'awaiting',
  'no-reaction',
  'refused',
]);
export type HudStatus = z.infer<typeof HudStatus>;

export const HackItem = z.object({
  id: Id,
  label: z.string().min(1).max(24),
  detail: z.string().max(32).optional(),
  /** action = one-shot, control = opens/is a 3D control, daemon = automation */
  kind: z.enum(['action', 'control', 'daemon']).optional(),
  channel: Channel.optional(),
  /** trigger/toggle control fired when the row is selected */
  controlId: Id.optional(),
  status: z.enum(['ready', 'locked', 'queued', 'uploading', 'verified', 'failed']).optional(),
  /** queue-strip: upload progress 0..1 */
  progress: z.number().min(0).max(1).optional(),
  /** right-hand column: how the device's reaction was proven (seen = camera, heard = mic, wired = ack) */
  verdict: z.enum(['seen', 'heard', 'wired', 'pending', 'none']).optional(),
  /** deck keys / hack rows: 7 mm second line, e.g. "your devices" under HACKS, "automations" under DAEMONS */
  subtitle: z.string().max(20).optional(),
  /** Japanese label from the device itself, e.g. 常夜灯 */
  jpLabel: z.string().max(12).optional(),
});
export type HackItem = z.infer<typeof HackItem>;

export const LogRow = z.object({
  title: z.string().min(1).max(28),
  status: z.enum(['pending', 'running', 'ok', 'fail']),
  evidence: z.string().max(64).optional(),
  /** proof = deterministic check (green tick); opinion = a model's reading (cyan chip) */
  kind: z.enum(['proof', 'opinion']).optional(),
});
export type LogRow = z.infer<typeof LogRow>;

export const ModelChip = z.object({
  /** Meta model id exactly as called, e.g. "muse-spark-1.3", "sam-3.1", "muse-voice-transcribe-1.0" */
  id: z.string().min(1).max(40),
  state: z.enum(['idle', 'live', 'done', 'error']),
});
export type ModelChip = z.infer<typeof ModelChip>;

export const ArchetypeParams = z.object({
  /** main dimension (diameter or length), metres */
  size: z.number().min(0.01).max(1).optional(),
  thickness: z.number().min(0.001).max(0.2).optional(),
  length: z.number().min(0.01).max(1).optional(),
  width: z.number().min(0.01).max(1).optional(),
  sweepDeg: z.number().min(30).max(360).optional(),
  /** lever: total rotation; default 60 */
  throwDeg: z.number().min(10).max(180).optional(),
  orientation: z.enum(['vertical', 'horizontal']).optional(),
  shape: z.enum(['round', 'square']).optional(),
  /** colour of the indicator / cap / highlight (default: control.accent, device accent, theme) */
  accent: HexColor.optional(),
  body: HexColor.optional(),
  cap: HexColor.optional(),
  /** presentation style for the whole archetype (default holo) */
  style: MaterialStyle.optional(),
  showLabel: z.boolean().optional(),
  showValue: z.boolean().optional(),
  rows: z.number().int().min(1).max(8).optional(),
  cols: z.number().int().min(1).max(8).optional(),
  octaves: z.number().int().min(1).max(2).optional(),
  /** wheel segments (default 12) */
  segments: z.number().int().min(2).max(24).optional(),
  /** wheel: hue ring or 5-step warmth bar */
  mode: z.enum(['hue', 'warmth']).optional(),
  /** button: true = fires while held (trigger), false = latches (toggle) */
  momentary: z.boolean().optional(),
  detents: z.number().int().min(0).max(128).optional(),
  // HUD archetypes
  title: z.string().max(32).optional(),
  subtitle: z.string().max(40).optional(),
  status: HudStatus.optional(),
  channel: Channel.optional(),
  /** brackets / twin: size of the device box, metres */
  boxSize: Vec3.optional(),
  /** outline / twin: the device silhouette in the anchor plane, metres, <= 96 points */
  contour: z.array(Vec2).min(3).max(96).optional(),
  /** twin: extrusion depth, metres */
  depth: z.number().min(0.002).max(1).optional(),
  /** ping-line / daemon-link endpoints (local metres) */
  from: Vec3.optional(),
  to: Vec3.optional(),
  particles: z.number().int().min(0).max(64).optional(),
  speed: z.number().min(0.01).max(5).optional(),
  /** hack-list / queue-strip / deck items */
  items: z.array(HackItem).max(12).optional(),
  /** link-matrix cell texts (rows*cols, e.g. "1C", "E9", "BD"); missing cells are filled */
  cells: z.array(z.string().max(4)).max(64).optional(),
  /** indices of cells already tried, in order */
  picked: z.array(z.number().int().min(0).max(63)).max(64).optional(),
  /** indices of cells that solved (verified by camera) */
  solved: z.array(z.number().int().min(0).max(63)).max(64).optional(),
  current: z.number().int().min(0).max(63).optional(),
  /** link-matrix: what the camera saw for a cell, named by the agent (LEARN → LINK by sight → LABEL) */
  cellMeta: z.array(z.object({ i: z.number().int().min(0).max(63), effect: z.string().max(14).optional(), jp: z.string().max(12).optional(), state: z.enum(['idle', 'trying', 'ok', 'fail']).optional() })).max(64).optional(),
  /** ir-waveform-card: the captured pulse train, <= 60 normalised samples (0 = space, 1 = mark) */
  samples: z.array(z.number().min(0).max(1)).max(60).optional(),
  /** ir-waveform-card: what the camera saw when it was replayed, e.g. "BRIGHTER" */
  effectLabel: z.string().max(14).optional(),
  jpLabel: z.string().max(12).optional(),
  /** ir-waveform-card state */
  cardState: z.enum(['captured', 'flying', 'replaying', 'seen', 'no-change']).optional(),
  /** remote-chips: one chip per remote button, positions in metres in the card's plane */
  chips: z.array(z.object({ id: Id, x: z.number(), y: z.number(), label: z.string().max(14), jpLabel: z.string().max(12).optional(), state: z.enum(['idle', 'pressed', 'captured']).optional() })).max(16).optional(),
  /** sweep-plane / generic 0..1 progress */
  progress: z.number().min(0).max(1).optional(),
  /** upload-bar segment labels (default GEN CHECK SEND SEEN) and how many have really completed */
  steps: z.array(z.string().max(8)).max(6).optional(),
  stepsDone: z.number().int().min(0).max(6).optional(),
  /** oracle-strip: what was sent, what the agent expected, what the camera/mic saw */
  sent: z.string().max(24).optional(),
  expect: z.string().max(24).optional(),
  seen: z.string().max(24).optional(),
  verdict: z.enum(['pending', 'ok', 'fail']).optional(),
  active: z.boolean().optional(),
  logRows: z.array(LogRow).max(8).optional(),
  models: z.array(ModelChip).max(8).optional(),
  reticleState: z.enum(['idle', 'candidate', 'locked', 'working', 'lost']).optional(),
});
export type ArchetypeParams = z.infer<typeof ArchetypeParams>;

// --- (b) presentation layer: parts ---------------------------------------------------------------

export const PartKind = z.enum(['group', 'primitive', 'archetype', 'text', 'path']);
export type PartKind = z.infer<typeof PartKind>;

/** When a part is drawn. armed/disarmed follow the control (or spec.state); hover/grabbed follow interaction. */
export const Visibility = z.enum(['always', 'armed', 'disarmed', 'hover', 'grabbed', 'never']);
export type Visibility = z.infer<typeof Visibility>;

/** Semantic role of a part inside a composed object: behaviours and feedback target roles when `partId` is omitted. */
export const PartRole = z.enum(['body', 'cap', 'indicator', 'track', 'base', 'handle', 'label', 'readout', 'arc', 'beam', 'decor']);
export type PartRole = z.infer<typeof PartRole>;

export const Part = z.object({
  id: Id,
  /** omitted = child of the object root */
  parentId: Id.optional(),
  kind: PartKind,
  name: z.string().max(40).optional(),
  role: PartRole.optional(),
  /** primitive */
  shape: Shape.optional(),
  dims: Dims.optional(),
  /** archetype */
  archetype: ArchetypeName.optional(),
  params: ArchetypeParams.optional(),
  /** archetype: the control it operates; primitive/text: the control whose state it reflects */
  controlId: Id.optional(),
  /** text */
  text: TextStyle.optional(),
  /** path */
  path: PathStyle.optional(),
  transform: Transform.optional(),
  material: Material.optional(),
  visibleWhen: Visibility.optional(),
});
export type Part = z.infer<typeof Part>;

// --- (b) presentation layer: behaviours (affordances) and feedback -------------------------------

export const BehaviorType = z.enum(['rotate', 'slide', 'press', 'toggle', 'pull', 'xy', 'grab']);
export type BehaviorType = z.infer<typeof BehaviorType>;

export const Gesture = z.enum(['pinch-drag', 'pinch-twist', 'poke', 'grab', 'pinch']);
export type Gesture = z.infer<typeof Gesture>;

export const Axis = z.enum(['x', 'y', 'z']);
export type Axis = z.infer<typeof Axis>;

/**
 * How a part (and its subtree) is operated and how its motion maps to a control's value.
 * rotate: about `axis` through `sweepDeg` [min,max] · slide: along `axis` through `travel` [min,max] ·
 * press: along `axis` by `depth` (trigger/toggle) · toggle: flips on press or on a drag across ·
 * pull: drag along `axis`, springs back, fires when pulled past 60 % · xy: pinch point on `plane` ·
 * grab: move the whole object (no control).
 */
export const Behavior = z.object({
  id: Id,
  partId: Id,
  /** required unless type = grab */
  controlId: Id.optional(),
  type: BehaviorType,
  axis: Axis.optional(),
  plane: z.enum(['xy', 'xz', 'yz']).optional(),
  /** rotate: [minDeg, maxDeg] mapped onto the control range (default [-135, 135]) */
  sweepDeg: Vec2.optional(),
  /** slide/pull: [minM, maxM] along the axis (default [0, 0.16]) */
  travel: Vec2.optional(),
  /** press depth, metres (default 0.007) */
  depth: z.number().min(0.001).max(0.1).optional(),
  gestures: z.array(Gesture).max(5).optional(),
  /** metres of pinch-drag for the full range (default 0.10) */
  dragGain: z.number().min(0.01).max(2).optional(),
  detents: z.number().int().min(0).max(128).optional(),
  /** return to rest when released */
  spring: z.boolean().optional(),
  invert: z.boolean().optional(),
  /** how close a pinch must be to grab, metres (default: part size + 0.03) */
  grabRadius: z.number().min(0.01).max(0.5).optional(),
  /** pads/keys/wheel segments/list rows: which item this part is; a press on it sets a stepped control to
   *  min + index*step, or fires a trigger with this index */
  index: z.number().int().min(0).max(127).optional(),
});
export type Behavior = z.infer<typeof Behavior>;

export const FeedbackType = z.enum(['glow', 'arc-fill', 'readout', 'tick', 'particles', 'beam-pulse', 'scale-pop', 'color-shift', 'glitch']);
export type FeedbackType = z.infer<typeof FeedbackType>;

export const Feedback = z.object({
  id: Id,
  controlId: Id,
  type: FeedbackType,
  /** the part that shows it (default: the role the type implies, e.g. arc-fill -> role "arc") */
  partId: Id.optional(),
  color: HexColor.optional(),
  /** readout format, e.g. "{value}{unit}", "{percent}%", "{label}" (default "{value}") */
  format: z.string().max(24).optional(),
  /** tick every fraction of the range (default 0.05) */
  every: z.number().min(0.01).max(1).optional(),
  sound: z.enum(['tick', 'click', 'pluck', 'knock', 'chirp', 'none']).optional(),
  on: z.enum(['change', 'hover', 'grab', 'release', 'arm', 'trigger']).optional(),
});
export type Feedback = z.infer<typeof Feedback>;

// --- anchoring and state ---------------------------------------------------------------------------

/**
 * device: beside/above the identified physical device (the renderer resolves cardId to a world pose) ·
 * floating: in front of the user at `distance`, `pitchDeg` below the horizon · surface: on the nearest
 * horizontal surface under the gaze · hand: follows a hand (palm up) · world: explicit `pose`.
 */
export const AnchorMode = z.enum(['device', 'floating', 'surface', 'hand', 'world']);
export type AnchorMode = z.infer<typeof AnchorMode>;

export const Anchor = z.object({
  mode: AnchorMode,
  cardId: Id.optional(),
  side: z.enum(['left', 'right', 'above', 'front', 'behind']).optional(),
  /** metres from the anchor origin in the anchor's frame */
  offset: Vec3.optional(),
  /** floating: metres in front of the user (default 0.6) */
  distance: z.number().min(0.25).max(3).optional(),
  /** floating: degrees below (-) or above (+) the horizon (default -12) */
  pitchDeg: z.number().min(-60).max(60).optional(),
  /** world: explicit pose */
  position: Vec3.optional(),
  rotationDeg: Vec3.optional(),
  hand: z.enum(['left', 'right']).optional(),
  /** turn the whole object toward the user (yaw only) */
  faceUser: z.boolean().optional(),
  /** show a handle bar and let the user grab-and-place the whole object (default true) */
  grabbable: z.boolean().optional(),
});
export type Anchor = z.infer<typeof Anchor>;

/** Disarmed = drawn as a wire ghost and inert until the driver has been verified on the real device. */
export const ArmState = z.object({
  armed: z.boolean(),
  /** shown on the object: "verifying on the real device…", "USB says OP-1 Field ✓" */
  reason: z.string().max(80).optional(),
  verifiedBy: z.array(z.string().max(60)).max(6).optional(),
});
export type ArmState = z.infer<typeof ArmState>;

export const DeviceRef = z.object({
  /** @ce/protocol device.card id */
  cardId: Id.optional(),
  name: z.string().min(1).max(60),
  category: z.string().max(32).optional(),
  /** the device's own colours, used for control accents in order */
  accents: z.array(HexColor).max(8).optional(),
  transport: z.enum(['usb-midi', 'ble-midi', 'ir', 'serial', 'http', 'sim', 'other']).optional(),
});
export type DeviceRef = z.infer<typeof DeviceRef>;

// --- skins (Muse Image at FORGE) ------------------------------------------------------------------------

/**
 * A generated image painted onto the object's backplates (or knob faces) as a subtle textured layer under
 * the text plates. Attached server-side after FORGE; every key is required or nullable so a constrained
 * decoder cannot skip it. Legibility rules are unchanged: text plates stay >= 0.9 alpha above the skin.
 */
export const Skin = z.object({
  /** https:// or data: URL of the image (PNG/JPEG/WebP) */
  url: z.string().min(1).max(4_000_000),
  /** panel = plates with role "base"; knob-face = caps of knob archetypes; both */
  kind: z.enum(['panel', 'knob-face', 'both']),
  /** final opacity of the layer (default 0.55; keep <= 0.7 so plates stay dark) */
  opacity: z.number().min(0.05).max(1),
  /** how the image maps onto each plate */
  fit: z.enum(['cover', 'contain', 'tile']),
  /** model that painted it, e.g. "muse-image-1.0"; "hand" for stand-ins */
  source: z.string().min(1).max(40),
  prompt: z.string().max(400).nullable(),
  /** restrict to these part ids; empty = every eligible part */
  partIds: z.array(Id).max(16),
  /** seconds the layer takes to fade in after the controls have built (default 2.5) */
  fadeS: z.number().min(0).max(10).nullable(),
});
export type Skin = z.infer<typeof Skin>;

// --- the spec ----------------------------------------------------------------------------------------

export const Gen3dSpec = z.object({
  spec: z.literal(GEN3D_SPEC_VERSION),
  specId: Id,
  /** revision; patches produce rev+1, undo restores an older rev as a new rev */
  rev: z.number().int().min(1),
  title: z.string().min(1).max(40),
  device: DeviceRef.optional(),
  anchor: Anchor,
  state: ArmState.optional(),
  controls: z.array(Control).max(LIMITS.controls),
  parts: z.array(Part).min(1).max(LIMITS.parts),
  behaviors: z.array(Behavior).max(LIMITS.behaviors).optional(),
  feedback: z.array(Feedback).max(LIMITS.feedback).optional(),
  notes: z.string().max(400).optional(),
  /** live model output, a canned fixture, or hand-written */
  source: z.enum(['live', 'fixture', 'hand']).optional(),
  /** the Meta model that generated it, shown on screen */
  modelId: z.string().max(60).optional(),
  /** optional generated image skin (Muse Image) */
  skin: Skin.optional(),
});
export type Gen3dSpec = z.infer<typeof Gen3dSpec>;

// --- patches (malleable edits) -------------------------------------------------------------------------

export const Collection = z.enum(['controls', 'parts', 'behaviors', 'feedback']);
export type Collection = z.infer<typeof Collection>;

/**
 * One edit. upsert: replace-or-add the item in `collection` (the item carries its own id) ·
 * remove: delete `id` from `collection` (removing a part removes its subtree and dependent behaviours/feedback) ·
 * set: replace a top-level field (title, anchor, state, device, notes).
 */
export const PatchOp = z.object({
  op: z.enum(['upsert', 'remove', 'set']),
  collection: Collection.optional(),
  id: Id.optional(),
  control: Control.optional(),
  part: Part.optional(),
  behavior: Behavior.optional(),
  feedback: Feedback.optional(),
  title: z.string().min(1).max(40).optional(),
  anchor: Anchor.optional(),
  state: ArmState.optional(),
  device: DeviceRef.optional(),
  notes: z.string().max(400).optional(),
  skin: Skin.nullable().optional(),
});
export type PatchOp = z.infer<typeof PatchOp>;

export const Patch = z.object({
  specId: Id,
  /** the revision this patch was written against; a mismatch is a conflict */
  baseRev: z.number().int().min(1),
  ops: z.array(PatchOp).min(1).max(64),
  /** what the user asked for, e.g. "make the cutoff knob bigger" */
  reason: z.string().max(120).optional(),
});
export type Patch = z.infer<typeof Patch>;

/**
 * What a model actually writes for an edit. The constrained decoder lets a model skip optional keys, so a
 * PatchOp with optional payloads often comes back empty (live finding, research/12 §3). EditSet has every
 * key required: items to upsert per collection (possibly empty arrays) and ids to remove. `editSetToPatch`
 * turns it into a Patch.
 */
export const EditSet = z.object({
  title: z.string().min(1).max(40),
  summary: z.string().max(120),
  controls: z.array(Control).max(LIMITS.controls),
  parts: z.array(Part).max(LIMITS.parts),
  behaviors: z.array(Behavior).max(LIMITS.behaviors),
  feedback: z.array(Feedback).max(LIMITS.feedback),
  remove: z.array(z.object({ collection: Collection, id: Id })).max(64),
});
export type EditSet = z.infer<typeof EditSet>;

// --- events out of the renderer -----------------------------------------------------------------------

export const ControlEvent = z.object({
  controlId: Id,
  value: ControlValue,
  /** pads/keys/hack-menu/wheel: which item */
  index: z.number().int().min(0).max(127).optional(),
  phase: z.enum(['start', 'move', 'end']),
  /** sender clock, epoch ms */
  ts: z.number(),
  specId: Id,
});
export type ControlEvent = z.infer<typeof ControlEvent>;
