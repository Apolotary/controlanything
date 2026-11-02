import { BufferGeometry, Float32BufferAttribute, Mesh, MeshBasicMaterial } from 'three';
import { Text } from 'troika-three-text';
import { THEME } from './theme';

export interface SdfTextOptions {
  text: string;
  size?: number;
  color?: string;
  weight?: 400 | 500 | 600;
  /** Semibold Inter with its native tabular digit glyphs selected in the local font. */
  tabular?: boolean;
  anchorX?: 'left' | 'center' | 'right';
  anchorY?: 'top' | 'middle' | 'bottom';
  maxWidth?: number;
  maxHeight?: number;
  outline?: boolean;
  singleLine?: boolean;
  align?: 'left' | 'center' | 'right';
}
export type SdfText = Text;
const headless = typeof document === 'undefined';
const textMaterial = new MeshBasicMaterial({ color: THEME.color.text, transparent: true, depthWrite: false, toneMapped: false });

// Exact bundled Latin glyph coverage. An unsupported name must never ask Troika's CDN fallback.
const unsupportedGlyphs = /[^\t\n\r\u0020-\u007e\u00a0-\u00ac\u00ae-\u00ff\u0131\u0152-\u0153\u02bb-\u02bc\u02c6\u02da\u02dc\u0300-\u0301\u0303-\u0304\u0308-\u0309\u0323\u2002\u2009\u200b\u2013-\u2014\u2018-\u201a\u201c-\u201e\u2022\u2026\u2032-\u2033\u2039-\u203a\u2044\u20ac\u2122\u2191\u2193\u2212\ufeff]/gu;
const remoteButtonNames: Record<string, string> = { '全灯': 'full on', '消灯': 'off', '常夜灯': 'night light', '明るく': 'brighter', '暗く': 'dimmer', '電源': 'power', '音量': 'volume' };
function localText(text: string): string {
  let translated = text.normalize('NFC')
    .replace(/Press\s+[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+\s*\(([^)]+)\)\s+once/gu, 'Press the "$1" button once')
    .replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+\s*\(([^)]+)\)/gu, '$1');
  translated = translated.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu, (name) => remoteButtonNames[name] ?? 'Device');
  return translated.trimStart().replace(unsupportedGlyphs, '').slice(0, THEME.limits.textChars);
}

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
  t.text = localText(o.text);
  t.fontSize = o.size ?? THEME.font.body;
  t.color = o.color ?? THEME.color.text;
  t.font = o.tabular ? THEME.font.tabular : o.weight === 600 ? THEME.font.semibold : o.weight === 500 ? THEME.font.medium : THEME.font.regular;
  t.anchorX = o.anchorX ?? 'left';
  t.anchorY = o.anchorY ?? 'middle';
  t.textAlign = o.align ?? (o.anchorX === 'center' ? 'center' : 'left');
  t.maxWidth = o.singleLine ? Infinity : o.maxWidth ?? Infinity;
  if (o.singleLine) { t.whiteSpace = 'nowrap'; t.userData.lineWidth = o.maxWidth; }
  if (o.maxHeight) { t.userData.fitWidth = o.maxWidth; t.userData.fitHeight = o.maxHeight; }
  t.lineHeight = THEME.font.lineHeight;
  t.letterSpacing = o.tabular ? 0 : THEME.font.letterSpacing;
  t.depthOffset = -1;
  if (!headless) t.material = textMaterial;
  t.renderOrder = THEME.render.text;
  t.name = 'sdf';
  t.frustumCulled = false;
  syncText(t);
  return t;
}
export function setText(t: SdfText, text: string, color?: string): void {
  const next = localText(text);
  if (t.text === next && (!color || t.color === color)) return;
  t.text = next;
  if (color) t.color = color;
  syncText(t);
}
function syncText(t: SdfText): void {
  const width = (t.userData.lineWidth ?? t.userData.fitWidth) as number | undefined;
  const height = t.userData.fitHeight as number | undefined;
  t.sync(width || height ? () => {
    const bounds = t.textRenderInfo?.blockBounds;
    if (bounds) t.scale.setScalar(Math.min(1, width ? width / Math.max(0.001, bounds[2] - bounds[0]) : 1, height ? height / Math.max(0.001, bounds[3] - bounds[1]) : 1));
  } : undefined);
}
export function sdfReady(): boolean { return true; }
export function whenSdfReady(): Promise<void> { return Promise.resolve(); }
