/** Small animation helpers: critically damped smoothing, tweens, a one-euro filter and the 3 Hz flash governor. */
import { Vector3 } from 'three';

/** Exponential smoothing toward a target with time constant tau (seconds). */
export function damp(current: number, target: number, tau: number, dt: number): number {
  if (tau <= 0) return target;
  const k = 1 - Math.exp(-dt / tau);
  return current + (target - current) * k;
}

export const ease = {
  outCubic: (t: number) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outBack: (t: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
};

export interface Tween {
  start: number;
  duration: number;
  fn: (t: number) => void;
  done?: () => void;
}

export class Tweens {
  private list: Tween[] = [];
  add(duration: number, fn: (t: number) => void, done?: () => void, delay = 0): void {
    this.list.push({ start: performance.now() / 1000 + delay, duration, fn, done });
  }
  update(now: number): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const tw = this.list[i]!;
      const t = (now - tw.start) / tw.duration;
      if (t < 0) continue;
      if (t >= 1) {
        tw.fn(1);
        tw.done?.();
        this.list.splice(i, 1);
      } else tw.fn(t);
    }
  }
  clear(): void {
    this.list.length = 0;
  }
}

/** One-euro filter for a 3D point (hand jitter), per Casiez et al. */
export class OneEuro3 {
  private prev = new Vector3();
  private dprev = new Vector3();
  private readonly delta = new Vector3();
  private has = false;
  constructor(private minCutoff = 1.0, private beta = 0.02, private dCutoff = 1.0) {}
  reset(): void {
    this.has = false;
  }
  filter(x: Vector3, dt: number, out = new Vector3()): Vector3 {
    if (!this.has || dt <= 0) {
      this.prev.copy(x);
      this.dprev.set(0, 0, 0);
      this.has = true;
      return out.copy(x);
    }
    const alphaD = alpha(dt, this.dCutoff);
    const dx = this.delta.copy(x).sub(this.prev).divideScalar(dt);
    this.dprev.lerp(dx, alphaD);
    const cutoff = this.minCutoff + this.beta * this.dprev.length();
    const a = alpha(dt, cutoff);
    this.prev.lerp(x, a);
    return out.copy(this.prev);
  }
}
function alpha(dt: number, cutoff: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

/** Nothing anywhere may flash more than 3 times per second: ask before every luminance flash. */
export class FlashGovernor {
  private times: number[] = [];
  constructor(private maxPerSecond = 3) {}
  allow(now: number): boolean {
    this.times = this.times.filter((t) => now - t < 1);
    if (this.times.length >= this.maxPerSecond) return false;
    this.times.push(now);
    return true;
  }
}
