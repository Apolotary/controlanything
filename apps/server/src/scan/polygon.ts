/**
 * Mask raster -> simplified outline polygon (<= 64 points) for the HUD, and point-in-polygon for the oracle.
 * The outline is traced by casting rays from the mask centroid (robust on noisy one_bit rasters, good for
 * the convex-ish shapes devices have) and simplified with Douglas-Peucker.
 */
import type { Polygon, PxBox } from '@ce/protocol';

export const MAX_POLYGON_POINTS = 64;

export interface Raster {
  /** row-major 0/1 values, width x height */
  data: Uint8Array;
  width: number;
  height: number;
  /** top-left of the raster in source pixels */
  x0: number;
  y0: number;
}

/** Centroid and pixel count of the set pixels; null for an empty raster. */
export function rasterCentroid(r: Raster): { cx: number; cy: number; count: number } | null {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < r.height; y++) {
    const row = y * r.width;
    for (let x = 0; x < r.width; x++) {
      if (r.data[row + x]) {
        sx += x;
        sy += y;
        n++;
      }
    }
  }
  if (!n) return null;
  return { cx: sx / n, cy: sy / n, count: n };
}

/** Outline by radial sampling from the centroid: the farthest set pixel along each of `rays` directions. */
export function traceOutline(r: Raster, rays = 48): [number, number][] {
  const c = rasterCentroid(r);
  if (!c) return [];
  const maxR = Math.hypot(r.width, r.height);
  const pts: [number, number][] = [];
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let hit: [number, number] | null = null;
    for (let d = maxR; d >= 0; d -= 1) {
      const x = Math.round(c.cx + dx * d);
      const y = Math.round(c.cy + dy * d);
      if (x < 0 || y < 0 || x >= r.width || y >= r.height) continue;
      if (r.data[y * r.width + x]) {
        hit = [x + r.x0, y + r.y0];
        break;
      }
    }
    if (hit) pts.push(hit);
  }
  return pts;
}

function perpDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Douglas-Peucker on an open polyline. */
export function simplify(points: [number, number][], epsilon: number): [number, number][] {
  if (points.length <= 2) return points;
  let maxD = 0;
  let idx = 0;
  const a = points[0];
  const b = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], a, b);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= epsilon) return [a, b];
  return [...simplify(points.slice(0, idx + 1), epsilon).slice(0, -1), ...simplify(points.slice(idx), epsilon)];
}

/** Closed polygon with at most `max` points: simplify with a growing tolerance until it fits. */
export function simplifyPolygon(points: [number, number][], max = MAX_POLYGON_POINTS): [number, number][] {
  if (points.length <= max) return points;
  let eps = 1;
  let out = points;
  while (out.length > max && eps < 1e4) {
    out = simplify([...points, points[0]], eps).slice(0, -1);
    eps *= 1.5;
  }
  return out.slice(0, max);
}

/** The protocol polygon for a raster, or the box corners when the raster is empty/absent. */
export function polygonFor(raster: Raster | null, box: PxBox): Polygon {
  if (raster) {
    const outline = traceOutline(raster);
    if (outline.length >= 3) return simplifyPolygon(outline).map(([x, y]) => [Math.round(x), Math.round(y)]);
  }
  const [x, y, w, h] = box;
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
}

/** Ray-casting point-in-polygon. */
export function pointInPolygon(px: number, py: number, poly: Polygon): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polygonBox(poly: Polygon): PxBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of poly) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX - minX, maxY - minY];
}

/** Intersection over union of two pixel boxes. */
export function iou(a: PxBox, b: PxBox): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}
