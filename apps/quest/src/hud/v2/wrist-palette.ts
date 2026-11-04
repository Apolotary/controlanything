import { Group, Matrix4, Object3D, Vector3 } from 'three';
import { Container, Text, withOpacity } from '@pmndrs/uikit';
import type { Panel } from '@pmndrs/uikit-horizon';
import type { HudFrame } from '../contract';
import type { GlassSurfaces } from './surface';
import { DockHold, HandDockAnchor } from './hand-dock';
import { FlatMaterial, glassPanel, isBrowser } from './look';
import { LOOK, THEME } from './theme';

/** One big wrist-palette button. Other lanes register theirs through `LeanHud.registerPaletteItem`. */
export interface PaletteItem {
  /** Unique key; also the button's Object3D name (e2e scripts look it up). */
  key: string;
  label: string;
  /** Lower sorts first. Built-ins: Visual synth 0, Stop 80, Exit 90, lab More 95. */
  order?: number;
  primary?: boolean;
  /** Main purpose actions are explicit; instruments and utilities live one deliberate More press away. */
  section?: 'primary' | 'more';
  /** Local navigation (More/Back) changes this palette without closing the hand menu. */
  keepOpen?: boolean;
  /** Hold for 600 ms instead of a tap (Exit). */
  hold?: boolean;
  /** Hidden while false (re-evaluated every frame). */
  visible?: () => boolean;
  onSelect: () => void;
  /** A compact segmented row instead of one button (e.g. Electronics · Objects · All); poke or pinch a segment. */
  segments?: { key: string; label: string; width: number }[];
  selected?: () => string;
  onSegment?: (key: string) => void;
  /** Legacy layout hint; the More utility grid now pairs plain feature actions automatically. */
  compactWithPrevious?: boolean;
}

/** Main purpose choices, including More. Stop all and Exit have their own persistent footer. */
export const PALETTE_MAX_ITEMS = 3;
const BUTTON_W = 0.24, BUTTON_H = 0.045, GAP = 0.004, SEGMENT_H = 0.036, PADDING = 0.01;
/**
 * Horizon look (look.ts, same as the device card and the Buddy): grayGlass plate, white = on, glass = off.
 * px = mm (LOOK.pixelSize). The palette draws above the device card and the Buddy (31-32), below the hands (101).
 */
const UI = {
  render: 33, padding: PADDING * 1000, border: 1.5, buttonFont: 19, segmentFont: 16,
  on: { bg: withOpacity('#ffffff', 0.92), hover: '#d9d9d9', pressed: '#c0c0c0', text: '#272727' },
  off: { bg: withOpacity('#ffffff', 0.08), hover: withOpacity('#ffffff', 0.16), pressed: withOpacity('#ffffff', 0.24), text: withOpacity('#ffffff', 0.92) },
} as const;
/** One uikit button face drawn under a LeanHud hit group (the group keeps the hit plane and the name). */
interface Face { group: Group; box: Container; label: Text; state: number }

/**
 * The wrist palette: deliberately raise a flat left palm and clear action rows appear beside the hand.
 * A few purpose actions lead; instruments and utilities are one More press away. Poke or pinch selects. On a
 * controller the menu button pins it; the desktop mouse fallback docks low and to the right of the view.
 * It replaces the world launcher pill, the 74 cm menu panel and the dwell recall.
 */
export class WristPalette extends Group {
  readonly anchor: HandDockAnchor;
  width = BUTTON_W + PADDING * 2;
  /** Button groups in display order; LeanHud wires a widget to each after `rebuild`. */
  buttons: Group[] = [];
  private items: PaletteItem[] = [];
  private shownKeys = '';
  private page: 'primary' | 'more' = 'primary';
  private readonly moreItem: PaletteItem = { key: 'palette-more', label: 'More', keepOpen: true,
    onSelect: () => this.setPage('more') };
  private readonly backItem: PaletteItem = { key: 'palette-back', label: 'Back', keepOpen: true,
    onSelect: () => this.resetPage() };
  /** One uikit root (one panel batch + one glyph batch) for the plate and every button face. */
  private ui?: Panel;
  private faces: Face[] = [];
  private readonly content = new Group();
  private readonly hold = new DockHold(600);
  private holdKey: string | null = null;
  private readonly wrist = new Object3D();
  /** Mouse dock: a lazy view-locked corner (lower right), so it never covers the device in the middle of the view. */
  private readonly dockOffset = new Vector3(0.3, -0.24, -0.6);
  private readonly dockTarget = new Vector3();
  private readonly dockMatrix = new Matrix4();
  private readonly dockUp = new Vector3();
  private dockPlaced = false;
  private suppressed = false;

  constructor(_surfaces: GlassSurfaces, nonDominant: 'left' | 'right' = 'left') {
    super();
    this.name = 'wrist-palette';
    this.visible = false;
    this.userData.page = this.page;
    // Beside the hand, never over it: the menu's near edge stays 3.5 cm past the knuckles so the pressing finger
    // does not crowd the menu hand (Quest loses hands that overlap).
    this.anchor = new HandDockAnchor(nonDominant, { lateral: nonDominant === 'left' ? 0.1 : -0.1, up: 0.03, toward: 0.03, clearance: 0.035 });
    this.add(this.content);
  }

  /** Add or replace an item (by key). Returns an unregister function. */
  register(item: PaletteItem): () => void {
    this.items = this.items.filter((i) => i.key !== item.key).concat(item)
      .sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
    this.shownKeys = '';
    return () => { this.items = this.items.filter((i) => i !== item); this.shownKeys = ''; };
  }

  item(key: string): PaletteItem | undefined {
    return key === this.moreItem.key ? this.moreItem : key === this.backItem.key ? this.backItem : this.items.find((i) => i.key === key);
  }

  private setPage(page: 'primary' | 'more'): void {
    if (this.page === page) return;
    this.page = page; this.userData.page = page; this.shownKeys = '';
    this.cancelExitHold();
  }
  /** A newly opened palette starts with purpose actions, not the previous utility grid. */
  resetPage(): void { this.setPage('primary'); }

  /** True when the visible item list changed and LeanHud must re-wire the buttons. */
  needsRebuild(): boolean { return this.visibleSignature() !== this.shownKeys; }

  private visibleSignature(): string { return `${this.page}:${this.visibleItems().map(i => i.key).join('|')}`; }

  private persistent(item: PaletteItem): boolean { return item.key === 'deck:panic' || item.key === 'exit-ar'; }

  /** Never discard a registered action: secondary and excess purpose actions remain on the single More page. */
  private visibleItems(): PaletteItem[] {
    const shown = this.items.filter((i) => i.visible?.() ?? true);
    const core = shown.filter(i => this.persistent(i));
    const purpose = shown.filter(i => !this.persistent(i) && i.section === 'primary');
    const hasMore = shown.some(i => !this.persistent(i) && i.section !== 'primary') || purpose.length > PALETTE_MAX_ITEMS;
    const primary = purpose.slice(0, hasMore ? PALETTE_MAX_ITEMS - 1 : PALETTE_MAX_ITEMS);
    const secondary = shown.filter(i => !this.persistent(i) && !primary.includes(i));
    if (this.page === 'more') return [this.backItem, ...secondary, ...core];
    return [...primary, ...(secondary.length ? [this.moreItem] : []), ...core];
  }

  private rows(items: PaletteItem[]): PaletteItem[][] {
    const rows: PaletteItem[][] = [];
    for (const item of items) {
      const previous = rows.at(-1);
      const footer = this.persistent(item) && !!previous?.[0] && this.persistent(previous[0]);
      const utilities = this.page === 'more' && !this.persistent(item) && !item.keepOpen
        && !!previous?.[0] && !this.persistent(previous[0]) && !previous[0].keepOpen;
      if ((footer || utilities) && !item.segments && previous?.length === 1 && !previous[0]!.segments
        && (footer || !item.hold && !previous[0]!.hold)) previous.push(item);
      else rows.push([item]);
    }
    return rows;
  }

  /** Rebuild the button column. The caller disposes the old groups' widgets first (LeanHud.clear). */
  rebuild(): Group[] {
    const shown = this.visibleItems();
    this.shownKeys = this.visibleSignature();
    this.cancelExitHold();
    const layout = this.rows(shown);
    const rows = layout.map((items) => items[0]!.segments ? SEGMENT_H : BUTTON_H);
    const height = rows.reduce((a, b) => a + b, 0) + Math.max(0, rows.length - 1) * GAP + PADDING * 2;
    const rowWidth = Math.max(BUTTON_W, ...shown.map((item) => item.segments ? item.segments.reduce((a, seg) => a + seg.width, 0) + (item.segments.length - 1) * 0.004 : 0));
    this.width = rowWidth + PADDING * 2;
    this.userData.height = height;
    const ui = this.buildUi(height);
    const buttons: Group[] = [];
    let y = height / 2 - PADDING;
    layout.forEach((items, i) => {
      const item = items[0]!;
      const rowH = rows[i]!;
      if (items.length === 2) {
        const width = (rowWidth - 0.008) / 2;
        const faces = ui ? new Container({ flexDirection: 'row', gap: 8, height: BUTTON_H * 1000, flexShrink: 0 }) : undefined;
        items.forEach((compact, index) => {
          const group = new Group(); group.name = compact.key;
          group.position.set((index - .5) * (width + .008), y - rowH / 2, THEME.panel.depth);
          group.userData.width = width; group.userData.height = BUTTON_H; group.userData.menuButton = true;
          group.userData.primary = !!compact.primary; group.userData.paletteKey = compact.key;
          this.content.add(group); buttons.push(group);
          faces?.add(this.face(group, this.actionLabel(compact), width, BUTTON_H, 18));
        });
        if (faces) ui!.add(faces);
        y -= rowH + GAP; return;
      }
      if (item.segments) {
        // Layer/filter choices fill the row; their visible faces and hit targets share the same dimensions.
        const row = new Group(); row.name = item.key; row.position.set(0, y - rowH / 2, THEME.panel.depth); this.content.add(row);
        const gaps = (item.segments.length - 1) * 0.004;
        const scale = (rowWidth - gaps) / item.segments.reduce((a, seg) => a + seg.width, 0);
        let x = -rowWidth / 2;
        for (const seg of item.segments) {
          const width = seg.width * scale;
          const group = new Group(); group.name = `${item.key}:${seg.key}`;
          group.position.set(x + width / 2, 0, 0); x += width + 0.004;
          group.userData.width = width; group.userData.height = SEGMENT_H; group.userData.menuButton = true;
          group.userData.paletteKey = item.key; group.userData.segmentKey = seg.key;
          row.add(group); buttons.push(group);
        }
        if (ui) {
          const faceRow = new Container({ flexDirection: 'row', gap: 4, height: SEGMENT_H * 1000, flexShrink: 0 });
          item.segments.forEach((seg, k) => faceRow.add(this.face(buttons[buttons.length - item.segments!.length + k]!, seg.label, seg.width * scale, SEGMENT_H, UI.segmentFont)));
          ui.add(faceRow);
        }
        y -= rowH + GAP;
        return;
      }
      const group = new Group(); group.name = item.key;
      group.position.set(0, y - BUTTON_H / 2, THEME.panel.depth);
      y -= BUTTON_H + GAP;
      group.userData.width = rowWidth; group.userData.height = BUTTON_H; group.userData.menuButton = true;
      group.userData.primary = !!item.primary; group.userData.paletteKey = item.key;
      this.content.add(group); buttons.push(group);
      if (ui) ui.add(this.face(group, this.actionLabel(item), rowWidth, BUTTON_H, UI.buttonFont));
    });
    this.buttons = buttons;
    return this.buttons;
  }

  private actionLabel(item: PaletteItem): string {
    const concise: Record<string, string> = { 'visual-synth': 'Visuals', 'musical-synth': 'Music',
      'tangible:pick': 'Use object', 'tangible:release': 'Release', 'lab-menu': 'Lab tools' };
    const label = this.page === 'more' ? concise[item.key] ?? item.label : item.label;
    return item.hold ? `${label} · hold` : label;
  }

  /** The plate: a fresh uikit root per rebuild (rare: the visible item list changed), laid out exactly like the hit groups. */
  private buildUi(height: number): Panel | undefined {
    this.disposeUi();
    if (!isBrowser) return undefined;
    // Padding + border agree with the hit layout so a visible action is the action the pinch selects.
    const ui = glassPanel({ width: this.width, height, anchorX: 'center', anchorY: 'center', padding: UI.padding - UI.border, gap: GAP * 1000,
      alignItems: 'center', renderOrder: UI.render, pointerEvents: 'none' } as never);
    ui.name = 'palette-plate';
    this.ui = ui;
    this.add(ui);
    return ui;
  }
  private face(group: Group, text: string, w: number, h: number, fontSize: number): Container {
    const box = new Container({ width: w * 1000, height: h * 1000, flexShrink: 0, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
      paddingX: 8, backgroundColor: UI.off.bg, panelMaterialClass: FlatMaterial } as never);
    const label = new Text({ text, fontSize, fontWeight: 'medium', color: UI.off.text, whiteSpace: 'nowrap' } as never);
    box.add(label);
    this.faces.push({ group, box, label, state: -1 });
    return box;
  }
  /** Paint each face from LeanHud's button feedback (hovered/pressed/selected): only on change, never a relayout. */
  private paintFaces(): void {
    for (const face of this.faces) {
      const d = face.group.userData;
      const on = !!d.primary || !!d.selected, state = (on ? 4 : 0) + (d.pressed ? 2 : d.hovered ? 1 : 0);
      if (state === face.state) continue;
      face.state = state;
      const tone = on ? UI.on : UI.off;
      face.box.setProperties({ backgroundColor: d.pressed ? tone.pressed : d.hovered ? tone.hover : tone.bg, transformScale: d.pressed ? 0.94 : 1 } as never);
      face.label.setProperties({ color: tone.text } as never);
    }
  }
  private disposeUi(): void {
    this.faces = [];
    if (!this.ui) return;
    const ui = this.ui; this.ui = undefined;
    ui.removeFromParent();
    // Collect first: disposing a component detaches it, which would break a live traverse.
    const parts: { dispose(): void }[] = [];
    ui.traverse((child) => { if (child !== ui && child instanceof Container) parts.push(child as { dispose(): void }); });
    for (const part of parts.reverse()) part.dispose();
    ui.dispose();
  }
  private holdLabel(key: string, text: string): void {
    const group = this.content.getObjectByName(key);
    const face = this.faces.find((f) => f.group === group);
    if (face && face.label.properties.peek().text !== text) face.label.setProperties({ text } as never);
  }

  get contentGroup(): Group { return this.content; }

  /** Hidden while hand control or another foreground interaction owns the hands. */
  setSuppressed(suppressed: boolean): void { this.suppressed = suppressed; }

  update(frame: HudFrame): void {
    // Segmented rows: the selected segment reads as selected (LeanHud's button feedback paints it).
    for (const group of this.buttons) {
      const key = group.userData.segmentKey as string | undefined;
      if (key) group.userData.selected = this.item(group.userData.paletteKey)?.selected?.() === key;
    }
    this.anchor.update(frame, this, this.wrist, this.width);
    if (!this.anchor.open) this.resetPage();
    if (this.anchor.source === 'mouse') this.followDock(frame);
    else this.dockPlaced = false;
    const show = !this.suppressed && this.anchor.open && this.anchor.opacity > 0.05 && this.buttons.length > 0;
    if (!show && this.visible) this.cancelExitHold();
    this.visible = show;
    // Appear: scale 0.92 → 1 with the anchor's eased opacity (xrblocks VisibilityTransition feel).
    this.scale.setScalar(0.92 + 0.08 * Math.min(1, this.anchor.opacity));
    if (show && this.ui) { this.paintFaces(); this.ui.update(Math.min(100, Math.max(0, frame.dt * 1000))); }
  }

  private followDock(frame: HudFrame): void {
    this.dockTarget.copy(this.dockOffset).applyQuaternion(frame.head.quaternion).add(frame.head.position);
    // xrblocks FollowHead: alpha = 1 - exp(-k·dt·60), here a ~0.2 s settle; the first frame snaps.
    const alpha = this.dockPlaced ? 1 - Math.exp(-0.12 * Math.min(0.1, Math.max(0, frame.dt)) * 60) : 1;
    this.position.lerp(this.dockTarget, alpha);
    this.dockMatrix.lookAt(frame.head.position, this.position, this.dockUp.set(0, 1, 0).applyQuaternion(frame.head.quaternion));
    this.quaternion.setFromRotationMatrix(this.dockMatrix);
    this.dockPlaced = true;
  }

  beginHold(key: string, time: number): void { this.holdKey = key; this.hold.begin(time); }
  cancelExitHold(): void {
    if (this.holdKey) {
      const item = this.item(this.holdKey);
      if (item) this.holdLabel(item.key, `${item.label} · hold`);
    }
    this.hold.cancel(); this.holdKey = null;
  }
  /** Returns the held item's key once its hold completes. */
  updateHold(time: number): string | null {
    if (!this.holdKey) return null;
    const fired = this.hold.update(time);
    const item = this.item(this.holdKey);
    if (item && this.hold.progress > 0) this.holdLabel(item.key, `${item.label} · ${Math.round(this.hold.progress * 100)}%`);
    return fired ? this.holdKey : null;
  }
}
