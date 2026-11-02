import { Camera, Group, Matrix4, Mesh, MeshBasicMaterial, Object3D, PlaneGeometry, Quaternion, Scene, Shape, ShapeGeometry, SphereGeometry, Vector3, type WebGLRenderer } from 'three';
import { applyPatch, type Control, type ControlEvent, type Gen3dSpec, type HackItem, type ModelChip, type Patch } from '@ce/gen3d';
import { Emitter } from '../../gen3d/events';
import { handCursor, newCursor, type Cursor } from '../../gen3d/interact';
import type { AgentStepLike, ConfirmRequest, DeckKey, EvidenceState, Hud, HudEvents, HudFrame, HudTarget, PingLine, UploadState } from '../contract';
import { BoxField } from './boxes';
import { makeText, setText, type SdfText } from './text';
import { THEME } from './theme';
export { whenSdfReady } from './text';
export { THEME } from './theme';

interface Mounted {
  spec: Gen3dSpec;
  targetId?: string;
  position?: [number, number, number];
  armed: boolean;
  values: Map<string, ControlEvent['value']>;
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
}
interface Capture { widget: Widget | null; startedAt: number }

function title(value: string, length = 36): string {
  const s = value.trim().slice(0, length);
  return s === s.toUpperCase() ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;
}
function roundedGeometry(w: number, h: number, r: number): ShapeGeometry {
  const shape = new Shape(), x = -w / 2, y = -h / 2;
  shape.moveTo(x + r, y); shape.lineTo(x + w - r, y);
  shape.quadraticCurveTo(x + w, y, x + w, y + r); shape.lineTo(x + w, y + h - r);
  shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h); shape.lineTo(x + r, y + h);
  shape.quadraticCurveTo(x, y + h, x, y + h - r); shape.lineTo(x, y + r);
  shape.quadraticCurveTo(x, y, x + r, y);
  return new ShapeGeometry(shape, THEME.box.cornerSteps);
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
  private readonly labels = new Map<string, SdfText>();
  private readonly specs = new Map<string, Mounted>();
  private readonly menus = new Map<string, { title: string; items: HackItem[] }>();
  private readonly logs = new Map<string, AgentStepLike>();
  private readonly history: EvidenceState[] = [];
  private readonly widgets: Widget[] = [];
  private readonly captures = new Map<string, Capture>();
  private readonly cursors = [newCursor('left', 'left'), newCursor('right', 'right')];
  private devCursors: Cursor[] = [];
  private readonly materials = {
    plate: new MeshBasicMaterial({ color: THEME.color.plate, transparent: true, opacity: THEME.opacity.plate, depthWrite: false, toneMapped: false }),
    button: new MeshBasicMaterial({ color: THEME.color.button, toneMapped: false }),
    accent: new MeshBasicMaterial({ color: THEME.color.accent, toneMapped: false }),
  };
  private readonly geometries = new Map<string, ShapeGeometry>();
  private readonly trackGeometry = new PlaneGeometry(1, 1);
  private readonly cursorGeometry = new SphereGeometry(THEME.control.thumbWidth / 3, 6, 4);
  private readonly handDots: Mesh[] = [];
  private readonly card = new Group();
  private readonly controls = new Group();
  private readonly details = new Group();
  private readonly modal = new Group();
  private readonly deck = new Group();
  private readonly notice = new Group();
  private readonly heading = makeText({ text: 'Look at a device', size: THEME.font.title, weight: 600, singleLine: true, maxWidth: THEME.control.width });
  private readonly status = makeText({ text: 'Pinch a box to learn.', singleLine: true, maxWidth: THEME.control.width });
  private readonly detailText = makeText({ text: '', size: THEME.font.detail, maxWidth: THEME.panel.textWidth, anchorY: 'top' });
  private readonly noticeText = makeText({ text: '', maxWidth: THEME.panel.textWidth, anchorX: 'center' });
  private locked: string | null = null;
  private candidate: string | null = null;
  private menuTarget: string | null = null;
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

  constructor(scene: Scene, private readonly camera: Camera) {
    this.root.name = 'hud-v2';
    this.card.name = 'device-card';
    this.controls.name = 'device-controls';
    this.details.name = 'details-panel';
    this.modal.name = 'confirmation-panel';
    this.deck.name = 'deck';
    this.notice.name = 'notice';
    this.root.add(this.boxes, this.card, this.modal, this.deck, this.notice);
    this.card.add(this.plate(THEME.card.width, THEME.card.height), this.heading, this.status, this.controls, this.details);
    this.heading.position.set(-THEME.card.width / 2 + THEME.card.padding, THEME.card.titleY, THEME.panel.depth);
    this.status.position.set(this.heading.position.x, THEME.card.statusY, THEME.panel.depth);
    this.details.position.y = -THEME.card.height / 2 - THEME.panel.detailHeight / 2 - THEME.panel.gap;
    this.details.add(this.plate(THEME.panel.width, THEME.panel.detailHeight), this.detailText);
    this.detailText.position.set(-THEME.panel.textWidth / 2, THEME.panel.detailHeight / 2 - THEME.card.padding, THEME.panel.depth);
    this.details.visible = false;
    this.notice.add(this.noticeText);
    this.notice.visible = this.modal.visible = this.deck.visible = false;
    for (const hand of ['left', 'right']) {
      const dot = new Mesh(this.cursorGeometry, this.materials.accent);
      dot.name = `${hand}-cursor`;
      dot.visible = false;
      this.handDots.push(dot);
      this.root.add(dot);
      this.captures.set(hand, { widget: null, startedAt: 0 });
    }
    scene.add(this.root);
    this.camera.getWorldPosition(this.head);
    this.camera.getWorldQuaternion(this.headQuaternion);
    this.refreshCard();
    this.place();
  }
  on<K extends keyof HudEvents>(key: K, fn: (e: HudEvents[K]) => void): () => void { return this.events.on(key, fn); }
  setDevCursors(cursors: Cursor[]): void {
    this.devCursors = cursors;
    for (const c of cursors) if (!this.captures.has(c.id)) this.captures.set(c.id, { widget: null, startedAt: 0 });
  }
  private plate(w: number, h: number, button = false): Mesh {
    const key = `${w}/${h}/${button}`;
    let geometry = this.geometries.get(key);
    if (!geometry) { geometry = roundedGeometry(w, h, button ? THEME.control.radius : THEME.card.radius); this.geometries.set(key, geometry); }
    const mesh = new Mesh(geometry, button ? this.materials.button : this.materials.plate);
    mesh.renderOrder = THEME.render.plates;
    return mesh;
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
    group.add(this.plate(w, THEME.control.height, true));
    this.label(group, text, 0, THEME.font.label);
    parent.add(group);
    const widget: Widget = { group, w, h: THEME.control.height, kind, start, end, lastMove: 0 };
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
    let text = this.locked ? 'Learning…' : this.scanning ? 'Pinch a box to learn.' : 'Start scanning to find devices.';
    if (target?.status === 'uploading' || target?.status === 'awaiting') text = 'Testing: did it react?';
    if (target?.status === 'failed' || target?.status === 'no-reaction') text = 'No reaction. Try again.';
    if (m && m.spec.controls.some((c) => this.isArmed(m, c))) text = 'Ready';
    if (this.upload?.verdict === 'pending' || this.evidence?.verdict === 'pending') text = 'Testing: did it react?';
    if (this.evidence?.verdict === 'fail') text = 'No reaction. Try again.';
    setText(this.status, text);
  }
  private refreshCard(): void {
    const target = this.selected(), m = this.mounted();
    const menu = this.menus.get(this.locked ?? this.menuTarget ?? '');
    this.card.visible = !this.scanning || !!this.locked;
    setText(this.heading, title(target?.label ?? menu?.title ?? m?.spec.title ?? 'Look at a device', 24));
    this.refreshStatus();
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
      else if ((c.kind === 'trigger' || c.kind === 'toggle') && buttons.length < 3) buttons.push(c);
    }
    if (m && main) this.mainControl(m, main);
    if (m && buttons.length) buttons.forEach((c, index) => this.controlButton(m, c, index, buttons.length));
    else if (menu && (m?.armed || target?.status === 'verified' || target?.status === 'controlled')) {
      const shown = menu.items.filter((item) => item.kind !== 'control' && item.status !== 'locked').slice(0, 3);
      shown.forEach((item, index) => this.button(this.controls, `action:${item.id}`, title(item.label, 12), (index - (shown.length - 1) / 2) * (THEME.control.buttonWidth + THEME.control.buttonGap), THEME.card.buttonsY, THEME.control.buttonWidth, 'hack', () => this.events.emit('hack', { targetId: this.locked ?? this.menuTarget!, itemId: item.id, controlId: item.controlId, index: menu.items.indexOf(item) })));
    }
  }
  private controlButton(m: Mounted, c: Control, index: number, count: number): void {
    const widget = this.button(this.controls, `control:${c.id}`, title(c.label, 12), (index - (count - 1) / 2) * (THEME.control.buttonWidth + THEME.control.buttonGap), THEME.card.buttonsY, THEME.control.buttonWidth, 'control', () => {
      m.values.set(c.id, c.kind === 'toggle' ? !m.values.get(c.id) : true);
      this.emitControl(m, c, 'start');
    }, () => { if (c.kind === 'trigger') m.values.set(c.id, false); this.emitControl(m, c, 'end'); });
    widget.group.userData.controlId = c.id;
  }
  private mainControl(m: Mounted, c: Control): void {
    const group = new Group();
    group.name = `main-control:${c.id}`;
    group.position.y = THEME.card.mainY;
    const track = new Mesh(this.trackGeometry, this.materials.button);
    track.scale.set(THEME.control.width, THEME.control.trackHeight, 1);
    const thumb = new Mesh(this.trackGeometry, this.materials.accent);
    thumb.name = 'value';
    thumb.scale.set(THEME.control.thumbWidth, THEME.control.height / 2, 1);
    thumb.position.z = THEME.panel.depth;
    const label = this.label(group, title(c.label), THEME.control.labelOffset, THEME.font.label);
    label.name = 'control-label';
    group.add(track, thumb);
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
    thumb.position.x = (Math.min(1, Math.max(0, (x - range.min) / (range.max - range.min || 1))) - 0.5) * THEME.control.width;
  }
  private emitControl(m: Mounted, c: Control, phase: ControlEvent['phase']): void {
    if (this.isArmed(m, c)) this.events.emit('control', { specId: m.spec.specId, controlId: c.id, value: m.values.get(c.id) ?? c.default ?? 0, phase, ts: Date.now() });
  }
  setScanning(on: boolean, _info?: { modelId?: string }): void { if (this.scanning === on) return; this.scanning = on; this.refreshCard(); }
  upsertTarget(t: HudTarget): void {
    const previous = this.targets.get(t.id);
    this.targets.set(t.id, t);
    this.point.fromArray(t.position);
    if (!this.boxes.set(t.id, this.point, t.sizeM?.[0] ?? THEME.box.defaultWidth, t.sizeM?.[1] ?? THEME.box.defaultHeight, this.locked === t.id || this.candidate === t.id ? THEME.color.accent : THEME.color.line)) return;
    this.boxes.setFacing(t.id, t.facing);
    let label = this.labels.get(t.id);
    if (!label) { label = makeText({ text: title(t.label, 22), size: THEME.font.label }); label.name = `target-label:${t.id}`; this.labels.set(t.id, label); this.root.add(label); }
    else setText(label, title(t.label, 22));
    if (this.locked === t.id && (previous?.label !== t.label || previous?.status !== t.status)) this.refreshCard();
  }
  removeTarget(id: string): void {
    this.targets.delete(id); this.boxes.remove(id);
    const label = this.labels.get(id); if (label) { label.removeFromParent(); label.dispose(); this.labels.delete(id); }
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
    if (old !== id) { this.evidence = null; this.upload = null; }
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
    const m: Mounted = { spec, targetId: at.targetId ?? previous?.targetId, position: at.position ?? previous?.position, armed: spec.state?.armed ?? false, values: previous?.values ?? new Map() };
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
    if (c && thumb && this.mounted() === m) this.positionThumb(m, c, thumb);
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
    if (d.open !== undefined) this.deck.visible = d.open;
    if (!this.deck.visible) return;
    this.clear(this.deck);
    const keys: [DeckKey, string][] = [['scan', 'Scan'], ['ping', 'Connect'], ['daemons', 'Automations'], ['undo', 'Undo'], ['mic', 'Voice'], ['panic', 'Stop']];
    const rows = Math.ceil(keys.length / 3);
    this.deck.add(this.plate(THEME.panel.width, rows * THEME.panel.row + THEME.card.padding * 2));
    keys.forEach(([key, label], i) => this.button(this.deck, `deck:${key}`, label, (i % 3 - 1) * (THEME.control.buttonWidth + THEME.control.buttonGap), ((rows - 1) / 2 - Math.floor(i / 3)) * THEME.panel.row, THEME.control.buttonWidth, 'deck', () => this.events.emit('deck', { key, phase: 'press' }), () => this.events.emit('deck', { key, phase: 'release' })));
    if (d.at) this.deck.position.fromArray(d.at); else this.placeHeadPanel(this.deck, THEME.panel.headY); this.face(this.deck);
  }
  toast(text: string, _level?: 'info' | 'ok' | 'warn' | 'error'): void { setText(this.noticeText, text.slice(0, 72)); this.notice.visible = true; this.noticeUntil = this.time + 3; this.placeHeadPanel(this.notice, THEME.panel.toastY); this.face(this.notice); }
  private face(object: Object3D): void {
    this.boxes.facingQuaternion(this.head, object.position, this.facing); object.quaternion.copy(this.facing);
  }
  private placeHeadPanel(panel: Group, y: number): void {
    this.direction.set(0, 0, -1).applyQuaternion(this.headQuaternion);
    panel.position.copy(this.head).addScaledVector(this.direction, THEME.card.distance); panel.position.y += y;
  }
  private place(): void {
    const target = this.selected(), m = this.mounted();
    if (target) {
      this.point.fromArray(target.position);
      this.direction.subVectors(this.head, this.point).setY(0);
      if (this.direction.lengthSq() < 1e-6) this.right.set(1, 0, 0).applyQuaternion(this.headQuaternion).setY(0).normalize();
      else { this.direction.normalize(); this.right.set(this.direction.z, 0, -this.direction.x); }
      this.card.position.copy(this.point).addScaledVector(this.right, (target.sizeM?.[0] ?? THEME.box.defaultWidth) / 2 + THEME.card.width / 2 + THEME.card.gap);
    } else if (m?.position) this.card.position.fromArray(m.position);
    else this.placeHeadPanel(this.card, THEME.panel.headY);
    this.face(this.card);
    if (this.modal.visible) { this.placeHeadPanel(this.modal, 0); this.face(this.modal); }
  }
  private hit(widget: Widget, cursor: Cursor, clampToFace = false): number {
    this.inverse.copy(widget.group.matrixWorld).invert();
    this.local.copy(cursor.position).applyMatrix4(this.inverse);
    let distance = Math.abs(this.local.z);
    if (!cursor.canPoke || distance > THEME.control.near || Math.abs(this.local.x) > widget.w / 2 + THEME.control.hitPadding || Math.abs(this.local.y) > widget.h / 2 + THEME.control.hitPadding) {
      if (!cursor.ray) return Infinity;
      this.origin.copy(cursor.ray.origin).applyMatrix4(this.inverse);
      this.direction.copy(cursor.ray.dir).transformDirection(this.inverse);
      if (Math.abs(this.direction.z) < 1e-6) return Infinity;
      distance = -this.origin.z / this.direction.z;
      if (distance < 0 || distance > THEME.control.rayDistance) return Infinity;
      this.local.copy(this.origin).addScaledVector(this.direction, distance);
    }
    if (!clampToFace && (Math.abs(this.local.x) > widget.w / 2 + THEME.control.hitPadding || Math.abs(this.local.y) > widget.h / 2 + THEME.control.hitPadding)) return Infinity;
    return distance;
  }
  private interact(cursor: Cursor): void {
    const capture = this.captures.get(cursor.id); if (!capture) return;
    if (!cursor.tracked) {
      const active = capture.widget; capture.widget = null;
      if (active?.kind === 'control' || active?.kind === 'deck') active.end?.();
      return;
    }
    if (cursor.justPinched) {
      let winner: Widget | null = null, distance = Infinity;
      for (const widget of this.widgets) {
        if (!visible(widget.group) || this.confirm && !this.modal.getObjectById(widget.group.id)) continue;
        const candidate = this.hit(widget, cursor);
        if (candidate < distance) { distance = candidate; winner = widget; }
      }
      capture.widget = winner; capture.startedAt = this.time;
      if (winner) {
        this.hit(winner, cursor);
        this.events.emit('consumed', { hand: cursor.hand, widget: winner.kind });
        winner.start(this.local);
      }
    }
    const active = capture.widget;
    if (!active) return;
    this.events.emit('consumed', { hand: cursor.hand, widget: active.kind });
    if (cursor.justReleased) {
      capture.widget = null;
      if (active.move && this.hit(active, cursor, true) !== Infinity) active.move(this.local);
      active.end?.();
    }
    else if (cursor.pinching && active.move && this.time - active.lastMove >= 1 / THEME.control.dragHz) {
      active.lastMove = this.time;
      if (this.hit(active, cursor, true) !== Infinity) active.move(this.local);
    }
  }
  update(frame: HudFrame): void {
    this.time = frame.time / 1000;
    this.head.copy(frame.head.position); this.headQuaternion.copy(frame.head.quaternion);
    this.boxes.update(frame.dt, this.head);
    for (const [id, label] of this.labels) {
      const box = this.boxes.boxes.get(id); if (!box) continue;
      this.boxes.labelAnchor(box, this.head, label.position);
      this.boxes.facingQuaternion(this.head, box.center, label.quaternion, box.facing);
    }
    this.place();
    this.root.updateMatrixWorld(true);
    handCursor('left', frame.hands.left, this.cursors[0]!); handCursor('right', frame.hands.right, this.cursors[1]!);
    this.cursors[0]!.canPoke = !frame.hands.left?.controller;
    this.cursors[1]!.canPoke = !frame.hands.right?.controller;
    for (let i = 0; i < this.cursors.length; i++) {
      const cursor = this.cursors[i]!, dot = this.handDots[i]!;
      dot.visible = cursor.tracked;
      if (cursor.tracked) dot.position.copy(cursor.position);
      this.interact(cursor);
    }
    for (const cursor of this.devCursors) this.interact(cursor);
    if (this.notice.visible && this.time > this.noticeUntil) this.notice.visible = false;
  }
  dispose(): void {
    this.root.traverse((o) => { if ('sync' in o && 'dispose' in o) (o as SdfText).dispose(); });
    this.boxes.dispose();
    for (const geometry of this.geometries.values()) geometry.dispose();
    for (const material of Object.values(this.materials)) material.dispose();
    this.trackGeometry.dispose(); this.cursorGeometry.dispose(); this.root.removeFromParent();
  }
}
