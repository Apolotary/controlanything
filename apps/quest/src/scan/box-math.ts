/** Pixel-box geometry shared by the SAM 3.1 scan path (no model here). */

export type Box = [number, number, number, number]; // x, y, w, h (pixels)

export function iou(a: Box, b: Box): number {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}

/** Fraction of box `a` that lies inside box `b`. */
export function containment(a: Box, b: Box): number {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  const area = a[2] * a[3];
  return area > 0 ? (Math.max(0, x1 - x0) * Math.max(0, y1 - y0)) / area : 0;
}

export interface ProjectedJoint {
  u: number;
  v: number;
  /** Radius in camera pixels, including a small allowance for pose latency. */
  radius?: number;
}

/** A device may be held or touched: only suppress a box mostly covered by a tracked hand cluster. */
export function overlapsHand(box: Box, joints: readonly ProjectedJoint[]): boolean {
  const [x, y, width, height] = box;
  if (!(width > 0 && height > 0)) return false;
  let count = 0, minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const { u, v, radius = 6 } of joints) {
    if (!Number.isFinite(u) || !Number.isFinite(v) || !Number.isFinite(radius)) continue;
    if (u < x || u > x + width || v < y || v > y + height) continue;
    count++;
    minU = Math.min(minU, u - radius); maxU = Math.max(maxU, u + radius);
    minV = Math.min(minV, v - radius); maxV = Math.max(maxV, v + radius);
  }
  if (count < 4) return false;
  const coverage = (Math.min(x + width, maxU) - Math.max(x, minU))
    * (Math.min(y + height, maxV) - Math.max(y, minV)) / (width * height);
  return coverage >= 0.7;
}
