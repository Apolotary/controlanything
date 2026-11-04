import { Quaternion, Vector3 } from 'three';
import type { GestureAxis, GestureMap, GesturePosture } from '@ce/protocol';
import type { ShellFrame, ShellHand } from '../app/hud-contract';
import { OneEuroScalar } from '../app/precision';
import { applyCurve, applyDeadzone, clamp01, inverseCurve, mapAxisValue } from './mapping';
import type { AxisBinding } from './mapping';
import { PostureDetector } from './posture';
import type { HandPosture } from './posture';

export interface GestureAxisState {
  axis: GestureAxis;
  actionId: string;
  label: string;
  value: number;
  normalized: number;
}
export interface GestureState {
  engaged: boolean;
  trackingLost: boolean;
  /** One-frame pulse. The caller routes it through the application's existing panic path. */
  stopped: boolean;
  /** One-frame pulse (zone mode): a quick right-hand pinch-tap, away from UI. The caller picks the next pattern. */
  tapped: boolean;
  /** Zone mode: why the right hand is not playing right now (for a short hint), or '' while engaged. */
  hold: '' | 'low' | 'fist' | 'pinch' | 'turned' | 'ui' | 'menu' | 'moving' | 'stop';
  mode: GestureEngage;
  axes: GestureAxisState[];
  leftPosture: HandPosture;
  rightPosture: HandPosture;
}
/**
 * 'clutch': the original explicit left-fist clutch.
 * 'zone' (hands-first default): the right hand plays whenever it is raised in front of you and held still for a
 * moment; dropping it, turning the palm toward you, a fist or a pinch holds the last value. No clutch to learn.
 */
export type GestureEngage = 'clutch' | 'zone';
export interface GestureEngineOptions { engage?: GestureEngage }

/** Play zone, head-relative metres (horizontal head forward). Enter/stay bounds give hysteresis. */
export const PLAY_ZONE = {
  enter: { below: 0.5, above: 0.18, forward: 0.18, reach: 0.85 },
  stay: { below: 0.58, above: 0.28, forward: 0.1, reach: 0.95 },
  /** The hand must be this slow (m/s) for settleMs before it picks up: raising it into the zone changes nothing. */
  settleSpeed: 0.35, settleMs: 110,
  /** Leaving through the bottom while falling this fast (m/s) restores the value from before the drop. */
  fallSpeed: 0.45, fallWindowMs: 700,
  /** Pinch-tap: shorter than this, and the wrist moves less than tapTravel metres. */
  tapMs: 350, tapTravel: 0.05, tapCooldownMs: 300,
} as const;
export type GestureEmit = (actionId: string, value: number | boolean, phase: 'move' | 'press', gesture: GestureAxis | GesturePosture) => void;
interface Pose { position: Vector3; quaternion: Quaternion }
interface AxisRuntime {
  binding: AxisBinding;
  view: GestureAxisState;
  filter: OneEuroScalar;
  origin: number;
  pickup: number;
  lastValue: number;
  lastSent: number;
}
const postureId: Record<HandPosture, GesturePosture | undefined> = {
  unknown: undefined, fist: 'R_FIST', open_palm: 'R_OPEN_PALM', point: 'R_POINT', pinch: 'R_PINCH',
};
const forward = new Vector3(0, 0, -1);
const finitePosition = (p: Vector3): boolean => Number.isFinite(p.x + p.y + p.z);
const finiteQuaternion = (q: Quaternion): boolean => Number.isFinite(q.x + q.y + q.z + q.w) && q.lengthSq() > 0.5;

/** Explicit clutch, relative pickup, and bounded event rates. All frame-loop storage is reused. */
export class GestureEngine {
  readonly state: GestureState;
  private readonly left = new PostureDetector();
  private readonly right = new PostureDetector();
  private readonly axes: AxisRuntime[];
  private readonly postureTimes: Float64Array;
  private readonly leftPose: Pose = { position: new Vector3(), quaternion: new Quaternion() };
  private readonly rightPose: Pose = { position: new Vector3(), quaternion: new Quaternion() };
  private readonly direction = new Vector3();
  private readonly palm = new Vector3();
  private readonly headToHand = new Vector3();
  private readonly rollReference = new Quaternion();
  private readonly depthForward = new Vector3(0, 0, -1);
  private readonly depthHead = new Vector3();
  private readonly depthOffset = new Vector3();
  private readonly depthCandidate = new Vector3();
  private depthTracked = false;
  private readonly relativeRotation = new Quaternion();
  private lastRoll = 0;
  private roll = 0;
  private panicSince = -Infinity;
  private inhibited = false;
  private previousRight: HandPosture = 'unknown';
  private heldAtEngage: HandPosture = 'unknown';
  private lastTime = -Infinity;
  readonly engage: GestureEngage;
  // Zone mode: wrist velocity, settle dwell, pre-drop values and pinch-tap tracking (all reused per frame).
  private readonly zoneForward = new Vector3(0, 0, -1);
  private readonly zoneRel = new Vector3();
  private readonly prevWrist = new Vector3();
  private prevWristTime = -Infinity;
  private velY = 0;
  private speed = 0;
  private settleSince = -Infinity;
  private readonly restValues: Float64Array;
  private fallingSince = -Infinity;
  private dropped = false;
  private tapStart = -Infinity;
  private tapValid = false;
  private lastTap = -Infinity;
  private readonly tapOrigin = new Vector3();

  constructor(private readonly map: GestureMap, private readonly emit: GestureEmit, initialValues?: ReadonlyMap<string, number>, options: GestureEngineOptions = {}) {
    this.engage = options.engage ?? 'clutch';
    this.axes = map.axes.map((binding) => {
      const initial = initialValues?.get(binding.actionId);
      const value = initial !== undefined && Number.isFinite(initial)
        ? Math.max(binding.outMin, Math.min(binding.outMax, initial))
        : mapAxisValue(0.5, binding);
      const normalized = (value - binding.outMin) / (binding.outMax - binding.outMin);
      return {
        binding, view: { axis: binding.axis, actionId: binding.actionId, label: binding.label, value, normalized },
        filter: new OneEuroScalar(binding.smoothingMinCutoff, binding.smoothingBeta),
        origin: NaN, pickup: inverseCurve(normalized, binding.curve), lastValue: value, lastSent: -Infinity,
      };
    });
    this.postureTimes = new Float64Array(map.postures.length).fill(-Infinity);
    this.restValues = new Float64Array(this.axes.length);
    this.state = { engaged: false, trackingLost: false, stopped: false, tapped: false, hold: '', mode: this.engage, axes: this.axes.map((axis) => axis.view), leftPosture: 'unknown', rightPosture: 'unknown' };
  }

  /** Current axis values (the held value while not engaged). */
  values(): ReadonlyMap<string, number> {
    return new Map(this.axes.map((axis) => [axis.binding.actionId, axis.lastValue]));
  }

  /** Perform off/on clears panic inhibition and dwell; ratcheted values remain frozen. */
  reset(): void {
    this.freeze();
    this.left.reset(); this.right.reset();
    this.state.stopped = false;
    this.state.trackingLost = false;
    this.state.leftPosture = this.state.rightPosture = this.previousRight = 'unknown';
    this.heldAtEngage = 'unknown';
    this.inhibited = false;
    this.panicSince = this.lastTime = -Infinity;
    this.prevWristTime = this.settleSince = this.fallingSince = this.tapStart = -Infinity;
    this.velY = this.speed = 0;
    this.tapValid = false;
    this.state.hold = '';
  }

  /**
   * `hold` (zone mode): the caller's reasons to keep values still, e.g. this hand is working UI or the wrist menu is open.
   */
  update(frame: ShellFrame, timeMs: number, controllerEngaged = false, hold = false, tapBlocked = hold): GestureState {
    this.state.stopped = false;
    this.state.tapped = false;
    if (!Number.isFinite(timeMs)) { this.freeze(); return this.state; }
    if (timeMs < this.lastTime || timeMs - this.lastTime > 150) {
      this.freeze();
      this.panicSince = -Infinity;
      this.prevWristTime = this.settleSince = this.tapStart = -Infinity;
      this.tapValid = false;
    }
    this.lastTime = timeMs;
    const lh = frame.hands.left, rh = frame.hands.right;
    this.state.leftPosture = this.left.update(lh, timeMs);
    this.state.rightPosture = this.right.update(rh, timeMs);
    const hasRight = this.samplePose(rh, this.rightPose);
    const hasLeft = this.samplePose(lh, this.leftPose);
    this.depthTracked = finitePosition(frame.head.position) && finiteQuaternion(frame.head.quaternion);
    if (this.depthTracked) this.depthHead.copy(frame.head.position);
    this.updatePanic(frame, timeMs);
    const controller = controllerEngaged && rh?.controller === true;
    const zone = this.engage === 'zone' && !rh?.controller;
    this.state.trackingLost = !hasRight || (!rh?.controller && (zone ? !this.right.tracked : !hasLeft || !this.left.tracked));
    if (this.map.postures.length && !this.right.tracked) this.state.trackingLost = true;
    for (const axis of this.axes) if (!Number.isFinite(this.rawAxis(axis.binding.axis, rh, hasLeft))) this.state.trackingLost = true;
    // Zone mode with a controller (or the desktop mouse) in the right hand: only an explicit controller toggle plays.
    const wantsEngage = !this.inhibited && hasRight && (controller
      || (zone ? this.inZone(frame, rh!, timeMs, hold, tapBlocked) : this.engage !== 'zone' && this.left.posture === 'fist' && this.left.raw === 'fist'));
    if (!zone) this.state.hold = '';
    else if (!hasRight) { this.state.hold = 'low'; this.tapStart = -Infinity; this.tapValid = false; this.prevWristTime = -Infinity; }
    if (!wantsEngage) {
      if (this.dropped) this.restoreBeforeDrop(timeMs);
      this.freeze();
      this.previousRight = this.right.posture;
      return this.state;
    }
    if (!this.state.engaged) {
      this.state.engaged = true;
      for (let index = 0; index < this.axes.length; index++) this.restValues[index] = this.axes[index]!.lastValue;
      // Freeze a horizontal body-forward direction at clutch pickup. Looking around
      // does not steer the axis, and moving head+hand together cancels translation.
      if (this.depthTracked) {
        this.depthCandidate.copy(forward).applyQuaternion(frame.head.quaternion); this.depthCandidate.y = 0;
        if (this.depthCandidate.lengthSq() > .01) this.depthForward.copy(this.depthCandidate).normalize();
      }
      this.rollReference.copy(this.rightPose.quaternion).invert();
      this.lastRoll = this.roll = 0;
      for (let index = 0; index < this.axes.length; index++) {
        const axis = this.axes[index]!;
        axis.origin = this.rawAxis(axis.binding.axis, rh, hasLeft);
        axis.pickup = inverseCurve((axis.lastValue - axis.binding.outMin) / (axis.binding.outMax - axis.binding.outMin), axis.binding.curve);
        axis.filter.reset();
        axis.filter.update(axis.pickup, timeMs);
      }
      // A posture already held when the clutch closes is not a new discrete command.
      this.previousRight = this.right.posture;
      this.heldAtEngage = this.right.raw;
    } else this.updateRoll();

    for (let index = 0; index < this.axes.length; index++) this.updateAxis(this.axes[index]!, rh, hasLeft, timeMs);
    if (this.right.raw !== this.heldAtEngage) this.heldAtEngage = 'unknown';
    if (this.right.posture !== this.previousRight && this.right.posture !== this.heldAtEngage) {
      const id = postureId[this.right.posture];
      for (let index = 0; index < this.map.postures.length; index++) {
        const binding = this.map.postures[index]!;
        if (binding.posture !== id || timeMs - this.postureTimes[index]! < 1000 / binding.maxRateHz) continue;
        this.postureTimes[index] = timeMs;
        this.emit(binding.actionId, binding.value ?? true, 'press', binding.posture);
      }
    }
    this.previousRight = this.right.posture;
    return this.state;
  }

  /**
   * Zone mode: is the right hand raised in front, still for a moment (entry) and free of every hold reason?
   * Also tracks the pinch-tap and remembers the values from before a fast drop.
   */
  private inZone(frame: ShellFrame, rh: ShellHand, timeMs: number, hold: boolean, tapBlocked: boolean): boolean {
    const wrist = this.rightPose.position;
    if (Number.isFinite(this.prevWristTime) && timeMs > this.prevWristTime) {
      const dt = (timeMs - this.prevWristTime) / 1000, k = 1 - Math.exp(-dt / 0.05);
      this.velY += ((wrist.y - this.prevWrist.y) / dt - this.velY) * k;
      this.speed += (wrist.distanceTo(this.prevWrist) / dt - this.speed) * k;
    } else this.velY = this.speed = 0;
    this.prevWrist.copy(wrist); this.prevWristTime = timeMs;
    if (!this.depthTracked) { this.state.hold = 'low'; this.settleSince = -Infinity; return false; }
    // While playing, the zone keeps the heading it had at pickup; looking at the card does not end the take.
    if (!this.state.engaged) {
      this.depthCandidate.copy(forward).applyQuaternion(frame.head.quaternion); this.depthCandidate.y = 0;
      if (this.depthCandidate.lengthSq() > .01) this.zoneForward.copy(this.depthCandidate).normalize();
    }
    this.zoneRel.subVectors(wrist, this.depthHead);
    const up = this.zoneRel.y, ahead = this.zoneRel.dot(this.zoneForward), reach = this.zoneRel.length();
    const bounds = this.state.engaged ? PLAY_ZONE.stay : PLAY_ZONE.enter;
    const inside = up > -bounds.below && up < bounds.above && ahead > bounds.forward && reach < bounds.reach;
    const menu = this.menuPalm(frame.hands.left, frame.head.position);
    const pinching = rh.pinching || this.right.raw === 'pinch';
    // Pinch-tap: a short, still pinch that started away from UI and the wrist menu.
    if (pinching) {
      if (!Number.isFinite(this.tapStart)) {
        this.tapStart = timeMs; this.tapOrigin.copy(wrist);
        this.tapValid = !tapBlocked && !menu && !this.inhibited && up > -0.62 && ahead > 0.05 && timeMs - this.lastTap >= PLAY_ZONE.tapCooldownMs;
      } else if (tapBlocked || wrist.distanceTo(this.tapOrigin) > PLAY_ZONE.tapTravel || timeMs - this.tapStart > PLAY_ZONE.tapMs) this.tapValid = false;
    } else if (Number.isFinite(this.tapStart)) {
      if (this.tapValid && timeMs - this.tapStart <= PLAY_ZONE.tapMs) { this.state.tapped = true; this.lastTap = timeMs; }
      this.tapStart = -Infinity; this.tapValid = false;
    }
    if (this.state.engaged) {
      if (this.velY > -PLAY_ZONE.fallSpeed) {
        this.fallingSince = -Infinity;
        for (let index = 0; index < this.axes.length; index++) this.restValues[index] = this.axes[index]!.lastValue;
      } else if (!Number.isFinite(this.fallingSince)) this.fallingSince = timeMs;
    }
    const reason: GestureState['hold'] = !inside ? 'low' : Number.isFinite(this.panicSince) ? 'stop' : hold ? 'ui' : menu ? 'menu'
      : this.right.raw === 'fist' ? 'fist' : pinching ? 'pinch' : rh.palmUp ? 'turned' : '';
    if (reason) {
      // Dropping the hand out of the bottom of the zone keeps the value it had before the drop began.
      this.dropped = this.state.engaged && reason === 'low' && up <= -bounds.below
        && Number.isFinite(this.fallingSince) && timeMs - this.fallingSince < PLAY_ZONE.fallWindowMs;
      this.settleSince = -Infinity; this.fallingSince = -Infinity;
      this.state.hold = reason;
      return false;
    }
    if (this.state.engaged) { this.state.hold = ''; return true; }
    if (this.speed > PLAY_ZONE.settleSpeed) { this.settleSince = -Infinity; this.state.hold = 'moving'; return false; }
    if (!Number.isFinite(this.settleSince)) this.settleSince = timeMs;
    if (timeMs - this.settleSince < PLAY_ZONE.settleMs) { this.state.hold = 'moving'; return false; }
    this.state.hold = '';
    return true;
  }

  /** The wrist-menu pose on the left hand: palm toward the face, raised in front of it. */
  private menuPalm(hand: ShellHand | undefined, head: Vector3): boolean {
    const wrist = hand?.joints.wrist?.position;
    return !!hand && !hand.controller && !!hand.palmUp && !!wrist && wrist.y > head.y - 0.45 && wrist.distanceTo(head) < 0.7;
  }

  private restoreBeforeDrop(timeMs: number): void {
    this.dropped = false;
    for (let index = 0; index < this.axes.length; index++) {
      const axis = this.axes[index]!, value = this.restValues[index]!;
      if (!Number.isFinite(value) || value === axis.lastValue) continue;
      axis.lastValue = value; axis.lastSent = timeMs;
      this.emit(axis.binding.actionId, value, 'move', axis.binding.axis);
    }
  }

  private freeze(): void {
    this.state.engaged = false;
    for (let index = 0; index < this.axes.length; index++) {
      const axis = this.axes[index]!;
      axis.view.value = axis.lastValue;
      axis.view.normalized = (axis.lastValue - axis.binding.outMin) / (axis.binding.outMax - axis.binding.outMin);
    }
  }

  private samplePose(hand: ShellHand | undefined, out: Pose): boolean {
    if (!hand) return false;
    const pose = hand.joints.wrist ?? (hand.controller ? hand.grip : undefined);
    if (pose) {
      if (!finitePosition(pose.position) || !finiteQuaternion(pose.quaternion)) return false;
      out.position.copy(pose.position);
      out.quaternion.copy(pose.quaternion).normalize();
      return true;
    }
    if (!hand.controller || !finitePosition(hand.ray.origin) || !finitePosition(hand.ray.dir) || hand.ray.dir.lengthSq() < 0.5) return false;
    out.position.copy(hand.ray.origin);
    this.direction.copy(hand.ray.dir).normalize();
    out.quaternion.setFromUnitVectors(forward, this.direction);
    return true;
  }

  private updatePanic(frame: ShellFrame, timeMs: number): void {
    const out = this.left.extended && this.right.extended
      && this.palmOut(frame.hands.left, frame.head.position)
      && this.palmOut(frame.hands.right, frame.head.position);
    if (!out) { this.panicSince = -Infinity; return; }
    if (!Number.isFinite(this.panicSince)) this.panicSince = timeMs;
    if (!this.inhibited && timeMs - this.panicSince >= 120) {
      this.inhibited = true;
      this.state.stopped = true;
    }
  }

  private palmOut(hand: ShellHand | undefined, head: Vector3): boolean {
    const wrist = hand?.joints.wrist;
    if (!wrist || !finiteQuaternion(wrist.quaternion) || wrist.position.y <= head.y - 0.55) return false;
    this.palm.set(0, -1, 0).applyQuaternion(wrist.quaternion);
    this.headToHand.subVectors(wrist.position, head).normalize();
    return this.palm.dot(this.headToHand) > (Number.isFinite(this.panicSince) ? 0.45 : 0.65);
  }

  private updateRoll(): void {
    this.relativeRotation.copy(this.rollReference).multiply(this.rightPose.quaternion);
    const angle = 2 * Math.atan2(this.relativeRotation.z, this.relativeRotation.w);
    let delta = angle - this.lastRoll;
    if (delta > Math.PI) delta -= 2 * Math.PI;
    else if (delta < -Math.PI) delta += 2 * Math.PI;
    this.roll += delta;
    this.lastRoll = angle;
  }

  private rawAxis(axis: GestureAxis, right: ShellHand | undefined, hasLeft: boolean): number {
    switch (axis) {
      case 'right_height': return this.rightPose.position.y / 0.45;
      case 'right_depth': return this.depthTracked ? this.depthOffset.subVectors(this.rightPose.position, this.depthHead).dot(this.depthForward) / .4 : NaN;
      case 'right_roll': return this.roll / (2 * Math.PI / 3);
      case 'right_pinch_aperture': {
        const thumb = right?.joints['thumb-tip'], index = right?.joints['index-finger-tip'];
        return thumb && index ? thumb.position.distanceTo(index.position) / 0.085 : NaN;
      }
      case 'two_hand_distance': return hasLeft ? this.leftPose.position.distanceTo(this.rightPose.position) / 0.5 : NaN;
    }
  }

  private updateAxis(axis: AxisRuntime, right: ShellHand | undefined, hasLeft: boolean, timeMs: number): void {
    const raw = this.rawAxis(axis.binding.axis, right, hasLeft);
    if (!Number.isFinite(raw)) {
      // Missing finger/span samples freeze this axis. Recovery takes a fresh pickup reference.
      axis.origin = NaN;
      axis.view.value = axis.lastValue;
      axis.view.normalized = (axis.lastValue - axis.binding.outMin) / (axis.binding.outMax - axis.binding.outMin);
      return;
    }
    if (!Number.isFinite(axis.origin)) {
      axis.origin = raw;
      axis.pickup = inverseCurve((axis.lastValue - axis.binding.outMin) / (axis.binding.outMax - axis.binding.outMin), axis.binding.curve);
      axis.filter.reset();
    }
    const binding = axis.binding;
    const input = clamp01(axis.pickup + applyDeadzone(raw - axis.origin, binding.deadzone));
    const filtered = axis.filter.update(input, timeMs);
    let value = mapAxisValue(filtered, binding);
    const continuousValue = binding.outMin + applyCurve(filtered, binding.curve) * (binding.outMax - binding.outMin);
    // A small Schmitt band around each quantized value stops a resting hand alternating steps.
    if (Math.abs(continuousValue - axis.lastValue) < binding.quantizeStep * 0.65) value = axis.lastValue;
    axis.view.value = value;
    axis.view.normalized = (value - binding.outMin) / (binding.outMax - binding.outMin);
    if (value === axis.lastValue || timeMs - axis.lastSent + 1e-6 < 1000 / Math.min(30, binding.maxRateHz)) return;
    axis.lastValue = value;
    axis.lastSent = timeMs;
    this.emit(binding.actionId, value, 'move', binding.axis);
  }
}
