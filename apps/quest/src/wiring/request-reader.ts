import { Group } from 'three';
import type { WireView } from '../hud/contract';
import { GlassSurfaces } from '../hud/v2/surface';
import { makeText, setText, type SdfText } from '../hud/v2/text';
import { LOOK, THEME } from '../hud/v2/theme';
import { UIKitReader } from '../hud/v2/uikit-reader';
import readerFont from '../../public/fonts/muse-reader-inter.json';

export const REQUEST_READING = {
  width: .68, height: .52, contentWidth: .60, contentHeight: .34,
  // A short reading chunk leaves room to breathe; preserve words by paging,
  // rather than filling the panel with a dense paragraph or shrinking type.
  fontSizeMm: 28, lineHeight: 1.5, paddingMm: 18, linesPerPage: 5,
  buttonWidth: .18, buttonHeight: .064,
} as const;

const advances = new Map(readerFont.chars.map(glyph => [glyph.id, glyph.xadvance / readerFont.info.size]));
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const textWidthMm = (text: string) => Array.from(text).reduce((width, char) =>
  width + (advances.get(char.codePointAt(0)!) ?? 1.2) * REQUEST_READING.fontSizeMm, 0);

/** Measure the bundled reading font once per request, never shrink text to fit. */
export function requestReadingPages(value: string): string[] {
  // A half-em margin covers positive kerning and the system-font fallback.
  const lineWidth = REQUEST_READING.contentWidth * 1000 - REQUEST_READING.paddingMm * 2 - REQUEST_READING.fontSizeMm / 2;
  const lines: string[] = [];
  let line = '';
  for (const word of value.trim().split(/\s+/).filter(Boolean)) {
    if (textWidthMm(line ? `${line} ${word}` : word) <= lineWidth) {
      line = line ? `${line} ${word}` : word;
      continue;
    }
    if (line) { lines.push(line); line = ''; }
    // URLs/long words wrap at a grapheme boundary without cutting emoji pairs.
    for (const { segment } of segmenter.segment(word)) {
      if (line && textWidthMm(line + segment) > lineWidth) { lines.push(line); line = ''; }
      line += segment;
    }
  }
  if (line) lines.push(line);
  return Array.from({ length: Math.max(1, Math.ceil(lines.length / REQUEST_READING.linesPerPage)) }, (_, i) =>
    lines.slice(i * REQUEST_READING.linesPerPage, (i + 1) * REQUEST_READING.linesPerPage).join('\n'));
}

/** A local reading surface. It has no app, assistant, executor or message callbacks. */
export class WireRequestReader extends Group {
  readonly width = REQUEST_READING.width;
  readonly height = REQUEST_READING.height;
  readonly buttonWidth = REQUEST_READING.buttonWidth;
  readonly buttonHeight = REQUEST_READING.buttonHeight;
  readonly previous: Group;
  readonly next: Group;
  readonly closeButton: Group;
  readonly hitArea = new Group();
  readonly reader = new UIKitReader({ backgroundColor: LOOK.plate.bottom,
    width: REQUEST_READING.contentWidth, height: REQUEST_READING.contentHeight,
    fontSizeMm: REQUEST_READING.fontSizeMm, lineHeight: REQUEST_READING.lineHeight, paddingMm: REQUEST_READING.paddingMm });
  private readonly heading = makeText({ text: 'Your request', size: .023, weight: 600, anchorX: 'left', maxWidth: .38 });
  private readonly counter = makeText({ text: '', size: .016, color: THEME.color.muted, anchorX: 'right', maxWidth: .18 });
  private view: WireView | null = null;
  private scope = '';
  private pages: string[] = [];
  private page = 0;

  constructor(surfaces: GlassSurfaces) {
    super();
    this.name = 'wire-request-reader'; this.visible = false;
    this.hitArea.name = 'wire-request-background'; this.hitArea.position.set(0, -this.height / 2, .001);
    const plate = surfaces.create(this.width, this.height, 'plate'); plate.position.y = -this.height / 2;
    this.heading.position.set(-.30, -.040, .002);
    this.counter.name = 'wire-request-page'; this.counter.position.set(.30, -.040, .002);
    this.reader.name = 'wire-request-text'; this.reader.position.set(-.30, -.094, .002);
    this.previous = this.button(surfaces, 'wire-request-prev', 'Back', -.21);
    this.next = this.button(surfaces, 'wire-request-next', 'Next', 0);
    this.closeButton = this.button(surfaces, 'wire-request-return', 'Close', .21);
    this.add(plate, this.hitArea, this.heading, this.counter, this.reader, this.previous, this.next, this.closeButton);
  }

  private button(surfaces: GlassSurfaces, name: string, text: string, x: number): Group {
    const group = new Group(); group.name = name; group.position.set(x, -.476, .002);
    const label = makeText({ text, size: .020, anchorX: 'center', maxWidth: this.buttonWidth - .020, singleLine: true });
    label.position.z = .001;
    const plate = surfaces.create(this.buttonWidth, this.buttonHeight, 'button');
    plate.name = 'button-plate'; // Existing HUD hover/press feedback works for reading controls too.
    group.add(plate, label);
    return group;
  }

  get available(): boolean { return !!this.view?.code && this.view.code.request.length > 40; }
  get canOpen(): boolean { return this.available && (this.view?.phase === 'stopped' || this.view?.phase === 'failed'); }

  set(view: WireView | null): void {
    const code = view?.code;
    const scope = code ? JSON.stringify([view!.targetId, code.requestId ?? code.wiringId, code.request]) : '';
    if (scope !== this.scope) {
      this.close(); this.scope = scope; this.page = 0;
      this.pages = code ? requestReadingPages(code.request) : [];
    }
    this.view = view;
    // A new request may arrive before its first progress/wiring ID. Closing is
    // presentation only; it never stops, starts or resumes a program.
    if (!this.canOpen) this.close();
    this.draw();
  }

  open(): boolean {
    if (!this.canOpen) return false;
    this.page = 0; this.visible = true; this.draw(); return true;
  }
  close(): void { this.visible = false; }
  previousPage(): void { if (this.visible) { this.page = Math.max(0, this.page - 1); this.draw(); } }
  nextPage(): void { if (this.visible) { this.page = Math.min(this.pages.length - 1, this.page + 1); this.draw(); } }

  private draw(): void {
    this.reader.setText(this.pages[this.page] ?? '');
    this.previous.userData.disabled = this.page === 0;
    this.next.userData.disabled = this.page >= this.pages.length - 1;
    this.previous.visible = !this.previous.userData.disabled;
    this.next.visible = !this.next.userData.disabled;
    this.next.userData.primary = this.next.visible;
    this.closeButton.userData.primary = !this.next.visible;
    setText(this.counter, this.pages.length > 1 ? `${this.page + 1} of ${this.pages.length}` : '');
    this.userData.reading = { targetId: this.view?.targetId, requestId: this.view?.code?.requestId,
      page: this.page, pages: this.pages.length, text: this.reader.text };
  }

  updateUi(deltaMs: number): void { this.reader.visible = this.visible; this.reader.updateUi(deltaMs); }
  disposeUi(): void {
    this.reader.disposeUi();
    this.traverse(o => { if ('sync' in o && 'dispose' in o) (o as SdfText).dispose(); });
    this.clear();
  }
}
