import { Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import type { HandState, HudFrame } from '../contract';
import { unfoldEase } from './motion';

const UP = new Vector3(0, 1, 0);
const WRIST_FACE = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
const KNUCKLES = ['index-finger', 'middle-finger', 'ring-finger', 'pinky-finger'] as const;
const DWELL_MS = 300, HIDE_DELAY_MS = 300, FADE_MS = 180;

function realHand(hand: HandState | undefined): hand is HandState {
  return !!hand && !hand.controller && !!hand.joints.wrist;
}

/** Hand attachment and visibility only; the caller places the controller/mouse fallback. */
export class HandDockAnchor {
  tracked = false;
  open = false;
  opacity = 0;
  wristOpacity = 0;
  justOpened = false;
  private attached = false;
  private awaySince: number | null = null;
  private previousTime: number | null = null;
  private fadeStarted = 0;
  private fadeFrom = 0;
  private readonly destination = new Vector3();
  private readonly direction = new Vector3();
  private readonly wristPosition = new Vector3();
  private readonly localTip = new Vector3();
  private readonly nearest = new Vector3();
  private readonly rotation = new Quaternion();
  private readonly wristRotation = new Quaternion();
  private readonly matrix = new Matrix4();

  constructor(readonly nonDominant: 'left' | 'right' = 'left') {}

  update(frame: HudFrame, dock: Object3D, wrist: Object3D, width: number): void {
    this.justOpened = false;
    if (this.previousTime !== null && frame.time < this.previousTime) this.closeImmediately();
    this.previousTime = frame.time;
    this.tracked = frame.pointer !== 'mouse' && (realHand(frame.hands.left) || realHand(frame.hands.right));
    const hand = frame.hands[this.nonDominant];

    if (!this.tracked) {
      this.justOpened = !this.open || this.attached;
      this.open = true;
      this.opacity = 1;
      this.wristOpacity = 0;
      this.attached = false;
      this.awaySince = null;
      wrist.visible = false;
      return;
    }
    // A tracked dominant hand must never substitute for the menu hand or reveal a stale anchor.
    if (!realHand(hand)) {
      this.closeImmediately();
      wrist.visible = false;
      return;
    }

    const firstPose = !this.attached;
    if (firstPose) this.closeImmediately();
    this.attached = true;
    this.place(frame, hand, dock, wrist, firstPose);

    const other = frame.hands[this.nonDominant === 'left' ? 'right' : 'left'];
    const held = this.open && this.fingerNear(other, dock, width);
    const palmReady = hand.palmUp && (hand.palmUpMs ?? 0) >= DWELL_MS;
    let nextOpen = this.open;
    if (palmReady || (this.open && (hand.palmUp || held))) {
      nextOpen = true;
      this.awaySince = null;
    } else if (this.open) {
      this.awaySince ??= frame.time;
      if (frame.time - this.awaySince >= HIDE_DELAY_MS) nextOpen = false;
    }
    if (nextOpen !== this.open) {
      this.open = nextOpen;
      this.justOpened = nextOpen;
      this.fadeFrom = this.opacity;
      this.fadeStarted = frame.time;
    }
    this.opacity = this.fadeFrom + ((this.open ? 1 : 0) - this.fadeFrom)
      * unfoldEase((frame.time - this.fadeStarted) / FADE_MS);
    this.wristOpacity = 0.6 * (1 - this.opacity);
    wrist.visible = this.wristOpacity > 0.001;
  }

  private closeImmediately(): void {
    this.open = false;
    this.opacity = this.fadeFrom = this.wristOpacity = 0;
    this.attached = false;
    this.awaySince = null;
  }

  private place(frame: HudFrame, hand: HandState, dock: Object3D, wrist: Object3D, first: boolean): void {
    const joint = hand.joints.wrist!;
    this.destination.set(0, 0, 0);
    let count = 0;
    for (const name of KNUCKLES) {
      const knuckle = hand.joints[`${name}-phalanx-proximal`];
      if (knuckle) { this.destination.add(knuckle.position); count++; }
    }
    if (count) this.destination.multiplyScalar(1 / count);
    else this.destination.set(0, 0, -0.075).applyQuaternion(joint.quaternion).add(joint.position);
    this.direction.subVectors(frame.head.position, this.destination).normalize();
    this.destination.addScaledVector(this.direction, 0.06);
    // A fixed up axis keeps the row level as the wrist rolls.
    this.matrix.lookAt(frame.head.position, this.destination, UP);
    this.rotation.setFromRotationMatrix(this.matrix);
    const alpha = first ? 1 : 1 - Math.exp(-Math.max(0, frame.dt) / 0.08);
    dock.position.lerp(this.destination, alpha);
    dock.quaternion.slerp(this.rotation, alpha);

    // WebXR +Y points out of the back of the hand; the glyph's +Y follows the fingers.
    this.wristPosition.set(0, 0.012, 0).applyQuaternion(joint.quaternion).add(joint.position);
    this.wristRotation.copy(joint.quaternion).multiply(WRIST_FACE);
    wrist.position.lerp(this.wristPosition, alpha);
    wrist.quaternion.slerp(this.wristRotation, alpha);
  }

  private fingerNear(hand: HandState | undefined, dock: Object3D, width: number): boolean {
    const tip = hand && !hand.controller ? hand.joints['index-finger-tip'] : undefined;
    if (!tip) return false;
    dock.updateWorldMatrix(true, false);
    this.localTip.copy(tip.position);
    dock.worldToLocal(this.localTip);
    // Distance to the finite row, including its ends, rather than an infinite interaction plane.
    this.nearest.set(
      Math.max(-width / 2, Math.min(width / 2, this.localTip.x)),
      Math.max(-0.016, Math.min(0.016, this.localTip.y)),
      0,
    );
    dock.localToWorld(this.nearest);
    return this.nearest.distanceToSquared(tip.position) <= 0.1 ** 2;
  }
}
