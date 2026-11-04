/**
 * Main-thread side of webcam hand tracking: grabs small frames from the <video>, runs the Worker
 * (vision.worker.ts, classic computer vision), turns blobs into two steady hands on the screen and then into the
 * same `Signals` the Quest's hand programs read. Touch or mouse can stand in for a hand.
 *
 * Coordinates here are display coordinates: 0..1 across the visible stage (mirrored for the front camera),
 * y down. The stage shows the camera "cover"-fitted, so `view` maps between the camera image and the screen.
 */
import type { HandSignals, ScreenSignals, Signals } from '../gestures/signals';
import type { Blob, CalibrationResult, Face, VisionResult } from './vision';

export type Side = 'left' | 'right';

export interface TrackedHand {
  side: Side;
  /** display 0..1, y down */
  x: number; y: number;
  /** apparent size: hand-region area as a fraction of the camera frame (touch: a fixed value) */
  area: number;
  /** display-space radius of the hand, 0..1 of the stage height */
  radius: number;
  /** 0 open .. 1 closed (approximate) */
  closed: number;
  fist: boolean;
  /** display units per second */
  vx: number; vy: number; speed: number;
  /** false while the hand is briefly lost (last value held) */
  seen: boolean;
  source: 'camera' | 'touch';
  /** ms (performance.now) of the last sighting */
  at: number;
}

export interface CameraView {
  /** video size */
  vw: number; vh: number;
  /** stage size */
  sw: number; sh: number;
  mirror: boolean;
}

/** Which part of the camera image is visible on each axis when the stage covers the screen. */
export function coverScale(v: CameraView): { sx: number; sy: number } {
  const va = v.vw / Math.max(1, v.vh), ca = v.sw / Math.max(1, v.sh);
  return ca > va ? { sx: 1, sy: va / ca } : { sx: ca / va, sy: 1 };
}
export function imageToDisplay(v: CameraView, ix: number, iy: number): { x: number; y: number } {
  const { sx, sy } = coverScale(v);
  const mx = v.mirror ? 1 - ix : ix;
  return { x: (mx - 0.5) / sx + 0.5, y: (iy - 0.5) / sy + 0.5 };
}
export function displayToImage(v: CameraView, x: number, y: number): { x: number; y: number } {
  const { sx, sy } = coverScale(v);
  const mx = (x - 0.5) * sx + 0.5;
  return { x: v.mirror ? 1 - mx : mx, y: (y - 0.5) * sy + 0.5 };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** One Euro filter (Casiez et al. 2012): little lag when moving fast, little jitter when still. */
export class OneEuro {
  private t = -Infinity; private x = 0; private dx = 0;
  constructor(private readonly minCutoff = 1.5, private readonly beta = 0.6, private readonly dCutoff = 1.2) {}
  reset(): void { this.t = -Infinity; }
  get value(): number { return this.x; }
  update(value: number, timeMs: number): number {
    const dt = (timeMs - this.t) / 1000;
    if (!Number.isFinite(this.t) || dt <= 0 || dt > 0.4) { this.t = timeMs; this.x = value; this.dx = 0; return value; }
    const a = (cut: number) => 1 / (1 + 1 / (2 * Math.PI * cut * dt));
    const rawDx = (value - this.x) / dt;
    this.dx += (rawDx - this.dx) * a(this.dCutoff);
    this.x += (value - this.x) * a(this.minCutoff + this.beta * Math.abs(this.dx));
    this.t = timeMs;
    return this.x;
  }
}

/** Open-palm shape measured at calibration (fill, compactness, height/width) and its apparent size. */
export interface HandReference { area: number; fill: number; compact: number; aspect: number }
export const DEFAULT_REFERENCE: HandReference = { area: 0.03, fill: 0.64, compact: 0.6, aspect: 1.12 };

/** 0 open .. 1 closed from the hand region's shape, relative to the open palm seen at calibration. */
export function closedness(b: Pick<Blob, 'fill' | 'compact' | 'aspect'>, ref: HandReference = DEFAULT_REFERENCE): number {
  const shorter = clamp01((ref.aspect - b.aspect) / Math.max(0.15, ref.aspect * 0.3));
  const fuller = clamp01((b.fill - ref.fill) / Math.max(0.08, 0.86 - ref.fill));
  const rounder = clamp01((b.compact - ref.compact) / Math.max(0.1, 0.9 - ref.compact));
  return clamp01(0.45 * shorter + 0.33 * fuller + 0.22 * rounder);
}

class HandFilter {
  readonly x = new OneEuro(1.4, 1.1);
  readonly y = new OneEuro(1.4, 1.1);
  readonly area = new OneEuro(1.0, 0.4);
  readonly closed = new OneEuro(2.5, 0.2);
  state: TrackedHand | null = null;
  fist = false;
  private lastX = 0; private lastY = 0; private lastT = -Infinity;
  vx = 0; vy = 0;
  reset(): void { this.x.reset(); this.y.reset(); this.area.reset(); this.closed.reset(); this.state = null; this.fist = false; this.lastT = -Infinity; this.vx = this.vy = 0; }
  update(side: Side, x: number, y: number, area: number, radius: number, closed: number, t: number, source: TrackedHand['source']): TrackedHand {
    const fx = this.x.update(x, t), fy = this.y.update(y, t), fa = this.area.update(area, t), fc = clamp01(this.closed.update(closed, t));
    const dt = (t - this.lastT) / 1000;
    if (Number.isFinite(this.lastT) && dt > 0 && dt < 0.3) {
      const k = 1 - Math.exp(-dt / 0.06);
      this.vx += ((fx - this.lastX) / dt - this.vx) * k;
      this.vy += ((fy - this.lastY) / dt - this.vy) * k;
    } else { this.vx = 0; this.vy = 0; }
    this.lastX = fx; this.lastY = fy; this.lastT = t;
    this.fist = this.fist ? fc > 0.5 : fc > 0.68;
    this.state = { side, x: fx, y: fy, area: fa, radius, closed: fc, fist: this.fist, vx: this.vx, vy: this.vy, speed: Math.hypot(this.vx, this.vy), seen: true, source, at: t };
    return this.state;
  }
}

/** Pinch-tap for webcam hands: a quick close-and-open of the hand that barely moves. */
class TapDetector {
  private closedAt = -Infinity; private ox = 0; private oy = 0; private valid = false; private wasClosed = false; private lastTap = -Infinity;
  update(h: TrackedHand | null, t: number): boolean {
    if (!h) { this.wasClosed = false; this.valid = false; return false; }
    let tap = false;
    if (h.fist && !this.wasClosed) { this.closedAt = t; this.ox = h.x; this.oy = h.y; this.valid = t - this.lastTap > 250; }
    else if (h.fist && (Math.hypot(h.x - this.ox, h.y - this.oy) > 0.07 || t - this.closedAt > 450)) this.valid = false;
    else if (!h.fist && this.wasClosed) { if (this.valid && t - this.closedAt <= 450) { tap = true; this.lastTap = t; } this.valid = false; }
    this.wasClosed = h.fist;
    return tap;
  }
}

export interface TrackerStats { fps: number; workerMs: number; frames: number; hands: number; face: boolean; skin: number; motion: number; size: string }

export interface TrackerOptions {
  /** processing width in pixels (height follows the camera's aspect) */
  width: number;
  onResult?(r: VisionResult, hands: TrackedHand[]): void;
  onCalibrated?(r: CalibrationResult, ref: HandReference | null): void;
}

export class HandTracker {
  private worker?: Worker;
  private readonly canvas = document.createElement('canvas');
  private ctx?: CanvasRenderingContext2D;
  private busy = false;
  private seq = 0;
  private video?: HTMLVideoElement;
  private frameHandle = 0;
  private lastGrab = 0;
  private running = false;
  private readonly filters: Record<Side, HandFilter> = { left: new HandFilter(), right: new HandFilter() };
  private readonly taps: Record<Side, TapDetector> = { left: new TapDetector(), right: new TapDetector() };
  private readonly touch = new Map<number, { side: Side; x: number; y: number; down: boolean; at: number; filter: HandFilter }>();
  private readonly screenV = { u: new OneEuro(3, 4), v: new OneEuro(3, 4), lu: 0, lv: 0, lt: -Infinity, vu: 0, vv: 0 };
  private startedAt = performance.now();
  private lastSignalsAt = -Infinity;
  private fpsWindow: number[] = [];
  view: CameraView = { vw: 640, vh: 480, sw: 1, sh: 1, mirror: true };
  reference: HandReference = { ...DEFAULT_REFERENCE };
  /** the worker sends its label mask every frame: the hand outline and the debug view use it */
  wantMask = true;
  /** the camera is on (otherwise the mouse can hover as a hand) */
  cameraOn = false;
  last?: VisionResult;
  readonly stats: TrackerStats = { fps: 0, workerMs: 0, frames: 0, hands: 0, face: false, skin: 0, motion: 0, size: '' };
  /** calibration box in display coordinates while calibrating */
  calibrationBox: { x0: number; y0: number; x1: number; y1: number } | null = null;

  constructor(private readonly opts: TrackerOptions) {}

  start(video: HTMLVideoElement, mirror: boolean, faceSearch = true): void {
    this.stop();
    this.video = video; this.view.mirror = mirror; this.running = true; this.cameraOn = true;
    if (!this.worker) {
      this.worker = new Worker(new URL('./vision.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this.onMessage(e.data);
      this.worker.onerror = (e) => { console.warn('[hands] vision worker error', e.message); this.busy = false; };
    }
    this.worker.postMessage({ type: 'face', search: faceSearch, face: null });
    // a new (or switched) camera: learn its background from scratch
    this.worker.postMessage({ type: 'reset-background' });
    this.schedule();
  }

  stop(): void {
    this.running = false; this.cameraOn = false;
    const v = this.video as (HTMLVideoElement & { cancelVideoFrameCallback?(h: number): void }) | undefined;
    if (v?.cancelVideoFrameCallback && this.frameHandle) v.cancelVideoFrameCallback(this.frameHandle);
    cancelAnimationFrame(this.frameHandle);
    this.frameHandle = 0;
    for (const f of Object.values(this.filters)) f.reset();
  }

  dispose(): void { this.stop(); this.worker?.terminate(); this.worker = undefined; }

  private schedule(): void {
    if (!this.running || !this.video) return;
    const v = this.video as HTMLVideoElement & { requestVideoFrameCallback?(cb: () => void): number };
    if (v.requestVideoFrameCallback) this.frameHandle = v.requestVideoFrameCallback(() => { this.grab(); this.schedule(); });
    else this.frameHandle = requestAnimationFrame(() => { this.grab(); this.schedule(); });
  }

  private grab(): void {
    const v = this.video;
    if (!v || this.busy || !this.worker || v.readyState < 2 || !v.videoWidth) return;
    const now = performance.now();
    if (now - this.lastGrab < 30) return; // at most ~33 frames a second
    this.lastGrab = now;
    this.view.vw = v.videoWidth; this.view.vh = v.videoHeight;
    const w = this.opts.width, h = Math.max(48, Math.round((w * v.videoHeight / v.videoWidth) / 8) * 8);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; this.ctx = undefined; }
    this.ctx ??= this.canvas.getContext('2d', { willReadFrequently: true }) ?? undefined;
    if (!this.ctx) return;
    this.ctx.drawImage(v, 0, 0, w, h);
    const data = this.ctx.getImageData(0, 0, w, h).data;
    this.busy = true;
    this.worker.postMessage({ type: 'frame', w, h, buffer: data.buffer, mask: this.wantMask, seq: ++this.seq }, [data.buffer]);
    this.stats.size = `${w}×${h}`;
  }

  private onMessage(m: { type: string; result: VisionResult; calibration: CalibrationResult | null }): void {
    if (m.type !== 'result') return;
    this.busy = false;
    if (!this.running) return;
    const now = performance.now();
    const r = m.result;
    this.last = r;
    this.fpsWindow.push(now); while (this.fpsWindow.length && now - this.fpsWindow[0]! > 1000) this.fpsWindow.shift();
    Object.assign(this.stats, { fps: this.fpsWindow.length, workerMs: this.stats.workerMs * 0.9 + r.ms * 0.1, frames: this.stats.frames + 1, hands: r.hands.length, face: !!r.face, skin: r.skin, motion: r.motion });
    this.assign(r.hands, now);
    if (m.calibration) this.finishCalibration(m.calibration);
    this.afterResult(r);
    this.opts.onResult?.(r, this.cameraHands());
  }

  /** Blobs -> left/right hands on the screen (the mirrored view: your right hand is on the right). */
  private assign(blobs: Blob[], t: number): void {
    const seen = blobs.map((b) => ({ b, d: imageToDisplay(this.view, b.x, b.y) }))
      .filter((c) => c.d.x > -0.05 && c.d.x < 1.05 && c.d.y > -0.05 && c.d.y < 1.05);
    const assigned: Partial<Record<Side, (typeof seen)[number]>> = {};
    if (seen.length >= 2) {
      const [a, b] = seen[0]!.d.x <= seen[1]!.d.x ? [seen[0]!, seen[1]!] : [seen[1]!, seen[0]!];
      assigned.left = a; assigned.right = b;
    } else if (seen.length === 1) {
      const c = seen[0]!;
      const live = (s: Side) => { const st = this.filters[s].state; return st && t - st.at < 450 ? st : null; };
      const l = live('left'), r = live('right');
      if (l && r) assigned[Math.hypot(l.x - c.d.x, l.y - c.d.y) < Math.hypot(r.x - c.d.x, r.y - c.d.y) ? 'left' : 'right'] = c;
      else if (l && Math.hypot(l.x - c.d.x, l.y - c.d.y) < 0.3) assigned.left = c;
      else if (r && Math.hypot(r.x - c.d.x, r.y - c.d.y) < 0.3) assigned.right = c;
      else assigned[c.d.x < 0.5 ? 'left' : 'right'] = c;
    }
    const { sy } = coverScale(this.view);
    for (const side of ['left', 'right'] as const) {
      const c = assigned[side];
      const f = this.filters[side];
      if (c) {
        // radius on screen (stage-height units): the hand region's height, through the cover crop
        const radius = Math.max(0.03, (c.b.h / sy) * 0.55);
        f.update(side, c.d.x, c.d.y, c.b.area, radius, closedness(c.b, this.reference), t, 'camera');
      } else if (f.state && t - f.state.at > 260) f.reset();
      else if (f.state) f.state = { ...f.state, seen: false };
    }
  }

  cameraHands(): TrackedHand[] {
    const out: TrackedHand[] = [];
    for (const side of ['left', 'right'] as const) { const s = this.filters[side].state; if (s) out.push(s); }
    return out;
  }

  // --- touch / mouse stand-in -----------------------------------------------------------------------------------

  pointer(id: number, kind: string, x: number, y: number, down: boolean, gone = false): void {
    const t = performance.now();
    if (gone || (!down && (kind !== 'mouse' || this.cameraOn))) { this.touch.delete(id); return; }
    let p = this.touch.get(id);
    if (!p) {
      const taken = new Set([...this.touch.values()].map((q) => q.side));
      const side: Side = !taken.has('right') ? 'right' : 'left';
      if (taken.has(side)) return;
      p = { side, x, y, down, at: t, filter: new HandFilter() };
      this.touch.set(id, p);
    }
    p.x = x; p.y = y; p.down = down; p.at = t;
  }

  private touchHands(t: number): TrackedHand[] {
    const out: TrackedHand[] = [];
    for (const [id, p] of this.touch) {
      if (!p.down && t - p.at > 1500) { this.touch.delete(id); continue; }
      out.push(p.filter.update(p.side, p.x, p.y, this.reference.area, 0.06, p.down ? 1 : 0, t, 'touch'));
    }
    return out;
  }

  /** Every hand the page should show and feed to programs: touch wins for its side. */
  hands(t = performance.now()): TrackedHand[] {
    const touch = this.touchHands(t);
    const bySide = new Map<Side, TrackedHand>();
    for (const h of this.cameraHands()) bySide.set(h.side, h);
    for (const h of touch) bySide.set(h.side, h);
    return [...bySide.values()];
  }

  // --- signals for Muse's hand programs --------------------------------------------------------------------------

  resetSignals(): void { this.startedAt = performance.now(); this.lastSignalsAt = -Infinity; }

  /**
   * The Quest `Signals` shape from webcam (or touch) hands. `withScreen`: the visuals fill the stage behind your
   * hands, so the stage is the "screen": u/v is where your hand is on it and a closed hand is a touch.
   */
  signals(withScreen: boolean, t = performance.now()): Signals {
    const dt = Number.isFinite(this.lastSignalsAt) ? Math.min(0.1, Math.max(0, (t - this.lastSignalsAt) / 1000)) : 1 / 60;
    this.lastSignalsAt = t;
    const hands = this.hands(t);
    const get = (side: Side) => hands.find((h) => h.side === side) ?? null;
    const sig = (h: TrackedHand | null, side: Side): HandSignals | null => {
      const tap = this.taps[side].update(h, t);
      if (!h) return null;
      return {
        height: clamp01((0.92 - h.y) / 0.84),
        side: clamp01((h.x - 0.08) / 0.84),
        push: h.source === 'touch' ? 0.5 : clamp01(0.5 + 1.2 * (Math.sqrt(h.area / Math.max(1e-4, this.reference.area)) - 1)),
        pinch: h.closed,
        pinchTap: tap,
        fist: h.fist, open: h.closed < 0.32, palmOut: false,
        // display widths per second; a webcam view is roughly a metre wide at arm's length
        speed: h.speed * 0.9,
      };
    };
    const right = sig(get('right'), 'right'), left = sig(get('left'), 'left');
    let screen: ScreenSignals | null = null;
    const lead = get('right') ?? get('left');
    if (withScreen && lead) {
      const sv = this.screenV;
      const u = clamp01(sv.u.update(lead.x, t)), v = clamp01(sv.v.update(lead.y, t));
      const sdt = (t - sv.lt) / 1000;
      if (Number.isFinite(sv.lt) && sdt > 0 && sdt < 0.3) { const k = 1 - Math.exp(-sdt / 0.04); sv.vu += ((u - sv.lu) / sdt - sv.vu) * k; sv.vv += ((v - sv.lv) / sdt - sv.vv) * k; }
      else { sv.vu = 0; sv.vv = 0; }
      sv.lu = u; sv.lv = v; sv.lt = t;
      const inside = lead.x >= 0 && lead.x <= 1 && lead.y >= 0 && lead.y <= 1;
      // no depth from one webcam: closing the hand is the "touch"; an open hand hovers
      const distance = lead.fist ? 0 : 0.03 + (1 - lead.closed) * 0.1;
      screen = { u, v, inside, distance, touching: inside && lead.fist, hover: lead.fist ? 1 : clamp01((0.15 - distance) / 0.13), vu: sv.vu, vv: sv.vv, hand: lead.side };
    } else { this.screenV.u.reset(); this.screenV.v.reset(); this.screenV.lt = -Infinity; }
    return { t: Math.max(0, (t - this.startedAt) / 1000), dt, right, left, screen };
  }

  // --- calibration ------------------------------------------------------------------------------------------------

  /** Refit the skin model to the palm inside `box` (display coordinates). */
  calibrate(box: { x0: number; y0: number; x1: number; y1: number }): void {
    if (!this.worker) return;
    this.calibrationBox = box;
    const a = displayToImage(this.view, box.x0, box.y0), b = displayToImage(this.view, box.x1, box.y1);
    this.worker.postMessage({ type: 'calibrate', box: { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) } });
  }

  private pendingCalibration?: CalibrationResult;
  private finishCalibration(c: CalibrationResult): void {
    this.pendingCalibration = c;
    // The next frame is processed with the new model: measure the palm in the box then.
    this.measureNext = 2;
  }
  private measureNext = 0;

  /** After each result: once the new model is in use, the palm in the box becomes the open-hand reference. */
  private afterResult(r: VisionResult): void {
    if (!this.measureNext || !this.pendingCalibration) return;
    if (--this.measureNext > 0) return;
    const box = this.calibrationBox;
    const c = this.pendingCalibration;
    this.pendingCalibration = undefined; this.calibrationBox = null;
    let ref: HandReference | null = null;
    if (c.ok && box) {
      const inBox = r.hands.map((b) => ({ b, d: imageToDisplay(this.view, b.x, b.y) }))
        .find(({ d }) => d.x > box.x0 - 0.05 && d.x < box.x1 + 0.05 && d.y > box.y0 - 0.08 && d.y < box.y1 + 0.08);
      if (inBox) {
        ref = { area: Math.max(0.004, inBox.b.area), fill: inBox.b.fill, compact: inBox.b.compact, aspect: inBox.b.aspect };
        this.reference = ref;
      }
    }
    this.opts.onCalibrated?.(c, ref);
  }

  resetCalibration(): void {
    this.reference = { ...DEFAULT_REFERENCE };
    this.worker?.postMessage({ type: 'reset-model' });
  }

  setFace(search: boolean, face?: Face | null): void { this.worker?.postMessage({ type: 'face', search, ...(face !== undefined ? { face } : {}) }); }
}
