/**
 * YOLOX post-processing. The exported head gives, per anchor, [dx, dy, log w, log h, objectness, 80 class
 * probabilities] with sigmoid already applied to objectness and classes but NOT the grid decode (YOLOX's
 * `decode_in_inference=False` export, as in its ONNXRuntime demo). Anchors are the cells of the stride-8,
 * 16 and 32 grids in that order: 52² + 26² + 13² = 3549 for a 416 input.
 */
import { deviceClass, PERSON_CLASS } from './classes';
import type { Box } from './prep';

export interface Candidate {
  box: Box; // model-input pixels
  score: number;
  cls: number;
}

export interface DecodeOptions {
  inputSize: number;
  numClasses?: number;
  strides?: number[];
  /** objectness × class probability */
  scoreThreshold: number;
  /** classes that may be returned; an anchor whose best class is outside the set is dropped */
  allowed: Set<number>;
}

export interface Decoded {
  devices: Candidate[];
}

export function anchorCount(inputSize: number, strides = [8, 16, 32]): number {
  return strides.reduce((n, s) => n + (inputSize / s) ** 2, 0);
}

export function decodeYolox(out: Float32Array, o: DecodeOptions): Decoded {
  const nc = o.numClasses ?? 80;
  const stride = 5 + nc;
  const strides = o.strides ?? [8, 16, 32];
  const devices: Candidate[] = [];
  let a = 0;
  for (const s of strides) {
    const g = Math.round(o.inputSize / s);
    for (let gy = 0; gy < g; gy++) {
      for (let gx = 0; gx < g; gx++, a++) {
        const base = a * stride;
        if (base + stride > out.length) return { devices };
        const obj = out[base + 4]!;
        if (!Number.isFinite(obj) || obj < o.scoreThreshold) continue; // score = obj × cls ≤ obj
        // best class over all 80: a person-dominant anchor is never relabelled as a device
        let best = 0;
        let bestP = -1;
        for (let c = 0; c < nc; c++) {
          const p = out[base + 5 + c]!;
          if (p > bestP) {
            bestP = p;
            best = c;
          }
        }
        const score = obj * bestP;
        if (score < o.scoreThreshold) continue;
        if (best === PERSON_CLASS || !deviceClass(best) || !o.allowed.has(best)) continue;
        const cx = (out[base]! + gx) * s;
        const cy = (out[base + 1]! + gy) * s;
        const w = Math.exp(out[base + 2]!) * s;
        const h = Math.exp(out[base + 3]!) * s;
        if (![cx, cy, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
        const c: Candidate = { box: [cx - w / 2, cy - h / 2, w, h], score, cls: best };
        devices.push(c);
      }
    }
  }
  return { devices };
}

export function iou(a: Box, b: Box): number {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}

/** Greedy NMS, per class (classAware) or across classes, highest score first; at most maxOut boxes. */
export function nms<T extends Candidate>(cands: T[], iouThreshold: number, opts: { classAware?: boolean; maxOut?: number } = {}): T[] {
  const sorted = [...cands].sort((p, q) => q.score - p.score);
  const keep: T[] = [];
  const max = opts.maxOut ?? 100;
  for (const c of sorted) {
    if (keep.length >= max) break;
    let ok = true;
    for (const k of keep) {
      if (opts.classAware !== false && k.cls !== c.cls) continue;
      if (iou(k.box, c.box) > iouThreshold) {
        ok = false;
        break;
      }
    }
    if (ok) keep.push(c);
  }
  return keep;
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

const LAPTOP = 63;
const KEYBOARD = 66;

/** A laptop's own keyboard is part of the laptop: drop a keyboard box that lies (≥ 80 %) inside a laptop box. */
export function dropLaptopKeyboards<T extends Candidate>(boxes: T[]): T[] {
  const laptops = boxes.filter((b) => b.cls === LAPTOP);
  if (!laptops.length) return boxes;
  return boxes.filter((b) => b.cls !== KEYBOARD || !laptops.some((l) => containment(b.box, l.box) >= 0.8));
}

/** The whole post-processing step used by the worker. */
export function postprocess(out: Float32Array, o: DecodeOptions & { iouThreshold?: number; maxOut?: number }): Candidate[] {
  // laptops are always decoded (to recognise a laptop's own keyboard), then filtered like everything else
  const decodeSet = o.allowed.has(KEYBOARD) ? new Set([...o.allowed, LAPTOP]) : o.allowed;
  const { devices } = decodeYolox(out, { ...o, allowed: decodeSet });
  const kept = nms(devices, o.iouThreshold ?? 0.45, { classAware: true, maxOut: (o.maxOut ?? 12) * 2 });
  // a second, class-agnostic pass: one object, one box
  const single = dropLaptopKeyboards(nms(kept, 0.7, { classAware: false, maxOut: o.maxOut ?? 12 })).filter((c) => o.allowed.has(c.cls));
  return single;
}
