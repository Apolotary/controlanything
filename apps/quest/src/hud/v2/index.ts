import { Camera, Group, Matrix4, Mesh, MeshBasicMaterial, Object3D, PlaneGeometry, Quaternion, Scene, Shape, ShapeGeometry, Vector3, type WebGLRenderer } from 'three';
import { applyPatch, type Control, type ControlEvent, type Gen3dSpec, type HackItem, type ModelChip, type Patch } from '@ce/gen3d';
import { Emitter } from '../../gen3d/events';
import { handCursor, newCursor, type Cursor } from '../../gen3d/interact';
import type { AgentStepLike, ConfirmRequest, DeviceState, HomeState, EvidenceState, HelperPairingView, Hud, HudEvents, HudFrame, HudTarget, PingLine, UploadState } from '../contract';
import { homeHint } from '../home';
import { controlPower, isBrightness } from './control-state';
import { PairCodeEntry, PAIR_CODE_KEYS } from './pair-code';
import { HelperPairingCard, HELPER_PAIRING_TARGET } from './helper-pairing';
import { targetChipLabel } from './target-chip';
import { BoxField } from './boxes';
import { makeText, setText, type SdfText } from './text';
import { THEME } from './theme';
import { GlassSurfaces } from './surface';
import { PinchReticles } from './reticle';
import { unfoldEase } from './motion';
import { TargetTether } from './tether';
import { PanelSeparation, WorldPanel } from './world-panel';
import { DockIcons } from './dock-icons';
import { FingerTouchDetector, HandDockAnchor } from './hand-dock';
import { PinchTargetHistory, expandedRayBounds, rayTargetWithinAngle } from '../../app/precision';
import { CardPlacement, EdgePlacement, angularScale } from './comfort';
import { acceptsCommandResult, commandTimedOut, commandSubtitle, routeLabel, type CommandState } from './command-state';
export { whenSdfReady } from './text';
export { THEME } from './theme';

interface Mounted {
  spec: Gen3dSpec;
  targetId?: string;
  position?: [number, number, number];
  armed: boolean;
  values: Map<string, ControlEvent['value']>;
  selectedButton?: string;
  power?: boolean;
  command?: CommandState;
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
  history: PinchTargetHistory<Widget>;
}
const newCapture = (): Capture => ({ widget: null, mode: null, wasPinching: false, tip: new Vector3(), hasTip: false, pokeBlocked: false, pokePlane: new Matrix4(), dragNear: false, history: new PinchTargetHistory<Widget>() });

function title(value: string, length = 36): string {
  const s = value.trim().slice(0, length);
  return s === s.toUpperCase() ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;
}
function visible(object: Object3D | null): boolean {
  for (let current = object; current; current = current.parent) if (!current.visible) return false;
  return true;
}

export function createHud(ctx: { scene: Scene; camera: Camera; renderer: WebGLRenderer; nonDominant?: 'left' | 'right' }): Hud {
  return new LeanHud(ctx.scene, ctx.camera, ctx.nonDominant);
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
  private readonly helperPairing = new HelperPairingCard(this.surfaces);
  private helperPairingView: HelperPairingView | null = null;
  private readonly trackGeometry = new PlaneGeometry(1, 1);
  private readonly reticles = new PinchReticles();
  private readonly reticlePoints = [new Vector3(), new Vector3()];
  private readonly reticleHits: (Vector3 | null)[] = [null, null];
  private readonly tether = new TargetTether();
  private readonly verdict = new Group();
  private readonly checkGeometry: ShapeGeometry;
  private readonly progress = new Group();
  private readonly progressFill = new Mesh(this.trackGeometry, this.materials.accent);
  private unfoldStarted = -Infinity;
  private controlsStarted = -Infinity;
  private controlsSignature = '';
  private readonly card = new Group();
  private pinned = false;
  private cardScale = 1;
  private readonly comfort = new CardPlacement();
  private readonly edgePlacement = new EdgePlacement();
  private readonly edge = new Group();
  private readonly edgeText = makeText({ text: '', size: THEME.font.detail, maxWidth: 0.25, singleLine: true });
  private readonly arrowGeometry: ShapeGeometry;
  private readonly edgeArrow: Mesh;
  private readonly lockGeometry: ShapeGeometry;
  private readonly controls = new Group();
  private readonly details = new Group();
  private readonly modal = new Group();
  private readonly deck = new DockIcons();
  private readonly handDock: HandDockAnchor;
  private readonly fingerTouch = new FingerTouchDetector();
  private fingerCapture: Widget | null = null;
  private readonly suppressedHands = new Set<string>();
  private home: HomeState = { mode: 'annotate', filter: 'everything', tagged: 0, status: 'Pinch a device to tag it' };
  private deviceState: DeviceState | null = null;
  private readonly dockHint = makeText({ text: '', size: 0.012, anchorX: 'center', maxWidth: 0.24 });
  private hintUntil = 0;
  private readonly coach = new Group();
  private coached = false;
  private coachUntil = 0;
  private readonly coachPlacement = new WorldPanel({ distance: 0.65, height: -0.1 });
  private readonly notice = new Group();
  private readonly heading = makeText({ text: 'Look at a device', size: THEME.font.title, weight: 600, singleLine: true, maxWidth: THEME.card.width - THEME.card.padding * 2 - THEME.card.chipWidth - 0.055 });
  private readonly status = makeText({ text: '', color: THEME.color.muted, maxWidth: THEME.control.width, maxHeight: 0.055, anchorY: 'top', singleLine: true });
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
  private codeEntry: PairCodeEntry | null = null;
  private codeTarget: string | null = null;
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
  private readonly panelSeparation = new PanelSeparation();
  private readonly deckPlacement = new WorldPanel({ distance: 0.6, height: -0.4, lateral: -0.24 });
  private readonly headPose = { position: this.head, quaternion: this.headQuaternion };
  private readonly noticePlacement = new WorldPanel({ height: THEME.panel.toastY });
  private placementKey = '';
  private hasFrame = false;
  constructor(scene: Scene, private readonly camera: Camera, nonDominant: 'left' | 'right' = 'left') {
    this.handDock = new HandDockAnchor(nonDominant);
    this.root.name = 'hud-v2';
    this.card.name = 'device-card';
    this.edge.name = 'device-edge-pill';
    const arrow = new Shape();
    arrow.moveTo(-0.009, -0.002); arrow.lineTo(0.002, -0.002); arrow.lineTo(0.002, -0.007);
    arrow.lineTo(0.011, 0); arrow.lineTo(0.002, 0.007); arrow.lineTo(0.002, 0.002); arrow.lineTo(-0.009, 0.002);
    this.arrowGeometry = new ShapeGeometry(arrow);
    this.edgeArrow = new Mesh(this.arrowGeometry, this.materials.accent);
    this.edgeArrow.name = 'edge-direction'; this.edgeArrow.position.set(-0.132, 0, THEME.panel.depth);
    this.edgeText.position.set(-0.11, 0, THEME.panel.depth);
    this.edge.add(this.plate(0.31, 0.044), this.edgeText, this.edgeArrow);
    this.edge.visible = false;
    this.root.add(this.edge);
    const lock = new Shape();
    lock.moveTo(-0.009, -0.01); lock.lineTo(0.009, -0.01); lock.lineTo(0.009, 0.003);
    lock.lineTo(0.006, 0.003); lock.lineTo(0.006, 0.009); lock.lineTo(-0.006, 0.009);
    lock.lineTo(-0.006, 0.003); lock.lineTo(-0.009, 0.003);
    this.lockGeometry = new ShapeGeometry(lock);
    this.controls.name = 'device-controls';
    this.details.name = 'details-panel';
    this.modal.name = 'confirmation-panel';
    this.deck.name = 'hand-dock';
    this.deck.wrist.name = 'wrist-mode';
    this.coach.name = 'hand-menu-coach';
    this.notice.name = 'notice';
    this.root.add(this.boxes, this.card, this.modal, this.deck, this.deck.wrist, this.coach, this.notice, this.reticles, this.tether);
    this.root.add(this.helperPairing);
    this.widgets.push({ group: this.helperPairing, w: this.helperPairing.width, h: this.helperPairing.height, kind: 'handle', start: () => {}, lastMove: 0 });
    for (const group of [this.helperPairing.typeCode, this.helperPairing.skip]) this.widgets.push({
      group, w: this.helperPairing.buttonWidth, h: THEME.control.buttonHeight, kind: 'handle', button: true, lastMove: 0,
      start: () => group === this.helperPairing.typeCode ? this.openPairCode(HELPER_PAIRING_TARGET) : this.events.emit('helperSkip', {}),
    });
    this.dockHint.name = 'dock-hint';
    this.dockHint.position.set(0, -0.048, THEME.panel.depth);
    this.dockHint.visible = false;
    this.deck.add(this.dockHint);
    const coachText = makeText({ text: `Turn your ${nonDominant} palm toward you for the menu`, size: THEME.font.body, anchorX: 'center', maxWidth: 0.34 });
    this.coach.add(this.plate(0.38, 0.075), coachText);
    coachText.position.z = THEME.panel.depth;
    this.coach.visible = false;
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
    this.verdict.position.set(0.085, THEME.card.titleY, THEME.panel.depth);
    this.verdict.add(this.surfaces.create(THEME.card.chipWidth, THEME.card.chipHeight, 'selected', true));
    const verified = makeText({ text: 'Verified', size: THEME.font.detail, color: THEME.color.accent, weight: 500 });
    verified.position.set(-THEME.card.chipWidth / 2 + 0.025, 0, THEME.panel.depth);
    const checkShape = new Shape();
    checkShape.moveTo(-0.005, 0); checkShape.lineTo(-0.001, -0.004);
    checkShape.lineTo(0.006, 0.004); checkShape.lineTo(0.0045, 0.0055);
    checkShape.lineTo(-0.001, -0.001); checkShape.lineTo(-0.0035, 0.0015);
    this.checkGeometry = new ShapeGeometry(checkShape);
    const check = new Mesh(this.checkGeometry, this.materials.accent);
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
    const text = state?.pairingSeconds ? `Look at the companion's QR code · ${state.pairingSeconds}s` : state?.busy ? state.sentence ?? 'Setting up control…' : connection === 'offline' ? state?.hint ?? 'Connect a companion to control this device.' : connection === 'unknown' ? 'Waiting for connection status…' : connection === 'setup' ? state?.hint ?? 'Set up control for this device.' : m?.armed ? 'Ready to control' : 'Confirm to enable controls';
    let subtitle = text;
    if (state?.busy) subtitle = commandSubtitle(undefined, '', '', state.sentence ?? text);
    else if (m?.armed && connection === 'ready') {
      let current = m.power === undefined ? 'Ready' : m.power ? 'On' : 'Off';
      if (m.power !== false) for (const c of m.spec.controls) {
        const value = m.values.get(c.id);
        if (isBrightness(c) && typeof value === 'number') { current += ` · ${Math.round(value)} %`; break; }
      }
      subtitle = commandSubtitle(m.command?.phase, routeLabel(m.spec.device?.transport, target?.channel), current);
    }
    const routeLine = connection === 'ready' || !!state?.busy;
    this.status.whiteSpace = routeLine ? 'nowrap' : 'normal';
    this.status.maxWidth = routeLine ? Infinity : THEME.control.width;
    this.status.userData.lineWidth = routeLine ? THEME.control.width : undefined;
    this.status.userData.fitHeight = routeLine ? 0.055 : 0.105;
    setText(this.status, subtitle.slice(0, 200));
    setText(this.edgeText, `${title(target?.label ?? '', 18)} · ${state?.busy ? 'Testing…' : m?.command?.phase === 'sending' ? 'Sending…' : this.pinned ? 'Locked' : 'Ready'}`);
    this.status.visible = !this.details.visible;
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
    this.card.visible = this.home.mode === 'control' && !!target?.tagged && !this.modal.visible && !this.helperPairingView;
    setText(this.heading, title(target?.label ?? menu?.title ?? m?.spec.title ?? 'Look at a device', 24));
    this.details.visible = this.detailsOpen && this.card.visible && this.selectedConnection() === 'ready' && !this.deviceState?.busy;
    this.refreshStatus();
    this.refreshHomeHint();
    const signature = `${this.locked}/${m?.spec.specId}/${m?.armed}/${m?.spec.controls.filter((c) => this.isArmed(m, c)).map((c) => c.id).join(',')}/${menu?.items.map((item) => item.id).join(',')}`;
    if (signature !== this.controlsSignature) { this.controlsStarted = this.time; this.controlsSignature = signature; }
    this.clear(this.controls);
    if (!this.card.visible) return;
    const lock = this.button(this.controls, 'device-lock', '', 0.171, THEME.card.titleY, 0.048, 'handle', () => {
      this.pinned = !this.pinned;
      this.card.userData.pinned = this.pinned;
      lock.group.userData.selected = this.pinned;
      this.refreshStatus();
    });
    lock.group.userData.selected = this.pinned;
    const lockIcon = new Mesh(this.lockGeometry, this.materials.accent);
    lockIcon.position.z = THEME.panel.depth; lock.group.add(lockIcon);
    const state = this.deviceState?.targetId === this.locked ? this.deviceState : null;
    const connection = this.selectedConnection();
    if (state?.busy) {
      this.button(this.controls, 'control-cancel', 'Cancel', 0, THEME.card.buttonsY, 0.16, 'handle', () => this.events.emit('cancel', { targetId: target!.id }));
      return;
    }
    if (connection !== 'ready') {
      if (connection === 'setup') this.button(this.controls, 'control-setup', 'Set up control', 0, THEME.card.buttonsY, 0.24, 'handle', () => this.events.emit('setup', { targetId: target!.id }));
      if (connection === 'offline' && (state?.action === 'open-companion' || state?.action === 'pair-device')) {
        if (state.pairingSeconds) this.button(this.controls, 'control-pair-cancel', 'Cancel', -0.09, THEME.card.buttonsY, 0.16, 'handle', () => this.events.emit('pairCancel', { targetId: target!.id }));
        else {
          const pairLabel = state.hint?.includes('/pair on this laptop') ? 'Pair' : state.action === 'open-companion' ? 'Connect Mac' : 'Connect device';
          const primary = this.button(this.controls, 'control-pair', pairLabel, 0, THEME.card.buttonsY, 0.24, 'handle', () => this.events.emit('pair', { targetId: target!.id }));
          this.selectButton(primary.group, true, 0.24);
        }
        if (state.pairingSeconds) this.button(this.controls, 'control-pair-code', 'Type code', 0.09, THEME.card.buttonsY, 0.16, 'handle', () => this.openPairCode());
        else this.button(this.controls, 'control-pair-code', 'Type code', 0, THEME.card.detailsY, 0.16, 'handle', () => this.openPairCode());
        if (state.pairingSeconds) this.label(this.controls, state.action === 'open-companion' ? 'or type the code shown on your Mac' : 'or type the code shown on the device', THEME.card.detailsY, THEME.font.detail).name = 'pair-code-hint';
      }
      return;
    }
    this.button(this.controls, 'details-toggle', this.detailsOpen ? 'Close details' : 'Details', 0, THEME.card.detailsY, THEME.control.buttonWidth * 1.5, 'handle', () => {
      this.detailsOpen = !this.detailsOpen;
      this.details.visible = this.detailsOpen;
      this.refreshDetails();
      this.refreshCard();
    });
    if (this.detailsOpen) return;
    if (m) this.refreshCommandUi(m);
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
    if (m?.command?.phase !== 'fail' && m && main && /synth|keyboard/i.test(m.spec.device?.category ?? '')) {
      this.button(this.controls, 'hand-control', state?.handControl ? 'Hand control on' : 'Hand control off', -0.075, THEME.card.detailsY, 0.19, 'handle', () => this.events.emit('handControl', { targetId: target!.id, enabled: !state?.handControl }));
      const details = this.controls.getObjectByName('details-toggle');
      if (details) { details.position.x = 0.13; details.scale.x = 0.6; }
    }
    if (m && buttons.length) buttons.forEach((c, index) => this.controlButton(m, c, index, buttons.length));
    else if (menu && m?.armed) {
      const shown = menu.items.filter((item) => item.kind !== 'control' && item.status !== 'locked').slice(0, 3);
      shown.forEach((item, index) => {
        const widget = this.button(this.controls, `action:${item.id}`, this.actionLabel(item.label), (index - (shown.length - 1) / 2) * (THEME.control.buttonWidth + THEME.control.buttonGap), THEME.card.buttonsY, THEME.control.buttonWidth, 'hack', () => {
          this.selectedAction = item.id;
          for (const action of shown) {
            const group = this.controls.getObjectByName(`action:${action.id}`) as Group;
            this.selectButton(group, action.id === item.id);
          }
          this.updatePower(m, { kind: 'trigger', label: item.label, binding: { action: item.id } }, true);
          this.emitHack(m, { targetId: this.locked ?? this.menuTarget!, itemId: item.id, controlId: item.controlId, index: menu.items.indexOf(item) });
        });
        widget.group.userData.action = true; widget.group.userData.controlId = item.id;
        this.selectButton(widget.group, this.selectedAction === item.id);
      });
    }
  }
  private selectButton(group: Group, selected: boolean, width = THEME.control.buttonWidth as number): void {
    group.userData.selected = selected;
    group.userData.feedbackStyle = undefined;
    const plate = group.getObjectByName('button-plate') as Mesh | undefined;
    if (plate) plate.material = this.surfaces.material(width, THEME.control.buttonHeight, selected && !group.userData.action ? 'selected' : 'button', true);
    for (const child of group.children) if ('sync' in child) setText(child as SdfText, (child as SdfText).text, selected ? THEME.color.accent : THEME.color.text);
  }
  private refreshButtons(m: Mounted): void {
    for (const c of m.spec.controls) {
      const group = this.controls.getObjectByName(`control:${c.id}`) as Group | undefined;
      if (group) this.selectButton(group, c.kind === 'toggle' ? Boolean(m.values.get(c.id)) : m.selectedButton === c.id);
    }
  }
  private controlButton(m: Mounted, c: Control, index: number, count: number): void {
    const widget = this.button(this.controls, `control:${c.id}`, this.actionLabel(c.label), (index - (count - 1) / 2) * (THEME.control.buttonWidth + THEME.control.buttonGap), THEME.card.buttonsY, THEME.control.buttonWidth, 'control', () => {
      m.values.set(c.id, c.kind === 'toggle' ? !m.values.get(c.id) : true);
      this.updatePower(m, c, m.values.get(c.id)!);
      m.selectedButton = c.id;
      this.refreshButtons(m);
      this.emitControl(m, c, 'start');
    }, () => { if (c.kind === 'trigger') m.values.set(c.id, false); this.emitControl(m, c, 'end'); });
    widget.group.userData.controlId = c.id;
    widget.group.userData.action = true;
    this.refreshButtons(m);
  }
  private actionLabel(label: string): string {
    return /full[ _-]?on/i.test(label) ? 'Full on' : /night/i.test(label) ? 'Night' : title(label, 12);
  }
  private updatePower(m: Mounted, c: Pick<Control, 'kind' | 'label' | 'binding'>, value: ControlEvent['value']): void {
    const power = controlPower(c, value);
    if (power !== undefined) m.power = power;
    else if (isBrightness(c)) m.power = true;
    if (this.mounted() !== m) return;
    for (const control of m.spec.controls) {
      const thumb = this.controls.getObjectByName(`main-control:${control.id}`)?.getObjectByName('value');
      if (thumb) this.positionThumb(m, control, thumb);
    }
  }
  private mainControl(m: Mounted, c: Control): void {
    const group = new Group();
    group.name = `main-control:${c.id}`;
    group.userData.controlId = c.id;
    group.position.y = THEME.card.mainY;
    const track = this.surfaces.create(THEME.control.width, THEME.control.height, 'button', true);
    track.name = 'button-plate';
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
      const previous = m.values.get(c.id);
      const range = c.range ?? { min: 0, max: 1 };
      let value = range.min + Math.min(1, Math.max(0, point.x / THEME.control.width + 0.5)) * (range.max - range.min);
      if (range.step) value = Math.min(range.max, Math.max(range.min, range.min + Math.round((value - range.min) / range.step) * range.step));
      if (c.kind === 'xy') {
        const yr = c.yRange ?? range;
        const y = yr.min + Math.min(1, Math.max(0, point.y / THEME.control.height + 0.5)) * (yr.max - yr.min);
        m.values.set(c.id, { x: value, y });
      } else m.values.set(c.id, value);
      if (isBrightness(c) && previous !== m.values.get(c.id)) m.power = true;
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
    const off = m.power === false && isBrightness(c);
    if (group?.userData.knob) {
      const angle = (0.75 - 1.5 * fraction) * Math.PI;
      const radius = THEME.control.knobDiameter / 2 - THEME.control.knobTick;
      thumb.position.set(Math.sin(angle) * radius, Math.cos(angle) * radius, THEME.panel.depth);
      thumb.rotation.z = -angle;
    }
    const fill = group?.getObjectByName('slider-fill') as Mesh | undefined;
    if (fill) {
      fill.visible = !off && fraction > 0;
      fill.scale.x = THEME.control.width * fraction;
      fill.position.x = (fraction - 1) * THEME.control.width / 2;
    }
    const valueText = group?.getObjectByName('control-value') as SdfText | undefined;
    const unit = c.unit ?? (/brightness|level/i.test(c.label) && range.max === 100 ? '%' : '');
    // Off hides the fill but keeps the thumb, so there is still something to drag back up
    thumb.visible = true;
    if (valueText) setText(valueText, off ? 'Off' : `${Number(x.toFixed(2))}${unit}`, off ? THEME.color.muted : THEME.color.accent);
  }
  private emitHack(m: Mounted, hack: NonNullable<CommandState['hack']>): void {
    const ts = Date.now();
    m.command = { controlId: hack.itemId, value: true, ts, phase: 'sending', at: this.time * 1000, hack };
    this.refreshCommandUi(m); this.events.emit('hack', { ...hack, ts });
  }
  private emitControl(m: Mounted, c: Control, phase: ControlEvent['phase']): void {
    if (!this.isArmed(m, c)) return;
    const value = m.values.get(c.id) ?? c.default ?? 0, ts = Date.now();
    m.command = { controlId: c.id, value, ts, phase: 'sending', at: phase === 'start' ? Infinity : this.time * 1000 };
    this.refreshCommandUi(m);
    this.events.emit('control', { specId: m.spec.specId, controlId: c.id, value, phase, ts });
  }
  private refreshCommandUi(m: Mounted): void {
    if (this.mounted() !== m) return;
    const failed = m.command?.phase === 'fail';
    const retry = this.controls.getObjectByName('command-retry');
    if (retry) retry.visible = failed;
    else if (failed && !this.detailsOpen) {
      this.button(this.controls, 'command-retry', 'Retry', 0, THEME.card.detailsY, 0.16, 'control', () => {
        const command = m.command;
        if (command?.hack) { this.emitHack(m, command.hack); return; }
        const control = m.spec.controls.find((c) => c.id === command?.controlId);
        if (!command || !control || !this.isArmed(m, control)) return;
        m.values.set(control.id, command.value); this.updatePower(m, control, command.value); this.emitControl(m, control, 'end');
      });
    }
    const details = this.controls.getObjectByName('details-toggle');
    if (details) details.visible = !failed;
    this.refreshStatus();
  }
  setCommandResult(specId: string, controlId: string, ts: number, ok: boolean): void {
    const m = this.specs.get(specId);
    if (!m || !acceptsCommandResult(m.command, controlId, ts)) return;
    m.command!.phase = ok ? 'ok' : 'fail';
    this.refreshCommandUi(m);
  }
  setScanning(on: boolean, _info?: { modelId?: string }): void { if (this.scanning === on) return; this.scanning = on; this.refreshCard(); }
  isTargetVisible(id: string): boolean { return this.boxes.isVisible(id); }
  getTargetAim(id: string, out: { position: Vector3; size: number }): boolean {
    const box = this.boxes.boxes.get(id);
    if (!box || !this.boxes.isVisible(id)) return false;
    // The device body stays aimable even when tagged (only its chip is drawn): people pinch the object itself.
    // The chip above it is its own pinchable widget ('selectTarget').
    out.position.copy(box.center); out.size = Math.max(box.w, box.h);
    return true;
  }
  upsertTarget(t: HudTarget): void {
    if (t.label.trim().toLowerCase() === 'person') { this.removeTarget(t.id); return; }
    const previous = this.targets.get(t.id);
    this.targets.set(t.id, t);
    this.point.fromArray(t.position);
    if (!this.boxes.set(t.id, this.point, t.sizeM?.[0] ?? THEME.box.defaultWidth, t.sizeM?.[1] ?? THEME.box.defaultHeight, t.tagged ? THEME.color.accent : THEME.color.line)) return;
    this.boxes.setTagged(t.id, !!t.tagged, t.connection === 'ready');
    this.boxes.setFacing(t.id, t.facing);
    if (!previous || previous.label !== t.label || previous.tagged !== t.tagged || previous.connection !== t.connection || previous.identifying !== t.identifying || previous.busy !== t.busy) this.refreshTargetLabel(t);
    if (this.locked === t.id) {
      if (previous?.label !== t.label || previous?.connection !== t.connection || previous?.tagged !== t.tagged) this.refreshCard();
      else if (previous?.status !== t.status) this.refreshStatus();
    }
  }
  private refreshTargetLabel(t: HudTarget): void {
    let label = this.labels.get(t.id);
    if (!label) { label = new Group(); label.name = `target-label:${t.id}`; this.labels.set(t.id, label); this.root.add(label); }
    this.clear(label);
    // Untag only after an explicit selection: on hover the (distance-scaled) chip can cover the device, so a pinch aimed
    // at the device would otherwise remove its tag by accident.
    const removable = this.home.mode === 'annotate' && t.tagged && this.locked === t.id;
    const state = this.deviceState?.targetId === t.id ? this.deviceState : null;
    const text = targetChipLabel({ ...t, ...(state ? { connection: state.connection, busy: state.busy } : {}) }, this.home.mode, !!removable);
    const width = Math.max(0.09, Math.ceil((text.length * THEME.font.label * 0.56 + THEME.box.labelPadding * 3) * 100) / 100);
    if (removable) this.button(label, `tag-remove:${t.id}`, text, width / 2, 0, width, 'handle', () => this.events.emit('tagRemove', { targetId: t.id }));
    else {
      const pill = this.surfaces.create(width, THEME.box.labelHeight, t.tagged ? 'selected' : 'plate', true);
      pill.position.x = width / 2;
      // The bundled Latin font has no check glyph; share the Verified badge's vector check.
      const checkWidth = t.tagged ? 0.016 : 0;
      const name = makeText({ text: text.replace(/^✓ /, ''), size: THEME.font.label, weight: 500, singleLine: true, maxWidth: width - THEME.box.labelPadding * 2 - checkWidth });
      name.position.set(THEME.box.labelPadding + checkWidth, 0, THEME.panel.depth);
      label.add(pill, name);
      if (t.tagged) {
        this.widgets.push({ group: label, w: width, h: THEME.box.labelHeight, kind: 'handle', button: true, lastMove: 0,
          start: () => this.events.emit('selectTarget', { targetId: t.id }) });
        const check = new Mesh(this.checkGeometry, this.materials.accent);
        check.name = 'tagged-check'; check.position.set(THEME.box.labelPadding + 0.005, 0, THEME.panel.depth);
        check.renderOrder = THEME.render.text; label.add(check);
      }
    }
    this.boxes.registerLabel(t.id, label, width);
  }
  removeTarget(id: string): void {
    this.targets.delete(id); this.boxes.remove(id);
    const label = this.labels.get(id); if (label) { label.removeFromParent(); this.clear(label); this.labels.delete(id); }
    if (this.locked === id) { this.locked = null; this.pinned = false; this.card.userData.pinned = false; this.refreshCard(); }
  }
  clearTargets(): void { for (const id of this.targets.keys()) this.removeTarget(id); }
  setCandidate(id: string | null): void {
    const old = this.candidate; this.candidate = id;
    if (old === id) return;
    if (old && this.targets.has(old)) this.refreshTargetLabel(this.targets.get(old)!);
    if (id && this.targets.has(id)) this.refreshTargetLabel(this.targets.get(id)!);
  }
  setLocked(id: string | null): void {
    if (id !== this.locked && this.codeEntry && this.codeTarget !== HELPER_PAIRING_TARGET) this.closePairCode();
    const old = this.locked; this.locked = id;
    if (old !== id) { this.pinned = false; this.card.userData.pinned = false; this.evidence = null; this.upload = null; this.selectedAction = null; this.unfoldStarted = this.time; }
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
    const m: Mounted = { spec, targetId: at.targetId ?? previous?.targetId, position: at.position ?? previous?.position, armed: previous?.armed ?? false, values: previous?.values ?? new Map(), selectedButton: previous?.selectedButton, power: previous?.power, command: previous?.command };
    for (const c of spec.controls) if (!m.values.has(c.id)) m.values.set(c.id, c.default ?? 0);
    this.specs.set(spec.specId, m); this.refreshCard(); this.place();
  }
  patchSpec(id: string, patch: Patch): { ok: boolean; errors?: string[] } {
    const m = this.specs.get(id); if (!m) return { ok: false, errors: [`No spec ${id}`] };
    const result = applyPatch(m.spec, patch);
    if (!result.ok) return { ok: false, errors: result.errors.map((e) => `${e.path}: ${e.message}`) };
    m.spec = result.spec; this.refreshCard(); return { ok: true };
  }
  removeSpec(id: string): void { this.specs.delete(id); this.refreshCard(); this.syncHome(); }
  setArmed(id: string, armed: boolean, _reason?: string, controlIds?: string[]): void {
    const m = this.specs.get(id); if (!m) return;
    if (controlIds && armed) m.armed = true;
    if (controlIds) m.spec = { ...m.spec, controls: m.spec.controls.map((c) => controlIds.includes(c.id) ? { ...c, armed } : c) };
    else { m.armed = armed; m.spec = { ...m.spec, state: { ...m.spec.state, armed } }; }
    this.refreshCard(); this.syncHome();
  }
  setControlValue(id: string, controlId: string, value: ControlEvent['value']): void {
    const m = this.specs.get(id); if (!m) return;
    const previous = m.values.get(controlId); m.values.set(controlId, value);
    const c = m.spec.controls.find((control) => control.id === controlId), thumb = this.controls.getObjectByName(`main-control:${controlId}`)?.getObjectByName('value');
    if (c && (!isBrightness(c) || previous !== value)) this.updatePower(m, c, value);
    if (this.mounted() === m) {
      if (c && thumb) this.positionThumb(m, c, thumb);
      this.refreshButtons(m); this.refreshStatus();
    }
  }
  showConfirm(confirm: ConfirmRequest | null): void {
    if (confirm && this.home.mode !== 'control') return;
    if (!confirm && this.codeTarget === HELPER_PAIRING_TARGET) { this.confirm = null; return; }
    this.confirm = confirm; this.clear(this.modal); this.modal.visible = !!confirm; if (!confirm) {
      if (this.approvals.length) this.showApprovals(this.approvals);
      else if (this.pairing) this.showPairing(this.pairing);
      return;
    }
    this.modal.add(this.plate(THEME.panel.width, 0.32));
    this.label(this.modal, title(confirm.title), 0.105, THEME.font.title);
    const summary = makeText({ text: (confirm.summary ?? (confirm.hold ? 'Hold to confirm.' : 'Confirm this action.')).slice(0, 200), size: THEME.font.label, anchorX: 'center', anchorY: 'top', maxWidth: THEME.panel.textWidth, maxHeight: 0.11 });
    summary.name = 'confirmation-summary'; summary.position.set(0, 0.05, THEME.panel.depth); this.modal.add(summary);
    const arm = confirm.kind === 'arm';
    let startedAt = 0;
    const primary = this.button(this.modal, 'confirm-yes', arm ? 'Enable controls' : confirm.hold ? 'Hold to allow' : 'Allow', 0.065, -0.1, arm ? 0.21 : THEME.control.buttonWidth * 1.5, 'confirm', () => { startedAt = this.time; }, () => {
      if ((!confirm.expiresAt || Date.now() < confirm.expiresAt) && (!confirm.hold || (this.time - startedAt) * 1000 >= (arm ? 2000 : THEME.control.holdMs))) this.events.emit('confirm', { id: confirm.id, approve: true, hold: !!confirm.hold });
    });
    if (arm) {
      primary.group.userData.primary = true;
      (primary.group.getObjectByName('button-plate') as Mesh).material = this.surfaces.material(primary.w, primary.h, 'primary', true);
      if (confirm.hold) this.label(this.modal, 'Hold for 2 seconds to enable', -0.045, THEME.font.detail);
    }
    this.button(this.modal, 'confirm-no', arm ? 'Not now' : 'Cancel', -0.11, -0.1, THEME.control.buttonWidth, 'confirm', () => this.events.emit('confirm', { id: confirm.id, approve: false }));
    this.place();
  }
  showPairing(pair: { display: string; qr: string; message?: string } | null): void {
    this.pairing = pair;
    if (this.codeEntry) return;
    if (this.confirm) return;
    if (this.approvals.length) { this.showApprovals(this.approvals); return; }
    this.clear(this.modal); this.modal.visible = !!pair; if (!pair) return;
    this.modal.add(this.plate(THEME.panel.width, THEME.panel.height));
    this.label(this.modal, 'Pair this headset', THEME.panel.row, THEME.font.title);
    this.label(this.modal, pair.display, 0, THEME.font.title);
    this.label(this.modal, pair.message ?? 'Enter this code on the Mac.', -THEME.panel.row, THEME.font.label); this.place();
  }
  showHelperPairing(view: HelperPairingView | null): void {
    this.helperPairingView = view;
    this.helperPairing.setState(view);
    if ((!view || view.pairedName) && this.codeTarget === HELPER_PAIRING_TARGET) this.closePairCode();
    this.refreshCard(); this.place();
  }
  showApprovals(list: { pairingId: string; name: string; kind: string; display: string }[]): void {
    this.approvals = list;
    if (this.codeEntry) return;
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
    const modeChanged = this.home.mode !== state.mode;
    this.home = { ...state };
    if (modeChanged) {
      const helperKeyboard = this.codeTarget === HELPER_PAIRING_TARGET;
      if (!helperKeyboard) { this.codeEntry = null; this.codeTarget = null; }
      this.detailsOpen = false; this.details.visible = false;
      this.confirm = null;
      if (!helperKeyboard) { this.clear(this.modal); this.modal.visible = false; }
      this.deviceState = null; this.pinned = false; this.card.userData.pinned = false;
      for (const target of this.targets.values()) this.refreshTargetLabel(target);
      this.refreshCard();
    }
    this.refreshHome();
    if (modeChanged) this.showDockHint();
    this.place();
  }
  setDeviceState(state: DeviceState | null): void {
    const previous = this.deviceState;
    if (previous === state) return;
    const sameContent = previous && state && previous.targetId === state.targetId && previous.connection === state.connection && previous.hint === state.hint && previous.action === state.action && previous.busy === state.busy && previous.sentence === state.sentence && previous.handControl === state.handControl;
    if (sameContent && previous.pairingSeconds === state.pairingSeconds) return;
    this.deviceState = state;
    if (sameContent && !!previous.pairingSeconds === !!state.pairingSeconds) { this.refreshStatus(); return; }
    if (this.codeEntry && this.codeTarget !== HELPER_PAIRING_TARGET && (!state || state.targetId !== previous?.targetId || state.connection !== 'offline' || !state.action)) this.closePairCode();
    const current = state ? this.targets.get(state.targetId) : undefined;
    if (current && state) this.boxes.setReady(current.id, state.connection === 'ready');
    if (current && state) this.targets.set(current.id, { ...current, connection: state.connection, busy: state.busy });
    for (const id of new Set([previous?.targetId, state?.targetId])) {
      const target = id ? this.targets.get(id) : undefined;
      if (target) this.refreshTargetLabel(target);
    }
    this.refreshCard();
    this.syncHome();
  }
  private openPairCode(targetId = this.locked): void {
    if (!targetId) return;
    if (targetId === this.locked && this.deviceState?.hint?.includes('/pair on this laptop')) {
      this.events.emit('pair', { targetId });
      targetId = HELPER_PAIRING_TARGET;
    }
    if (targetId !== HELPER_PAIRING_TARGET) this.events.emit('pairCancel', { targetId });
    this.codeTarget = targetId;
    this.codeEntry = new PairCodeEntry();
    this.drawPairCode();
  }
  private closePairCode(): void {
    this.codeEntry = null;
    this.codeTarget = null;
    this.clear(this.modal); this.modal.visible = false;
    this.refreshCard(); this.place();
  }
  private drawPairCode(): void {
    const entry = this.codeEntry;
    if (!entry) return;
    this.clear(this.modal); this.modal.visible = true; this.card.visible = false;
    this.modal.add(this.plate(0.48, 0.48));
    this.label(this.modal, this.codeTarget === HELPER_PAIRING_TARGET ? 'Code shown on your laptop' : this.deviceState?.action === 'open-companion' ? 'Code shown on your Mac' : 'Code shown on the device', 0.205, THEME.font.label);
    this.label(this.modal, entry.display, 0.16, THEME.font.title).name = 'pair-code-value';
    const update = (key: string) => { entry.key(key); this.drawPairCode(); };
    PAIR_CODE_KEYS.forEach((key, i) => this.button(this.modal, `pair-key:${key}`, key, (i % 8 - 3.5) * 0.057, 0.10 - Math.floor(i / 8) * 0.056, 0.05, 'handle', () => update(key)));
    this.button(this.modal, 'pair-code-back', 'Back', 0.09, -0.13, 0.16, 'handle', () => update('Back'));
    this.button(this.modal, 'pair-code-close', 'Cancel', -0.09, -0.13, 0.16, 'handle', () => this.closePairCode());
    if (entry.valid) {
      const submit = this.button(this.modal, 'pair-code-submit', 'Connect', 0, -0.195, 0.16, 'handle', () => {
        const targetId = this.codeTarget;
        this.closePairCode();
        if (targetId) this.events.emit('pairCode', { targetId, code: entry.value });
      });
      this.selectButton(submit.group, true, 0.16);
    }
    this.place();
  }
  private canStop(): boolean {
    return this.home.mode === 'control' && (this.home.canStop ?? (!!this.deviceState?.busy || [...this.specs.values()].some((m) => m.armed && m.spec.controls.some((c) => c.armed !== false))));
  }
  private syncHome(): void { this.refreshHome(); }
  private refreshHomeHint(): void {
    setText(this.dockHint, homeHint(this.home.mode, this.home.tagged, !!this.selected()?.tagged));
    this.dockHint.visible = !this.deck.fingerMenu && !!this.dockHint.text && this.time < this.hintUntil;
  }
  private showDockHint(): void {
    this.hintUntil = this.time + 2.5;
    this.refreshHomeHint();
  }
  private releaseDockCapture(capture: Capture): void {
    const widget = capture.widget;
    capture.widget = null; capture.mode = null; capture.pokeBlocked = false; capture.hasTip = false;
    widget?.end?.();
  }
  private refreshHome(): void {
    this.deck.setState(this.home, this.canStop(), this.handDock.source === 'hand');
    this.deck.userData.width = this.deck.width;
    this.deck.userData.height = this.deck.height;
    // Keep captures across count/filter updates, releasing only icons that actually disappeared.
    for (let i = this.widgets.length - 1; i >= 0; i--) {
      const widget = this.widgets[i]!;
      if (!widget.group.userData.dockIcon || this.deck.buttons.includes(widget.group)) continue;
      for (const capture of this.captures.values()) if (capture.widget === widget) {
        this.releaseDockCapture(capture);
      }
      if (this.fingerCapture === widget) { this.fingerCapture = null; widget.end?.(); }
      this.widgets.splice(i, 1);
    }
    for (const group of this.deck.buttons) {
      if (this.widgets.some((widget) => widget.group === group)) continue;
      const start = () => {
        if (group.name === 'mode-annotate' || group.name === 'mode-control') {
          this.events.emit('mode', { mode: group.name === 'mode-annotate' ? 'annotate' : 'control' });
        } else if (group.name.startsWith('filter:')) {
          this.events.emit('filter', { filter: group.name.slice(7) as HomeState['filter'] });
        } else if (group.name === 'exit-ar') this.deck.beginExitHold(this.time * 1000);
        else this.events.emit('deck', { key: 'panic', phase: 'press' });
      };
      this.widgets.push({ group, w: this.deck.height, h: this.deck.height, kind: 'deck', start,
        end: group.name === 'exit-ar' ? () => this.deck.cancelExitHold() : group.name === 'deck:panic' ? () => this.events.emit('deck', { key: 'panic', phase: 'release' }) : undefined,
        button: true, lastMove: 0 });
    }
    this.refreshHomeHint();
    this.deck.updateFeedback(this.handDock.opacity);
  }
  // Kept for the shared HUD interface; v2 visibility comes entirely from the current hand frame.
  setDeck(_d: { open?: boolean; scanning?: boolean; daemons?: boolean; at?: [number, number, number] }): void {}
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
    this.card.visible = this.home.mode === 'control' && !!target?.tagged && !this.modal.visible && !this.helperPairingView;
    this.helperPairing.visible = !!this.helperPairingView && !this.modal.visible;
    this.helperPairing.update({ head: this.headPose, time: this.time * 1000 });
    const unfold = target ? unfoldEase((this.time - this.unfoldStarted) / THEME.motion.duration) : 1;
    this.card.scale.x = Math.max(0.001, unfold);
    const controls = unfoldEase((this.time - this.controlsStarted) / THEME.motion.duration);
    this.controls.scale.y = Math.max(0.001, controls);
    const box = target && this.boxes.boxes.get(target.id);
    const key = target?.id ?? (m?.position ? `position:${m.spec.specId}` : 'idle');
    if (key !== this.placementKey) {
      this.placementKey = key;
      this.idlePlacement.reset(); this.dockPlacement.reset();
      if (box) {
        this.comfort.place(this.head, box.center, box.w, this.card.position, this.card.quaternion);
        this.dockPlacement.anchor(this.card, this.headPose, this.time * 1000);
        this.cardScale = angularScale(this.card.position.distanceTo(this.head), THEME.control.buttonHeight);
      } else if (m?.position) {
        this.card.position.fromArray(m.position); this.face(this.card);
        this.idlePlacement.anchor(this.card, this.headPose, this.time * 1000);
      }
    }
    if (box) {
      if (!this.pinned) this.follow(this.card, this.dockPlacement);
      const scale = this.cardScale;
      this.card.scale.set(Math.max(0.001, unfold) * scale, scale, scale);
      if (this.edgePlacement.update(this.head, this.headQuaternion, box.center)) {
        this.edge.visible = this.card.visible || !!this.deviceState?.busy;
        this.edge.position.copy(this.edgePlacement.position); this.edge.quaternion.copy(this.headQuaternion);
        this.edgeArrow.rotation.z = this.edgePlacement.angle;
        this.tether.hide();
      } else { this.edge.visible = false; this.placeTether(box.id); }
    } else {
      this.edge.visible = false; this.tether.hide();
      if (!this.pinned) this.follow(this.card, this.idlePlacement);
    }
    if (this.modal.visible) this.follow(this.modal, this.modalPlacement);
    else this.modalPlacement.reset();
    if (!this.handDock.tracked) {
      this.follow(this.deck, this.deckPlacement);
      if (this.card.visible) // The card is angularly scaled (>= 4° buttons), so separate against its real size.
        this.panelSeparation.update(this.card, this.deck, this.headPose, THEME.card.width * this.card.scale.y, THEME.card.height * this.card.scale.y, this.deck.width, this.deck.height);
    }
    if (this.coach.visible) this.follow(this.coach, this.coachPlacement);
    if (this.notice.visible) this.follow(this.notice, this.noticePlacement);
  }
  private inside(widget: Widget, point: Vector3): boolean {
    if (widget.group.userData.dockIcon) return Math.hypot(point.x, point.y) <= (widget.group.userData.finger ? 0.02 / widget.group.scale.x : widget.w / 2 + 0.002);
    return Math.abs(point.x) <= Math.max(THEME.control.minHitSize, widget.group.userData.collapsed ? THEME.box.labelHeight : widget.w) / 2 + THEME.control.hitPadding
      && Math.abs(point.y) <= Math.max(THEME.control.minHitSize, widget.h) / 2 + THEME.control.hitPadding;
  }
  private hit(widget: Widget, cursor: Cursor, clampToFace = false): number {
    this.inverse.copy(widget.group.matrixWorld).invert();
    this.local.copy(cursor.tip).applyMatrix4(this.inverse);
    let distance = Math.abs(this.local.z), rayHit = false;
    if (!cursor.canPoke || distance > (widget.group.userData.dockIcon ? 0.03 : THEME.control.near) || !this.inside(widget, this.local)) {
      if (!cursor.ray) return Infinity;
      rayHit = true;
      this.origin.copy(cursor.ray.origin).applyMatrix4(this.inverse);
      // Preserve world ray distance while the card unfolds with a nonuniform scale.
      this.direction.copy(cursor.ray.origin).add(cursor.ray.dir).applyMatrix4(this.inverse).sub(this.origin);
      if (Math.abs(this.direction.z) < 1e-6) return Infinity;
      distance = -this.origin.z / this.direction.z;
      if (distance < 0 || distance > THEME.control.rayDistance) return Infinity;
      this.local.copy(this.origin).addScaledVector(this.direction, distance);
    }
    if (!clampToFace) {
      if (rayHit) {
        if (widget.group.userData.dockIcon) {
          if (Math.hypot(this.local.x, this.local.y) > widget.w * 0.65) return Infinity;
        } else if (!expandedRayBounds(this.local.x, this.local.y, widget.group.userData.collapsed ? 0.07 : widget.w, widget.h)) return Infinity;
      } else if (!this.inside(widget, this.local)) return Infinity;
    }
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
  private interactive(widget: Widget, cursor: Cursor): boolean {
    if (!visible(widget.group) || this.suppressedHands.has(cursor.hand)) return false;
    if (this.helperPairing.visible && !this.helperPairing.getObjectById(widget.group.id) && !this.deck.getObjectById(widget.group.id)) return false;
    if (widget.group.userData.dockIcon && (!this.handDock.open || this.handDock.tracked && cursor.hand === (this.handDock.source === 'controller' ? 'left' : this.handDock.nonDominant))) return false;
    return !this.modal.visible || !!this.modal.getObjectById(widget.group.id) || !!this.deck.getObjectById(widget.group.id);
  }
  private interact(cursor: Cursor): void {
    const capture = this.captures.get(cursor.id); if (!capture) return;
    if (!cursor.tracked || this.suppressedHands.has(cursor.hand)) {
      const active = capture.widget; capture.widget = null; capture.mode = null; capture.hasTip = false; capture.wasPinching = false;
      capture.history.reset();
      if (active?.kind === 'control' || active?.kind === 'deck') active.end?.();
      return;
    }
    if (capture.widget?.group.userData.dockIcon && !this.interactive(capture.widget, cursor)) {
      this.releaseDockCapture(capture); capture.history.reset();
    }
    if (cursor.canPoke && capture.pokeBlocked) {
      this.local.copy(cursor.tip).applyMatrix4(capture.pokePlane);
      if (this.local.z > THEME.control.pokeRelease) capture.pokeBlocked = false;
    }
    let hover: Widget | null = null, poke: Widget | null = null, distance = Infinity;
    for (const widget of this.widgets) {
      if (!this.interactive(widget, cursor)) continue;
      const candidate = this.hit(widget, cursor);
      if (candidate !== Infinity && candidate <= distance) { distance = candidate; hover = widget; }
      if (!poke && this.crosses(widget, cursor, capture)) poke = widget;
    }
    if (hover) hover.group.userData.hovered = true;
    if (!capture.mode) {
      const pinch = cursor.justPinched && !capture.wasPinching;
      const ray = cursor.rawRay ?? cursor.ray;
      const compensated = pinch && ray ? capture.history.compensate(this.time * 1000, hover, ray.origin, ray.dir) : hover;
      const winner = pinch ? compensated && this.widgets.includes(compensated) && this.interactive(compensated, cursor) ? compensated : hover : !cursor.pinching ? poke : null;
      if (winner) {
        if (pinch) this.hit(winner, cursor, true);
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
    const historyRay = cursor.rawRay ?? cursor.ray;
    if (historyRay) capture.history.record(this.time * 1000, hover, historyRay.origin, historyRay.dir);
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
  private updateFingerMenu(frame: HudFrame): void {
    const side = this.handDock.nonDominant;
    const open = this.handDock.source === 'hand' && this.handDock.open;
    // Consume the menu hand before the shell selects devices, including an index pinch held on close.
    if (open) this.suppressedHands.add(side);
    for (const hand of ['left', 'right'] as const) {
      if (this.suppressedHands.has(hand) && !(open && hand === side) && !frame.hands[hand]?.pinching) this.suppressedHands.delete(hand);
      if (this.suppressedHands.has(hand)) this.events.emit('consumed', { hand, widget: 'deck' });
    }
    const touch = this.fingerTouch.update(frame.hands[side], open, frame.time);
    if (this.fingerCapture && (!touch.touching || this.fingerCapture.group.userData.finger !== touch.finger)) {
      const active = this.fingerCapture; this.fingerCapture = null; active.end?.();
    }
    for (const button of this.deck.buttons) button.userData.near = !!button.userData.finger && touch.near[button.userData.finger as keyof typeof touch.near];
    if (!touch.justTouched) return;
    const widget = this.widgets.find((widget) => widget.group.userData.finger === touch.finger);
    if (!widget) return;
    this.fingerCapture = widget;
    this.pressUntil.set(`finger:${touch.finger}`, this.time + 0.12);
    widget.start(this.local.set(0, 0, 0));
  }

  private buttonFeedback(): void {
    for (const [name, until] of this.pressUntil) if (until < this.time) this.pressUntil.delete(name);
    for (const widget of this.widgets) {
      if (!widget.button && widget.kind !== 'control') continue;
      const { group } = widget;
      const finger = group.userData.finger;
      let pressed = this.pressUntil.has(group.name) || !!finger && this.pressUntil.has(`finger:${finger}`) || this.fingerCapture === widget;
      for (const capture of this.captures.values()) if (capture.widget === widget) pressed = true;
      const hovered = Boolean(group.userData.hovered), selected = Boolean(group.userData.selected);
      group.userData.pressed = pressed;
      if (widget.button && !group.name.startsWith('target-label:')) {
        const scale = finger ? (group.userData.near ? 1.15 : 1) : (pressed ? 0.92 : 1);
        group.scale.setScalar(scale);
      }
      if (group.userData.dockIcon) continue;
      const plate = group.getObjectByName('button-plate') as Mesh | undefined;
      if (!plate) continue;
      const command = this.mounted()?.command;
      const pending = command && command.controlId === group.userData.controlId ? command.phase : undefined;
      const style = pending === 'fail' ? 'failed' : pressed ? 'pressed' : pending === 'sending' ? 'sending' : group.userData.primary ? 'primary' : hovered ? selected && !group.userData.action ? 'selected-hover' : 'hover' : selected && !group.userData.action ? 'selected' : 'button';
      if (group.userData.feedbackStyle !== style) {
        group.userData.feedbackStyle = style; plate.material = this.surfaces.material(widget.w, widget.h, style, true);
      }
    }
  }
  update(frame: HudFrame): void {
    this.time = frame.time / 1000;
    for (const m of this.specs.values()) if (commandTimedOut(m.command, frame.time)) {
      m.command!.phase = 'fail'; this.refreshCommandUi(m);
    }
    this.surfaces.tick(this.time);
    this.hasFrame = true;
    this.head.copy(frame.head.position); this.headQuaternion.copy(frame.head.quaternion);
    const wasTracked = this.handDock.tracked, previousSource = this.handDock.source;
    this.handDock.update(frame, this.deck, this.deck.wrist, this.deck.width);
    if (previousSource !== this.handDock.source) this.refreshHome();
    if (wasTracked && !this.handDock.tracked) this.deckPlacement.reset();
    this.deck.visible = this.handDock.opacity > 0;
    this.deck.userData.anchor = this.handDock.source === 'controller' ? 'left-controller' : this.handDock.source === 'mouse' ? 'fallback' : this.handDock.source === 'hand' ? this.handDock.nonDominant : 'none';
    this.deck.userData.open = this.handDock.open;
    if (this.handDock.justOpened) { this.showDockHint(); this.coach.visible = false; this.coachUntil = 0; }
    if (!this.handDock.open) for (const capture of this.captures.values()) {
      if (capture.widget?.group.userData.dockIcon) {
        this.releaseDockCapture(capture);
      }
    }
    if (frame.frame && !this.coached && !this.handDock.open) {
      this.coached = true; this.coach.visible = true; this.coachUntil = this.time + 4;
      this.coachPlacement.reset();
    }
    if (this.time >= this.coachUntil) this.coach.visible = false;
    for (const target of this.targets.values()) {
      if (this.home.mode === 'control' && !target.tagged) this.boxes.setOpacity(target.id, 0);
      else if (this.home.mode === 'annotate' && this.boxes.boxes.get(target.id)?.opacity === 0) this.boxes.setOpacity(target.id, 1);
    }
    this.boxes.setActive(this.locked ?? this.candidate);
    this.boxes.setSelected(this.locked);
    this.boxes.update(frame.dt, this.head, frame, this.home.mode);
    for (const [id, label] of this.labels) {
      const box = this.boxes.boxes.get(id); if (!box) continue;
      this.boxes.labelAnchor(box, this.head, label.position);
      this.boxes.labelQuaternion(this.head, label.position, label.quaternion);
    }
    this.place();
    this.updateFingerMenu(frame);
    this.deck.updateFingers(frame, this.handDock.nonDominant, this.handDock.open);
    this.root.updateMatrixWorld(true);
    handCursor('left', frame.hands.left, this.cursors[0]!); handCursor('right', frame.hands.right, this.cursors[1]!);
    this.cursors[0]!.canPoke &&= !frame.hands.left?.controller;
    this.cursors[1]!.canPoke &&= !frame.hands.right?.controller;
    for (const cursor of this.cursors) if (this.suppressedHands.has(cursor.hand)) cursor.tracked = false;
    for (let i = 0; i < this.cursors.length; i++) {
      const cursor = this.cursors[i]!; let distance = Infinity; this.reticleHits[i] = null;
      if (!cursor.tracked) continue;
      for (const widget of this.widgets) {
        if (!this.interactive(widget, cursor)) continue;
        const hit = this.hit(widget, cursor);
        if (hit < distance) {
          distance = hit;
          this.reticleHits[i] = this.reticlePoints[i]!.copy(this.local).applyMatrix4(widget.group.matrixWorld);
          if (widget.button && cursor.ray) {
            widget.group.getWorldPosition(this.point);
            if (rayTargetWithinAngle(cursor.ray.origin, cursor.ray.dir, this.point) !== Infinity) this.reticleHits[i]!.copy(this.point);
          }
        }
      }
    }
    this.reticles.update(this.cursors, this.head, frame.dt, this.boxes, this.reticleHits);
    for (const widget of this.widgets) widget.group.userData.hovered = false;
    for (const cursor of this.cursors) this.interact(cursor);
    for (const cursor of this.devCursors) this.interact(cursor);
    if (this.deck.updateExitHold(frame.time)) this.events.emit('exit', {});
    this.buttonFeedback();
    this.deck.updateFeedback(this.handDock.opacity);
    this.deck.setWrist(this.home.mode, this.handDock.wristOpacity);
    this.dockHint.visible = !this.deck.fingerMenu && !!this.dockHint.text && this.time < this.hintUntil;
    (this.dockHint as SdfText & { fillOpacity: number }).fillOpacity = this.handDock.opacity;
    if (this.notice.visible && this.time > this.noticeUntil) this.notice.visible = false;
  }
  dispose(): void {
    this.root.traverse((o) => { if ('sync' in o && 'dispose' in o) (o as SdfText).dispose(); });
    this.deck.dispose();
    this.helperPairing.dispose();
    this.boxes.dispose();
    this.checkGeometry.dispose(); this.arrowGeometry.dispose(); this.lockGeometry.dispose();
    this.surfaces.dispose();
    this.reticles.dispose();
    this.tether.dispose();
    for (const material of Object.values(this.materials)) material.dispose();
    this.trackGeometry.dispose(); this.root.removeFromParent();
  }
}
