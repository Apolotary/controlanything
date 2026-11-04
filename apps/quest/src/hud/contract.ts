/**
 * The HUD API the app shell (quest-io) calls. Types only: no three.js imports beyond math classes.
 * Mirrors apps/quest/src/app/hud-contract.ts; this file is the one the shell imports once it exists.
 */
import type { Object3D, Quaternion, Vector3 } from 'three';
import type { Channel, ControlEvent, Gen3dSpec, HackItem, HudStatus, LogRow, ModelChip, Patch } from '@ce/gen3d';
import type { CanvasActionPayload, CanvasStatePayload, ObjectInformation, ProjectSpatialScene, SetupProgressView, TaggedDevice } from '@ce/protocol';

export type AppMode = 'annotate' | 'control';
export type ObjectFilter = 'electronics' | 'objects' | 'lights' | 'everything';
export type DeviceConnection = 'ready' | 'setup' | 'offline' | 'unknown';
export interface HomeState { mode: AppMode; filter: ObjectFilter; tagged: number; status: string; canStop?: boolean; visualSynthSelection?: { phase: 'pending' | 'unavailable'; message: string } }
export type MappingOutcome = 'working' | 'review' | 'applied' | 'unchanged' | 'failed' | 'cancelled';
export interface DeviceState { targetId: string; connection: DeviceConnection; hint?: string; action?: TaggedDevice['action']; busy?: boolean; sentence?: string; handControl?: boolean; performAvailable?: boolean; performingLive?: boolean; performanceRoute?: string; pairingSeconds?: number; screenGuide?: boolean; canvasReady?: boolean; silentVisual?: boolean; mappingSummary?: string; mappingActionId?: string; mappingOutcome?: MappingOutcome;
  /** `?perform=1`: the old hand-written Perform mapping (Perform toggle, "Set up gestures") is offered; off by default. Muse writes the wiring now. */
  legacyPerform?: boolean }
export interface CanvasView { targetId: string; state: CanvasStatePayload }

/**
 * "Muse writes the glue": what the wearer asked their hands to do, and the program Muse wrote for it. The wiring
 * controller (wiring/controller.ts) owns the state; the HUD only draws it (device card + code card).
 */
export type WirePhase = 'idle' | 'asked' | 'writing' | 'validating' | 'dry-run' | 'verifying' | 'calibrating' | 'ready' | 'running' | 'stopped' | 'failed';
export interface WireCodeView {
  wiringId: string;
  phase: WirePhase;
  model: string;
  /** live = a Meta model wrote it now; fixture = a recorded answer; template = no Meta model wrote it (always shown) */
  source: 'live' | 'fixture' | 'template';
  request: string;
  /** everything streamed so far (the card types it out) */
  code: string;
  phaseLine: string;
  title?: string;
  explanation?: string;
  /** full = the streaming panel; pill = collapsed while it runs */
  mode: 'full' | 'pill';
  stopped?: boolean;
}
export interface WireCalibrationView {
  step: 'top-left' | 'bottom-right';
  /** 0..1 of the hold on the current corner */
  progress: number;
  message: string;
  /** world points captured so far (top-left, bottom-right) */
  corners: ([number, number, number] | null)[];
  /** the held fingertip, world */
  tip?: [number, number, number];
  /** the calibrated screen corners (TL, TR, BR, BL), world, shown briefly when done */
  outline?: [number, number, number][];
}
export interface WireView {
  targetId: string;
  phase: WirePhase;
  /** the line under the device name */
  prompt: string;
  /** suggestion chips; empty = none shown */
  chips: string[];
  activeChip?: string;
  /** the hold-to-talk button: off = hidden (no microphone) */
  mic: 'off' | 'idle' | 'listening' | 'busy';
  code?: WireCodeView;
  calibration?: WireCalibrationView;
  /** "Recalibrate screen" offered (a screen wiring is calibrated or running) */
  canRecalibrate?: boolean;
}
export interface ProjectView {
  title: string; status: string; projectCount: number; actionCount: number; ready: boolean; running: boolean; engaged: boolean;
  action?: { label: string; kind: 'number' | 'trigger'; value: number };
  chordPads?: { id: string; label: string }[];
  lastChord?: string;
  spatial?: { recipe: ProjectSpatialScene; normalized: number; running: boolean; available: boolean };
}
export type ProjectUiCommand = 'next-project' | 'next-action' | 'start' | 'stop' | 'refresh' | 'trigger' | 'pad' | 'close' | 'open-page' | 'run-spatial';
export interface HelperPairingView { urls: string[]; pairedName?: string }
export interface OnboardingView { step: 'tag' | 'use'; title: string; message: string }
export interface AssistantView {
  targetId: string;
  targetLabel?: string;
  objectInfo?: ObjectInformation;
  state: 'idle' | 'listening' | 'thinking' | 'reply' | 'setup' | 'proposal' | 'applied' | 'error';
  transcript?: string;
  text?: string;
  proposalId?: string;
  proposalKind?: 'gesture' | 'identity' | 'peripheral';
  mapping?: string[];
}

export interface JointState {
  position: Vector3;
  quaternion: Quaternion;
  radius: number;
}

export interface HandState {
  joints: Partial<Record<string, JointState>>;
  pinching: boolean;
  justPinched: boolean;
  justReleased: boolean;
  pinchPoint: Vector3;
  ray: { origin: Vector3; dir: Vector3 };
  /** Unfiltered pose used to detect a pinch-induced ray jump. */
  rawRay?: { origin: Vector3; dir: Vector3 };
  /** Palm facing the head; the HUD uses its dwell to reveal the hand menu. */
  palmUp?: boolean;
  palmUpMs?: number;
  /** true when this "hand" is really a controller */
  controller?: boolean;
  /** Located controller grip, independent of the pointing ray. */
  grip?: { position: Vector3; quaternion: Quaternion };
  /** Left controller menu button, when exposed by the runtime. */
  menuDown?: boolean;
  menuPressed?: boolean;
}

export interface HudFrame {
  time: number;
  dt: number;
  frame?: XRFrame;
  refSpace?: XRReferenceSpace;
  head: { position: Vector3; quaternion: Quaternion; ray?: { origin: Vector3; dir: Vector3 } };
  hands: { left?: HandState; right?: HandState };
  /** 'mouse' while the desktop emulator's mouse drives input: hand-anchored UI uses its fallback. */
  pointer?: 'mouse';
}

/** A detection the shell has placed in the world (capture pose + hit-test, pinch-to-refine). */
export interface HudTarget {
  id: string;
  label: string;
  /** The detector/model label before display shortening; filters and matching use this. */
  rawLabel?: string;
  tagged?: boolean;
  identifying?: boolean;
  busy?: boolean;
  connection?: DeviceConnection;
  locating?: boolean;
  subtitle?: string;
  status: HudStatus;
  channel?: Channel;
  /** world, local-floor */
  position: [number, number, number];
  normal?: [number, number, number];
  /** unit vector device → capture camera: the plane the contour lies in */
  facing?: [number, number, number];
  /** false = fixed-distance guess, drawn dashed */
  confirmed: boolean;
  sizeM?: [number, number, number];
  /** mask outline, metres, in the facing plane, centred on position */
  contour?: [number, number][];
  score?: number;
  modelId?: string;
  /** Detector source. Both sources are selectable; a live pick waits for a matching SAM target. */
  source?: 'sam' | 'yolo';
}

export interface PingLine {
  id: string;
  targetId: string;
  from?: [number, number, number];
  channel: Channel;
  /** false = hypothesis (grey dashed) */
  proven: boolean;
  inFlight?: boolean;
  label?: string;
  status?: HudStatus;
}

export interface AgentStepLike {
  stepId: string;
  title: string;
  status: 'pending' | 'running' | 'ok' | 'fail';
  detail?: string;
  model?: string;
  kind?: 'proof' | 'opinion';
  evidence?: string;
}

export interface UploadState {
  hackId: string;
  label: string;
  steps?: string[];
  stepsDone: number;
  modelId?: string;
  elapsedS?: number;
  verdict?: 'pending' | 'ok' | 'fail';
}

export interface EvidenceState {
  targetId?: string;
  sent: string;
  expect: string;
  seen: string;
  verdict: 'pending' | 'ok' | 'fail';
  sparkline?: number[];
}

export interface ConfirmRequest {
  id: string;
  kind?: 'arm' | 'forget' | 'place';
  primaryLabel?: string;
  cancelLabel?: string;
  title: string;
  summary?: string;
  hold?: boolean;
  expiresAt?: number;
  targetId?: string;
}

export type DeckKey = 'scan' | 'ping' | 'hacks' | 'daemons' | 'undo' | 'mic' | 'panic';

export interface HudEvents {
  exit: Record<string, never>;
  selectTarget: { targetId: string };
  mode: { mode: AppMode };
  filter: { filter: ObjectFilter };
  tagRemove: { targetId: string };
  forget: { targetId: string };
  setup: { targetId: string };
  cancel: { targetId: string };
  pair: { targetId: string };
  pairCancel: { targetId: string };
  pairCode: { targetId: string; code: string };
  helperSkip: Record<string, never>;
  helperPair: Record<string, never>;
  visualSynth: Record<string, never>;
  menuOpened: {};
  askMuseGeneral: {};
  identifyArea: {};
  projectsOpen: Record<string, never>;
  projectsCommand: { command: ProjectUiCommand; actionId?: string };
  projectsPause: Record<string, never>;
  changeDevice: Record<string, never>;
  inspectObject: { targetId: string };
  gestureSetup: { targetId: string };
  canvasCreate: { targetId: string };
  canvasAction: { targetId: string } & Omit<CanvasActionPayload, 'requestId' | 'cardId'>;
  canvasRestore: { targetId: string; revision: number; baseRevision: number };
  canvasClose: { targetId: string };
  assistantTalk: { targetId: string };
  /** The wearer asked their hands to do something: a chip, spoken words or typed text. */
  wireAsk: { targetId: string; text: string; source: 'chip' | 'voice' | 'text' };
  /** Hold-to-talk for a wiring request: down = start listening, up = send. */
  wireTalk: { targetId: string; down: boolean };
  wireRecalibrate: { targetId: string };
  assistantConfirm: { targetId: string; proposalId: string; accept: boolean };
  assistantDismiss: { targetId: string };
  handControl: { targetId: string; enabled: boolean };
  deck: { key: DeckKey; phase: 'press' | 'release' };
  hack: { ts?: number; targetId: string; itemId: string; controlId?: string; index: number; hold?: boolean };
  control: ControlEvent;
  approve: { pairingId: string; approve: boolean };
  confirm: { id: string; approve: boolean; hold?: boolean };
  /** a pinch or poke landed on a HUD widget: the shell must not treat it as lock / refine */
  consumed: { hand: string; widget: 'control' | 'hack' | 'deck' | 'handle' | 'confirm' | 'approval' };
  grab: { specId: string; position: [number, number, number]; yawDeg: number };
}

export interface Hud {
  readonly root: Object3D;
  /** Presentation only; never establishes device or mapping authority. */
  presentationSnapshot?(): { surface: 'menu' | 'device' | 'assistant' | 'project' | 'inspect'; stage: 'choose' | 'prepare' | 'building' | 'review' | 'ready' | 'perform' };
  update(f: HudFrame): void;
  setHome?(state: HomeState): void;
  setDeviceState?(state: DeviceState | null): void;
  /** The selected device's wiring: the ask section of its card and the code card beside it. */
  setWire?(view: WireView | null): void;
  /** The wiring is running and the hands are working (right hand in the play zone, or a finger near the screen): the wrist menu stays shut. */
  setHandsBusy?(busy: boolean): void;
  /** Actual setup events and artifact previews for the selected card. */
  setSetupProgress?(view: SetupProgressView | null): void;
  setCanvas?(view: CanvasView | null): void;
  setProjects?(view: ProjectView | null): void;
  /** Explicitly bring navigation and the selected workspace to the current view. */
  recenter?(): void;

  // SCAN
  setScanning(on: boolean, info?: { prompts?: number; pending?: number; startedAt?: number; modelId?: string }): void;
  upsertTarget(t: HudTarget): void;
  isTargetVisible?(id: string): boolean;
  getTargetAim?(id: string, out: { position: Vector3; size: number }): boolean;
  removeTarget(id: string): void;
  clearTargets(): void;
  setCandidate(id: string | null): void;
  setLocked(id: string | null): void;

  // PING
  setPing(lines: PingLine[]): void;

  // agent presence
  logStep(step: AgentStepLike): void;
  setModelChips(chips: ModelChip[]): void;

  // HACKS
  showHackMenu(targetId: string, menu: { title: string; subtitle?: string; items: HackItem[] }): void;
  hideHackMenu(): void;
  setUpload(u: UploadState | null): void;
  showEvidence(e: EvidenceState | null): void;
  showConfirm(c: ConfirmRequest | null): void;

  // generated 3D controls
  renderSpec(spec: Gen3dSpec, at: { targetId?: string; position?: [number, number, number]; yawDeg?: number }): void;
  patchSpec(specId: string, patch: Patch): { ok: boolean; errors?: string[] };
  removeSpec(specId: string): void;
  setArmed(specId: string, armed: boolean, reason?: string, controlIds?: string[]): void;
  setControlValue(specId: string, controlId: string, value: ControlEvent['value']): void;
  setCommandResult?(specId: string, controlId: string, ts: number, ok: boolean): void;

  // pairing, voice, deck, toasts
  showPairing(p: { display: string; qr: string; message?: string } | null): void;
  showHelperPairing?(view: HelperPairingView | null): void;
  setOnboarding?(view: OnboardingView | null): void;
  setAssistant?(view: AssistantView | null): void;
  showApprovals(list: { pairingId: string; name: string; kind: string; display: string }[]): void;
  setVoice(v: { listening: boolean; level?: number; partial?: string; final?: string }): void;
  setDeck(d: { open?: boolean; scanning?: boolean; daemons?: boolean; at?: [number, number, number] }): void;
  /** Discard captured input without firing release actions (for hidden/suspended XR). */
  cancelInteractions?(): void;
  /** Hands-first control: this hand is working UI (touching/near a panel or dial, or holding one) or the wrist menu is open. */
  handBusy?(hand: 'left' | 'right'): boolean;
  /** This hand's ray rests on UI: a pinch now is a UI press, not a gesture. */
  handRayOnUi?(hand: 'left' | 'right'): boolean;
  toast(text: string, level?: 'info' | 'ok' | 'warn' | 'error'): void;

  on<K extends keyof HudEvents>(k: K, fn: (e: HudEvents[K]) => void): () => void;
  dispose(): void;
}

export type { LogRow };
