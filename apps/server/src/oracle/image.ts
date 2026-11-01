/**
 * Pure-JS image helpers for the oracles and the QR decoder: JPEG -> RGBA (jpeg-js), region statistics.
 */
import jpeg from 'jpeg-js';
import type { Polygon, PxBox } from '@ce/protocol';
import { pointInPolygon, polygonBox } from '../scan/polygon';

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, row-major */
  data: Uint8Array;
}

export function decodeJpeg(input: string | Uint8Array): DecodedImage {
  const buf = typeof input === 'string' ? Buffer.from(input, 'base64') : input;
  const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512, maxResolutionInMP: 40 });
  return { width: img.width, height: img.height, data: img.data as Uint8Array };
}

/** Encode RGBA to JPEG (tests and the sim-mode fixtures). */
export function encodeJpeg(img: DecodedImage, quality = 85): Uint8Array {
  const out = jpeg.encode({ width: img.width, height: img.height, data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength) }, quality);
  return new Uint8Array(out.data.buffer, out.data.byteOffset, out.data.byteLength);
}

export interface RegionStats {
  /** mean luma 0..255 */
  luma: number;
  /** mean red / mean blue (colour temperature proxy; higher = warmer) */
  rb: number;
  r: number;
  g: number;
  b: number;
  pixels: number;
}

/** Mean luma (Rec. 709) and channel means over the pixels where `inside(x, y)` holds, within `box`, sampling every `step` pixels. */
export function regionStats(img: DecodedImage, box: PxBox, inside: (x: number, y: number) => boolean, step = 1): RegionStats {
  const x0 = Math.max(0, Math.floor(box[0]));
  const y0 = Math.max(0, Math.floor(box[1]));
  const x1 = Math.min(img.width, Math.ceil(box[0] + box[2]));
  const y1 = Math.min(img.height, Math.ceil(box[1] + box[3]));
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = y0; y < y1; y += step) {
    const row = y * img.width;
    for (let x = x0; x < x1; x += step) {
      if (!inside(x, y)) continue;
      const i = (row + x) * 4;
      r += img.data[i];
      g += img.data[i + 1];
      b += img.data[i + 2];
      n++;
    }
  }
  if (!n) return { luma: 0, rb: 1, r: 0, g: 0, b: 0, pixels: 0 };
  r /= n;
  g /= n;
  b /= n;
  return { luma: 0.2126 * r + 0.7152 * g + 0.0722 * b, rb: (r + 1) / (b + 1), r, g, b, pixels: n };
}

/** A sampling step that keeps a region under ~40k samples. */
export function sampleStep(box: PxBox): number {
  const area = Math.max(1, box[2] * box[3]);
  return Math.max(1, Math.floor(Math.sqrt(area / 40_000)));
}

/** Expand a box by `factor` on every side, clamped to the image. */
export function expandBox(box: PxBox, factor: number, width: number, height: number): PxBox {
  const dx = box[2] * factor;
  const dy = box[3] * factor;
  const x = Math.max(0, box[0] - dx);
  const y = Math.max(0, box[1] - dy);
  const x2 = Math.min(width, box[0] + box[2] + dx);
  const y2 = Math.min(height, box[1] + box[3] + dy);
  return [x, y, x2 - x, y2 - y];
}

export interface MaskRegions {
  /** pixels inside the polygon */
  mask: RegionStats;
  /** pixels in a ring around the polygon's box (background reference, cancels auto-exposure) */
  ring: RegionStats;
  /** mask and ring together (absolute brightness of the lamp and what it lights; valid at a fixed exposure) */
  all: RegionStats;
}

/** Mask vs ring statistics for one polygon in one image. */
export function maskAndRing(img: DecodedImage, polygon: Polygon, ringFactor = 0.35): MaskRegions {
  const box = polygonBox(polygon);
  const step = sampleStep(box);
  const mask = regionStats(img, box, (x, y) => pointInPolygon(x + 0.5, y + 0.5, polygon), step);
  const outer = expandBox(box, ringFactor, img.width, img.height);
  const inner = expandBox(box, 0.08, img.width, img.height);
  const ring = regionStats(
    img,
    outer,
    (x, y) => !(x >= inner[0] && x < inner[0] + inner[2] && y >= inner[1] && y < inner[1] + inner[3]),
    sampleStep(outer),
  );
  const n = mask.pixels + ring.pixels;
  const mix = (a: number, b: number) => (n ? (a * mask.pixels + b * ring.pixels) / n : 0);
  const all: RegionStats = { luma: mix(mask.luma, ring.luma), rb: mix(mask.rb, ring.rb), r: mix(mask.r, ring.r), g: mix(mask.g, ring.g), b: mix(mask.b, ring.b), pixels: n };
  return { mask, ring, all };
}
