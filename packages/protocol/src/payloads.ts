/**
 * Payload schemas, one per message type. Direction: C = client, S = server.
 * Payloads that a Meta model may generate (device.card, driver.spec, ui.spec, agent.step)
 * are kept flat and JSON-Schema-friendly so they can be passed as `response_format` json_schema.
 *
 * Protocol v1 adds the discovery loop (SPEC §3.1): scan.frame/scan.result, target.select/target.status,
 * link.request/link.result, driver.spec (+ driver.status), exec.command/exec.ack, sense.request/sense.result,
 * verify.result (Evidence), arm.request/arm.confirm/arm.result, panic, voice.audio/voice.text,
 * gen3d.generate/gen3d.edit, and ui.spec v1 (gen3d spec + hack set).
 *
 * Naming: the identified physical device is always `cardId` (the device.card id); a paired client is
 * `deviceId`. Large or frequent client -> server payloads (scan.frame, voice.audio, sense.result, exec.ack)
 * should be sent with envelope `to: "server"` so the hub does not relay them to every other client.
 */
import { Control as Gen3dControl, Gen3dSpec, HackItem as Gen3dHackItem, Part as Gen3dPart } from '@ce/gen3d';
import { z } from 'zod';
import { Driver, Evidence, ExecOp, IrCapture, VerifyState } from './driver';
import { GestureMap } from './gestures';
import { Hack, HackSet } from './hackset';
import { RoomPlacement } from './library';
import { ObjectInformation } from './object-information';
import { WorkspaceContext } from './workspace-context';
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
  Polygon,
  Port,
  Pose,
  PxBox,
  Role,
  TargetState, Vec3 } from './primitives';

// --- connection -----------------------------------------------------------------------------

/** C->S. First message on a socket. The server takes name, kind and approval rights from its registry. */
export const HelloPayload = z.object({
  /** Whether this browser tab owns the companion executor lock. */
  executor: z.boolean().optional(),
  deviceToken: z.string().min(1).max(256),
  /** how this device acts now; defaults by kind (quest=hmd, mac=companion, ...) */
  role: Role.optional(),
  /** replaces the registered capabilities (descriptive only, not a privilege) */
  capabilities: z.array(Capability).max(32).optional(),
  ports: z.array(Port).max(128).optional(),
  /** client app name and version, e.g. "companion@0.1.0" */
  app: z.string().max(120).optional(),
  /**
   * Headsets: whether this tab is visible now (document.visibilityState === 'visible'). A hidden tab that
   * (re)connects while another socket of the same headset owns the session does not take it over: it is told
   * `session.superseded` {reason:'background-tab'} instead. Omitted = foreground (the newest socket wins).
   */
  foreground: z.boolean().optional(),
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

/**
 * C->S. "This tab is the one in use": the newest claim for a headset identity wins (also implied by every new
 * hmd socket's hello). The Quest sends it on visibilitychange→visible and on Enter AR. Never relayed.
 */
export const SessionClaimPayload = z.object({});
export type SessionClaimPayload = z.infer<typeof SessionClaimPayload>;

/**
 * WIRE: Muse writes the glue between the wearer's hands and a device, live, after the wearer asks (see
 * research/36-muse-wiring-contract.md). Nothing is pre-wired: no request, no interaction.
 */
/** C->S (hmd). "What should my hands do?" — a chip, transcribed speech or typed text, for one armed or selected card. */
export const WireRequestPayload = z.object({
  /** Client ask epoch; new clients always provide it, older request senders remain compatible. */
  requestId: Id.optional(),
  cardId: z.string().min(1).max(128),
  text: z.string().min(1).max(500),
  source: z.enum(['chip', 'voice', 'text']),
});
export type WireRequestPayload = z.infer<typeof WireRequestPayload>;

/** One driver action a wiring program may drive (ids from the verified driver; ranges in the action's units). */
export const WireAction = z.object({
  actionId: z.string().min(1).max(64),
  label: z.string().max(64),
  kind: z.enum(['set', 'trigger', 'toggle']),
  min: z.number().optional(),
  max: z.number().optional(),
  maxRateHz: z.number().positive().max(120).optional(),
});
export type WireAction = z.infer<typeof WireAction>;

/**
 * S->C (hmd + companion). Progress while Muse writes and the server checks a wiring program.
 * `codeDelta` appends streamed source while phase = writing; `code` replaces it (repairs, final text).
 */
export const WireProgressPayload = z.object({
  requestId: Id.optional(),
  cardId: z.string().min(1).max(128),
  wiringId: z.string().min(1).max(64),
  phase: z.enum(['writing', 'validating', 'dry-run', 'verifying', 'ready', 'failed']),
  request: z.string().max(500).optional(),
  codeDelta: z.string().max(8192).optional(),
  code: z.string().max(8192).optional(),
  title: z.string().max(80).optional(),
  explanation: z.string().max(300).optional(),
  /** Model that wrote the code; 'template' when no Meta model wrote it (always shown to the wearer). */
  model: z.string().max(64),
  source: z.enum(['live', 'fixture', 'template']),
  latencyMs: z.number().nonnegative().optional(),
  /** Validator / dry-run findings, human-readable. */
  issues: z.array(z.string().max(200)).max(12).optional(),
  /** e.g. "dry-run ✓ 120 frames · 3 actions". */
  note: z.string().max(160).optional(),
});
export type WireProgressPayload = z.infer<typeof WireProgressPayload>;

/**
 * S->C (hmd + companion). A validated, dry-run wiring program, ready to run in the headset's sandbox.
 * The headset runs `code` as the body of `function wire(s, out, mem)` and sends each output as a
 * `control.event` with widgetId `wire:<actionId>` on this card; the server dispatches it through the driver.
 */
/**
 * One AR control the Muse agent generated for the wearer (a knob, slider, button or toggle beside the device).
 * Moving it sends `control.event` with widgetId `wire:<actionId>`, the same route as a hand program's output.
 */
export const WireControl = z.object({
  id: z.string().min(1).max(64),
  actionId: z.string().min(1).max(64),
  label: z.string().max(24),
  kind: z.enum(['knob', 'slider', 'button', 'toggle']),
  min: z.number().optional(),
  max: z.number().optional(),
  value: z.number().optional(),
});
export type WireControl = z.infer<typeof WireControl>;

export const WireReadyPayload = z.object({
  requestId: Id.optional(),
  cardId: z.string().min(1).max(128),
  wiringId: z.string().min(1).max(64),
  /** The hand program; empty when the wearer asked only for AR controls. */
  code: z.string().max(8192),
  title: z.string().max(80),
  explanation: z.string().max(300),
  model: z.string().max(64),
  source: z.enum(['live', 'fixture', 'template']),
  actions: z.array(WireAction).min(1).max(16),
  /** Signals the program reads (e.g. ["screen", "right"]); "screen" means the wearer must calibrate the screen first. */
  needs: z.array(z.enum(['right', 'left', 'screen'])).max(3),
  /** Generated AR controls (Muse agent); absent on older hand-program-only wirings. */
  controls: z.array(WireControl).max(8).optional(),
  /** Trusted compiler output from Muse's compact instrument design. */
  ui: Gen3dSpec.optional(),
  visualizer: z.object({ kind: z.enum(['notes', 'trail', 'pulse', 'ripple']), actions: z.array(z.string().min(1).max(41)).max(16) }).optional(),
  /** Where the glue runs on the Mac (Muse agent): the connector entry file and its process. */
  connector: z.object({ entry: z.string().max(200), pid: z.number().int().optional() }).optional(),
});
export type WireReadyPayload = z.infer<typeof WireReadyPayload>;

/** C->S. Stop this request's wiring only; keep the verified device selected/armed for a new ask. */
export const WireStopPayload = z.object({
  cardId: z.string().min(1).max(128), requestId: Id,
  /** Optional only while the first progress message has not supplied the server wiring ID yet. */
  wiringId: z.string().min(1).max(64).optional(), reason: z.string().max(160).optional(),
});
export type WireStopPayload = z.infer<typeof WireStopPayload>;

/** S->requester and its exact device executor on success; never a global Stop or automatic replay. */
export const WireStoppedPayload = z.object({
  cardId: z.string().min(1).max(128), requestId: Id,
  wiringId: z.string().min(1).max(64).optional(), ok: z.boolean(),
  /** ok describes revoked program authority; this separately confirms the known held-output release. */
  releaseConfirmed: z.boolean().optional(), reason: z.string().max(200).optional(),
});
export type WireStoppedPayload = z.infer<typeof WireStoppedPayload>;


/**
 * S->C. Another socket of the same headset identity claimed the session (Quest Browser opened the app in a
 * new tab). The server ignores this socket's control/exec/scan/mode messages from now on and closes it with
 * code 4409 "superseded" after `graceMs`. The client must stop its camera, scanner and sends, and must not
 * reconnect by itself (that would kick the newer tab).
 */
export const SessionSupersededPayload = z.object({
  reason: z.string().min(1).max(64),
  /** server clock, epoch ms */
  at: z.number(),
  /** how long until the server closes this socket */
  graceMs: z.number().int().min(0).optional(),
});
export type SessionSupersededPayload = z.infer<typeof SessionSupersededPayload>;

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

// --- perception (legacy snapshot) -----------------------------------------------------------

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

// --- perception v1: scan frames and SAM results ---------------------------------------------

export const FramePurpose = z.enum(['scan', 'verify', 'pair']);
export type FramePurpose = z.infer<typeof FramePurpose>;

/** Camera facts for one frame. Everything is optional: a handheld scanner (iPhone) has no pose. */
export const CameraInfo = z.object({
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  /** vertical field of view, degrees */
  fovY: z.number().positive().max(180).optional(),
  intrinsics: z.object({ fx: z.number(), fy: z.number(), cx: z.number(), cy: z.number() }).optional(),
  eye: z.enum(['left', 'right', 'mono']).optional(),
  source: z.enum(['passthrough', 'synthetic', 'replay', 'handheld']).optional(),
  /** "locked": the client held a manual exposure across the before/after pair, so absolute luma is comparable */
  exposure: z.enum(['locked', 'auto']).optional(),
  /** world pose of the camera at capture (head pose x head->camera offset), same space as `pose` */
  cameraPose: Pose.optional(),
});
export type CameraInfo = z.infer<typeof CameraInfo>;

/** One SAM 3.1 detection in a scan frame. Boxes and polygons are in pixels of the JPEG that was sent. */
export const ScanDetection = z.object({
  detId: Id,
  /** device category label, e.g. "ceiling light"; never a person */
  label: z.string().max(60),
  /** the SAM concept prompt that found it */
  prompt: z.string().max(60),
  score: z.number().min(0).max(1),
  box: PxBox,
  polygon: Polygon.optional(),
  /** matched to a known target (device.card) */
  cardId: Id.optional(),
  /** matched to a paired client device (its screen was in view, e.g. the Cardputer) */
  deviceId: Id.optional(),
  /** stable across frames while the object stays in view */
  trackId: Id.optional(),
});
export type ScanDetection = z.infer<typeof ScanDetection>;

/**
 * C->S, send with `to: "server"`. One frame for SCAN (<= 1 Hz while scanning), VERIFY (before/after an action,
 * usually inside sense.result) or PAIR (the server decodes pairing QR codes in every frame anyway).
 */
export const ScanFramePayload = z.object({
  frameId: Id,
  /** base64 JPEG bytes, no "data:" prefix; <= 1280 px wide */
  jpeg: z.string().min(1).max(12_000_000),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** epoch ms when the camera frame was captured */
  capturedAt: z.number(),
  /** reference space of the poses, e.g. WebXR "local-floor" */
  space: z.string().max(64).optional(),
  /** viewer (head) pose at capture */
  pose: Pose.optional(),
  camera: CameraInfo.optional(),
  purpose: FramePurpose,
  /** Synthetic demo boxes; accepted only by a fixture server from an owner. */
  fixtureDetections: z.array(ScanDetection.omit({ cardId: true, deviceId: true, trackId: true })).max(64).optional(),
  /** verify frames: the target this frame is about */
  cardId: Id.optional(),
  /** when this frame answers a sense.request */
  senseId: Id.optional(),
  /** scan frames: the wrist filter (Electronics · Objects · All); the server picks the SAM 3.1 text prompts from it */
  filter: z.enum(['electronics', 'objects', 'everything']).optional(),
});
export type ScanFramePayload = z.infer<typeof ScanFramePayload>;

/** A pairing QR code seen in a frame (the server approves it when the sender may approve). */
export const SeenQr = z.object({
  text: z.string().max(512),
  pairingId: Id.optional(),
  approved: z.boolean().optional(),
  box: PxBox.optional(),
});
export type SeenQr = z.infer<typeof SeenQr>;

/** S->C (the frame's sender, and other HUD clients). Detections for one frame; an empty list is a valid "nothing found". */
export const ScanResultPayload = z.object({
  frameId: Id,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  detections: z.array(ScanDetection).max(64),
  qr: z.array(SeenQr).max(8).optional(),
  /** Meta model id, e.g. "sam-3.1" */
  modelId: z.string().max(120),
  source: ModelSource,
  latencyMs: z.number().min(0),
  /** the concept prompts that were run on this frame */
  prompts: z.array(z.string().max(60)).max(16).optional(),
});
export type ScanResultPayload = z.infer<typeof ScanResultPayload>;

/** C->S. The user picked a detection (pinch) or a known device; starts the discovery loop for it. */
export const TargetSelectPayload = z.object({
  /** Correlates explicit virtual-device selection without guessing from generic device labels. */
  requestId: Id.optional(),
  virtual: z.enum(['visual-synth', 'musical-synth']).optional(),
  /** User-chosen placement of a known virtual screen; not a vision detection. */
  position: Vec3.optional(),
  frameId: Id.optional(),
  detId: Id.optional(),
  /** a target already identified earlier */
  cardId: Id.optional(),
  /** a paired client device (the Mac itself, the iPhone...) */
  deviceId: Id.optional(),
  /** what the user said with it, e.g. "control this" */
  text: z.string().max(500).optional(),
  /** the on-device detector's label of the pinched box (e.g. "laptop"); the server identifies it with Muse */
  label: z.string().max(80).optional(),
});
export type TargetSelectPayload = z.infer<typeof TargetSelectPayload>;

/** S->requester. Selection only; setup, camera verification and Enable remain separate steps. */
export const TargetSelectResultPayload = z.object({
  requestId: Id,
  ok: z.boolean(),
  cardId: Id.optional(),
  reason: z.string().max(300).optional(),
  /** CE_DEMO=1: the server started control.setup for this card itself; the client tracks it as its active setup */
  autoSetup: z.boolean().optional(),
});
export type TargetSelectResultPayload = z.infer<typeof TargetSelectResultPayload>;

/** S->paired companion. Opens only the built-in silent visual screen, never device controls. */
export const VisualOpenPayload = z.object({ requestId: Id });
export type VisualOpenPayload = z.infer<typeof VisualOpenPayload>;

/** S->paired companion. Opens the software instrument panel; only a human Mac click unlocks sound. */
export const MusicalOpenPayload = z.object({ requestId: Id });
export type MusicalOpenPayload = z.infer<typeof MusicalOpenPayload>;

/** C->S. Stop work on this target; runId ignores an action from an older run when supplied. */
export const TargetCancelPayload = z.object({
  cardId: Id,
  runId: Id.optional(),
});
export type TargetCancelPayload = z.infer<typeof TargetCancelPayload>;

/** C->S. Try this target again after a recoverable failure or cancellation. */
export const TargetRetryPayload = TargetCancelPayload;
export type TargetRetryPayload = z.infer<typeof TargetRetryPayload>;

/** select-visual-synth (CE_DEMO): Muse named the pinched object the Mac; the headset continues into its visual synth. */
export const GuidanceAction = z.enum(['retry', 'cancel', 'open-companion', 'pair-device', 'select-visual-synth']);
export type GuidanceAction = z.infer<typeof GuidanceAction>;

/** Short, plain guidance for the HUD; every field is optional for older clients. */
export const AgentGuidance = z.object({
  sentence: z.string().min(1).max(200).optional(),
  hint: z.string().min(1).max(300).optional(),
  action: GuidanceAction.optional(),
});
export type AgentGuidance = z.infer<typeof AgentGuidance>;

/** S->all. Where a target is in the loop (drives tag/outline status in the HUD). */
export const TargetStatusPayload = z.object({
  ...AgentGuidance.shape,
  cardId: Id,
  /** identifies the current attempt so retry/cancel actions can ignore stale UI */
  runId: Id.optional(),
  state: TargetState,
  since: z.number(),
  detail: z.string().max(300).optional(),
  driverId: Id.optional(),
  specId: Id.optional(),
  /** which paired client reaches the device, once linked */
  executorDeviceId: Id.optional(),
});
export type TargetStatusPayload = z.infer<typeof TargetStatusPayload>;

// --- agent work log -------------------------------------------------------------------------

export const AgentPhase = z.enum([
  'capture',
  'scan',
  'identify',
  'link',
  'research',
  'plan',
  'drive',
  'codegen',
  'verify',
  'forge',
  'arm',
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
  ...AgentGuidance.shape,
  stepId: Id,
  runId: Id.optional(),
  parentId: Id.optional(),
  /** the target this step is about */
  cardId: Id.optional(),
  phase: AgentPhase,
  status: StepStatus,
  title: z.string().max(200),
  detail: z.string().max(4000).optional(),
  /** short evidence for the worklog row, e.g. "USB says OP-1 ✓" */
  evidence: z.string().max(64).optional(),
  /** proof = deterministic check; opinion = a model's reading */
  kind: z.enum(['proof', 'opinion']).optional(),
  /** Meta model that did the work, e.g. "muse-spark-1.3" */
  model: z.string().max(120).optional(),
  /** reasoning effort used for that call */
  effort: z.string().max(16).optional(),
  latencyMs: z.number().min(0).optional(),
  source: ModelSource.optional(),
  /** fixture replay: the Meta model that produced the recorded answer */
  recordedFrom: z.string().max(120).optional(),
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

/** What kind of paired client is needed to reach the device. */
export const CompanionNeed = z.enum(['none', 'computer_usb', 'ir_blaster', 'phone_ble', 'network']);
export type CompanionNeed = z.infer<typeof CompanionNeed>;

/**
 * S->C. A physical device the agent identified. Not a paired client: `cardId` names the card;
 * ui.spec, driver.spec and every loop message refer to it.
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
  /** other plausible identifications */
  alternatives: z.array(z.object({ maker: z.string().max(120), model: z.string().max(120), confidence: z.number().min(0).max(1) })).max(4).optional(),
  /** legible text seen on the device, quoted */
  visibleText: z.array(z.string().max(120)).max(12).optional(),
  companion: CompanionNeed.optional(),
  /** what to photograph or ask next to raise confidence */
  followUp: z.array(z.string().max(200)).max(4).optional(),
  /** client capabilities needed to control it, e.g. ["midi"]: no such client online = ask for a companion */
  requires: z.array(Capability).max(8).optional(),
  snapshotId: Id.optional(),
  frameId: Id.optional(),
  detId: Id.optional(),
  bbox: BBox.optional(),
  notes: z.string().max(2000).optional(),
  source: ModelSource.optional(),
  modelId: z.string().max(120).optional(),
});
export type DeviceCardPayload = z.infer<typeof DeviceCardPayload>;

// --- linking: which paired client reaches the device --------------------------------------------

/**
 * S->all. The target needs a channel: either no suitable client is online ("needs a companion: Cardputer (IR)")
 * or several could do it. The HUD shows it; the owner plugs in / pairs / picks.
 */
export const LinkRequestPayload = z.object({
  linkId: Id,
  cardId: Id,
  needs: z.array(Capability).min(1).max(8),
  reason: z.string().max(300),
  suggestedClients: z.array(DeviceKind).max(8),
  /** paired clients that could do it (online or not) */
  candidates: z
    .array(z.object({ deviceId: Id, name: z.string().max(120), kind: DeviceKind, online: z.boolean(), port: z.string().max(256).optional() }))
    .max(16)
    .optional(),
  status: z.enum(['needs-companion', 'candidates', 'waiting']),
});
export type LinkRequestPayload = z.infer<typeof LinkRequestPayload>;

export const LinkEvidenceKind = z.enum(['port-name', 'midi-identity', 'audio-label', 'ir-reply', 'user', 'sim']);
export type LinkEvidenceKind = z.infer<typeof LinkEvidenceKind>;

/** S->all. The channel verdict: confirmed / consistent (port name only) / mismatch (wrong device) / unknown. */
export const LinkResultPayload = z.object({
  linkId: Id,
  cardId: Id,
  verdict: z.enum(['confirmed', 'consistent', 'mismatch', 'unknown', 'none']),
  executorDeviceId: Id.optional(),
  channel: z.enum(['midi', 'ir', 'local', 'sim', 'ble']).optional(),
  port: Port.optional(),
  evidence: z.array(z.object({ kind: LinkEvidenceKind, ok: z.boolean(), detail: z.string().max(300) })).max(8),
  reason: z.string().max(300).optional(),
});
export type LinkResultPayload = z.infer<typeof LinkResultPayload>;

// --- generated control surface --------------------------------------------------------------

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

/** Result of the forge's deterministic checks on a spec. */
export const SpecCheck = z.object({
  ok: z.boolean(),
  attempts: z.number().int().min(0),
  errors: z.number().int().min(0),
  warnings: z.number().int().min(0),
});
export type SpecCheck = z.infer<typeof SpecCheck>;

/**
 * S->C. A generated control surface. v1: `gen3d` (ce.gen3d/1, rendered by the Quest in 3D and by 2D clients
 * through its `controls`) + `hackset` (ce.hackset/1, the hack menu). v0 `widgets` stays for 2D clients that
 * only know the flat widget list. Controls bound to unverified actions render disarmed.
 */
export const UiSpecPayload = z.object({
  specId: Id,
  title: z.string().max(120).optional(),
  cardId: Id.optional(),
  driverId: Id.optional(),
  /** revision; edits and undo produce rev + 1 */
  rev: z.number().int().min(1).optional(),
  widgets: z.array(Widget).min(1).max(64).optional(),
  gen3d: Gen3dSpec.optional(),
  hackset: HackSet.optional(),
  gestureMap: GestureMap.optional(),
  notes: z.string().max(2000).optional(),
  source: ModelSource.optional(),
  /** the Meta model that generated it, e.g. "muse-spark-1.3" */
  modelId: z.string().max(120).optional(),
  recordedFrom: z.string().max(120).optional(),
  check: SpecCheck.optional(),
});
export type UiSpecPayload = z.infer<typeof UiSpecPayload>;

/**
 * C->S (and relayed C->C, low latency). A control moved. `widgetId` is the gen3d control id, which equals the
 * hack id for hack-bound controls; a 2D client fires an action hack with {widgetId: hackId, value: true, phase: "end"}.
 */
export const ControlEventPayload = z.object({
  /** Generated WIRE outputs carry their actual program epoch; legacy non-WIRE controls omit it. */
  requestId: Id.optional(), wiringId: z.string().min(1).max(64).optional(),
  widgetId: z.string().min(1).max(64),
  value: ControlValue,
  /** when the gesture happened, sender clock, epoch ms */
  ts: z.number(),
  specId: Id.optional(),
  /** pads only: which pad */
  index: z.number().int().min(0).max(127).optional(),
  phase: z.enum(['start', 'move', 'end']).optional(),
});
export type ControlEventPayload = z.infer<typeof ControlEventPayload>;

/** S->C. The executor acknowledged all operations for the originating control event. */
export const ControlResultPayload = z.object({
  specId: Id,
  widgetId: z.string().min(1).max(64),
  ts: z.number(),
  ok: z.boolean(),
  detail: z.string().max(512).optional(),
});
export type ControlResultPayload = z.infer<typeof ControlResultPayload>;

/**
 * S->C, droppable. One finished piece of a spec while the model is still writing it, so the headset can show
 * the object assembling: a control with its 3D part and hack-menu row. The complete spec follows as ui.spec.
 */
export const UiPartialPayload = z.object({
  specId: Id,
  cardId: Id.optional(),
  runId: Id.optional(),
  seq: z.number().int().min(0),
  control: Gen3dControl.optional(),
  part: Gen3dPart.optional(),
  hackItem: Gen3dHackItem.optional(),
  hack: Hack.optional(),
});
export type UiPartialPayload = z.infer<typeof UiPartialPayload>;

/** C->S. Ask the forge for a hack set + 3D spec for a target (the loop does this itself after VERIFY). */
export const Gen3dGeneratePayload = z.object({
  requestId: Id,
  cardId: Id,
  request: z.string().max(500).optional(),
});
export type Gen3dGeneratePayload = z.infer<typeof Gen3dGeneratePayload>;

/** C->S. A typed (or transcribed) edit of an existing spec: "make resonance a big red lever". */
export const Gen3dEditPayload = z.object({
  requestId: Id,
  specId: Id,
  instruction: z.string().min(1).max(500),
});
export type Gen3dEditPayload = z.infer<typeof Gen3dEditPayload>;

// --- drivers --------------------------------------------------------------------------------

export const DriverRuntime = z.enum(['browser-js', 'node', 'micropython', 'arduino', 'other']);
export type DriverRuntime = z.infer<typeof DriverRuntime>;

export const DriverActionName = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
});
export type DriverActionName = z.infer<typeof DriverActionName>;

/** S->C (usually targeted with `to`). Legacy: generated driver code for a client to load. v1 uses driver.spec. */
export const DriverDeployPayload = z.object({
  driverId: Id,
  version: z.number().int().min(1),
  cardId: Id.optional(),
  runtime: DriverRuntime,
  language: z.enum(['javascript', 'typescript', 'python', 'cpp', 'other']),
  code: z.string().max(500_000),
  /** exported function/class name to call, if the runtime needs one */
  entry: z.string().max(120).optional(),
  actions: z.array(DriverActionName).max(128),
  notes: z.string().max(2000).optional(),
  source: ModelSource.optional(),
});
export type DriverDeployPayload = z.infer<typeof DriverDeployPayload>;

/** S->all. The declarative, validated driver (SPEC §3.2) for a target. Re-sent when actions get verified. */
export const DriverSpecPayload = Driver;
export type DriverSpecPayload = z.infer<typeof DriverSpecPayload>;

export const DriverPhase = z.enum(['drafting', 'validating', 'verifying', 'verified', 'armed', 'disarmed', 'failed']);
export type DriverPhase = z.infer<typeof DriverPhase>;

/**
 * S->all (v1): where a driver is and which of its actions are verified. Also C->S (legacy): what happened to
 * a deployed code driver (`status`).
 */
export const DriverStatusPayload = z.object({
  driverId: Id,
  cardId: Id.optional(),
  version: z.number().int().min(1).optional(),
  phase: DriverPhase.optional(),
  actions: z.array(z.object({ actionId: Id, label: z.string().max(40).optional(), verified: VerifyState })).max(64).optional(),
  /** legacy code-driver lifecycle */
  status: z.enum(['received', 'loading', 'running', 'stopped', 'error']).optional(),
  modelId: z.string().max(120).optional(),
  detail: z.string().max(4000).optional(),
});
export type DriverStatusPayload = z.infer<typeof DriverStatusPayload>;

// --- execution and sensing ------------------------------------------------------------------

/**
 * S->executor (targeted with `to`). One resolved op ("$value" already substituted). `port` = the MIDI output
 * (id, exact name or case-insensitive substring from the executor's hello.ports). `dryRun` = validate and ack
 * without touching the device.
 */
export const ExecCommandPayload = z.object({
  execId: Id,
  executorDeviceId: Id,
  op: ExecOp,
  port: z.string().max(256).optional(),
  dryRun: z.boolean().optional(),
  cardId: Id.optional(),
  driverId: Id.optional(),
  actionId: Id.optional(),
  /** Bytes produced by the current Muse-written connector. The semantic op remains the allowlist. */
  generatedMidi: z.object({
    connectorId: z.string().min(1).max(80),
    hash: z.string().regex(/^[a-f0-9]{64}$/i),
    portId: z.string().min(1).max(256),
    bytes: z.array(z.number().int().min(0).max(255)).min(2).max(3),
  }).optional(),
});
export type ExecCommandPayload = z.infer<typeof ExecCommandPayload>;

export const ExecErrorCode = z.enum(['no_port', 'no_midi', 'no_ir', 'bad_args', 'rate_limited', 'unsupported', 'serial_offline', 'timeout', 'device_error', 'refused']);
export type ExecErrorCode = z.infer<typeof ExecErrorCode>;

/** executor->S, send with `to: "server"`. */
export const ExecAckPayload = z.object({
  execId: Id,
  ok: z.boolean(),
  /** executor clock, epoch ms, when the bytes went out */
  sentAt: z.number(),
  detail: z.string().max(1000).optional(),
  error: ExecErrorCode.optional(),
  /** bytes that came back (MIDI identity reply) */
  reply: z.array(z.number().int().min(0).max(255)).max(256).optional(),
  /** receipt -> bytes out, ms */
  latencyMs: z.number().min(0).optional(),
  /**
   * The executor's own report of the state it applied (the visual synth: its parameters after the command).
   * renderer = a live renderer drew at least one frame with it; port = headless state only.
   */
  applied: z.object({
    source: z.enum(['renderer', 'port', 'musical-synth']),
    /** at most 16 keys; the visual synth sends 0..1 units (symmetry 1..8, pattern 0..3) */
    params: z.record(z.string(), z.number()).optional(),
    visible: z.boolean().optional(),
    frame: z.number().int().min(0).optional(),
    at: z.number().optional(),
    /** Software Web Audio analyser evidence, sampled before the master mute; never a physical audio acknowledgment. */
    audio: z.object({
      unlocked: z.boolean(), muted: z.boolean(),
      rms: z.number().finite().min(0), peak: z.number().finite().min(0),
      frequency: z.number().finite().min(0).max(24000),
      activeNote: z.number().int().min(0).max(127).optional(),
    }).optional(),
  }).optional(),
});
export type ExecAckPayload = z.infer<typeof ExecAckPayload>;

export const SenseKind = z.enum(['frame', 'audio-features', 'ir-capture', 'audio-clip']);
export type SenseKind = z.infer<typeof SenseKind>;

/**
 * S->sensor (targeted with `to`). frame: send one verify frame (sense.result.frame). audio-features: measure a
 * window of `durationMs` (default 600); `offsetMs` < 0 = take it from the sensor's rolling buffer (e.g. -500 =
 * the 500 ms before now, a free "before"). ir-capture: listen for remote presses for `durationMs`, one
 * sense.result per frame seen; `prompt` is shown to the user ("press 全灯 once"). audio-clip: record the
 * microphone for `durationMs` and return the WAV (the server transcribes it to hear a device speak).
 */
export const SenseRequestPayload = z.object({
  senseId: Id,
  sensorDeviceId: Id,
  kind: SenseKind,
  durationMs: z.number().int().min(0).max(60_000).optional(),
  offsetMs: z.number().int().min(-10_000).max(10_000).optional(),
  cardId: Id.optional(),
  prompt: z.string().max(200).optional(),
});
export type SenseRequestPayload = z.infer<typeof SenseRequestPayload>;

/** Audio features of one window (companion mic or the synth's own USB audio input). */
export const AudioFeatures = z.object({
  /** linear RMS 0..1 */
  rms: z.number().min(0),
  /** dBFS */
  rmsDb: z.number().optional(),
  peak: z.number().min(0).optional(),
  /** magnitude-weighted spectral centroid, Hz */
  centroidHz: z.number().min(0),
  /** mean power per band, dB */
  bands: z.array(z.number()).max(32),
  bandEdgesHz: z.array(z.number().min(0)).max(33).optional(),
  /** mean log spectrum, for A-B-A-B comparisons */
  spec: z.array(z.number()).max(128).optional(),
  windowMs: z.number().min(0).optional(),
  sampleRate: z.number().positive().optional(),
  /** input label, e.g. "OP-1" (USB audio) or "MacBook Pro Microphone" */
  input: z.string().max(120).optional(),
  silent: z.boolean().optional(),
  clipped: z.boolean().optional(),
});
export type AudioFeatures = z.infer<typeof AudioFeatures>;

/** A short recording (kind "audio-clip"): mono 16-bit PCM WAV, 16 or 24 kHz, as Muse Voice Transcribe wants it. */
export const AudioClip = z.object({
  /** base64 WAV bytes */
  wav: z.string().min(1).max(8_000_000),
  sampleRate: z.number().int().positive().optional(),
  durationMs: z.number().int().min(0).optional(),
  /** input label, e.g. "MacBook Pro Microphone" */
  input: z.string().max(120).optional(),
});
export type AudioClip = z.infer<typeof AudioClip>;

/** sensor->S, send with `to: "server"`. */
export const SenseResultPayload = z.object({
  senseId: Id,
  kind: SenseKind,
  frame: ScanFramePayload.optional(),
  audio: AudioFeatures.optional(),
  ir: IrCapture.optional(),
  clip: AudioClip.optional(),
  /** sensor clock, epoch ms, when the measurement was taken */
  at: z.number(),
  ok: z.boolean().optional(),
  error: z.string().max(300).optional(),
});
export type SenseResultPayload = z.infer<typeof SenseResultPayload>;

/** S->all. One verification attempt: sent / expected / observed (SPEC §3.3). */
export const VerifyResultPayload = Evidence;
export type VerifyResultPayload = z.infer<typeof VerifyResultPayload>;

// --- signals and daemons --------------------------------------------------------------------

/**
 * C->S, droppable, send with `to: "server"`. Something a client measured about a device, for daemons:
 * "clock_bpm" (tempo from incoming MIDI clock), "note_on", "level" (0..1). `cardId` when the client knows
 * which identified device it is about; otherwise the server maps the sender to its linked targets.
 */
export const DeviceSignalPayload = z.object({
  cardId: Id.optional(),
  /** the paired client that measured it (defaults to the sender) */
  deviceId: Id.optional(),
  signal: z.string().min(1).max(64),
  value: z.number(),
  unit: z.string().max(16).optional(),
  /** sender clock, epoch ms */
  at: z.number(),
});
export type DeviceSignalPayload = z.infer<typeof DeviceSignalPayload>;

export const DaemonState = z.enum(['proposed', 'running', 'paused', 'stopped', 'failed']);
export type DaemonState = z.infer<typeof DaemonState>;

/** S->all. A persistent automation changed state (the HUD's daemon-link chip). */
export const DaemonStatusPayload = z.object({
  daemonId: Id,
  specId: Id.optional(),
  /** the device(s) it drives */
  cardId: Id.optional(),
  name: z.string().max(40).optional(),
  state: DaemonState,
  /** tempo it follows, if any */
  bpm: z.number().positive().optional(),
  /** how often it writes its target, per second (<= 3) */
  rateHz: z.number().min(0).max(3).optional(),
  /** where the tempo comes from */
  source: z.enum(['midi-clock', 'voice', 'menu', 'default']).optional(),
  detail: z.string().max(300).optional(),
  at: z.number(),
});
export type DaemonStatusPayload = z.infer<typeof DaemonStatusPayload>;

// --- human confirmation (ARM) and panic -----------------------------------------------------

/**
 * S->approvers. One-tap human confirmation before the first real drive of a target: "Arm 4 verified controls
 * for OP-1 Field?". Answered with arm.confirm; expires on its own.
 */
export const ArmRequestPayload = z.object({
  armId: Id,
  cardId: Id,
  driverId: Id,
  specId: Id.optional(),
  title: z.string().max(120),
  summary: z.string().max(500),
  actions: z.array(z.object({ actionId: Id, label: z.string().max(40), verified: VerifyState })).max(64),
  /** contains an action that cannot be undone on the device: needs a pinch-and-hold */
  irreversible: z.boolean().optional(),
  expiresAt: z.number(),
});
export type ArmRequestPayload = z.infer<typeof ArmRequestPayload>;

/** approver->S, send with `to: "server"`. */
export const ArmConfirmPayload = z.object({
  armId: Id,
  approve: z.boolean(),
  /** the confirmation was a hold (required when arm.request.irreversible) */
  hold: z.boolean().optional(),
});
export type ArmConfirmPayload = z.infer<typeof ArmConfirmPayload>;

/** S->all. */
export const ArmResultPayload = z.object({
  armId: Id,
  cardId: Id,
  driverId: Id,
  armed: z.boolean(),
  by: z.string().max(120).optional(),
  reason: z.string().max(300).optional(),
  /** CE_DEMO=1: armed by the server after verification, with no arm.request; clients accept it for their active setup */
  auto: z.boolean().optional(),
});
export type ArmResultPayload = z.infer<typeof ArmResultPayload>;

/**
 * Any direction. C->S: stop everything (the server sends MIDI panic + IR off to every executor and disarms).
 * S->executors: the fan-out. Scope it with cardId to one target.
 */
export const PanicPayload = z.object({
  reason: z.string().max(300).optional(),
  cardId: Id.optional(),
});
export type PanicPayload = z.infer<typeof PanicPayload>;

// --- voice ----------------------------------------------------------------------------------

/**
 * C->S, send with `to: "server"`. PCM16 little-endian mono chunks (~100 ms) while push-to-talk is held;
 * `final: true` on the last chunk. The server transcribes with Muse Voice Transcribe (the key stays here)
 * and answers with voice.text. Optional cardId/specId say what the words are about (an edit target).
 */
export const VoiceAudioPayload = z.object({
  utteranceId: Id,
  seq: z.number().int().min(0),
  sampleRate: z.union([z.literal(16_000), z.literal(24_000)]),
  /** base64 PCM16LE mono */
  pcm16: z.string().max(2_000_000),
  final: z.boolean().optional(),
  cardId: Id.optional(),
  specId: Id.optional(),
  /** Client-observed UI state, frozen at request start; never control authority. */
  workspace: WorkspaceContext.optional(),
});
export type VoiceAudioPayload = z.infer<typeof VoiceAudioPayload>;

/**
 * S->C: a transcript (partial while `final` is false; the final one is punctuated) with the model id.
 * C->S: a typed command, same fields, treated like a final transcript.
 */
export const VoiceTextPayload = z.object({
  utteranceId: Id.optional(),
  text: z.string().max(2000),
  final: z.boolean(),
  source: ModelSource.optional(),
  modelId: z.string().max(120).optional(),
  latencyMs: z.number().min(0).optional(),
  cardId: Id.optional(),
  specId: Id.optional(),
  /** Client-observed UI state, frozen at request start; never control authority. */
  workspace: WorkspaceContext.optional(),
  /** what the server did with it */
  intent: z.enum(['edit', 'hack', 'scan', 'undo', 'panic', 'question', 'inspect', 'identity', 'setup', 'gesture', 'none']).optional(),
  /** Server-stamped destination for selected-device assistant replies. */
  recipientId: Id.optional(),
  assistant: z.object({
    state: z.enum(['thinking', 'reply', 'setup', 'proposal', 'applied', 'error']),
    text: z.string().min(1).max(2000),
    proposalId: Id.optional(),
    proposalKind: z.enum(['gesture', 'identity', 'peripheral']).optional(),
    /** Server-confirmed peripheral selection; never client-authoritative. */
    selectedCardId: Id.optional(),
    mapping: z.array(z.string().max(240)).max(10).optional(),
    objectInfo: ObjectInformation.optional(),
  }).optional(),
});
export type VoiceTextPayload = z.infer<typeof VoiceTextPayload>;

/** C->S. A proposal belongs to its requesting sender and selected card. */
export const VoiceConfirmPayload = z.object({ cardId: Id, proposalId: Id, accept: z.boolean() });
export type VoiceConfirmPayload = z.infer<typeof VoiceConfirmPayload>;
/** C->S. Abandon a selected-device request, including transcription and deferred proposals. */
export const VoiceCancelPayload = z.object({ cardId: Id, utteranceId: Id.optional() });
export type VoiceCancelPayload = z.infer<typeof VoiceCancelPayload>;

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

// ---------------------------------------------------------------------------------------------------------------------
// Two modes (research/20-two-modes.md): ANNOTATE first (tag devices), CONTROL only when the user switches.

export const Mode = z.enum(['annotate', 'control']);
export type Mode = z.infer<typeof Mode>;

/** C->S. The user switched modes. The server never switches by itself. */
export const ModeSetPayload = z.object({ mode: Mode });
export type ModeSetPayload = z.infer<typeof ModeSetPayload>;

/** S->C. The current mode (also sent on connect). */
export const ModeStatePayload = z.object({ mode: Mode });
export type ModeStatePayload = z.infer<typeof ModeStatePayload>;

/** C->S. Tag a device in ANNOTATE mode: identify it and remember it. Never starts linking or control. */
export const TagAddPayload = z.object({
  cardId: Id.optional(),
  targetId: Id.optional(),
  frameId: Id.optional(),
  detId: Id.optional(),
  label: z.string().min(1).max(80),
  position: Vec3.optional(),
});
export type TagAddPayload = z.infer<typeof TagAddPayload>;

/** C->S. Hide a tag while retaining its saved setup in the library. */
export const TagRemovePayload = z.object({ cardId: Id });
export type TagRemovePayload = z.infer<typeof TagRemovePayload>;

/** How a tagged device can be reached right now. */
export const TagConnection = z.enum(['ready', 'setup', 'offline']);
export type TagConnection = z.infer<typeof TagConnection>;

export const TaggedDevice = z.object({
  /** Advances on an owner-confirmed identity change; clients discard older control caches. */
  identityRevision: z.number().int().nonnegative().optional(),
  placement: RoomPlacement.optional(),
  cardId: Id,
  label: z.string().max(80),
  name: z.string().max(120).optional(),
  category: z.string().max(60).optional(),
  position: Vec3.optional(),
  connection: TagConnection,
  /** one plain sentence: what to connect, or what happens next */
  hint: z.string().max(200).optional(),
  /** Suggested connection action; absent when only a cable is needed. */
  action: GuidanceAction.optional(),
  specId: Id.optional(),
});
export type TaggedDevice = z.infer<typeof TaggedDevice>;

/** S->C. Full snapshot of tagged devices, sent on every change and on connect. */
export const TagsStatePayload = z.object({ tags: z.array(TaggedDevice).max(64) });
export type TagsStatePayload = z.infer<typeof TagsStatePayload>;

/** C->S. CONTROL mode only: set up control for a tagged device (LINK -> LEARN -> DRIVE -> VERIFY -> FORGE -> ARM). */
export const ControlSetupPayload = z.object({ cardId: Id, rerun: z.boolean().optional() });
export type ControlSetupPayload = z.infer<typeof ControlSetupPayload>;

/** C->S. Stop a running control setup. */
export const ControlCancelPayload = z.object({ cardId: Id });
export type ControlCancelPayload = z.infer<typeof ControlCancelPayload>;
