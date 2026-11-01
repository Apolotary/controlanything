/**
 * Payload schemas, one per message type. Direction: C = client, S = server.
 * Payloads that a Meta model may generate (device.card, ui.spec, driver.deploy, agent.step)
 * are kept flat and JSON-Schema-friendly so they can be passed as `response_format` json_schema.
 */
import { z } from 'zod';
import {
  PairApproveRequest,
  PairDenyRequest,
  PairingStatus,
  PairStartRequest,
  PendingPairing,
} from './pairing';
import {
  BBox,
  CameraIntrinsics,
  Capability,
  ControlValue,
  Detection,
  DeviceInfo,
  DeviceKind,
  Id,
  ModelSource,
  Port,
  Pose,
  Role,
} from './primitives';

// --- connection -----------------------------------------------------------------------------

/** C->S. First message on a socket. The server takes name, kind and approval rights from its registry. */
export const HelloPayload = z.object({
  deviceToken: z.string().min(1).max(256),
  /** how this device acts now; defaults by kind (quest=hmd, mac=companion, ...) */
  role: Role.optional(),
  /** replaces the registered capabilities (descriptive only, not a privilege) */
  capabilities: z.array(Capability).max(32).optional(),
  ports: z.array(Port).max(128).optional(),
  /** client app name and version, e.g. "companion@0.1.0" */
  app: z.string().max(120).optional(),
});
export type HelloPayload = z.infer<typeof HelloPayload>;

/** S->C. Reply to a valid hello. Send `hello` again at any time to update role/capabilities/ports. */
export const WelcomePayload = z.object({
  /** this connection */
  clientId: Id,
  deviceId: Id,
  name: z.string(),
  kind: DeviceKind,
  role: Role,
  canApprove: z.boolean(),
  spaceId: Id,
  protocol: z.number().int(),
  server: z.string(),
  mode: ModelSource,
});
export type WelcomePayload = z.infer<typeof WelcomePayload>;

/** S->C. Everyone paired to the space, with online state. Sent on every join/leave/update. */
export const PresencePayload = z.object({
  spaceId: Id,
  devices: z.array(DeviceInfo).max(256),
  reason: z.enum(['join', 'leave', 'update', 'paired', 'revoked']).optional(),
  /** the device whose change triggered this presence */
  deviceId: Id.optional(),
});
export type PresencePayload = z.infer<typeof PresencePayload>;

// --- pairing --------------------------------------------------------------------------------

/** C->S (unauthenticated socket allowed). Same body as POST /api/pair/start; answered with `pair.status`. */
export const PairStartPayload = PairStartRequest;

/**
 * S->C: state of a pairing request (answer to `pair.start`, and on every change).
 * C->S: send {pairingId, pollSecret} without `status` to watch a request on this socket (after a reconnect).
 */
export const PairStatusPayload = z.object({
  pairingId: Id,
  status: PairingStatus.optional(),
  pollSecret: z.string().max(128).optional(),
  code: z.string().max(32).optional(),
  display: z.string().max(32).optional(),
  qr: z.string().max(512).optional(),
  expiresAt: z.number().optional(),
});
export type PairStatusPayload = z.infer<typeof PairStatusPayload>;

/** C->S from an approver (paired quest/mac/iphone, or a localhost socket). */
export const PairApprovePayload = PairApproveRequest;
/** C->S from an approver. */
export const PairDenyPayload = PairDenyRequest;

/** S->approvers. Someone wants to join: show "Cardputer wants to join · K7Q-4M2". */
export const PairPendingPayload = PendingPairing;

/** S->approvers and S->the new device. `deviceToken` is only in the new device's own copy. */
export const PairApprovedPayload = z.object({
  pairingId: Id,
  deviceId: Id,
  name: z.string(),
  kind: DeviceKind,
  canApprove: z.boolean(),
  approvedBy: z.string().max(120).optional(),
  deviceToken: z.string().optional(),
});
export type PairApprovedPayload = z.infer<typeof PairApprovedPayload>;

/** S->approvers and S->the requesting device. */
export const PairDeniedPayload = z.object({
  pairingId: Id,
  reason: z.enum(['denied', 'expired', 'too_many_attempts']),
  message: z.string().max(500).optional(),
});
export type PairDeniedPayload = z.infer<typeof PairDeniedPayload>;

// --- perception -----------------------------------------------------------------------------

/** C->S (usually the HMD). A passthrough frame for the agent, optionally with pose and detections. */
export const SnapshotPayload = z.object({
  snapshotId: Id,
  /** base64 JPEG bytes, no "data:" prefix */
  jpegBase64: z.string().min(1).max(12_000_000),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  /** epoch ms when the camera frame was captured */
  capturedAt: z.number(),
  /** reference space of the poses, e.g. WebXR "local-floor" */
  space: z.string().max(64).optional(),
  headPose: Pose.optional(),
  cameraPose: Pose.optional(),
  intrinsics: CameraIntrinsics.optional(),
  detections: z.array(Detection).max(200).optional(),
  /** what the user said or typed with this snapshot, e.g. "what is this?" */
  text: z.string().max(4000).optional(),
  purpose: z.enum(['identify', 'track', 'context']).optional(),
});
export type SnapshotPayload = z.infer<typeof SnapshotPayload>;

// --- agent work log -------------------------------------------------------------------------

export const AgentPhase = z.enum([
  'capture',
  'identify',
  'research',
  'plan',
  'codegen',
  'verify',
  'deploy',
  'ui',
  'control',
  'other',
]);
export type AgentPhase = z.infer<typeof AgentPhase>;

export const StepStatus = z.enum(['pending', 'running', 'ok', 'fail']);
export type StepStatus = z.infer<typeof StepStatus>;

/** S->C. One line of the live work log. Re-send with the same stepId to update its status. */
export const AgentStepPayload = z.object({
  stepId: Id,
  runId: Id.optional(),
  parentId: Id.optional(),
  phase: AgentPhase,
  status: StepStatus,
  title: z.string().max(200),
  detail: z.string().max(4000).optional(),
  /** Meta model that did the work, e.g. "muse-spark-1.3" */
  model: z.string().max(120).optional(),
  source: ModelSource.optional(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
});
export type AgentStepPayload = z.infer<typeof AgentStepPayload>;

// --- identified physical devices (the synth, the lamp...) -----------------------------------

export const DeviceCategory = z.enum([
  'synthesizer',
  'drum-machine',
  'sampler',
  'groovebox',
  'midi-controller',
  'audio-interface',
  'effects',
  'lighting',
  'remote-control',
  'appliance',
  'computer',
  'microcontroller',
  'phone',
  'other',
]);
export type DeviceCategory = z.infer<typeof DeviceCategory>;

export const DeviceProtocol = z.enum(['midi', 'ble', 'serial', 'ir', 'http', 'osc', 'hid', 'other']);
export type DeviceProtocol = z.infer<typeof DeviceProtocol>;

/**
 * S->C. A physical device the agent identified. Not a paired client: `cardId` names the card;
 * ui.spec and driver.deploy refer to it.
 */
export const DeviceCardPayload = z.object({
  cardId: Id,
  name: z.string().max(120),
  maker: z.string().max(120),
  /** model name or number; empty string when unknown */
  model: z.string().max(120),
  category: DeviceCategory,
  confidence: z.number().min(0).max(1),
  protocols: z.array(DeviceProtocol).max(8),
  /** visible cues and facts behind the identification */
  evidence: z.array(z.string().max(300)).max(12),
  /** client capabilities needed to control it, e.g. ["midi"]: no such client online = ask for a companion */
  requires: z.array(Capability).max(8).optional(),
  snapshotId: Id.optional(),
  bbox: BBox.optional(),
  notes: z.string().max(2000).optional(),
  source: ModelSource.optional(),
});
export type DeviceCardPayload = z.infer<typeof DeviceCardPayload>;

// --- generated control surface (v0) ---------------------------------------------------------

export const WidgetKind = z.enum(['knob', 'fader', 'button', 'toggle', 'xy', 'pads']);
export type WidgetKind = z.infer<typeof WidgetKind>;

export const Range = z.object({
  min: z.number(),
  max: z.number(),
  step: z.number().positive().optional(),
});
export type Range = z.infer<typeof Range>;

/**
 * What a widget does: a driver action plus static arguments. The MIDI fields let a generic
 * runtime execute "midi.cc" / "midi.note" bindings without generated driver code.
 */
export const Binding = z.object({
  /** driver action, e.g. "midi.cc", "midi.note", "ir.send", or a generated driver's own action */
  action: z.string().min(1).max(120),
  driverId: Id.optional(),
  /** MIDI channel 1-16 */
  channel: z.number().int().min(1).max(16).optional(),
  cc: z.number().int().min(0).max(127).optional(),
  note: z.number().int().min(0).max(127).optional(),
  args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export type Binding = z.infer<typeof Binding>;

export const Pad = z.object({
  label: z.string().max(40).optional(),
  /** overrides binding.note for this pad */
  note: z.number().int().min(0).max(127).optional(),
  color: z.string().max(32).optional(),
});
export type Pad = z.infer<typeof Pad>;

export const LayoutHints = z.object({
  /** section name, e.g. "Filter" */
  group: z.string().max(60).optional(),
  row: z.number().int().min(0).max(32).optional(),
  col: z.number().int().min(0).max(32).optional(),
  span: z.number().int().min(1).max(12).optional(),
  size: z.enum(['s', 'm', 'l']).optional(),
  color: z.string().max(32).optional(),
  /** XR placement: floating panel, next to the physical device, or on the hand */
  anchor: z.enum(['panel', 'device', 'hand']).optional(),
});
export type LayoutHints = z.infer<typeof LayoutHints>;

export const Widget = z.object({
  id: z.string().min(1).max(64),
  kind: WidgetKind,
  label: z.string().max(60),
  /** knob/fader value range, and the x axis of an xy pad (default 0..1) */
  range: Range.optional(),
  /** xy only: y axis range */
  yRange: Range.optional(),
  default: ControlValue.optional(),
  unit: z.string().max(16).optional(),
  binding: Binding,
  /** xy only: binding for the y axis */
  yBinding: Binding.optional(),
  /** pads only */
  pads: z.array(Pad).max(64).optional(),
  layout: LayoutHints.optional(),
  description: z.string().max(300).optional(),
});
export type Widget = z.infer<typeof Widget>;

/** S->C. A generated control surface: a flat list of widgets. */
export const UiSpecPayload = z.object({
  specId: Id,
  title: z.string().max(120),
  cardId: Id.optional(),
  driverId: Id.optional(),
  widgets: z.array(Widget).min(1).max(64),
  notes: z.string().max(2000).optional(),
  source: ModelSource.optional(),
});
export type UiSpecPayload = z.infer<typeof UiSpecPayload>;

/** C->C (relayed, low latency). A widget moved. */
export const ControlEventPayload = z.object({
  widgetId: z.string().min(1).max(64),
  value: ControlValue,
  /** when the gesture happened, sender clock, epoch ms */
  ts: z.number(),
  specId: Id.optional(),
  /** pads only: which pad */
  index: z.number().int().min(0).max(63).optional(),
  phase: z.enum(['start', 'move', 'end']).optional(),
});
export type ControlEventPayload = z.infer<typeof ControlEventPayload>;

// --- drivers --------------------------------------------------------------------------------

export const DriverRuntime = z.enum(['browser-js', 'node', 'micropython', 'arduino', 'other']);
export type DriverRuntime = z.infer<typeof DriverRuntime>;

export const DriverAction = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
});
export type DriverAction = z.infer<typeof DriverAction>;

/** S->C (usually targeted with `to`). Generated driver code for a client to load. */
export const DriverDeployPayload = z.object({
  driverId: Id,
  version: z.number().int().min(1),
  cardId: Id.optional(),
  runtime: DriverRuntime,
  language: z.enum(['javascript', 'typescript', 'python', 'cpp', 'other']),
  code: z.string().max(500_000),
  /** exported function/class name to call, if the runtime needs one */
  entry: z.string().max(120).optional(),
  actions: z.array(DriverAction).max(128),
  notes: z.string().max(2000).optional(),
  source: ModelSource.optional(),
});
export type DriverDeployPayload = z.infer<typeof DriverDeployPayload>;

/** C->S. What happened to a deployed driver. */
export const DriverStatusPayload = z.object({
  driverId: Id,
  version: z.number().int().min(1).optional(),
  status: z.enum(['received', 'loading', 'running', 'stopped', 'error']),
  detail: z.string().max(4000).optional(),
});
export type DriverStatusPayload = z.infer<typeof DriverStatusPayload>;

// --- logging --------------------------------------------------------------------------------

/** Any direction. The hub answers invalid or refused messages with level "error" and a code. */
export const LogPayload = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string().max(4000),
  code: z.string().max(64).optional(),
  /** id of the message this log refers to */
  ref: z.string().max(128).optional(),
  issues: z.array(z.string().max(500)).max(20).optional(),
});
export type LogPayload = z.infer<typeof LogPayload>;
