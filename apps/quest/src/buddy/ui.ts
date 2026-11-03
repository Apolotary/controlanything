/**
 * The buddy's two uikit surfaces in the shared Horizon look (hud/v2/look.ts):
 *  - SpeechBubble: a small glass bubble above its head; the quip types itself out, and the line under it names the
 *    Meta model that answered ("muse-spark-1.3 · 4.8 s", or "FIXTURE · recorded …" so a replay never passes as live);
 *  - BuddyCard: the quest ("Show me something green"), the collection shelf (one atlas texture) and three buttons.
 * Each is one uikit root (one panel batch + one glyph batch), renderOrder ≥ 31, depthTest off.
 */
import { Group, Mesh, MeshBasicMaterial, ShapeGeometry, Shape, type Texture } from 'three';
import { Container, Image, Text } from '@pmndrs/uikit';
import { glassPanel, horizonButton, isBrowser, LOOK } from '../hud/v2/look';
import type { Panel } from '@pmndrs/uikit-horizon';

/** wide enough for a 64-character quip in at most 3 lines at 16 px (the bubble grows upward to fit) */
const BUBBLE_W = 0.24;
const SAY_MAX = 72;

/** Never more than ~3 lines: cut at a word boundary. */
export function fitLine(text: string, n = SAY_MAX): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= n) return one;
  const cut = one.slice(0, n - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:-]+$/, '')}…`;
}
const RENDER = { bubble: 32, card: 31 } as const;

export class SpeechBubble extends Group {
  private readonly root?: Panel;
  private readonly quip?: Text;
  private readonly meta?: Text;
  private readonly tail?: Mesh;
  private full = '';
  private shown = 0;
  private typeAcc = 0;
  private visibleSince = -1;
  private hideAt = Infinity;
  private time = 0;
  private open = false;

  constructor() {
    super();
    this.name = 'buddy-bubble';
    this.visible = false;
    if (!isBrowser) return;
    this.root = glassPanel({ width: BUBBLE_W, renderOrder: RENDER.bubble, padding: 14, gap: 4, anchorY: 'bottom', borderRadius: 22 } as never);
    this.quip = new Text({ text: '', fontSize: 16, fontWeight: 'semi-bold', color: LOOK.text.primary, wordBreak: 'break-word' } as never);
    this.meta = new Text({ text: '', fontSize: 10, fontWeight: 'medium', color: LOOK.text.secondary } as never);
    this.root.add(this.quip, this.meta);
    this.add(this.root);
    // a little tail pointing down at the buddy
    const s = new Shape();
    s.moveTo(-0.009, 0); s.lineTo(0.009, 0); s.lineTo(0, -0.011); s.closePath();
    this.tail = new Mesh(new ShapeGeometry(s), new MeshBasicMaterial({ color: LOOK.plate.bottom, transparent: true, opacity: LOOK.plate.alpha, depthTest: false, depthWrite: false }));
    this.tail.renderOrder = RENDER.bubble;
    this.tail.position.set(0.04, 0.0005, 0);
    this.add(this.tail);
  }

  get uiRoot(): { update(dtMs: number): void } | undefined { return this.root; }

  /** Say a line for `holdS` seconds (Infinity = until replaced). */
  say(text: string, meta = '', holdS = 7): void {
    text = fitLine(text);
    this.full = text;
    this.shown = 0;
    this.typeAcc = 0;
    this.quip?.setProperties({ text: '' });
    this.meta?.setProperties({ text: meta });
    this.userData.text = text;
    this.userData.meta = meta;
    if (!this.open) this.visibleSince = this.time;
    this.open = true;
    this.hideAt = this.time + holdS + text.length / 40;
  }

  hide(): void {
    this.open = false;
  }

  /** Point the tail at the mascot from wherever the bubble sits. */
  setTail(x: number): void {
    this.tail?.position.setX(x);
  }

  update(dtMs: number): void {
    const dt = dtMs / 1000;
    this.time += dt;
    if (this.open && this.time > this.hideAt) this.open = false;
    this.visible = this.open;
    if (!this.open) return;
    if (this.shown < this.full.length) {
      this.typeAcc += dt * 70;
      // re-layout at most every ~3 characters (uikit text layout is not free)
      if (this.typeAcc >= 3 || this.shown + this.typeAcc >= this.full.length) {
        this.shown = Math.min(this.full.length, this.shown + Math.floor(this.typeAcc));
        this.typeAcc -= Math.floor(this.typeAcc);
        this.quip?.setProperties({ text: this.full.slice(0, this.shown) });
      }
    }
    const t = Math.min(1, (this.time - this.visibleSince) / LOOK.motion.appearS);
    const sc = 0.85 + 0.15 * (1 - (1 - t) ** 3);
    this.scale.setScalar(sc);
    this.root?.update(Math.min(100, dtMs));
  }
}

export interface CardHandlers { show(): void; skip(): void; close(): void }

export class BuddyCard extends Group {
  readonly widthM = LOOK.card.width * LOOK.pixelSize;
  private readonly root?: Panel;
  private readonly title?: Text;
  private readonly subtitle?: Text;

  constructor(shelfTexture: Texture | null, handlers: CardHandlers) {
    super();
    this.name = 'buddy-card';
    if (!isBrowser) return;
    // one row: quest + buttons on the left, the 3×2 collection shelf on the right (wide and short = less neck tilt)
    this.root = glassPanel({ width: this.widthM, renderOrder: RENDER.card, padding: 14, gap: 12, flexDirection: 'row', alignItems: 'center', anchorX: 'right', anchorY: 'center' } as never);
    const left = new Container({ flexDirection: 'column', gap: 8, flexGrow: 1, flexShrink: 1, flexBasis: 0 });
    const kicker = new Text({ text: 'QUEST', fontSize: 10, fontWeight: 'semi-bold', color: LOOK.text.secondary, letterSpacing: 0.8 } as never);
    this.title = new Text({ text: '', fontSize: 16, fontWeight: 'semi-bold', color: LOOK.text.primary, wordBreak: 'break-word' } as never);
    this.subtitle = new Text({ text: '', fontSize: 11, fontWeight: 'medium', color: LOOK.text.secondary } as never);
    const row = new Container({ flexDirection: 'row', gap: 6, marginTop: 2 });
    const show = horizonButton('Show', { icon: 'eye', variant: 'primary', size: 'sm', onClick: () => handlers.show() } as never);
    show.name = 'buddy-show';
    const skip = horizonButton('', { icon: 'retry', size: 'sm', width: 40, paddingX: 0, justifyContent: 'center', onClick: () => handlers.skip() } as never);
    skip.name = 'buddy-skip';
    const close = horizonButton('', { icon: 'cancel', size: 'sm', width: 40, paddingX: 0, justifyContent: 'center', onClick: () => handlers.close() } as never);
    close.name = 'buddy-close';
    row.add(show, skip, close);
    left.add(kicker, this.title, this.subtitle, row);
    this.root.add(left);
    if (shelfTexture) {
      const shelf = new Image({ src: shelfTexture, width: 141, height: 94, flexShrink: 0, objectFit: 'fill', keepAspectRatio: false } as never);
      shelf.name = 'buddy-shelf';
      this.root.add(shelf);
    }
    this.add(this.root);
  }

  get uiRoot(): { update(dtMs: number): void } | undefined { return this.root; }

  set(view: { quest: string; collected: number; done: number; status: string }): void {
    this.userData.view = view;
    this.title?.setProperties({ text: `Show me ${view.quest}` });
    this.subtitle?.setProperties({ text: view.status || `${view.done} done · ${view.collected} collected` });
  }

  /** Which side of the mascot the card hangs on (it grows away from the mascot). */
  setSide(side: 'left' | 'right'): void {
    this.root?.setProperties({ anchorX: side === 'left' ? 'right' : 'left' } as never);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.root?.setProperties({ visibility: v ? 'visible' : 'hidden', pointerEvents: v ? 'auto' : 'none' } as never);
  }

  update(dtMs: number): void {
    this.root?.update(Math.min(100, dtMs));
  }
}
