/**
 * The HUD API the shell calls is defined by gen3d-lead in src/hud/contract.ts (agreed Nov 2). This module
 * re-exports it and adds the shell's stricter frame types: the shell always fills head.ray and the hand
 * extras, so its own code can rely on them while the HUD sees the looser published shapes.
 */
import type { Camera, Quaternion, Scene, Vector3, WebGLRenderer } from 'three';
import type { HandState, Hud, HudFrame, JointState } from '../hud/contract';

export type {
  AgentStepLike,
  ConfirmRequest as ConfirmView,
  DeckKey,
  EvidenceState as EvidenceView,
  HandState,
  Hud,
  HudEvents,
  HudFrame,
  HudTarget,
  JointState as JointSample,
  PingLine,
  UploadState,
} from '../hud/contract';

export type V3 = [number, number, number];
export type Handedness = 'left' | 'right';

export interface Ray {
  origin: Vector3;
  dir: Vector3;
}

/** What the shell's input sampler produces for one hand (a HandState with every optional field filled). */
export interface ShellHand extends HandState {
  joints: Partial<Record<XRHandJoint, JointState>>;
  ray: Ray;
  palmUp: boolean;
  palmUpMs: number;
  controller: boolean;
}

/** What the shell's input sampler produces per frame (a HudFrame with head.ray always set). */
export interface ShellFrame extends HudFrame {
  head: { position: Vector3; quaternion: Quaternion; ray: Ray };
  hands: { left?: ShellHand; right?: ShellHand };
}

export interface ApprovalView {
  pairingId: string;
  name: string;
  kind: string;
  display: string;
}

export interface HudContext {
  scene: Scene;
  camera: Camera;
  renderer: WebGLRenderer;
}

export type CreateHud = (ctx: HudContext) => Hud;
