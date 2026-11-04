/**
 * The AR overlay on the camera view, in the Quest's look (hud/v2 theme: white outline = an object SAM sees,
 * a white pill = tagged, the accent = selected): SAM 3.1 outlines with label pills, the aim reticle with a dwell
 * ring, and hit-testing for a tap, a click or a held hand. Drawn on a 2D canvas above the GPU stage.
 */
import type { Detection, Tag } from './annotate';

export type ToDisplay = (x: number, y: number) => { x: number; y: number };
const ACCENT = '#38BDF8';

export interface OverlayItem {
  kind: 'detection' | 'tag';
  key: string;
  label: string;
  /** display-space outline (0..1) */
  points: { x: number; y: number }[];
  box: { x0: number; y0: number; x1: number; y1: number };
  det?: Detection; tag?: Tag;
}

export class Overlay {
  readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  items: OverlayItem[] = [];
  selected?: string;
  aim?: { x: number; y: number; progress: number; color: string };

  constructor(host: HTMLElement) {
    this.canvas.className = 'ar-overlay';
    host.append(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
  }

  resize(): void {
    const r = this.canvas.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
  }

  /** Rebuild what to draw: live detections (Annotate) and tags (both layers). */
  build(mode: 'annotate' | 'control', detections: Detection[], tags: Iterable<Tag>, toDisplay: ToDisplay, tagFor: (d: Detection) => Tag | undefined): void {
    const items: OverlayItem[] = [];
    const shape = (b: { x: number; y: number; w: number; h: number; polygon?: [number, number][] }) => {
      const src = b.polygon && b.polygon.length >= 3 ? b.polygon : [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]] as [number, number][];
      const points = src.map(([x, y]) => toDisplay(x, y));
      const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
      return { points, box: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) } };
    };
    const shown = new Set<string>();
    if (mode === 'annotate') for (const d of detections) {
      const tag = tagFor(d);
      if (tag) shown.add(tag.cardId);
      items.push({ kind: tag ? 'tag' : 'detection', key: tag?.cardId ?? d.detId, label: tag?.name ?? tag?.label ?? d.label, det: d, ...(tag ? { tag } : {}), ...shape(d) });
    }
    for (const tag of tags) {
      if (shown.has(tag.cardId) || !tag.box) continue;
      items.push({ kind: 'tag', key: tag.cardId, label: tag.name ?? tag.label, tag, ...shape(tag.box) });
    }
    this.items = items;
  }

  /** The item under a display point (tags win over plain detections; the smallest box wins). */
  hit(x: number, y: number, kinds: OverlayItem['kind'][] = ['detection', 'tag']): OverlayItem | undefined {
    const pad = 0.015;
    return this.items
      .filter((i) => kinds.includes(i.kind) && x >= i.box.x0 - pad && x <= i.box.x1 + pad && y >= i.box.y0 - pad && y <= i.box.y1 + pad)
      .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'tag' ? -1 : 1) || area(a) - area(b))[0];
  }

  draw(mode: 'annotate' | 'control', time: number): void {
    const c = this.ctx, W = this.canvas.width, H = this.canvas.height, dpr = W / Math.max(1, this.canvas.clientWidth);
    c.clearRect(0, 0, W, H);
    for (const item of this.items) {
      if (mode === 'control' && item.kind !== 'tag') continue;
      const selected = item.key === this.selected;
      const tagged = item.kind === 'tag';
      c.save();
      c.beginPath();
      item.points.forEach((p, i) => (i ? c.lineTo(p.x * W, p.y * H) : c.moveTo(p.x * W, p.y * H)));
      c.closePath();
      c.lineJoin = 'round';
      c.shadowColor = selected ? ACCENT : 'rgba(255,255,255,0.65)'; c.shadowBlur = (selected ? 14 : 8) * dpr;
      c.strokeStyle = selected ? ACCENT : tagged ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.7)';
      c.lineWidth = (selected ? 3 : tagged ? 2.2 : 1.5) * dpr;
      if (!tagged) c.setLineDash([6 * dpr, 5 * dpr]);
      c.stroke();
      if (selected) { c.fillStyle = 'rgba(56,189,248,0.10)'; c.fill(); }
      c.restore();
      // label pill above the box (the Quest's white pill = tagged)
      const text = `${tagged ? '✓ ' : ''}${item.label}`;
      c.font = `500 ${13 * dpr}px Inter, system-ui, sans-serif`;
      const tw = c.measureText(text).width, ph = 24 * dpr, pw = tw + 22 * dpr;
      let px = ((item.box.x0 + item.box.x1) / 2) * W - pw / 2, py = item.box.y0 * H - ph - 8 * dpr;
      px = Math.max(6 * dpr, Math.min(W - pw - 6 * dpr, px)); if (py < 6 * dpr) py = item.box.y1 * H + 8 * dpr;
      c.beginPath(); c.roundRect(px, py, pw, ph, ph / 2);
      c.fillStyle = selected ? ACCENT : tagged ? '#FFFFFF' : 'rgba(22,22,27,0.82)'; c.fill();
      if (!tagged) { c.strokeStyle = 'rgba(255,255,255,0.18)'; c.lineWidth = 1 * dpr; c.stroke(); }
      c.fillStyle = tagged || selected ? '#121216' : '#FFFFFF';
      c.textBaseline = 'middle'; c.fillText(text, px + 11 * dpr, py + ph / 2 + 0.5 * dpr);
    }
    const a = this.aim;
    if (a) {
      const x = a.x * W, y = a.y * H, r = 15 * dpr;
      c.save();
      c.lineWidth = 2 * dpr; c.strokeStyle = 'rgba(255,255,255,0.85)'; c.shadowColor = a.color; c.shadowBlur = 10 * dpr;
      c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.stroke();
      c.fillStyle = '#fff'; c.beginPath(); c.arc(x, y, 2.6 * dpr, 0, Math.PI * 2); c.fill();
      if (a.progress > 0) {
        c.strokeStyle = a.color; c.lineWidth = 4 * dpr; c.lineCap = 'round';
        c.beginPath(); c.arc(x, y, r + 6 * dpr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, a.progress)); c.stroke();
      }
      c.restore();
    }
    void time;
  }
}

const area = (i: OverlayItem) => (i.box.x1 - i.box.x0) * (i.box.y1 - i.box.y0);
