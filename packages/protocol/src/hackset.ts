/**
 * ce.hackset/1: the semantic hack set a Meta model writes for one device (SPEC §3.4; field rules from the
 * creative direction). Every hack is bound to driver actions by `actionId`; the server runs the commands
 * through the validated Driver, so a hack set never carries raw MIDI bytes or IR codes itself.
 *
 *   action  = one-shot (a row in the hack menu)        · control = a continuous/stepped 3D control
 *   daemon  = persistent automation (source signal -> hack param), rate-capped
 *
 * Control-loop contract (server runtime): a gen3d control whose id equals a hack id drives that hack; on
 * control.event {widgetId: hackId, value} the server runs `commands` in order; a command with `param`
 * takes the event value (clamped to the action range), otherwise its fixed `value`. Rates respect
 * `max_rate_hz` (<= 3). Undo = `inverse.commands`, or restore the param's previous value when
 * `inverse.restore` is set.
 */
import { z } from 'zod';
import { Id, ModelSource } from './primitives';

export const HACKSET_VERSION = 'ce.hackset/1' as const;

/** Nothing in the room may change faster than this (photosensitivity, SPEC §3.2). */
export const MAX_HACK_RATE_HZ = 3;

export const HackKind = z.enum(['action', 'control', 'daemon']);
export type HackKind = z.infer<typeof HackKind>;

export const HackArchetype = z.enum(['knob', 'slider', 'ring', 'lever', 'xy', 'pads', 'toggle', 'button']);
export type HackArchetype = z.infer<typeof HackArchetype>;

export const HackSize = z.enum(['s', 'm', 'l']);
export type HackSize = z.infer<typeof HackSize>;

export const OracleType = z.enum(['camera', 'mic', 'wire', 'serial', 'none']);
export type OracleType = z.infer<typeof OracleType>;

export const OracleExpect = z.enum([
  'on',
  'off',
  'brighter',
  'dimmer',
  'warmer',
  'cooler',
  'dimmer+warmer',
  'colour_shift',
  'luminance_tracks_param',
  'louder',
  'quieter',
  'silent',
  'centroid_up',
  'centroid_down',
  'tempo_match',
  'screen_changed',
  'text_on_screen',
  'heard_text',
  'paper_moved',
  'usb_echo',
  'serial_ack',
  'none',
]);
export type OracleExpect = z.infer<typeof OracleExpect>;

export const HackStatus = z.enum(['ready', 'locked', 'queued', 'uploading', 'verified', 'failed']);
export type HackStatus = z.infer<typeof HackStatus>;

/** How the channel to the device is realised (HUD glyph + ping-line style). */
export const HackChannel = z.enum(['usb', 'midi', 'ir', 'wifi', 'ble', 'serial', 'local', 'sim']);
export type HackChannel = z.infer<typeof HackChannel>;

/** A continuous value the user sets (one per control hack, optionally more for daemons). */
export const HackParam = z.object({
  id: Id,
  name: z.string().min(1).max(24),
  min: z.number(),
  max: z.number(),
  default: z.number().optional(),
  unit: z.string().max(8).optional(),
  step: z.number().positive().optional(),
});
export type HackParam = z.infer<typeof HackParam>;

/**
 * One driver action call. `param` = take the live value of that param (clamped to the action range).
 * `cardId` = the device whose driver holds the action (room combos span devices; omitted = the hack set's device).
 */
export const HackCommand = z.object({
  /** driver actionId */
  action: Id,
  value: z.number().optional(),
  param: Id.optional(),
  /** wait before this command, ms */
  delayMs: z.number().int().min(0).max(10_000).optional(),
  cardId: Id.optional(),
});
export type HackCommand = z.infer<typeof HackCommand>;

export const HackControl = z.object({
  archetype: HackArchetype,
  size: HackSize.optional(),
  /** the param this control sets */
  param: Id,
});
export type HackControl = z.infer<typeof HackControl>;

export const HackOracle = z.object({
  type: OracleType,
  /** camera: which pixels (default mask) */
  region: z.enum(['mask', 'ring', 'frame']).optional(),
  expect: OracleExpect,
  /** required when type is "none": why this hack cannot be checked (rendered as unverified) */
  reason: z.string().max(120).optional(),
});
export type HackOracle = z.infer<typeof HackOracle>;

export const HackInverse = z.object({
  /** restore this param to its value before the hack ran */
  restore: Id.optional(),
  commands: z.array(HackCommand).max(8).optional(),
});
export type HackInverse = z.infer<typeof HackInverse>;

export const Hack = z.object({
  id: Id,
  /** verb-first, <= 24 chars ("Dim room", "Open filter") */
  name: z.string().min(1).max(24),
  kind: HackKind,
  /** plain effect, <= 40 chars ("brightness 0-100") */
  blurb: z.string().max(40).optional(),
  params: z.array(HackParam).max(4).optional(),
  control: HackControl.optional(),
  commands: z.array(HackCommand).min(1).max(8),
  oracle: HackOracle,
  reversible: z.boolean().optional(),
  inverse: HackInverse.optional(),
  /** "hold" = pinch-and-hold before it runs (irreversible on the device) */
  confirm: z.enum(['tap', 'hold']).optional(),
  max_rate_hz: z.number().min(0.05).max(MAX_HACK_RATE_HZ),
  /** server-owned: set from verification evidence */
  status: HackStatus.optional(),
});
export type Hack = z.infer<typeof Hack>;

export const DaemonTrigger = z.object({
  /** "device.<cardId>.<signal>" (e.g. clock_bpm, level, note_on) or "control.<hackId>" */
  source: z.string().min(1).max(80),
});
export type DaemonTrigger = z.infer<typeof DaemonTrigger>;

export const DaemonMap = z.object({
  curve: z.enum(['linear', 'sine', 'step']),
  /** output range written into the target param */
  range: z.array(z.number()).min(2).max(2),
  period_bars: z.number().positive().max(64).optional(),
});
export type DaemonMap = z.infer<typeof DaemonMap>;

export const DaemonTarget = z.object({
  hack: Id,
  param: Id.optional(),
});
export type DaemonTarget = z.infer<typeof DaemonTarget>;

export const Daemon = z.object({
  id: Id,
  name: z.string().min(1).max(24),
  blurb: z.string().max(40).optional(),
  trigger: DaemonTrigger,
  map: DaemonMap.optional(),
  targets: z.array(DaemonTarget).min(1).max(4),
  /** default 2; never above 3 */
  max_rate_hz: z.number().min(0.05).max(MAX_HACK_RATE_HZ),
  status: z.enum(['proposed', 'running', 'paused', 'killed']).optional(),
});
export type Daemon = z.infer<typeof Daemon>;

export const HackSetDevice = z.object({
  /** @ce/protocol device.card id */
  id: Id,
  name: z.string().min(1).max(60),
  kind: z.string().max(32).optional(),
  channel: z.object({ type: HackChannel, via: Id.optional() }),
});
export type HackSetDevice = z.infer<typeof HackSetDevice>;

export const HackSet = z.object({
  spec: z.literal(HACKSET_VERSION),
  device: HackSetDevice,
  hacks: z.array(Hack).min(1).max(12),
  daemons: z.array(Daemon).max(4).optional(),
  notes: z.string().max(400).optional(),
  source: ModelSource.optional(),
  /** the Meta model that wrote it */
  modelId: z.string().max(120).optional(),
});
export type HackSet = z.infer<typeof HackSet>;
