import { Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import type { HandState, HudFrame } from '../contract';
import { unfoldEase } from './motion';

const UP = new Vector3(0, 1, 0);
const KNUCKLES = ['index-finger-phalanx-proximal', 'middle-finger-phalanx-proximal', 'ring-finger-phalanx-proximal', 'pinky-finger-phalanx-proximal'] as const;
const DWELL_MS = 300, HIDE_DELAY_MS = 300, FADE_MS = 180;
const RAISED_ENTER_COS = Math.cos(35 * Math.PI / 180);
const RAISED_EXIT_COS = Math.cos(45 * Math.PI / 180);
const FINGER_JOINTS = {
  middle: 'middle-finger-tip',
  ring: 'ring-finger-tip',
  pinky: 'pinky-finger-tip',
} as const;
export type FingerMenuFinger = keyof typeof FINGER_JOINTS;
const MENU_FINGERS = Object.keys(FINGER_JOINTS) as FingerMenuFinger[];
const TOUCH_ENTER = 0.015, TOUCH_RELEASE = 0.022, TOUCH_NEAR = 0.04;
const TOUCH_DEBOUNCE_MS = 30, MAX_HAND_SPEED = 0.6;

export interface FingerTouchState {
  finger: FingerMenuFinger | null;
  justTouched: boolean;
  touching: boolean;
  near: Record<FingerMenuFinger, boolean>;
  ready: boolean;
}

/** Thumb-to-finger touches, with a fresh release required after any unsafe pose. */
export class FingerTouchDetector {
  private readonly state: FingerTouchState = {
    finger: null, justTouched: false, touching: false,
    near: { middle: false, ring: false, pinky: false }, ready: false,
  };
  private readonly distances = { middle: Infinity, ring: Infinity, pinky: Infinity };
  private readonly armed = { middle: false, ring: false, pinky: false };
  private readonly previousWrist = new Vector3();
  private previousTime: number | null = null;
  private candidate: FingerMenuFinger | null = null;
  private candidateSince = 0;

  update(hand: HandState | undefined, open: boolean, time: number): FingerTouchState {
    const state = this.state;
    state.justTouched = false;
    state.ready = false;
    const wrist = hand?.joints.wrist;
    const validWrist = !!wrist && Number.isFinite(wrist.position.lengthSq());
    const thumb = hand?.joints['thumb-tip'];
    const elapsed = this.previousTime === null ? null : time - this.previousTime;
    const moved = validWrist ? wrist.position.distanceTo(this.previousWrist) : 0;
    const fast = elapsed !== null && (elapsed < 0 || (elapsed === 0 ? moved > 0 : moved / (elapsed / 1000) > MAX_HAND_SPEED));
    if (validWrist && Number.isFinite(time)) { this.previousWrist.copy(wrist.position); this.previousTime = time; }
    else this.previousTime = null;

    let hasFinger = false;
    for (const finger of MENU_FINGERS) {
      const tip = hand?.joints[FINGER_JOINTS[finger]];
      const distance = thumb && tip ? thumb.position.distanceTo(tip.position) : Infinity;
      this.distances[finger] = distance;
      if (Number.isFinite(distance)) hasFinger = true;
      else this.armed[finger] = false;
      state.near[finger] = open && !hand?.controller && !!hand?.palmUp && distance < TOUCH_NEAR;
    }
    const valid = open && !hand?.controller && !!hand?.palmUp
      && (hand.palmUpMs ?? 0) >= DWELL_MS && validWrist && hasFinger && !fast && Number.isFinite(time);
    if (!valid) {
      this.cancel();
      return state;
    }
    for (const finger of MENU_FINGERS) {
      if (Number.isFinite(this.distances[finger]) && this.distances[finger] > TOUCH_RELEASE) this.armed[finger] = true;
    }
    state.ready = state.finger !== null || MENU_FINGERS.some((finger) => this.armed[finger]);
    if (state.finger !== null) {
      if (this.distances[state.finger] <= TOUCH_RELEASE) return state;
      state.finger = null;
      state.touching = false;
      this.candidate = null;
      return state;
    }

    let nearest: FingerMenuFinger | null = null;
    let closest = TOUCH_ENTER;
    for (const finger of MENU_FINGERS) {
      if (this.armed[finger] && this.distances[finger] < closest) {
        closest = this.distances[finger];
        nearest = finger;
      }
    }
    if (nearest !== this.candidate) {
      this.candidate = nearest;
      this.candidateSince = time;
    }
    if (nearest !== null && time - this.candidateSince >= TOUCH_DEBOUNCE_MS) {
      state.finger = nearest;
      state.touching = state.justTouched = true;
      this.armed[nearest] = false;
      this.candidate = null;
    }
    return state;
  }

  private cancel(): void {
    this.state.finger = null;
    this.state.touching = false;
    this.candidate = null;
    for (const finger of MENU_FINGERS) this.armed[finger] = false;
  }
}

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
  private readonly rotation = new Quaternion();
  private readonly matrix = new Matrix4();
  private readonly headForward = new Vector3();
  private readonly side = new Vector3();
  private readonly offset: { lateral: number; up: number; toward: number };

  /** `offset` (metres, head frame) moves the dock beside the hand so the other index can poke it. */
  constructor(readonly nonDominant: 'left' | 'right' = 'left', offset: Partial<{ lateral: number; up: number; toward: number }> = {}) {
    this.offset = { lateral: 0, up: 0, toward: 0.06, ...offset };
  }

  update(frame: HudFrame, dock: Object3D, wrist: Object3D, _width: number): void {
    this.justOpened = false;
    if (this.previousTime !== null && frame.time < this.previousTime) this.closeImmediately();
    this.previousTime = frame.time;
    const previousSource = this.source;
    const hasHands = realHand(frame.hands.left) || realHand(frame.hands.right);
    const hand = frame.hands[this.nonDominant];
    const controller = frame.hands.left;
    // In the emulator the mouse is the right hand; an articulated menu hand still owns the dock.
    const menuHand = realHand(hand);
    this.source = frame.pointer === 'mouse' && !(menuHand && (hand.palmUp || this.source === 'hand' && this.open)) ? 'mouse'
      : hasHands ? 'hand' : controller?.controller && controller.grip ? 'controller' : null;
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
    const held = this.open && this.fingerNear(other, hand);
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
    this.wristOpacity = 0.6;
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
    this.destination.addScaledVector(this.direction, this.offset.toward);
    // Beside the hand (toward the body centre) and slightly up, in the head's frame.
    this.side.set(1, 0, 0).applyQuaternion(frame.head.quaternion).setY(0).normalize();
    this.destination.addScaledVector(this.side, this.offset.lateral);
    this.destination.y += this.offset.up;
    // A fixed up axis keeps the menu content level as the wrist rolls.
    this.matrix.lookAt(frame.head.position, this.destination, UP);
    this.rotation.setFromRotationMatrix(this.matrix);
    const alpha = first ? 1 : 1 - Math.exp(-Math.max(0, frame.dt) / 0.08);
    dock.position.lerp(this.destination, alpha);
    dock.quaternion.slerp(this.rotation, alpha);

    // Keep the mode label near the wrist and facing the reader.
    this.wristPosition.set(0, 0.012, 0).applyQuaternion(joint.quaternion).add(joint.position);
    wrist.position.lerp(this.wristPosition, alpha);
    wrist.quaternion.slerp(this.rotation, alpha);
  }

  private fingerNear(hand: HandState | undefined, menuHand: HandState): boolean {
    const tip = hand && !hand.controller ? hand.joints['index-finger-tip'] : undefined;
    if (!tip) return false;
    // The fallback follows the finger targets rather than a fixed row over the palm.
    return MENU_FINGERS.some((finger) => {
      const target = menuHand.joints[FINGER_JOINTS[finger]];
      return !!target && target.position.distanceToSquared(tip.position) <= 0.1 ** 2;
    });
  }
}
