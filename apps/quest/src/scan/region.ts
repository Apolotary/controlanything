import type { Intrinsics } from '../io/v1';

/** A screen-space selection in camera-image coordinates, normalized to [0, 1]. */
export type ScanRegion = readonly [number, number, number, number];

export function scanRegion(a: readonly number[], b: readonly number[]): ScanRegion | null {
  if (![...a, ...b].every(Number.isFinite)) return null;
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  const r = [clamp(Math.min(a[0], b[0])), clamp(Math.min(a[1], b[1])),
    clamp(Math.max(a[0], b[0])), clamp(Math.max(a[1], b[1]))] as const;
  return r[2] - r[0] >= 0.06 && r[3] - r[1] >= 0.06 ? r : null;
}

/** Crop the image and the principal point together, preserving world-space projection. */
export function regionCrop(k: Intrinsics, region: ScanRegion) {
  const valid = scanRegion(region.slice(0, 2), region.slice(2));
  if (!valid) throw new Error('Choose a larger area inside the camera view.');
  const x = Math.floor(valid[0] * k.width), y = Math.floor(valid[1] * k.height);
  const width = Math.max(1, Math.ceil(valid[2] * k.width) - x);
  const height = Math.max(1, Math.ceil(valid[3] * k.height) - y);
  return { x, y, width, height, intrinsics: { ...k, cx: k.cx - x, cy: k.cy - y, width, height } };
}
