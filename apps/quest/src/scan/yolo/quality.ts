import { containment, iou } from './post';
import type { Box } from './prep';

export interface ProjectedJoint {
  u: number;
  v: number;
  /** Radius in camera pixels, including a small allowance for pose latency. */
  radius?: number;
}

/** Suppress hand/arm candidates even when a joint only touches the edge of their box. */
export function overlapsHand(box: Box, joints: readonly ProjectedJoint[]): boolean {
  const [x, y, width, height] = box;
  if (!(width > 0 && height > 0)) return false;
  return joints.some(({ u, v, radius = 6 }) => {
    if (![u, v, radius].every(Number.isFinite)) return false;
    const dx = u - Math.max(x, Math.min(x + width, u));
    const dy = v - Math.max(y, Math.min(y + height, v));
    return dx * dx + dy * dy <= Math.max(0, radius) ** 2;
  });
}

interface Position { x: number; y: number; z: number }
export interface SamCandidate {
  id: string;
  box?: Box | null;
  position?: Position;
  sizeM?: readonly number[];
}

/** SAM owns the label and outline once it covers the same image region or physical anchor. */
export function claimSamTarget(box: Box, candidates: readonly SamCandidate[], position?: Position, sizeM?: readonly number[]): string | undefined {
  let best: string | undefined;
  let bestScore = 0;
  for (const candidate of candidates) {
    const sam = candidate.box;
    const overlap = sam ? iou(box, sam) : 0;
    // A little button inside a laptop must not claim the entire laptop.
    const covers = sam && containment(box, sam) >= 0.6 && containment(sam, box) >= 0.2;
    let score = overlap >= 0.25 || covers ? 1 + overlap : 0;
    if (!score && position && candidate.position) {
      const p = candidate.position;
      const distance = Math.hypot(position.x - p.x, position.y - p.y, position.z - p.z);
      // Keep the subobject guard when looking away: proximity alone cannot establish ownership.
      const areaRatio = sam ? (sam[2] * sam[3]) / (box[2] * box[3]) : faceArea(candidate.sizeM) / faceArea(sizeM);
      if (distance < 0.12 && areaRatio >= 0.2 && areaRatio <= 5) score = 1 - distance / 0.12;
    }
    if (score > bestScore) {
      best = candidate.id;
      bestScore = score;
    }
  }
  return best;
}

function faceArea(sizeM: readonly number[] | undefined): number {
  const width = sizeM?.[0], height = sizeM?.[1];
  return width !== undefined && height !== undefined && Number.isFinite(width) && Number.isFinite(height)
    && width > 0 && height > 0 ? width * height : NaN;
}
