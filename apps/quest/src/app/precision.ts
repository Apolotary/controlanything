import { Quaternion, Vector3 } from 'three';

const radians = Math.PI / 180;
const clampDot = (value: number): number => Math.max(-1, Math.min(1, value));
const alpha = (cutoff: number, seconds: number): number => 1 / (1 + 1 / (2 * Math.PI * cutoff * seconds));

/** Adaptive scalar smoothing; reset on a new clutch reference so pickup never drifts. */
export class OneEuroScalar {
  private time = -Infinity;
  private previous = 0;
  private filtered = 0;
  private velocity = 0;

  constructor(private readonly minCutoff = 1.2, private readonly beta = 0.4) {}

  reset(): void { this.time = -Infinity; }

  update(value: number, timeMs: number): number {
    if (!Number.isFinite(value) || !Number.isFinite(timeMs)) return this.filtered;
    const seconds = (timeMs - this.time) / 1000;
    if (!Number.isFinite(this.time) || seconds > 0.25 || seconds < 0) {
      this.filtered = value;
      this.velocity = 0;
    } else if (seconds > 0) {
      this.velocity += ((value - this.previous) / seconds - this.velocity) * alpha(1, seconds);
      this.filtered += (value - this.filtered) * alpha(this.minCutoff + this.beta * Math.abs(this.velocity), seconds);
    }
    this.previous = value;
    this.time = timeMs;
    return this.filtered;
  }
}

/** Research synthesis rule 8: slow rays reject tremor; deliberate motion raises the cutoff. */
export class OneEuroRayFilter {
  private time = -Infinity;
  private readonly origin = new Vector3();
  private readonly direction = new Vector3();
  private readonly previousOrigin = new Vector3();
  private readonly previousDirection = new Vector3();
  private readonly velocity = new Vector3();
  private readonly delta = new Vector3();
  private readonly rotation = new Quaternion();
  private angularSpeed = 0;

  // beta is per rad/s (direction) and per m/s (origin): 1 keeps resting tremor smoothed (≈1.5-2 Hz) while a deliberate
  // 1 rad/s move raises the cutoff to ≈2.5 Hz and a fast flick to ≈7 Hz, so the pointer keeps up with a moving hand.
  constructor(private readonly minCutoff = 1.5, private readonly beta = 1) {}

  reset(): void { this.time = -Infinity; }

  /** Inputs may also be outputs. Directions remain unit length; all storage is reused. */
  update(origin: Vector3, direction: Vector3, timeMs: number, outOrigin: Vector3, outDirection: Vector3): void {
    const seconds = (timeMs - this.time) / 1000;
    if (!Number.isFinite(this.time) || seconds > 0.25 || seconds < 0) {
      this.origin.copy(origin); this.direction.copy(direction).normalize();
      this.velocity.set(0, 0, 0); this.angularSpeed = 0;
    } else if (seconds > 0) {
      const derivativeAlpha = alpha(1, seconds);
      this.delta.subVectors(origin, this.previousOrigin).divideScalar(seconds);
      this.velocity.lerp(this.delta, derivativeAlpha);
      this.origin.lerp(origin, alpha(this.minCutoff + this.beta * this.velocity.length(), seconds));
      const speed = Math.acos(clampDot(this.previousDirection.dot(direction))) / seconds;
      this.angularSpeed += (speed - this.angularSpeed) * derivativeAlpha;
      // Angular velocity is in radians/second, so beta has the same useful scale as metres/second.
      const angle = Math.acos(clampDot(this.direction.dot(direction)));
      if (angle > 1e-8) {
        this.delta.crossVectors(this.direction, direction);
        if (this.delta.lengthSq() < 1e-12) {
          this.delta.set(Math.abs(this.direction.x) < 0.9 ? 1 : 0, Math.abs(this.direction.x) < 0.9 ? 0 : 1, 0).cross(this.direction);
        }
        this.delta.normalize();
        this.rotation.setFromAxisAngle(this.delta, angle * alpha(this.minCutoff + this.beta * this.angularSpeed, seconds));
        this.direction.applyQuaternion(this.rotation).normalize();
      }
    }
    this.previousOrigin.copy(origin); this.previousDirection.copy(direction).normalize();
    this.time = timeMs;
    outOrigin.copy(this.origin); outDirection.copy(this.direction);
  }
}

/** Fixed ring buffer: selecting never allocates and stale/null hover samples never resurrect a target. */
export class PinchTargetHistory<T> {
  private readonly times = new Float64Array(32);
  private readonly targets: (T | null)[] = Array<T | null>(32).fill(null);
  private readonly origins = Array.from({ length: 32 }, () => new Vector3());
  private readonly directions = Array.from({ length: 32 }, () => new Vector3());
  private cursor = 0;
  private count = 0;

  reset(): void { this.count = 0; this.cursor = 0; this.targets.fill(null); }

  record(timeMs: number, target: T | null, origin: Vector3, direction: Vector3): void {
    const index = this.cursor;
    this.times[index] = timeMs; this.targets[index] = target;
    this.origins[index]!.copy(origin); this.directions[index]!.copy(direction);
    this.cursor = (index + 1) % this.times.length;
    this.count = Math.min(this.count + 1, this.times.length);
  }

  /** Call before recording the pinch frame, using the raw ray when one is available. */
  compensate(timeMs: number, current: T | null, origin: Vector3, direction: Vector3): T | null {
    let best = -1, error = Infinity, recent = -1, recentAge = 0;
    for (let offset = 0; offset < this.count; offset++) {
      const index = (this.cursor - 1 - offset + this.times.length) % this.times.length;
      const age = timeMs - this.times[index]!;
      if (age > recentAge && age <= 30) { recent = index; recentAge = age; }
      if (age < 0 || age > 150 || age < 70) continue;
      const distance = Math.abs(age - 120);
      if (distance < error) { best = index; error = distance; }
    }
    if (best < 0 || recent < 0 || this.targets[best] === null || direction.lengthSq() < 0.5) return current;
    // Only an abrupt pinch-sized disturbance gets compensated. A deliberate sweep toward a new
    // button must not select its old neighbor merely because that neighbor was hovered earlier.
    if (direction.dot(this.directions[best]!) < Math.cos(6 * radians)) return current;
    const jumped = direction.dot(this.directions[recent]!) < Math.cos(radians)
      || origin.distanceToSquared(this.origins[recent]!) > 0.015 ** 2;
    return jumped ? this.targets[best]! : current;
  }
}

/** Ray-only enlargement; poke bounds deliberately retain their existing physical dimensions. */
export function expandedRayBounds(x: number, y: number, width: number, height: number): boolean {
  return Math.abs(x) <= width * 0.65 && Math.abs(y) <= height * 0.65;
}

/** Research synthesis rule 8: positive distance within the magnetic cone, otherwise Infinity. */
export function rayTargetWithinAngle(origin: Vector3, direction: Vector3, target: Vector3, degrees = 3): number {
  const x = target.x - origin.x, y = target.y - origin.y, z = target.z - origin.z;
  const distanceSq = x * x + y * y + z * z;
  const along = x * direction.x + y * direction.y + z * direction.z;
  const cos = Math.cos(degrees * radians);
  return along > 0 && along * along >= distanceSq * cos * cos ? Math.sqrt(distanceSq) : Infinity;
}
