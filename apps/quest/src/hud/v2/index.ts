import { Camera, Group, Matrix4, Mesh, MeshBasicMaterial, Object3D, PlaneGeometry, Quaternion, Scene, Shape, ShapeGeometry, Vector3, type WebGLRenderer } from 'three';
import { applyPatch, type Control, type ControlEvent, type Gen3dSpec, type HackItem, type ModelChip, type Patch } from '@ce/gen3d';
import { Emitter } from '../../gen3d/events';
import { handCursor, newCursor, type Cursor } from '../../gen3d/interact';
import type { AgentStepLike, ConfirmRequest, DeckKey, EvidenceState, Hud, HudEvents, HudFrame, HudTarget, PingLine, UploadState } from '../contract';
import { BoxField } from './boxes';
import { makeText, setText, type SdfText } from './text';
import { THEME } from './theme';
import { GlassSurfaces } from './surface';
import { PinchReticles } from './reticle';
import { unfoldEase } from './motion';
import { TargetTether } from './tether';
import { WorldPanel } from './world-panel';
export { whenSdfReady } from './text';
export { THEME } from './theme';

interface Mounted {
  spec: Gen3dSpec;
  targetId?: string;
  position?: [number, number, number];
  armed: boolean;
  values: Map<string, ControlEvent['value']>;
  selectedButton?: string;
}
interface Widget {
  group: Group;
  w: number;
  h: number;
  kind: HudEvents['consumed']['widget'];
  start: (point: Vector3) => void;
  move?: (point: Vector3) => void;
  end?: () => void;
  lastMove: number;
  button?: boolean;
}
interface Capture {
  widget: Widget | null;
  mode: 'pinch' | 'poke' | null;
  wasPinching: boolean;
  tip: Vector3;
  hasTip: boolean;
  pokeBlocked: boolean;
  pokePlane: Matrix4;
}
const newCapture = (): Capture => ({ widget: null, mode: null, wasPinching: false, tip: new Vector3(), hasTip: false, pokeBlocked: false, pokePlane: new Matrix4() });

function title(value: string, length = 36): string {
  const s = value.trim().slice(0, length);
  return s === s.toUpperCase() ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;
}
function visible(object: Object3D | null): boolean {
  for (let current = object; current; current = current.parent) if (!current.visible) return false;
  return true;
}

export function createHud(ctx: { scene: Scene; camera: Camera; renderer: WebGLRenderer }): Hud {
  return new LeanHud(ctx.scene, ctx.camera);
}

/** One selected device, a short sentence, and only the controls that are ready to use. */
export class LeanHud implements Hud {
  readonly root = new Group();
  readonly boxes = new BoxField();
  private readonly events = new Emitter<HudEvents>();
  private readonly targets = new Map<string, HudTarget>();
  private readonly labels = new Map<string, Group>();
  private readonly specs = new Map<string, Mounted>();
  private readonly menus = new Map<string, { title: string; items: HackItem[] }>();
  private readonly logs = new Map<string, AgentStepLike>();
  private readonly history: EvidenceState[] = [];
  private readonly widgets: Widget[] = [];
  private readonly captures = new Map<string, Capture>();
  private readonly pressUntil = new Map<string, number>();
  private readonly cursors = [newCursor('left', 'left'), newCursor('right', 'right')];
  private devCursors: Cursor[] = [];
  private readonly materials = {
    button: new MeshBasicMaterial({ color: THEME.color.muted, transparent: true, opacity: THEME.surface.buttonOpacity, depthWrite: false, toneMapped: false }),
    accent: new MeshBasicMaterial({ color: THEME.color.accent, transparent: true, depthWrite: false, toneMapped: false }),
  };
  private readonly surfaces = new GlassSurfaces();
  private readonly trackGeometry = new PlaneGeometry(1, 1);
  private readonly reticles = new PinchReticles();
  private readonly tether = new TargetTether();
  private readonly verdict = new Group();
  private readonly progress = new Group();
  private readonly progressFill = new Mesh(this.trackGeometry, this.materials.accent);
  private unfoldStarted = -Infinity;
  private controlsStarted = -Infinity;
  private controlsSignature = '';
  private readonly card = new Group();
  private readonly controls = new Group();
  private readonly details = new Group();
  private readonly modal = new Group();
  private readonly deck = new Group();
  private readonly notice = new Group();
  private readonly heading = makeText({ text: 'Look at a device', size: THEME.font.title, weight: 600, singleLine: true, maxWidth: THEME.card.width - THEME.card.padding * 2 - THEME.card.chipWidth - THEME.card.padding });
  private readonly status = makeText({ text: 'Pinch a box to learn.', color: THEME.color.muted, singleLine: true, maxWidth: THEME.control.width });
  private readonly detailText = makeText({ text: '', size: THEME.font.detail, maxWidth: THEME.panel.textWidth, anchorY: 'top' });
  private readonly noticeText = makeText({ text: '', maxWidth: THEME.panel.textWidth, anchorX: 'center' });
  private locked: string | null = null;
  private candidate: string | null = null;
  private menuTarget: string | null = null;
  private selectedAction: string | null = null;
  private scanning = false;
  private detailsOpen = false;
  private upload: UploadState | null = null;
  private evidence: EvidenceState | null = null;
  private chips: ModelChip[] = [];
  private pings: PingLine[] = [];
  private confirm: ConfirmRequest | null = null;
  private pairing: { display: string; qr: string; message?: string } | null = null;
  private approvals: { pairingId: string; name: string; kind: string; display: string }[] = [];
  private time = 0;
  private noticeUntil = 0;
  private readonly head = new Vector3();
  private readonly headQuaternion = new Quaternion();
  private readonly point = new Vector3();
  private readonly direction = new Vector3();
  private readonly right = new Vector3();
  private readonly local = new Vector3();
  private readonly origin = new Vector3();
  private readonly inverse = new Matrix4();
  private readonly facing = new Quaternion();
  private readonly tetherStart = new Vector3();
  private readonly tetherEnd = new Vector3();
  private readonly previousTip = new Vector3();
  private readonly idlePlacement = new WorldPanel({ distance: THEME.card.distance, height: THEME.panel.headY });
  private readonly dockPlacement = new WorldPanel({ distance: THEME.card.dockDistance, height: THEME.panel.headY });
  private readonly modalPlacement = new WorldPanel({ height: -0.06 });
  private readonly deckPlacement = new WorldPanel();
  private readonly noticePlacement = new WorldPanel({ height: THEME.panel.toastY });
  private placementKey = '';
  private docked = false;
  private hasFrame = false;
  private deckAt?: [number, number, number];

  constructor(scene: Scene, private readonly camera: Camera) {
    this.root.name = 'hud-v2';
    this.card.name = 'device-card';
    this.controls.name = 'device-controls';
    this.details.name = 'details-panel';
    this.modal.name = 'confirmation-panel';
    this.deck.name = 'deck';
    this.notice.name = 'notice';
    this.root.add(this.boxes, this.card, this.modal, this.deck, this.notice, this.reticles, this.tether);
    this.card.add(this.plate(THEME.card.width, THEME.card.height), this.heading, this.status, this.controls, this.details, this.verdict, this.progress);
    this.heading.position.set(-THEME.card.width / 2 + THEME.card.padding, THEME.card.titleY, THEME.panel.depth);
    this.status.position.set(this.heading.position.x, THEME.card.statusY, THEME.panel.depth);
    this.details.position.y = -THEME.card.height / 2 - THEME.panel.detailHeight / 2 - THEME.panel.gap;
    this.details.add(this.plate(THEME.panel.width, THEME.panel.detailHeight), this.detailText);
    this.detailText.position.set(-THEME.panel.textWidth / 2, THEME.panel.detailHeight / 2 - THEME.card.padding, THEME.panel.depth);
    this.details.visible = false;
    this.notice.add(this.noticeText);
    this.notice.visible = this.modal.visible = this.deck.visible = false;
    this.heading.name = 'device-name';
    this.status.name = 'device-status';
    this.verdict.name = 'verdict-chip';
    this.verdict.position.set(THEME.card.chipX, THEME.card.titleY, THEME.panel.depth);
    this.verdict.add(this.surfaces.create(THEME.card.chipWidth, THEME.card.chipHeight, 'selected', true));
    const verified = makeText({ text: 'Verified', size: THEME.font.detail, color: THEME.color.accent, weight: 500 });
    verified.position.set(-THEME.card.chipWidth / 2 + 0.025, 0, THEME.panel.depth);
    const checkShape = new Shape();
    checkShape.moveTo(-0.005, 0); checkShape.lineTo(-0.001, -0.004);
    checkShape.lineTo(0.006, 0.004); checkShape.lineTo(0.0045, 0.0055);
    checkShape.lineTo(-0.001, -0.001); checkShape.lineTo(-0.0035, 0.0015);
    const check = new Mesh(new ShapeGeometry(checkShape), this.materials.accent);
    check.name = 'verified-check'; check.position.set(-THEME.card.chipWidth / 2 + 0.013, 0, THEME.panel.depth);
    check.renderOrder = THEME.render.text;
    this.verdict.add(verified, check);
    this.progress.name = 'verification-progress';
    this.progress.position.set(0, THEME.card.progressY, THEME.panel.depth);
    const progressTrack = new Mesh(this.trackGeometry, this.materials.button);
    progressTrack.scale.set(THEME.control.width, THEME.card.progressHeight, 1);
    progressTrack.renderOrder = this.progressFill.renderOrder = THEME.render.plates + 1;
    this.progressFill.name = 'progress-fill';
    this.progressFill.position.z = THEME.panel.depth;
    this.progress.add(progressTrack, this.progressFill);
    for (const hand of ['left', 'right']) this.captures.set(hand, newCapture());
    scene.add(this.root);
    this.camera.getWorldPosition(this.head);
    this.camera.getWorldQuaternion(this.headQuaternion);
    this.refreshCard();
    this.place();
  }
  on<K extends keyof HudEvents>(key: K, fn: (e: HudEvents[K]) => void): () => void { return this.events.on(key, fn); }
  setDevCursors(cursors: Cursor[]): void {
    this.devCursors = cursors;
    for (const c of cursors) if (!this.captures.has(c.id)) this.captures.set(c.id, newCapture());
  }
  private plate(w: number, h: number, button = false): Mesh {
    return this.surfaces.create(w, h, button ? 'button' : 'plate', button);
  }
  private label(parent: Group, text: string, y: number, size: number = THEME.font.body): SdfText {
    const label = makeText({ text, size, anchorX: 'center', maxWidth: THEME.panel.textWidth });
    label.position.set(0, y, THEME.panel.depth);
    parent.add(label);
    return label;
  }
  private button(parent: Group, name: string, text: string, x: number, y: number, w: number, kind: Widget['kind'], start: Widget['start'], end?: Widget['end']): Widget {
    const group = new Group();
    group.name = name;
    group.position.set(x, y, THEME.panel.depth);
    const plate = this.plate(w, THEME.control.buttonHeight, true);
    plate.name = 'button-plate';
    group.add(plate);
    const label = makeText({ text, size: THEME.font.label, weight: 500, anchorX: 'center', singleLine: true, maxWidth: w - THEME.card.padding });
    label.position.z = THEME.panel.depth;
    group.add(label);
    parent.add(group);
    const widget: Widget = { group, w, h: THEME.control.buttonHeight, kind, start, end, lastMove: 0, button: true };
    this.widgets.push(widget);
    return widget;
  }
  private clear(parent: Group): void {
    for (let i = this.widgets.length - 1; i >= 0; i--) {
      let ancestor: Object3D | null = this.widgets[i]!.group;
      while (ancestor && ancestor !== parent) ancestor = ancestor.parent;
      if (ancestor) {
        const widget = this.widgets[i]!;
        for (const capture of this.captures.values()) if (capture.widget === widget) {
          capture.widget = null;
          if (widget.kind === 'control' || widget.kind === 'deck') widget.end?.();
        }
        this.widgets.splice(i, 1);
      }
    }
    parent.traverse((o) => { if ('sync' in o && 'dispose' in o) (o as SdfText).dispose(); });
    parent.clear();
  }
  private selected(): HudTarget | undefined { return this.locked ? this.targets.get(this.locked) : undefined; }
  private mounted(): Mounted | undefined {
    let last: Mounted | undefined;
    for (const m of this.specs.values()) {
      if (this.locked ? m.targetId === this.locked : !m.targetId || m.targetId === this.menuTarget) last = m;
    }
    return last;
  }
  private isArmed(m: Mounted, control: Control): boolean { return m.armed && (control.armed ?? true); }
  private refreshStatus(): void {
    const target = this.selected(), m = this.mounted();
    const failed = this.evidence?.verdict === 'fail' || this.upload?.verdict === 'fail' || target?.status === 'failed' || target?.status === 'no-reaction';
    const pending = this.evidence?.verdict === 'pending' || this.upload?.verdict === 'pending';
    const verified = !failed && !pending && (this.evidence?.verdict === 'ok' || this.upload?.verdict === 'ok' || target?.status === 'verified' || target?.status === 'controlled');
    let text = this.locked ? 'Learning this device…' : this.scanning ? 'Pinch a box to learn.' : 'Start scanning to find devices.';
    if (target?.status === 'uploading' || target?.status === 'awaiting' || pending) text = 'Testing: did it react?';
    else if (m && m.spec.controls.some((c) => this.isArmed(m, c))) text = 'Ready to control';
    else if (verified) text = 'Response verified';
    if (failed) text = 'No reaction. Try again.';
    setText(this.status, text);
    this.verdict.visible = verified;
    this.progress.visible = !!this.locked;
    const steps = this.upload?.steps?.length ?? 0;
    const amount = failed ? 0 : verified ? 1 : steps ? Math.min(1, this.upload!.stepsDone / steps) : pending ? 0.5 : 0.12;
    this.progress.userData.value = amount;
    this.progressFill.visible = amount > 0;
    this.progressFill.scale.set(THEME.control.width * amount, THEME.card.progressHeight, 1);
    this.progressFill.position.x = (amount - 1) * THEME.control.width / 2;
  }
  private refreshCard(): void {
    const target = this.selected(), m = this.mounted();
    const menu = this.menus.get(this.locked ?? this.menuTarget ?? '');
    this.card.visible = !this.deck.visible && !this.modal.visible;
    setText(this.heading, title(target?.label ?? menu?.title ?? m?.spec.title ?? 'Look at a device', 24));
    this.refreshStatus();
    const signature = `${this.locked}/${m?.spec.specId}/${m?.armed}/${m?.spec.controls.filter((c) => this.isArmed(m, c)).map((c) => c.id).join(',')}/${menu?.items.map((item) => item.id).join(',')}`;
    if (signature !== this.controlsSignature) { this.controlsStarted = this.time; this.controlsSignature = signature; }
    this.clear(this.controls);
    this.button(this.controls, 'details-toggle', this.detailsOpen ? 'Close details' : 'Details', 0, THEME.card.detailsY, THEME.control.buttonWidth * 1.5, 'handle', () => {
      this.detailsOpen = !this.detailsOpen;
      this.details.visible = this.detailsOpen;
      this.refreshDetails();
      this.refreshCard();
    });
    if (!this.locked && !m && !menu) {
      this.button(this.controls, 'scan-toggle', this.scanning ? 'Stop scan' : 'Scan', 0, THEME.card.mainY, THEME.control.width, 'deck', () => this.events.emit('deck', { key: 'scan', phase: 'press' }), () => this.events.emit('deck', { key: 'scan', phase: 'release' }));
      return;
    }
    let main: Control | undefined;
    const buttons: Control[] = [];
    if (m) for (const c of m.spec.controls) {
      if (!this.isArmed(m, c)) continue;
      if (!main && c.kind !== 'trigger' && c.kind !== 'toggle') main = c;
      else if (c.kind === 'trigger' || c.kind === 'toggle') buttons.push(c);
    }
    const presetOrder = (c: Control) => {
      const action = c.binding?.action.split('.').at(-1) ?? '';
      if (/^(full[ _-]?on|full|on)$/i.test(action) || /full[ _-]?on/i.test(c.label)) return 0;
      if (/^off$/i.test(action) || /\boff\b/i.test(c.label)) return 1;
      return /^night(?:[ _-]?light)?$/i.test(action) || /night/i.test(c.label) ? 2 : 3;
    };
    buttons.sort((a, b) => presetOrder(a) - presetOrder(b));
    buttons.splice(3);
    if (m && main) {
      const knobs = m.spec.controls.filter((c) => this.isArmed(m, c) && (c.kind === 'continuous' || c.kind === 'stepped')).slice(0, 4);
      if (/synth/i.test(m.spec.device?.category ?? '') && knobs.length > 1) knobs.forEach((c, i) => this.knobControl(m, c, i, knobs.length));
      else this.mainControl(m, main);
    }
    if (m && buttons.length) buttons.forEach((c, index) => this.controlButton(m, c, index, buttons.length));
    else if (menu && (m?.armed || target?.status === 'verified' || target?.status === 'controlled')) {
      const shown = menu.items.filter((item) => item.kind !== 'control' && item.status !== 'locked').slice(0, 3);
      shown.forEach((item, index) => {
        const widget = this.button(this.controls, `action:${item.id}`, title(item.label, 12), (index - (shown.length - 1) / 2) * (THEME.control.buttonWidth + THEME.control.buttonGap), THEME.card.buttonsY, THEME.control.buttonWidth, 'hack', () => {
          this.selectedAction = item.id;
          for (const action of shown) {
            const group = this.controls.getObjectByName(`action:${action.id}`) as Group;
            this.selectButton(group, action.id === item.id);
          }
          this.events.emit('hack', { targetId: this.locked ?? this.menuTarget!, itemId: item.id, controlId: item.controlId, index: menu.items.indexOf(item) });
        });
        this.selectButton(widget.group, this.selectedAction === item.id);
      });
    }
  }
  private selectButton(group: Group, selected: boolean, width = THEME.control.buttonWidth as number): void {
    group.userData.selected = selected;
    const plate = group.getObjectByName('button-plate') as Mesh | undefined;
    if (plate) plate.material = this.surfaces.material(width, THEME.control.buttonHeight, selected ? 'selected' : 'button', true);
    for (const child of group.children) if ('sync' in child) setText(child as SdfText, (child as SdfText).text, selected ? THEME.color.accent : THEME.color.text);
  }
  private refreshButtons(m: Mounted): void {
    for (const c of m.spec.controls) {
      const group = this.controls.getObjectByName(`control:${c.id}`) as Group | undefined;
      if (group) this.selectButton(group, c.kind === 'toggle' ? Boolean(m.values.get(c.id)) : m.selectedButton === c.id);
    }
  }
  private controlButton(m: Mounted, c: Control, index: number, count: number): void {
    const widget = this.button(this.controls, `control:${c.id}`, (/night/i.test(c.label) ? 'Night' : title(c.label, 12)), (index - (count - 1) / 2) * (THEME.control.buttonWidth + THEME.control.buttonGap), THEME.card.buttonsY, THEME.control.buttonWidth, 'control', () => {
      m.values.set(c.id, c.kind === 'toggle' ? !m.values.get(c.id) : true);
      m.selectedButton = c.id;
      this.refreshButtons(m);
      this.emitControl(m, c, 'start');
    }, () => { if (c.kind === 'trigger') m.values.set(c.id, false); this.emitControl(m, c, 'end'); });
    widget.group.userData.controlId = c.id;
    this.refreshButtons(m);
  }
  private knobControl(m: Mounted, c: Control, index: number, count: number): void {
    const group = new Group();
    group.name = `main-control:${c.id}`;
    const width = THEME.control.width / count;
    group.position.set((index - (count - 1) / 2) * width, THEME.card.mainY, 0);
    group.userData.knob = true;
    const face = this.surfaces.create(THEME.control.knobDiameter, THEME.control.knobDiameter, 'button', true);
    const thumb = new Mesh(this.trackGeometry, this.materials.accent);
    thumb.name = 'value'; thumb.renderOrder = THEME.render.text;
    thumb.scale.set(THEME.surface.stroke * 2, THEME.control.knobTick, 1);
    thumb.position.z = THEME.panel.depth;
    const label = makeText({ text: title(c.label), size: THEME.font.label, anchorX: 'center', singleLine: true, maxWidth: width - THEME.control.buttonGap });
    label.position.set(0, THEME.control.labelOffset + THEME.panel.depth, THEME.panel.depth);
    const value = makeText({ text: '', size: THEME.font.detail, color: THEME.color.accent, tabular: true, anchorX: 'center' });
    value.name = 'control-value'; value.position.z = THEME.panel.depth;
    group.add(face, thumb, label, value); this.controls.add(group);
    const update = (point: Vector3) => {
      const range = c.range ?? { min: 0, max: 1 };
      let value = range.min + Math.min(1, Math.max(0, point.x / width + 0.5)) * (range.max - range.min);
      if (range.step) value = Math.min(range.max, Math.max(range.min, range.min + Math.round((value - range.min) / range.step) * range.step));
      m.values.set(c.id, value); this.positionThumb(m, c, thumb);
    };
    this.widgets.push({ group, w: width, h: THEME.control.knobDiameter, kind: 'control', lastMove: 0,
      start: (p) => { update(p); this.emitControl(m, c, 'start'); },
      move: (p) => { update(p); this.emitControl(m, c, 'move'); }, end: () => this.emitControl(m, c, 'end') });
    this.positionThumb(m, c, thumb);
  }
  private mainControl(m: Mounted, c: Control): void {
    const group = new Group();
    group.name = `main-control:${c.id}`;
    group.position.y = THEME.card.mainY;
    const track = this.surfaces.create(THEME.control.width, THEME.control.height, 'button', true);
    const fill = this.surfaces.create(THEME.control.width, THEME.control.height, 'selected', true);
    fill.name = 'slider-fill'; fill.position.z = THEME.panel.depth;
    const valueText = makeText({ text: '', size: THEME.font.title, color: THEME.color.accent, weight: 600, tabular: true, anchorX: 'right', singleLine: true, maxWidth: THEME.control.width / 3 });
    valueText.name = 'control-value';
    valueText.position.set(THEME.control.width / 2, THEME.control.labelOffset, THEME.panel.depth);
    group.add(valueText);
    const thumb = new Mesh(this.trackGeometry, this.materials.accent);
    thumb.name = 'value';
    thumb.scale.set(THEME.surface.stroke * 2, THEME.control.height - THEME.card.radius, 1);
    thumb.position.z = THEME.panel.depth * 2;
    const label = makeText({ text: title(c.label), size: THEME.font.label, weight: 500, singleLine: true, maxWidth: THEME.control.width * 2 / 3 });
    label.name = 'control-label';
    label.position.set(-THEME.control.width / 2, THEME.control.labelOffset, THEME.panel.depth);
    group.add(label);
    thumb.renderOrder = THEME.render.plates + 1;
    group.add(track, fill, thumb);
    this.controls.add(group);
    const update = (point: Vector3) => {
      const range = c.range ?? { min: 0, max: 1 };
      let value = range.min + Math.min(1, Math.max(0, point.x / THEME.control.width + 0.5)) * (range.max - range.min);
      if (range.step) value = Math.min(range.max, Math.max(range.min, range.min + Math.round((value - range.min) / range.step) * range.step));
      if (c.kind === 'xy') {
        const yr = c.yRange ?? range;
        const y = yr.min + Math.min(1, Math.max(0, point.y / THEME.control.height + 0.5)) * (yr.max - yr.min);
        m.values.set(c.id, { x: value, y });
      } else m.values.set(c.id, value);
      this.positionThumb(m, c, thumb);
    };
    const widget: Widget = { group, w: THEME.control.width, h: THEME.control.height, kind: 'control', lastMove: 0, start: (p) => { update(p); this.emitControl(m, c, 'start'); }, move: (p) => { update(p); this.emitControl(m, c, 'move'); }, end: () => this.emitControl(m, c, 'end') };
    this.widgets.push(widget);
    this.positionThumb(m, c, thumb);
  }
  private positionThumb(m: Mounted, c: Control, thumb: Object3D): void {
    const range = c.range ?? { min: 0, max: 1 }, value = m.values.get(c.id) ?? c.default ?? range.min;
    const x = typeof value === 'object' ? value.x : Number(value);
    const fraction = Math.min(1, Math.max(0, (x - range.min) / (range.max - range.min || 1)));
    thumb.position.x = (fraction - 0.5) * (THEME.control.width - THEME.card.radius * 2);
    const group = thumb.parent;
    if (group?.userData.knob) {
      const angle = (0.75 - 1.5 * fraction) * Math.PI;
      const radius = THEME.control.knobDiameter / 2 - THEME.control.knobTick;
      thumb.position.set(Math.sin(angle) * radius, Math.cos(angle) * radius, THEME.panel.depth);
      thumb.rotation.z = -angle;
    }
    const fill = group?.getObjectByName('slider-fill') as Mesh | undefined;
    if (fill) {
      fill.visible = fraction > 0;
      fill.scale.x = THEME.control.width * fraction;
      fill.position.x = (fraction - 1) * THEME.control.width / 2;
    }
    const valueText = group?.getObjectByName('control-value') as SdfText | undefined;
    const unit = c.unit ?? (/brightness|level/i.test(c.label) && range.max === 100 ? '%' : '');
    if (valueText) setText(valueText, `${Number(x.toFixed(2))}${unit}`);
  }
  private emitControl(m: Mounted, c: Control, phase: ControlEvent['phase']): void {
    if (this.isArmed(m, c)) this.events.emit('control', { specId: m.spec.specId, controlId: c.id, value: m.values.get(c.id) ?? c.default ?? 0, phase, ts: Date.now() });
  }
  setScanning(on: boolean, _info?: { modelId?: string }): void { if (this.scanning === on) return; this.scanning = on; this.refreshCard(); }
  upsertTarget(t: HudTarget): void {
    if (t.label.trim().toLowerCase() === 'person') { this.removeTarget(t.id); return; }
    const previous = this.targets.get(t.id);
    this.targets.set(t.id, t);
    this.point.fromArray(t.position);
    if (!this.boxes.set(t.id, this.point, t.sizeM?.[0] ?? THEME.box.defaultWidth, t.sizeM?.[1] ?? THEME.box.defaultHeight, this.locked === t.id || this.candidate === t.id ? THEME.color.accent : THEME.color.line)) return;
    this.boxes.setFacing(t.id, t.facing);
    let label = this.labels.get(t.id);
    if (!label) {
      label = new Group(); label.name = `target-label:${t.id}`;
      this.labels.set(t.id, label); this.root.add(label);
    }
    if (!label.children.length || !previous || previous.label !== t.label) {
      this.clear(label);
      const text = title(t.label, 22);
      const width = Math.max(0.065, text.length * THEME.font.label * 0.56 + THEME.box.labelPadding * 3);
      const pill = this.surfaces.create(width, THEME.box.labelHeight, 'plate', true);
      pill.position.x = width / 2;
      const name = makeText({ text: `•  ${text}`, size: THEME.font.label, weight: 500, singleLine: true, maxWidth: width - THEME.box.labelPadding * 2 });
      name.position.set(THEME.box.labelPadding, 0, THEME.panel.depth);
      label.add(pill, name);
    }
    if (this.locked === t.id && (previous?.label !== t.label || previous?.status !== t.status)) this.refreshCard();
  }
  removeTarget(id: string): void {
    this.targets.delete(id); this.boxes.remove(id);
    const label = this.labels.get(id); if (label) { label.removeFromParent(); this.clear(label); this.labels.delete(id); }
    if (this.locked === id) { this.locked = null; this.refreshCard(); }
  }
  clearTargets(): void { for (const id of this.targets.keys()) this.removeTarget(id); }
  setCandidate(id: string | null): void {
    const old = this.candidate; this.candidate = id;
    if (old && old !== this.locked) this.boxes.boxes.get(old)?.tColor.set(THEME.color.line);
    if (id) this.boxes.boxes.get(id)?.tColor.set(THEME.color.accent);
  }
  setLocked(id: string | null): void {
    const old = this.locked; this.locked = id;
    if (old !== id) { this.evidence = null; this.upload = null; this.selectedAction = null; this.unfoldStarted = this.time; }
    if (old && old !== this.candidate) this.boxes.boxes.get(old)?.tColor.set(THEME.color.line);
    if (id) this.boxes.boxes.get(id)?.tColor.set(THEME.color.accent);
    this.refreshCard(); this.place();
  }
  setPing(lines: PingLine[]): void { this.pings = lines; this.refreshDetails(); }
  logStep(step: AgentStepLike): void { this.logs.set(step.stepId, step); while (this.logs.size > THEME.limits.logs) this.logs.delete(this.logs.keys().next().value!); this.refreshDetails(); }
  setModelChips(chips: ModelChip[]): void { this.chips = chips; this.refreshDetails(); }
  showHackMenu(targetId: string, menu: { title: string; subtitle?: string; items: HackItem[] }): void { this.menus.set(targetId, menu); this.menuTarget = targetId; this.refreshCard(); }
  hideHackMenu(): void { this.menus.clear(); this.menuTarget = null; this.refreshCard(); }
  setUpload(upload: UploadState | null): void { this.upload = upload; this.refreshStatus(); this.refreshDetails(); }
  showEvidence(evidence: EvidenceState | null): void {
    this.evidence = evidence?.targetId && evidence.targetId !== this.locked ? null : evidence;
    if (evidence && evidence.verdict !== 'pending') { this.history.push(evidence); if (this.history.length > THEME.limits.evidence) this.history.shift(); }
    this.refreshStatus(); this.refreshDetails();
  }
  private refreshDetails(): void {
    if (!this.detailsOpen) return;
    const lines: string[] = [];
    for (const log of this.logs.values()) lines.push(`${title(log.title, 34)} · ${log.status}${log.detail ? `\n${log.detail.slice(0, 72)}` : ''}`);
    for (const evidence of this.history) lines.push(`${evidence.verdict === 'ok' ? 'Observed' : 'Not observed'}: ${evidence.seen}`);
    if (this.upload?.modelId) lines.push(this.upload.modelId);
    for (const chip of this.chips) lines.push(`${chip.id} · ${chip.state}`);
    for (const ping of this.pings) lines.push(`${ping.channel}: ${ping.proven ? 'Connected' : 'Checking'}`);
    setText(this.detailText, lines.slice(-THEME.panel.detailLines).join('\n') || 'No activity yet.');
  }
  renderSpec(spec: Gen3dSpec, at: { targetId?: string; position?: [number, number, number]; yawDeg?: number }): void {
    const previous = this.specs.get(spec.specId);
    const m: Mounted = { spec, targetId: at.targetId ?? previous?.targetId, position: at.position ?? previous?.position, armed: spec.state?.armed ?? false, values: previous?.values ?? new Map(), selectedButton: previous?.selectedButton };
    for (const c of spec.controls) if (!m.values.has(c.id)) m.values.set(c.id, c.default ?? 0);
    this.specs.set(spec.specId, m); this.refreshCard(); this.place();
  }
  patchSpec(id: string, patch: Patch): { ok: boolean; errors?: string[] } {
    const m = this.specs.get(id); if (!m) return { ok: false, errors: [`No spec ${id}`] };
    const result = applyPatch(m.spec, patch);
    if (!result.ok) return { ok: false, errors: result.errors.map((e) => `${e.path}: ${e.message}`) };
    m.spec = result.spec; m.armed = result.spec.state?.armed ?? m.armed; this.refreshCard(); return { ok: true };
  }
  removeSpec(id: string): void { this.specs.delete(id); this.refreshCard(); }
  setArmed(id: string, armed: boolean, _reason?: string, controlIds?: string[]): void {
    const m = this.specs.get(id); if (!m) return;
    if (controlIds) m.spec = { ...m.spec, controls: m.spec.controls.map((c) => controlIds.includes(c.id) ? { ...c, armed } : c) };
    else { m.armed = armed; m.spec = { ...m.spec, state: { ...m.spec.state, armed }, controls: m.spec.controls.map((c) => ({ ...c, armed })) }; }
    this.refreshCard();
  }
  setControlValue(id: string, controlId: string, value: ControlEvent['value']): void {
    const m = this.specs.get(id); if (!m) return; m.values.set(controlId, value);
    const c = m.spec.controls.find((control) => control.id === controlId), thumb = this.controls.getObjectByName(`main-control:${controlId}`)?.getObjectByName('value');
    if (this.mounted() === m) {
      if (c && thumb) this.positionThumb(m, c, thumb);
      this.refreshButtons(m);
    }
  }
  showConfirm(confirm: ConfirmRequest | null): void {
    this.confirm = confirm; this.clear(this.modal); this.modal.visible = !!confirm; if (!confirm) {
      if (this.approvals.length) this.showApprovals(this.approvals);
      else if (this.pairing) this.showPairing(this.pairing);
      return;
    }
    this.modal.add(this.plate(THEME.panel.width, THEME.panel.height));
    this.label(this.modal, title(confirm.title), THEME.panel.row, THEME.font.title);
    this.label(this.modal, confirm.summary ?? (confirm.hold ? 'Hold to confirm.' : 'Confirm this action.'), 0, THEME.font.label);
    let startedAt = 0;
    this.button(this.modal, 'confirm-yes', confirm.hold ? 'Hold to allow' : 'Allow', THEME.control.buttonWidth / 1.5, -THEME.panel.row, THEME.control.buttonWidth * 1.5, 'confirm', () => { startedAt = this.time; }, () => {
      if ((!confirm.expiresAt || Date.now() < confirm.expiresAt) && (!confirm.hold || (this.time - startedAt) * 1000 >= THEME.control.holdMs)) this.events.emit('confirm', { id: confirm.id, approve: true, hold: !!confirm.hold });
    });
    this.button(this.modal, 'confirm-no', 'Cancel', -THEME.control.buttonWidth, -THEME.panel.row, THEME.control.buttonWidth, 'confirm', () => this.events.emit('confirm', { id: confirm.id, approve: false }));
    this.place();
  }
  showPairing(pair: { display: string; qr: string; message?: string } | null): void {
    this.pairing = pair;
    if (this.confirm) return;
    if (this.approvals.length) { this.showApprovals(this.approvals); return; }
    this.clear(this.modal); this.modal.visible = !!pair; if (!pair) return;
    this.modal.add(this.plate(THEME.panel.width, THEME.panel.height));
    this.label(this.modal, 'Pair this headset', THEME.panel.row, THEME.font.title);
    this.label(this.modal, pair.display, 0, THEME.font.title);
    this.label(this.modal, pair.message ?? 'Enter this code on the Mac.', -THEME.panel.row, THEME.font.label); this.place();
  }
  showApprovals(list: { pairingId: string; name: string; kind: string; display: string }[]): void {
    this.approvals = list;
    if (this.confirm) return;
    if (!list.length && this.pairing) { this.showPairing(this.pairing); return; }
    this.clear(this.modal); this.modal.visible = !!list.length; const first = list[0]; if (!first) return;
    this.modal.add(this.plate(THEME.panel.width, THEME.panel.height));
    this.label(this.modal, `${title(first.name, 22)} wants to join`, THEME.panel.row, THEME.font.title);
    this.label(this.modal, first.display, 0);
    for (const approve of [false, true]) this.button(this.modal, approve ? 'approval-yes' : 'approval-no', approve ? 'Allow' : 'Cancel', (approve ? 1 : -1) * THEME.control.buttonWidth / 1.5, -THEME.panel.row, THEME.control.buttonWidth, 'approval', () => this.events.emit('approve', { pairingId: first.pairingId, approve }));
    this.place();
  }
  setVoice(v: { listening: boolean; level?: number; partial?: string; final?: string }): void {
    if (v.listening || v.final) this.toast(v.final ?? v.partial ?? 'Listening…');
  }
  setDeck(d: { open?: boolean; scanning?: boolean; daemons?: boolean; at?: [number, number, number] }): void {
    if (d.open && !this.deck.visible) { this.deckPlacement.reset(); this.deckAt = undefined; }
    if (d.at) this.deckAt = d.at;
    if (d.open !== undefined) this.deck.visible = d.open;
    if (!this.deck.visible) return;
    this.clear(this.deck);
    const keys: [DeckKey, string][] = [['scan', 'Scan'], ['ping', 'Connect'], ['daemons', 'Automations'], ['undo', 'Undo'], ['mic', 'Voice'], ['panic', 'Stop']];
    const rows = Math.ceil(keys.length / 3);
    this.deck.add(this.plate(THEME.panel.width, rows * THEME.panel.row + THEME.card.padding * 2));
    keys.forEach(([key, label], i) => this.button(this.deck, `deck:${key}`, label, (i % 3 - 1) * (THEME.control.buttonWidth + THEME.control.buttonGap), ((rows - 1) / 2 - Math.floor(i / 3)) * THEME.panel.row, THEME.control.buttonWidth, 'deck', () => this.events.emit('deck', { key, phase: 'press' }), () => this.events.emit('deck', { key, phase: 'release' })));
    this.place();
  }
  toast(text: string, _level?: 'info' | 'ok' | 'warn' | 'error'): void { setText(this.noticeText, text.slice(0, 72)); if (!this.notice.visible) this.noticePlacement.reset(); this.notice.visible = true; this.noticeUntil = this.time + 3; this.place(); }
  private face(object: Object3D): void {
    this.boxes.facingQuaternion(this.head, object.position, this.facing); object.quaternion.copy(this.facing);
  }
  private follow(panel: Group, placement: WorldPanel): void {
    placement.update(panel, { position: this.head, quaternion: this.headQuaternion }, this.time * 1000);
  }
  private placeTether(targetId: string): void {
    if (!this.card.visible || !this.boxes.nearestBorder(targetId, this.card.position, this.head, this.tetherStart)) { this.tether.hide(); return; }
    this.facing.copy(this.card.quaternion).invert();
    this.local.subVectors(this.tetherStart, this.card.position).applyQuaternion(this.facing);
    const hw = THEME.card.width / 2 * this.card.scale.x, hh = THEME.card.height / 2;
    let x = Math.max(-hw, Math.min(hw, this.local.x)), y = Math.max(-hh, Math.min(hh, this.local.y));
    if (Math.abs(x) < hw && Math.abs(y) < hh) {
      if (hw - Math.abs(x) < hh - Math.abs(y)) x = x < 0 ? -hw : hw;
      else y = y < 0 ? -hh : hh;
    }
    this.tetherEnd.set(x, y, 0).applyQuaternion(this.card.quaternion).add(this.card.position);
    this.tether.update(this.tetherStart, this.tetherEnd, this.head);
  }
  private place(): void {
    if (!this.hasFrame) return;
    this.card.visible = !this.deck.visible && !this.modal.visible;
    const target = this.selected(), m = this.mounted();
    const unfold = target ? unfoldEase((this.time - this.unfoldStarted) / THEME.motion.duration) : 1;
    this.card.scale.x = Math.max(0.001, unfold);
    const controls = unfoldEase((this.time - this.controlsStarted) / THEME.motion.duration);
    this.controls.scale.y = Math.max(0.001, controls);
    const box = target && this.boxes.boxes.get(target.id);
    const key = target?.id ?? (m?.position ? `position:${m.spec.specId}` : 'idle');
    if (key !== this.placementKey) {
      this.placementKey = key;
      this.idlePlacement.reset(); this.dockPlacement.reset();
      this.docked = !!box && (box.center.distanceTo(this.head) > THEME.card.maxTargetDistance || box.center.y - this.head.y > THEME.card.maxTargetHeight);
    }
    if (box) {
      if (this.docked) this.follow(this.card, this.dockPlacement);
      else {
        this.boxes.facingQuaternion(this.head, box.center, this.card.quaternion, box.facing);
        this.right.set(1, 0, 0).applyQuaternion(this.card.quaternion);
        this.card.position.copy(box.center).addScaledVector(this.right, box.w / 2 + THEME.card.gap + THEME.card.width / 2 * this.card.scale.x);
      }
      this.placeTether(box.id);
    } else {
      this.tether.hide();
      if (m?.position) { this.card.position.fromArray(m.position); this.face(this.card); }
      else this.follow(this.card, this.idlePlacement);
    }
    if (this.modal.visible) this.follow(this.modal, this.modalPlacement);
    else this.modalPlacement.reset();
    if (this.deck.visible) {
      if (this.deckAt) { this.deck.position.fromArray(this.deckAt); this.face(this.deck); }
      else this.follow(this.deck, this.deckPlacement);
    }
    if (this.notice.visible) this.follow(this.notice, this.noticePlacement);
  }
  private inside(widget: Widget, point: Vector3): boolean {
    return Math.abs(point.x) <= Math.max(THEME.control.minHitSize, widget.w) / 2 + THEME.control.hitPadding
      && Math.abs(point.y) <= Math.max(THEME.control.minHitSize, widget.h) / 2 + THEME.control.hitPadding;
  }
  private hit(widget: Widget, cursor: Cursor, clampToFace = false): number {
    this.inverse.copy(widget.group.matrixWorld).invert();
    this.local.copy(cursor.tip).applyMatrix4(this.inverse);
    let distance = Math.abs(this.local.z);
    if (!cursor.canPoke || distance > THEME.control.near || !this.inside(widget, this.local)) {
      if (!cursor.ray) return Infinity;
      this.origin.copy(cursor.ray.origin).applyMatrix4(this.inverse);
      // Preserve world ray distance while the card unfolds with a nonuniform scale.
      this.direction.copy(cursor.ray.origin).add(cursor.ray.dir).applyMatrix4(this.inverse).sub(this.origin);
      if (Math.abs(this.direction.z) < 1e-6) return Infinity;
      distance = -this.origin.z / this.direction.z;
      if (distance < 0 || distance > THEME.control.rayDistance) return Infinity;
      this.local.copy(this.origin).addScaledVector(this.direction, distance);
    }
    if (!clampToFace && !this.inside(widget, this.local)) return Infinity;
    return distance;
  }
  private crosses(widget: Widget, cursor: Cursor, capture: Capture): boolean {
    if (!widget.button || !cursor.canPoke || !capture.hasTip || capture.pokeBlocked) return false;
    this.inverse.copy(widget.group.matrixWorld).invert();
    this.previousTip.copy(capture.tip).applyMatrix4(this.inverse);
    this.local.copy(cursor.tip).applyMatrix4(this.inverse);
    if (this.previousTip.z <= 0 || this.local.z > 0) return false;
    const fraction = this.previousTip.z / (this.previousTip.z - this.local.z);
    this.local.lerpVectors(this.previousTip, this.local, fraction);
    return this.inside(widget, this.local);
  }
  private interact(cursor: Cursor): void {
    const capture = this.captures.get(cursor.id); if (!capture) return;
    if (!cursor.tracked) {
      const active = capture.widget; capture.widget = null; capture.mode = null; capture.hasTip = false; capture.wasPinching = false;
      if (active?.kind === 'control' || active?.kind === 'deck') active.end?.();
      return;
    }
    if (cursor.canPoke && capture.pokeBlocked) {
      this.local.copy(cursor.tip).applyMatrix4(capture.pokePlane);
      if (this.local.z > THEME.control.pokeRelease) capture.pokeBlocked = false;
    }
    let hover: Widget | null = null, poke: Widget | null = null, distance = Infinity;
    for (const widget of this.widgets) {
      if (!visible(widget.group) || this.modal.visible && !this.modal.getObjectById(widget.group.id)) continue;
      const candidate = this.hit(widget, cursor);
      if (candidate < distance) { distance = candidate; hover = widget; }
      if (!poke && this.crosses(widget, cursor, capture)) poke = widget;
    }
    if (hover) hover.group.userData.hovered = true;
    if (!capture.mode) {
      const pinch = cursor.justPinched && !capture.wasPinching;
      const winner = pinch ? hover : !cursor.pinching ? poke : null;
      if (winner) {
        if (pinch) this.hit(winner, cursor);
        else this.crosses(winner, cursor, capture);
        capture.widget = winner; capture.mode = pinch ? 'pinch' : 'poke';
        capture.pokeBlocked = cursor.canPoke;
        capture.pokePlane.copy(winner.group.matrixWorld).invert();
        this.pressUntil.set(winner.group.name, this.time + 0.12);
        this.events.emit('consumed', { hand: cursor.hand, widget: winner.kind });
        winner.start(this.local);
      }
    }
    const active = capture.widget;
    let released = capture.mode === 'pinch' && (!cursor.pinching || cursor.justReleased);
    if (capture.mode === 'poke') {
      this.local.copy(cursor.tip).applyMatrix4(capture.pokePlane);
      released = !cursor.canPoke || !capture.pokeBlocked || !!active && !this.inside(active, this.local);
    }
    if (active) {
      this.events.emit('consumed', { hand: cursor.hand, widget: active.kind });
      if (released) {
        capture.widget = null; capture.mode = null;
        if (active.move && this.hit(active, cursor, true) !== Infinity) active.move(this.local);
        active.end?.();
      } else if (cursor.pinching && active.move && this.time - active.lastMove >= 1 / THEME.control.dragHz) {
        active.lastMove = this.time;
        if (this.hit(active, cursor, true) !== Infinity) active.move(this.local);
      }
    } else if (released) capture.mode = null;
    capture.wasPinching = cursor.pinching;
    capture.hasTip = cursor.canPoke;
    if (cursor.canPoke) capture.tip.copy(cursor.tip);
  }
  private buttonFeedback(): void {
    for (const [name, until] of this.pressUntil) if (until < this.time) this.pressUntil.delete(name);
    for (const widget of this.widgets) {
      if (!widget.button) continue;
      const { group } = widget;
      let pressed = this.pressUntil.has(group.name);
      for (const capture of this.captures.values()) if (capture.widget === widget) pressed = true;
      const hovered = Boolean(group.userData.hovered), selected = Boolean(group.userData.selected);
      group.userData.pressed = pressed;
      group.scale.setScalar(pressed ? 0.96 : 1);
      const plate = group.getObjectByName('button-plate') as Mesh;
      const style = pressed ? 'pressed' : hovered ? selected ? 'selected-hover' : 'hover' : selected ? 'selected' : 'button';
      plate.material = this.surfaces.material(widget.w, widget.h, style, true);
    }
  }
  update(frame: HudFrame): void {
    this.time = frame.time / 1000;
    this.hasFrame = true;
    this.head.copy(frame.head.position); this.headQuaternion.copy(frame.head.quaternion);
    this.boxes.setActive(this.locked ?? this.candidate);
    this.boxes.update(frame.dt, this.head);
    for (const [id, label] of this.labels) {
      const box = this.boxes.boxes.get(id); if (!box) continue;
      this.boxes.labelAnchor(box, this.head, label.position);
      this.boxes.facingQuaternion(this.head, box.center, label.quaternion, box.facing);
    }
    this.place();
    this.root.updateMatrixWorld(true);
    handCursor('left', frame.hands.left, this.cursors[0]!); handCursor('right', frame.hands.right, this.cursors[1]!);
    this.cursors[0]!.canPoke &&= !frame.hands.left?.controller;
    this.cursors[1]!.canPoke &&= !frame.hands.right?.controller;
    this.reticles.update(this.cursors, this.head, frame.dt, this.boxes);
    for (const widget of this.widgets) widget.group.userData.hovered = false;
    for (const cursor of this.cursors) this.interact(cursor);
    for (const cursor of this.devCursors) this.interact(cursor);
    this.buttonFeedback();
    if (this.notice.visible && this.time > this.noticeUntil) this.notice.visible = false;
  }
  dispose(): void {
    this.root.traverse((o) => { if ('sync' in o && 'dispose' in o) (o as SdfText).dispose(); });
    this.boxes.dispose();
    (this.verdict.getObjectByName('verified-check') as Mesh).geometry.dispose();
    this.surfaces.dispose();
    this.reticles.dispose();
    this.tether.dispose();
    for (const material of Object.values(this.materials)) material.dispose();
    this.trackGeometry.dispose(); this.root.removeFromParent();
  }
}
