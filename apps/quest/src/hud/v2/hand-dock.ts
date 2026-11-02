import { Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import type { HandState, HudFrame } from '../contract';
import { unfoldEase } from './motion';

const UP = new Vector3(0, 1, 0);
const WRIST_FACE = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
const KNUCKLES = ['index-finger-phalanx-proximal', 'middle-finger-phalanx-proximal', 'ring-finger-phalanx-proximal', 'pinky-finger-phalanx-proximal'] as const;
const DWELL_MS = 300, HIDE_DELAY_MS = 300, FADE_MS = 180;
const RAISED_ENTER_COS = Math.cos(35 * Math.PI / 180);
const RAISED_EXIT_COS = Math.cos(45 * Math.PI / 180);

/** A hold commits once, and release or a clock reset always cancels unfinished progress. */
export class DockHold {
  progress = 0;
  private started: number | null = null;
  private fired = false;

  constructor(readonly durationMs = 600) {}

  begin(time: number): void {
    if (this.started !== null) return;
    this.started = time;
    this.progress = 0;
    this.fired = false;
  }

  cancel(): void {
    this.started = null;
    this.progress = 0;
    this.fired = false;
  }

  update(time: number): boolean {
    if (this.started === null) return false;
    if (time < this.started) { this.cancel(); return false; }
    this.progress = Math.min(1, (time - this.started) / this.durationMs);
    if (this.progress < 1 || this.fired) return false;
    this.fired = true;
    return true;
  }
}

function realHand(hand: HandState | undefined): hand is HandState {
  return !!hand && !hand.controller && !!hand.joints.wrist;
}

/** Hand/controller attachment and visibility; only a desktop mouse uses the caller's fallback. */
export class HandDockAnchor {
  tracked = false;
  source: 'hand' | 'controller' | 'mouse' | null = null;
  open = false;
  opacity = 0;
  wristOpacity = 0;
  justOpened = false;
  private attached = false;
  private awaySince: number | null = null;
  private previousTime: number | null = null;
  private fadeStarted = 0;
  private fadeFrom = 0;
  private raisedSince: number | null = null;
  private controllerPinned = false;
  private controllerRaised = false;
  private readonly destination = new Vector3();
  private readonly direction = new Vector3();
  private readonly wristPosition = new Vector3();
  private readonly localTip = new Vector3();
  private readonly nearest = new Vector3();
  private readonly rotation = new Quaternion();
  private readonly wristRotation = new Quaternion();
  private readonly matrix = new Matrix4();
  private readonly headForward = new Vector3();

  constructor(readonly nonDominant: 'left' | 'right' = 'left') {}

  update(frame: HudFrame, dock: Object3D, wrist: Object3D, width: number): void {
    this.justOpened = false;
    if (this.previousTime !== null && frame.time < this.previousTime) this.closeImmediately();
    this.previousTime = frame.time;
    const previousSource = this.source;
    const hasHands = realHand(frame.hands.left) || realHand(frame.hands.right);
    const hand = frame.hands[this.nonDominant];
    const controller = frame.hands.left;
    this.source = frame.pointer === 'mouse' ? 'mouse' : hasHands ? 'hand' : controller?.controller && controller.grip ? 'controller' : null;
    // Treat unavailable tracking as attached so a hidden dock never jumps to a desk fallback.
    this.tracked = this.source !== 'mouse';
    if (previousSource !== this.source) this.closeImmediately();

    if (this.source === 'mouse') {
      this.justOpened = !this.open || this.attached;
      this.open = true;
      this.opacity = 1;
      this.wristOpacity = 0;
      this.attached = false;
      this.awaySince = null;
      wrist.visible = false;
      return;
    }
    if (this.source === 'controller') {
      this.updateController(frame, controller!, dock);
      wrist.visible = false;
      return;
    }
    // A tracked dominant hand must never substitute for the menu hand or reveal a stale anchor.
    if (this.source !== 'hand' || !realHand(hand)) {
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
    this.fade(nextOpen, frame.time);
    this.wristOpacity = 0.6 * (1 - this.opacity);
    wrist.visible = this.wristOpacity > 0.001;
  }

  private fade(nextOpen: boolean, time: number): void {
    if (nextOpen !== this.open) {
      this.open = nextOpen;
      this.justOpened = nextOpen;
      this.fadeFrom = this.opacity;
      this.fadeStarted = time;
    }
    this.opacity = this.fadeFrom + ((this.open ? 1 : 0) - this.fadeFrom)
      * unfoldEase((time - this.fadeStarted) / FADE_MS);
  }

  private updateController(frame: HudFrame, hand: HandState, dock: Object3D): void {
    const grip = hand.grip!;
    const first = !this.attached;
    this.attached = true;
    this.destination.copy(grip.position);
    this.destination.y += 0.11;
    this.direction.subVectors(frame.head.position, this.destination).normalize();
    this.destination.addScaledVector(this.direction, 0.04);
    this.matrix.lookAt(frame.head.position, this.destination, UP);
    this.rotation.setFromRotationMatrix(this.matrix);
    const alpha = first ? 1 : 1 - Math.exp(-Math.max(0, frame.dt) / 0.08);
    dock.position.lerp(this.destination, alpha);
    dock.quaternion.slerp(this.rotation, alpha);

    this.direction.subVectors(grip.position, frame.head.position);
    const distance = this.direction.length();
    this.headForward.set(0, 0, -1).applyQuaternion(frame.head.quaternion);
    const facing = distance > 0 ? this.direction.dot(this.headForward) / distance : -1;
    // A raised controller needs a deliberate near-face dwell, with a wider exit cone.
    const raised = distance < (this.controllerRaised ? 0.9 : 0.8)
      && grip.position.y > frame.head.position.y - (this.controllerRaised ? 0.48 : 0.38)
      && facing > (this.controllerRaised ? RAISED_EXIT_COS : RAISED_ENTER_COS);
    this.controllerRaised = raised;
    if (raised) this.raisedSince ??= frame.time;
    else this.raisedSince = null;
    if (hand.menuPressed) this.controllerPinned = !this.controllerPinned;
    const ready = this.controllerPinned || this.raisedSince !== null && frame.time - this.raisedSince >= DWELL_MS;
    let nextOpen = this.open;
    if (ready) { nextOpen = true; this.awaySince = null; }
    else if (this.open) {
      this.awaySince ??= frame.time;
      if (frame.time - this.awaySince >= HIDE_DELAY_MS) nextOpen = false;
    }
    this.fade(nextOpen, frame.time);
    this.wristOpacity = 0;
  }

  private closeImmediately(): void {
    this.open = false;
    this.opacity = this.fadeFrom = this.wristOpacity = 0;
    this.attached = false;
    this.awaySince = null;
    this.raisedSince = null;
    this.controllerPinned = this.controllerRaised = false;
  }

  private place(frame: HudFrame, hand: HandState, dock: Object3D, wrist: Object3D, first: boolean): void {
    const joint = hand.joints.wrist!;
    this.destination.set(0, 0, 0);
    let count = 0;
    for (const name of KNUCKLES) {
      const knuckle = hand.joints[name];
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
