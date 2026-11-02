/**
 * Declarative drivers (SPEC §3.2) and evidence (SPEC §3.3).
 *
 * A Driver is data, never code: a list of actions, each with a deterministic `encode` op the server
 * expands and sends to an executor client (`exec.command`). Muse Wonder writes the Driver with
 * `json_schema`; the server validates it against allowlists (CC numbers from the stored chart, IR codes
 * from the stored candidate library or learned frames, no SysEx writes), ranges and rate limits before
 * anything executes. Every op the executor receives is one of MidiOp | IrOp | LocalOp.
 *
 * Same rules as the rest of the package: flat, non-recursive, depth <= 10 (these double as Muse
 * `response_format` json_schema).
 */
import { z } from 'zod';
import { Id, ModelSource } from './primitives';

// --- rate limits and safety constants (server-enforced) --------------------------------------

export const RATE_LIMITS = {
  /** MIDI messages per second per executor */
  midiPerSec: 200,
  /** IR frames per second per executor */
  irPerSec: 4,
  /** anything that changes visible light: flashes per second (photosensitivity) */
  lightChangesPerSec: 3,
  /** control.event -> exec.command budget on the LAN, milliseconds */
  controlLatencyMs: 50,
} as const;

/** `"$value"` in an op field means "substitute the live control value here" (actions of kind "set"). */
export const VALUE_PLACEHOLDER = '$value' as const;
export const ValuePlaceholder = z.literal(VALUE_PLACEHOLDER);

// --- ops -------------------------------------------------------------------------------------

export const MidiMsg = z.enum(['cc', 'note', 'pc', 'sysex-identity', 'panic']);
export type MidiMsg = z.infer<typeof MidiMsg>;

/**
 * One MIDI message. cc: number = controller 0-127, value = 0-127 or "$value".
 * note: number = note 0-127, velocity 1-127, durationMs -> note off after that long (default 250; 0 = note on only).
 * pc: number = program 0-127. sysex-identity: the universal identity request F0 7E 7F 06 01 F7 (read-only;
 * the executor answers with the reply bytes in exec.ack.reply). panic: the executor releases every note it
 * turned on, then CC 123 + CC 120 on all 16 channels and CC 64 = 0. No other SysEx is ever allowed.
 */
export const MidiOp = z.object({
  kind: z.literal('midi'),
  msg: MidiMsg,
  /** MIDI channel 1-16 */
  channel: z.number().int().min(1).max(16),
  /** controller, note or program number */
  number: z.number().int().min(0).max(127).optional(),
  value: z.union([z.number().int().min(0).max(127), ValuePlaceholder]).optional(),
  velocity: z.number().int().min(1).max(127).optional(),
  durationMs: z.number().int().min(0).max(10_000).optional(),
});
export type MidiOp = z.infer<typeof MidiOp>;

export const IrProtocol = z.enum(['NEC', 'AEHA', 'SONY', 'RC5', 'RC6', 'KASEIKYO', 'RAW']);
export type IrProtocol = z.infer<typeof IrProtocol>;

/**
 * One infrared frame (or burst). `bytes` are in send order, each byte LSB-first (native NEC/AEHA notation:
 * Panasonic CH1 off = [0x2C, 0x52, 0x09, 0x2F, 0x26]). The server always fills `rawUs` (alternating mark/space
 * microseconds, starting with a mark) before sending, so an executor that only knows RAW + khz works; the
 * protocol/bytes stay for logs, decoding and the allowlist. `repeats` = EXTRA full frames after the first
 * (IRremoteESP8266 convention: 0 = sent once, 1 = twice as Panasonic lighting remotes do), `frameGapUs` =
 * the space after a frame's last mark before the next frame's leader. A learned capture that already holds
 * two frames and their gap in `rawUs` is replayed with repeats 0. `ref` names the library entry the bytes
 * came from ("lib:<brand>/<model>/<key>" or "learned:<id>") so the allowlist check is a lookup, not a guess.
 * Firmware limits: rawUs 2..1024 entries of 1..65000 us, <= 0.5 s per frame, repeats <= 5, gap <= 500 ms.
 */
export const IrOp = z.object({
  kind: z.literal('ir'),
  protocol: IrProtocol,
  /** bytes in send order, LSB-first per byte */
  bytes: z.array(z.number().int().min(0).max(255)).max(16).optional(),
  /** NEC convenience: 16-bit (extended) address and 8-bit command (bytes win when both are given) */
  address: z.number().int().min(0).max(0xffff).optional(),
  command: z.number().int().min(0).max(0xff).optional(),
  /** unit time T in microseconds (default per protocol: NEC 562.5, AEHA 425) */
  unitUs: z.number().min(200).max(1000).optional(),
  /** extra frames after the first (0 = once) */
  repeats: z.number().int().min(0).max(5).optional(),
  frameGapUs: z.number().int().min(1000).max(500_000).optional(),
  /** alternating mark/space durations in microseconds, starting with a mark */
  rawUs: z.array(z.number().int().min(1).max(65_000)).min(2).max(1024).optional(),
  /** carrier in kHz (default 38) */
  khz: z.number().min(30).max(60).optional(),
  ref: z.string().max(120).optional(),
});
export type IrOp = z.infer<typeof IrOp>;

/**
 * A captured IR frame (learning): what a receiver saw during one press (may hold several frames and their
 * gaps in `rawUs`), decoded when the protocol is recognisable. `frames` = how many frames the capture holds.
 */
export const IrCapture = z.object({
  rawUs: z.array(z.number().int().min(1).max(200_000)).min(2).max(1024),
  khz: z.number().min(30).max(60).optional(),
  /** extra frames after the first, if the capture was split (0 = the whole press is in rawUs) */
  repeats: z.number().int().min(0).max(5).optional(),
  frames: z.number().int().min(1).max(8).optional(),
  frameGapUs: z.number().int().min(1000).max(500_000).optional(),
  protocol: z.enum([...IrProtocol.options, 'UNKNOWN']).optional(),
  bytes: z.array(z.number().int().min(0).max(255)).max(16).optional(),
  unitUs: z.number().min(200).max(1000).optional(),
});
export type IrCapture = z.infer<typeof IrCapture>;

export const LocalOpName = z.enum(['volume', 'music', 'say', 'torch', 'haptic', 'print', 'screen', 'beep']);
export type LocalOpName = z.infer<typeof LocalOpName>;

/** A flat bag of arguments for the richer local ops (print receipts, screen washes, beeps). */
export const LocalArgs = z.record(z.string(), z.union([z.string().max(2000), z.number(), z.boolean(), z.array(z.string().max(256)).max(32)]));
export type LocalArgs = z.infer<typeof LocalArgs>;

/**
 * Something a client does on itself (capability "local"; "print" needs "printer").
 *   volume: 0-100 or "$value" (Mac: osascript) · music: "play" | "pause" | "playpause" | "next" | "prev" ·
 *   say: text · torch: 0..1, true/false or "$value" · haptic: "tap" | "light" | "medium" | "heavy" | "pulse" |
 *   "success" | "warning" | "error" · screen: "#rrggbb" | "off" | {color, mode: steady|flash|pulse, hz<=3, ms} ·
 *   print: text or {title, lines[], qr, device, hack, oracle, verdict, models[]} (32-column receipt) ·
 *   beep: frequency Hz, "$value" or {freq, count, ms} (<= 3 Hz).
 */
export const LocalOp = z.object({
  kind: z.literal('local'),
  op: LocalOpName,
  arg: z.union([z.string().max(2000), z.number(), z.boolean(), ValuePlaceholder, LocalArgs]).optional(),
});
export type LocalOp = z.infer<typeof LocalOp>;

/** What an executor can receive. */
export const ExecOp = z.discriminatedUnion('kind', [MidiOp, IrOp, LocalOp]);
export type ExecOp = z.infer<typeof ExecOp>;

/**
 * Server-side composite for "set" actions on step-only devices (an IR dimmer): the server tracks the level
 * and sends `up`/`down` trigger actions until the tracked level matches. Never sent to an executor.
 */
export const StepOp = z.object({
  kind: z.literal('step'),
  upActionId: Id,
  downActionId: Id,
  /** number of discrete levels the device has */
  steps: z.number().int().min(2).max(64),
  /** wait between steps, ms (the device may fade) */
  settleMs: z.number().int().min(0).max(5000).optional(),
});
export type StepOp = z.infer<typeof StepOp>;

export const ActionEncode = z.discriminatedUnion('kind', [MidiOp, IrOp, LocalOp, StepOp]);
export type ActionEncode = z.infer<typeof ActionEncode>;

// --- expectations and evidence -------------------------------------------------------------

export const Sense = z.enum(['camera', 'audio', 'ack', 'none']);
export type Sense = z.infer<typeof Sense>;

export const Effect = z.enum([
  'on',
  'off',
  'brighter',
  'dimmer',
  'warmer',
  'cooler',
  'louder',
  'quieter',
  'tone-up',
  'tone-down',
  'any',
  'none',
]);
export type Effect = z.infer<typeof Effect>;

/** What the oracle should observe after an action runs. */
export const Expectation = z.object({ sense: Sense, effect: Effect });
export type Expectation = z.infer<typeof Expectation>;

export const EvidenceMetric = z.enum(['luma-mask-vs-ring', 'luma-abs', 'rb-ratio', 'centroid', 'rms', 'transcript', 'ack', 'none']);
export type EvidenceMetric = z.infer<typeof EvidenceMetric>;

/** SPEC §3.3: what the HUD's "sent / expected / observed" strip shows. One per verification attempt. */
export const Evidence = z.object({
  evidenceId: Id,
  cardId: Id.optional(),
  driverId: Id.optional(),
  actionId: Id,
  execId: Id,
  attempt: z.number().int().min(1),
  sent: z.object({ op: ExecOp, at: z.number() }),
  expected: Expectation,
  observed: z.object({
    sense: Sense,
    metric: EvidenceMetric,
    before: z.number(),
    after: z.number(),
    delta: z.number(),
    threshold: z.number(),
    /** which sensor device produced the measurement */
    sensorDeviceId: Id.optional(),
    note: z.string().max(200).optional(),
  }),
  pass: z.boolean(),
  note: z.string().max(300).optional(),
});
export type Evidence = z.infer<typeof Evidence>;

// --- the driver -----------------------------------------------------------------------------

export const Transport = z.enum(['midi', 'ir', 'local']);
export type Transport = z.infer<typeof Transport>;

export const ProvenanceSource = z.enum(['midi.guide', 'manual', 'irdb', 'web_search', 'learned', 'curated', 'fixture']);
export type ProvenanceSource = z.infer<typeof ProvenanceSource>;

export const Provenance = z.object({
  source: ProvenanceSource,
  /** URL, file path or library key */
  ref: z.string().max(500),
  note: z.string().max(300).optional(),
});
export type Provenance = z.infer<typeof Provenance>;

export const ActionKind = z.enum(['set', 'trigger', 'toggle']);
export type ActionKind = z.infer<typeof ActionKind>;

export const ActionRange = z.object({
  min: z.number(),
  max: z.number(),
  step: z.number().positive().optional(),
});
export type ActionRange = z.infer<typeof ActionRange>;

export const VerifyState = z.enum(['pending', 'pass', 'fail', 'untested']);
export type VerifyState = z.infer<typeof VerifyState>;

export const DriverAction = z.object({
  actionId: Id,
  /** short, e.g. "Cutoff", "Lights off" */
  label: z.string().min(1).max(40),
  kind: ActionKind,
  description: z.string().max(300).optional(),
  /** "set" only: the control's value range; the server maps it onto the encode's domain */
  range: ActionRange.optional(),
  /** Mapping from a normalized gesture to this action's range. */
  curve: z.enum(['linear', 'exponential', 'step']).optional(),
  encode: ActionEncode,
  expect: Expectation.optional(),
  /** action that undoes this one (UNDO is never empty) */
  inverseActionId: Id.optional(),
  /** needs a pinch-and-hold before it runs (irreversible on the device) */
  confirm: z.enum(['tap', 'hold']).optional(),
  verified: VerifyState.optional(),
});
export type DriverAction = z.infer<typeof DriverAction>;

/** SPEC §3.2. The whole thing is validated server-side before any action can execute. */
export const Driver = z.object({
  driverId: Id,
  cardId: Id,
  name: z.string().max(120).optional(),
  transport: Transport,
  /** which paired client executes it (and on which of its ports) */
  executor: z.object({ deviceId: Id, port: z.string().max(256).optional() }),
  provenance: z.array(Provenance).max(12),
  actions: z.array(DriverAction).min(1).max(64),
  /** verified actions whose encodes must never be sent faster than this, per second */
  maxRateHz: z.number().min(0.1).max(RATE_LIMITS.midiPerSec).optional(),
  notes: z.string().max(2000).optional(),
  /** the Meta model that wrote it, e.g. "muse-wonder-1.0" */
  modelId: z.string().max(120).optional(),
  source: ModelSource.optional(),
  version: z.number().int().min(1).optional(),
});
export type Driver = z.infer<typeof Driver>;

/**
 * The shape Muse writes: no ids or executor (the server stamps them), no verified flags.
 * Everything else is the model's.
 */
export const DriverDraft = Driver.omit({ driverId: true, executor: true, modelId: true, source: true, version: true }).extend({
  actions: z
    .array(DriverAction.omit({ verified: true }))
    .min(1)
    .max(64),
});
export type DriverDraft = z.infer<typeof DriverDraft>;
