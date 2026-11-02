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
  /** One-frame pulse. The caller routes it through the application's existing panic path. */
  stopped: boolean;
  axes: GestureAxisState[];
  leftPosture: HandPosture;
  rightPosture: HandPosture;
}
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
  private readonly relativeRotation = new Quaternion();
  private lastRoll = 0;
  private roll = 0;
  private panicSince = -Infinity;
  private inhibited = false;
  private previousRight: HandPosture = 'unknown';
  private heldAtEngage: HandPosture = 'unknown';
  private lastTime = -Infinity;

  constructor(private readonly map: GestureMap, private readonly emit: GestureEmit, initialValues?: ReadonlyMap<string, number>) {
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
    this.state = { engaged: false, stopped: false, axes: this.axes.map((axis) => axis.view), leftPosture: 'unknown', rightPosture: 'unknown' };
  }

  /** Perform off/on clears panic inhibition and dwell; ratcheted values remain frozen. */
  reset(): void {
    this.freeze();
    this.left.reset(); this.right.reset();
    this.state.stopped = false;
    this.state.leftPosture = this.state.rightPosture = this.previousRight = 'unknown';
    this.heldAtEngage = 'unknown';
    this.inhibited = false;
    this.panicSince = this.lastTime = -Infinity;
  }

  update(frame: ShellFrame, timeMs: number, controllerEngaged = false): GestureState {
    this.state.stopped = false;
    if (!Number.isFinite(timeMs)) { this.freeze(); return this.state; }
    if (timeMs < this.lastTime || timeMs - this.lastTime > 150) {
      this.freeze();
      this.panicSince = -Infinity;
    }
    this.lastTime = timeMs;
    const lh = frame.hands.left, rh = frame.hands.right;
    this.state.leftPosture = this.left.update(lh, timeMs);
    this.state.rightPosture = this.right.update(rh, timeMs);
    const hasRight = this.samplePose(rh, this.rightPose);
    const hasLeft = this.samplePose(lh, this.leftPose);
    this.updatePanic(frame, timeMs);
    const controller = controllerEngaged && rh?.controller === true;
    const wantsEngage = !this.inhibited && hasRight && (controller || (this.left.posture === 'fist' && this.left.raw === 'fist'));
    if (!wantsEngage) {
      this.freeze();
      this.previousRight = this.right.posture;
      return this.state;
    }
    if (!this.state.engaged) {
      this.state.engaged = true;
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
