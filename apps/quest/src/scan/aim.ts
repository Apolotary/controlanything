/**
 * Target lock geometry (research/15 §4.3): the head ray (gaze proxy) or a hand ray picks the target whose
 * direction is within its angular radius plus a margin; a pinch within reach of a target touches it.
 */
import { Vector3 } from 'three';

export interface AimTarget {
  id: string;
  position: Vector3;
  /** largest dimension, metres */
  size: number;
}

export interface AimHit {
  id: string;
  angleDeg: number;
  distance: number;
}

export interface AimOptions {
  marginDeg?: number;
  minDist?: number;
  maxDist?: number;
}

const DEFAULT_OPTIONS: AimOptions = {};

/** The target the ray points at, if any: smallest angle within (angular radius + marginDeg), at minDist..maxDist. */
export function aimAt(origin: Vector3, dir: Vector3, targets: Iterable<AimTarget>, opts: AimOptions = DEFAULT_OPTIONS, out?: AimHit): AimHit | null {
  const margin = opts.marginDeg ?? 3;
  const dirLength = Math.hypot(dir.x, dir.y, dir.z);
  if (!(dirLength > 0) || !Number.isFinite(dirLength)) return null;
  let bestId: string | undefined;
  let bestAngle = 0;
  let bestDistance = 0;
  let bestScore = Infinity;
  for (const t of targets) {
    const x = t.position.x - origin.x;
    const y = t.position.y - origin.y;
    const z = t.position.z - origin.z;
    const dist = Math.hypot(x, y, z);
    if (!(dist > 0)) continue;
    if (dist < (opts.minDist ?? 0.1) || dist > (opts.maxDist ?? 6)) continue;
    const dot = (x * dir.x + y * dir.y + z * dir.z) / (dist * dirLength);
    const angle = (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
    const radius = (Math.atan(t.size / 2 / dist) * 180) / Math.PI;
    if (angle > radius + margin) continue;
    // prefer the target whose centre is closest to the ray, relative to its apparent size
    const score = angle / (radius + margin);
    if (score < bestScore) {
      bestScore = score;
      bestId = t.id;
      bestAngle = angle;
      bestDistance = dist;
    }
  }
  if (bestId === undefined) return null;
  const hit = out ?? { id: bestId, angleDeg: bestAngle, distance: bestDistance };
  hit.id = bestId;
  hit.angleDeg = bestAngle;
  hit.distance = bestDistance;
  return hit;
}

/** The target a pinch point touches: within half its size + `reach` metres. */
export function touching(point: Vector3, targets: Iterable<AimTarget>, reach = 0.06, out?: AimHit): AimHit | null {
  let bestId: string | undefined;
  let bestDistance = Infinity;
  for (const t of targets) {
    const dist = t.position.distanceTo(point);
    if (dist > t.size / 2 + reach) continue;
    if (dist < bestDistance) {
      bestId = t.id;
      bestDistance = dist;
    }
  }
  if (bestId === undefined) return null;
  const hit = out ?? { id: bestId, angleDeg: 0, distance: bestDistance };
  hit.id = bestId;
  hit.angleDeg = 0;
  hit.distance = bestDistance;
  return hit;
}
