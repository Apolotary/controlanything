/**
 * The sim camera: adds the room's linear light layers for the current lamp state and develops the result
 * like a small camera sensor would (fixed exposure and white balance, a filmic curve on luminance that keeps
 * the lamp's colour in the highlights, sRGB encoding, optional sensor noise).
 *
 *   linear = skyGain·sky + lampGain·main·rgb(T)·lamp + nightGain·night·amber·nightLayer
 *
 * Pure (no DOM): the browser calls it for the live view and for every camera frame it sends; tests call it
 * on small synthetic layers.
 */
import { NIGHT_RGB, type Rgb } from './cct';
import type { LampDisplay } from './lamp';

export interface RoomLayers {
  width: number;
  height: number;
  /** linear RGB, 3 floats per pixel */
  sky: Float32Array;
  lamp: Float32Array;
  night: Float32Array;
}

export interface CameraParams {
  /** multiplier before the tone curve (1 = as calibrated) */
  exposure: number;
  skyGain: number;
  lampGain: number;
  nightGain: number;
}

export interface ComposeOptions {
  /** sensor noise strength, 0 = none (live view), 1 = typical small-sensor noise (frames sent to the server) */
  noise?: number;
  seed?: number;
}

const LUT_SIZE = 4096;
const GAMMA_LUT = (() => {
  const lut = new Uint8ClampedArray(LUT_SIZE + 1);
  for (let i = 0; i <= LUT_SIZE; i++) {
    const v = i / LUT_SIZE;
    const s = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    lut[i] = Math.round(s * 255);
  }
  return lut;
})();

/** Filmic curve (ACES fit by K. Narkowicz), applied to luminance. */
export function tone(x: number): number {
  const y = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
  return y < 0 ? 0 : y > 1 ? 1 : y;
}

/** Multiply every layer by a soft lens vignette (exact, because light is linear). Call once after loading. */
export function applyVignette(layers: RoomLayers, strength = 0.28): void {
  const { width: w, height: h } = layers;
  const cx = w / 2;
  const cy = h / 2;
  const r2max = cx * cx + cy * cy;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = ((x - cx) ** 2 + (y - cy) ** 2) / r2max;
      const v = 1 - strength * d * d;
      const i = (y * w + x) * 3;
      for (const L of [layers.sky, layers.lamp, layers.night]) {
        L[i] = L[i]! * v;
        L[i + 1] = L[i + 1]! * v;
        L[i + 2] = L[i + 2]! * v;
      }
    }
  }
}

/** Develop one frame into `out` (RGBA, width*height*4). */
export function compose(layers: RoomLayers, d: LampDisplay, cam: CameraParams, out: Uint8ClampedArray, opts: ComposeOptions = {}): void {
  const { sky, lamp, night } = layers;
  const n = layers.width * layers.height;
  const e = cam.exposure;
  const s = cam.skyGain * e;
  const lr = cam.lampGain * d.main * d.rgb[0] * e;
  const lg = cam.lampGain * d.main * d.rgb[1] * e;
  const lb = cam.lampGain * d.main * d.rgb[2] * e;
  const nr = cam.nightGain * d.night * NIGHT_RGB[0] * e;
  const ng = cam.nightGain * d.night * NIGHT_RGB[1] * e;
  const nb = cam.nightGain * d.night * NIGHT_RGB[2] * e;
  const useNight = d.night > 1e-4;
  const useLamp = d.main > 1e-4;
  const noise = opts.noise ?? 0;
  let seed = (opts.seed ?? 1) >>> 0 || 1;
  const rnd = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  for (let p = 0, i = 0, o = 0; p < n; p++, i += 3, o += 4) {
    let r = sky[i]! * s;
    let g = sky[i + 1]! * s;
    let b = sky[i + 2]! * s;
    if (useLamp) {
      r += lamp[i]! * lr;
      g += lamp[i + 1]! * lg;
      b += lamp[i + 2]! * lb;
    }
    if (useNight) {
      r += night[i]! * nr;
      g += night[i + 1]! * ng;
      b += night[i + 2]! * nb;
    }
    const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (Y > 1e-7) {
      const Yt = tone(Y);
      const m = Yt / Y;
      r *= m;
      g *= m;
      b *= m;
      const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
      if (mx > 1) {
        r /= mx;
        g /= mx;
        b /= mx;
      }
      if (Yt > 0.85) {
        // the very top drifts toward white, like a real sensor, but keeps most of its hue
        const a = (Yt - 0.85) * 1.0;
        r += (Yt - r) * a;
        g += (Yt - g) * a;
        b += (Yt - b) * a;
      }
    } else {
      r = g = b = 0;
    }
    let R = GAMMA_LUT[(r * LUT_SIZE) | 0]!;
    let G = GAMMA_LUT[(g * LUT_SIZE) | 0]!;
    let B = GAMMA_LUT[(b * LUT_SIZE) | 0]!;
    if (noise > 0) {
      // shot-like noise grows with signal, plus a read-noise floor (8-bit units)
      const v = (R + G + B) / 765;
      const sigma = noise * (1.1 + 3.2 * Math.sqrt(v));
      const k = (rnd() + rnd() - 1) * 1.7 * sigma;
      R += k + (rnd() - 0.5) * sigma;
      G += k + (rnd() - 0.5) * sigma;
      B += k + (rnd() - 0.5) * sigma;
    }
    out[o] = R;
    out[o + 1] = G;
    out[o + 2] = B;
    out[o + 3] = 255;
  }
}

export interface Region {
  /** pixel box */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Mean Rec. 709 luma (0-255) and R/B ratio of an RGBA buffer, optionally inside a box. */
export function stats(rgba: Uint8ClampedArray, width: number, region?: Region): { luma: number; r: number; g: number; b: number; rb: number; clipped: number } {
  const height = rgba.length / 4 / width;
  const x0 = region ? Math.max(0, Math.floor(region.x)) : 0;
  const y0 = region ? Math.max(0, Math.floor(region.y)) : 0;
  const x1 = region ? Math.min(width, Math.ceil(region.x + region.w)) : width;
  const y1 = region ? Math.min(height, Math.ceil(region.y + region.h)) : height;
  let R = 0;
  let G = 0;
  let B = 0;
  let clipped = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * width + x) * 4;
      const r = rgba[o]!;
      const g = rgba[o + 1]!;
      const b = rgba[o + 2]!;
      R += r;
      G += g;
      B += b;
      if (0.2126 * r + 0.7152 * g + 0.0722 * b > 240) clipped++;
      n++;
    }
  }
  n = Math.max(1, n);
  const r = R / n;
  const g = G / n;
  const b = B / n;
  return { luma: 0.2126 * r + 0.7152 * g + 0.0722 * b, r, g, b, rb: r / Math.max(1e-6, b), clipped: clipped / n };
}

export type { Rgb };
