import { CanvasTexture, Group, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace, type WebGLRenderer } from 'three';
import { Container, Text, reversePainterSortStable } from '@pmndrs/uikit';
import { makeText, setText, type SdfText } from './text';
import { THEME } from './theme';
import readerCoverage from '../../../public/fonts/muse-reader-coverage.json';

const readerGlyphs = new Set(readerCoverage);
const readerFonts = { muse: { medium: '/quest/fonts/muse-reader-inter.json' } };
export const needsSystemReaderFont = (text: string): boolean => Array.from(text).some((char) => !/\s/u.test(char) && !readerGlyphs.has(char.codePointAt(0)!));

/** UIKit keeps its own internal panel/text order; legacy HUD layers keep theirs. */
export function configureAssistantRenderer(renderer: WebGLRenderer): void {
  renderer.localClippingEnabled = true;
  // The headless HUD fixture intentionally supplies no renderer methods.
  renderer.setTransparentSort?.(reversePainterSortStable);
}

export interface ReaderLayout {
  renderer: 'uikit' | 'headless';
  ready: boolean;
  width: number;
  height: number;
  contentHeight: number;
  overflow: boolean;
  font: 'local-inter' | 'system-fallback';
}

export interface ReaderOptions {
  backgroundColor?: string;
  width?: number;
  height?: number;
  fontSizeMm?: number;
  lineHeight?: number;
  paddingMm?: number;
}

/**
 * A bounded, native spatial reading surface. Navigation belongs to LeanHud:
 * this component deliberately installs no pointer/session owner. The npm-bundled
 * Inter atlas is generated at build time from our existing licensed font. Text
 * outside that atlas uses the browser's system-font canvas, never a font CDN.
 */
export class UIKitReader extends Group {
  readonly maxWidth: number;
  readonly maxHeight: number;
  text = '';
  private readonly panel?: Container;
  private readonly content?: Text;
  private readonly fallback?: SdfText;
  private disposed = false;
  private lastVisibility?: boolean;
  private systemCanvas?: HTMLCanvasElement;
  private systemText?: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private systemTexture?: CanvasTexture;
  private systemContentHeight = 0;
  private readonly fontSizeMm: number;
  private readonly systemFontSizeMm: number;
  private readonly lineHeight: number;
  private readonly paddingMm: number;

  constructor(options: ReaderOptions = {}) {
    super();
    this.maxWidth = options.width ?? .38;
    this.maxHeight = options.height ?? .28;
    this.fontSizeMm = options.fontSizeMm ?? 16.5;
    // Preserve the older assistant's system-font size; focused readers opt in.
    this.systemFontSizeMm = options.fontSizeMm ?? 15;
    this.lineHeight = options.lineHeight ?? 1.25;
    this.paddingMm = options.paddingMm ?? 8;
    this.name = 'object-info-detail';
    this.userData.fitWidth = this.maxWidth;
    this.userData.fitHeight = this.maxHeight;
    if (typeof document === 'undefined') {
      this.fallback = makeText({ text: '', size: options.fontSizeMm === undefined ? THEME.font.body : this.fontSizeMm / 1000,
        maxWidth: this.maxWidth, anchorY: 'top' });
      this.add(this.fallback);
      return;
    }
    this.panel = new Container({
      sizeX: this.maxWidth, sizeY: this.maxHeight, pixelSize: 0.001,
      anchorX: 'left', anchorY: 'top', flexDirection: 'column',
      padding: this.paddingMm, overflow: 'hidden', borderRadius: 8,
      backgroundColor: options.backgroundColor ?? '#14212F', opacity: 1,
      depthTest: false, depthWrite: false, renderOrder: THEME.render.text,
      pointerEvents: 'none', fontFamilies: readerFonts, fontFamily: 'muse',
    });
    this.content = new Text({
      text: '', width: '100%', flexShrink: 0,
      fontSize: this.fontSizeMm, lineHeight: `${this.lineHeight * 100}%`, fontWeight: 'medium',
      fontFamilies: readerFonts, fontFamily: 'muse',
      color: THEME.color.text, whiteSpace: 'pre-line', wordBreak: 'break-word',
      depthTest: false, depthWrite: false, pointerEvents: 'none',
    });
    this.panel.add(this.content);
    this.add(this.panel);
  }

  setText(value: string): void {
    if (this.disposed || this.text === value) return;
    // Text is already partitioned by readingPages; unlike the old SDF path this
    // does not silently slice at THEME.limits.textChars or scale down to fit.
    this.text = value;
    if (this.fallback) setText(this.fallback, value);
    const system = needsSystemReaderFont(value);
    this.content?.setProperties({ text: system ? '' : value });
    if (this.systemText) this.systemText.visible = system;
    if (system && this.panel) this.drawSystemText(value);
  }

  private drawSystemText(value: string): void {
    const canvas = this.systemCanvas ??= document.createElement('canvas');
    const innerWidth = this.maxWidth - this.paddingMm * .002;
    const innerHeight = this.maxHeight - this.paddingMm * .002;
    canvas.width = Math.round(innerWidth * 2000); canvas.height = Math.round(innerHeight * 2000);
    const context = canvas.getContext('2d');
    if (!context) return;
    const fontPx = this.systemFontSizeMm * 2, linePx = fontPx * this.lineHeight;
    context.font = `${fontPx}px sans-serif`; context.fillStyle = THEME.color.text; context.textBaseline = 'top';
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const lines: string[] = [];
    for (const paragraph of value.split('\n')) {
      let line = '';
      for (const { segment } of segmenter.segment(paragraph)) {
        if (line && context.measureText(line + segment).width > canvas.width) { lines.push(line); line = ''; }
        line += segment;
      }
      lines.push(line);
    }
    lines.forEach((line, index) => context.fillText(line, 0, index * linePx));
    this.systemContentHeight = lines.length * linePx / 2000;
    if (!this.systemText) {
      this.systemTexture = new CanvasTexture(canvas); this.systemTexture.colorSpace = SRGBColorSpace;
      this.systemText = new Mesh(new PlaneGeometry(innerWidth, innerHeight), new MeshBasicMaterial({ map: this.systemTexture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
      this.systemText.name = 'reader-system-font'; this.systemText.position.set(this.maxWidth / 2, -this.maxHeight / 2, 0.001);
      this.systemText.renderOrder = THEME.render.text + 1; this.systemText.raycast = () => {};
      this.add(this.systemText);
    }
    this.systemText.visible = true;
    this.systemTexture!.needsUpdate = true;
  }

  updateUi(deltaMs: number): void {
    if (this.disposed) return;
    // Root update is required even when no interaction occurred: font completion
    // and Yoga layout are asynchronous, and hidden roots must track visibility.
    if (this.lastVisibility !== this.visible) {
      this.lastVisibility = this.visible;
      this.panel?.setProperties({ visibility: this.visible ? 'visible' : 'hidden' });
    }
    this.panel?.update(Number.isFinite(deltaMs) ? Math.min(100, Math.max(0, deltaMs)) : 0);
    this.userData.layout = this.layout;
  }

  get layout(): ReaderLayout {
    const size = this.panel?.size.peek(), contentSize = this.content?.size.peek();
    const system = needsSystemReaderFont(this.text);
    const contentHeight = system ? this.systemContentHeight : contentSize ? contentSize[1] * 0.001 : 0;
    return {
      renderer: this.panel ? 'uikit' : 'headless',
      ready: this.panel ? !!size && (system ? !!this.systemText : !!this.content?.fontSignal.peek()) : true,
      width: size ? size[0] * 0.001 : this.maxWidth,
      height: size ? size[1] * 0.001 : this.maxHeight,
      contentHeight,
      overflow: contentHeight > this.maxHeight - this.paddingMm * .002 + .0001,
      font: system ? 'system-fallback' : 'local-inter',
    };
  }

  disposeUi(): void {
    if (this.disposed) return;
    this.disposed = true;
    // UIKit dispose is intentionally non-recursive.
    this.content?.dispose(); this.panel?.dispose();
    this.systemText?.geometry.dispose(); this.systemText?.material.dispose(); this.systemTexture?.dispose();
    this.fallback?.dispose();
    this.clear();
  }
}
