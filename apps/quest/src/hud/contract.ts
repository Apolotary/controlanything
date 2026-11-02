/**
 * The HUD API the app shell (quest-io) calls. Types only: no three.js imports beyond math classes.
 * Mirrors apps/quest/src/app/hud-contract.ts; this file is the one the shell imports once it exists.
 */
import type { Object3D, Quaternion, Vector3 } from 'three';
import type { Channel, ControlEvent, Gen3dSpec, HackItem, HudStatus, LogRow, ModelChip, Patch } from '@ce/gen3d';
import type { TaggedDevice } from '@ce/protocol';

export type AppMode = 'annotate' | 'control';
export type ObjectFilter = 'electronics' | 'lights' | 'everything';
export type DeviceConnection = 'ready' | 'setup' | 'offline' | 'unknown';
export interface HomeState { mode: AppMode; filter: ObjectFilter; tagged: number; status: string; canStop?: boolean }
export interface DeviceState { targetId: string; connection: DeviceConnection; hint?: string; action?: TaggedDevice['action']; busy?: boolean; sentence?: string; handControl?: boolean; performAvailable?: boolean; performingLive?: boolean; performanceRoute?: string; pairingSeconds?: number }
export interface HelperPairingView { urls: string[]; pairedName?: string }

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
  tagged?: boolean;
  identifying?: boolean;
  busy?: boolean;
  connection?: DeviceConnection;
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
  kind?: 'arm';
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
  setup: { targetId: string };
  cancel: { targetId: string };
  pair: { targetId: string };
  pairCancel: { targetId: string };
  pairCode: { targetId: string; code: string };
  helperSkip: Record<string, never>;
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
  update(f: HudFrame): void;
  setHome?(state: HomeState): void;
  setDeviceState?(state: DeviceState | null): void;

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
  showApprovals(list: { pairingId: string; name: string; kind: string; display: string }[]): void;
  setVoice(v: { listening: boolean; level?: number; partial?: string; final?: string }): void;
  setDeck(d: { open?: boolean; scanning?: boolean; daemons?: boolean; at?: [number, number, number] }): void;
  toast(text: string, level?: 'info' | 'ok' | 'warn' | 'error'): void;

  on<K extends keyof HudEvents>(k: K, fn: (e: HudEvents[K]) => void): () => void;
  dispose(): void;
}

export type { LogRow };
