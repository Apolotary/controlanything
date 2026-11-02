/**
 * The HUD API the app shell (quest-io) calls. Types only: no three.js imports beyond math classes.
 * Mirrors apps/quest/src/app/hud-contract.ts; this file is the one the shell imports once it exists.
 */
import type { Object3D, Quaternion, Vector3 } from 'three';
import type { Channel, ControlEvent, Gen3dSpec, HackItem, HudStatus, LogRow, ModelChip, Patch } from '@ce/gen3d';

export type AppMode = 'annotate' | 'control';
export type ObjectFilter = 'electronics' | 'lights' | 'everything';
export type DeviceConnection = 'ready' | 'setup' | 'offline' | 'unknown';
export interface HomeState { mode: AppMode; filter: ObjectFilter; tagged: number; status: string }
export interface DeviceState { targetId: string; connection: DeviceConnection; hint?: string; busy?: boolean; sentence?: string; handControl?: boolean }

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
  /** non-dominant palm facing the user (spawns the deck) */
  palmUp?: boolean;
  palmUpMs?: number;
  /** true when this "hand" is really a controller */
  controller?: boolean;
}

export interface HudFrame {
  time: number;
  dt: number;
  frame?: XRFrame;
  refSpace?: XRReferenceSpace;
  head: { position: Vector3; quaternion: Quaternion; ray?: { origin: Vector3; dir: Vector3 } };
  hands: { left?: HandState; right?: HandState };
}

/** A detection the shell has placed in the world (capture pose + hit-test, pinch-to-refine). */
export interface HudTarget {
  id: string;
  label: string;
  tagged?: boolean;
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
  title: string;
  summary?: string;
  hold?: boolean;
  expiresAt?: number;
  targetId?: string;
}

export type DeckKey = 'scan' | 'ping' | 'hacks' | 'daemons' | 'undo' | 'mic' | 'panic';

export interface HudEvents {
  mode: { mode: AppMode };
  filter: { filter: ObjectFilter };
  tagRemove: { targetId: string };
  setup: { targetId: string };
  cancel: { targetId: string };
  pair: { targetId: string };
  handControl: { targetId: string; enabled: boolean };
  deck: { key: DeckKey; phase: 'press' | 'release' };
  hack: { targetId: string; itemId: string; controlId?: string; index: number; hold?: boolean };
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

  // pairing, voice, deck, toasts
  showPairing(p: { display: string; qr: string; message?: string } | null): void;
  showApprovals(list: { pairingId: string; name: string; kind: string; display: string }[]): void;
  setVoice(v: { listening: boolean; level?: number; partial?: string; final?: string }): void;
  setDeck(d: { open?: boolean; scanning?: boolean; daemons?: boolean; at?: [number, number, number] }): void;
  toast(text: string, level?: 'info' | 'ok' | 'warn' | 'error'): void;

  on<K extends keyof HudEvents>(k: K, fn: (e: HudEvents[K]) => void): () => void;
  dispose(): void;
}

export type { LogRow };
