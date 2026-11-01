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

/** The target the ray points at, if any: smallest angle within (angular radius + marginDeg), at minDist..maxDist. */
export function aimAt(origin: Vector3, dir: Vector3, targets: Iterable<AimTarget>, opts: { marginDeg?: number; minDist?: number; maxDist?: number } = {}): AimHit | null {
  const margin = opts.marginDeg ?? 3;
  const d = dir.clone().normalize();
  let best: AimHit | null = null;
  let bestScore = Infinity;
  for (const t of targets) {
    const to = t.position.clone().sub(origin);
    const dist = to.length();
    if (dist < (opts.minDist ?? 0.1) || dist > (opts.maxDist ?? 6)) continue;
    const angle = (Math.acos(Math.max(-1, Math.min(1, to.normalize().dot(d)))) * 180) / Math.PI;
    const radius = (Math.atan(t.size / 2 / dist) * 180) / Math.PI;
    if (angle > radius + margin) continue;
    // prefer the target whose centre is closest to the ray, relative to its apparent size
    const score = angle / (radius + margin);
    if (score < bestScore) {
      bestScore = score;
      best = { id: t.id, angleDeg: angle, distance: dist };
    }
  }
  return best;
}

/** The target a pinch point touches: within half its size + `reach` metres. */
export function touching(point: Vector3, targets: Iterable<AimTarget>, reach = 0.06): AimHit | null {
  let best: AimHit | null = null;
  for (const t of targets) {
    const dist = t.position.distanceTo(point);
    if (dist > t.size / 2 + reach) continue;
    if (!best || dist < best.distance) best = { id: t.id, angleDeg: 0, distance: dist };
  }
  return best;
}
