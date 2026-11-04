/**
 * Webcam hand finding with classic, deterministic computer vision. No model of any kind is loaded or called.
 *
 * Per frame (about 192 x 144 pixels, in a Worker):
 *   1. Skin likelihood in YCrCb: a Mahalanobis distance in the (Cr, Cb) plane against a skin colour model.
 *      The default model covers typical skin; "Show your palm in the box" refits it to this person and this light.
 *   2. Motion: frame difference on luma, kept as a short motion history (used for the flow field and to help
 *      moving skin through weak colour).
 *   2b. Background: every pixel that stays unchanged for ~4 s is learned (a laptop webcam does not move), and skin
 *      only counts where the image differs from that background. Warm walls, wood and a still face drop out; a
 *      hand held perfectly still for that long fades too and returns the moment it moves.
 *   3. The face is skin too: it is found once (a steady skin blob near the top middle), then followed with mean
 *      shift and masked out, so hands next to the face still count.
 *   4. A 3 x 3 box blur and a threshold give a mask; two-pass connected components with union-find give blobs.
 *   5. The two largest remaining blobs are hands. Raised hands are the top end of an arm blob, so the hand region
 *      is the top part of the blob (about 1.35 hand widths tall). Its centroid, area, fill and outline compactness
 *      are measured: a closed hand is compact and square-ish, an open hand is taller with a ragged outline.
 *   6. A coarse optical-flow field (one Lucas-Kanade solve per 8 x 8 cell) for the particles.
 *
 * Coordinates are image coordinates in 0..1 (not mirrored). The page mirrors and fits them to the screen.
 */

export interface SkinModel {
  /** mean Cr, Cb */
  mCr: number; mCb: number;
  /** inverse covariance (a b; b c) */
  a: number; b: number; c: number;
  /** squared distance where the score reaches 0 */
  gate: number;
}

export function skinModelFrom(mCr: number, mCb: number, sCr: number, sCb: number, rho: number, gate = 7): SkinModel {
  const vCr = sCr * sCr, vCb = sCb * sCb, cov = rho * sCr * sCb;
  const det = Math.max(1e-6, vCr * vCb - cov * cov);
  return { mCr, mCb, a: vCb / det, b: -cov / det, c: vCr / det, gate };
}

/** Typical skin in YCrCb (wide on purpose; calibration narrows it). */
export const DEFAULT_SKIN = skinModelFrom(150, 108, 11, 13, -0.45, 7);

export interface Blob {
  /** hand-region centroid, 0..1 image coordinates */
  x: number; y: number;
  /** hand-region area as a fraction of the frame */
  area: number;
  /** whole connected blob area (hand plus any forearm) */
  blobArea: number;
  /** hand-region box size, 0..1 of width / height */
  w: number; h: number;
  /** area / box area */
  fill: number;
  /** 4 pi A / P^2 of the hand region (1 = disc) */
  compact: number;
  /** hand-region height over width (in pixels) */
  aspect: number;
  /** topmost point of the hand region */
  tipX: number; tipY: number;
  /** share of the hand region that moved in the last half second */
  motion: number;
}

export interface Face { x: number; y: number; rx: number; ry: number }

export interface VisionResult {
  w: number; h: number;
  hands: Blob[];
  face: Face | null;
  /** gw * gh * 3: flow x, flow y (image widths per frame), motion energy 0..1 */
  flow: Float32Array; gw: number; gh: number;
  skin: number; motion: number;
  ms: number;
  /** debug: 0 none, 1 skin, 2 hand blob, 3 face */
  mask?: Uint8Array;
}

export interface CalibrationResult { ok: boolean; model: SkinModel; samples: number; area: number; message: string }

const CELL = 8;
const MOTION_THRESHOLD = 16;

export class HandVision {
  model: SkinModel = DEFAULT_SKIN;
  /** the model was fitted to this person (Calibrate) */
  calibrated = false;
  readonly n: number;
  private readonly luma: Uint8Array;
  private readonly prevLuma: Uint8Array;
  private readonly cr: Uint8Array;
  private readonly cb: Uint8Array;
  private readonly score: Uint8Array;
  private readonly tmp: Uint16Array;
  private readonly mask: Uint8Array;
  /** skin by colour alone (the face tracker uses this; hands also need foreground) */
  private readonly skin: Uint8Array;
  private readonly history: Uint8Array;
  private readonly labels: Int32Array;
  private readonly parent: Int32Array;
  private readonly debug: Uint8Array;
  /** learned background colour per pixel (a static webcam), how long each pixel has been unchanged, and foreground */
  private readonly bgY: Float32Array;
  private readonly bgCr: Float32Array;
  private readonly bgCb: Float32Array;
  private readonly bgReady: Uint8Array;
  private readonly stable: Uint8Array;
  private readonly fg: Uint8Array;
  private busyFrames = 0;
  /** frames a pixel must stay unchanged before it is background */
  learnFrames = 120;
  readonly gw: number; readonly gh: number;
  private readonly flow: Float32Array;
  private hasPrev = false;
  face: Face | null = null;
  /** face search state: a candidate must stay put for a few frames */
  private faceCandidate: { x: number; y: number; rx: number; ry: number; frames: number } | null = null;
  private faceWeak = 0;
  /** false for the rear camera (no face in view) */
  faceSearch = true;
  /** smallest hand region, fraction of the frame */
  minArea = 0.0035;

  constructor(readonly w: number, readonly h: number) {
    const n = this.n = w * h;
    this.luma = new Uint8Array(n); this.prevLuma = new Uint8Array(n);
    this.cr = new Uint8Array(n); this.cb = new Uint8Array(n);
    this.score = new Uint8Array(n); this.tmp = new Uint16Array(n); this.mask = new Uint8Array(n); this.skin = new Uint8Array(n);
    this.history = new Uint8Array(n); this.labels = new Int32Array(n); this.parent = new Int32Array(n + 1);
    this.debug = new Uint8Array(n);
    this.bgY = new Float32Array(n); this.bgCr = new Float32Array(n); this.bgCb = new Float32Array(n);
    this.bgReady = new Uint8Array(n); this.stable = new Uint8Array(n); this.fg = new Uint8Array(n);
    this.gw = Math.floor(w / CELL); this.gh = Math.floor(h / CELL);
    this.flow = new Float32Array(this.gw * this.gh * 3);
  }

  /** Skin score 0..255 for one pixel's chroma. */
  private skinScore(cr: number, cb: number, y: number, r: number, g: number, b: number): number {
    const m = this.model;
    const dr = cr - m.mCr, db = cb - m.mCb;
    const d2 = m.a * dr * dr + 2 * m.b * dr * db + m.c * db * db;
    if (d2 >= m.gate) return 0;
    // Chroma is unreliable in near-black and blown-out pixels; skin is never bluer than it is red.
    if (y < 30 || y > 250 || b > r + 8 || g > r + 12) return 0;
    let s = 1 - d2 / m.gate;
    // Before calibration: skin is clearly redder than it is blue (Cr - Cb is about 40); a pale wall under warm
    // light is not (about 15). After calibration the person's own colour model decides.
    if (!this.calibrated) { const warm = cr - cb; if (warm < 14) return 0; if (warm < 24) s *= (warm - 14) / 10; }
    if (y < 55) s *= (y - 30) / 25;
    return Math.round(s * 255);
  }

  process(rgba: Uint8ClampedArray | Uint8Array, wantMask = false): VisionResult {
    const t0 = performance.now();
    const { w, h, n, luma, prevLuma, cr, cb, score, history } = this;
    // 1. colour space + skin score + motion history
    let skinCount = 0, moveCount = 0, fgCount = 0;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const r = rgba[p]!, g = rgba[p + 1]!, b = rgba[p + 2]!;
      const y = (77 * r + 150 * g + 29 * b) >> 8;
      const vCr = Math.max(0, Math.min(255, ((128 * r - 107 * g - 21 * b) >> 8) + 128));
      const vCb = Math.max(0, Math.min(255, ((-43 * r - 85 * g + 128 * b) >> 8) + 128));
      luma[i] = y; cr[i] = vCr; cb[i] = vCb;
      score[i] = this.skinScore(vCr, vCb, y, r, g, b);
      if (this.hasPrev) {
        const moved = Math.abs(y - prevLuma[i]!) > MOTION_THRESHOLD;
        const hv = history[i]!;
        history[i] = moved ? 255 : hv > 20 ? hv - 20 : 0;
        if (moved) moveCount++;
        const st = this.stable[i]!;
        this.stable[i] = moved ? 0 : st < 255 ? st + 1 : 255;
      }
      // background: learn pixels that have not changed for a while; foreground = differs from it
      const learned = this.stable[i]! > this.learnFrames;
      if (!this.bgReady[i]) {
        this.fg[i] = 1;
        if (learned) { this.bgY[i] = y; this.bgCr[i] = vCr; this.bgCb[i] = vCb; this.bgReady[i] = 1; }
      } else {
        const dY = Math.abs(y - this.bgY[i]!), dC = Math.abs(vCr - this.bgCr[i]!) + Math.abs(vCb - this.bgCb[i]!);
        const isFg = dY > 22 || dC > 12;
        this.fg[i] = isFg ? 1 : 0;
        if (isFg) fgCount++;
        if (learned) { this.bgY[i]! += (y - this.bgY[i]!) * 0.08; this.bgCr[i]! += (vCr - this.bgCr[i]!) * 0.08; this.bgCb[i]! += (vCb - this.bgCb[i]!) * 0.08; }
      }
    }
    // the camera moved or the light changed a lot: learn again
    this.busyFrames = fgCount > n * 0.55 ? this.busyFrames + 1 : 0;
    if (this.busyFrames > 45) { this.bgReady.fill(0); this.busyFrames = 0; }
    // 2. 3x3 box blur of the score (separable), then threshold. Moving pixels with a fair score are helped through.
    const tmp = this.tmp, mask = this.mask;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        tmp[i] = score[i]! + (x > 0 ? score[i - 1]! : score[i]!) + (x < w - 1 ? score[i + 1]! : score[i]!);
      }
    }
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        const sum = tmp[i]! + (y > 0 ? tmp[i - w]! : tmp[i]!) + (y < h - 1 ? tmp[i + w]! : tmp[i]!);
        const v = sum / 9;
        const skin = v > 100 || (v > 60 && history[i]! > 0);
        this.skin[i] = skin ? 1 : 0;
        const on = skin && this.fg[i] === 1;
        mask[i] = on ? 1 : 0;
        if (on) skinCount++;
      }
    }
    // 3. the face: follow it (mean shift on the mask), or look for one; then cut it out of the mask.
    this.handLabels.clear();
    if (this.faceSearch) this.trackFace();
    else this.face = null;
    const face = this.face;
    if (face) {
      const fx = face.x * w, fy = face.y * h, rx = face.rx * w * 1.12, ry = face.ry * h * 1.12;
      const x0 = Math.max(0, Math.floor(fx - rx)), x1 = Math.min(w - 1, Math.ceil(fx + rx));
      const y0 = Math.max(0, Math.floor(fy - ry)), y1 = Math.min(h - 1, Math.ceil(fy + ry * 1.6));
      for (let y = y0; y <= y1; y++) {
        // below the chin the cut narrows into the neck
        const dy = (y - fy) / ry;
        const neck = dy > 1;
        for (let x = x0; x <= x1; x++) {
          const dx = (x - fx) / rx;
          if (neck ? Math.abs(dx) < 0.55 && dy < 1.6 : dx * dx + dy * dy < 1) mask[y * w + x] = 0;
        }
      }
    }
    // 4. connected components
    const blobs = this.components();
    // 5. hands
    const hands: Blob[] = [];
    for (const b of blobs) {
      if (hands.length >= 2) break;
      const hand = this.handRegion(b);
      if (hand && hand.area >= this.minArea) hands.push(hand);
    }
    this.stillBlob(hands);
    // 6. flow
    if (this.hasPrev) this.computeFlow(); else this.flow.fill(0);
    prevLuma.set(luma); this.hasPrev = true;
    let debug: Uint8Array | undefined;
    if (wantMask) {
      debug = this.debug;
      for (let i = 0; i < n; i++) debug[i] = mask[i] ? (this.labels[i]! > 0 && this.handLabels.has(this.labels[i]!) ? 2 : 1) : 0;
      if (face) {
        const fx = face.x * w, fy = face.y * h, rx = face.rx * w, ry = face.ry * h;
        for (let a = 0; a < 64; a++) {
          const x = Math.round(fx + Math.cos(a / 64 * Math.PI * 2) * rx), y = Math.round(fy + Math.sin(a / 64 * Math.PI * 2) * ry);
          if (x >= 0 && x < w && y >= 0 && y < h) debug[y * w + x] = 3;
        }
      }
    }
    return { w, h, hands, face: face ? { ...face } : null, flow: this.flow, gw: this.gw, gh: this.gh, skin: skinCount / n, motion: moveCount / n, ms: performance.now() - t0, ...(debug ? { mask: debug } : {}) };
  }

  // --- connected components ------------------------------------------------------------------------------------

  private readonly handLabels = new Set<number>();
  private find(x: number): number {
    const parent = this.parent;
    while (parent[x] !== x) { parent[x] = parent[parent[x]!]!; x = parent[x]!; }
    return x;
  }
  private union(a: number, b: number): number {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return ra;
    if (ra < rb) { this.parent[rb] = ra; return ra; }
    this.parent[ra] = rb; return rb;
  }

  /** Blobs sorted by area (largest first), each with its bounding box. Labels stay in this.labels (root ids). */
  private components(): { label: number; area: number; x0: number; y0: number; x1: number; y1: number }[] {
    const { w, h, mask, labels, parent } = this;
    let next = 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!mask[i]) { labels[i] = 0; continue; }
        const left = x > 0 ? labels[i - 1]! : 0;
        const up = y > 0 ? labels[i - w]! : 0;
        const ul = x > 0 && y > 0 ? labels[i - w - 1]! : 0;
        const ur = x < w - 1 && y > 0 ? labels[i - w + 1]! : 0;
        let l = left || up || ul || ur;
        if (!l) { if (next >= parent.length) { labels[i] = 0; continue; } parent[next] = next; l = next++; }
        else {
          if (left && left !== l) l = this.union(l, left);
          if (up && up !== l) l = this.union(l, up);
          if (ul && ul !== l) l = this.union(l, ul);
          if (ur && ur !== l) l = this.union(l, ur);
        }
        labels[i] = l;
      }
    }
    const stats = new Map<number, { label: number; area: number; x0: number; y0: number; x1: number; y1: number }>();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!labels[i]) continue;
        const r = this.find(labels[i]!);
        labels[i] = r;
        let s = stats.get(r);
        if (!s) { s = { label: r, area: 0, x0: x, y0: y, x1: x, y1: y }; stats.set(r, s); }
        s.area++;
        if (x < s.x0) s.x0 = x; if (x > s.x1) s.x1 = x;
        if (y > s.y1) s.y1 = y;
      }
    }
    const minPixels = this.minArea * this.n * 0.6;
    // A blob covering most of the frame is a skin-coloured wall or a lens cap, not a hand.
    const maxPixels = this.n * 0.45;
    return [...stats.values()].filter((s) => s.area >= minPixels && s.area <= maxPixels).sort((a, b) => b.area - a.area);
  }

  private readonly spanMin = new Int32Array(1024);
  private readonly spanMax = new Int32Array(1024);

  /**
   * The top end of a blob down to the wrist: a raised hand on an arm. Row spans (leftmost to rightmost pixel)
   * stay wide through spread fingers and the palm, then narrow at the wrist.
   */
  private handRegion(b: { label: number; area: number; x0: number; y0: number; x1: number; y1: number }): Blob | null {
    const { w, h, labels, history, spanMin, spanMax } = this;
    const bh = b.y1 - b.y0 + 1;
    let maxSpan = 0, end = b.y1, below = 0;
    for (let y = b.y0; y <= b.y1 && y - b.y0 < spanMin.length; y++) {
      let lo = w, hi = -1;
      for (let x = b.x0; x <= b.x1; x++) if (labels[y * w + x] === b.label) { if (x < lo) lo = x; hi = x; }
      spanMin[y - b.y0] = lo; spanMax[y - b.y0] = hi;
      const span = hi >= lo ? hi - lo + 1 : 0;
      if (span > maxSpan) { maxSpan = span; below = 0; }
      const depth = y - b.y0 + 1;
      // past most of a hand's length, a clearly narrower stretch is the wrist
      if (depth > maxSpan * 0.7 && span < maxSpan * 0.74) { if (++below >= 2) { end = y - 2; break; } }
      else below = 0;
      if (depth >= Math.round(maxSpan * 1.7) + 2) { end = y; break; }
    }
    const handLen = Math.max(3, Math.min(bh, end - b.y0 + 1));
    const yEnd = b.y0 + handLen - 1;
    let area = 0, sx = 0, sy = 0, perim = 0, moving = 0, minX = w, maxX = 0, tipSum = 0, tipCount = 0;
    for (let y = b.y0; y <= yEnd; y++) {
      const lo = spanMin[y - b.y0]!, hi = spanMax[y - b.y0]!;
      for (let x = lo; x <= hi; x++) {
        const i = y * w + x;
        if (labels[i] !== b.label) continue;
        area++; sx += x; sy += y;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (history[i]! > 0) moving++;
        const edge = x === 0 || x === w - 1 || y === 0 || y === h - 1
          || labels[i - 1] !== b.label || labels[i + 1] !== b.label || labels[i - w] !== b.label || (y < yEnd && labels[i + w] !== b.label);
        if (edge) perim++;
        if (y <= b.y0 + 1) { tipSum += x; tipCount++; }
      }
    }
    if (!area) return null;
    this.handLabels.add(b.label);
    const rw = maxX - minX + 1;
    const fill = area / (rw * handLen);
    const compact = Math.min(1, (4 * Math.PI * area) / Math.max(1, perim * perim));
    return {
      x: (sx / area + 0.5) / w, y: (sy / area + 0.5) / h,
      area: area / this.n, blobArea: b.area / this.n,
      w: rw / w, h: handLen / h, fill, compact, aspect: handLen / rw,
      tipX: tipCount ? (tipSum / tipCount + 0.5) / w : (sx / area + 0.5) / w, tipY: (b.y0 + 0.5) / h,
      motion: moving / area,
    };
  }

  // --- face ----------------------------------------------------------------------------------------------------

  private frameIndex = 0;
  /** a region the face search must not use (the calibration box, for a moment) */
  private avoid: { x0: number; y0: number; x1: number; y1: number; until: number } | null = null;
  /** off: the per-pixel background replaced the "still blob is the face" fallback */
  stillFallback = false;
  /** a hand-sized blob that has not moved: after ~2 s in the middle it is taken to be the face */
  private still: { x: number; y: number; frames: number } | null = null;

  private trackFace(): void {
    const { w, h } = this;
    const mask = this.skin;
    this.frameIndex++;
    if (this.face) {
      // Mean shift: move the ellipse to the centroid of the skin inside it, two short iterations.
      const f = this.face;
      let fill = 0;
      for (let iter = 0; iter < 2; iter++) {
        const fx = f.x * w, fy = f.y * h, rx = f.rx * w, ry = f.ry * h;
        let sx = 0, sy = 0, count = 0, total = 0;
        const x0 = Math.max(0, Math.floor(fx - rx)), x1 = Math.min(w - 1, Math.ceil(fx + rx));
        const y0 = Math.max(0, Math.floor(fy - ry)), y1 = Math.min(h - 1, Math.ceil(fy + ry));
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const dx = (x - fx) / rx, dy = (y - fy) / ry;
          if (dx * dx + dy * dy > 1) continue;
          total++;
          if (mask[y * w + x]) { sx += x; sy += y; count++; }
        }
        fill = total ? count / total : 0;
        if (count < 8) break;
        f.x += ((sx / count + 0.5) / w - f.x) * 0.5;
        f.y += ((sy / count + 0.5) / h - f.y) * 0.5;
      }
      // the ellipse empties when the face leaves (or it was really a hand that moved on): look again after ~1 s
      this.faceWeak = fill < 0.3 ? this.faceWeak + 1 : 0;
      if (this.faceWeak > 30) { this.face = null; this.faceWeak = 0; }
      return;
    }
    // Search only in the first seconds after the camera starts (a person faces the camera, hands down). After that
    // the learned background removes a still face anyway, and a hand held still must never become "the face".
    if (this.frameIndex > 140 || this.frameIndex % 3) return;
    // Look for a face: a large, well-filled skin ellipse near the top middle with background around its upper half,
    // not moving much, that stays put for a few searches.
    const { history } = this;
    const x0 = Math.floor(w * 0.18), x1 = Math.ceil(w * 0.82), y1 = Math.ceil(h * 0.75);
    const avoid = this.avoid && this.frameIndex < this.avoid.until ? this.avoid : null;
    let best: { x: number; y: number; rx: number; ry: number; score: number } | null = null;
    const sizes = [0.16, 0.22, 0.28, 0.36, 0.44];
    for (let si = 0; si < sizes.length; si++) {
      const rx = sizes[si]! * w / 2, ry = rx * 1.3;
      if (ry * 2 > h * 0.95) continue;
      const step = Math.max(3, Math.round(rx / 3));
      for (let cy = ry; cy < y1 - ry * 0.3; cy += step) {
        for (let cx = x0 + rx * 0.5; cx < x1 - rx * 0.5; cx += step) {
          if (avoid && cx / w > avoid.x0 - 0.05 && cx / w < avoid.x1 + 0.05 && cy / h > avoid.y0 - 0.05 && cy / h < avoid.y1 + 0.05) continue;
          let inside = 0, on = 0, ring = 0, ringOn = 0, moving = 0;
          const sstep = Math.max(1, Math.round(rx / 6));
          for (let y = Math.max(0, Math.floor(cy - ry * 1.25)); y <= Math.min(h - 1, cy + ry * 1.25); y += sstep) {
            for (let x = Math.max(0, Math.floor(cx - rx * 1.25)); x <= Math.min(w - 1, cx + rx * 1.25); x += sstep) {
              const dx = (x - cx) / rx, dy = (y - cy) / ry, d = dx * dx + dy * dy;
              const i = y * w + x;
              if (d < 1) { inside++; if (mask[i]) { on++; if (history[i]! > 120) moving++; } }
              else if (d < 1.56 && dy < 0.6) { ring++; if (mask[i]) ringOn++; }
            }
          }
          if (inside < 6 || on / inside < 0.7 || moving / Math.max(1, on) > 0.3) continue;
          // bigger windows that still fill well win (a face is usually the biggest steady skin region)
          const score = on / inside - 0.8 * (ring ? ringOn / ring : 0) + si * 0.04;
          if (!best || score > best.score) best = { x: (cx + 0.5) / w, y: (cy + 0.5) / h, rx: rx / w, ry: ry / h, score };
        }
      }
    }
    if (!best || best.score < 0.42) { this.faceCandidate = null; return; }
    const c = this.faceCandidate;
    if (c && Math.abs(c.x - best.x) < 0.06 && Math.abs(c.y - best.y) < 0.06) {
      c.frames++; c.x += (best.x - c.x) * 0.3; c.y += (best.y - c.y) * 0.3; c.rx = Math.max(c.rx, best.rx); c.ry = Math.max(c.ry, best.ry);
      if (c.frames >= 4) this.setFace({ x: c.x, y: c.y, rx: c.rx, ry: c.ry });
    } else this.faceCandidate = { ...best, frames: 1 };
  }

  /** Fallback: a hand-sized blob in the middle that has not moved for ~2 s is the face (it heals if wrong). */
  private stillBlob(hands: Blob[]): void {
    // retired: the per-pixel background now removes a still face, and a held hand must stay a hand
    if (this.face || !this.faceSearch || !this.stillFallback) { this.still = null; return; }
    const avoid = this.avoid && this.frameIndex < this.avoid.until ? this.avoid : null;
    const b = hands.find((hand) => hand.motion < 0.15 && hand.x > 0.2 && hand.x < 0.8 && hand.y < 0.7
      && !(avoid && hand.x > avoid.x0 - 0.05 && hand.x < avoid.x1 + 0.05 && hand.y > avoid.y0 - 0.05 && hand.y < avoid.y1 + 0.05));
    if (!b) { this.still = null; return; }
    const s = this.still;
    if (s && Math.abs(s.x - b.x) < 0.03 && Math.abs(s.y - b.y) < 0.03) {
      if (++s.frames >= 60) this.setFace({ x: b.x, y: b.y, rx: b.w * 0.55, ry: b.h * 0.55 });
    } else this.still = { x: b.x, y: b.y, frames: 1 };
  }

  /** Forget the face (a new calibration or camera). */
  resetFace(): void { this.setFace(null); }

  /** A face the page knows about, or null to search again. */
  setFace(face: Face | null): void { this.face = face; this.faceCandidate = null; this.faceWeak = 0; this.still = null; }

  // --- flow ----------------------------------------------------------------------------------------------------

  /** One Lucas-Kanade solve per 8x8 cell on luma: image widths per frame, plus motion energy. */
  private computeFlow(): void {
    const { w, gw, gh, luma, prevLuma, history, flow } = this;
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        let sxx = 0, syy = 0, sxy = 0, sxt = 0, syt = 0, energy = 0;
        const x0 = gx * CELL, y0 = gy * CELL;
        for (let y = y0 + 1; y < y0 + CELL - 1; y++) {
          for (let x = x0 + 1; x < x0 + CELL - 1; x++) {
            const i = y * w + x;
            const ix = (luma[i + 1]! - luma[i - 1]! + prevLuma[i + 1]! - prevLuma[i - 1]!) * 0.25;
            const iy = (luma[i + w]! - luma[i - w]! + prevLuma[i + w]! - prevLuma[i - w]!) * 0.25;
            const it = luma[i]! - prevLuma[i]!;
            sxx += ix * ix; syy += iy * iy; sxy += ix * iy; sxt += ix * it; syt += iy * it;
            if (history[i]! > 200) energy++;
          }
        }
        const det = sxx * syy - sxy * sxy;
        let vx = 0, vy = 0;
        const e = energy / ((CELL - 2) * (CELL - 2));
        if (det > 400 && e > 0.04) {
          vx = (-syy * sxt + sxy * syt) / det;
          vy = (sxy * sxt - sxx * syt) / det;
          const mag = Math.hypot(vx, vy);
          if (mag > 4) { vx *= 4 / mag; vy *= 4 / mag; }
        }
        const k = (gy * gw + gx) * 3;
        // smooth in time a little (flow is noisy)
        flow[k] = flow[k]! * 0.4 + (vx / w) * 0.6;
        flow[k + 1] = flow[k + 1]! * 0.4 + (vy / this.h) * 0.6;
        flow[k + 2] = flow[k + 2]! * 0.5 + e * 0.5;
      }
    }
  }

  // --- calibration ---------------------------------------------------------------------------------------------

  private calib: { box: { x0: number; y0: number; x1: number; y1: number }; crHist: Uint32Array; cbHist: Uint32Array; samples: number[]; frames: number; need: number } | null = null;

  startCalibration(box: { x0: number; y0: number; x1: number; y1: number }, frames = 12): void {
    // the palm in the box is steady and skin-coloured: keep the face search away from it for a few seconds
    this.avoid = { ...box, until: this.frameIndex + 150 };
    if (this.face && this.face.x > box.x0 && this.face.x < box.x1 && this.face.y > box.y0 && this.face.y < box.y1) this.setFace(null);
    this.calib = { box, crHist: new Uint32Array(256), cbHist: new Uint32Array(256), samples: [], frames: 0, need: frames };
  }
  get calibrating(): boolean { return !!this.calib; }

  /** Feed a frame while calibrating; returns the result on the last frame. Uses the chroma of the previous process(). */
  calibrateFrame(rgba: Uint8ClampedArray | Uint8Array): CalibrationResult | null {
    const c = this.calib;
    if (!c) return null;
    const { w, h } = this;
    const x0 = Math.max(0, Math.floor(c.box.x0 * w)), x1 = Math.min(w - 1, Math.ceil(c.box.x1 * w));
    const y0 = Math.max(0, Math.floor(c.box.y0 * h)), y1 = Math.min(h - 1, Math.ceil(c.box.y1 * h));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const p = (y * w + x) * 4;
      const r = rgba[p]!, g = rgba[p + 1]!, b = rgba[p + 2]!;
      const yy = (77 * r + 150 * g + 29 * b) >> 8;
      if (yy < 40 || yy > 245) continue;
      const vCr = Math.max(0, Math.min(255, ((128 * r - 107 * g - 21 * b) >> 8) + 128));
      const vCb = Math.max(0, Math.min(255, ((-43 * r - 85 * g + 128 * b) >> 8) + 128));
      c.crHist[vCr]!++; c.cbHist[vCb]!++;
      if (c.samples.length < 24000) c.samples.push(vCr, vCb);
    }
    if (++c.frames < c.need) return null;
    this.calib = null;
    const count = c.samples.length / 2;
    if (count < 120) return { ok: false, model: this.model, samples: count, area: 0, message: 'The box was too dark or too bright. Add some light and try again.' };
    const median = (hist: Uint32Array) => { let acc = 0; for (let i = 0; i < 256; i++) { acc += hist[i]!; if (acc >= count / 2) return i; } return 128; };
    const mCr0 = median(c.crHist), mCb0 = median(c.cbHist);
    // spread from the median absolute deviation, then a covariance from the inliers
    const devCr: number[] = [], devCb: number[] = [];
    for (let i = 0; i < c.samples.length; i += 2) { devCr.push(Math.abs(c.samples[i]! - mCr0)); devCb.push(Math.abs(c.samples[i + 1]! - mCb0)); }
    devCr.sort((a, b) => a - b); devCb.sort((a, b) => a - b);
    const madCr = Math.max(2, 1.4826 * devCr[devCr.length >> 1]!), madCb = Math.max(2, 1.4826 * devCb[devCb.length >> 1]!);
    let n = 0, sr = 0, sb = 0, srr = 0, sbb = 0, srb = 0;
    for (let i = 0; i < c.samples.length; i += 2) {
      const r = c.samples[i]!, b = c.samples[i + 1]!;
      if (Math.abs(r - mCr0) > 2.5 * madCr || Math.abs(b - mCb0) > 2.5 * madCb) continue;
      n++; sr += r; sb += b; srr += r * r; sbb += b * b; srb += r * b;
    }
    if (n < 80) return { ok: false, model: this.model, samples: count, area: 0, message: 'Hold your palm so it fills the box, then try again.' };
    const mr = sr / n, mb = sb / n;
    const vr = srr / n - mr * mr, vb = sbb / n - mb * mb, cv = srb / n - mr * mb;
    const sCr = Math.min(18, Math.max(6, Math.sqrt(Math.max(0, vr)) * 1.8));
    const sCb = Math.min(18, Math.max(6, Math.sqrt(Math.max(0, vb)) * 1.8));
    const rho = Math.max(-0.8, Math.min(0.8, cv / Math.max(1e-6, Math.sqrt(Math.max(1e-6, vr * vb)))));
    const inliers = n / count;
    const skinish = mr > 128 && mb < 135;
    this.model = skinModelFrom(mr, mb, sCr, sCb, rho, 7);
    this.calibrated = true;
    return {
      ok: true, model: this.model, samples: count, area: 0,
      message: inliers < 0.5 ? 'Calibrated, but the box held mixed colours. If tracking is patchy, fill the box with your palm and calibrate again.'
        : !skinish ? 'Calibrated to an unusual colour (strong coloured light?). Tracking follows that colour now.'
        : 'Calibrated to your skin and this light.',
    };
  }

  resetModel(): void { this.model = DEFAULT_SKIN; this.calibrated = false; }
  /** Forget the learned background (the camera was moved or switched). */
  resetBackground(): void { this.bgReady.fill(0); this.stable.fill(0); this.frameIndex = 0; }
}
