import { Group, Mesh, Object3D } from 'three';
import type { HudFrame } from '../contract';
import { GlassSurfaces } from './surface';
import { DockHold, HandDockAnchor } from './hand-dock';
import { makeText, setText, type SdfText } from './text';
import { THEME } from './theme';
import { WorldPanel } from './world-panel';

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
}

export const PALETTE_MAX_ITEMS = 6;
const BUTTON_W = 0.15, BUTTON_H = 0.046, GAP = 0.01, SEGMENT_H = 0.036;

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
  private readonly plate: Mesh;
  private readonly content = new Group();
  private readonly hold = new DockHold(600);
  private holdKey: string | null = null;
  private readonly wrist = new Object3D();
  private readonly fallback = new WorldPanel({ distance: 0.6, height: -0.2, lateral: -0.2, follow: true });
  private suppressed = false;

  constructor(private readonly surfaces: GlassSurfaces, nonDominant: 'left' | 'right' = 'left') {
    super();
    this.name = 'wrist-palette';
    this.visible = false;
    this.anchor = new HandDockAnchor(nonDominant, { lateral: nonDominant === 'left' ? 0.1 : -0.1, up: 0.03, toward: 0.03 });
    this.plate = surfaces.create(this.width, 0.1, 'plate');
    this.plate.name = 'palette-plate';
    this.add(this.plate, this.content);
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
    const rest = shown.filter((i) => (i.order ?? 50) < 80).slice(0, Math.max(0, PALETTE_MAX_ITEMS - core.length));
    return [...rest, ...core];
  }

  /** Rebuild the button column. The caller disposes the old groups' widgets first (LeanHud.clear). */
  rebuild(): Group[] {
    const shown = this.visibleItems();
    this.shownKeys = shown.map((i) => i.key).join('|');
    this.cancelExitHold();
    const rows = shown.map((item) => item.segments ? SEGMENT_H : BUTTON_H);
    const height = rows.reduce((a, b) => a + b, 0) + Math.max(0, shown.length - 1) * GAP + 0.02;
    const rowWidth = Math.max(BUTTON_W, ...shown.map((item) => item.segments ? item.segments.reduce((a, seg) => a + seg.width, 0) + (item.segments.length - 1) * 0.004 : 0));
    this.width = rowWidth + 0.02;
    this.userData.height = height;
    this.plate.scale.set(this.width, height, 1);
    this.plate.material = this.surfaces.material(this.width, height, 'plate');
    const buttons: Group[] = [];
    let y = height / 2 - 0.01;
    shown.forEach((item, i) => {
      const rowH = rows[i]!;
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
          const pill = this.surfaces.create(seg.width, SEGMENT_H, 'button', true); pill.name = 'button-plate';
          const text = makeText({ text: seg.label, size: 0.0125, weight: 600, anchorX: 'center', maxWidth: seg.width - 0.006, singleLine: true });
          text.position.z = THEME.panel.depth;
          group.add(pill, text); row.add(group); buttons.push(group);
        }
        y -= rowH + GAP;
        return;
      }
      const group = new Group(); group.name = item.key;
      group.position.set(0, y - BUTTON_H / 2, THEME.panel.depth);
      y -= BUTTON_H + GAP;
      group.userData.width = BUTTON_W; group.userData.height = BUTTON_H; group.userData.menuButton = true;
      group.userData.primary = !!item.primary; group.userData.paletteKey = item.key;
      const button = this.surfaces.create(BUTTON_W, BUTTON_H, item.primary ? 'primary' : 'button', true);
      button.name = 'button-plate';
      const text = makeText({ text: item.hold ? `${item.label} · hold` : item.label, size: 0.017, weight: 600, anchorX: 'center', maxWidth: BUTTON_W - 0.016, singleLine: true });
      text.name = 'palette-label'; text.position.z = THEME.panel.depth;
      group.add(button, text); this.content.add(group); buttons.push(group);
    });
    this.buttons = buttons;
    return this.buttons;
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
    if (this.anchor.source === 'mouse') this.fallback.update(this, frame.head, frame.time);
    const show = !this.suppressed && this.anchor.open && this.anchor.opacity > 0.05 && this.buttons.length > 0;
    if (!show && this.visible) this.cancelExitHold();
    this.visible = show;
    // Appear: scale 0.92 → 1 with the anchor's eased opacity (xrblocks VisibilityTransition feel).
    this.scale.setScalar(0.92 + 0.08 * Math.min(1, this.anchor.opacity));
  }

  beginHold(key: string, time: number): void { this.holdKey = key; this.hold.begin(time); }
  cancelExitHold(): void {
    if (this.holdKey) {
      const item = this.item(this.holdKey), label = this.content.getObjectByName(this.holdKey)?.getObjectByName('palette-label') as SdfText | undefined;
      if (item && label) setText(label, `${item.label} · hold`);
    }
    this.hold.cancel(); this.holdKey = null;
  }
  /** Returns the held item's key once its hold completes. */
  updateHold(time: number): string | null {
    if (!this.holdKey) return null;
    const fired = this.hold.update(time);
    const item = this.item(this.holdKey), label = this.content.getObjectByName(this.holdKey)?.getObjectByName('palette-label') as SdfText | undefined;
    if (item && label && this.hold.progress > 0) setText(label, `${item.label} · ${Math.round(this.hold.progress * 100)}%`);
    return fired ? this.holdKey : null;
  }
}
