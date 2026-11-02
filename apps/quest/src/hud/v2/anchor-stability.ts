import { Vector3 } from 'three';

export const ANCHOR_DEADBAND_M = 0.12;
export const ANCHOR_DWELL_S = 0.5;
export const ANCHOR_SMOOTHING_S = 0.28;
export const CHIP_GAP_M = 0.12;
export const CHIP_MIN_ANGLE_RAD = 4 * Math.PI / 180;
const ATTENTION_ENTER = Math.cos(12 * Math.PI / 180);
const ATTENTION_EXIT = Math.cos(16 * Math.PI / 180);

/** Research rules 4 and 5: ignore detector noise, then ease sustained movement. */
export class StableAnchor {
  readonly accepted = new Vector3();
  readonly observed = new Vector3();
  private outsideSince = -1;
  private observedAt = 0;

  reset(position: Vector3): void {
    this.accepted.copy(position); this.observed.copy(position); this.outsideSince = -1;
  }
  observe(position: Vector3, time: number): void {
    this.observed.copy(position); this.observedAt = time;
    if (position.distanceToSquared(this.accepted) <= ANCHOR_DEADBAND_M ** 2) this.outsideSince = -1;
    else if (this.outsideSince < 0) this.outsideSince = time;
  }
  update(time: number): boolean {
    if (this.outsideSince < 0 || this.observedAt - this.outsideSince < ANCHOR_DWELL_S || time - this.observedAt > 0.6) return false;
    this.accepted.copy(this.observed); this.outsideSince = -1;
    return true;
  }
}

/** Research rule 2: a short dwell plus a wider exit cone avoids chip flicker. */
export class ChipAttention {
  expanded = false;
  private enteredAt = -1;
  update(cosine: number, time: number, forced = false): boolean {
    if (forced) { this.expanded = true; this.enteredAt = -1; return true; }
    if (this.expanded) {
      if (cosine < ATTENTION_EXIT) { this.expanded = false; this.enteredAt = -1; }
    } else if (cosine >= ATTENTION_ENTER) {
      if (this.enteredAt < 0) this.enteredAt = time;
      if (time - this.enteredAt >= 0.25) this.expanded = true;
    } else this.enteredAt = -1;
    return this.expanded;
  }
}

/** Research rule 3: central nearby candidates win; Infinity means outside the view budget. */
export function candidateScore(distance: number, cosine: number): number {
  // 40° keeps devices in natural view (e.g. a synth on the desk ~35° below eye level) while capping clutter at 5 boxes.
  if (!(distance > 0 && distance <= 3) || cosine < Math.cos(40 * Math.PI / 180)) return Infinity;
  return Math.acos(Math.max(-1, Math.min(1, cosine))) * 4 + distance * 0.1;
}

/** Research rule 7: every full chip subtends at least four degrees vertically. */
export function chipScale(distance: number, height: number): number {
  return Math.max(1, 2 * distance * Math.tan(CHIP_MIN_ANGLE_RAD / 2) / height);
}
