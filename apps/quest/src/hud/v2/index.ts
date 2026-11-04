import { BufferGeometry, Camera, Group, LineBasicMaterial, LineSegments, Matrix4, Mesh, MeshBasicMaterial, Object3D, PlaneGeometry, Quaternion, Scene, Shape, ShapeGeometry, Vector3, type WebGLRenderer } from 'three';
import { applyPatch, type Control, type ControlEvent, type Gen3dSpec, type HackItem, type ModelChip, type Patch } from '@ce/gen3d';
import type { SetupProgressView } from '@ce/protocol';
import { Emitter } from '../../gen3d/events';
import { handCursor, newCursor, type Cursor } from '../../gen3d/interact';
import type { AgentStepLike, AssistantView, CanvasView, ConfirmRequest, DeviceState, HomeState, EvidenceState, HelperPairingView, OnboardingView, Hud, HudEvents, HudFrame, HudTarget, PingLine, UploadState, ProjectView, ProjectUiCommand } from '../contract';
import { controlPower, isBrightness } from './control-state';
import { cardControlShape, controlFraction, controlValue, DIAL_DIAMETER, LEVER_TRAVEL } from './control-shape';
import { PairCodeEntry, PAIR_CODE_KEYS } from './pair-code';
import { HelperPairingCard, HELPER_PAIRING_TARGET } from './helper-pairing';
import { AssistantPanel, configureAssistantRenderer } from './assistant-panel';
import { SetupProgress } from './setup-progress';
import { CanvasPanel } from './canvas-panel';
import { ProjectPanel } from './project-panel';
import { targetChipLabel } from './target-chip';
import { BoxField } from './boxes';
import { makeText, setText, type SdfText } from './text';
import { LOOK, THEME } from './theme';
import { GlassSurfaces, isOnStyle } from './surface';
import { PinchReticles } from './reticle';
import { unfoldEase } from './motion';
import { TargetTether } from './tether';
import { WorldPanel } from './world-panel';
import { WorkspaceAnchor } from './workspace-anchor';
import { MainMenu } from './main-menu';
import { WristPalette, type PaletteItem } from './wrist-palette';
import type { SpatialInput } from '../../app/spatial-input';
import { labEnabled } from '../../app/lab';
import { PinchTargetHistory, expandedRayBounds, rayTargetWithinAngle } from '../../app/precision';
import { EdgePlacement } from './comfort';
import { acceptsCommandResult, commandTimedOut, commandSubtitle, routeLabel, type CommandState } from './command-state';
import { DeviceCard, type CardAction, type CardAgent, type CardView } from './device-card';
import { DialRig, type DialMode, type DialModel } from './radial-dial';
import { setupChecks, setupFraction } from './setup-ring';
import { liveGesture } from '../../gestures/feedback';
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
  drag?: boolean;
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
  configureAssistantRenderer(ctx.renderer);
  return new LeanHud(ctx.scene, ctx.camera, ctx.nonDominant, labEnabled());
}

/** One pointer (xr-input ray/touch/grab or the forwarded mouse) holding a widget. */
interface PointerHold { widget: Widget; hand: string; plane: Matrix4; lastMove: number }
type HudPointerEvent = { pointerId: number; pointerType?: string; button?: number; point: Vector3; target?: { setPointerCapture?(id: number): void }; nativeEvent?: { altKey?: boolean }; stopPropagation?(): void };

/** One selected device, a short sentence, and only the controls that are ready to use. */
export class LeanHud implements Hud {
  readonly root = new Group();
  readonly boxes = new BoxField();
  private readonly annotationLayer = new Group();
  private readonly events = new Emitter<HudEvents>();
  private readonly targets = new Map<string, HudTarget>();
  private readonly labels = new Map<string, Group>();
  private readonly specs = new Map<string, Mounted>();
  private readonly menus = new Map<string, { title: string; items: HackItem[] }>();
  private readonly logs = new Map<string, AgentStepLike>();
  private readonly history: EvidenceState[] = [];
  private readonly widgets: Widget[] = [];
  private readonly captures = new Map<string, Capture>();
  /** HUD time (s) of the last control interaction; the wrist menu does not open for 1 s after it. */
  private lastControlAt = -Infinity;
  private readonly pressUntil = new Map<string, number>();
  private readonly cursors = [newCursor('left', 'left'), newCursor('right', 'right')];
  private devCursors: Cursor[] = [];
  private readonly materials = {
    button: new MeshBasicMaterial({ color: THEME.color.muted, transparent: true, opacity: THEME.surface.buttonOpacity, depthWrite: false, toneMapped: false }),
    accent: new MeshBasicMaterial({ color: THEME.color.accent, transparent: true, depthWrite: false, toneMapped: false }),
    /** Glyph-like marks on a white "on" pill (the tagged check) and on glass (the edge arrow): Horizon label colours. */
    onLight: new MeshBasicMaterial({ color: LOOK.text.onLight, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }),
    white: new MeshBasicMaterial({ color: LOOK.text.primary, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }),
  };
  private readonly surfaces = new GlassSurfaces();
  private readonly helperPairing = new HelperPairingCard(this.surfaces);
  private helperPairingView: HelperPairingView | null = null;
  private readonly assistant = new AssistantPanel(this.surfaces);
  private assistantView: AssistantView | null = null;
  private readonly assistantTalk: Widget;
  private readonly canvasPanel = new CanvasPanel(this.surfaces);
  private canvasView: CanvasView | null = null;
  private readonly projectPanel = new ProjectPanel(this.surfaces);
  private projectView: ProjectView | null = null;
  private readonly workspaceAnchor = new WorkspaceAnchor();
  private readonly canvasLaunch: Widget;
  private readonly inspectLaunch: Widget;
  private readonly visualSelection = new Group();
  /** A small Horizon card (24 × 16 cm): a title, a short status (≤ 3 lines) and Retry. */
  private readonly visualSelectionTitle = makeText({ text: 'Visual synth', size: 0.02, weight: 600, maxWidth: 0.2, singleLine: true });
  private readonly visualSelectionBody = makeText({ text: '', size: THEME.font.detail, color: THEME.color.muted, maxWidth: 0.2, maxHeight: 0.05, anchorY: 'top' });
  private readonly visualSelectionRetry: Widget;
  private readonly setupProgress = new SetupProgress(this.surfaces);
  private setupProgressView: SetupProgressView | null = null;
  private setupProgressTarget: string | null = null;
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
  private readonly cardPlate: Mesh;
  private pinned = false;
  private readonly edgePlacement = new EdgePlacement();
  private readonly edge = new Group();
  private readonly edgeText = makeText({ text: '', size: THEME.font.detail, maxWidth: 0.25, singleLine: true });
  private readonly arrowGeometry: ShapeGeometry;
  private readonly edgeArrow: Mesh;
  private readonly lockGeometry: ShapeGeometry;
  private readonly controls = new Group();
  private readonly details = new Group();
  private readonly modal = new Group();
  private readonly modalLayer = new Group();
  private readonly deck = new MainMenu(this.surfaces);
  private home: HomeState = { mode: 'annotate', filter: 'everything', tagged: 0, status: 'Pinch a device to tag it' };
  private deviceState: DeviceState | null = null;
  private readonly coach = new Group();
  private onboarding: OnboardingView | null = null;
  private readonly coachTitle = makeText({ text: '', size: THEME.font.title, weight: 600, anchorX: 'center', maxWidth: 0.38 });
  private readonly coachBody = makeText({ text: '', size: THEME.font.body, anchorX: 'center', maxWidth: 0.38, maxHeight: 0.07 });
  private readonly coachStep = makeText({ text: '', size: THEME.font.detail, color: THEME.color.muted, anchorX: 'center', maxWidth: 0.38 });
  private readonly coachPlacement = new WorldPanel({ distance: 0.75, height: 0.15 });
  private readonly notice = new Group();
  private readonly screenGuide = new Group();
  private readonly screenGuideGeometry = new BufferGeometry();
  private readonly screenGuideMaterial = new LineBasicMaterial({ color: THEME.color.accent, transparent: true, opacity: 0.8, depthTest: false, toneMapped: false });
  private readonly screenGuideText = makeText({ text: '', size: THEME.font.body, anchorX: 'center', maxWidth: 0.49, maxHeight: 0.065 });
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
  private readonly headPose = { position: this.head, quaternion: this.headQuaternion };
  private readonly noticePlacement = new WorldPanel({ height: THEME.panel.toastY });
  private hasFrame = false;
  private inputSurface = '';
  /** xr-input (hands + controllers) and the forwarded mouse: the single UI input owner when attached. */
  private spatial: SpatialInput | null = null;
  readonly palette: WristPalette;
  private readonly holds = new Map<number, PointerHold>();
  /** HUD time (s) the right hand last played (hands-first control); dials and the menu wait a moment after it. */
  private lastLiveAt = -Infinity;
  private frameHands: HudFrame['hands'] = {};
  private readonly nearLocal = new Vector3();
  private readonly nearWorld = new Vector3();
  private readonly fading = new Map<string, number>();
  private readonly taps = new Map<number, Widget>();
  private readonly hitGeometry = new PlaneGeometry(1, 1);
  private readonly hitMaterial = new MeshBasicMaterial({ visible: false });
  private readonly objectActions: { key: string; label: string; visible?: (targetId: string) => boolean; onSelect: (targetId: string) => void }[] = [];
  constructor(scene: Scene, private readonly camera: Camera, _nonDominant: 'left' | 'right' = 'left', private readonly lab = false) {
    this.root.name = 'hud-v2';
    this.palette = new WristPalette(this.surfaces, _nonDominant);
    // First child of the HUD root, so name lookups ('visual-synth', 'deck:panic', 'exit-ar') find the palette before
    // the hidden lab menu's same-named buttons (e2e scripts and the judge path use these names).
    this.root.add(this.palette);
    // Not `primary`: a white pill reads as "selected/pressed" next to the Annotate | Control segments.
    this.palette.register({ key: 'visual-synth', label: 'Visual synth', order: 0, onSelect: () => this.events.emit('visualSynth', {}) });
    this.palette.register({ key: 'deck:panic', label: 'Stop', order: 80, onSelect: () => {
      this.events.emit('deck', { key: 'panic', phase: 'press' }); this.events.emit('deck', { key: 'panic', phase: 'release' });
    } });
    this.palette.register({ key: 'exit-ar', label: 'Exit', order: 90, hold: true, onSelect: () => this.events.emit('exit', {}) });
    if (lab) this.palette.register({ key: 'lab-menu', label: 'More (lab)', order: 95, onSelect: () => this.setMenuOpen(!this.deck.panel.visible) });
    // The two layers from the spec, always first: Annotate (look, box, track) and Control (talk to the device).
    this.palette.register({ key: 'layer', label: 'Layer', order: -20, onSelect: () => {},
      segments: [{ key: 'annotate', label: 'Annotate', width: 0.094 }, { key: 'control', label: 'Control', width: 0.094 }],
      selected: () => this.home.mode, onSegment: (key) => this.events.emit('mode', { mode: key === 'control' ? 'control' : 'annotate' }) });
    // What to track (spec: "switch tracking to electronics"): one compact segmented row, Annotate only.
    this.palette.register({ key: 'track', label: 'Track', order: -10, onSelect: () => {}, visible: () => this.home.mode === 'annotate',
      segments: [{ key: 'electronics', label: 'Electronics', width: 0.086 }, { key: 'objects', label: 'Objects', width: 0.064 }, { key: 'everything', label: 'All', width: 0.04 }],
      selected: () => this.home.filter, onSegment: (key) => this.events.emit('filter', { filter: key as HomeState['filter'] }) });
    this.card.name = 'device-card';
    this.edge.name = 'device-edge-pill';
    const arrow = new Shape();
    arrow.moveTo(-0.009, -0.002); arrow.lineTo(0.002, -0.002); arrow.lineTo(0.002, -0.007);
    arrow.lineTo(0.011, 0); arrow.lineTo(0.002, 0.007); arrow.lineTo(0.002, 0.002); arrow.lineTo(-0.009, 0.002);
    this.arrowGeometry = new ShapeGeometry(arrow);
    this.edgeArrow = new Mesh(this.arrowGeometry, this.materials.white);
    this.edgeArrow.name = 'edge-direction'; this.edgeArrow.position.set(-0.132, 0, THEME.panel.depth);
    this.edgeText.name = 'workspace-recovery-label'; this.edgeText.position.set(-0.11, 0, THEME.panel.depth);
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
    this.coach.name = 'onboarding-guide';
    this.notice.name = 'notice';
    this.screenGuide.name = 'visual-synth-screen-guide'; this.screenGuide.visible = false;
    const guidePoints: Vector3[] = [];
    for (const x of [-1, 1]) for (const y of [-1, 1]) {
      guidePoints.push(new Vector3(x * 0.25, y * 0.15, 0), new Vector3(x * 0.20, y * 0.15, 0),
        new Vector3(x * 0.25, y * 0.15, 0), new Vector3(x * 0.25, y * 0.10, 0));
    }
    this.screenGuideGeometry.setFromPoints(guidePoints);
    const guideCorners = new LineSegments(this.screenGuideGeometry, this.screenGuideMaterial); guideCorners.renderOrder = THEME.render.text;
    this.screenGuideText.name = 'visual-synth-screen-instruction'; this.screenGuideText.position.y = -0.20;
    this.screenGuide.add(guideCorners, this.screenGuideText); this.root.add(this.screenGuide);
    this.modalLayer.add(this.modal);
    this.annotationLayer.name = 'device-annotations';
    this.annotationLayer.add(this.boxes);
    this.root.add(this.annotationLayer, this.card, this.modalLayer, this.deck, this.deck.panel, this.coach, this.notice, this.reticles, this.tether);
    this.root.add(this.helperPairing);
    this.root.add(this.assistant);
    this.root.add(this.projectPanel);
    this.widgets.push({ group: this.projectPanel.hitArea, w: this.projectPanel.width, h: this.projectPanel.height, kind: 'handle', start: () => {}, lastMove: 0 });
    for (const group of this.projectPanel.buttons) this.widgets.push({ group, w: group.userData.width, h: group.userData.height, kind: 'handle', button: true, lastMove: 0,
      start: () => this.events.emit('projectsCommand', { command: group.userData.command as ProjectUiCommand,
        ...(typeof group.userData.actionId === 'string' ? { actionId: group.userData.actionId } : {}) }) });
    this.visualSelection.name = 'visual-synth-selection'; this.visualSelection.visible = false;
    this.visualSelectionTitle.name = 'visual-synth-selection-title'; this.visualSelectionTitle.position.set(-0.1, 0.055, THEME.panel.depth);
    this.visualSelectionBody.name = 'visual-synth-selection-message'; this.visualSelectionBody.position.set(-0.1, 0.037, THEME.panel.depth);
    this.visualSelection.add(this.plate(0.24, 0.16), this.visualSelectionTitle, this.visualSelectionBody);
    this.root.add(this.visualSelection);
    this.widgets.push({ group: this.visualSelection, w: 0.24, h: 0.16, kind: 'handle', start: () => {}, lastMove: 0 });
    this.visualSelectionRetry = this.button(this.visualSelection, 'visual-synth-retry', 'Retry', 0, -0.045, 0.12, 'handle', () => this.events.emit('visualSynth', {}));
    this.widgets.push({ group: this.assistant, w: this.assistant.width, h: this.assistant.height, kind: 'handle', start: () => {}, lastMove: 0 });
    for (const group of [this.assistant.apply, this.assistant.dismiss]) this.widgets.push({
      group, w: this.assistant.buttonWidth, h: this.assistant.buttonHeight, kind: 'handle', button: true, lastMove: 0,
      start: () => {
        const view = this.assistantView;
        if (!view || (view.targetId !== 'muse-general' && view.targetId !== this.locked)) return;
        if (view.state === 'proposal' && view.proposalId) this.events.emit('assistantConfirm', { targetId: view.targetId, proposalId: view.proposalId, accept: group === this.assistant.apply });
        else if (group === this.assistant.dismiss) this.events.emit('assistantDismiss', { targetId: view.targetId });
      },
    });
    this.widgets.push({ group: this.assistant.send, w: this.assistant.buttonWidth, h: this.assistant.buttonHeight, kind: 'handle', button: true, lastMove: 0,
      start: () => { if (this.assistantView?.state === 'listening') this.events.emit('assistantTalk', { targetId: this.assistantView.targetId }); } });
    this.widgets.push({ group: this.assistant.read, w: 0.30, h: this.assistant.buttonHeight, kind: 'handle', button: true, lastMove: 0, start: () => this.assistant.openFullText() });
    this.widgets.push({ group: this.assistant.sources, w: 0.12, h: this.assistant.buttonHeight, kind: 'handle', button: true, lastMove: 0,
      start: () => this.assistant.nextInformationPage() });
    this.widgets.push({ group: this.assistant.infoBack, w: 0.12, h: this.assistant.buttonHeight, kind: 'handle', button: true, lastMove: 0,
      start: () => this.assistant.previousInformationPage() });
    this.widgets.push({ group: this.assistant.infoClose, w: 0.12, h: this.assistant.buttonHeight, kind: 'handle', button: true, lastMove: 0,
      start: () => { if (!this.assistant.closeReadingPage() && this.assistantView) this.events.emit('assistantDismiss', { targetId: this.assistantView.targetId }); } });
    this.widgets.push({ group: this.helperPairing, w: this.helperPairing.width, h: this.helperPairing.height, kind: 'handle', start: () => {}, lastMove: 0 });
    for (const group of [this.helperPairing.typeCode, this.helperPairing.skip]) this.widgets.push({
      group, w: this.helperPairing.buttonWidth, h: THEME.control.buttonHeight, kind: 'handle', button: true, lastMove: 0,
      start: () => group === this.helperPairing.typeCode ? this.openPairCode(HELPER_PAIRING_TARGET) : this.events.emit('helperSkip', {}),
    });
    this.coach.add(this.plate(0.43, 0.19), this.coachTitle, this.coachBody, this.coachStep);
    this.coachTitle.name = 'onboarding-title'; this.coachTitle.position.set(0, 0.048, THEME.panel.depth);
    this.coachBody.name = 'onboarding-message'; this.coachBody.position.set(0, -0.005, THEME.panel.depth);
    this.coachStep.name = 'onboarding-step'; this.coachStep.position.set(0, -0.068, THEME.panel.depth);
    this.coach.visible = false;
    this.widgets.push({ group: this.deck.panel, w: this.deck.panelWidth, h: this.deck.panelHeight, kind: 'deck', start: () => {}, lastMove: 0 });
    this.cardPlate = this.plate(THEME.card.width, THEME.card.height);
    this.card.add(this.cardPlate, this.setupProgress, this.canvasPanel, this.heading, this.status, this.controls, this.details, this.verdict, this.progress);
    this.widgets.push({ group: this.canvasPanel.hitArea, w: this.canvasPanel.width, h: this.canvasPanel.height, kind: 'handle', start: () => {}, lastMove: 0 });
    for (const group of this.canvasPanel.buttons) this.widgets.push({ group, w: group.userData.width, h: group.userData.height, kind: 'handle', button: true, lastMove: 0,
      start: () => {
        if (!this.hasCanvas() || !this.locked) return;
        const state = this.canvasView!.state, document = state.document;
        if (group === this.canvasPanel.close) { this.events.emit('canvasClose', { targetId: this.locked }); return; }
        if (group.userData.canvasAction === 'retry') { this.events.emit('canvasCreate', { targetId: this.locked }); return; }
        if (state.status !== 'ready' || !document) return;
        if (group === this.canvasPanel.previous) this.events.emit('canvasRestore', { targetId: this.locked, revision: group.userData.revision, baseRevision: document.revision });
        else this.events.emit('canvasAction', { targetId: this.locked, revision: document.revision, action: group.userData.canvasAction,
          ...(group.userData.roundId ? { roundId: group.userData.roundId } : {}), ...(group.userData.choiceId ? { choiceId: group.userData.choiceId } : {}) });
      } });
    this.widgets.push({ group: this.setupProgress.hitArea, w: this.setupProgress.width, h: this.setupProgress.height, kind: 'handle', start: () => {}, lastMove: 0 });
    this.widgets.push({ group: this.setupProgress.action, w: this.setupProgress.actionWidth, h: THEME.control.buttonHeight, kind: 'handle', button: true, lastMove: 0,
      start: () => {
        if (!this.hasSetupProgress() || !this.locked) return;
        this.events.emit(this.setupWorking() ? 'cancel' : 'setup', { targetId: this.locked });
      } });
    this.assistantTalk = this.button(this.card, 'assistant-talk', 'Ask Muse', 0, 0.202, 0.17, 'handle', () => {
      if (this.home.mode === 'control' && this.selected()?.tagged && this.locked) this.events.emit('assistantTalk', { targetId: this.locked });
    });
    this.inspectLaunch = this.button(this.card, 'object-inspect', 'About this object', -0.105, -0.202, 0.20, 'handle', () => {
      if (this.card.visible && this.selected()?.tagged && this.locked) this.events.emit('inspectObject', { targetId: this.locked });
    });
    this.canvasLaunch = this.button(this.card, 'canvas-create', 'Make a game', 0.105, -0.202, 0.19, 'handle', () => {
      if (this.card.visible && this.selected()?.tagged && !this.deviceState?.busy && !this.hasCanvas() && this.locked) this.events.emit('canvasCreate', { targetId: this.locked });
    });
    this.heading.position.set(-THEME.card.width / 2 + THEME.card.padding, THEME.card.titleY, THEME.panel.depth);
    this.status.position.set(this.heading.position.x, THEME.card.statusY, THEME.panel.depth);
    this.details.position.z = THEME.panel.depth;
    this.details.add(this.detailText);
    this.detailText.position.set(-THEME.panel.textWidth / 2, 0.06, THEME.panel.depth);
    this.details.visible = false;
    this.notice.add(this.noticeText);
    this.notice.visible = this.modal.visible = false;
    this.deck.visible = false;
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
    this.dragHandle(this.card, 'device-drag', 0.26, 0.125);
    this.dragHandle(this.assistant, 'assistant-drag', 0.38, 0.23);
    this.dragHandle(this.deck.panel, 'menu-title-drag', 0.27, 0.324, -0.05, 0.05);
    this.dragHandle(this.deck.panel, 'menu-drag', 0.39, 0.26, 0, 0.05, 0.052);
    this.dragHandle(this.projectPanel, 'project-drag', 0.37, 0.28);
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
        for (const [id, hold] of this.holds) if (hold.widget === widget) {
          this.holds.delete(id);
          if (widget.kind === 'control' || widget.kind === 'deck') widget.end?.();
        }
        for (const [id, tap] of this.taps) if (tap === widget) this.taps.delete(id);
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
  private isArmed(m: Mounted, control: Control): boolean { return this.home.mode === 'control' && !!this.selected()?.tagged && this.selectedConnection() === 'ready' && !this.deviceState?.busy && m.armed && control.armed === true; }
  private selectedConnection(): DeviceState['connection'] { return this.deviceState?.targetId === this.locked ? this.deviceState.connection : this.selected()?.connection ?? 'unknown'; }
  private setupWorking(): boolean { return !!this.setupProgressView && (this.setupProgressView.working || !!this.deviceState?.busy); }
  private hasCanvas(): boolean { return !!this.canvasView && this.canvasView.targetId === this.locked && this.home.mode === 'control'; }
  private hasSetupProgress(): boolean {
    return !this.hasCanvas() && !!this.setupProgressView && this.setupProgressTarget === this.locked && this.home.mode === 'control'
      && !(this.selectedConnection() === 'offline' && (this.deviceState?.action === 'open-companion' || this.deviceState?.action === 'pair-device'))
      && !this.deviceState?.handControl && (this.setupWorking() || this.selectedConnection() !== 'ready');
  }
  private refreshStatus(): void {
    const target = this.selected(), m = this.mounted();
    const failed = this.evidence?.verdict === 'fail' || this.upload?.verdict === 'fail' || target?.status === 'failed' || target?.status === 'no-reaction';
    const pending = this.evidence?.verdict === 'pending' || this.upload?.verdict === 'pending';
    const verified = !failed && !pending && !!m?.spec.controls.length && m.spec.controls.every((control) => control.armed === true)
      && m.spec.controls.some((control) => this.isArmed(m, control));
    const state = this.deviceState?.targetId === this.locked ? this.deviceState : null;
    const connection = this.selectedConnection();
    const text = state?.pairingSeconds ? `Look at the companion's QR code · ${state.pairingSeconds}s` : state?.busy ? state.sentence ?? 'Setting up control…' : connection === 'offline' ? state?.hint ?? 'Connect a companion to control this device.' : connection === 'unknown' ? 'Waiting for connection status…' : connection === 'setup' ? state?.hint ?? 'Set up control for this device.' : m?.armed ? 'Ready to control' : 'Confirm to enable controls';
    let subtitle = text;
    let mappingStatus = false;
    if (state?.busy) subtitle = commandSubtitle(undefined, '', '', state.sentence ?? text);
    else if (m?.armed && connection === 'ready') {
      let current = m.power === undefined ? 'Ready' : m.power ? 'On' : 'Off';
      if (m.power !== false) for (const c of m.spec.controls) {
        const value = m.values.get(c.id);
        if (isBrightness(c) && typeof value === 'number') { current += ` · ${Math.round(value)} %`; break; }
      }
      subtitle = commandSubtitle(m.command?.phase, routeLabel(m.spec.device?.transport, target?.channel), current);
      if (!m.command && m.spec.controls.some((control) => control.armed !== true)) {
        subtitle = m.spec.controls.some((control) => this.isArmed(m, control)) ? 'Only verified controls shown' : 'No verified controls available';
      }
      // A validated Perform map can use the available controls while other actions remain unverified.
      if (state?.handControl && state.performAvailable && m.command?.phase !== 'fail') {
        subtitle = `${state.performingLive ? 'Live · ' : ''}${state.performanceRoute ?? routeLabel(m.spec.device?.transport, target?.channel)}`;
      }
      if (state?.silentVisual && !m.command) subtitle = state.handControl
        ? state.performingLive ? 'Live gestures · silent visuals' : 'Hands ready · raise your right hand'
        : state.performAvailable ? 'Hands paused · tap Use hands' : 'Silent visuals · set up gestures first';
      if (state?.mappingSummary && state.performAvailable && !state.handControl && m.command?.phase !== 'sending' && m.command?.phase !== 'fail') {
        mappingStatus = true;
        const outcome = state.mappingOutcome;
        const result = outcome === 'working' ? 'New mapping pending'
          : outcome === 'review' ? 'Review new mapping before Apply'
            : outcome === 'failed' ? 'Latest result unconfirmed'
              : outcome === 'cancelled' ? 'Request cancelled; saved map shown'
                : outcome === 'unchanged' ? 'Latest request not applied'
                  : outcome === 'applied' ? 'Mapping applied; tap Use hands' : state.silentVisual ? 'Hands paused · silent visuals' : 'Hands paused · tap Use hands';
        subtitle = `${state.mappingSummary}\n${result}`;
      }
    }
    const routeLine = connection === 'ready' || !!state?.busy;
    // Preserve the two deliberate mapping lines. Fit their measured block between
    // the title and the first control's label/value, rather than wrapping over it.
    const singleLine = routeLine;
    this.status.whiteSpace = singleLine ? 'nowrap' : 'normal';
    this.status.maxWidth = singleLine ? Infinity : THEME.control.width;
    this.status.userData.lineWidth = singleLine ? THEME.control.width : undefined;
    this.status.position.y = mappingStatus ? THEME.card.titleY - THEME.font.title * THEME.font.lineHeight / 2 - 0.012 : THEME.card.statusY;
    this.status.userData.fitHeight = mappingStatus
      ? this.status.position.y - (THEME.card.mainY + THEME.control.labelOffset + THEME.font.title * THEME.font.lineHeight / 2) - 0.008
      : routeLine ? 0.055 : 0.105;
    setText(this.status, subtitle.slice(0, 200));
    this.status.visible = !this.details.visible && !this.hasSetupProgress() && !this.hasCanvas();
    this.verdict.visible = verified && !this.hasSetupProgress() && !this.hasCanvas();
    this.progress.visible = false;
    const steps = this.upload?.steps?.length ?? 0;
    const amount = failed ? 0 : verified ? 1 : steps ? Math.min(1, this.upload!.stepsDone / steps) : pending ? 0.5 : 0.12;
    this.progress.userData.value = amount;
    this.progressFill.visible = amount > 0;
    this.progressFill.scale.set(THEME.control.width * amount, THEME.card.progressHeight, 1);
    this.progressFill.position.x = (amount - 1) * THEME.control.width / 2;
  }
  private primaryContinuous(m: Mounted): Control | undefined {
    const controls = m.spec.controls.filter(c => this.isArmed(m, c) && c.kind !== 'trigger' && c.kind !== 'toggle');
    const state = this.deviceState?.targetId === m.targetId ? this.deviceState : null;
    // Only the applied, validated map supplies this ID; request/proposal wording is not a binding.
    return (state?.performAvailable && state.mappingActionId
      ? controls.find(c => c.binding?.action === state.mappingActionId) : undefined) ?? controls[0];
  }
  private otherContinuous(m: Mounted): Control | undefined {
    const main = this.primaryContinuous(m);
    return m.spec.controls.find(c => c !== main && this.isArmed(m, c) && c.kind !== 'trigger' && c.kind !== 'toggle');
  }
  private refreshCard(): void {
    const target = this.selected(), m = this.mounted();
    const menu = this.menus.get(this.locked ?? this.menuTarget ?? '');
    this.card.visible = this.home.mode === 'control' && !!target?.tagged && !this.modal.visible && !this.helperPairingView && !this.deck.panel.visible;
    const deviceTitle = target?.label ?? menu?.title ?? m?.spec.title ?? 'Look at a device';
    setText(this.heading, /^ControlAnything Visual Synth$/i.test(deviceTitle) ? 'Visual synth' : title(deviceTitle, 24));
    this.details.visible = this.detailsOpen && this.card.visible && this.selectedConnection() === 'ready' && !this.deviceState?.busy;
    this.refreshStatus();
    this.refreshHome();
    const signature = `${this.locked}/${m?.spec.specId}/${m?.armed}/${m?.spec.controls.filter((c) => this.isArmed(m, c)).map((c) => c.id).join(',')}/${menu?.items.map((item) => item.id).join(',')}/${this.deviceState?.mappingActionId}`;
    if (signature !== this.controlsSignature) { this.controlsStarted = this.time; this.controlsSignature = signature; }
    this.clear(this.controls);
    // The Horizon card (device-card.ts) replaces the legacy card contents; no Details, JSON or paragraphs.
    this.detailsOpen = false;
    this.refreshLook();
  }
  // --- WP3 look: Horizon device card + spatial arc dials on the selected screen ---------------------------
  private look?: { card: DeviceCard; rig: DialRig; spatial: SpatialInput | null; unregister: (() => void)[] };
  private readonly lookFacing = new Quaternion();
  private lookClock = 0;
  private ensureLook(): { card: DeviceCard; rig: DialRig; spatial: SpatialInput | null; unregister: (() => void)[] } {
    if (!this.look) {
      const card = new DeviceCard({
        toggle: () => {
          const state = this.deviceState?.targetId === this.locked ? this.deviceState : null;
          if (this.locked && state?.performAvailable) this.events.emit('handControl', { targetId: this.locked, enabled: !state.handControl });
        },
        action: (id) => this.lookAction(id),
      });
      // Centred on the legacy card origin, so the workspace anchor, drag bar and tether keep working.
      card.position.set(0, 0, THEME.panel.depth * 4);
      this.card.add(card);
      const rig = new DialRig();
      for (const dial of rig.dials) dial.onChange = (id, fraction, phase) => this.lookDial(id, fraction, phase);
      this.root.add(rig);
      // Retire the legacy card chrome into a hidden holder: names stay addressable, nothing renders or takes input.
      const legacy = new Group(); legacy.name = 'legacy-card-chrome'; legacy.visible = false;
      this.card.add(legacy);
      legacy.add(this.cardPlate, this.heading, this.status, this.verdict, this.progress, this.setupProgress, this.details, this.controls);
      legacy.add(this.screenGuide);
      // The legacy 0.40 × 0.32 card-background widget would overhang this card and swallow the right dial; the
      // uikit card consumes its own background.
      const surface = this.widgets.findIndex((widget) => widget.group === this.card);
      if (surface >= 0) { (this.card.userData.hit as Object3D | undefined)?.removeFromParent(); this.widgets.splice(surface, 1); }
      this.look = { card, rig, spatial: null, unregister: [] };
    }
    const look = this.look;
    if (look.spatial !== this.spatial) {
      for (const off of look.unregister.splice(0)) off();
      look.spatial = this.spatial;
      if (this.spatial) {
        const spatial = this.spatial;
        const cardRoot = look.card.uiRoot, labels = look.rig.uiRoot;
        if (cardRoot) look.unregister.push(spatial.addUiRoot(cardRoot, () => visible(look.card)));
        if (labels) look.unregister.push(spatial.addUiRoot(labels, () => visible(look.rig)));
        // Forwarded mouse hover over our surfaces keeps the legacy mouse cursor from also acting.
        for (const target of [look.card, look.rig.left.hit, look.rig.right.hit]) {
          const over = (e: unknown) => this.spatial?.markHover(e as { pointerId: number; pointerType?: string }, true);
          const out = (e: unknown) => this.spatial?.markHover(e as { pointerId: number; pointerType?: string }, false);
          target.addEventListener('pointerover' as never, over as never); target.addEventListener('pointerout' as never, out as never);
          look.unregister.push(() => { target.removeEventListener('pointerover' as never, over as never); target.removeEventListener('pointerout' as never, out as never); });
        }
      }
    }
    return look;
  }
  private lookAction(id: string): void {
    const target = this.selected(), m = this.mounted();
    if (!target) return;
    if (id === 'control-setup') this.events.emit('setup', { targetId: target.id });
    else if (id === 'control-cancel') this.events.emit('cancel', { targetId: target.id });
    else if (id === 'control-pair') this.events.emit('pair', { targetId: target.id });
    else if (id === 'control-pair-cancel') this.events.emit('pairCancel', { targetId: target.id });
    else if (id === 'control-pair-code') this.openPairCode();
    else if (id === 'gesture-setup') this.events.emit('gestureSetup', { targetId: target.id });
    else if (id.startsWith('control:') && m) {
      const c = m.spec.controls.find((control) => control.id === id.slice(8));
      if (!c || !this.isArmed(m, c)) return;
      m.values.set(c.id, c.kind === 'toggle' ? !m.values.get(c.id) : true);
      this.updatePower(m, c, m.values.get(c.id)!);
      m.selectedButton = c.id;
      this.emitControl(m, c, 'start');
      if (c.kind === 'trigger') m.values.set(c.id, false);
      this.emitControl(m, c, 'end');
    } else if (id.startsWith('action:') && m) {
      const menu = this.menus.get(this.locked ?? this.menuTarget ?? '');
      const item = menu?.items.find((entry) => entry.id === id.slice(7));
      if (!menu || !item) return;
      this.selectedAction = item.id;
      this.updatePower(m, { kind: 'trigger', label: item.label, binding: { action: item.id } }, true);
      this.emitHack(m, { targetId: this.locked ?? this.menuTarget!, itemId: item.id, controlId: item.controlId, index: menu.items.indexOf(item) });
    }
    this.refreshLook();
  }
  private lookDial(id: string, fraction: number, phase: 'start' | 'move' | 'end'): void {
    const m = this.mounted(), c = m?.spec.controls.find((control) => control.id === id);
    if (!m || !c || !this.isArmed(m, c)) return;
    const value = controlValue(fraction, c.range ?? { min: 0, max: 1 });
    m.values.set(c.id, value);
    if (isBrightness(c)) m.power = true;
    this.emitControl(m, c, phase);
    this.refreshDials();
  }
  private dialModel(m: Mounted, c: Control | undefined): DialModel | null {
    if (!c) return null;
    const range = c.range ?? { min: 0, max: 1 }, raw = m.values.get(c.id) ?? c.default ?? range.min;
    const value = typeof raw === 'object' ? raw.x : Number(raw);
    const fraction = Math.min(1, Math.max(0, (value - range.min) / (range.max - range.min || 1)));
    const label = /ripple/i.test(c.label) ? 'Ripples' : title(c.label, 12);
    return { id: c.id, label, fraction, display: String(Math.round(value)) };
  }
  private refreshDials(): void {
    const look = this.look, m = this.mounted();
    if (!look) return;
    if (!m) { look.rig.setDials(null, null); return; }
    look.rig.setDials(this.dialModel(m, this.primaryContinuous(m)), this.dialModel(m, this.otherContinuous(m)));
  }
  private lookTitle(): string {
    const target = this.selected(), m = this.mounted(), menu = this.menus.get(this.locked ?? this.menuTarget ?? '');
    const name = target?.label ?? menu?.title ?? m?.spec.title ?? 'Device';
    return /visual.?synth/i.test(name) ? 'Visual synth' : title(name, 24);
  }
  private lookAgent(working: boolean): CardAgent | null {
    const view = this.assistantView;
    const model = this.upload?.modelId ?? this.setupProgressView?.source?.match(/^Live · (.+)$/)?.[1];
    if (view && (view.targetId === this.locked || view.targetId === 'muse-general')) {
      if (view.state === 'listening') return { state: 'listening', text: view.transcript ?? '' };
      if (view.state === 'thinking' || view.state === 'setup') return { state: 'thinking', text: view.transcript ?? '', model };
      if (view.state === 'error') return { state: 'error', text: view.text ?? '' };
      if (view.state !== 'idle') return { state: 'reply', text: view.text ?? '', model };
    }
    if (working && this.setupProgressView) return { state: 'reply', text: this.setupProgressView.title, model };
    return null;
  }
  private lookView(): CardView {
    const target = this.selected(), m = this.mounted();
    const state = this.deviceState?.targetId === this.locked ? this.deviceState : null;
    const connection = this.selectedConnection();
    const name = this.lookTitle();
    const visual = /visual/i.test(name) || !!state?.silentVisual;
    const route = visual ? 'via Mac' : routeLabel(m?.spec.device?.transport, target?.channel).replace(/ \(.*\)$/, '');
    const working = this.setupWorking() || !!state?.busy;
    const actions: CardAction[] = [];
    let subtitle: string, toggle: CardView['toggle'] = null;
    if (state?.pairingSeconds) {
      subtitle = `Look at the Mac's code · ${state.pairingSeconds}s`;
      actions.push({ id: 'control-pair-cancel', label: 'Cancel', icon: 'cancel' }, { id: 'control-pair-code', label: 'Type code', icon: 'keyboard' });
    } else if (working) {
      const checks = setupChecks(this.setupProgressView);
      subtitle = checks.passed ? `Setting up… ${checks.passed} of ${checks.total} checked` : 'Setting up…';
      actions.push({ id: 'control-cancel', label: 'Cancel', icon: 'cancel' });
    } else if (connection === 'offline' && (state?.action === 'open-companion' || state?.action === 'pair-device')) {
      subtitle = 'Not connected';
      const pairLabel = state.hint?.includes('/pair on this laptop') ? 'Pair' : state.action === 'open-companion' ? 'Connect Mac' : 'Connect';
      actions.push({ id: 'control-pair', label: pairLabel, icon: 'link', primary: true }, { id: 'control-pair-code', label: 'Type code', icon: 'keyboard' });
    } else if (connection === 'offline') subtitle = 'Offline · open the Mac app';
    else if (connection === 'unknown') subtitle = 'Connecting…';
    else if (connection === 'setup') {
      const failed = !!this.setupProgressView?.stages.some((stage) => stage.status === 'failed');
      subtitle = failed ? 'Setup stopped' : 'Ready to set up';
      actions.push({ id: 'control-setup', label: failed ? 'Try again' : 'Set up', icon: failed ? 'retry' : 'setup', primary: true });
    } else {
      if (m?.armed && state?.performAvailable) toggle = { on: !!state.handControl, label: state.handControl ? 'Pause hands' : 'Use hands', name: 'hand-control', icon: 'hand' };
      subtitle = state?.handControl ? state.performingLive ? `Playing · ${route}` : 'Hands ready · raise your right hand'
        : m?.armed && state?.performAvailable && m?.command?.phase !== 'sending' && m?.command?.phase !== 'fail' ? `Hands paused · ${route}`
        : m?.command?.phase === 'sending' ? 'Sending…'
          : m?.command?.phase === 'fail' ? 'Not delivered · try again'
            : m?.armed ? `${m.power === false ? 'Off' : 'On'} · ${route}` : 'Confirm to enable controls';
      if (m?.armed && state && !state.performAvailable && m.spec.controls.some((control) => this.isArmed(m, control))) actions.push({ id: 'gesture-setup', label: 'Set up gestures', icon: 'hand' });
      const presets = m ? m.spec.controls.filter((c) => this.isArmed(m, c) && (c.kind === 'trigger' || c.kind === 'toggle')) : [];
      const iconFor = (label: string): CardAction['icon'] => /flow|wave/i.test(label) ? 'waves' : /ring|circle/i.test(label) ? 'rings' : /prism|triangle/i.test(label) ? 'prism' : undefined;
      if (m && presets.length) for (const c of presets.slice(0, 3 - actions.length)) {
        actions.push({ id: `control:${c.id}`, label: this.actionLabel(c.label), icon: iconFor(c.label),
          selected: c.kind === 'toggle' ? Boolean(m.values.get(c.id)) : m.selectedButton === c.id });
      } else if (m?.armed) {
        const menu = this.menus.get(this.locked ?? this.menuTarget ?? '');
        for (const item of (menu?.items ?? []).filter((entry) => entry.kind !== 'control' && entry.status === 'verified').slice(0, 3 - actions.length)) {
          actions.push({ id: `action:${item.id}`, label: this.actionLabel(item.label), icon: iconFor(item.label), selected: this.selectedAction === item.id });
        }
      }
    }
    return { title: name, subtitle, toggle, actions: actions.slice(0, 3), agent: this.lookAgent(working) };
  }
  private refreshLook(): void {
    if (!this.look) return;
    this.look.card.set(this.lookView());
    this.refreshDials();
  }
  /** Per frame, after place(): the Horizon card replaces the legacy card chrome; the dials ride the selected box. */
  private updateLook(frame: HudFrame): void {
    const look = this.ensureLook(), dt = Math.min(0.1, Math.max(0, frame.dt));
    this.lookClock += dt;
    if (this.lookClock >= 0.1) { this.lookClock = 0; look.card.set(this.lookView()); }
    const target = this.selected(), m = this.mounted();
    const state = this.deviceState?.targetId === this.locked ? this.deviceState : null;
    const box = target ? this.boxes.boxes.get(target.id) : undefined;
    const workspace = this.home.mode === 'control' && !!target?.tagged && !this.modal.visible && !this.deck.panel.visible && !this.helperPairingView && !this.projectView;
    const connection = this.selectedConnection();
    const ready = connection === 'ready' && !!m?.armed && !this.setupWorking() && !state?.busy;
    const mode: DialMode = !workspace || !box ? 'hidden' : ready ? state?.handControl ? 'perform' : 'armed' : 'setup';
    look.rig.setMode(mode);
    // Hands-first: the arcs read out the hand's values and stay an optional fine control. They take input whenever
    // the right hand is not playing (a short grace after, so a pinch-tap for the next pattern never grabs an arc).
    if (mode === 'perform') {
      const take = !state?.performingLive && this.time - this.lastLiveAt > 0.4;
      for (const dial of look.rig.dials) if (dial.interactive !== (take && !!dial.model)) dial.setInteractive(take);
    }
    if (box && mode !== 'hidden') {
      this.boxes.facingQuaternion(this.head, box.center, this.lookFacing, box.facing);
      look.rig.place(box.center, box.w, box.h, this.lookFacing, dt);
    }
    if (mode === 'setup') {
      const checks = setupChecks(this.setupProgressView);
      look.rig.ring.setProgress(ready ? 1 : setupFraction(this.setupProgressView), checks.passed, checks.total, this.setupWorking() || !!state?.busy);
    }
    if (mode === 'perform' && liveGesture.active && m) for (const dial of look.rig.dials) {
      const c = dial.model ? m.spec.controls.find((control) => control.id === dial.model!.id) : undefined;
      const live = c?.binding?.action ? liveGesture.values.get(c.binding.action) : undefined;
      if (live !== undefined) dial.target = live;
    }
    const registered = !!look.spatial;
    look.rig.update(dt, mode !== 'hidden', !registered);
    look.card.update(dt * 1000, this.card.visible && visible(this.card), !registered);
  }
  private selectButton(group: Group, selected: boolean, width = THEME.control.buttonWidth as number): void {
    group.userData.selected = selected;
    group.userData.feedbackStyle = undefined;
    const plate = group.getObjectByName('button-plate') as Mesh | undefined;
    if (plate) plate.material = this.surfaces.material(width, THEME.control.buttonHeight, selected && !group.userData.action ? 'selected' : 'button', true);
    for (const child of group.children) if ('sync' in child) setText(child as SdfText, (child as SdfText).text, THEME.color.text);
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
  private mainControl(m: Mounted, c: Control, y: number = THEME.card.mainY): void {
    const shape = cardControlShape(m.spec, c);
    const shaped = shape !== 'slider';
    const group = new Group();
    group.name = `main-control:${c.id}`;
    group.userData.controlId = c.id;
    group.userData.archetype = shape;
    group.userData.knob = shape === 'knob';
    group.position.y = y;
    const track = this.surfaces.create(shape === 'knob' ? DIAL_DIAMETER : shape === 'lever' ? 0.030 : THEME.control.width,
      shaped ? DIAL_DIAMETER : THEME.control.height, 'button', shape !== 'lever');
    track.name = 'button-plate';
    const fill = this.surfaces.create(THEME.control.width, THEME.control.height, 'selected', true);
    fill.name = 'slider-fill'; fill.position.z = THEME.panel.depth;
    const valueText = makeText({ text: '', size: THEME.font.title, color: THEME.color.accent, weight: 600, tabular: true, anchorX: 'right', singleLine: true, maxWidth: THEME.control.width / 3 });
    valueText.name = 'control-value';
    valueText.position.set(THEME.control.width / 2, shaped ? 0 : THEME.control.labelOffset, THEME.panel.depth);
    group.add(valueText);
    const thumb = new Mesh(this.trackGeometry, this.materials.accent);
    thumb.name = 'value';
    thumb.scale.set(shape === 'knob' ? 0.003 : shape === 'lever' ? 0.034 : THEME.surface.stroke * 2,
      shape === 'knob' ? 0.010 : shape === 'lever' ? 0.009 : THEME.control.height - THEME.card.radius, 1);
    thumb.position.z = THEME.panel.depth * 2;
    const label = makeText({ text: title(c.label), size: THEME.font.label, weight: 500, singleLine: true, maxWidth: THEME.control.width * (shaped ? .36 : 2 / 3) });
    label.name = 'control-label';
    label.position.set(-THEME.control.width / 2, shaped ? 0 : THEME.control.labelOffset, THEME.panel.depth);
    group.add(label);
    thumb.renderOrder = THEME.render.plates + 1;
    group.add(track, thumb);
    if (!shaped) group.add(fill);
    this.controls.add(group);
    const update = (point: Vector3) => {
      const previous = m.values.get(c.id);
      const range = c.range ?? { min: 0, max: 1 };
      const previousValue = typeof previous === 'number' ? previous : typeof previous === 'object' ? previous.x : Number(c.default ?? range.min);
      const previousFraction = Math.max(0, Math.min(1, (previousValue - range.min) / (range.max - range.min || 1)));
      const value = controlValue(controlFraction(shape, point, previousFraction), range);
      if (c.kind === 'xy') {
        const yr = c.yRange ?? range;
        const y = yr.min + Math.min(1, Math.max(0, point.y / THEME.control.height + 0.5)) * (yr.max - yr.min);
        m.values.set(c.id, { x: value, y });
      } else m.values.set(c.id, value);
      if (isBrightness(c) && previous !== m.values.get(c.id)) m.power = true;
      this.positionThumb(m, c, thumb);
    };
    const widget: Widget = { group, w: shaped ? DIAL_DIAMETER : THEME.control.width, h: shaped ? DIAL_DIAMETER : THEME.control.height, kind: 'control', lastMove: 0, start: (p) => { update(p); this.emitControl(m, c, 'start'); }, move: (p) => { update(p); this.emitControl(m, c, 'move'); }, end: () => this.emitControl(m, c, 'end') };
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
      const angle = (-0.75 + 1.5 * fraction) * Math.PI;
      const radius = DIAL_DIAMETER / 2 - 0.009;
      thumb.position.set(Math.sin(angle) * radius, Math.cos(angle) * radius, THEME.panel.depth * 2);
      thumb.rotation.z = -angle;
    } else if (group?.userData.archetype === 'lever') {
      thumb.position.set(0, (fraction - .5) * LEVER_TRAVEL, THEME.panel.depth * 2);
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
    if (!m.armed || this.home.mode !== 'control' || !this.selected()?.tagged || this.selectedConnection() !== 'ready'
      || this.deviceState?.busy || this.menus.get(hack.targetId)?.items.find((item) => item.id === hack.itemId)?.status !== 'verified') return;
    const ts = Date.now();
    m.command = { controlId: hack.itemId, value: true, ts, phase: 'sending', at: this.time * 1000, hack };
    this.refreshCommandUi(m); this.events.emit('hack', { ...hack, ts });
  }
  private emitControl(m: Mounted, c: Control, phase: ControlEvent['phase']): void {
    this.lastControlAt = this.time;
    if (!this.isArmed(m, c)) return;
    const value = m.values.get(c.id) ?? c.default ?? 0, ts = Date.now();
    m.command = { controlId: c.id, value, ts, phase: 'sending', at: phase === 'start' ? Infinity : this.time * 1000 };
    this.refreshCommandUi(m);
    this.events.emit('control', { specId: m.spec.specId, controlId: c.id, value, phase, ts });
  }
  private refreshCommandUi(m: Mounted): void {
    if (this.mounted() !== m) return;
    const canRetry = m.command?.hack
      ? this.menus.get(m.command.hack.targetId)?.items.find((item) => item.id === m.command!.hack!.itemId)?.status === 'verified'
      : !!m.command && m.spec.controls.some((control) => control.id === m.command!.controlId && this.isArmed(m, control));
    const failed = m.command?.phase === 'fail' && canRetry;
    // Failure shows on the card's status line; tapping the preset or dial again retries.
    void failed;
    this.refreshLook();
    this.refreshStatus();
  }
  setCommandResult(specId: string, controlId: string, ts: number, ok: boolean): void {
    const m = this.specs.get(specId);
    if (!m || !acceptsCommandResult(m.command, controlId, ts)) return;
    m.command!.phase = ok ? 'ok' : 'fail';
    this.refreshCommandUi(m);
  }
  setScanning(on: boolean, _info?: { modelId?: string }): void { if (this.scanning === on) return; this.scanning = on; this.refreshCard(); }
  isTargetVisible(id: string): boolean { return (this.annotationLayer.visible || this.home.mode === 'control' && id === this.locked) && this.boxes.isVisible(id); }
  getTargetAim(id: string, out: { position: Vector3; size: number }): boolean {
    const box = this.boxes.boxes.get(id);
    if (!box || !this.annotationLayer.visible || !this.isTargetVisible(id)) return false;
    // The device body stays aimable even when tagged (only its chip is drawn): people pinch the object itself.
    // The chip above it is its own pinchable widget ('selectTarget').
    out.position.copy(box.center); out.size = Math.max(box.w, box.h);
    return true;
  }
  upsertTarget(t: HudTarget): void {
    if (t.label.trim().toLowerCase() === 'person') { this.removeTarget(t.id); return; }
    if (this.fading.delete(t.id)) this.boxes.setOpacity(t.id, 1);
    const previous = this.targets.get(t.id);
    this.targets.set(t.id, t);
    this.point.fromArray(t.position);
    if (!this.boxes.set(t.id, this.point, t.sizeM?.[0] ?? THEME.box.defaultWidth, t.sizeM?.[1] ?? THEME.box.defaultHeight, t.tagged ? THEME.color.accent : THEME.color.line)) return;
    this.boxes.setTagged(t.id, !!t.tagged, t.connection === 'ready');
    this.boxes.setFacing(t.id, t.facing);
    if (!previous || previous.label !== t.label || previous.tagged !== t.tagged || previous.connection !== t.connection || previous.identifying !== t.identifying || previous.busy !== t.busy || previous.locating !== t.locating) this.refreshTargetLabel(t);
    if (this.locked === t.id) {
      if (previous?.label !== t.label || previous?.connection !== t.connection || previous?.tagged !== t.tagged) this.refreshCard();
      else if (previous?.status !== t.status) this.refreshStatus();
    }
  }
  private refreshTargetLabel(t: HudTarget): void {
    let label = this.labels.get(t.id);
    if (!label) { label = new Group(); label.name = `target-label:${t.id}`; this.labels.set(t.id, label); this.annotationLayer.add(label); }
    this.clear(label);
    // Untag only after an explicit selection: on hover the (distance-scaled) chip can cover the device, so a pinch aimed
    // at the device would otherwise remove its tag by accident.
    const removable = this.home.mode === 'annotate' && t.tagged && this.locked === t.id;
    const state = this.deviceState?.targetId === t.id ? this.deviceState : null;
    const text = targetChipLabel({ ...t, ...(state ? { connection: state.connection, busy: state.busy } : {}) }, this.home.mode, !!removable || (!t.tagged && this.candidate === t.id));
    const width = Math.max(0.09, Math.ceil((text.length * THEME.font.label * 0.56 + THEME.box.labelPadding * 3) * 100) / 100);
    if (removable) {
      this.button(label, `tag-remove:${t.id}`, text, width / 2, 0, width, 'handle', () => this.events.emit('tagRemove', { targetId: t.id }));
      this.button(label, `forget:${t.id}`, 'Forget', width + 0.055, 0, 0.09, 'handle', () => this.events.emit('forget', { targetId: t.id }));
    }
    else {
      const pill = this.surfaces.create(width, THEME.box.labelHeight, t.tagged ? 'selected' : 'plate', true);
      pill.position.x = width / 2;
      // The bundled Latin font has no check glyph; share the Verified badge's vector check.
      const checkWidth = t.tagged ? 0.016 : 0;
      const name = makeText({ text: text.replace(/^✓ /, ''), size: THEME.font.label, weight: 500, singleLine: true, maxWidth: width - THEME.box.labelPadding * 2 - checkWidth,
        ...(t.tagged ? { color: LOOK.text.onLight } : {}) });
      name.position.set(THEME.box.labelPadding + checkWidth, 0, THEME.panel.depth);
      label.add(pill, name);
      if (t.tagged) {
        label.userData.hitOffsetX = width / 2;
        this.widgets.push({ group: label, w: width, h: THEME.box.labelHeight, kind: 'handle', button: true, lastMove: 0,
          start: () => this.events.emit('selectTarget', { targetId: t.id }) });
        const check = new Mesh(this.checkGeometry, this.materials.onLight);
        check.name = 'tagged-check'; check.position.set(THEME.box.labelPadding + 0.005, 0, THEME.panel.depth);
        check.renderOrder = THEME.render.text; label.add(check);
      }
    }
    // Registered object actions (e.g. "Use as controller") sit beside the selected object's label.
    let x = width + 0.01;
    if (this.locked === t.id || this.candidate === t.id) for (const action of this.objectActions) {
      if (action.visible && !action.visible(t.id)) continue;
      const w = Math.max(0.1, Math.ceil((action.label.length * THEME.font.label * 0.56 + THEME.box.labelPadding * 3) * 100) / 100);
      this.button(label, `object-action:${action.key}:${t.id}`, action.label, x + w / 2, 0, w, 'handle', () => action.onSelect(t.id));
      x += w + 0.01;
    }
    this.boxes.registerLabel(t.id, label, width);
  }
  removeTarget(id: string): void {
    // A box leaving Annotate (filter switch, stale detection) fades out over 250 ms instead of popping.
    if (this.home.mode === 'annotate' && this.targets.has(id) && this.boxes.isVisible(id)) this.fading.set(id, this.time);
    else { this.fading.delete(id); this.boxes.remove(id); }
    this.targets.delete(id);
    const label = this.labels.get(id); if (label) { label.removeFromParent(); this.clear(label); this.labels.delete(id); }
    if (this.locked === id) { this.locked = null; this.setAssistant(null); this.setSetupProgress(null); this.setCanvas(null); this.pinned = false; this.card.userData.pinned = false; this.refreshCard(); }
  }
  clearTargets(): void { for (const id of this.targets.keys()) this.removeTarget(id); }
  setCandidate(id: string | null): void {
    const old = this.candidate; this.candidate = id;
    if (old === id) return;
    if (old && this.targets.has(old)) this.refreshTargetLabel(this.targets.get(old)!);
    if (id && this.targets.has(id)) this.refreshTargetLabel(this.targets.get(id)!);
  }
  setLocked(id: string | null): void {
    if (id !== this.locked) { this.setAssistant(null); this.setSetupProgress(null); this.setCanvas(null); }
    if (id !== this.locked && this.codeEntry && this.codeTarget !== HELPER_PAIRING_TARGET) this.closePairCode();
    const old = this.locked; this.locked = id;
    if (old !== id) { this.pinned = false; this.card.userData.pinned = false; this.evidence = null; this.upload = null; this.selectedAction = null; this.unfoldStarted = this.time; }
    // A newly selected device's panel spawns once in front of the wearer; it never follows the head afterwards.
    if (id && old !== id && !this.workspaceAnchorHeld()) this.workspaceAnchor.reset();
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
    for (const control of this.mounted()?.spec.controls ?? []) if (control.armed !== true) lines.push(`${control.label}: not verified`);
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
    const mounted = this.mounted(), manual = !!mounted && !!this.otherContinuous(mounted);
    this.detailText.position.y = manual ? -0.019 : 0.06;
    if (manual) this.detailText.userData.fitHeight = 0.025;
    else delete this.detailText.userData.fitHeight;
    setText(this.detailText, wrapped.slice(manual ? -1 : -THEME.panel.detailLines).join('\n') || (manual ? 'Manual control · your hand map is unchanged' : 'No activity yet.'));
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
      this.refreshButtons(m); this.refreshStatus(); this.refreshDials();
    }
  }
  showConfirm(confirm: ConfirmRequest | null): void {
    if (confirm && this.home.mode !== 'control' && confirm.kind !== 'forget' && confirm.kind !== 'place') return;
    if (confirm) this.interruptAssistantInput();
    if (!confirm && this.codeTarget === HELPER_PAIRING_TARGET) { this.confirm = null; return; }
    this.confirm = confirm; this.clear(this.modal); this.modal.visible = !!confirm; if (!confirm) {
      if (this.approvals.length) this.showApprovals(this.approvals);
      else if (this.pairing) this.showPairing(this.pairing);
      this.refreshCard(); this.place();
      return;
    }
    this.modal.add(this.plate(THEME.panel.width, 0.32));
    const heading = makeText({ text: confirm.title, size: THEME.font.title, weight: 600, anchorX: 'center', maxWidth: THEME.panel.textWidth, maxHeight: 0.06 });
    heading.name = 'confirmation-title'; heading.position.set(0, 0.105, THEME.panel.depth); this.modal.add(heading);
    const summary = makeText({ text: (confirm.summary ?? (confirm.hold ? 'Hold to confirm.' : 'Confirm this action.')).slice(0, 200), size: THEME.font.label, anchorX: 'center', anchorY: 'top', maxWidth: THEME.panel.textWidth, maxHeight: 0.11 });
    summary.name = 'confirmation-summary'; summary.position.set(0, 0.05, THEME.panel.depth); this.modal.add(summary);
    const arm = confirm.kind === 'arm';
    let startedAt = 0;
    const primary = this.button(this.modal, 'confirm-yes', confirm.primaryLabel ?? (arm ? 'Enable controls' : confirm.hold ? 'Hold to allow' : 'Allow'), 0.065, -0.1, arm ? 0.21 : THEME.control.buttonWidth * 1.5, 'confirm', () => { startedAt = this.time; }, () => {
      if ((!confirm.expiresAt || Date.now() < confirm.expiresAt) && (!confirm.hold || (this.time - startedAt) * 1000 >= (arm ? 2000 : THEME.control.holdMs))) this.events.emit('confirm', { id: confirm.id, approve: true, hold: !!confirm.hold });
    });
    if (arm) {
      primary.group.userData.primary = true;
      (primary.group.getObjectByName('button-plate') as Mesh).material = this.surfaces.material(primary.w, primary.h, 'primary', true);
      if (confirm.hold) this.label(this.modal, 'Hold for 2 seconds to enable', -0.045, THEME.font.detail);
    }
    this.button(this.modal, 'confirm-no', confirm.cancelLabel ?? (arm ? 'Not now' : 'Cancel'), -0.11, -0.1, THEME.control.buttonWidth, 'confirm', () => this.events.emit('confirm', { id: confirm.id, approve: false }));
    this.place();
  }
  showPairing(pair: { display: string; qr: string; message?: string } | null): void {
    if (pair) this.interruptAssistantInput();
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
    if (view) this.interruptAssistantInput();
    this.helperPairingView = view;
    this.helperPairing.setState(view);
    if ((!view || view.pairedName) && this.codeTarget === HELPER_PAIRING_TARGET) this.closePairCode();
    this.refreshCard(); this.place();
  }
  showApprovals(list: { pairingId: string; name: string; kind: string; display: string }[]): void {
    if (list.length) this.interruptAssistantInput();
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
      this.setAssistant(null);
      this.setSetupProgress(null);
      this.setCanvas(null);
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
    if (modeChanged) this.setMenuOpen(false);
    this.place();
  }
  setDeviceState(state: DeviceState | null): void {
    const previous = this.deviceState;
    if (previous === state) return;
    const sameContent = previous && state && previous.targetId === state.targetId && previous.connection === state.connection && previous.hint === state.hint && previous.action === state.action && previous.busy === state.busy && previous.sentence === state.sentence && previous.handControl === state.handControl && previous.performAvailable === state.performAvailable && previous.screenGuide === state.screenGuide && previous.canvasReady === state.canvasReady && previous.silentVisual === state.silentVisual && previous.mappingSummary === state.mappingSummary && previous.mappingActionId === state.mappingActionId && previous.mappingOutcome === state.mappingOutcome;
    if (sameContent && previous.pairingSeconds === state.pairingSeconds && previous.performingLive === state.performingLive && previous.performanceRoute === state.performanceRoute) return;
    this.deviceState = state;
    this.setupProgress.setWorking(this.setupWorking());
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
  setSetupProgress(view: SetupProgressView | null): void {
    if (view && (this.home.mode !== 'control' || !this.locked || !this.selected()?.tagged)) return;
    const wasVisible = this.hasSetupProgress();
    this.setupProgressView = view;
    this.setupProgressTarget = view ? this.locked : null;
    this.setupProgress.setState(view, this.setupWorking());
    if (wasVisible !== this.hasSetupProgress()) this.refreshCard();
    this.place();
  }
  setCanvas(view: CanvasView | null): void {
    if (view && (view.targetId !== this.locked || this.home.mode !== 'control' || !this.selected()?.tagged)) return;
    const wasOpen = this.hasCanvas();
    if (view && !wasOpen) for (const capture of this.captures.values()) {
      // Opening a local game must not finish a captured hardware drag and send its last command.
      capture.widget = null; capture.mode = null; capture.hasTip = false; capture.history.reset();
    }
    this.canvasView = view; this.canvasPanel.setState(view);
    if (wasOpen !== this.hasCanvas()) this.refreshCard();
    this.place();
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
    this.interruptAssistantInput();
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
  setOnboarding(view: OnboardingView | null): void {
    // No coach cards in the headset (the wrist palette and the device ring are the guidance).
    view = null as OnboardingView | null;
    if (view && !this.onboarding) this.coachPlacement.reset();
    this.onboarding = view;
    if (view) {
      setText(this.coachTitle, view.title); setText(this.coachBody, view.message);
      setText(this.coachStep, view.step === 'tag' ? '2 of 3 · Find a device' : '3 of 3 · Choose when to use it');
      this.coach.userData.step = view.step;
    }
    this.place();
  }
  setAssistant(view: AssistantView | null): void {
    if (view && view.targetId !== 'muse-general' && (view.targetId !== this.locked || this.home.mode !== 'control' || !this.selected()?.tagged || this.onboarding)) return;
    this.assistantView = view ? { ...view, targetLabel: view.targetId === 'muse-general' ? 'Ask Muse' : this.selected()?.label, mapping: view.mapping ? [...view.mapping] : undefined } : null;
    this.assistant.setState(this.assistantView);
    const talk = this.assistantTalk.group;
    talk.userData.disabled = view?.state === 'thinking';
    talk.userData.selected = view?.state === 'listening';
    const label = talk.children.find((child) => 'sync' in child) as SdfText;
    setText(label, view?.state === 'listening' ? 'Send' : view?.state === 'thinking' ? 'Thinking…' : 'Ask Muse', view?.state === 'listening' ? THEME.color.accent : THEME.color.text);
    this.place();
  }
  private setMenuOpen(open: boolean): void {
    if (open && this.projectView) this.events.emit('projectsPause', {});
    if (open) this.interruptAssistantInput();
    if (open && !this.deck.panel.visible) { this.events.emit('menuOpened', {}); }
    this.deck.setOpen(open);
    this.place();
    for (const capture of this.captures.values()) {
      if (capture.widget && !visible(capture.widget.group)) this.releaseDockCapture(capture);
    }
  }
  recenter(): void {
    this.pinned = false; this.card.userData.pinned = false;
    this.workspaceAnchor.reset(); this.coachPlacement.reset();
    for (const capture of this.captures.values()) if (capture.widget) this.releaseDockCapture(capture);
    this.place();
  }
  private interruptAssistantInput(): void {
    const view = this.assistantView;
    if (view && (view.state === 'idle' || view.state === 'listening')) this.events.emit('assistantDismiss', { targetId: view.targetId });
  }
  private releaseDockCapture(capture: Capture): void {
    const widget = capture.widget;
    capture.widget = null; capture.mode = null; capture.pokeBlocked = false; capture.hasTip = false;
    capture.wasPinching = true; capture.history.reset();
    if (widget?.kind === 'control' || widget?.kind === 'deck') widget.end?.();
  }
  cancelInteractions(): void {
    for (const capture of this.captures.values()) {
      capture.widget = null; capture.mode = null; capture.pokeBlocked = false; capture.hasTip = false;
      capture.wasPinching = true; capture.history.reset();
    }
    this.pressUntil.clear(); this.deck.cancelExitHold();
  }
  private refreshHome(): void {
    this.deck.setState(this.home, this.canStop());
    for (const capture of this.captures.values()) {
      if (capture.widget?.kind === 'deck' && !visible(capture.widget.group)) this.releaseDockCapture(capture);
    }
    for (const group of this.deck.buttons) {
      if (this.widgets.some((widget) => widget.group === group)) continue;
      const start = () => {
        if (group.name === 'menu-toggle') this.setMenuOpen(!this.deck.panel.visible);
        else if (group.name === 'menu-close') this.setMenuOpen(false);
        else if (group.name === 'menu-tools' || group.name === 'menu-tools-back') { this.deck.setTools(group.name === 'menu-tools'); this.place(); }
        else if (group.name === 'mode-annotate' || group.name === 'mode-control') {
          this.setMenuOpen(false);
          this.events.emit('mode', { mode: group.name === 'mode-annotate' ? 'annotate' : 'control' });
        } else if (group.name.startsWith('filter:')) {
          this.setMenuOpen(false);
          this.events.emit('filter', { filter: group.name.slice(7) as HomeState['filter'] });
        } else if (group.name === 'helper-pair') {
          this.setMenuOpen(false); this.events.emit('helperPair', {});
        } else if (group.name === 'visual-synth') {
          this.setMenuOpen(false); this.events.emit('visualSynth', {});
        } else if (group.name === 'ask-muse-general') {
          this.setMenuOpen(false); this.events.emit('askMuseGeneral', {});
        } else if (group.name === 'identify-area') {
          this.setMenuOpen(false); this.events.emit('identifyArea', {});
        } else if (group.name === 'muse-canvas') {
          this.setMenuOpen(false); this.events.emit('projectsOpen', {});
        } else if (group.name === 'change-device') {
          this.setMenuOpen(false); this.events.emit('changeDevice', {});
        } else if (group.name === 'menu-recenter') {
          this.recenter(); this.setMenuOpen(false);
        } else if (group.name === 'exit-ar') this.deck.beginExitHold(this.time * 1000);
        else this.events.emit('deck', { key: 'panic', phase: 'press' });
      };
      this.widgets.push({ group, w: group.userData.width, h: group.userData.height, kind: 'deck', start,
        end: group.name === 'exit-ar' ? () => this.deck.cancelExitHold() : group.name === 'deck:panic' ? () => { this.events.emit('deck', { key: 'panic', phase: 'release' }); this.setMenuOpen(false); } : undefined,
        button: true, lastMove: 0 });
    }
  }
  setDeck(d: { open?: boolean; scanning?: boolean; daemons?: boolean; at?: [number, number, number] }): void {
    if (d.open !== undefined) this.setMenuOpen(d.open);
  }
  setProjects(view: ProjectView | null): void {
    this.projectView = view; this.projectPanel.setState(view); this.place();
    for (const capture of this.captures.values()) if (capture.widget && !visible(capture.widget.group)) this.releaseDockCapture(capture);
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
  presentationSnapshot(): { surface: 'menu' | 'device' | 'assistant' | 'project' | 'inspect'; stage: 'choose' | 'prepare' | 'building' | 'review' | 'ready' | 'perform' } {
    if (this.deck.panel.visible) return { surface: 'menu', stage: 'choose' };
    if (this.modal.visible) return { surface: 'device', stage: 'review' };
    if (this.projectView) return { surface: 'project', stage: this.projectView.running ? 'perform' : this.projectView.ready ? 'ready' : 'prepare' };
    if (this.assistant.visible && this.assistantView) {
      const view = this.assistantView;
      return { surface: view.objectInfo ? 'inspect' : 'assistant', stage: view.state === 'thinking' || view.state === 'setup' ? 'building'
        : view.state === 'proposal' ? 'review' : view.state === 'applied' ? 'ready' : 'prepare' };
    }
    if (this.deviceState?.handControl) return { surface: 'device', stage: 'perform' };
    if (this.setupWorking() || this.deviceState?.busy) return { surface: 'device', stage: 'building' };
    if (this.deviceState?.performAvailable && this.mounted()?.armed) return { surface: 'device', stage: 'ready' };
    return { surface: 'device', stage: this.home.mode === 'control' && !!this.selected()?.tagged ? 'prepare' : 'choose' };
  }
  private assistantNeedsFocus(): boolean {
    return this.assistant.visible && !!this.assistantView && ['listening', 'thinking', 'setup', 'proposal'].includes(this.assistantView.state);
  }
  private place(): void {
    if (!this.hasFrame) return;
    if (this.projectView?.running && (this.modal.visible || this.helperPairingView || this.deck.panel.visible)) this.events.emit('projectsPause', {});
    this.modalLayer.visible = !this.deck.panel.visible;
    this.deck.visible = false;
    const target = this.selected(), m = this.mounted();
    const workspace = this.home.mode === 'control' && !!target?.tagged;
    const selection = this.home.mode === 'control' ? this.home.visualSynthSelection : undefined;
    const available = !this.modal.visible && !this.helperPairingView && !this.deck.panel.visible && !selection && !this.projectView;
    // One foreground task at a time. The device's physical anchor remains unchanged.
    const generalConversation = this.assistantView?.targetId === 'muse-general';
    this.assistant.visible = available && (generalConversation || workspace && !this.onboarding && this.assistantView?.targetId === target?.id
      && (!this.setupWorking() || this.assistantView.state !== 'setup'));
    this.card.visible = workspace && available && !this.assistant.visible;
    // Tag/use coaching is nonblocking: the wearer may keep finding devices before switching modes.
    // Only an actual foreground workspace/menu/dialog suppresses annotation targets.
    this.annotationLayer.visible = !this.deck.panel.visible && !this.modal.visible && !this.helperPairingView && !workspace && !selection && !this.projectView && !this.assistant.visible;
    this.visualSelection.visible = !!selection && !this.deck.panel.visible && !this.modal.visible && !this.helperPairingView && !this.projectView;
    this.projectPanel.visible = !!this.projectView && !this.deck.panel.visible && !this.modal.visible && !this.helperPairingView;
    // Spawn the shared workspace pose the first time a panel needs it (~0.6 m, 15° below eye line), then never move it.
    // A selected device's card spawns beside its box (never between the eyes and the device).
    const selectedBox = this.card.visible && target ? this.boxes.boxes.get(target.id) : undefined;
    if (selectedBox && !this.workspaceAnchor.isPlaced) this.workspaceAnchor.spawnBeside(selectedBox.center, selectedBox.w / 2, this.headPose, this.time * 1000);
    if (this.card.visible || this.modal.visible || this.assistant.visible || this.projectPanel.visible || !!selection || !!this.helperPairingView || this.deck.panel.visible) {
      this.workspaceAnchor.update(this.headPose, this.time * 1000);
    }
    this.workspaceAnchor.place(this.projectPanel);
    if (selection) {
      setText(this.visualSelectionTitle, selection.phase === 'pending' ? 'Opening Mac visuals' : 'Waiting for Mac visuals');
      setText(this.visualSelectionBody, selection.message);
      this.visualSelectionRetry.group.visible = selection.phase === 'unavailable';
      this.workspaceAnchor.place(this.visualSelection);
    }
    this.setupProgress.visible = this.card.visible && this.hasSetupProgress();
    this.canvasPanel.visible = this.card.visible && this.hasCanvas();
    // Center the taller game panel around eye level, not below the device card.
    this.canvasPanel.position.y = 0.12;
    this.heading.visible = !this.hasCanvas();
    this.cardPlate.visible = !this.hasSetupProgress() && !this.hasCanvas();
    const objectActions = this.card.visible && !this.deviceState?.handControl && !this.onboarding && !this.deviceState?.busy && !this.hasSetupProgress() && !this.hasCanvas();
    this.inspectLaunch.group.visible = this.lab && objectActions;
    // Games are an object fallback, not an unrelated action on an operating instrument.
    this.canvasLaunch.group.visible = this.lab && objectActions && (this.deviceState?.canvasReady || !m?.armed && !this.deviceState?.performAvailable && !/synth|laptop|macbook|computer|keyboard/i.test(target?.label ?? ''));
    this.inspectLaunch.group.position.x = this.canvasLaunch.group.visible ? -0.105 : 0;
    setText(this.canvasLaunch.group.children[1] as SdfText, this.deviceState?.canvasReady ? 'Open game' : 'Make a game');
    this.assistantTalk.group.visible = this.lab && this.card.visible && !this.onboarding && !this.deviceState?.handControl;
    this.assistantTalk.group.position.y = this.canvasPanel.visible ? 0.314 : 0.202;
    const screenGuide = this.deviceState?.targetId === target?.id && this.deviceState?.screenGuide
      && (this.selectedConnection() === 'setup' || this.deviceState.busy) && this.selectedConnection() !== 'ready';
    this.screenGuide.visible = !!screenGuide && this.card.visible && !this.assistant.visible && !this.canvasPanel.visible;
    if (this.screenGuide.visible) {
      // This is a comfortable aiming aid, not a promise about camera capture boundaries.
      this.screenGuide.position.set(0.30, 0.06, -1).applyQuaternion(this.headQuaternion).add(this.head);
      this.screenGuide.quaternion.copy(this.headQuaternion);
      // Brackets only: the card's status line already says what to do.
      setText(this.screenGuideText, '');
    }
    // The selected card names this device; its floating chip must not cross the conversation text.
    for (const [id, label] of this.labels) {
      const box = this.boxes.boxes.get(id);
      // Quiet rings; the pill label appears only on gaze/ray hover, for the selection, or once tagged.
      label.visible = this.annotationLayer.visible && !!box?.visible && box.opacity > 0.001
        && (id === this.candidate || id === this.locked || !!this.targets.get(id)?.tagged);
    }
    this.helperPairing.visible = !!this.helperPairingView && !this.modal.visible && !this.deck.panel.visible;
    this.coach.visible = !!this.onboarding && !this.assistant.visible && !this.helperPairingView && !this.modal.visible && !this.deck.panel.visible && !this.projectView;
    this.helperPairing.update({ head: this.headPose, time: this.time * 1000 });
    this.workspaceAnchor.place(this.helperPairing);
    const unfold = target ? unfoldEase((this.time - this.unfoldStarted) / THEME.motion.duration) : 1;
    this.card.scale.x = Math.max(0.001, unfold);
    const controls = unfoldEase((this.time - this.controlsStarted) / THEME.motion.duration);
    this.controls.scale.y = Math.max(0.001, controls);
    const box = target && this.boxes.boxes.get(target.id);
    this.workspaceAnchor.place(this.card);
    this.card.scale.set(Math.max(0.001, unfold), 1, 1);
    // The card spawns right beside its device (ring + dials on the box), so no tether line.
    this.tether.hide();
    this.workspaceAnchor.place(this.modal);
    this.workspaceAnchor.place(this.assistant);
    this.assistant.scale.setScalar(1);
    // One navigation slot clears the largest task panel and never follows head motion.
    this.workspaceAnchor.place(this.deck, 0.378);
    this.workspaceAnchor.place(this.deck.panel, 0.05);
    const foreground = this.deck.panel.visible ? this.deck.panel : this.modal.visible ? this.modal
      : this.helperPairing.visible ? this.helperPairing : this.projectPanel.visible ? this.projectPanel
      : this.visualSelection.visible ? this.visualSelection : this.assistant.visible ? this.assistant
      : this.card.visible ? this.card : this.deck.visible ? this.deck : undefined;
    this.edge.visible = !!foreground && this.edgePlacement.update(this.head, this.headQuaternion, foreground.position);
    if (this.edge.visible) {
      this.edge.position.copy(this.edgePlacement.position); this.edge.quaternion.copy(this.headQuaternion);
      this.edgeArrow.rotation.z = this.edgePlacement.angle;
      const x = Math.cos(this.edgePlacement.angle), y = Math.sin(this.edgePlacement.angle);
      const direction = Math.abs(x) >= Math.abs(y) ? x >= 0 ? 'right' : 'left' : y >= 0 ? 'up' : 'down';
      setText(this.edgeText, this.assistantNeedsFocus() ? `Muse · look ${direction}` : `Controls · look ${direction}`);
      this.edge.userData.targetSurface = foreground!.name;
      this.tether.hide();
    } else this.edge.userData.targetSurface = undefined;
    const presentation = this.presentationSnapshot();
    this.root.userData.workspace = presentation;
    this.deck.setWorkspace(presentation.stage);
    const inputSurface = this.deck.panel.visible ? `menu:${this.deck.panel.userData.toolsOpen ? 'tools' : 'demo'}` : this.modal.visible ? `modal:${this.confirm?.id ?? 'pair-code'}`
      : this.helperPairing.visible ? 'helper-pairing' : this.projectPanel.visible ? 'project' : this.visualSelection.visible ? 'visual-selection'
      : this.assistant.visible ? `assistant:${this.assistantView?.targetId}` : this.card.visible ? `device:${this.locked}` : 'choose';
    if (this.inputSurface !== inputSurface) {
      this.inputSurface = inputSurface;
      // A held pinch belongs to the surface it began on. A second hand may not
      // click through a replacement surface in the same frame either.
      for (const capture of this.captures.values()) {
        if (capture.widget?.kind === 'control' || capture.widget?.kind === 'deck') this.releaseDockCapture(capture);
      }
      this.cancelInteractions();
    }
    if (this.coach.visible) this.follow(this.coach, this.coachPlacement);
    if (this.notice.visible) this.follow(this.notice, this.noticePlacement);
  }
  // --- spatial input (xr-input + pointer-events) -------------------------------------------------------

  /** Attach the single UI input owner. From then on the legacy fingertip/ray hit-testing is off. */
  setSpatialInput(spatial: SpatialInput | null): void {
    this.spatial = spatial;
    for (const capture of this.captures.values()) this.releaseDockCapture(capture);
  }
  /** Add a wrist-palette button (≤ 5 shown). Returns an unregister function. */
  registerPaletteItem(item: PaletteItem): () => void { return this.palette.register(item); }
  /** Add an action pill beside a selected object's ring label (e.g. "Use as controller"). */
  registerObjectAction(action: { key: string; label: string; visible?: (targetId: string) => boolean; onSelect: (targetId: string) => void }): () => void {
    this.objectActions.push(action);
    for (const target of this.targets.values()) this.refreshTargetLabel(target);
    return () => {
      const i = this.objectActions.indexOf(action); if (i >= 0) this.objectActions.splice(i, 1);
      for (const target of this.targets.values()) this.refreshTargetLabel(target);
    };
  }
  private workspaceAnchorHeld(): boolean { return [...this.holds.values()].some((hold) => hold.widget.drag); }
  private rebuildPalette(): void {
    this.clear(this.palette.contentGroup);
    for (const group of this.palette.rebuild()) {
      const item = this.palette.item(group.userData.paletteKey ?? group.name)!;
      const segment = group.userData.segmentKey as string | undefined;
      this.widgets.push({ group, w: group.userData.width, h: group.userData.height, kind: 'deck', button: true, lastMove: 0,
        // A button does its job and the menu gets out of the way (it reopens after the palm turns away and back);
        // segment rows (Annotate | Control, what to track) keep it open for a second choice.
        start: () => { if (segment) item.onSegment?.(segment); else if (item.hold) this.palette.beginHold(item.key, this.time * 1000); else { item.onSelect(); this.palette.anchor.dismiss(this.time * 1000); } },
        end: item.hold ? () => this.palette.cancelExitHold() : undefined });
    }
  }
  private isPaletteWidget(widget: Widget): boolean { return !!this.palette.getObjectById(widget.group.id); }
  /** One invisible hit plane per widget; pointer-events only intersects objects with listeners. */
  private syncHitMeshes(): void {
    for (const widget of this.widgets) {
      const group = widget.group;
      let hit = group.userData.hit as Mesh | undefined;
      if (!hit || hit.parent !== group) hit = this.bindHit(widget);
      // pmndrs pointer-events ignores Object3D.visible for the forwarded mouse and grab pointers: gate with pointerEvents too.
      const live = this.interactive(widget, this.cursors[0]!);
      hit.visible = live;
      (hit as unknown as { pointerEvents: string }).pointerEvents = live ? 'auto' : 'none';
      // The palette hand hovering its own palette is not a hover (only the other hand can press it).
      const ownHand = this.isPaletteWidget(widget) && this.palette.anchor.source === 'hand' ? this.palette.anchor.nonDominant : null;
      let hovered = false;
      for (const id of hit.userData.hover as Set<number>) if (!ownHand || this.spatial?.handOf(id) !== ownHand) { hovered = true; break; }
      group.userData.hovered = hovered;
    }
  }
  private bindHit(widget: Widget): Mesh {
    const hit = new Mesh(this.hitGeometry, this.hitMaterial);
    hit.name = 'ui-hit';
    const palette = this.isPaletteWidget(widget);
    // Segments of one row sit 4 mm apart and rows 10 mm apart: a segment's hit plane fills half of each gap (2 mm
    // sideways, 5 mm up/down), so a press in a gap always lands on the nearer segment and planes never overlap.
    const segment = !!widget.group.userData.segmentKey;
    const w = segment ? widget.w + 0.004 : Math.max(THEME.control.minHitSize, widget.w) + THEME.control.hitPadding * 2;
    const h = segment ? widget.h + 0.01 : Math.max(THEME.control.minHitSize, widget.h) + THEME.control.hitPadding * 2;
    hit.position.set(widget.group.userData.hitOffsetX ?? 0, 0, THEME.panel.depth * 2);
    hit.scale.set(w, h, 1);
    // Higher order wins over nearer surfaces: the palette, then buttons/controls/handles, then passive plates.
    (hit as unknown as { pointerEventsOrder: number }).pointerEventsOrder = palette ? 2 : widget.button || widget.drag || widget.kind === 'control' ? 1 : 0;
    hit.userData.hover = new Set<number>();
    (hit as unknown as { pointerEvents: string }).pointerEvents = 'none';
    const on = (type: string, fn: (e: HudPointerEvent) => void) =>
      (hit as unknown as { addEventListener(t: string, f: (e: unknown) => void): void }).addEventListener(type, (e) => fn(e as HudPointerEvent));
    on('pointerover', (e) => { (hit.userData.hover as Set<number>).add(e.pointerId); this.spatial?.markHover(e, true); });
    on('pointerout', (e) => { (hit.userData.hover as Set<number>).delete(e.pointerId); this.spatial?.markHover(e, false); });
    on('pointerdown', (e) => this.pointerDown(widget, e));
    on('pointermove', (e) => this.pointerMove(widget, e));
    on('pointerup', (e) => this.pointerUp(widget, e, false));
    on('pointercancel', (e) => this.pointerUp(widget, e, true));
    on('click', (e) => this.pointerClick(widget, e));
    widget.group.add(hit);
    widget.group.userData.hit = hit;
    return hit;
  }
  /** Tap buttons fire on lift-off over the same button (click); holds, drags and controls capture the pointer. */
  private isTap(widget: Widget): boolean {
    return !!widget.button && widget.kind !== 'control' && widget.kind !== 'confirm' && !(widget.kind === 'deck' && widget.end);
  }
  private acceptPointer(widget: Widget, e: HudPointerEvent): string | null {
    if (!this.spatial || (e.button ?? 0) !== 0 || e.nativeEvent?.altKey) return null;
    if (!this.widgets.includes(widget) || !this.interactive(widget, this.cursors[0]!)) return null;
    const hand = this.spatial.handOf(e.pointerId, e.pointerType) ?? 'unknown';
    // The palette hand cannot press its own palette; poke and pinch come from the other hand.
    if (this.isPaletteWidget(widget) && this.palette.anchor.source === 'hand' && hand === this.palette.anchor.nonDominant) return null;
    // Live Perform: hand gestures are gesture travel, not UI presses (controllers and the mouse still work).
    if (this.deviceState?.performingLive && (hand === 'left' || hand === 'right') && !this.isPaletteWidget(widget) && e.pointerType !== 'ray') return null;
    if (this.deviceState?.performingLive && e.pointerType === 'touch') return null;
    if ([...this.holds.values()].some((hold) => hold.widget === widget)) return null;
    return hand;
  }
  private localPoint(e: HudPointerEvent, plane: Matrix4): Vector3 { return this.local.copy(e.point).applyMatrix4(plane); }
  private pointerDown(widget: Widget, e: HudPointerEvent): void {
    const hand = this.acceptPointer(widget, e);
    if (!hand) return;
    e.stopPropagation?.();
    this.events.emit('consumed', { hand: hand === 'mouse' ? 'right' : hand, widget: widget.kind });
    this.pressUntil.set(widget.group.name, this.time + 0.12);
    if (this.isTap(widget)) { this.taps.set(e.pointerId, widget); return; }
    const plane = new Matrix4().copy(widget.group.matrixWorld).invert();
    this.holds.set(e.pointerId, { widget, hand, plane, lastMove: this.time });
    e.target?.setPointerCapture?.(e.pointerId);
    widget.start(this.localPoint(e, plane));
  }
  private pointerMove(widget: Widget, e: HudPointerEvent): void {
    const hold = this.holds.get(e.pointerId);
    if (!hold || hold.widget !== widget || !widget.move) return;
    if (this.time - hold.lastMove < 1 / THEME.control.dragHz && hold.lastMove !== this.time) return;
    hold.lastMove = this.time;
    widget.move(this.localPoint(e, hold.plane));
  }
  private pointerUp(widget: Widget, e: HudPointerEvent, cancelled: boolean): void {
    // A tap completes on lift-off over the same button (taps never capture, so this up is over this widget).
    if (this.taps.get(e.pointerId) === widget) { if (cancelled) this.taps.delete(e.pointerId); else this.pointerClick(widget, e); }
    const hold = this.holds.get(e.pointerId);
    if (!hold || hold.widget !== widget) return;
    this.holds.delete(e.pointerId);
    if (!this.widgets.includes(widget)) return;
    const local = this.localPoint(e, hold.plane);
    if (!cancelled && widget.move) widget.move(local);
    // Releasing a confirmation outside its face (or losing tracking) cancels it; controls and holds always end.
    const inside = Math.abs(local.x) <= Math.max(THEME.control.minHitSize, widget.w) / 2 + THEME.control.hitPadding
      && Math.abs(local.y) <= Math.max(THEME.control.minHitSize, widget.h) / 2 + THEME.control.hitPadding;
    if (widget.kind === 'control' || widget.kind === 'deck' || widget.drag || !widget.button || (!cancelled && inside)) widget.end?.();
  }
  private pointerClick(widget: Widget, e: HudPointerEvent): void {
    if (this.taps.get(e.pointerId) !== widget) return;
    this.taps.delete(e.pointerId);
    if (!this.widgets.includes(widget) || !this.interactive(widget, this.cursors[0]!)) return;
    const local = this.local.copy(e.point).applyMatrix4(this.inverse.copy(widget.group.matrixWorld).invert());
    widget.start(local);
    widget.end?.();
  }
  /** Explicit title-bar drags retain a world anchor; head turns and status changes never move it. */
  private dragHandle(panel: Group, name: string, width: number, y: number, x = 0, slotY = 0, height = 0.035): void {
    const handle = new Group(); handle.name = name; handle.position.set(x, y, THEME.panel.depth * 3);
    const start = new Vector3(), origin = new Vector3(), rotation = new Quaternion(), delta = new Vector3();
    const explicitMove = name === 'menu-drag';
    const grip = makeText({ text: explicitMove ? 'Move panel · hold pinch' : '', size: explicitMove ? 0.014 : 0.011, color: explicitMove ? THEME.color.text : THEME.color.muted, anchorX: 'center', maxWidth: width - 0.02, singleLine: true });
    grip.name = `${name}-label`; grip.position.z = THEME.panel.depth;
    if (explicitMove) { const plate = this.surfaces.create(width, height, 'button', true); plate.name = 'button-plate'; handle.add(plate); }
    else if (name === 'device-drag') {
      // Horizon-style grab bar: a small white pill at 30 % above the card.
      const bar = new Mesh(this.trackGeometry, new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, depthWrite: false, toneMapped: false }));
      bar.name = 'grab-bar'; bar.scale.set(0.08, 0.008, 1); bar.renderOrder = THEME.render.buttons; handle.add(bar);
    }
    handle.userData.dragHandle = true;
    handle.add(grip); panel.add(handle);
    this.widgets.push({ group: handle, w: width, h: height, kind: 'handle', drag: true, lastMove: 0,
      start: (point) => { start.copy(point); origin.copy(panel.position); rotation.copy(panel.quaternion); },
      move: (point) => {
        delta.subVectors(point, start).setZ(0).applyQuaternion(rotation);
        if (delta.lengthSq() > 4) return;
        panel.position.copy(origin).add(delta);
        this.workspaceAnchor.adopt(panel, this.headPose, this.time * 1000, slotY);
        if (panel === this.card) { this.pinned = true; this.card.userData.pinned = true; }
      },
      end: () => this.workspaceAnchor.adopt(panel, this.headPose, this.time * 1000, slotY),
    });
  }
  private inside(widget: Widget, point: Vector3): boolean {
    return Math.abs(point.x) <= Math.max(THEME.control.minHitSize, widget.group.userData.collapsed ? THEME.box.labelHeight : widget.w) / 2 + THEME.control.hitPadding
      && Math.abs(point.y) <= Math.max(THEME.control.minHitSize, widget.h) / 2 + THEME.control.hitPadding;
  }
  private hit(widget: Widget, cursor: Cursor, clampToFace = false): number {
    this.inverse.copy(widget.group.matrixWorld).invert();
    this.local.copy(cursor.tip).applyMatrix4(this.inverse);
    let distance = Math.abs(this.local.z), rayHit = false;
    if (!cursor.canPoke || distance > THEME.control.near || !this.inside(widget, this.local)) {
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
        if (!expandedRayBounds(this.local.x, this.local.y, widget.group.userData.collapsed ? 0.07 : widget.w, widget.h)) return Infinity;
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
  /** Match the visible aim assistance: a near miss can select a button from a relaxed hand ray.
   * Continuous controls keep exact plane geometry, and direct button hits always win. */
  private magneticButton(cursor: Cursor): Widget | null {
    if (!cursor.ray) return null;
    let best: Widget | null = null, angle = Infinity;
    for (const widget of this.widgets) {
      if (!widget.button || !this.interactive(widget, cursor)) continue;
      widget.group.getWorldPosition(this.point);
      const distance = rayTargetWithinAngle(cursor.ray.origin, cursor.ray.dir, this.point, 3);
      if (distance > THEME.control.rayDistance) continue;
      if (this.hit(widget, cursor, true) === Infinity) continue;
      // Rank the visible button face, not just its center: a near miss beside a wide Ask Muse
      // button must not snap to the tiny lock icon below it merely because that center is closer.
      const dx = Math.max(0, Math.abs(this.local.x) - widget.w / 2), dy = Math.max(0, Math.abs(this.local.y) - widget.h / 2);
      const e = widget.group.matrixWorld.elements;
      const sx2 = e[0]! ** 2 + e[1]! ** 2 + e[2]! ** 2, sy2 = e[4]! ** 2 + e[5]! ** 2 + e[6]! ** 2;
      const error = (dx * dx * sx2 + dy * dy * sy2) / (distance * distance);
      if (error < angle) { best = widget; angle = error; }
    }
    return best;
  }
  private interactive(widget: Widget, _cursor: Cursor): boolean {
    if (!visible(widget.group)) return false;
    let owner: Object3D | null = widget.group;
    while (owner && owner !== this.root) { if (owner.userData.disabled) return false; owner = owner.parent; }
    if (owner !== this.root) return false;
    // The wrist palette is the escape hatch: it stays pressable over any panel or dialog.
    const menu = !!this.deck.getObjectById(widget.group.id) || !!this.deck.panel.getObjectById(widget.group.id) || !!this.palette.getObjectById(widget.group.id);
    if (this.deck.panel.visible && !menu) return false;
    if (this.helperPairing.visible && !this.helperPairing.getObjectById(widget.group.id) && !menu) return false;
    if (this.visualSelection.visible && !this.visualSelection.getObjectById(widget.group.id) && !menu) return false;
    if (this.assistant.visible && !this.assistant.getObjectById(widget.group.id) && !menu) return false;
    if (this.projectPanel.visible && !this.projectPanel.getObjectById(widget.group.id) && !menu) return false;
    return !this.modal.visible || !!this.modal.getObjectById(widget.group.id) || menu;
  }
  private resolveTarget(cursor: Cursor): Widget | null {
    let winner: Widget | null = null, distance = Infinity;
    for (const widget of this.widgets) {
      if (!this.interactive(widget, cursor)) continue;
      const candidate = this.hit(widget, cursor);
      if (candidate !== Infinity && candidate <= distance) { distance = candidate; winner = widget; }
    }
    // A fingertip can be near empty panel space while its far ray aims at Move.
    // The passive surface still blocks other panels, but must not swallow its own controls.
    if (winner && !winner.button && !winner.drag && winner.kind !== 'control') {
      const surface = winner.group;
      let child: Widget | null = null, childDistance = Infinity;
      for (const widget of this.widgets) {
        if ((!widget.button && !widget.drag && widget.kind !== 'control') || !surface.getObjectById(widget.group.id) || !this.interactive(widget, cursor)) continue;
        const candidate = this.hit(widget, cursor);
        if (candidate !== Infinity && candidate <= childDistance) { child = widget; childDistance = candidate; }
      }
      winner = child ?? winner;
    }
    if (!winner?.button && !winner?.drag && winner?.kind !== 'control') winner = this.magneticButton(cursor) ?? winner;
    const capture = this.captures.get(cursor.id), ray = cursor.rawRay ?? cursor.ray;
    if (capture && cursor.justPinched && !capture.wasPinching && ray) {
      const compensated = capture.history.compensate(this.time * 1000, winner, ray.origin, ray.dir);
      if (compensated && this.widgets.includes(compensated) && this.interactive(compensated, cursor)) return compensated;
    }
    return winner;
  }
  private interact(cursor: Cursor): void {
    const capture = this.captures.get(cursor.id); if (!capture) return;
    if (!cursor.tracked) {
      const active = capture.widget; capture.widget = null; capture.mode = null; capture.hasTip = false; capture.wasPinching = false;
      capture.history.reset();
      if (active?.kind === 'control' || active?.kind === 'deck') active.end?.();
      return;
    }
    if (capture.widget && !this.interactive(capture.widget, cursor)) {
      this.releaseDockCapture(capture); capture.history.reset();
    }
    if (cursor.canPoke && capture.pokeBlocked) {
      this.local.copy(cursor.tip).applyMatrix4(capture.pokePlane);
      if (this.local.z > THEME.control.pokeRelease) capture.pokeBlocked = false;
    }
    const hover = this.resolveTarget(cursor);
    let poke: Widget | null = null;
    for (const widget of this.widgets) {
      if (this.interactive(widget, cursor) && this.crosses(widget, cursor, capture)) poke = widget;
    }
    if (hover) hover.group.userData.hovered = true;
    if (!capture.mode) {
      const pinch = cursor.justPinched && !capture.wasPinching;
      const winner = pinch ? hover : !cursor.pinching ? poke : null;
      if (winner && ![...this.captures.values()].some((other) => other !== capture && other.widget === winner)) {
        if (pinch) this.hit(winner, cursor, true);
        else this.crosses(winner, cursor, capture);
        capture.widget = winner; capture.mode = pinch ? 'pinch' : 'poke';
        capture.pokeBlocked = cursor.canPoke;
        capture.pokePlane.copy(winner.group.matrixWorld).invert();
        // A hand ray can acquire this handle while its fingertip is merely at
        // the same depth elsewhere. Keep that far-ray reference for the whole drag.
        this.point.copy(cursor.tip).applyMatrix4(capture.pokePlane);
        capture.dragNear = cursor.canPoke && Math.abs(this.point.z) <= THEME.control.near && this.inside(winner, this.point);
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
        // Releasing a review/confirmation outside its face is cancellation.
        // Control and dock end handlers still receive release to stop holds.
        if (!active.button || active.kind === 'control' || active.kind === 'deck' || this.hit(active, cursor) !== Infinity) active.end?.();
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
  private buttonFeedback(): void {
    for (const [name, until] of this.pressUntil) if (until < this.time) this.pressUntil.delete(name);
    for (const widget of this.widgets) {
      if (!widget.button && !widget.drag && widget.kind !== 'control') continue;
      const { group } = widget;
      let pressed = this.pressUntil.has(group.name);
      for (const capture of this.captures.values()) if (capture.widget === widget) pressed = true;
      for (const hold of this.holds.values()) if (hold.widget === widget) pressed = true;
      for (const tap of this.taps.values()) if (tap === widget) pressed = true;
      const hovered = Boolean(group.userData.hovered), selected = Boolean(group.userData.selected);
      group.userData.pressed = pressed;
      if (group.name === 'menu-drag') setText(group.getObjectByName('menu-drag-label') as SdfText, pressed ? 'Moving · release to place' : hovered ? 'Move panel · pinch and hold' : 'Move panel · hold pinch');
      if (widget.button && !group.name.startsWith('target-label:')) {
        const scale = pressed ? 0.92 : 1;
        group.scale.setScalar(scale);
      }
      const plate = group.getObjectByName('button-plate') as Mesh | undefined;
      if (!plate) continue;
      const command = this.mounted()?.command;
      const pending = command && command.controlId === group.userData.controlId ? command.phase : undefined;
      const on = !!group.userData.primary || selected && !group.userData.action;
      const style = pending === 'fail' ? 'failed' : pressed ? on ? 'on-pressed' : 'pressed' : pending === 'sending' ? 'sending' : group.userData.primary ? 'primary' : hovered ? selected && !group.userData.action ? 'selected-hover' : 'hover' : selected && !group.userData.action ? 'selected' : 'button';
      if (group.userData.feedbackStyle !== style) {
        group.userData.feedbackStyle = style; plate.material = this.surfaces.material(widget.w, widget.h, style, true);
        this.paintLabels(group, isOnStyle(style));
      }
    }
  }
  /**
   * Hands-first control asks this every frame: is this hand working UI right now? True while the wrist menu is open,
   * while the hand holds/drags a panel or dial, while it touches or ray-pinches UI, or while its index tip is within
   * reach of the device card or an arc (about to poke it). A ray merely resting on UI is not busy (handRayOnUi).
   */
  handBusy(hand: 'left' | 'right'): boolean {
    const anchor = this.palette.anchor;
    if (this.palette.visible && anchor.open && anchor.source === 'hand') return true;
    for (const hold of this.holds.values()) if (hold.hand === hand) return true;
    const state = this.frameHands[hand];
    if (this.spatial?.uiOwns(hand) && (this.spatial.pointerKind(hand) !== 'ray' || !!state?.pinching)) return true;
    const tip = state && !state.controller ? state.joints['index-finger-tip']?.position : undefined;
    const look = this.look;
    if (!tip || !look) return false;
    if (visible(look.card) && this.card.visible) {
      const local = look.card.worldToLocal(this.nearLocal.copy(tip));
      if (Math.abs(local.x) < look.card.widthM / 2 + 0.06 && Math.abs(local.y) < look.card.heightM / 2 + 0.06 && Math.abs(local.z) < 0.1) return true;
    }
    for (const dial of look.rig.dials) {
      if (!visible(dial)) continue;
      const geometry = dial.hit.geometry;
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      const sphere = geometry.boundingSphere!;
      if (this.nearWorld.copy(sphere.center).applyMatrix4(dial.hit.matrixWorld).distanceTo(tip) < sphere.radius + 0.06) return true;
    }
    return false;
  }
  handRayOnUi(hand: 'left' | 'right'): boolean { return !!this.spatial?.uiOwns(hand); }
  /** White = on: a white pill's labels turn dark (Horizon primary); glass restores each label's own colour. Only on a style change. */
  private paintLabels(group: Group, on: boolean): void {
    for (const child of group.children) {
      if (!('sync' in child)) continue;
      const text = child as SdfText;
      if (on) {
        if (text.color !== LOOK.text.onLight) text.userData.offColor = text.color;
        setText(text, text.text, LOOK.text.onLight);
      } else if (text.color === LOOK.text.onLight) setText(text, text.text, (text.userData.offColor as string | undefined) ?? THEME.color.text);
    }
  }
  update(frame: HudFrame): void {
    this.time = frame.time / 1000;
    for (const m of this.specs.values()) if (commandTimedOut(m.command, frame.time)) {
      m.command!.phase = 'fail'; this.refreshCommandUi(m);
    }
    this.surfaces.tick(this.time);
    this.assistant.updateUi(frame.dt * 1000);
    this.hasFrame = true;
    this.head.copy(frame.head.position); this.headQuaternion.copy(frame.head.quaternion);
    this.updateLook(frame);
    // Wrist palette: palm toward the face (or the controller menu button) shows it. Hands-first control stays
    // available: the engine holds the right hand while the left palm raises the menu, and a playing hand blocks opening.
    const performing = !!this.projectView?.running;
    const movingPanel = [...this.holds.values()].some((hold) => hold.widget.drag);
    this.palette.setSuppressed(performing || movingPanel || this.modal.visible);
    // Working a control (or just finished, or the other hand is pinching): a closed menu stays closed.
    const menuHand = this.palette.anchor.nonDominant, otherHand = frame.hands[menuHand === 'left' ? 'right' : 'left'];
    const usingControl = [...this.captures.values()].some((c) => !!c.widget && !this.isPaletteWidget(c.widget));
    if (usingControl) this.lastControlAt = this.time;
    if (this.deviceState?.performingLive) this.lastLiveAt = this.time;
    this.palette.anchor.blockOpen = usingControl || this.time - this.lastControlAt < 1 || (!!otherHand?.pinching && !otherHand.controller)
      || this.time - this.lastLiveAt < 0.25;
    this.frameHands = frame.hands;
    if (this.palette.needsRebuild()) this.rebuildPalette();
    this.palette.update(frame);
    const held = this.palette.updateHold(frame.time);
    if (held) { this.palette.cancelExitHold(); this.palette.item(held)?.onSelect(); this.palette.anchor.dismiss(frame.time); }
    for (const target of this.targets.values()) {
      if (this.home.mode === 'control' && !target.tagged) this.boxes.setOpacity(target.id, 0);
      else if (this.home.mode === 'annotate' && this.boxes.boxes.get(target.id)?.opacity === 0) this.boxes.setOpacity(target.id, 1);
    }
    this.boxes.setActive(this.locked ?? this.candidate);
    this.boxes.setSelected(this.locked);
    for (const [id, start] of this.fading) {
      const opacity = 1 - (this.time - start) / 0.25;
      if (opacity <= 0 || this.targets.has(id)) { this.fading.delete(id); if (!this.targets.has(id)) this.boxes.remove(id); }
      else this.boxes.setOpacity(id, opacity);
    }
    this.boxes.update(frame.dt, this.head, frame, this.home.mode);
    for (const [id, label] of this.labels) {
      const box = this.boxes.boxes.get(id); if (!box) continue;
      this.boxes.labelAnchor(box, this.head, label.position);
      this.boxes.labelQuaternion(this.head, label.position, label.quaternion);
    }
    this.place();
    this.root.updateMatrixWorld(true);
    handCursor('left', frame.hands.left, this.cursors[0]!); handCursor('right', frame.hands.right, this.cursors[1]!);
    if (this.deviceState?.performingLive || this.projectView?.engaged) for (const cursor of this.cursors) {
      if (frame.hands[cursor.hand as 'left' | 'right']?.controller) continue;
      cursor.tracked = false;
      const capture = this.captures.get(cursor.id);
      if (capture) { capture.widget = null; capture.mode = null; capture.hasTip = false; capture.wasPinching = false; capture.history.reset(); }
    }
    this.cursors[0]!.canPoke &&= !frame.hands.left?.controller;
    this.cursors[1]!.canPoke &&= !frame.hands.right?.controller;
    // Gesture travel stays gesture travel through pickup/tracking pauses. A paused Perform session
    // still accepts deliberate ray pinches (including its off toggle and the recalled menu).
    if (this.deviceState?.performingLive || this.projectView?.running) for (const cursor of this.cursors) cursor.canPoke = false;
    if (this.spatial) {
      // xr-input owns UI pointing. The legacy cursors only drive the box-aim reticles, and never over UI.
      this.syncHitMeshes();
      const holdBy = (hand: string) => [...this.holds.values()].some((hold) => hold.hand === hand);
      for (const cursor of this.cursors) {
        const hand = frame.pointer === 'mouse' && cursor.hand === 'right' ? 'mouse' : cursor.hand as 'left' | 'right';
        if (this.spatial.uiOwns(hand) || holdBy(hand)) { cursor.tracked = false; this.events.emit('consumed', { hand: cursor.hand, widget: 'handle' }); }
      }
      this.reticles.update(this.cursors, this.head, frame.dt, this.boxes);
      this.buttonFeedback();
      if (this.notice.visible && this.time > this.noticeUntil) this.notice.visible = false;
      return;
    }
    for (let i = 0; i < this.cursors.length; i++) {
      const cursor = this.cursors[i]!; this.reticleHits[i] = null;
      if (!cursor.tracked) continue;
      const captured = this.captures.get(cursor.id)?.widget;
      const winner = captured && this.interactive(captured, cursor) ? captured : this.resolveTarget(cursor);
      if (winner && this.hit(winner, cursor, true) !== Infinity) {
        this.reticleHits[i] = this.reticlePoints[i]!.copy(this.local).applyMatrix4(winner.group.matrixWorld);
        if (winner.button && cursor.ray) {
          winner.group.getWorldPosition(this.point);
          if (rayTargetWithinAngle(cursor.ray.origin, cursor.ray.dir, this.point) !== Infinity) this.reticleHits[i]!.copy(this.point);
        }
      }
    }
    this.reticles.update(this.cursors, this.head, frame.dt, this.boxes, this.reticleHits);
    for (const widget of this.widgets) widget.group.userData.hovered = false;
    for (const cursor of this.cursors) this.interact(cursor);
    for (const cursor of this.devCursors) this.interact(cursor);
    if (this.deck.updateExitHold(frame.time)) this.events.emit('exit', {});
    this.buttonFeedback();
    if (this.notice.visible && this.time > this.noticeUntil) this.notice.visible = false;
  }
  dispose(): void {
    this.assistant.disposeUi();
    this.projectPanel.disposeSpatial();
    this.root.traverse((o) => { if ('sync' in o && 'dispose' in o) (o as SdfText).dispose(); });
    this.helperPairing.dispose();
    this.boxes.dispose();
    this.checkGeometry.dispose(); this.arrowGeometry.dispose(); this.lockGeometry.dispose();
    this.screenGuideGeometry.dispose(); this.screenGuideMaterial.dispose();
    this.surfaces.dispose();
    this.reticles.dispose();
    this.tether.dispose();
    for (const material of Object.values(this.materials)) material.dispose();
    this.trackGeometry.dispose(); this.root.removeFromParent();
  }
}
