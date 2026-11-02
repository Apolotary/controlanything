import type { ShellHand } from '../app/hud-contract';

export type HandPosture = 'unknown' | 'fist' | 'open_palm' | 'point' | 'pinch';
const dwell: Record<HandPosture, number> = { unknown: 0, fist: 45, open_palm: 60, point: 80, pinch: 22 };

/** Scale-normalized joint classifier. Hysteresis holds a pose, dwell admits a new one. */
export class PostureDetector {
  posture: HandPosture = 'unknown';
  raw: HandPosture = 'unknown';
  tracked = false;
  extended = false;
  private candidate: HandPosture = 'unknown';
  private since = -Infinity;
  private previousTime = -Infinity;

  reset(): void {
    this.posture = this.raw = this.candidate = 'unknown';
    this.tracked = this.extended = false;
    this.since = this.previousTime = -Infinity;
  }

  update(hand: ShellHand | undefined, timeMs: number): HandPosture {
    if (timeMs < this.previousTime || timeMs - this.previousTime > 150) this.reset();
    this.previousTime = timeMs;
    this.raw = this.classify(hand);
    if (!this.tracked) {
      this.posture = this.candidate = 'unknown';
      this.since = timeMs;
      return this.posture;
    }
    if (this.raw === this.posture) {
      this.candidate = this.raw;
      this.since = timeMs;
    } else {
      // Release is immediate. Entry dwell never extends an old clutch through an opening hand.
      this.posture = 'unknown';
      if (this.raw !== this.candidate) {
        this.candidate = this.raw;
        this.since = timeMs;
      }
      if (timeMs - this.since >= dwell[this.raw]) this.posture = this.raw;
    }
    return this.posture;
  }

  private classify(hand: ShellHand | undefined): HandPosture {
    this.tracked = this.extended = false;
    if (!hand || hand.controller) return 'unknown';
    const j = hand.joints;
    const wrist = j.wrist;
    // The proximal joint is the knuckle; XR metacarpal origins can sit almost at the wrist.
    const knuckle = j['middle-finger-phalanx-proximal'] ?? j['middle-finger-metacarpal'];
    const thumb = j['thumb-tip'], index = j['index-finger-tip'], middle = j['middle-finger-tip'];
    const ring = j['ring-finger-tip'], pinky = j['pinky-finger-tip'];
    if (!wrist || !knuckle || !thumb || !index || !middle || !ring || !pinky) return 'unknown';
    const scale = wrist.position.distanceTo(knuckle.position);
    if (!Number.isFinite(scale) || scale < 0.025 || scale > 0.16) return 'unknown';
    const i = wrist.position.distanceTo(index.position) / scale;
    const m = wrist.position.distanceTo(middle.position) / scale;
    const r = wrist.position.distanceTo(ring.position) / scale;
    const p = wrist.position.distanceTo(pinky.position) / scale;
    const t = wrist.position.distanceTo(thumb.position) / scale;
    const aperture = thumb.position.distanceTo(index.position) / scale;
    if (!Number.isFinite(i + m + r + p + t + aperture)) return 'unknown';
    this.tracked = true;
    const min = Math.min(i, m, r, p), max = Math.max(i, m, r, p);
    this.extended = min > 1.62;
    const current = this.posture;
    if (max < (current === 'fist' ? 1.38 : 1.18) && t < (current === 'fist' ? 1.65 : 1.45)) return 'fist';
    if (aperture < (current === 'pinch' ? 0.5 : 0.285) && Math.max(m, r) > 1.25) return 'pinch';
    if (i > (current === 'point' ? 1.48 : 1.65) && Math.max(m, r, p) < (current === 'point' ? 1.35 : 1.18)) return 'point';
    if (min > (current === 'open_palm' ? 1.48 : 1.65) && t > 1.35 && aperture > 0.7) return 'open_palm';
    return 'unknown';
  }
}
