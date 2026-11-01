/**
 * A flat plate with canvas-drawn content and pinch hit regions, for the shell's debug HUD
 * (gen3d-lead's HUD replaces it). 2 px per millimetre keeps text crisp at desk distance.
 */
import { CanvasTexture, DoubleSide, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace, type Vector2 } from 'three';

export const PALETTE = {
  void: '#0A0E12',
  plate: '#101820',
  bone: '#F3F7FA',
  dim: '#8FA3B3',
  cyan: '#38F0FF',
  volt: '#EEFF41',
  magenta: '#FF3DBE',
  ok: '#5CFFA3',
  fail: '#FF5A3C',
} as const;

export const FONT_LABEL = '"Chakra Petch", "Arial Narrow", system-ui, sans-serif';
export const FONT_MONO = '"Share Tech Mono", ui-monospace, Menlo, monospace';

const PX_PER_MM = 2;

export interface HitRegion {
  /** canvas pixels */
  x: number;
  y: number;
  w: number;
  h: number;
  id: string;
  /** 0..1 position of the hit inside the region (for sliders) */
  onPick: (fx: number, fy: number) => void;
}

export class Panel {
  readonly mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly texture: CanvasTexture;
  regions: HitRegion[] = [];
  readonly wPx: number;
  readonly hPx: number;

  constructor(
    readonly widthMm: number,
    readonly heightMm: number,
    opts: { name?: string; depthTest?: boolean; renderOrder?: number } = {},
  ) {
    this.wPx = Math.round(widthMm * PX_PER_MM);
    this.hPx = Math.round(heightMm * PX_PER_MM);
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.wPx;
    this.canvas.height = this.hPx;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    const mat = new MeshBasicMaterial({ map: this.texture, transparent: true, side: DoubleSide, depthTest: opts.depthTest ?? true, depthWrite: false });
    this.mesh = new Mesh(new PlaneGeometry(widthMm / 1000, heightMm / 1000), mat);
    this.mesh.name = opts.name ?? 'panel';
    this.mesh.renderOrder = opts.renderOrder ?? 10;
    this.mesh.userData.panel = this;
  }

  /** Redraw: clears, draws the plate, runs `fn`, uploads. Hit regions are reset and re-declared by `fn`. */
  draw(fn: (ctx: CanvasRenderingContext2D, p: Panel) => void, opts: { plate?: boolean; edge?: string } = {}): void {
    const c = this.ctx;
    c.clearRect(0, 0, this.wPx, this.hPx);
    this.regions = [];
    if (opts.plate !== false) {
      c.fillStyle = hexA(PALETTE.plate, 0.92);
      roundRect(c, 1, 1, this.wPx - 2, this.hPx - 2, 10);
      c.fill();
      c.strokeStyle = hexA(PALETTE.void, 1);
      c.lineWidth = 6;
      c.stroke();
      c.strokeStyle = opts.edge ?? PALETTE.cyan;
      c.lineWidth = 2;
      c.stroke();
    }
    fn(c, this);
    this.texture.needsUpdate = true;
  }

  /** Text helper: `size` in millimetres of cap height (roughly). */
  text(s: string, xMm: number, yMm: number, opts: { size?: number; color?: string; font?: 'label' | 'mono'; align?: CanvasTextAlign; weight?: number; maxMm?: number } = {}): void {
    const c = this.ctx;
    const px = (opts.size ?? 7) * PX_PER_MM * 1.35;
    c.font = `${opts.weight ?? 600} ${px}px ${opts.font === 'mono' ? FONT_MONO : FONT_LABEL}`;
    c.fillStyle = opts.color ?? PALETTE.bone;
    c.textAlign = opts.align ?? 'left';
    c.textBaseline = 'alphabetic';
    let str = s;
    if (opts.maxMm) {
      const max = opts.maxMm * PX_PER_MM;
      while (str.length > 3 && c.measureText(str).width > max) str = `${str.slice(0, -2)}…`;
    }
    c.fillText(str, xMm * PX_PER_MM, yMm * PX_PER_MM);
  }

  /** Declare a pinchable rectangle (millimetres). */
  region(id: string, xMm: number, yMm: number, wMm: number, hMm: number, onPick: HitRegion['onPick']): void {
    this.regions.push({ id, x: xMm * PX_PER_MM, y: yMm * PX_PER_MM, w: wMm * PX_PER_MM, h: hMm * PX_PER_MM, onPick });
  }

  /** A button plate with a label; returns nothing, declares its region. */
  button(id: string, label: string, xMm: number, yMm: number, wMm: number, hMm: number, onPick: () => void, opts: { active?: boolean; color?: string } = {}): void {
    const c = this.ctx;
    const k = PX_PER_MM;
    c.fillStyle = opts.active ? hexA(opts.color ?? PALETTE.volt, 0.25) : hexA(PALETTE.void, 0.9);
    roundRect(c, xMm * k, yMm * k, wMm * k, hMm * k, 6);
    c.fill();
    c.strokeStyle = opts.color ?? (opts.active ? PALETTE.volt : PALETTE.cyan);
    c.lineWidth = 2;
    c.stroke();
    this.text(label, xMm + wMm / 2, yMm + hMm / 2 + 3, { size: 6, align: 'center', color: opts.color ?? (opts.active ? PALETTE.volt : PALETTE.bone) });
    this.region(id, xMm, yMm, wMm, hMm, () => onPick());
  }

  /** Route a hit (uv from a raycast) to the region under it. Returns the region id or null. */
  pick(uv: Vector2): string | null {
    const x = uv.x * this.wPx;
    const y = (1 - uv.y) * this.hPx;
    for (const r of this.regions) {
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        r.onPick((x - r.x) / r.w, (y - r.y) / r.h);
        return r.id;
      }
    }
    return null;
  }

  dispose(): void {
    this.texture.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

export function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

export function hexA(hex: string, a: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
