/**
 * Crisp SDF text for the headset (troika-three-text, MIT) in one family: Inter (OFL). One draw call per label,
 * sharp at any distance, with a dark outline so words read over a bright room without a plate when needed.
 * Headless (unit tests): a stub Object3D with the same surface.
 */
import { Object3D } from 'three';
import { NEON } from '@ce/gen3d';
import inter500 from '@fontsource/inter/files/inter-latin-500-normal.woff';
import inter600 from '@fontsource/inter/files/inter-latin-600-normal.woff';

export interface SdfTextOptions {
  text: string;
  /** cap-ish height in metres (troika fontSize) */
  size?: number;
  color?: string;
  weight?: 500 | 600;
  anchorX?: 'left' | 'center' | 'right';
  anchorY?: 'top' | 'middle' | 'bottom';
  maxWidth?: number;
  outline?: boolean;
  align?: 'left' | 'center' | 'right';
}

export interface SdfText extends Object3D {
  text: string;
  color: string | number;
  fontSize: number;
  sync(cb?: () => void): void;
  dispose(): void;
  /** troika's material; the stub carries a compatible object */
  material: { opacity: number; transparent: boolean; depthWrite: boolean };
}

type TroikaCtor = new () => SdfText & Record<string, unknown>;
let TroikaText: TroikaCtor | null = null;
const headless = typeof document === 'undefined';
if (!headless) {
  // dynamic import keeps the headless test path free of troika's worker setup
  void import('troika-three-text').then((m) => (TroikaText = m.Text as unknown as TroikaCtor));
}

class StubText extends Object3D implements SdfText {
  text = '';
  color: string | number = '#ffffff';
  fontSize = 0.01;
  material = { opacity: 1, transparent: true, depthWrite: false };
  sync(cb?: () => void): void {
    cb?.();
  }
  dispose(): void {}
}

/** Create a label. Set `.text`/`.color` and call `.sync()` to change it later. */
export function makeText(o: SdfTextOptions): SdfText {
  const t: SdfText & Record<string, unknown> = TroikaText ? new TroikaText() : new StubText();
  t.text = o.text;
  t.fontSize = o.size ?? 0.012;
  t.color = o.color ?? NEON.bone;
  if (TroikaText) {
    t.font = (o.weight ?? 500) === 600 ? inter600 : inter500;
    t.anchorX = o.anchorX ?? 'left';
    t.anchorY = o.anchorY ?? 'middle';
    t.textAlign = o.align ?? (o.anchorX === 'center' ? 'center' : 'left');
    if (o.maxWidth) t.maxWidth = o.maxWidth;
    t.lineHeight = 1.25;
    t.letterSpacing = 0;
    if (o.outline ?? true) {
      t.outlineWidth = '10%';
      t.outlineColor = NEON.void;
      t.outlineOpacity = 0.9;
    }
    t.depthOffset = -1;
    (t.material as { toneMapped?: boolean }).toneMapped = false;
    t.renderOrder = 60;
    t.sync();
  }
  t.name = 'sdf';
  return t;
}

export function setText(t: SdfText, text: string, color?: string): void {
  let changed = false;
  if (t.text !== text) {
    t.text = text;
    changed = true;
  }
  if (color && t.color !== color) {
    t.color = color;
    changed = true;
  }
  if (changed) t.sync();
}

/** True once troika is loaded (labels created before that are stubs and should be recreated). */
export function sdfReady(): boolean {
  return headless || TroikaText !== null;
}

/** Resolve when the SDF engine is available (immediately when headless). */
export function whenSdfReady(): Promise<void> {
  if (sdfReady()) return Promise.resolve();
  return import('troika-three-text').then((m) => {
    TroikaText = m.Text as unknown as TroikaCtor;
  });
}
