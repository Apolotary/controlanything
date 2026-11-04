/**
 * Two-corner screen calibration: "touch the top-left corner of the screen", then "the bottom-right one".
 * A corner counts when an index fingertip is held still for CALIBRATION.holdMs in a believable place (near the device,
 * at the right side of it). The plane comes from gestures/screen-plane.ts.
 *
 * The calibrator never moves or sends anything; the wiring controller shows the prompts and stores the result.
 */
import { Vector3 } from 'three';
import type { ShellFrame } from '../app/hud-contract';
import { planeFromCorners, type ScreenPlane } from './screen-plane';

export type CalibrationStep = 'top-left' | 'bottom-right';
export const CALIBRATION = {
  holdMs: 400,
  /** the fingertip may wander this far (m) while it counts as held still */
  stillRadius: 0.014,
  /** corner must be within this of the device anchor (m) */
  reach: 0.9,
  /** the fingertip must have left the first corner by this much before the second may be captured */
  minTravel: 0.1,
  /** a hand that is already still when a prompt appears does not count: it must first move this far (m) from where it was seen */
  freshTravel: 0.06,
  /** the bottom-right corner is at least this far right and below (m) */
  minWidth: 0.1, minDrop: 0.06,
} as const;

export type CalibrationUpdate =
  | { kind: 'progress' }
  | { kind: 'corner'; step: CalibrationStep; point: Vector3 }
  | { kind: 'done'; plane: ScreenPlane }
  | { kind: 'rejected'; message: string };

export class ScreenCalibrator {
  step: CalibrationStep = 'top-left';
  /** 0..1 progress of the current hold (for the ring around the fingertip) */
  progress = 0;
  /** the fingertip the progress belongs to, world */
  readonly tip = new Vector3();
  hasTip = false;
  topLeft: Vector3 | null = null;
  /** where a fingertip was first seen since the prompt (or since it was lost); it must travel away before a hold counts */
  private readonly baseline = new Vector3();
  private fresh = false;
  private hasBaseline = false;
  private readonly still = new Vector3();
  private since = -Infinity;
  private lastTime = -Infinity;
  private readonly right = new Vector3();
  private readonly rel = new Vector3();

  reset(): void {
    this.step = 'top-left'; this.progress = 0; this.hasTip = false; this.topLeft = null; this.since = -Infinity; this.lastTime = -Infinity; this.fresh = false; this.hasBaseline = false;
  }

  /** The device the wearer is calibrating (world anchor) and where they stand are read per frame. */
  update(frame: ShellFrame, timeMs: number, anchor: Vector3): CalibrationUpdate {
    if (timeMs < this.lastTime || timeMs - this.lastTime > 250) this.since = -Infinity;
    this.lastTime = timeMs;
    // Screen's right, as seen from the wearer: used to tell left from right of the anchor.
    this.right.set(-(anchor.z - frame.head.position.z), 0, anchor.x - frame.head.position.x);
    if (this.right.lengthSq() < 1e-6) this.right.set(1, 0, 0);
    this.right.normalize();
    // Prefer the right hand, then the left; the first one still enough and in a plausible place wins.
    let tip: Vector3 | undefined, seen: Vector3 | undefined;
    for (const side of ['right', 'left'] as const) {
      const hand = frame.hands[side];
      const p = hand && !hand.controller ? hand.joints['index-finger-tip']?.position : undefined;
      if (!p || !Number.isFinite(p.x + p.y + p.z)) continue;
      seen ??= p;
      if (!tip && this.plausible(p, frame, anchor)) tip = p;
    }
    // A hand that was already resting there when the prompt came up is not a touch: it has to move first.
    if (!this.fresh) {
      if (!seen) this.hasBaseline = false;
      else {
        if (!this.hasBaseline) { this.baseline.copy(seen); this.hasBaseline = true; }
        if (seen.distanceTo(this.baseline) > CALIBRATION.freshTravel) this.fresh = true;
      }
    }
    if (!tip || !this.fresh) { this.hasTip = false; this.progress = 0; this.since = -Infinity; return { kind: 'progress' }; }
    this.hasTip = true; this.tip.copy(tip);
    if (!Number.isFinite(this.since) || tip.distanceTo(this.still) > CALIBRATION.stillRadius) { this.still.copy(tip); this.since = timeMs; }
    this.progress = Math.min(1, (timeMs - this.since) / CALIBRATION.holdMs);
    if (this.progress < 1) return { kind: 'progress' };

    // Captured.
    this.since = -Infinity; this.progress = 0;
    const point = this.still.clone();
    if (this.step === 'top-left') {
      this.topLeft = point; this.step = 'bottom-right';
      return { kind: 'corner', step: 'top-left', point };
    }
    const result = planeFromCorners(this.topLeft!, point, frame.head.position, anchor);
    if ('error' in result) {
      // Start over from the first corner.
      this.topLeft = null; this.step = 'top-left';
      return { kind: 'rejected', message: result.error };
    }
    return { kind: 'done', plane: result.plane };
  }

  private plausible(p: Vector3, frame: ShellFrame, anchor: Vector3): boolean {
    if (p.distanceTo(anchor) > CALIBRATION.reach || p.distanceTo(frame.head.position) < 0.2) return false;
    this.rel.subVectors(p, anchor);
    if (this.step === 'top-left') {
      // Above the device's centre (the top of a screen), and not to the right of it.
      return this.rel.y > -0.02 && this.rel.dot(this.right) < 0.12;
    }
    const tl = this.topLeft!;
    if (p.distanceTo(tl) < CALIBRATION.minTravel) return false;
    this.rel.subVectors(p, tl);
    return this.rel.dot(this.right) > CALIBRATION.minWidth && -this.rel.y > CALIBRATION.minDrop;
  }
}
