/**
 * Ring buffer of viewer (head) poses, one per XR frame, so a camera frame captured ~60–120 ms before it was
 * delivered can be stamped with the head pose at its exposure time (research/04 §3 step 1).
 */
import { Quaternion, Vector3 } from 'three';

export interface PoseSample {
  t: number;
  position: Vector3;
  quaternion: Quaternion;
  /** head angular speed, degrees per second */
  speedDeg: number;
}

export interface PoseLookup extends PoseSample {
  /** distance in ms from the requested time to the nearest stored sample (0 when bracketed) */
  gapMs: number;
}

export class PoseRing {
  private readonly t: Float64Array;
  private readonly p: Float32Array;
  private readonly q: Float32Array;
  private readonly s: Float32Array;
  private head = 0;
  private count = 0;
  private readonly prevQ = new Quaternion();
  private prevT = -1;

  constructor(readonly capacity = 256) {
    this.t = new Float64Array(capacity);
    this.p = new Float32Array(capacity * 3);
    this.q = new Float32Array(capacity * 4);
    this.s = new Float32Array(capacity);
  }

  get size(): number {
    return this.count;
  }

  /** Store the viewer pose at time t (performance.now() ms). Angular speed is derived from the previous sample. */
  push(t: number, position: { x: number; y: number; z: number }, q: { x: number; y: number; z: number; w: number }): void {
    let speed = 0;
    if (this.prevT >= 0 && t > this.prevT) {
      const dot = Math.min(1, Math.abs(q.x * this.prevQ.x + q.y * this.prevQ.y + q.z * this.prevQ.z + q.w * this.prevQ.w));
      speed = ((2 * Math.acos(dot) * 180) / Math.PI) / ((t - this.prevT) / 1000);
    }
    this.prevQ.set(q.x, q.y, q.z, q.w);
    this.prevT = t;
    const i = this.head;
    this.t[i] = t;
    this.p.set([position.x, position.y, position.z], i * 3);
    this.q.set([q.x, q.y, q.z, q.w], i * 4);
    this.s[i] = speed;
    this.head = (this.head + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
  }

  latest(): PoseSample | null {
    if (!this.count) return null;
    return this.sample((this.head - 1 + this.capacity) % this.capacity);
  }

  /** Pose at time t: interpolated between the two samples around t, else the nearest end of the buffer. */
  lookup(t: number): PoseLookup | null {
    if (!this.count) return null;
    // samples are in time order from oldest to newest
    const oldest = (this.head - this.count + this.capacity) % this.capacity;
    let prev = -1;
    for (let n = 0; n < this.count; n++) {
      const i = (oldest + n) % this.capacity;
      if (this.t[i] >= t) {
        if (prev < 0 || this.t[i] === t) return { ...this.sample(i), gapMs: Math.abs(this.t[i] - t) };
        const a = this.sample(prev);
        const b = this.sample(i);
        const k = (t - a.t) / (b.t - a.t);
        return {
          t,
          position: a.position.lerp(b.position, k),
          quaternion: a.quaternion.slerp(b.quaternion, k),
          speedDeg: a.speedDeg + (b.speedDeg - a.speedDeg) * k,
          gapMs: 0,
        };
      }
      prev = i;
    }
    const last = this.sample(prev);
    return { ...last, gapMs: t - last.t };
  }

  /** Peak angular speed over the last `ms` milliseconds (for "hold still" gating). */
  peakSpeed(now: number, ms: number): number {
    let peak = 0;
    for (let n = 0; n < this.count; n++) {
      const i = (this.head - 1 - n + this.capacity * 2) % this.capacity;
      if (now - this.t[i] > ms) break;
      peak = Math.max(peak, this.s[i]);
    }
    return peak;
  }

  private sample(i: number): PoseSample {
    return {
      t: this.t[i],
      position: new Vector3(this.p[i * 3], this.p[i * 3 + 1], this.p[i * 3 + 2]),
      quaternion: new Quaternion(this.q[i * 4], this.q[i * 4 + 1], this.q[i * 4 + 2], this.q[i * 4 + 3]),
      speedDeg: this.s[i],
    };
  }
}
