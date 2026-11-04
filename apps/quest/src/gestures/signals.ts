/**
 * The signal layer: what a wiring program (written live by Muse, run in the sandbox) can read, every frame.
 * Nothing here maps a signal to a device; it only measures hands and, once a screen is calibrated, the fingertip on it.
 * `Signals` is the contract in research/36-muse-wiring-contract.md; keep the two in step.
 *
 * Hand signals use the play zone (gestures/engine.ts PLAY_ZONE): a head-relative box in front of the chest, with the
 * "forward" direction following the body slowly so looking at a screen never steers a value.
 */
import { Vector3 } from 'three';
import type { ShellFrame, ShellHand } from '../app/hud-contract';
import { OneEuroScalar } from '../app/precision';
import { PostureDetector } from './posture';
import { PLAY_ZONE } from './engine';
import { projectOnPlane, type PlanePoint, type ScreenPlane } from './screen-plane';

export interface HandSignals {
  height: number; push: number; side: number; pinch: number; pinchTap: boolean;
  fist: boolean; open: boolean; palmOut: boolean; speed: number;
}
export interface ScreenSignals {
  u: number; v: number; inside: boolean; distance: number; touching: boolean; hover: number; vu: number; vv: number; hand: 'left' | 'right';
}
export interface Signals {
  t: number; dt: number;
  right: HandSignals | null; left: HandSignals | null;
  screen: ScreenSignals | null;
}

/** Head-relative metres mapped to 0..1. Chest is about 0.5 m under the eyes, "above the head" 0.25 m over them. */
export const SIGNAL_RANGE = {
  height: { lo: -PLAY_ZONE.enter.below, hi: 0.25 },
  push: { lo: 0.12, hi: 0.6 },
  side: { lo: -0.4, hi: 0.4 },
  /** thumb-index aperture over the hand's wrist-knuckle length: pinch = 1 at or below `closed`, 0 at or above `open` */
  pinch: { closed: 0.25, open: 1.0 },
  /** Screen contact */
  touchEnter: 0.02, touchLeave: 0.03, hoverRange: 0.15, behind: 0.08,
  /** Both palms out for this long = stop */
  stopMs: 400,
  /** No stop while either hand is this close to a calibrated screen (a flat hand touching the water faces away too). */
  stopScreenClear: 0.25,
} as const;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const norm = (v: number, lo: number, hi: number): number => clamp01((v - lo) / (hi - lo));
const finite = (p: Vector3): boolean => Number.isFinite(p.x + p.y + p.z);

class HandTracker {
  readonly posture = new PostureDetector();
  private readonly height = new OneEuroScalar(2.2, 1.5);
  private readonly push = new OneEuroScalar(2.2, 1.5);
  private readonly side = new OneEuroScalar(2.2, 1.5);
  private readonly pinch = new OneEuroScalar(8, 0);
  private readonly prev = new Vector3();
  private prevTime = -Infinity;
  private speed = 0;
  private pinching = false;
  private tapStart = -Infinity;
  private tapValid = false;
  private lastTap = -Infinity;
  private readonly tapOrigin = new Vector3();
  private readonly rel = new Vector3();
  private readonly palm = new Vector3();
  private readonly toHand = new Vector3();
  palmDot = 0;

  reset(): void {
    this.posture.reset();
    for (const f of [this.height, this.push, this.side, this.pinch]) f.reset();
    this.prevTime = this.tapStart = -Infinity;
    this.speed = 0; this.pinching = false; this.tapValid = false;
  }

  /** null when the hand is not tracked (or is a controller: hand signals come from joints). */
  update(hand: ShellHand | undefined, head: Vector3, bodyForward: Vector3, bodyRight: Vector3, timeMs: number, tapBlocked: boolean): HandSignals | null {
    const posture = this.posture.update(hand, timeMs);
    const wrist = hand?.joints.wrist?.position ?? (hand?.controller ? hand.grip?.position ?? hand.ray.origin : undefined);
    if (!hand || !wrist || !finite(wrist)) { this.prevTime = -Infinity; this.tapStart = -Infinity; this.tapValid = false; this.pinching = false; return null; }
    const dt = (timeMs - this.prevTime) / 1000;
    if (Number.isFinite(this.prevTime) && dt > 0 && dt < 0.25) {
      const k = 1 - Math.exp(-dt / 0.05);
      this.speed += (wrist.distanceTo(this.prev) / dt - this.speed) * k;
    } else this.speed = 0;
    this.prev.copy(wrist); this.prevTime = timeMs;
    this.rel.subVectors(wrist, head);
    const ahead = this.rel.dot(bodyForward), lateral = this.rel.dot(bodyRight);
    const r = SIGNAL_RANGE;
    const height = this.height.update(norm(this.rel.y, r.height.lo, r.height.hi), timeMs);
    const push = this.push.update(norm(ahead, r.push.lo, r.push.hi), timeMs);
    const side = this.side.update(norm(lateral, r.side.lo, r.side.hi), timeMs);

    // Pinch closeness from the thumb and index tips, relative to the hand's own size.
    const j = hand.joints, thumb = j['thumb-tip']?.position, index = j['index-finger-tip']?.position;
    const knuckle = j['middle-finger-phalanx-proximal']?.position ?? j['middle-finger-metacarpal']?.position;
    let pinch = 0;
    if (thumb && index && knuckle && j.wrist) {
      const scale = Math.max(0.03, j.wrist.position.distanceTo(knuckle));
      pinch = this.pinch.update(norm(r.pinch.open - thumb.distanceTo(index) / scale, 0, r.pinch.open - r.pinch.closed), timeMs);
    } else if (hand.pinching) pinch = this.pinch.update(1, timeMs);
    else pinch = this.pinch.update(0, timeMs);

    // Pinch-tap: a short pinch that barely moves, started away from UI.
    const nowPinching = hand.pinching || this.posture.raw === 'pinch';
    let tap = false;
    if (nowPinching) {
      if (!this.pinching) {
        this.tapStart = timeMs; this.tapOrigin.copy(wrist);
        this.tapValid = !tapBlocked && timeMs - this.lastTap >= PLAY_ZONE.tapCooldownMs;
      } else if (tapBlocked || wrist.distanceTo(this.tapOrigin) > PLAY_ZONE.tapTravel || timeMs - this.tapStart > PLAY_ZONE.tapMs) this.tapValid = false;
    } else if (this.pinching) {
      if (this.tapValid && timeMs - this.tapStart <= PLAY_ZONE.tapMs) { tap = true; this.lastTap = timeMs; }
      this.tapValid = false;
    }
    this.pinching = nowPinching;

    // Palm facing away from the head (the stop pose is two of these).
    const q = hand.joints.wrist?.quaternion;
    let palmOut = false;
    if (q && !hand.controller && wrist.y > head.y - 0.55 && this.posture.extended) {
      this.palm.set(0, -1, 0).applyQuaternion(q);
      this.toHand.subVectors(wrist, head).normalize();
      this.palmDot = this.palm.dot(this.toHand);
      palmOut = this.palmDot > (this.palmOutHeld ? 0.45 : 0.65);
    } else this.palmDot = 0;
    this.palmOutHeld = palmOut;

    return {
      height, push, side, pinch, pinchTap: tap,
      fist: posture === 'fist', open: posture === 'open_palm', palmOut,
      speed: this.speed,
    };
  }
  private palmOutHeld = false;
}

/** Per-hand state for the screen signals. */
class FingerTracker {
  readonly u = new OneEuroScalar(3, 8);
  readonly v = new OneEuroScalar(3, 8);
  readonly distance = new OneEuroScalar(8, 0);
  touching = false;
  private lastU = 0;
  private lastV = 0;
  private lastTime = -Infinity;
  vu = 0; vv = 0;
  reset(): void { this.u.reset(); this.v.reset(); this.distance.reset(); this.touching = false; this.lastTime = -Infinity; this.vu = this.vv = 0; }
  advance(u: number, v: number, timeMs: number): void {
    const dt = (timeMs - this.lastTime) / 1000;
    if (Number.isFinite(this.lastTime) && dt > 0 && dt < 0.25) {
      const k = 1 - Math.exp(-dt / 0.04);
      this.vu += ((u - this.lastU) / dt - this.vu) * k;
      this.vv += ((v - this.lastV) / dt - this.vv) * k;
    } else this.vu = this.vv = 0;
    this.lastU = u; this.lastV = v; this.lastTime = timeMs;
  }
}

export interface SignalFrame {
  signals: Signals;
  /** One frame: both palms out for SIGNAL_RANGE.stopMs. The caller stops the wiring. */
  stop: boolean;
  /** Right palm is in the comfortable play zone in front of the chest (the wrist menu stays shut then). */
  rightInZone: boolean;
  /** The hand that is within reach of the screen plane right now (hover > 0 on the calibrated screen). */
  hovering: boolean;
}
export interface SignalContext {
  plane?: ScreenPlane | null;
  /** The hand is working UI right now: a pinch is a press, not a tap. */
  tapBlocked?: (hand: 'left' | 'right') => boolean;
}

export class SignalTracker {
  private readonly hands = { left: new HandTracker(), right: new HandTracker() };
  private readonly fingers = { left: new FingerTracker(), right: new FingerTracker() };
  private readonly bodyForward = new Vector3(0, 0, -1);
  private readonly bodyRight = new Vector3(1, 0, 0);
  private readonly look = new Vector3();
  private readonly point: PlanePoint = { u: 0, v: 0, distance: 0, inside: false };
  private readonly best: PlanePoint & { hand: 'left' | 'right' } = { u: 0, v: 0, distance: 0, inside: false, hand: 'right' };
  private startedAt = -Infinity;
  private lastTime = -Infinity;
  private bothOutSince = -Infinity;
  private stopLatched = false;
  private screenHand: 'left' | 'right' | null = null;

  /** Call when a wiring starts: `t` counts from here. */
  reset(timeMs: number): void {
    this.startedAt = timeMs; this.lastTime = -Infinity;
    this.hands.left.reset(); this.hands.right.reset();
    this.fingers.left.reset(); this.fingers.right.reset();
    this.bothOutSince = -Infinity; this.stopLatched = false; this.screenHand = null;
  }

  update(frame: ShellFrame, timeMs: number, ctx: SignalContext = {}): SignalFrame {
    if (!Number.isFinite(this.startedAt)) this.startedAt = timeMs;
    const dt = Number.isFinite(this.lastTime) ? Math.min(0.1, Math.max(0, (timeMs - this.lastTime) / 1000)) : 1 / 72;
    if (timeMs < this.lastTime || timeMs - this.lastTime > 250) { this.hands.left.reset(); this.hands.right.reset(); this.fingers.left.reset(); this.fingers.right.reset(); }
    this.lastTime = timeMs;
    const head = frame.head.position;
    // The body faces where the head has been looking for a moment (slow follow): a glance at the screen does not turn it.
    this.look.set(0, 0, -1).applyQuaternion(frame.head.quaternion); this.look.y = 0;
    if (this.look.lengthSq() > 0.01) {
      this.look.normalize();
      this.bodyForward.lerp(this.look, 1 - Math.exp(-dt / 0.8)).setY(0);
      if (this.bodyForward.lengthSq() < 1e-4) this.bodyForward.copy(this.look);
      this.bodyForward.normalize();
    }
    this.bodyRight.set(-this.bodyForward.z, 0, this.bodyForward.x);

    const left = this.hands.left.update(frame.hands.left, head, this.bodyForward, this.bodyRight, timeMs, ctx.tapBlocked?.('left') ?? false);
    const right = this.hands.right.update(frame.hands.right, head, this.bodyForward, this.bodyRight, timeMs, ctx.tapBlocked?.('right') ?? false);

    // Both palms out stops the wiring, but never while a hand is at the screen: touching it with a flat hand or two
    // fingers also turns the palms away from the eyes.
    const nearScreen = !!ctx.plane && (['left', 'right'] as const).some(side => {
      const hand = frame.hands[side], p = hand?.joints['index-finger-tip']?.position ?? hand?.joints.wrist?.position;
      if (!p) return false;
      const o = ctx.plane!.origin, n = ctx.plane!.normal;
      return Math.abs((p.x - o[0]) * n[0] + (p.y - o[1]) * n[1] + (p.z - o[2]) * n[2]) < SIGNAL_RANGE.stopScreenClear;
    });
    const out = !!left?.palmOut && !!right?.palmOut && !nearScreen;
    let stop = false;
    if (!out) { this.bothOutSince = -Infinity; this.stopLatched = false; }
    else {
      if (!Number.isFinite(this.bothOutSince)) this.bothOutSince = timeMs;
      if (!this.stopLatched && timeMs - this.bothOutSince >= SIGNAL_RANGE.stopMs) { this.stopLatched = true; stop = true; }
    }

    const screen = ctx.plane ? this.screen(frame, ctx.plane, timeMs) : null;
    const rightWrist = frame.hands.right?.joints.wrist?.position;
    let rightInZone = false;
    if (right && rightWrist) {
      const up = rightWrist.y - head.y, ahead = (rightWrist.x - head.x) * this.bodyForward.x + (rightWrist.z - head.z) * this.bodyForward.z;
      const z = PLAY_ZONE.enter;
      rightInZone = up > -z.below && up < z.above && ahead > z.forward && rightWrist.distanceTo(head) < z.reach;
    }
    return {
      signals: { t: Math.max(0, (timeMs - this.startedAt) / 1000), dt, right, left, screen },
      stop, rightInZone, hovering: !!screen && screen.hover > 0,
    };
  }

  /** The index fingertip nearest the plane. */
  private screen(frame: ShellFrame, plane: ScreenPlane, timeMs: number): ScreenSignals | null {
    let pick: 'left' | 'right' | null = null;
    let bestAbs = Infinity;
    for (const side of ['right', 'left'] as const) {
      const hand = frame.hands[side];
      const tip = hand && !hand.controller ? hand.joints['index-finger-tip']?.position : undefined;
      if (!tip || !finite(tip)) { this.fingers[side].reset(); continue; }
      projectOnPlane(plane, tip, this.point);
      if (this.point.distance < -SIGNAL_RANGE.behind) { this.fingers[side].reset(); continue; }
      const abs = Math.abs(this.point.distance) + (this.point.inside ? 0 : 0.5);
      // Keep the hand that was already working the screen unless the other one is clearly nearer.
      const bias = side === this.screenHand ? 0.02 : 0;
      if (abs - bias < bestAbs) { bestAbs = abs - bias; pick = side; this.best.u = this.point.u; this.best.v = this.point.v; this.best.distance = this.point.distance; this.best.inside = this.point.inside; }
    }
    if (!pick) { this.screenHand = null; return null; }
    if (pick !== this.screenHand) { this.fingers[pick].reset(); this.screenHand = pick; }
    const finger = this.fingers[pick];
    const u = clamp01(finger.u.update(this.best.u, timeMs)), v = clamp01(finger.v.update(this.best.v, timeMs));
    finger.advance(u, v, timeMs);
    const raw = Math.max(0, this.best.distance);
    const distance = Math.max(0, finger.distance.update(raw, timeMs));
    const inside = this.best.inside;
    finger.touching = inside && distance < (finger.touching ? SIGNAL_RANGE.touchLeave : SIGNAL_RANGE.touchEnter);
    const hover = inside ? clamp01((SIGNAL_RANGE.hoverRange - distance) / (SIGNAL_RANGE.hoverRange - SIGNAL_RANGE.touchEnter)) : 0;
    return { u, v, inside, distance, touching: finger.touching, hover: finger.touching ? 1 : hover, vu: finger.vu, vv: finger.vv, hand: pick };
  }
}
