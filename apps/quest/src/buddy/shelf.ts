/**
 * The collection shelf: everything you showed the buddy, as one 384×256 canvas atlas (3×2 slots) on one texture,
 * so the whole shelf is a single draw call inside the card. A slot first shows the photo crop; when the Muse Image
 * sticker arrives its chroma-green background is flood-filled away from the border and it replaces the photo.
 * Canvas work happens only when an item is added or a sticker lands, never per frame.
 */
import { CanvasTexture, SRGBColorSpace } from 'three';

const SLOT = 128;
const COLS = 3;
const ROWS = 2;
export const SHELF_SLOTS = COLS * ROWS;

export interface ShelfItem {
  name: string;
  questMet: boolean;
  photo?: ImageBitmap;
  sticker?: HTMLCanvasElement;
  painting: boolean;
}

/** Remove the flat green background connected to the image border (keeps green parts of the object). */
export function keyGreen(img: ImageData): void {
  const { width: w, height: h, data } = img;
  const isKey = (i: number) => {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    return g > 150 && g - Math.max(r, b) > 70;
  };
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let x = 0; x < w; x++) { stack.push(x, (h - 1) * w + x); }
  for (let y = 0; y < h; y++) { stack.push(y * w, y * w + w - 1); }
  while (stack.length) {
    const p = stack.pop()!;
    if (seen[p]) continue;
    seen[p] = 1;
    if (!isKey(p * 4)) continue;
    data[p * 4 + 3] = 0;
    const x = p % w, y = (p / w) | 0;
    if (x > 0) stack.push(p - 1);
    if (x < w - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - w);
    if (y < h - 1) stack.push(p + w);
  }
  // soften the green fringe next to removed pixels
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    if (data[i + 3] === 0) continue;
    const g = data[i + 1], m = Math.max(data[i], data[i + 2]);
    if (g > m + 30) data[i + 1] = m + 30;
  }
}

export async function loadSticker(url: string): Promise<HTMLCanvasElement> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`sticker HTTP ${res.status}`);
  const bmp = await createImageBitmap(await res.blob(), { resizeWidth: SLOT, resizeHeight: SLOT, resizeQuality: 'high' });
  const c = document.createElement('canvas');
  c.width = c.height = SLOT;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0, SLOT, SLOT);
  bmp.close();
  const img = g.getImageData(0, 0, SLOT, SLOT);
  keyGreen(img);
  g.putImageData(img, 0, 0);
  return c;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export class Shelf {
  readonly canvas: HTMLCanvasElement;
  readonly texture: CanvasTexture;
  readonly items: ShelfItem[] = [];
  private readonly g: CanvasRenderingContext2D;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = COLS * SLOT;
    this.canvas.height = ROWS * SLOT;
    this.g = this.canvas.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.redraw();
  }

  add(item: ShelfItem): ShelfItem {
    this.items.push(item);
    while (this.items.length > SHELF_SLOTS) {
      const old = this.items.shift();
      old?.photo?.close();
    }
    this.redraw();
    return item;
  }

  redraw(): void {
    const g = this.g;
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (let i = 0; i < SHELF_SLOTS; i++) {
      const x = (i % COLS) * SLOT, y = Math.floor(i / COLS) * SLOT;
      const item = this.items[i];
      g.save();
      roundRect(g, x + 6, y + 6, SLOT - 12, SLOT - 12, 22);
      g.fillStyle = item ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.05)';
      g.fill();
      if (!item) {
        g.setLineDash([8, 8]);
        g.strokeStyle = 'rgba(255,255,255,0.22)';
        g.lineWidth = 2;
        g.stroke();
        g.restore();
        continue;
      }
      if (item.sticker) {
        g.drawImage(item.sticker, x + 4, y + 4, SLOT - 8, SLOT - 8);
      } else if (item.photo) {
        g.clip();
        const s = Math.min(item.photo.width, item.photo.height);
        g.globalAlpha = item.painting ? 0.75 : 1;
        g.drawImage(item.photo, (item.photo.width - s) / 2, (item.photo.height - s) / 2, s, s, x + 6, y + 6, SLOT - 12, SLOT - 12);
        g.globalAlpha = 1;
        if (item.painting) {
          // "painting…" shimmer bar
          g.fillStyle = 'rgba(0,0,0,0.45)';
          g.fillRect(x + 6, y + SLOT - 38, SLOT - 12, 32);
          g.fillStyle = '#FFFFFF';
          g.font = '600 17px Inter, system-ui, sans-serif';
          g.textAlign = 'center';
          g.fillText('painting…', x + SLOT / 2, y + SLOT - 16);
        }
      }
      g.restore();
      if (item.questMet) {
        // a small gold star badge
        const cx = x + SLOT - 22, cy = y + 22;
        g.beginPath();
        for (let k = 0; k < 10; k++) {
          const r = k % 2 ? 7 : 15;
          const a = -Math.PI / 2 + (k * Math.PI) / 5;
          g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
        }
        g.closePath();
        g.fillStyle = '#FFD54F';
        g.fill();
        g.lineWidth = 3;
        g.strokeStyle = '#16161B';
        g.stroke();
      }
    }
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    for (const i of this.items) i.photo?.close();
    this.texture.dispose();
  }
}
