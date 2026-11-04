/**
 * The tutorial's one speech bubble in the Horizon look (hud/v2/look.ts, like the Buddy bubble and the device card):
 * one uikit root (one panel batch + one glyph batch), 22 cm wide, a step counter "2/6", a small Skip button,
 * a short title and at most one detail line, an optional pinch glyph, and a little tail pointing at what it explains.
 *
 * Cost: texts change only when the step changes (a relayout per step, never per frame). While hidden, nothing
 * updates. The plate ignores pointers (pointerEvents none) so it can never swallow a pinch meant for a box or a dial;
 * only Skip takes hits.
 */
import { Group, Mesh, MeshBasicMaterial, Shape, ShapeGeometry } from 'three';
import { Container, Text, withOpacity } from '@pmndrs/uikit';
import type { Button, Panel } from '@pmndrs/uikit-horizon';
import { glassPanel, horizonButton, isBrowser, LOOK } from '../hud/v2/look';

/** Metres. The brief caps it at 22 cm. */
export const BUBBLE_W = 0.22;
/** Drawn at 75 % (about 16.5 cm wide) so it stays out of the way of the device and the demo. */
const BUBBLE_SCALE = 0.75;
/** Above the device card (30-31), the Buddy (31-32) and the palette (33); below the hands (101). It never overlaps them. */
const RENDER = 34;
const APPEAR_S = LOOK.motion.appearS;
const LEAVE_S = 0.18;

export type TailSide = 'none' | 'left' | 'right' | 'down';
export interface BubbleView {
  /** "2/6" */
  counter: string;
  title: string;
  detail?: string;
  /** a small animated pinch (thumb + index meeting) beside the text */
  pinch?: boolean;
  /** which edge the tail sits on (it points from there at the thing explained) */
  tail: TailSide;
  /** "Skip" (or "Close" on the last bubble) */
  skipLabel?: string;
}

export class TutorialBubble extends Group {
  private readonly root?: Panel;
  private readonly counter?: Text;
  private readonly title?: Text;
  private readonly detail?: Text;
  private readonly skip?: Button;
  private readonly skipText?: Text;
  private readonly glyph?: Container;
  private readonly thumb?: Container;
  private readonly index?: Container;
  private readonly tail?: Mesh;
  private viewKey = '';
  private tailSide: TailSide = 'none';
  private tailHeight = -1;
  private time = 0;
  /** 0 → 1 while appearing, 1 while shown, 1 → 0 while leaving */
  private phase: 'hidden' | 'in' | 'shown' | 'out' = 'hidden';
  private phaseAt = 0;
  private opacityShown = -1;
  private glyphAt = -1;
  private pinchOn = false;

  constructor(onSkip: () => void) {
    super();
    this.name = 'tutorial-bubble';
    this.visible = false;
    if (!isBrowser) return;
    this.root = glassPanel({ width: BUBBLE_W, renderOrder: RENDER, padding: 12, gap: 6, borderRadius: 20, anchorX: 'center', anchorY: 'center',
      pointerEvents: 'none' } as never);
    this.root.name = 'tutorial-bubble-plate';
    const header = new Container({ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 26 } as never);
    this.counter = new Text({ text: '', fontSize: 11, fontWeight: 'semi-bold', color: LOOK.text.secondary, letterSpacing: 0.6 } as never);
    this.skip = horizonButton('', { variant: 'secondary', size: 'sm', height: 26, minWidth: 0, paddingX: 12, pointerEvents: 'auto',
      backgroundColor: withOpacity('#ffffff', 0.1), onClick: () => onSkip() } as never);
    this.skip.name = 'tutorial-skip';
    this.skipText = new Text({ text: 'Skip', fontSize: 12, fontWeight: 'medium', color: LOOK.text.primary, whiteSpace: 'nowrap' } as never);
    this.skip.add(this.skipText);
    header.add(this.counter, this.skip);
    const body = new Container({ flexDirection: 'row', alignItems: 'center', gap: 10 } as never);
    // The pinch glyph: thumb and index tips that meet in the middle and part again (moved with transforms, no relayout).
    this.glyph = new Container({ width: 34, height: 34, flexShrink: 0, borderRadius: 1000, display: 'none',
      backgroundColor: withOpacity('#ffffff', 0.08) } as never);
    this.thumb = new Container({ positionType: 'absolute', positionLeft: 13, positionTop: 13, width: 8, height: 8, borderRadius: 4,
      backgroundColor: '#ffffff' } as never);
    this.index = new Container({ positionType: 'absolute', positionLeft: 13, positionTop: 13, width: 8, height: 8, borderRadius: 4,
      backgroundColor: '#ffffff' } as never);
    this.glyph.add(this.thumb, this.index);
    const texts = new Container({ flexDirection: 'column', gap: 3, flexGrow: 1, flexShrink: 1, flexBasis: 0 } as never);
    this.title = new Text({ text: '', fontSize: 16, fontWeight: 'semi-bold', color: LOOK.text.primary, wordBreak: 'break-word' } as never);
    this.detail = new Text({ text: '', fontSize: 12, fontWeight: 'medium', color: LOOK.text.secondary, wordBreak: 'break-word' } as never);
    texts.add(this.title, this.detail);
    body.add(this.glyph, texts);
    this.root.add(header, body);
    this.add(this.root);
    // The tail: a small triangle in the plate's bottom tone, on the edge facing the thing explained.
    const s = new Shape();
    s.moveTo(0, -0.011); s.lineTo(0, 0.011); s.lineTo(0.013, 0); s.closePath();
    this.tail = new Mesh(new ShapeGeometry(s), new MeshBasicMaterial({ color: LOOK.plate.bottom, transparent: true, opacity: LOOK.plate.alpha,
      depthTest: false, depthWrite: false }));
    this.tail.name = 'tutorial-bubble-tail';
    this.tail.renderOrder = RENDER;
    this.tail.visible = false;
    this.add(this.tail);
  }

  get shown(): boolean { return this.phase === 'in' || this.phase === 'shown'; }
  get hidden(): boolean { return this.phase === 'hidden'; }
  /** Height of the laid-out plate in metres (an estimate before the first layout). */
  get heightM(): number { return (this.root?.size.peek()?.[1] ?? 90) * LOOK.pixelSize; }

  /** Change the content. Only a real change touches uikit (one relayout). */
  set(view: BubbleView): void {
    const key = `${view.counter}|${view.title}|${view.detail ?? ''}|${view.pinch ? 1 : 0}|${view.skipLabel ?? ''}`;
    this.tailSide = view.tail;
    this.tailHeight = -1;
    if (key === this.viewKey) return;
    this.viewKey = key;
    this.userData.view = { ...view };
    this.counter?.setProperties({ text: view.counter } as never);
    this.title?.setProperties({ text: view.title } as never);
    this.detail?.setProperties({ text: view.detail ?? '', display: view.detail ? 'flex' : 'none' } as never);
    this.skipText?.setProperties({ text: view.skipLabel ?? 'Skip' } as never);
    if (this.pinchOn !== !!view.pinch) {
      this.pinchOn = !!view.pinch;
      this.glyph?.setProperties({ display: this.pinchOn ? 'flex' : 'none' } as never);
    }
  }

  /** A quiet "done" beat before leaving: the title gains a check. */
  markDone(): void {
    const view = this.userData.view as BubbleView | undefined;
    if (!view || view.title.startsWith('✓')) return;
    this.set({ ...view, title: `✓ ${view.title}`, pinch: false });
  }

  show(): void {
    if (this.phase === 'in' || this.phase === 'shown') return;
    // From a partial fade-out, appear again from where the fade had got to.
    const from = this.phase === 'out' ? this.progress() : 0;
    this.phase = 'in';
    this.phaseAt = this.time - from * APPEAR_S;
    this.visible = true;
    this.root?.setProperties({ visibility: 'visible' } as never);
  }

  hide(): void {
    if (this.phase === 'hidden' || this.phase === 'out') return;
    const from = this.progress();
    this.phase = 'out';
    this.phaseAt = this.time - (1 - from) * LEAVE_S;
  }

  /** Drop at once (no fade): leaving AR, a reset. */
  hideNow(): void {
    this.phase = 'hidden';
    this.visible = false;
    this.root?.setProperties({ visibility: 'hidden' } as never);
  }

  /** 0..1 visible amount for the current phase. */
  private progress(): number {
    if (this.phase === 'hidden') return 0;
    if (this.phase === 'shown') return 1;
    if (this.phase === 'in') return Math.min(1, (this.time - this.phaseAt) / APPEAR_S);
    return Math.max(0, 1 - (this.time - this.phaseAt) / LEAVE_S);
  }

  update(dtMs: number): void {
    this.time += dtMs / 1000;
    if (this.phase === 'hidden') return;
    let p = this.progress();
    if (this.phase === 'in' && p >= 1) this.phase = 'shown';
    if (this.phase === 'out' && p <= 0) { this.hideNow(); return; }
    // xrblocks VisibilityTransition feel: ease-out scale 0.9 → 1 with a fade; opacity is written only while it changes.
    const eased = 1 - (1 - p) ** 3;
    this.scale.setScalar(BUBBLE_SCALE * (0.9 + 0.1 * eased));
    p = Math.round(eased * 20) / 20;
    if (p !== this.opacityShown) {
      this.opacityShown = p;
      this.root?.setProperties({ opacity: p } as never);
      if (this.tail) (this.tail.material as MeshBasicMaterial).opacity = LOOK.plate.alpha * p;
    }
    this.placeTail();
    this.animateGlyph();
    this.root?.update(Math.min(100, dtMs));
  }

  private placeTail(): void {
    if (!this.tail) return;
    const h = this.heightM;
    if (Math.abs(h - this.tailHeight) < 1e-4) return;
    this.tailHeight = h;
    const w = BUBBLE_W;
    this.tail.visible = this.tailSide !== 'none';
    if (this.tailSide === 'right') { this.tail.position.set(w / 2 - 0.001, 0, 0); this.tail.rotation.z = 0; }
    else if (this.tailSide === 'left') { this.tail.position.set(-w / 2 + 0.001, 0, 0); this.tail.rotation.z = Math.PI; }
    else if (this.tailSide === 'down') { this.tail.position.set(0, -h / 2 + 0.001, 0); this.tail.rotation.z = -Math.PI / 2; }
  }

  /** ~20 Hz: thumb and index slide together (pinch), hold, and part. Transform-only, so uikit does not relayout. */
  private animateGlyph(): void {
    if (!this.pinchOn || !this.thumb || !this.index) return;
    if (this.time - this.glyphAt < 0.05) return;
    this.glyphAt = this.time;
    const cycle = (this.time % 1.4) / 1.4;
    // apart 0-0.35, closing 0.35-0.55, pinched 0.55-0.8, opening 0.8-1
    const closed = cycle < 0.35 ? 0 : cycle < 0.55 ? (cycle - 0.35) / 0.2 : cycle < 0.8 ? 1 : 1 - (cycle - 0.8) / 0.2;
    const apart = 9 * (1 - closed);
    this.thumb.setProperties({ transformTranslateX: -apart, transformTranslateY: apart * 0.8 } as never);
    this.index.setProperties({ transformTranslateX: apart, transformTranslateY: -apart * 0.8 } as never);
  }

  override dispose(): void {
    this.hideNow();
    const parts: { dispose(): void }[] = [];
    this.root?.traverse(child => { if (child instanceof Container && child !== this.root) parts.push(child); });
    for (const part of parts.reverse()) part.dispose();
    this.root?.dispose();
    this.tail?.geometry.dispose();
    (this.tail?.material as MeshBasicMaterial | undefined)?.dispose();
    this.removeFromParent();
  }
}
