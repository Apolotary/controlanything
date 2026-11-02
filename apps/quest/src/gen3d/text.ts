/**
 * Canvas-texture labels: crisp at desk distance (4 px per mm), on a plate by default, with the HUD fonts
 * (Chakra Petch for labels, Share Tech Mono for readouts; system fallbacks until the fonts load).
 * No external text engine: ≤ 60 labels per scene, one small texture each, redrawn only when the text changes.
 */
import { CanvasTexture, LinearFilter, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from 'three';
import type { TextStyle } from '@ce/gen3d';
import { FONTS, NEON } from '@ce/gen3d';

const PX_PER_M = 4000;
const MAX_W = 1024;

const registry = new Set<Label>();
let fontsReady = false;
if (typeof document !== 'undefined' && 'fonts' in document) {
  document.fonts.ready.then(() => {
    fontsReady = true;
    for (const l of registry) l.redraw();
  });
}

function fontFor(style: TextStyle): string {
  const weight = style.weight === 'regular' ? 400 : style.weight === 'medium' ? 600 : 700;
  if (style.font === 'mono') return `${weight === 400 ? 400 : 400} ${'{px}'}px ${FONTS.mono}`;
  const jp = /[぀-ヿ一-鿿]/.test(style.value);
  return `${weight} {px}px ${jp ? FONTS.jp : FONTS.label}`;
}

export class Label extends Mesh<PlaneGeometry, MeshBasicMaterial> {
  private canvas: HTMLCanvasElement;
  private texture: CanvasTexture;
  private style: TextStyle;
  widthM = 0;
  heightM = 0;

  constructor(style: TextStyle) {
    // headless (unit tests, server-side render checks): no canvas, a plain plane of roughly the right size
    const headless = typeof document === 'undefined';
    const canvas = headless ? ({ width: 1, height: 1, getContext: () => null } as unknown as HTMLCanvasElement) : document.createElement('canvas');
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = false;
    texture.anisotropy = 4;
    super(new PlaneGeometry(1, 1), new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false }));
    this.canvas = canvas;
    this.texture = texture;
    this.style = { ...style };
    this.name = 'label';
    registry.add(this);
    this.redraw();
  }

  get text(): string {
    return this.style.value;
  }

  setText(value: string): void {
    if (value === this.style.value) return;
    this.style.value = value;
    this.redraw();
  }

  setColor(color: string): void {
    if (color === this.style.color) return;
    this.style.color = color;
    this.redraw();
  }

  redraw(): void {
    const s = this.style;
    const cap = s.heightM ?? 0.009;
    const fontPx = Math.round((cap * PX_PER_M) / 0.7); // cap height ≈ 0.7 em for these fonts
    const ctx = this.canvas.getContext('2d');
    if (!ctx) {
      // headless: approximate the plate size so layout-dependent logic (bounds, handles) still works
      this.heightM = cap * 1.8;
      this.widthM = Math.max(0.01, s.value.length * cap * 0.75 + cap);
      this.geometry.dispose();
      this.geometry = new PlaneGeometry(this.widthM, this.heightM);
      return;
    }
    const font = fontFor(s).replace('{px}', String(fontPx));
    ctx.font = font;
    const raw = s.uppercase === false ? s.value : s.font === 'mono' ? s.value : s.value.toUpperCase();
    const lines = s.wrap ? wrap(raw, s.wrap) : [raw];
    const tracking = s.font === 'mono' ? 0 : fontPx * 0.06;
    const widths = lines.map((l) => measure(ctx, l, tracking));
    const textW = Math.max(1, ...widths);
    const padX = s.background ? fontPx * 0.55 : 2;
    const padY = s.background ? fontPx * 0.3 : 2;
    const lineH = fontPx * 1.15;
    let w = Math.ceil(textW + padX * 2);
    const h = Math.ceil(lineH * lines.length + padY * 2);
    let scale = 1;
    if (w > MAX_W) {
      scale = MAX_W / w;
      w = MAX_W;
    }
    this.canvas.width = w;
    this.canvas.height = Math.ceil(h * scale);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, w / scale, h);
    if (s.background) {
      ctx.fillStyle = s.background;
      roundRect(ctx, 0, 0, w / scale, h, Math.min(h / 2, fontPx * 0.35));
      ctx.fill();
    }
    ctx.font = font;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = s.color ?? NEON.bone;
    lines.forEach((line, i) => {
      const y = padY + lineH * (i + 0.5);
      const lw = widths[i]!;
      const x0 = s.align === 'left' ? padX : s.align === 'right' ? w / scale - padX - lw : (w / scale - lw) / 2;
      drawTracked(ctx, line, x0, y, tracking);
    });
    this.texture.needsUpdate = true;
    // size the plane: canvas px -> metres
    this.widthM = w / scale / PX_PER_M;
    this.heightM = h / PX_PER_M;
    this.geometry.dispose();
    this.geometry = new PlaneGeometry(this.widthM, this.heightM);
    // anchor: left/right aligned labels keep their edge at the part position
    const shift = s.align === 'left' ? this.widthM / 2 : s.align === 'right' ? -this.widthM / 2 : 0;
    this.geometry.translate(shift, 0, 0);
  }

  override dispose(): void {
    registry.delete(this);
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}

function measure(ctx: CanvasRenderingContext2D, text: string, tracking: number): number {
  if (!tracking) return ctx.measureText(text).width;
  let w = 0;
  for (const ch of text) w += ctx.measureText(ch).width + tracking;
  return w - tracking;
}
function drawTracked(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, tracking: number): void {
  if (!tracking) {
    ctx.fillText(text, x, y);
    return;
  }
  let cx = x;
  for (const ch of text) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + tracking;
  }
}
function wrap(text: string, max: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max && cur) {
      lines.push(cur);
      cur = w;
    } else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 6);
}
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function fontsLoaded(): boolean {
  return fontsReady;
}
