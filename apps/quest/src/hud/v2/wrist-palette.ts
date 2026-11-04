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
  /** Hold for 600 ms instead of a tap (Exit). */
  hold?: boolean;
  /** Hidden while false (re-evaluated every frame). */
  visible?: () => boolean;
  onSelect: () => void;
  /** A compact segmented row instead of one button (e.g. Electronics · Objects · All); poke or pinch a segment. */
  segments?: { key: string; label: string; width: number }[];
  selected?: () => string;
  onSegment?: (key: string) => void;
  /** A small companion action on the previous plain row (Tutorial beside Stop), preserving menu height. */
  compactWithPrevious?: boolean;
}

export const PALETTE_MAX_ITEMS = 6;
const BUTTON_W = 0.15, BUTTON_H = 0.046, GAP = 0.01, SEGMENT_H = 0.036;
/**
 * Horizon look (look.ts, same as the device card and the Buddy): grayGlass plate, white = on, glass = off.
 * px = mm (LOOK.pixelSize). The palette draws above the device card and the Buddy (31-32), below the hands (101).
 */
const UI = {
  render: 33, padding: 10, border: 1.5, buttonFont: 16, segmentFont: 13,
  on: { bg: withOpacity('#ffffff', 0.92), hover: '#d9d9d9', pressed: '#c0c0c0', text: '#272727' },
  off: { bg: withOpacity('#ffffff', 0.08), hover: withOpacity('#ffffff', 0.16), pressed: withOpacity('#ffffff', 0.24), text: withOpacity('#ffffff', 0.92) },
} as const;
/** One uikit button face drawn under a LeanHud hit group (the group keeps the hit plane and the name). */
interface Face { group: Group; box: Container; label: Text; state: number }

/**
 * The wrist palette: turn the left palm toward your face and up to five big buttons appear beside the hand
 * (Visual synth · Stop · Exit, plus registered items such as Buddy). Poke or pinch selects. On a controller,
 * the menu button pins it. In the desktop emulator (mouse) it docks low and to the left of the view.
 * It replaces the world launcher pill, the 74 cm menu panel and the dwell recall.
 */
export class WristPalette extends Group {
  readonly anchor: HandDockAnchor;
  width = BUTTON_W + 0.02;
  /** Button groups in display order; LeanHud wires a widget to each after `rebuild`. */
  buttons: Group[] = [];
  private items: PaletteItem[] = [];
  private shownKeys = '';
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

  item(key: string): PaletteItem | undefined { return this.items.find((i) => i.key === key); }

  /** True when the visible item list changed and LeanHud must re-wire the buttons. */
  needsRebuild(): boolean { return this.visibleItems().map((i) => i.key).join('|') !== this.shownKeys; }

  /** Stop and Exit (order ≥ 80) always stay; registered items fill the remaining slots in order. */
  private visibleItems(): PaletteItem[] {
    const shown = this.items.filter((i) => i.visible?.() ?? true);
    const core = shown.filter((i) => (i.order ?? 50) >= 80);
    const rest = shown.filter((i) => (i.order ?? 50) < 80).slice(0, Math.max(0, PALETTE_MAX_ITEMS - this.rows(core).length));
    return [...rest, ...core];
  }

  private rows(items: PaletteItem[]): PaletteItem[][] {
    const rows: PaletteItem[][] = [];
    for (const item of items) {
      const previous = rows.at(-1);
      if (item.compactWithPrevious && !item.hold && !item.segments && previous?.length === 1 && !previous[0]!.hold && !previous[0]!.segments) previous.push(item);
      else rows.push([item]);
    }
    return rows;
  }

  /** Rebuild the button column. The caller disposes the old groups' widgets first (LeanHud.clear). */
  rebuild(): Group[] {
    const shown = this.visibleItems();
    this.shownKeys = shown.map((i) => i.key).join('|');
    this.cancelExitHold();
    const layout = this.rows(shown);
    const rows = layout.map((items) => items[0]!.segments ? SEGMENT_H : BUTTON_H);
    const height = rows.reduce((a, b) => a + b, 0) + Math.max(0, rows.length - 1) * GAP + 0.02;
    const rowWidth = Math.max(BUTTON_W, ...shown.map((item) => item.segments ? item.segments.reduce((a, seg) => a + seg.width, 0) + (item.segments.length - 1) * 0.004 : 0));
    this.width = rowWidth + 0.02;
    this.userData.height = height;
    const ui = this.buildUi(height);
    const buttons: Group[] = [];
    let y = height / 2 - 0.01;
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
          faces?.add(this.face(group, compact.label, width, BUTTON_H, 14));
        });
        if (faces) ui!.add(faces);
        y -= rowH + GAP; return;
      }
      if (item.segments) {
        // One row of small pills; each segment is its own button (named `${key}:${segment}`).
        const row = new Group(); row.name = item.key; row.position.set(0, y - rowH / 2, THEME.panel.depth); this.content.add(row);
        const total = item.segments.reduce((a, seg) => a + seg.width, 0) + (item.segments.length - 1) * 0.004;
        let x = -total / 2;
        for (const seg of item.segments) {
          const group = new Group(); group.name = `${item.key}:${seg.key}`;
          group.position.set(x + seg.width / 2, 0, 0); x += seg.width + 0.004;
          group.userData.width = seg.width; group.userData.height = SEGMENT_H; group.userData.menuButton = true;
          group.userData.paletteKey = item.key; group.userData.segmentKey = seg.key;
          row.add(group); buttons.push(group);
        }
        if (ui) {
          const faceRow = new Container({ flexDirection: 'row', gap: 4, height: SEGMENT_H * 1000, flexShrink: 0 });
          item.segments.forEach((seg, k) => faceRow.add(this.face(buttons[buttons.length - item.segments!.length + k]!, seg.label, seg.width, SEGMENT_H, UI.segmentFont)));
          ui.add(faceRow);
        }
        y -= rowH + GAP;
        return;
      }
      const group = new Group(); group.name = item.key;
      group.position.set(0, y - BUTTON_H / 2, THEME.panel.depth);
      y -= BUTTON_H + GAP;
      group.userData.width = BUTTON_W; group.userData.height = BUTTON_H; group.userData.menuButton = true;
      group.userData.primary = !!item.primary; group.userData.paletteKey = item.key;
      this.content.add(group); buttons.push(group);
      if (ui) ui.add(this.face(group, item.hold ? `${item.label} · hold` : item.label, BUTTON_W, BUTTON_H, UI.buttonFont));
    });
    this.buttons = buttons;
    return this.buttons;
  }

  /** The plate: a fresh uikit root per rebuild (rare: the visible item list changed), laid out exactly like the hit groups. */
  private buildUi(height: number): Panel | undefined {
    this.disposeUi();
    if (!isBrowser) return undefined;
    // padding + border = 10 mm, gap = GAP: the faces land on the hit groups' centres.
    const ui = glassPanel({ width: this.width, height, anchorX: 'center', anchorY: 'center', padding: UI.padding - UI.border, gap: GAP * 1000,
      alignItems: 'center', renderOrder: UI.render, pointerEvents: 'none' } as never);
    ui.name = 'palette-plate';
    this.ui = ui;
    this.add(ui);
    return ui;
  }
  private face(group: Group, text: string, w: number, h: number, fontSize: number): Container {
    const box = new Container({ width: w * 1000, height: h * 1000, flexShrink: 0, borderRadius: 1000, alignItems: 'center', justifyContent: 'center',
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

  /** Hidden while the hands perform (the left fist is the clutch) or a panel is being moved. */
  setSuppressed(suppressed: boolean): void { this.suppressed = suppressed; }

  update(frame: HudFrame): void {
    // Segmented rows: the selected segment reads as selected (LeanHud's button feedback paints it).
    for (const group of this.buttons) {
      const key = group.userData.segmentKey as string | undefined;
      if (key) group.userData.selected = this.item(group.userData.paletteKey)?.selected?.() === key;
    }
    this.anchor.update(frame, this, this.wrist, this.width);
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
