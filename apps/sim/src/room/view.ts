/**
 * The room camera in the browser: loads the light layers of a view, develops them for the lamp's current
 * (fading) state into a 1280x960 canvas, captures JPEG frames for scan.frame / sense.result, and draws the
 * SAM detections that come back in scan.result.
 */
import type { Pose, ScanResultPayload } from '@ce/protocol';
import { applyVignette, type CameraParams, compose, type RoomLayers } from './compose';
import { decodeCel } from './hdr';
import type { LampAnimator, LampDisplay } from './lamp';

export type ViewId = 'room' | 'desk';

export interface RoomDevice {
  id: string;
  kind: string;
  label: string;
  /** normalized [x, y, w, h] in 0..1 */
  box: [number, number, number, number];
  /** pixel outline (simplified), for drawing */
  polygon?: [number, number][];
}

export interface ViewMeta {
  pose: Pose;
  intrinsics: { fx: number; fy: number; cx: number; cy: number; width: number; height: number };
  fovYDeg: number;
  devices: RoomDevice[];
  /** quad corners (px, clockwise from bottom-left) of screens that the sim paints live */
  screens: Record<string, [number, number][]>;
}

export interface RoomMeta {
  v: number;
  width: number;
  height: number;
  space: string;
  camera: CameraParams;
  views: Record<ViewId, ViewMeta>;
  devices: Record<string, { center: number[]; size: number[] }>;
}

export const BASE = import.meta.env.BASE_URL; // "/sim/"

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  if (url.endsWith('.gz') && res.headers.get('content-encoding') !== 'gzip') {
    const ds = res.body!.pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(ds).arrayBuffer());
  }
  return new Uint8Array(await res.arrayBuffer());
}

export async function loadMeta(): Promise<RoomMeta> {
  const res = await fetch(`${BASE}room/meta.json`);
  if (!res.ok) throw new Error(`room/meta.json: HTTP ${res.status}`);
  return (await res.json()) as RoomMeta;
}

export async function loadLayers(view: ViewId, onProgress?: (msg: string) => void): Promise<RoomLayers> {
  const names = ['sky', 'lamp', 'night'] as const;
  const imgs = await Promise.all(
    names.map(async (n) => {
      const bytes = await fetchBytes(`${BASE}room/${view}/${n}.cel.gz`);
      onProgress?.(`decoded ${view}/${n}`);
      return decodeCel(bytes);
    }),
  );
  const [sky, lamp, night] = imgs;
  const layers: RoomLayers = { width: sky!.width, height: sky!.height, sky: sky!.data, lamp: lamp!.data, night: night!.data };
  applyVignette(layers);
  return layers;
}

/**
 * Paint `src` onto the quad (bl, br, tr, tl in px) with two affine-mapped triangles (the screen is small, so
 * the missing perspective term is invisible).
 */
function drawQuad(g: CanvasRenderingContext2D, src: HTMLCanvasElement, quad: [number, number][], alpha = 1): void {
  const [bl, br, tr, tl] = quad as [[number, number], [number, number], [number, number], [number, number]];
  const w = src.width;
  const h = src.height;
  const tri = (s0: [number, number], s1: [number, number], s2: [number, number], d0: [number, number], d1: [number, number], d2: [number, number]) => {
    g.save();
    g.beginPath();
    g.moveTo(d0[0], d0[1]);
    g.lineTo(d1[0], d1[1]);
    g.lineTo(d2[0], d2[1]);
    g.closePath();
    g.clip();
    const den = s0[0] * (s2[1] - s1[1]) - s1[0] * s2[1] + s2[0] * s1[1] + (s1[0] - s2[0]) * s0[1];
    const a = -(s0[1] * (d2[0] - d1[0]) - s1[1] * d2[0] + s2[1] * d1[0] + (s1[1] - s2[1]) * d0[0]) / den;
    const b = (s1[1] * d2[1] + s0[1] * (d1[1] - d2[1]) - s2[1] * d1[1] + (s2[1] - s1[1]) * d0[1]) / den;
    const c = (s0[0] * (d2[0] - d1[0]) - s1[0] * d2[0] + s2[0] * d1[0] + (s1[0] - s2[0]) * d0[0]) / den;
    const d = -(s1[0] * d2[1] + s0[0] * (d1[1] - d2[1]) - s2[0] * d1[1] + (s2[0] - s1[0]) * d0[1]) / den;
    const e = (s0[0] * (s2[1] * d1[0] - s1[1] * d2[0]) + s0[1] * (s1[0] * d2[0] - s2[0] * d1[0]) + (s2[0] * s1[1] - s1[0] * s2[1]) * d0[0]) / den;
    const f = (s0[0] * (s2[1] * d1[1] - s1[1] * d2[1]) + s0[1] * (s1[0] * d2[1] - s2[0] * d1[1]) + (s2[0] * s1[1] - s1[0] * s2[1]) * d0[1]) / den;
    g.transform(a, b, c, d, e, f);
    g.globalAlpha = alpha;
    g.drawImage(src, 0, 0);
    g.restore();
  };
  tri([0, h], [w, h], [w, 0], bl, br, tr);
  tri([0, h], [w, 0], [0, 0], bl, tr, tl);
}

export class RoomView {
  readonly canvas: HTMLCanvasElement;
  readonly overlay: HTMLCanvasElement;
  view: ViewId = 'room';
  meta?: RoomMeta;
  cam: CameraParams = { exposure: 1, skyGain: 1, lampGain: 1, nightGain: 1 };
  /** the synth's screen canvas, pasted onto the synth in the desk photo */
  screenSource?: HTMLCanvasElement;
  /** Silent instrument displayed by the laptop in both camera views. */
  visualScreenSource?: HTMLCanvasElement;
  beforePaintScreens?: () => void;
  private readonly layers = new Map<ViewId, RoomLayers>();
  private loading = new Map<ViewId, Promise<RoomLayers>>();
  private img?: ImageData;
  private raf = 0;
  private lastFrame = 0;
  private screenDirty = false;
  private detections?: { result: ScanResultPayload; view: ViewId; at: number };
  onFrame?: () => void;

  constructor(
    canvas: HTMLCanvasElement,
    overlay: HTMLCanvasElement,
    private readonly lamp: LampAnimator,
  ) {
    this.canvas = canvas;
    this.overlay = overlay;
  }

  get ready(): boolean {
    return this.layers.has(this.view);
  }

  get viewMeta(): ViewMeta | undefined {
    return this.meta?.views[this.view];
  }

  async init(onProgress?: (m: string) => void): Promise<void> {
    this.meta = await loadMeta();
    this.cam = { ...this.meta.camera };
    this.canvas.width = this.overlay.width = this.meta.width;
    this.canvas.height = this.overlay.height = this.meta.height;
    await this.ensure(this.view, onProgress);
    this.render();
    // preload the other view in the background
    void this.ensure(this.view === 'room' ? 'desk' : 'room').catch(() => {});
  }

  private ensure(view: ViewId, onProgress?: (m: string) => void): Promise<RoomLayers> {
    const have = this.layers.get(view);
    if (have) return Promise.resolve(have);
    let p = this.loading.get(view);
    if (!p) {
      p = loadLayers(view, onProgress).then((l) => {
        this.layers.set(view, l);
        return l;
      });
      this.loading.set(view, p);
    }
    return p;
  }

  async setView(view: ViewId): Promise<void> {
    this.view = view;
    await this.ensure(view);
    this.detections = undefined;
    this.drawOverlay();
    this.render();
  }

  /** Mark a live screen as changed. */
  screenChanged(): void {
    this.screenDirty = true;
  }

  start(): void {
    let last = performance.now();
    const loop = (t: number) => {
      this.raf = requestAnimationFrame(loop);
      const dt = t - last;
      last = t;
      const changed = this.lamp.step(dt);
      if ((changed || this.screenDirty || this.visualScreenSource) && t - this.lastFrame > 33) {
        this.lastFrame = t;
        this.screenDirty = false;
        if (changed) this.render();
        else this.repaintScreens();
      }
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
  }

  /** Develop the current lamp state into the visible canvas. */
  render(display: LampDisplay = this.lamp.display): void {
    const layers = this.layers.get(this.view);
    if (!layers) return;
    const g = this.canvas.getContext('2d')!;
    if (!this.img || this.img.width !== layers.width) this.img = g.createImageData(layers.width, layers.height);
    compose(layers, display, this.cam, this.img.data);
    g.putImageData(this.img, 0, 0);
    this.paintScreens(g, 1);
    this.onFrame?.();
  }

  /** Reuse the developed room while only the live display animates. */
  private repaintScreens(): void {
    if (!this.img) return;
    const g = this.canvas.getContext('2d')!;
    g.putImageData(this.img, 0, 0);
    this.paintScreens(g, 1);
    this.onFrame?.();
  }

  private paintScreens(g: CanvasRenderingContext2D, alpha: number, view: ViewId = this.view): void {
    this.beforePaintScreens?.();
    g.save();
    g.filter = 'blur(0.4px) brightness(0.85)';
    const screens = this.meta?.views[view].screens;
    if (view === 'desk' && screens?.['synth-screen'] && this.screenSource) drawQuad(g, this.screenSource, screens['synth-screen'], alpha * 0.92);
    if (screens?.['laptop-screen'] && this.visualScreenSource) drawQuad(g, this.visualScreenSource, screens['laptop-screen'], alpha);
    g.restore();
  }

  /**
   * A camera frame as base64 JPEG (no data: prefix): the same development plus sensor noise, optionally for
   * an earlier instant (`at`, epoch ms) using the lamp's fade history.
   */
  async capture(opts: { noise?: number; at?: number; quality?: number; view?: ViewId } = {}): Promise<{ jpeg: string; width: number; height: number; view: ViewId }> {
    const view = opts.view ?? this.view;
    const layers = await this.ensure(view);
    const c = document.createElement('canvas');
    c.width = layers.width;
    c.height = layers.height;
    const g = c.getContext('2d')!;
    const img = g.createImageData(layers.width, layers.height);
    const display = opts.at ? this.lamp.at(opts.at) : this.lamp.display;
    compose(layers, display, this.cam, img.data, { noise: opts.noise ?? 1, seed: (Date.now() & 0x7fffffff) | 1 });
    g.putImageData(img, 0, 0);
    this.paintScreens(g, 1, view);
    const blob = await new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', opts.quality ?? 0.88));
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { jpeg: btoa(s), width: layers.width, height: layers.height, view };
  }

  showDetections(result: ScanResultPayload, view: ViewId = this.view): void {
    this.detections = { result, view, at: Date.now() };
    this.drawOverlay();
  }

  clearDetections(): void {
    this.detections = undefined;
    this.drawOverlay();
  }

  drawOverlay(): void {
    const g = this.overlay.getContext('2d')!;
    g.clearRect(0, 0, this.overlay.width, this.overlay.height);
    const d = this.detections;
    if (!d || d.view !== this.view) return;
    const sx = this.overlay.width / d.result.width;
    const sy = this.overlay.height / d.result.height;
    g.lineWidth = 3;
    g.font = '600 22px ui-monospace, SFMono-Regular, Menlo, monospace';
    for (const det of d.result.detections) {
      const color = det.label.includes('light') ? '#3ff2d0' : det.label.includes('synth') ? '#ffb020' : '#ff3d8b';
      g.strokeStyle = color;
      g.fillStyle = color;
      if (det.polygon && det.polygon.length > 2) {
        g.beginPath();
        det.polygon.forEach(([x, y], i) => (i ? g.lineTo(x * sx, y * sy) : g.moveTo(x * sx, y * sy)));
        g.closePath();
        g.globalAlpha = 0.18;
        g.fill();
        g.globalAlpha = 1;
        g.stroke();
      } else {
        const [x, y, w, h] = det.box;
        g.strokeRect(x * sx, y * sy, w * sx, h * sy);
      }
      const [x, y] = det.box;
      const text = `${det.label} ${(det.score * 100).toFixed(0)}%`;
      const tw = g.measureText(text).width;
      g.globalAlpha = 0.75;
      g.fillStyle = '#05070a';
      g.fillRect(x * sx, Math.max(0, y * sy - 30), tw + 14, 28);
      g.globalAlpha = 1;
      g.fillStyle = color;
      g.fillText(text, x * sx + 7, Math.max(20, y * sy - 9));
    }
    const tag = `${d.result.modelId} · ${d.result.source.toUpperCase()} · ${Math.round(d.result.latencyMs)} ms`;
    g.font = '500 18px ui-monospace, SFMono-Regular, Menlo, monospace';
    const tw = g.measureText(tag).width;
    g.globalAlpha = 0.7;
    g.fillStyle = '#05070a';
    g.fillRect(this.overlay.width - tw - 28, this.overlay.height - 40, tw + 18, 28);
    g.globalAlpha = 1;
    g.fillStyle = '#c9d4df';
    g.fillText(tag, this.overlay.width - tw - 19, this.overlay.height - 20);
  }
}
