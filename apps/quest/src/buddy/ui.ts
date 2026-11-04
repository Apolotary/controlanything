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

  /** Change only the small line under the quip (e.g. the elapsed seconds while Muse thinks), without retyping. */
  setMeta(meta: string): void {
    if (this.userData.meta === meta) return;
    this.userData.meta = meta;
    this.meta?.setProperties({ text: meta });
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

export interface CardHandlers { show(): void; retake(): void; wave(): void; virtual(): void; close(): void }
export interface CardView {
  kicker: string;
  title: string;
  status: string;
  preview: boolean;
  busy: boolean;
}

export class BuddyCard extends Group {
  readonly widthM = LOOK.card.width * LOOK.pixelSize;
  private readonly root?: Panel;
  private readonly kicker?: Text;
  private readonly title?: Text;
  private readonly subtitle?: Text;
  private readonly capture?: Container;
  private readonly retake?: Container;

  constructor(shelfTexture: Texture | null, handlers: CardHandlers) {
    super();
    this.name = 'buddy-card';
    if (!isBrowser) return;
    // one row: quest + buttons on the left, the 3×2 collection shelf on the right (wide and short = less neck tilt)
    this.root = glassPanel({ width: this.widthM, renderOrder: RENDER.card, padding: 14, gap: 12, flexDirection: 'row', alignItems: 'center', anchorX: 'right', anchorY: 'center' } as never);
    const left = new Container({ flexDirection: 'column', gap: 8, flexGrow: 1, flexShrink: 1, flexBasis: 0 });
    this.kicker = new Text({ text: 'MUSE BUDDY', fontSize: 10, fontWeight: 'semi-bold', color: LOOK.text.secondary, letterSpacing: 0.8 } as never);
    this.title = new Text({ text: '', fontSize: 16, fontWeight: 'semi-bold', color: LOOK.text.primary, wordBreak: 'break-word' } as never);
    this.subtitle = new Text({ text: '', fontSize: 11, fontWeight: 'medium', color: LOOK.text.secondary } as never);
    const row = new Container({ flexDirection: 'row', gap: 6, marginTop: 2 });
    this.capture = horizonButton('Capture', { icon: 'eye', variant: 'primary', size: 'sm', onClick: () => handlers.show() } as never);
    this.capture.name = 'buddy-show';
    this.retake = horizonButton('Retake', { size: 'sm', display: 'none', onClick: () => handlers.retake() } as never);
    this.retake.name = 'buddy-retake';
    const virtual = horizonButton('Virtual', { size: 'sm', onClick: () => handlers.virtual() } as never);
    virtual.name = 'buddy-virtual';
    row.add(this.capture, this.retake, virtual);
    const social = new Container({ flexDirection: 'row', gap: 6 });
    const wave = horizonButton('Wave hello', { size: 'sm', onClick: () => handlers.wave() } as never);
    wave.name = 'buddy-wave';
    const close = horizonButton('Close', { size: 'sm', onClick: () => handlers.close() } as never);
    close.name = 'buddy-close'; social.add(wave, close);
    left.add(this.kicker, this.title, this.subtitle, row, social);
    this.root.add(left);
    if (shelfTexture) {
      const shelf = new Image({ src: shelfTexture, width: 104, height: 70, flexShrink: 0, objectFit: 'fill', keepAspectRatio: false } as never);
      shelf.name = 'buddy-shelf';
      this.root.add(shelf);
    }
    this.add(this.root);
  }

  get uiRoot(): { update(dtMs: number): void } | undefined { return this.root; }

  set(view: CardView): void {
    const prev = this.userData.view as CardView | undefined;
    this.userData.view = view;
    if (prev?.kicker !== view.kicker) this.kicker?.setProperties({ text: view.kicker });
    if (prev?.title !== view.title) this.title?.setProperties({ text: view.title });
    if (prev?.status !== view.status) this.subtitle?.setProperties({ text: view.status });
    if (prev?.preview !== view.preview || prev?.busy !== view.busy) {
      // horizonButton owns its text child; update that label without rebuilding the panel.
      let label: Text | undefined; this.capture?.traverse(child => { if (!label && child instanceof Text) label = child as Text; });
      label?.setProperties({ text: view.preview ? 'Show Buddy' : view.busy ? 'Looking…' : 'Capture' });
      this.capture?.setProperties({ pointerEvents: view.busy ? 'none' : 'auto', opacity: view.busy ? .55 : 1 } as never);
      this.retake?.setProperties({ display: view.preview ? 'flex' : 'none' } as never);
    }
  }

  /** The shelf's centre in the card's own frame (metres): the right end of the row. */
  shelfLocal(side: 'left' | 'right'): number {
    const fromRightEdge = 0.014 + 0.0705;
    return side === 'left' ? -fromRightEdge : this.widthM - fromRightEdge;
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
