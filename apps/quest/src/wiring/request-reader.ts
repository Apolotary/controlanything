import { Group } from 'three';
import type { WireView } from '../hud/contract';
import { readingPages } from '../hud/v2/assistant-panel';
import { GlassSurfaces } from '../hud/v2/surface';
import { makeText, setText, type SdfText } from '../hud/v2/text';
import { LOOK, THEME } from '../hud/v2/theme';
import { UIKitReader } from '../hud/v2/uikit-reader';

/** A local reading surface. It has no app, assistant, executor or message callbacks. */
export class WireRequestReader extends Group {
  readonly width = .42;
  readonly height = .42;
  readonly buttonWidth = .11;
  readonly buttonHeight = .048;
  readonly previous: Group;
  readonly next: Group;
  readonly closeButton: Group;
  readonly hitArea = new Group();
  readonly reader = new UIKitReader({ backgroundColor: LOOK.plate.bottom });
  private readonly heading = makeText({ text: 'Your full request', size: .018, weight: 600, anchorX: 'center', maxWidth: .38 });
  private readonly counter = makeText({ text: '', size: .012, color: THEME.color.muted, anchorX: 'center', maxWidth: .38 });
  private view: WireView | null = null;
  private scope = '';
  private pages: string[] = [];
  private page = 0;

  constructor(surfaces: GlassSurfaces) {
    super();
    this.name = 'wire-request-reader'; this.visible = false;
    this.hitArea.name = 'wire-request-background'; this.hitArea.position.set(0, -this.height / 2, .001);
    const plate = surfaces.create(this.width, this.height, 'plate'); plate.position.y = -this.height / 2;
    this.heading.position.set(0, -.028, .002);
    this.counter.name = 'wire-request-page'; this.counter.position.set(0, -.054, .002);
    this.reader.name = 'wire-request-text'; this.reader.position.set(-.19, -.076, .002);
    this.previous = this.button(surfaces, 'wire-request-prev', 'Previous', -.125);
    this.next = this.button(surfaces, 'wire-request-next', 'Next', 0);
    this.closeButton = this.button(surfaces, 'wire-request-return', 'Return', .125);
    this.add(plate, this.hitArea, this.heading, this.counter, this.reader, this.previous, this.next, this.closeButton);
  }

  private button(surfaces: GlassSurfaces, name: string, text: string, x: number): Group {
    const group = new Group(); group.name = name; group.position.set(x, -.385, .002);
    const label = makeText({ text, size: .014, anchorX: 'center', maxWidth: this.buttonWidth - .012, singleLine: true });
    label.position.z = .001;
    group.add(surfaces.create(this.buttonWidth, this.buttonHeight, 'button', true), label);
    return group;
  }

  get available(): boolean { return !!this.view?.code && this.view.code.request.length > 40; }
  get canOpen(): boolean { return this.available && (this.view?.phase === 'stopped' || this.view?.phase === 'failed'); }

  set(view: WireView | null): void {
    const code = view?.code;
    const scope = code ? JSON.stringify([view!.targetId, code.requestId ?? code.wiringId, code.request]) : '';
    if (scope !== this.scope) {
      this.close(); this.scope = scope; this.page = 0;
      this.pages = code ? readingPages(code.request) : [];
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
    setText(this.counter, `${this.page + 1} / ${Math.max(1, this.pages.length)}`);
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
