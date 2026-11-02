import { BufferGeometry, Float32BufferAttribute, Mesh, MeshBasicMaterial } from 'three';
import { Text } from 'troika-three-text';
import { THEME } from './theme';

export interface SdfTextOptions {
  text: string;
  size?: number;
  color?: string;
  weight?: 500 | 600;
  anchorX?: 'left' | 'center' | 'right';
  anchorY?: 'top' | 'middle' | 'bottom';
  maxWidth?: number;
  outline?: boolean;
  singleLine?: boolean;
  align?: 'left' | 'center' | 'right';
}
export type SdfText = Text;
const headless = typeof document === 'undefined';
const textMaterial = new MeshBasicMaterial({ color: THEME.color.text, transparent: true, depthWrite: false, toneMapped: false });

/** Tests retain a real renderable Mesh and two triangles per glyph, without launching font workers. */
class HeadlessText extends Mesh<BufferGeometry, MeshBasicMaterial> {
  text = '';
  color: string | number = THEME.color.text;
  fontSize = THEME.font.body as number;
  constructor() { super(new BufferGeometry(), textMaterial); }
  sync(callback?: () => void): void {
    const vertices = new Float32Array(Math.max(1, this.text.length) * 18);
    this.geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3));
    callback?.();
  }
  override dispose(): void { this.geometry.dispose(); }
}

/** Browser imports are synchronous: every browser label is real SDF text from its first frame. */
export function makeText(o: SdfTextOptions): SdfText {
  const t = headless ? new HeadlessText() as unknown as Text : new Text();
  t.text = o.text.slice(0, THEME.limits.textChars);
  t.fontSize = o.size ?? THEME.font.body;
  t.color = o.color ?? THEME.color.text;
  t.font = o.weight === 600 ? THEME.font.semibold : THEME.font.regular;
  t.anchorX = o.anchorX ?? 'left';
  t.anchorY = o.anchorY ?? 'middle';
  t.textAlign = o.align ?? (o.anchorX === 'center' ? 'center' : 'left');
  t.maxWidth = o.singleLine ? Infinity : o.maxWidth ?? Infinity;
  if (o.singleLine) { t.whiteSpace = 'nowrap'; t.userData.lineWidth = o.maxWidth; }
  t.lineHeight = THEME.font.lineHeight;
  t.letterSpacing = 0;
  t.depthOffset = -1;
  if (!headless) t.material = textMaterial;
  t.renderOrder = THEME.render.text;
  t.name = 'sdf';
  t.frustumCulled = false;
  syncText(t);
  return t;
}
export function setText(t: SdfText, text: string, color?: string): void {
  const next = text.slice(0, THEME.limits.textChars);
  if (t.text === next && (!color || t.color === color)) return;
  t.text = next;
  if (color) t.color = color;
  syncText(t);
}
function syncText(t: SdfText): void {
  const width = t.userData.lineWidth as number | undefined;
  t.sync(width ? () => {
    const bounds = t.textRenderInfo?.blockBounds;
    if (bounds) t.scale.setScalar(Math.min(1, width / Math.max(0.001, bounds[2] - bounds[0])));
  } : undefined);
}
export function sdfReady(): boolean { return true; }
export function whenSdfReady(): Promise<void> { return Promise.resolve(); }
