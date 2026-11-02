import { Camera, Group, Matrix4, Mesh, MeshBasicMaterial, Object3D, PlaneGeometry, Quaternion, Scene, Shape, ShapeGeometry, Vector3, type WebGLRenderer } from 'three';
import { applyPatch, type Control, type ControlEvent, type Gen3dSpec, type HackItem, type ModelChip, type Patch } from '@ce/gen3d';
import { Emitter } from '../../gen3d/events';
import { handCursor, newCursor, type Cursor } from '../../gen3d/interact';
import type { AgentStepLike, ConfirmRequest, DeviceState, HomeState, EvidenceState, Hud, HudEvents, HudFrame, HudTarget, PingLine, UploadState } from '../contract';
import { BoxField } from './boxes';
import { makeText, setText, type SdfText } from './text';
import { THEME } from './theme';
import { GlassSurfaces } from './surface';
import { PinchReticles } from './reticle';
import { unfoldEase } from './motion';
import { TargetTether } from './tether';
import { PanelSeparation, WorldPanel } from './world-panel';
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
  dragNear: boolean;
}
const newCapture = (): Capture => ({ widget: null, mode: null, wasPinching: false, tip: new Vector3(), hasTip: false, pokeBlocked: false, pokePlane: new Matrix4(), dragNear: false });

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
  private readonly reticlePoints = [new Vector3(), new Vector3()];
  private readonly reticleHits: (Vector3 | null)[] = [null, null];
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
  private home: HomeState = { mode: 'annotate', filter: 'electronics', tagged: 0, status: 'Tag the devices you want to control' };
  private deviceState: DeviceState | null = null;
  private wristOpen = false;
  private readonly homePosition = new Vector3();
  private readonly homeRotation = new Quaternion();
  private readonly homeCount = makeText({ text: '0 tagged', size: THEME.font.detail, anchorX: 'center', singleLine: true, maxWidth: 0.11 });
  private readonly homeStatus = makeText({ text: '', size: THEME.font.detail, anchorX: 'center', singleLine: true, maxWidth: 0.44 });
  private readonly notice = new Group();
  private readonly heading = makeText({ text: 'Look at a device', size: THEME.font.title, weight: 600, singleLine: true, maxWidth: THEME.card.width - THEME.card.padding * 2 - THEME.card.chipWidth - THEME.card.padding });
  private readonly status = makeText({ text: '', color: THEME.color.muted, maxWidth: THEME.control.width, maxHeight: 0.105, anchorY: 'top' });
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
  private readonly cardEdge = new Vector3();
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
  private readonly panelSeparation = new PanelSeparation();
  private readonly deckPlacement = new WorldPanel({ distance: 0.6, height: -0.4 });
  private readonly headPose = { position: this.head, quaternion: this.headQuaternion };
  private readonly noticePlacement = new WorldPanel({ height: THEME.panel.toastY });
  private placementKey = '';
  private docked = false;
  private openingBesideTarget = false;
  private hasFrame = false;
  private deckAt?: [number, number, number];

  constructor(scene: Scene, private readonly camera: Camera) {
    this.root.name = 'hud-v2';
    this.card.name = 'device-card';
    this.controls.name = 'device-controls';
    this.details.name = 'details-panel';
    this.modal.name = 'confirmation-panel';
    this.deck.name = 'home-bar';
    this.notice.name = 'notice';
    this.root.add(this.boxes, this.card, this.modal, this.deck, this.notice, this.reticles, this.tether);
    this.card.add(this.plate(THEME.card.width, THEME.card.height), this.heading, this.status, this.controls, this.details, this.verdict, this.progress);
    this.heading.position.set(-THEME.card.width / 2 + THEME.card.padding, THEME.card.titleY, THEME.panel.depth);
    this.status.position.set(this.heading.position.x, THEME.card.statusY, THEME.panel.depth);
    this.details.position.z = THEME.panel.depth;
    this.details.add(this.detailText);
    this.detailText.position.set(-THEME.panel.textWidth / 2, 0.06, THEME.panel.depth);
    this.details.visible = false;
    this.notice.add(this.noticeText);
    this.notice.visible = this.modal.visible = false;
    this.deck.visible = true;
    this.widgets.push({ group: this.card, w: THEME.card.width, h: THEME.card.height, kind: 'handle', start: () => {}, lastMove: 0 });
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
    this.refreshHome();
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
  private isArmed(m: Mounted, control: Control): boolean { return this.home.mode === 'control' && !!this.selected()?.tagged && this.selectedConnection() === 'ready' && !this.deviceState?.busy && m.armed && (control.armed ?? true); }
  private selectedConnection(): DeviceState['connection'] { return this.deviceState?.targetId === this.locked ? this.deviceState.connection : this.selected()?.connection ?? 'unknown'; }
  private refreshStatus(): void {
    const target = this.selected(), m = this.mounted();
    const failed = this.evidence?.verdict === 'fail' || this.upload?.verdict === 'fail' || target?.status === 'failed' || target?.status === 'no-reaction';
    const pending = this.evidence?.verdict === 'pending' || this.upload?.verdict === 'pending';
    const verified = !failed && !pending && (this.evidence?.verdict === 'ok' || this.upload?.verdict === 'ok' || target?.status === 'verified' || target?.status === 'controlled');
    const state = this.deviceState?.targetId === this.locked ? this.deviceState : null;
    const connection = this.selectedConnection();
    const text = state?.busy ? state.sentence ?? 'Setting up control…' : connection === 'offline' ? state?.hint ?? 'Connect a companion to control this device.' : connection === 'unknown' ? 'Waiting for connection status…' : connection === 'setup' ? state?.hint ?? 'Set up control for this device.' : m?.armed ? 'Ready to control' : 'Confirm to enable controls';
    setText(this.status, text.slice(0, 200));
    this.verdict.visible = verified;
    this.progress.visible = false;
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
    this.card.visible = this.home.mode === 'control' && !!target?.tagged && !this.modal.visible;
    setText(this.heading, title(target?.label ?? menu?.title ?? m?.spec.title ?? 'Look at a device', 24));
    this.refreshStatus();
    this.details.visible = this.detailsOpen && this.card.visible && this.selectedConnection() === 'ready' && !this.deviceState?.busy;
    this.status.visible = !this.details.visible;
    const signature = `${this.locked}/${m?.spec.specId}/${m?.armed}/${m?.spec.controls.filter((c) => this.isArmed(m, c)).map((c) => c.id).join(',')}/${menu?.items.map((item) => item.id).join(',')}`;
    if (signature !== this.controlsSignature) { this.controlsStarted = this.time; this.controlsSignature = signature; }
    this.clear(this.controls);
    if (!this.card.visible) return;
    const state = this.deviceState?.targetId === this.locked ? this.deviceState : null;
    const connection = this.selectedConnection();
    if (state?.busy) {
      this.button(this.controls, 'control-cancel', 'Cancel', 0, THEME.card.buttonsY, 0.16, 'handle', () => this.events.emit('cancel', { targetId: target!.id }));
      return;
    }
    if (connection !== 'ready') {
      if (connection === 'setup') this.button(this.controls, 'control-setup', 'Set up control', 0, THEME.card.buttonsY, 0.24, 'handle', () => this.events.emit('setup', { targetId: target!.id }));
      if (connection === 'offline') this.button(this.controls, 'control-pair', 'Look at pairing QR', 0, THEME.card.buttonsY, 0.26, 'handle', () => this.events.emit('pair', { targetId: target!.id }));
      return;
    }
    this.button(this.controls, 'details-toggle', this.detailsOpen ? 'Close details' : 'Details', 0, THEME.card.detailsY, THEME.control.buttonWidth * 1.5, 'handle', () => {
      this.detailsOpen = !this.detailsOpen;
      this.details.visible = this.detailsOpen;
      this.refreshDetails();
      this.refreshCard();
    });
    if (this.detailsOpen) return;
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
    if (m && main) this.mainControl(m, main);
    if (m && main && /synth|keyboard/i.test(m.spec.device?.category ?? '')) {
      this.button(this.controls, 'hand-control', state?.handControl ? 'Hand control on' : 'Hand control off', -0.075, THEME.card.detailsY, 0.19, 'handle', () => this.events.emit('handControl', { targetId: target!.id, enabled: !state?.handControl }));
      const details = this.controls.getObjectByName('details-toggle');
      if (details) { details.position.x = 0.13; details.scale.x = 0.6; }
    }
    if (m && buttons.length) buttons.forEach((c, index) => this.controlButton(m, c, index, buttons.length));
    else if (menu && m?.armed) {
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
  isTargetVisible(id: string): boolean { return this.boxes.has(id); }
  upsertTarget(t: HudTarget): void {
    if (t.label.trim().toLowerCase() === 'person') { this.removeTarget(t.id); return; }
    const previous = this.targets.get(t.id);
    this.targets.set(t.id, t);
    this.point.fromArray(t.position);
    if (!this.boxes.set(t.id, this.point, t.sizeM?.[0] ?? THEME.box.defaultWidth, t.sizeM?.[1] ?? THEME.box.defaultHeight, t.tagged || this.locked === t.id || this.candidate === t.id ? THEME.color.accent : THEME.color.line)) return;
    this.boxes.setFacing(t.id, t.facing);
    if (!previous || previous.label !== t.label || previous.tagged !== t.tagged || previous.connection !== t.connection) this.refreshTargetLabel(t);
    if (this.locked === t.id && (previous?.label !== t.label || previous?.status !== t.status || previous?.connection !== t.connection || previous?.tagged !== t.tagged)) this.refreshCard();
  }
  private refreshTargetLabel(t: HudTarget): void {
    let label = this.labels.get(t.id);
    if (!label) { label = new Group(); label.name = `target-label:${t.id}`; this.labels.set(t.id, label); this.root.add(label); }
    this.clear(label);
    const removable = this.home.mode === 'annotate' && t.tagged && this.locked === t.id;
    const connection = t.connection ?? 'unknown';
    const status = this.home.mode === 'control' && t.tagged ? ({ ready: 'Ready', setup: 'Set up', offline: 'Not connected', unknown: 'Unknown' } as const)[connection] : '';
    const text = removable ? 'Untag' : `${title(t.label, 22)}${status ? ` · ${status}` : ''}`;
    const width = Math.max(0.09, Math.ceil((text.length * THEME.font.label * 0.56 + THEME.box.labelPadding * 3) * 100) / 100);
    if (removable) this.button(label, `tag-remove:${t.id}`, text, width / 2, 0, width, 'handle', () => this.events.emit('tagRemove', { targetId: t.id }));
    else {
      const pill = this.surfaces.create(width, THEME.box.labelHeight, t.tagged ? 'selected' : 'plate', true);
      pill.position.x = width / 2;
      const name = makeText({ text, size: THEME.font.label, weight: 500, singleLine: true, maxWidth: width - THEME.box.labelPadding * 2 });
      name.position.set(THEME.box.labelPadding, 0, THEME.panel.depth);
      label.add(pill, name);
    }
  }
  removeTarget(id: string): void {
    this.targets.delete(id); this.boxes.remove(id);
    const label = this.labels.get(id); if (label) { label.removeFromParent(); this.clear(label); this.labels.delete(id); }
    if (this.locked === id) { this.locked = null; this.refreshCard(); }
  }
  clearTargets(): void { for (const id of this.targets.keys()) this.removeTarget(id); }
  setCandidate(id: string | null): void {
    const old = this.candidate; this.candidate = id;
    if (old && old !== this.locked) this.boxes.boxes.get(old)?.tColor.set(this.targets.get(old)?.tagged ? THEME.color.accent : THEME.color.line);
    if (id) this.boxes.boxes.get(id)?.tColor.set(THEME.color.accent);
  }
  setLocked(id: string | null): void {
    const old = this.locked; this.locked = id;
    if (old !== id) { this.evidence = null; this.upload = null; this.selectedAction = null; this.unfoldStarted = this.time; }
    if (old && old !== this.candidate) this.boxes.boxes.get(old)?.tColor.set(this.targets.get(old)?.tagged ? THEME.color.accent : THEME.color.line);
    if (id) this.boxes.boxes.get(id)?.tColor.set(THEME.color.accent);
    if (old && this.targets.has(old)) this.refreshTargetLabel(this.targets.get(old)!);
    if (id && this.targets.has(id)) this.refreshTargetLabel(this.targets.get(id)!);
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
    const wrapped: string[] = [];
    for (const line of lines) for (const row of line.split('\n')) {
      const words = row.split(/\s+/); let current = '';
      for (const word of words) { if ((current + ' ' + word).trim().length > 34) { if (current) wrapped.push(current); current = word.slice(0, 34); } else current = (current + ' ' + word).trim(); }
      if (current) wrapped.push(current);
    }
    setText(this.detailText, wrapped.slice(-THEME.panel.detailLines).join('\n') || 'No activity yet.');
  }
  renderSpec(spec: Gen3dSpec, at: { targetId?: string; position?: [number, number, number]; yawDeg?: number }): void {
    const previous = this.specs.get(spec.specId);
    const m: Mounted = { spec, targetId: at.targetId ?? previous?.targetId, position: at.position ?? previous?.position, armed: previous?.armed ?? false, values: previous?.values ?? new Map(), selectedButton: previous?.selectedButton };
    for (const c of spec.controls) if (!m.values.has(c.id)) m.values.set(c.id, c.default ?? 0);
    this.specs.set(spec.specId, m); this.refreshCard(); this.place();
  }
  patchSpec(id: string, patch: Patch): { ok: boolean; errors?: string[] } {
    const m = this.specs.get(id); if (!m) return { ok: false, errors: [`No spec ${id}`] };
    const result = applyPatch(m.spec, patch);
    if (!result.ok) return { ok: false, errors: result.errors.map((e) => `${e.path}: ${e.message}`) };
    m.spec = result.spec; this.refreshCard(); return { ok: true };
  }
  removeSpec(id: string): void { this.specs.delete(id); this.refreshCard(); }
  setArmed(id: string, armed: boolean, _reason?: string, controlIds?: string[]): void {
    const m = this.specs.get(id); if (!m) return;
    if (controlIds && armed) m.armed = true;
    if (controlIds) m.spec = { ...m.spec, controls: m.spec.controls.map((c) => controlIds.includes(c.id) ? { ...c, armed } : c) };
    else { m.armed = armed; m.spec = { ...m.spec, state: { ...m.spec.state, armed } }; }
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
    if (confirm && this.home.mode !== 'control') return;
    this.confirm = confirm; this.clear(this.modal); this.modal.visible = !!confirm; if (!confirm) {
      if (this.approvals.length) this.showApprovals(this.approvals);
      else if (this.pairing) this.showPairing(this.pairing);
      return;
    }
    this.modal.add(this.plate(THEME.panel.width, 0.32));
    this.label(this.modal, title(confirm.title), 0.105, THEME.font.title);
    const summary = makeText({ text: (confirm.summary ?? (confirm.hold ? 'Hold to confirm.' : 'Confirm this action.')).slice(0, 200), size: THEME.font.label, anchorX: 'center', anchorY: 'top', maxWidth: THEME.panel.textWidth, maxHeight: 0.11 });
    summary.name = 'confirmation-summary'; summary.position.set(0, 0.05, THEME.panel.depth); this.modal.add(summary);
    const arm = confirm.title.trim().toLowerCase() === 'arm controls';
    let startedAt = 0;
    this.button(this.modal, 'confirm-yes', confirm.hold ? arm ? 'Hold to arm' : 'Hold to allow' : arm ? 'Arm' : 'Allow', THEME.control.buttonWidth / 1.5, -0.1, THEME.control.buttonWidth * 1.5, 'confirm', () => { startedAt = this.time; }, () => {
      if ((!confirm.expiresAt || Date.now() < confirm.expiresAt) && (!confirm.hold || (this.time - startedAt) * 1000 >= THEME.control.holdMs)) this.events.emit('confirm', { id: confirm.id, approve: true, hold: !!confirm.hold });
    });
    this.button(this.modal, 'confirm-no', 'Cancel', -THEME.control.buttonWidth, -0.1, THEME.control.buttonWidth, 'confirm', () => this.events.emit('confirm', { id: confirm.id, approve: false }));
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
  setHome(state: HomeState): void {
    const changed = this.home.mode !== state.mode || this.home.filter !== state.filter;
    const modeChanged = this.home.mode !== state.mode;
    this.home = { ...state };
    if (modeChanged) {
      this.detailsOpen = false; this.details.visible = false;
      this.confirm = null; this.clear(this.modal); this.modal.visible = false;
      this.deviceState = null;
      for (const target of this.targets.values()) this.refreshTargetLabel(target);
      this.refreshCard();
    }
    if (changed) this.refreshHome();
    setText(this.homeCount, `${state.tagged} tagged`);
    setText(this.homeStatus, state.status);
    this.place();
  }
  setDeviceState(state: DeviceState | null): void {
    const previous = this.deviceState;
    if (previous === state || previous && state && previous.targetId === state.targetId && previous.connection === state.connection && previous.hint === state.hint && previous.busy === state.busy && previous.sentence === state.sentence && previous.handControl === state.handControl) return;
    this.deviceState = state;
    this.refreshCard();
  }
  private refreshHome(): void {
    // These persistent labels are detached before clearing the buttons.
    this.homeCount.removeFromParent(); this.homeStatus.removeFromParent();
    this.clear(this.deck);
    const annotate = this.home.mode === 'annotate';
    this.deck.add(this.plate(0.48, annotate ? 0.22 : 0.16));
    for (const [mode, text, x] of [['annotate', 'Annotate', -0.115], ['control', 'Control', 0.115]] as const) {
      const button = this.button(this.deck, `mode-${mode}`, text, x, annotate ? 0.066 : 0.036, 0.216, 'deck', () => this.events.emit('mode', { mode }));
      this.selectButton(button.group, this.home.mode === mode, 0.216);
    }
    this.homeCount.position.set(annotate && !this.wristOpen ? 0 : -0.145, annotate ? 0.015 : -0.022, THEME.panel.depth);
    this.homeStatus.position.set(0, annotate ? -0.088 : -0.058, THEME.panel.depth);
    this.deck.add(this.homeCount, this.homeStatus);
    setText(this.homeCount, `${this.home.tagged} tagged`); setText(this.homeStatus, this.home.status);
    if (annotate) for (const [filter, text, x] of [['electronics', 'Electronics', -0.152], ['lights', 'Lights', 0], ['everything', 'All devices', 0.152]] as const) {
      const button = this.button(this.deck, `filter:${filter}`, text, x, -0.035, 0.14, 'deck', () => this.events.emit('filter', { filter }));
      this.selectButton(button.group, this.home.filter === filter, 0.14);
    }
    else this.button(this.deck, 'deck:panic', 'Stop', 0.15, -0.022, 0.12, 'deck', () => this.events.emit('deck', { key: 'panic', phase: 'press' }), () => this.events.emit('deck', { key: 'panic', phase: 'release' }));
    if (this.wristOpen) this.button(this.deck, 'deck-close', 'Close', annotate ? 0.15 : 0, annotate ? 0.015 : -0.022, 0.11, 'deck', () => this.setDeck({ open: false }));
    this.homeCount.visible = true;
  }
  setDeck(d: { open?: boolean; scanning?: boolean; daemons?: boolean; at?: [number, number, number] }): void {
    if (d.open === true && !this.wristOpen) {
      this.homePosition.copy(this.deck.position); this.homeRotation.copy(this.deck.quaternion);
      this.wristOpen = true;
      this.deckAt = d.at;
      if (this.deckAt) { this.deck.position.fromArray(this.deckAt); this.face(this.deck); }
      this.refreshHome();
    } else if (d.open === false && this.wristOpen) {
      this.wristOpen = false; this.deckAt = undefined;
      this.deck.position.copy(this.homePosition); this.deck.quaternion.copy(this.homeRotation);
      this.refreshHome();
    }
  }
  toast(text: string, _level?: 'info' | 'ok' | 'warn' | 'error'): void { setText(this.noticeText, text.slice(0, 72)); if (!this.notice.visible) this.noticePlacement.reset(); this.notice.visible = true; this.noticeUntil = this.time + 3; this.place(); }
  private face(object: Object3D): void {
    this.boxes.facingQuaternion(this.head, object.position, this.facing); object.quaternion.copy(this.facing);
  }
  private follow(panel: Group, placement: WorldPanel): void {
    placement.update(panel, this.headPose, this.time * 1000);
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
    const target = this.selected(), m = this.mounted();
    this.card.visible = this.home.mode === 'control' && !!target?.tagged && !this.modal.visible;
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
      this.openingBesideTarget = !!box && !this.docked;
      if (box && this.openingBesideTarget) {
        this.boxes.facingQuaternion(this.head, box.center, this.card.quaternion, box.facing);
        this.right.set(1, 0, 0).applyQuaternion(this.card.quaternion);
        this.cardEdge.copy(box.center).addScaledVector(this.right, box.w / 2 + THEME.card.gap);
      } else if (m?.position) {
        this.card.position.fromArray(m.position); this.face(this.card);
        this.idlePlacement.anchor(this.card, this.headPose, this.time * 1000);
      }
    }
    if (box) {
      if (this.openingBesideTarget) {
        this.card.position.copy(this.cardEdge).addScaledVector(this.right, THEME.card.width / 2 * this.card.scale.x);
        if (unfold >= 1) {
          this.dockPlacement.anchor(this.card, this.headPose, this.time * 1000);
          this.openingBesideTarget = false;
        }
      } else this.follow(this.card, this.dockPlacement);
      this.placeTether(box.id);
    } else {
      this.tether.hide();
      this.follow(this.card, this.idlePlacement);
    }
    if (this.modal.visible) this.follow(this.modal, this.modalPlacement);
    else this.modalPlacement.reset();
    if (!this.wristOpen) {
      this.follow(this.deck, this.deckPlacement);
      if (this.card.visible) this.panelSeparation.update(this.card, this.deck, this.headPose, THEME.card.width, THEME.card.height, 0.48, 0.16);
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
      if (!visible(widget.group) || this.modal.visible && !this.modal.getObjectById(widget.group.id) && !this.deck.getObjectById(widget.group.id)) continue;
      const candidate = this.hit(widget, cursor);
      if (candidate !== Infinity && candidate <= distance) { distance = candidate; hover = widget; }
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
        capture.dragNear = cursor.canPoke && Math.abs(this.point.copy(cursor.tip).applyMatrix4(capture.pokePlane).z) <= THEME.control.near;
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
        if (active.move && this.dragPoint(cursor, capture)) active.move(this.local);
        active.end?.();
      } else if (cursor.pinching && active.move && this.time - active.lastMove >= 1 / THEME.control.dragHz) {
        active.lastMove = this.time;
        if (this.dragPoint(cursor, capture)) active.move(this.local);
      }
    } else if (released) capture.mode = null;
    capture.wasPinching = cursor.pinching;
    capture.hasTip = cursor.canPoke;
    if (cursor.canPoke) capture.tip.copy(cursor.tip);
  }
  private dragPoint(cursor: Cursor, capture: Capture): boolean {
    if (capture.dragNear) {
      if (!cursor.canPoke) return false;
      this.local.copy(cursor.tip).applyMatrix4(capture.pokePlane);
      // A lost depth estimate cannot turn a near drag into an unrelated ray drag.
      return Math.abs(this.local.z) < 0.15;
    }
    if (!cursor.ray) return false;
    this.origin.copy(cursor.ray.origin).applyMatrix4(capture.pokePlane);
    this.direction.copy(cursor.ray.origin).add(cursor.ray.dir).applyMatrix4(capture.pokePlane).sub(this.origin);
    if (Math.abs(this.direction.z) < 1e-6) return false;
    const distance = -this.origin.z / this.direction.z;
    if (distance < 0 || distance > THEME.control.rayDistance) return false;
    this.local.copy(this.origin).addScaledVector(this.direction, distance);
    return true;
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
    for (const target of this.targets.values()) {
      if (this.home.mode === 'control' && !target.tagged) this.boxes.setOpacity(target.id, 0);
      else if (this.home.mode === 'annotate' && this.boxes.boxes.get(target.id)?.opacity === 0) this.boxes.setOpacity(target.id, 1);
    }
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
    for (let i = 0; i < this.cursors.length; i++) {
      const cursor = this.cursors[i]!; let distance = Infinity; this.reticleHits[i] = null;
      if (!cursor.tracked) continue;
      for (const widget of this.widgets) {
        if (!visible(widget.group)) continue;
        const hit = this.hit(widget, cursor);
        if (hit < distance) { distance = hit; this.reticleHits[i] = this.reticlePoints[i]!.copy(this.local).applyMatrix4(widget.group.matrixWorld); }
      }
    }
    this.reticles.update(this.cursors, this.head, frame.dt, this.boxes, this.reticleHits);
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
