/**
 * The Quest app shell: renderer + XR session + input + camera + pairing + WebSocket + scan + voice +
 * record/replay, wired to the HUD (gen3d-lead's, or the debug one). One instance, exposed as window.__ce.
 *
 * URL parameters:
 *   emulate=1|0        force/forbid the IWER desktop emulator (default: on when immersive-ar is unsupported)
 *   devui=1            IWER DevUI instead of the built-in mouse/keyboard controls
 *   camera=live|photo|sim   camera source (default: live on a headset, photo in the emulator)
 *   photo=<url>        backdrop photo for camera=photo (default test/scan-scene.jpg)
 *   sim=<url>          sim embed for camera=sim (default /sim/?embed=room)
 *   scan=fixture       use recorded photo boxes or projected sim layout (automatic for sim + fixture server)
 *   replay=<url>       a take (session.jsonl or .zip); replayMode=playback|pipeline
 *   record=1           highlight recording instructions (recording requires the Record button)
 *   mic=0              never open the microphone (no AudioContext at all)
 *   hud=v2|v1|debug    compact HUD (default), original HUD, or shell debug HUD
 *   dominant=left      left-handed: the menu follows the RIGHT hand
 *   ws=<url>           WebSocket override
 *   yolo=0|1           live boxes from the on-device YOLOX-nano detector while scanning (default 1)
 *   yoloep=webgpu|wasm force the detector's execution provider (default: WebGPU when available)
 *   track=<category>   initial live-box category: everything|electronics|instruments|lights|remotes
 *   debug=1            in-headset hand tracking, rendering and detector diagnostics
 */
import type { Channel, ControlEvent, Gen3dSpec, HackItem, HudStatus, ModelChip } from '@ce/gen3d';
import type { AgentStepPayload, LibraryDevice, PayloadOf, TargetState } from '@ce/protocol';
import { SetupProgressTracker, type Message } from '@ce/protocol';
import { ObjectCanvas } from './canvas';
import { ProjectControls, headsetCanvasUrl } from './projects';
import { ManualRegionSelector } from '../scan/manual-region';
import type { ScanRegion } from '../scan/region';
import { AmbientLight, DirectionalLight, HemisphereLight, PerspectiveCamera, Quaternion, Scene, SRGBColorSpace, Vector3, WebGLRenderer } from 'three';
import type { Identity } from '../io/identity';
import { isLocalPage } from '../io/identity';
import {
  type ArmRequestPayload,
  evidenceSentence,
  type LinkRequestPayload,
  type LinkResultPayload,
  normalizeDetections,
  type ScanResultPayload,
  type SenseRequestPayload,
  type TargetStatusPayload,
  type UiSpecPayload,
  type VerifyResultPayload,
} from '../io/v1';
import { type Envelope, WsClient } from '../io/ws';
import { Approvals } from '../pair/approvals';
import { homeHint } from '../hud/home';
import { PairingFlow } from '../pair/self';
import { candidateScore } from '../hud/v2/anchor-stability';
import { pairingCode } from '../hud/v2/pair-code';
import { type ReplayMode, ReplayCamera, TakePlayer } from '../replay/player';
import { Recorder } from '../replay/recorder';
import { TakeVideoRecorder } from '../replay/video';
import { loadTake, type Take } from '../replay/take';
import { type AimHit, type AimTarget, aimAt, touching } from '../scan/aim';
import { type CameraSource, CameraError, LiveCamera } from '../scan/camera';
import { FrameCapture } from '../scan/capture';
import { JpegEncoder } from '../scan/encode';
import { fixtureFromSimLayout, loadSamFixture, projectFixture, type SamFixture } from '../scan/fixture';
import { VirtualRoomDepth, XrHitTester } from '../scan/hittest';
import type { DepthProvider } from '../scan/placement';
import { HandheldTracker, type WristPose } from '../scan/handheld';
import { PoseRing } from '../scan/poses';
import { cameraPoseFromHead, questIntrinsics, worldToPixel } from '../scan/projection';
import { Scanner } from '../scan/scanner';
import { SyntheticCamera, VirtualRoom } from '../scan/synthetic';
import { type Target, TargetStore, toHudTarget } from '../scan/targets';
import { CATEGORIES, type Category } from '../scan/yolo/classes';
import { categoryFromControl, CHIPS_SPEC_ID, chipsSpec } from '../scan/yolo/chips';
import { isLiveId, LiveDetector } from '../scan/yolo/live';
import { LiveReadout } from '../scan/yolo/readout';
import { Mic } from '../voice/mic';
import { pairingApi } from '../io/api';
import { PushToTalk } from '../voice/ptt';
import { VoiceAssistant } from '../voice/assistant';
import { mappingSummary } from '../voice/mapping-summary';
import { workspaceContext } from './demo-workspace';
import { PinchTargetHistory } from './precision';
import { ControlSender } from './controls';
import { ModeState } from './modes';
import { HelperOnboarding, type HelperInfo } from './onboarding';
import type { AppMode, HudTarget, ObjectFilter } from '../hud/contract';
import { annotationFadeMs, annotationRange, matchesAnnotationFilter, inAnnotationRange } from '../scan/policy';
import { type Emulator, installEmulator } from './emulator';
import { HandFeedback } from './hand-feedback';
import { GestureSession } from '../gestures/session';
import { GestureFeedback } from '../gestures/feedback';
import { routeLabel } from '../hud/v2/command-state';
import { THEME as HUD_V2_THEME } from '../hud/v2/theme';
import type { Handedness, Hud, ShellFrame } from './hud-contract';
import { type HudKind, loadHud } from './hud-loader';
import { handJointPositions, InputSampler } from './input';
import { createSpatialInput, type SpatialInput } from './spatial-input';
import type { PaletteItem } from '../hud/v2/wrist-palette';
import { labEnabled } from './lab';
import { Page } from './page';
import { frameReferenceSpace, endXr, startXr, xrSupport } from './xr';
import { RoomAnchors } from '../anchors/room';
import { matchSavedDevice } from '../anchors/matching';

export const APP_VERSION = 'quest@0.1.0';
const GAZE_AIM = { marginDeg: 3 };
const HAND_AIM = { marginDeg: 2, minDist: 0.3 };
const HANDS = ['left', 'right'] as const;

const TARGET_STATES: Record<TargetState, { status: HudStatus; sub: string }> = {
  scanned: { status: 'scanned', sub: 'unverified' },
  identifying: { status: 'locked', sub: 'identifying…' },
  identified: { status: 'locked', sub: 'identified' },
  linking: { status: 'linking', sub: 'linking…' },
  'needs-companion': { status: 'linking', sub: 'needs a companion' },
  linked: { status: 'linked', sub: 'linked' },
  researching: { status: 'linked', sub: 'researching…' },
  driving: { status: 'linked', sub: 'writing the driver…' },
  verifying: { status: 'uploading', sub: 'verifying on the device…' },
  verified: { status: 'verified', sub: 'verified' },
  forging: { status: 'verified', sub: 'forging controls…' },
  forged: { status: 'verified', sub: 'controls ready' },
  arming: { status: 'verified', sub: 'awaiting your confirmation' },
  armed: { status: 'controlled', sub: 'armed' },
  controlling: { status: 'controlled', sub: 'under control' },
  failed: { status: 'failed', sub: 'failed' },
};

/** Channel guess for a ping hypothesis before the server has linked anything. */
function guessChannel(label: string): Channel {
  if (/light|lamp|air condition|tv|television|fan|remote/i.test(label)) return 'ir';
  if (/synth|drum|sampler|groovebox|keyboard|midi/i.test(label)) return 'usb';
  if (/phone/i.test(label)) return 'ble';
  if (/screen and keyboard|cardputer/i.test(label)) return 'serial';
  return 'wifi';
}

function channelOf(t: string | undefined): Channel {
  switch (t) {
    case 'midi':
      return 'usb';
    case 'ir':
      return 'ir';
    case 'local':
      return 'wifi';
    case 'sim':
      return 'sim';
    case 'serial':
      return 'serial';
    case 'ble':
      return 'ble';
    default:
      return 'wifi';
  }
}

export class QuestApp {
  readonly params: URLSearchParams;
  readonly page = new Page();
  readonly scene = new Scene();
  readonly desktopCam = new PerspectiveCamera(70, 1, 0.01, 100);
  readonly input = new InputSampler();
  readonly poses = new PoseRing(256);
  readonly encoder = new JpegEncoder(1280, 0.8);
  readonly targets = new TargetStore();
  readonly roomAnchors = new RoomAnchors({
    save: (cardId, placement) => { this.ws.send('library.place', { cardId, placement }, { to: 'server' }); },
    locate: (cardId, position) => this.locateSavedDevice(cardId, position),
  });
  private pendingForget?: { id: string; cardId: string; targetId: string };
  private pendingPlacement?: { target: Target; devices: LibraryDevice[]; index: number };
  readonly modes = new ModeState();
  filter: ObjectFilter = 'everything';
  private readonly observed = new Map<string, { target: HudTarget; at: number }>();
  private readonly visibleTargets = new Set<string>();
  /** Renderer residency survives temporary menu/modal hiding; interaction visibility does not. */
  private mountedTargets = new Set<string>();
  private readonly armedCards = new Set<string>();
  private readonly cancelledCards = new Set<string>();
  private lastAnnotationsAt = 0;
  private readonly deferredSpecs = new Map<string, UiSpecPayload>();
  private readonly controlValues = new Map<string, ControlEvent['value']>();
  private readonly generated = new Map<string, Gen3dSpec>();
  private drawTarget?: (target: HudTarget) => void;
  private eraseTarget?: (id: string) => void;
  private activeSetup?: string;
  private setupProgress?: SetupProgressTracker;
  private canvas?: ObjectCanvas;
  private projects?: ProjectControls;
  private armRequest?: ArmRequestPayload;
  private acceptedArm?: string;
  readonly onboarding: HelperOnboarding;
  private pairingUntil = 0;
  private helperLoading = false;
  private helperPresenceRevision = 0;
  private lastHelperPoll = -Infinity;
  private helperViewKey = '';
  private onboardingViewKey = '';
  private pairCodeRequest: string | null = null;
  private lastPairFrame = 0;
  private pairCapturing = false;
  private readonly gestureSpecs = new Map<string, UiSpecPayload>();
  private retiredUiSpecs = new Set<string>();
  private handMapping?: { targetId: string; session: GestureSession; live: boolean; controllerEngaged: boolean; route: string };
  private gestureFeedback?: GestureFeedback;
  readonly xrHit = new XrHitTester();
  readonly handheld = new HandheldTracker();
  readonly recorder = new Recorder();
  private recordingVideo?: TakeVideoRecorder;
  private recordingFinalizing = false;
  private recordingHasVideo = false;
  private recordingRefSpace?: XRReferenceSpace;
  private readonly onRecordingSpaceReset = () => {
    this.recorder.spaceBoundary('reference-reset');
    // A new XR origin invalidates the heading captured when the clutch engaged.
    this.clearHandControl();
    this.projects?.pauseForNavigation();
  };
  readonly mic = new Mic();
  renderer!: WebGLRenderer;
  hud!: Hud;
  hudKind: HudKind = 'debug';
  camera!: CameraSource;
  capture!: FrameCapture;
  scanner!: Scanner;
  readonly ws: WsClient = new WsClient(WsClient.sameOrigin(), () => this.helloPayload());
  pairing!: PairingFlow;
  approvals!: Approvals;
  ptt!: PushToTalk;
  assistant?: VoiceAssistant;
  controls!: ControlSender;
  emulator?: Emulator;
  /** live boxes (on-device YOLOX-nano): responsiveness only; SAM 3.1 stays the source of truth */
  live?: LiveDetector;
  private readout?: LiveReadout;
  private chipsShown = false;
  room?: VirtualRoom;
  fixture?: SamFixture;
  player?: TakePlayer;
  take?: Take;
  session?: XRSession;
  refSpace?: XRReferenceSpace;
  lastFrame?: ShellFrame;
  identity?: Identity;
  private freshSocketIdentity = false;
  welcome?: PayloadOf<'welcome'>;
  cameraState: 'off' | 'starting' | 'on' | 'error' = 'off';
  cameraNote = '';
  private readonly nonDominant: Handedness;
  private candidate = { id: null as string | null, since: 0, shown: null as string | null };
  lockedId: string | null = null;
  private virtualSelection?: { requestId: string; position: Vector3; timeout: ReturnType<typeof setTimeout> };
  private visualSynthIntent?: { phase: 'pending' | 'unavailable'; message: string; deviceId?: string; attemptedReadyKey: string };
  private visualSynthReadyKey = '';
  private readonly virtualCards = new Set<string>();
  private readonly consumed = { left: false, right: false };
  private readonly specByCard = new Map<string, string>();
  private specRevisions = new Map<string, number>();
  private readonly cardOfSpec = new Map<string, string>();
  /** gen3d spec id → ui.spec id (control events carry the ui.spec id) */
  private readonly uiSpecOfGen3d = new Map<string, string>();
  private readonly links = new Map<string, { channel: Channel; proven: boolean; label?: string }>();
  private readonly chips = new Map<string, ModelChip & { at: number }>();
  private upload?: { hackId: string; label: string; cardId?: string; stepsDone: number; startedAt: number };
  private pingVisible = false;
  private lastStatusAt = 0;
  private lastFrameShownAt = 0;
  private serverMode = '';
  private enteringXr = false;
  private handFeedback!: HandFeedback;
  /** The single UI input owner (xr-input ray/poke/grab + forwarded mouse). */
  spatial?: SpatialInput;
  private readonly frameHooks: ((f: ShellFrame, dtSec: number, timeMs: number, xrFrame?: XRFrame) => void)[] = [];

  constructor(params: URLSearchParams) {
    this.params = params;
    this.onboarding = new HelperOnboarding(params.get('camera') === 'sim');
    this.nonDominant = params.get('dominant') === 'left' ? 'right' : 'left';
  }

  // --- boot ------------------------------------------------------------------------------------

  async init(): Promise<void> {
    this.setupRenderer();
    const support = await xrSupport();
    const emulate = this.params.has('emulate') ? this.params.get('emulate') !== '0' : !support.ar;
    this.page.presentation(emulate);
    if (emulate) {
      this.emulator = await installEmulator({ devui: this.params.get('devui') === '1', canvas: this.renderer.domElement });
      this.input.mouseAsHand = true;
      this.page.log(`desktop emulator: IWER ${this.emulator.device.version} (${this.emulator.device.name}${this.emulator.devui ? ', DevUI' : ''})`, 'ok');
    }
    await this.setupHud();
    this.spatial = createSpatialInput(this.scene, this.desktopCam, this.renderer);
    (this.hud as Hud & { setSpatialInput?: (s: SpatialInput) => void }).setSpatialInput?.(this.spatial);
    await this.setupCamera();
    this.refreshHome();
    if (this.live && this.params.get('debug') === '1') {
      this.readout = new LiveReadout();
      this.scene.add(this.readout);
    }
    this.setupIo();
    this.setupUi();
    this.renderer.setAnimationLoop((t, f) => this.frame(t, f));
    void this.connect();
    const replay = this.params.get('replay');
    if (replay) await this.startReplay(replay, (this.params.get('replayMode') as ReplayMode) ?? 'playback');
    if (this.params.get('record') === '1') this.page.log('To record a take, prepare the camera and press Record take before entering AR.');
    const xrOk = emulate || support.ar;
    this.page.setButton(this.page.enter, emulate ? 'Enter AR (emulated)' : 'Enter AR', false, !xrOk);
    this.page.xrMessage(xrOk ? (emulate ? 'IWER emulates a Quest 3 in this browser. Click = pinch, right-drag = look.' : 'Camera and microphone are requested when you enter.') : 'This browser has no immersive-ar. Use Quest Browser, or open with ?emulate=1.');
  }

  private setupRenderer(): void {
    const r = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(2, window.devicePixelRatio));
    r.setClearColor(0x000000, 0);
    r.outputColorSpace = SRGBColorSpace;
    r.localClippingEnabled = true;
    r.xr.enabled = true;
    // three.js emits this synchronously before its first XR animation callback.
    r.xr.addEventListener('sessionstart', () => {
      const session = r.xr.getSession();
      if (session) this.input.attach(session);
    });
    try {
      r.xr.setFoveation(1);
    } catch {
      // not available before a session on some runtimes
    }
    this.renderer = r;
    this.handFeedback = new HandFeedback(this.params.get('debug') === '1');
    this.scene.add(this.handFeedback.root);
    this.gestureFeedback = new GestureFeedback(this.scene);
    this.page.stage.appendChild(r.domElement);
    const resize = () => {
      const w = this.page.stage.clientWidth || window.innerWidth;
      const h = this.page.stage.clientHeight || window.innerHeight;
      if (!r.xr.isPresenting) r.setSize(w, h, false);
      this.desktopCam.aspect = w / Math.max(1, h);
      this.desktopCam.updateProjectionMatrix();
    };
    window.addEventListener('resize', resize);
    resize();
    this.desktopCam.position.set(0, 1.6, 0);
    this.scene.add(new HemisphereLight(0xdfefff, 0x202830, 1.2), new AmbientLight(0xffffff, 0.3));
    const sun = new DirectionalLight(0xffffff, 1.2);
    sun.position.set(1, 3, 2);
    this.scene.add(sun);
    const el = r.domElement;
    const setPointer = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      this.input.pointer.ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    };
    el.addEventListener('pointermove', (e) => {
      setPointer(e);
      this.input.pointer.inside = true;
    });
    el.addEventListener('pointerenter', () => (this.input.pointer.inside = true));
    el.addEventListener('pointerleave', () => {
      this.input.pointer.inside = false;
      this.input.pointer.down = false;
    });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.altKey) return;
      setPointer(e);
      this.input.pointer.down = true;
      this.input.pointer.latched = true;
      this.input.pointer.inside = true;
    });
    window.addEventListener('pointerup', () => (this.input.pointer.down = false));
  }

  private async useSimFixture(): Promise<void> {
    const room = this.room;
    if (!room || room.source.kind !== 'sim') return;
    try {
      await room.ready;
      if (this.params.get('scan') !== 'fixture' && this.serverMode !== 'fixture') return;
      const layout = room.sim?.layout;
      if (!layout?.devices.length) {
        this.page.log('scan fixture: the sim embed exposes no layout', 'warn');
        return;
      }
      this.fixture = fixtureFromSimLayout(layout);
      this.page.log(`scan fixture: ${layout.devices.length} exact boxes from the sim layout (labelled sim-layout, not a model)`, 'warn');
    } catch (error) {
      this.page.log(`scan fixture unavailable: ${(error as Error).message}`, 'warn');
    }
  }

  private async setupCamera(): Promise<void> {
    const want = this.params.get('camera') ?? (this.emulator ? 'photo' : 'live');
    const headPose = () => (this.lastFrame ? { position: this.lastFrame.head.position, quaternion: this.lastFrame.head.quaternion } : null);
    if (want === 'photo' || want === 'sim') {
      const src = want === 'sim' ? { kind: 'sim' as const, url: this.params.get('sim') ?? '/sim/?embed=room' } : { kind: 'photo' as const, url: this.params.get('photo') ?? `${import.meta.env.BASE_URL}test/scan-scene.jpg` };
      if (src.kind === 'sim' && this.params.get('mute') === '1') {
        const url = new URL(src.url, location.href);
        url.searchParams.set('mute', '1');
        src.url = url.href;
      }
      this.room = new VirtualRoom(src);
      this.room.ready
        .then(() => this.page.log(`virtual room: ${this.room!.label} (${this.room!.widthM.toFixed(2)} × ${this.room!.heightM.toFixed(2)} m)`, 'ok'))
        .catch((e) => this.page.log(`virtual room failed: ${(e as Error).message}`, 'error'));
      if (this.emulator) this.scene.add(this.room.backdropGroup);
      this.camera = new SyntheticCamera(this.room, headPose);
      if (this.params.get('scan') === 'fixture' && src.kind === 'sim') {
        void this.useSimFixture();
      }
      if (this.params.get('scan') === 'fixture' && src.kind === 'photo') {
        this.fixture = await loadSamFixture(`${import.meta.env.BASE_URL}test/scan-scene.sam.json`).catch((e) => {
          this.page.log(`scan fixture: ${(e as Error).message}`, 'error');
          return undefined;
        });
        if (this.fixture) this.page.log(`scan fixture: ${this.fixture.detections.length} recorded ${this.fixture.modelId} boxes (labelled FIXTURE)`, 'warn');
      }
    } else {
      this.camera = new LiveCamera({ eye: 'left' });
    }
    this.capture = new FrameCapture({ camera: this.camera, poses: this.poses, encoder: this.encoder, handJoints: () => handJointPositions(this.lastFrame) });
    this.scanner = new Scanner({
      capture: () => this.capture,
      ws: this.ws,
      hud: () => this.hud,
      targets: this.targets,
      poses: this.poses,
      depth: () => this.depthProviders(),
      headPosition: () => this.lastFrame?.head.position ?? this.desktopCam.position,
      log: (m, l) => this.page.log(m, l),
      fixture: () => (this.fixture && this.room ? { fix: this.fixture, room: this.room } : null),
      local: (dir, type, payload) => this.recorder.message(dir, { v: 1, type, id: `local-${type}-${Date.now()}`, ts: Date.now(), from: dir === 'in' ? 'fixture' : '', payload }),
    });
    this.scanner.rangeM = annotationRange(this.params.get('range'));
    this.scanner.setCategory(this.filter);
    this.scanner.on('frame', (fr) => this.rememberJpeg(fr.frameId, fr.jpeg));
    this.scanner.on('result', (r) => {
      const rec = this.capture.get(r.frameId);
      this.lastShown = { frameId: r.frameId, dets: r.dets };
      this.reassociateDetections(r.placed);
      if (this.manualScanPending) {
        this.manualScanPending = false; this.manualFocusIds = new Set(r.placed.map(t => t.id));
        this.hud.toast(r.placed.length ? 'Area identified. Point and pinch an outline to tag it.' : 'No object found in that area. Choose Identify here to retry.', r.placed.length ? 'info' : 'warn');
      }
      // a remote in the user's hand follows the wrist from now on (LEARN flow)
      const wrists = this.wrists();
      for (const t of r.placed) {
        const s = this.handheld.observe(t.id, t.label, t.position, wrists, performance.now());
        if (s !== 'none') this.page.log(`${t.label} ${s === 'attached' ? 'is in your hand: following it' : 'put down'}`);
      }
      if (r.rejected.length) this.page.log(`dropped ${r.rejected.length}: ${r.rejected.map((x) => `${x.det.label} (${x.reason})`).join(', ')}`, 'warn');
      this.page.log(`scan.result ${r.frameId.slice(-6)}: ${r.placed.length} device(s) · ${this.scanner.stats.lastModelId} ${this.scanner.stats.lastLatencyMs} ms${this.scanner.stats.lastSource === 'fixture' ? ' · FIXTURE' : ''}`);
      if (rec && this.scanner.stats.lastModelId) this.chip(this.scanner.stats.lastModelId, 'done');
      if (this.pingVisible) this.refreshPing();
    });
    this.scanner.on('state', ({ on }) => {
      this.page.setButton(this.page.scan, on ? 'Stop scan' : 'Scan', on);
      this.hud.setDeck({ scanning: on });
      this.recorder.input('scan', { on });
    });
    this.setupLive();
  }

  private readonly liveHands: Vector3[] = [];

  private setupLive(): void {
    if (this.params.get('yolo') === '0') {
      this.page.log('live boxes off (?yolo=0): SAM 3.1 scan only');
      return;
    }
    const ep = this.params.get('yoloep');
    const live = new LiveDetector({
      camera: () => this.camera,
      poses: this.poses,
      hud: () => this.hud,
      samTargets: () => this.targets.list(),
      depth: () => this.depthProviders(),
      headPosition: () => this.lastFrame?.head.position ?? this.desktopCam.position,
      handJoints: () => handJointPositions(this.lastFrame, this.liveHands),
      log: (m, l) => this.page.log(m, l),
      modelUrl: `${import.meta.env.BASE_URL}models/yolox_nano.onnx`,
      ep: ep === 'wasm' || ep === 'webgpu' ? ep : 'auto',
      onPickClaimed: (id) => {
        if (isLiveId(this.lockedId)) this.lock(id, 'live box');
      },
    });
    const track = this.params.get('track');
    if (track === 'electronics' || track === 'lights' || track === 'everything') this.filter = track;
    live.category = this.filter;
    live.rangeM = annotationRange(this.params.get('range'));
    this.scanner.setCategory(this.filter);
    this.live = live;
    this.scanner.on('state', ({ on }) => {
      if (on && this.modes.mode === 'annotate' && !this.manualScanPending && !this.manualRegion?.active) {
        live.start();
        this.showChips();
      } else {
        live.stop();
        this.hideChips();
      }
    });
    // The SAM target takes over the selected live box as soon as it covers the same object.
    this.scanner.on('result', () => live.onSamTargets());
    // load the model while the user is still on the 2D page, so the first scan has boxes at once
    setTimeout(() => void live.load().catch(() => undefined), 1500);
  }

  private showChips(): void {
    if (!this.live || this.hudKind === 'v2') return;
    const note = this.live.category === 'lights' ? 'lights: SAM scan only' : undefined;
    this.hud.renderSpec(chipsSpec(this.live.category, note), {});
    this.chipsShown = true;
  }

  private hideChips(): void {
    if (!this.chipsShown) return;
    this.hud.removeSpec(CHIPS_SPEC_ID);
    this.chipsShown = false;
  }

  setLiveCategory(c: Category): void {
    if (this.modes.mode !== 'annotate') return;
    this.filter = c === 'lights' || c === 'everything' ? c : 'electronics';
    this.live?.setCategory(this.filter);
    this.scanner.setCategory(this.filter);
    this.refreshAnnotations();
    this.refreshHome();
    this.recorder.input('track', { category: this.filter });
  }

  /** `y` key: live boxes on/off for this scan session. */
  toggleLive(): void {
    const l = this.live;
    if (!l) return;
    if (l.running) {
      if (isLiveId(this.lockedId)) this.release();
      l.stop();
      this.hideChips();
      this.page.log('live boxes paused');
    } else if (this.scanner.active) {
      l.start();
      this.showChips();
      this.page.log('live boxes on');
    } else this.page.log('live boxes start with the next scan (s)');
  }

  private depthProviders(): DepthProvider[] {
    const list: DepthProvider[] = [];
    if (this.session && this.xrHit.supported && !this.emulator) list.push(this.xrHit);
    if (this.room && this.emulator) list.push(new VirtualRoomDepth(this.room));
    return list;
  }

  private async setupHud(): Promise<void> {
    const { hud, kind, error } = await loadHud({ scene: this.scene, camera: this.desktopCam, renderer: this.renderer, nonDominant: this.nonDominant }, this.params.get('hud'));
    this.hud = hud;
    this.hudKind = kind;
    this.drawTarget = hud.upsertTarget.bind(hud);
    this.eraseTarget = hud.removeTarget.bind(hud);
    hud.upsertTarget = (target) => this.observeTarget(target);
    hud.removeTarget = (id) => {
      this.observed.delete(id);
      if (!this.modes.tags.has(id)) this.eraseAnnotation(id);
    };
    this.refreshHome();
    if (kind === 'v2') this.handFeedback.setAppearance({ accent: HUD_V2_THEME.color.accent, showHover: true });
    this.scene.add(hud.root);
    if (error) this.page.log(error, 'warn');
    this.page.log(`HUD: ${kind === 'v2' ? 'compact v2' : kind === 'gen3d' ? 'original renderer (v1)' : 'shell debug HUD'}`);
    hud.on('consumed', (e) => {
      // the desktop mouse is the right hand (gen3d reports its dev cursor as 'mouse')
      const hand = e.hand === 'mouse' ? 'right' : e.hand;
      if (hand === 'left' || hand === 'right') this.consumed[hand as Handedness] = true;
    });
    // desktop: gen3d's widgets take a mouse "dev cursor" that raycasts the HUD's own objects (as in its gallery)
    const devHud = hud as Hud & { setDevCursors?: (c: unknown[]) => void };
    if (this.emulator && kind === 'gen3d' && typeof devHud.setDevCursors === 'function') {
      try {
        const g = (await import('../gen3d/index')) as unknown as { MouseCursor?: new (el: HTMLElement, cam: PerspectiveCamera) => { cursor: unknown; setTargets(o: unknown[]): void; update(): unknown } };
        if (g.MouseCursor) {
          this.mouseCursor = new g.MouseCursor(this.renderer.domElement, this.desktopCam);
          // three.js raycasts lines and points with a 1 m threshold by default: any nearby rail would steal the cursor
          const rc = (this.mouseCursor as unknown as { raycaster?: { params: { Line?: { threshold: number }; Points?: { threshold: number } } } }).raycaster;
          if (rc?.params.Line) rc.params.Line.threshold = 0.004;
          if (rc?.params.Points) rc.params.Points.threshold = 0.004;
          this.mouseCursor.setTargets([hud.root]);
          devHud.setDevCursors([this.mouseCursor.cursor]);
          this.page.log('desktop: the mouse drives gen3d widgets (dev cursor)');
        }
      } catch (e) {
        this.page.log(`gen3d dev cursor unavailable: ${(e as Error).message}`, 'warn');
      }
    }
    hud.on('exit', () => { void endXr(this.renderer).catch(() => this.hud.toast('Could not exit AR. Hold Exit to try again.', 'warn')); });
    hud.on('selectTarget', (e) => this.lock(e.targetId, 'chip'));
    hud.on('mode', (e) => this.setMode(e.mode));
    hud.on('filter', (e) => this.setLiveCategory(e.filter));
    hud.on('tagRemove', (e) => this.untag(e.targetId));
    hud.on('forget', (e) => this.requestForget(e.targetId));
    hud.on('setup', (e) => this.setupControl(e.targetId));
    hud.on('cancel', (e) => this.cancelControl(e.targetId));
    hud.on('pair', (e) => this.pairDevice(e.targetId));
    hud.on('pairCancel', () => { this.pairingUntil = 0; this.pairCodeRequest = null; this.refreshHome(); });
    hud.on('helperSkip', () => this.skipHelper());
    hud.on('helperPair', () => this.openHelper());
    hud.on('visualSynth', () => this.selectVisualSynth());
    hud.on('identifyArea', () => { void this.beginManualRegion(); });
    hud.on('menuOpened', () => { this.cancelManualRegion(); });
    hud.on('askMuseGeneral', () => { this.cancelManualRegion(); this.clearHandControl(); this.projects?.close(); this.canvas?.close(); this.scanner.stop(); this.live?.stop(); void this.assistant?.toggleGeneral(); });
    hud.on('projectsOpen', () => this.openProjects());
    hud.on('projectsCommand', ({ command, actionId }) => this.projects?.command(command, actionId));
    hud.on('projectsPause', () => this.projects?.pauseForNavigation());
    hud.on('changeDevice', () => { this.release(); this.hud.toast('Point at a device and pinch to select it.', 'info'); });
    hud.on('inspectObject', (e) => this.askSelectedObject(e.targetId, 'Inspect this object: description, dimensions, weight and current price, with sources.'));
    hud.on('gestureSetup', (e) => this.askSelectedObject(e.targetId, 'Propose a simple hand gesture mapping for this selected device. Use right hand height for a continuous parameter and left fist as the Perform clutch.'));
    hud.on('canvasCreate', (e) => { this.canvasController()?.openOrCreate(e.targetId); this.refreshHome(); });
    hud.on('canvasAction', ({ targetId, ...action }) => this.canvasController()?.action(targetId, action));
    hud.on('canvasRestore', (e) => this.canvasController()?.restore(e.targetId, e.revision, e.baseRevision));
    hud.on('canvasClose', (e) => { this.canvas?.close(e.targetId); this.refreshHome(); });
    hud.on('pairCode', (e) => this.submitPairCode(e.targetId, e.code));
    hud.on('handControl', (e) => this.setHandControl(e.targetId, e.enabled));
    hud.on('assistantTalk', (e) => { this.clearHandControl(); void this.assistant?.toggle(e.targetId); });
    hud.on('assistantConfirm', (e) => this.assistant?.confirm(e.targetId, e.proposalId, e.accept));
    hud.on('assistantDismiss', () => this.assistant?.cancel());
    hud.on('deck', (e) => this.onDeck(e.key, e.phase));
    hud.on('hack', (e) => this.onHack(e));
    hud.on('control', (e) => this.onControl(e));
    hud.on('approve', (e) => (e.approve ? this.approvals.approve(e.pairingId) : this.approvals.deny(e.pairingId)));
    hud.on('confirm', (e) => this.answerConfirm(e.id, e.approve, e.hold));
    hud.on('grab', (e) => this.recorder.input('grab', e as unknown as Record<string, unknown>));
  }

  private openProjects(projectId?: string): void {
      this.cancelManualRegion();
      const active = this.activeSetup ? this.modes.byCard(this.activeSetup) : undefined;
      if (active) this.cancelControl(active.targetId);
      this.release(); this.canvas?.close(); this.controls.clear();
      (this.projects ??= new ProjectControls({
        send: (type, payload) => !!this.ws.send(type, payload as never, { to: 'server', droppable: type === 'project.action' }),
        render: (view) => this.hud.setProjects?.(view), connected: () => this.ws.open,
        immersive: () => !!this.session && this.session.visibilityState !== 'hidden',
        openPage: (id) => { void this.openCanvasPage(id); },
      })).show(projectId);
  }

  private openingCanvas = false;
  private async openCanvasPage(projectId?: string): Promise<void> {
    if (this.openingCanvas) return;
    this.openingCanvas = true;
    this.cancelManualRegion(); this.clearHandControl(); this.controls.clear();
    this.assistant?.cancel(); this.projects?.pauseForNavigation(); this.scanner.stop(); this.live?.stop();
    this.ws.send('panic', { reason: 'Opening the headset webpage' }, { to: 'server' });
    try {
      if (this.session) await this.session.end();
      location.assign(headsetCanvasUrl(projectId));
    } catch { this.openingCanvas = false; this.hud.toast('Could not leave AR. Exit AR and open Muse Canvas from the entry page.', 'warn'); }
  }

  private setupIo(): void {
    const name = this.emulator ? 'Quest (desktop emulator)' : /Quest 3S/i.test(navigator.userAgent) ? 'Quest 3S' : 'Quest 3';
    const savedAllowed = WsClient.allowsSavedToken(this.ws.url);
    const foreignIdentity = new Map<string, string>();
    const destination = new URL(this.ws.url);
    destination.protocol = destination.protocol === 'wss:' ? 'https:' : 'http:';
    this.pairing = new PairingFlow({ name, capabilities: ['camera', 'mic', 'hands', 'display'], ...(!savedAllowed ? {
      api: pairingApi(destination.origin),
      store: { getItem: (key: string) => foreignIdentity.get(key) ?? null,
        setItem: (key: string, value: string) => { foreignIdentity.set(key, value); },
        removeItem: (key: string) => { foreignIdentity.delete(key); } },
    } : {}) });
    if (!savedAllowed) this.page.log('The socket destination differs from this page; pairing fresh without sending the saved device token.', 'warn');
    this.controls = new ControlSender((p) => {
      if (!p.specId) return;
      const sent = this.canControl(this.cardOfSpec.get(p.specId)) && this.ws.send('control.event', p);
      if (!sent) this.hud.setCommandResult?.(this.gen3dIdFor(p.specId), p.widgetId, p.ts, false);
    }, 30);
    this.approvals = new Approvals(this.ws);
    this.ptt = new PushToTalk(this.mic, this.ws, () => WsClient.allowsSavedToken(this.ws.url) ? this.identity?.deviceToken : undefined, () => {
      const cardId = this.lockedId ? this.modes.tags.get(this.lockedId)?.cardId : undefined;
      return { cardId, specId: cardId ? this.specByCard.get(cardId) : undefined };
    });
    this.assistant = new VoiceAssistant({
      ptt: this.ptt,
      selected: () => {
        const tag = this.lockedId ? this.modes.tags.get(this.lockedId) : undefined;
        return this.modes.mode === 'control' && tag?.cardId && this.targets.get(tag.targetId) ? {
          targetId: tag.targetId, cardId: tag.cardId, specId: this.specByCard.get(tag.cardId),
          specRevision: this.specRevisions?.get(tag.cardId), identityRevision: tag.identityRevision ?? 0,
        } : undefined;
      },
      selectTarget: (cardId) => {
        const tag = this.modes.byCard(cardId);
        if (!tag) return;
        this.setMode('control');
        if (!this.targets.get(tag.targetId)) {
          const head = this.lastFrame?.head ?? this.desktopCam;
          const position = new Vector3(0, -0.05, -0.85).applyQuaternion(head.quaternion).add(head.position);
          const target = this.targets.upsert({ detId: '', cardId, label: tag.name ?? tag.label, score: 1, box: [0, 0, 1, 1] },
            { position, facing: head.position.clone().sub(position).normalize(), confirmed: false, method: 'connected-instrument', depth: 0.85, sizeM: [0.2, 0.1, 0.05] }, '').target;
          this.targets.reattach(tag.targetId, target, cardId);
        }
        this.lock(tag.targetId, 'confirmed instrument');
        return { targetId: tag.targetId, cardId, specId: this.specByCard.get(cardId),
          specRevision: this.specRevisions?.get(cardId), identityRevision: tag.identityRevision ?? 0 };
      },
      workspaceContext: (target) => workspaceContext({
        scope: target.targetId === 'muse-general' ? 'general' : 'device', targetId: target.targetId,
        presentation: this.hud.presentationSnapshot?.(), assistant: this.assistant?.view,
        setupWorking: this.activeSetup === target.cardId || this.setupProgress?.get(target.cardId)?.working,
        controlsReady: this.armedCards.has(target.cardId) && this.gestureSpecs.has(target.cardId), mappingOutcome: this.assistant?.mappingOutcome(target.cardId),
        performance: this.handMapping?.targetId === target.targetId ? {
          enabled: true, live: this.handMapping.live, trackingLost: this.handMapping.session.engine.state.trackingLost,
        } : undefined,
      }),
      identity: () => this.identity?.deviceId,
      microphoneError: () => !this.ws.open ? 'The server is disconnected. Reconnect and try again.'
        : this.params.get('mic') === '0' ? 'Microphone is disabled for this session. Enable it on the entry page before entering AR.'
        : this.session && !this.mic.ready ? 'Exit AR, choose Camera + mic and allow microphone access, then enter AR again.' : undefined,
      send: (type, payload) => !!this.ws.send(type, payload, { to: 'server' }),
      setup: (targetId) => {
        if (this.activeSetup && this.activeSetup === this.modes.tags.get(targetId)?.cardId) return true;
        if (!this.modes.canSetup(targetId)) return false;
        this.setupControl(targetId);
        return this.activeSetup === this.modes.tags.get(targetId)?.cardId;
      },
      render: (view) => { this.hud.setAssistant?.(view); this.refreshHome(); },
      requestStarted: (target, utteranceId) => { if (this.modes.tags.has(target.targetId)) this.canvasController()?.allowVoice(target.targetId, utteranceId); },
      requestCancelled: (utteranceId) => this.canvas?.cancelVoice(utteranceId),
    });
    this.ws.tap('out', (m) => this.recorder.message('out', m));
    this.ws.tap('in', (m) => this.recorder.message('in', m));
    this.ws.onState = (s, info) => {
      this.page.badge('b-ws', s, s === 'open' ? 'ok' : s === 'connecting' ? 'warn' : 'bad');
      if (s === 'closed') {
        this.cancelManualRegion();
        this.projects?.disconnect();
        this.canvas?.disconnect();
        this.setupProgress?.disconnect();
        this.disconnectVisualSynthSelection();
        this.assistant?.cancel();
        const active = this.activeSetup ? this.modes.byCard(this.activeSetup) : undefined;
        if (active) this.cancelControl(active.targetId);
        this.controls.clear(); this.clearHandControl(); this.modes.disconnected(); this.refreshHome(); this.refreshTags();
      }
      if (s === 'closed' && info) this.page.log(`socket closed (${info.code}${info.reason ? ` ${info.reason}` : ''}); reconnecting`, 'warn');
    };
    this.ws.onUnauthorized = () => {
      this.page.log('the server revoked this headset; pairing again', 'warn');
      void this.repairPairing();
    };
    this.ws.onInvalid = (err) => this.page.log(`invalid message from server: ${err}`, 'warn');
    this.pairing.on('state', (s) => {
      if (s.kind === 'pending') {
        const p = { display: s.display, qr: s.qr, message: 'Approve on the Mac companion or type y in the server terminal.' };
        this.page.showPairing(p);
        this.hud.showPairing(p);
        this.page.log(`pairing: waiting for approval · code ${s.display}`, 'warn');
      } else {
        this.page.showPairing(null);
        this.hud.showPairing(null);
      }
      if (s.kind === 'offline') this.page.log(s.message, 'warn');
      if (s.kind === 'denied') this.page.log(s.message, 'error');
      if (s.kind === 'paired') this.freshSocketIdentity = !savedAllowed;
      if (s.kind === 'paired') this.page.log(`paired as ${s.identity.name} (${s.identity.deviceId.slice(0, 8)}…)${s.verified ? '' : ' · not verified (server offline)'}`, 'ok');
    });
    this.approvals.on('change', (list) => {
      const tag = this.lockedId ? this.modes.tags.get(this.lockedId) : undefined;
      const connectingMac = this.modes.mode === 'control' && tag?.connection === 'offline' && tag.action === 'open-companion';
      const onboardingActive = this.onboarding.visible || !!this.onboarding.guide(this.modes.tags.size);
      this.hud.showApprovals(onboardingActive || this.pairingUntil || connectingMac ? [] : list);
      this.page.showApprovals(list, (id, ok) => (ok ? this.approvals.approve(id) : this.approvals.deny(id)));
      if (list.length && !onboardingActive && !this.pairingUntil && !connectingMac) this.hud.toast(`${list[0].name} wants to join · ${list[0].display}`, 'info');
    });
    this.approvals.on('resolved', (r) => this.page.log(`pairing ${r.approved ? 'approved' : 'denied'}${r.name ? `: ${r.name}` : ''}`, r.approved ? 'ok' : 'warn'));
    this.ptt.on('listening', ({ listening }) => {
      if (listening) this.chip('muse-voice-transcribe-1.0', 'live');
    });
    this.ptt.on('text', (t) => {
      if (t.recipientId && t.recipientId !== this.identity?.deviceId) return;
      if (t.final) {
        this.chip(t.modelId ?? 'muse-voice-transcribe-1.0', 'done');
        this.page.log(`voice${t.via === 'http' ? ' (http fallback)' : ''}: “${t.text}”${t.modelId ? ` · ${t.modelId}` : ''}`, 'ok');
      }
    });
    this.ptt.on('error', (e) => {
      this.page.log(e, 'warn');
    });
    this.wireMessages();
  }

  setMode(mode: AppMode, send = true): void {
    this.cancelManualRegion();
    if (mode !== 'annotate' && mode !== 'control') return;
    this.projects?.close();
    if (send && mode === 'control') this.onboarding?.chooseControl();
    if (mode !== this.modes.mode) {
      if (this.activeSetup) {
        const tag = this.modes.byCard(this.activeSetup);
        if (tag) this.cancelControl(tag.targetId);
      }
      this.controls?.clear();
      this.release();
      this.hud.hideHackMenu();
      this.hud.showConfirm(null);
      this.pendingPlacement = undefined; this.pendingForget = undefined;
    }
    this.modes.mode = mode;
    if (send) {
      this.ws.send('mode.set', { mode }, { to: 'server' });
    }
    if (mode === 'annotate') {
      if (this.cameraState !== 'on') void this.startCamera();
      this.scanner.start();
    } else {
      this.scanner.stop();
      this.live?.stop();
    }
    this.refreshAnnotations(true);
    this.refreshHome();
  }

  private refreshHome(): void {
    this.refreshOnboarding();
    this.hud.setHome?.({ mode: this.modes.mode, filter: this.filter, tagged: this.modes.tags.size,
      status: this.locationHint() ?? homeHint(this.modes.mode, this.modes.tags.size, !!this.lockedId),
      canStop: !!this.activeSetup || this.armedCards.size > 0, visualSynthSelection: this.visualSynthIntent });
    const tag = this.lockedId ? this.modes.tags.get(this.lockedId) : undefined;
    this.hud.setDeviceState?.(tag ? { targetId: tag.targetId, connection: tag.connection, hint: tag.hint, action: tag.action,
      screenGuide: !!tag.cardId && !!this.virtualCards?.has(tag.cardId) && tag.connection !== 'ready',
      silentVisual: !!tag.cardId && !!this.virtualCards?.has(tag.cardId),
      pairingSeconds: this.pairingUntil ? Math.max(1, Math.ceil((this.pairingUntil - performance.now()) / 1000)) : undefined,
      busy: tag.busy, sentence: tag.sentence, canvasReady: !!tag.cardId && this.canvas?.hasDocument(tag.cardId), handControl: this.handMapping?.targetId === tag.targetId,
      performAvailable: !!tag.cardId && this.gestureSpecs.has(tag.cardId),
      mappingSummary: tag.cardId ? mappingSummary(this.gestureSpecs.get(tag.cardId)) : undefined,
      mappingActionId: tag.cardId ? this.gestureSpecs.get(tag.cardId)?.gestureMap?.axes[0]?.actionId : undefined,
      mappingOutcome: tag.cardId ? this.assistant?.mappingOutcome?.(tag.cardId) : undefined,
      performingLive: this.handMapping?.live ?? false, performanceRoute: this.handMapping?.route } : null);
    this.refreshSetupProgress();
    this.canvasController()?.syncSelection();
  }

  private canvasController(): ObjectCanvas | undefined {
    if (!this.hud.setCanvas) return;
    return this.canvas ??= new ObjectCanvas({
      selected: () => {
        const tag = this.ws.open && this.lockedId && this.modes.mode === 'control' ? this.modes.tags.get(this.lockedId) : undefined;
        return tag?.cardId ? { targetId: tag.targetId, cardId: tag.cardId, busy: tag.busy } : undefined;
      },
      send: (type, payload) => !!this.ws.send(type, payload, { to: 'server' }),
      render: (view) => this.hud.setCanvas?.(view),
      pauseControls: () => { this.clearHandControl(); this.controls.clear(); },
    });
  }

  private onCanvasState(message: Envelope): void {
    if (message.from !== 'server') return;
    this.canvasController()?.receive(message.payload as PayloadOf<'canvas.state'>);
    this.refreshHome();
  }

  private refreshSetupProgress(): void {
    const tag = this.lockedId ? this.modes.tags.get(this.lockedId) : undefined;
    const view = this.modes.mode === 'control' && tag?.cardId && !this.cancelledCards.has(tag.cardId)
      && !this.handMapping && !this.canvas?.open ? this.setupProgress?.get(tag.cardId) : undefined;
    this.hud.setSetupProgress?.(view ?? null);
  }

  private onSetupProgress(message: Envelope): void {
    if (message.from !== 'server' || !['target.status', 'agent.step', 'link.result', 'driver.spec', 'driver.status',
      'verify.result', 'ui.partial', 'ui.spec', 'arm.request', 'arm.result'].includes(message.type)) return;
    const cardId = (message.payload as { cardId?: string }).cardId;
    if (!cardId || !this.modes.byCard(cardId) || this.cancelledCards.has(cardId)) return;
    (this.setupProgress ??= new SetupProgressTracker()).update(message as Message);
    this.refreshSetupProgress();
  }

  private observeTarget(target: HudTarget): void {
    if (/\b(person|people|human)\b/i.test(target.rawLabel ?? target.label)) return;
    const tag = this.modes.tags.get(target.id);
    if (tag) {
      tag.position = { x: target.position[0], y: target.position[1], z: target.position[2] };
      target = { ...target, label: tag.name || tag.label, tagged: true, connection: tag.connection, identifying: !tag.name?.trim(), busy: tag.busy };
    }
    // Annotate shows only screens/keyboards/phones (and lane-allowed classes); everything else stays undrawn.
    if (!this.annotationAllowed(target)) return;
    const tracked = this.targets.get(target.id);
    // Repainting a saved label is not another camera observation.
    this.observed.set(target.id, { target, at: tracked?.lastSeenAt ?? Date.now() });
    this.refreshAnnotations(true);
  }

  /** One budget shared by both detectors. Measured tagged anchors survive detection expiry. */
  private readonly annotationForward = new Vector3();
  private manualRegion?: ManualRegionSelector;
  private manualScanPending = false;
  private manualFocusIds?: Set<string>;
  private manualRequest = 0;

  private cancelManualRegion(): void {
    this.manualRequest = (this.manualRequest ?? 0) + 1;
    if (this.manualScanPending) this.scanner?.stop();
    this.manualScanPending = false; this.manualRegion?.cancel(); this.manualFocusIds = undefined;
  }

  private async beginManualRegion(): Promise<void> {
    this.clearHandControl(); this.projects?.close(); this.canvas?.close(); this.assistant?.cancel();
    this.setMode('annotate'); this.release(); this.scanner.stop(); this.live?.stop();
    this.onboarding?.leave();
    this.hud.setOnboarding?.(null);
    this.hud.setDeck({ open: false }); this.manualFocusIds = new Set();
    const request = this.manualRequest;
    if (this.cameraState !== 'on') await this.startCamera();
    if (request !== this.manualRequest || !this.session && !this.emulator) return;
    if (this.cameraState !== 'on') { this.hud.toast('Allow camera access on the entry page before identifying an area.', 'warn'); return; }
    if (!this.manualRegion) { this.manualRegion = new ManualRegionSelector(); this.scene.add(this.manualRegion.root); }
    this.manualRegion.begin(); this.refreshAnnotations(true);
    this.hud.toast('Point with your hand. Pinch two opposite corners around the object.', 'info');
  }

  private async scanManualRegion(region: ScanRegion): Promise<void> {
    const request = this.manualRequest;
    this.manualScanPending = true; this.manualFocusIds = new Set();
    this.hud.toast('Identifying only the selected area…', 'info');
    this.scanner.setCategory('everything');
    try {
      const sent = await this.scanner.scanRegion(region, performance.now());
      if (request !== this.manualRequest) return;
      if (!sent) { this.manualScanPending = false; this.hud.toast('Could not capture that area. Choose Identify here to retry.', 'warn'); }
      else setTimeout(() => {
        if (request === this.manualRequest && this.manualScanPending) {
          this.scanner.stop(); this.manualScanPending = false;
          this.hud.toast('No result received. Choose Identify here to retry.', 'warn');
        }
      }, this.scanner.timeoutMs + 500);
    } catch {
      if (request !== this.manualRequest) return;
      this.scanner.stop(); this.manualScanPending = false;
      this.hud.toast('Could not identify that area. Choose Identify here to retry.', 'warn');
    } finally { if (request === this.manualRequest) this.live?.stop(); }
  }

  private eraseAnnotation(id: string): void {
    this.eraseTarget?.(id);
    this.mountedTargets?.delete(id);
    this.visibleTargets.delete(id);
  }

  private clearAnnotations(): void {
    for (const id of this.mountedTargets ?? []) this.eraseAnnotation(id);
    this.observed.clear();
    this.visibleTargets.clear();
  }

  private refreshAnnotations(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastAnnotationsAt < 80) return;
    this.lastAnnotationsAt = now;
    const head = this.lastFrame?.head.position ?? this.desktopCam.position;
    const range = Math.min(3, annotationRange(this.params.get('range')));
    this.annotationForward.set(0, 0, -1).applyQuaternion(this.lastFrame?.head.quaternion ?? this.desktopCam.quaternion);
    const inFront = (target: HudTarget) => {
      const x = target.position[0] - head.x, y = target.position[1] - head.y, z = target.position[2] - head.z;
      return (x * this.annotationForward.x + y * this.annotationForward.y + z * this.annotationForward.z) / Math.max(.001, Math.hypot(x, y, z)) > .35;
    };
    const mounted = this.mountedTargets ??= new Set<string>();
    const show = new Set<string>();
    const draw: HudTarget[] = [];
    for (const [id, tag] of this.modes.tags) {
      if (this.manualRegion?.active || this.manualScanPending || this.modes.mode === 'annotate' && this.manualFocusIds && !this.manualFocusIds.has(id)) continue;
      const observed = this.observed.get(id);
      // Removing the selected target also dismisses its controls. Its panel stays available while looking away.
      const selected = this.modes.mode === 'control' && this.lockedId === id;
      if (!observed || !selected && (!inAnnotationRange(observed.target.position, head, range) || !inFront(observed.target))) continue;
      if (this.modes.mode === 'annotate' && !observed.target.confirmed && now - observed.at > annotationFadeMs(isLiveId(id))) continue;
      show.add(id);
      if (force || !this.visibleTargets.has(id)) draw.push({ ...observed.target, tagged: true, connection: tag.connection,
        label: tag.name || tag.label, identifying: !tag.name?.trim(), busy: tag.busy });
    }
    if (this.modes.mode === 'annotate') {
      const candidates = [...this.observed.values()].filter(({ target, at }) => !this.manualRegion?.active && !this.manualScanPending
        && (!this.manualFocusIds || this.manualFocusIds.has(target.id)) && !this.modes.tags.has(target.id)
        && now - at <= annotationFadeMs(isLiveId(target.id)) && (target.score ?? 0) >= 0.5 && (this.manualFocusIds?.has(target.id) || matchesAnnotationFilter(target.rawLabel ?? target.label, this.filter))
        && inAnnotationRange(target.position, head, range) && inFront(target));
      const rank = (target: HudTarget) => {
        const x = target.position[0] - head.x, y = target.position[1] - head.y, z = target.position[2] - head.z;
        const distance = Math.hypot(x, y, z);
        return candidateScore(distance, (x * this.annotationForward.x + y * this.annotationForward.y + z * this.annotationForward.z) / Math.max(0.001, distance));
      };
      candidates.sort((a, b) => rank(a.target) - rank(b.target));
      for (const { target } of candidates.slice(0, 3)) {
        if (!Number.isFinite(rank(target))) continue;
        show.add(target.id);
        if (force || !this.visibleTargets.has(target.id)) draw.push(target);
      }
    }
    // Menu hides every target from hit testing, but those objects still exist in the renderer.
    // Reconcile residency so a later crop/filter/mode change cannot resurrect hidden stale labels.
    for (const id of mounted) if (!show.has(id)) this.eraseAnnotation(id);
    for (const target of draw) { this.drawTarget?.(target); mounted.add(target.id); }
    this.visibleTargets.clear();
    for (const id of show) if (this.hudKind !== 'v2' || this.hud.isTargetVisible?.(id)) this.visibleTargets.add(id);
    for (const [id, observed] of this.observed) if (now - observed.at > 15_000 && !this.modes.tags.has(id)) {
      this.observed.delete(id); this.targets.remove(id);
    }
  }

  private materializeTarget(snapshot: HudTarget, cardId?: string): Target {
    const target = this.targets.upsert({ detId: '', label: snapshot.rawLabel ?? snapshot.label, cardId, score: snapshot.score ?? 1, box: [0, 0, 1, 1] },
      { position: new Vector3().fromArray(snapshot.position), facing: new Vector3().fromArray(snapshot.facing ?? [0, 0, 1]),
        sizeM: snapshot.sizeM ?? [0.25, 0.2, 0.1], confirmed: snapshot.confirmed, method: 'tracked', depth: 1 }, '', snapshot.modelId).target;
    return target;
  }

  private onTagsState(payload: PayloadOf<'tags.state'>): void {
    for (const remote of payload.tags) {
      const previous = this.modes.byCard(remote.cardId);
      if (previous && (remote.identityRevision ?? 0) > (previous.identityRevision ?? 0)) this.invalidateIdentityControls(remote.cardId, previous.targetId);
    }
    if (this.activeSetup && !payload.tags.some((tag) => tag.cardId === this.activeSetup)) {
      const active = this.modes.byCard(this.activeSetup);
      if (active) this.cancelControl(active.targetId);
    }
    const removed = this.modes.snapshot(payload.tags);
    const pairingTag = this.lockedId ? this.modes.tags.get(this.lockedId) : undefined;
    if (this.pairingUntil && (!pairingTag || pairingTag.connection !== 'offline' || !pairingTag.action)) {
      this.pairingUntil = 0; this.pairCodeRequest = null;
    }
    for (const tag of removed) {
      if (tag.cardId) this.setupProgress?.clear(tag.cardId);
      if (tag.cardId) { this.armedCards.delete(tag.cardId); this.controls.clear(); }
      const target = this.targets.get(tag.targetId);
      if (target) target.label = tag.label;
      if (this.lockedId === tag.targetId) this.release();
      this.hud.removeTarget(tag.targetId);
    }
    for (const tag of this.modes.tags.values()) {
      if (tag.cardId !== this.activeSetup) { tag.busy = false; tag.sentence = undefined; }
      let target = this.targets.get(tag.targetId);
      // A stored capture position belongs to an earlier reference space. Only a fresh detection or anchor locates it.
      if (target) { target.cardId = tag.cardId; target.label = tag.name ?? tag.label; }
      if (target && !target.locating && tag.cardId && this.roomAnchors.devices.has(tag.cardId) && this.roomAnchors.states.get(tag.cardId) === 'unlocated') {
        this.roomAnchors.place(tag.cardId, target.position, target.facing);
      }
      if (tag.cardId) {
        if (tag.connection === 'offline' && this.activeSetup === tag.cardId) this.cancelControl(tag.targetId);
        if (tag.connection === 'ready' && this.cancelledCards.has(tag.cardId)) tag.connection = 'setup';
        if (tag.connection === 'ready' && this.activeSetup !== tag.cardId && !this.cancelledCards.has(tag.cardId)) this.armedCards.add(tag.cardId);
        else { this.armedCards.delete(tag.cardId); this.controls.clear(); }
        const deferred = this.deferredSpecs.get(tag.cardId);
        if (deferred && tag.connection === 'ready' && !this.cancelledCards.has(tag.cardId)) { this.deferredSpecs.delete(tag.cardId); this.onUiSpec(deferred); }
        const specId = this.specByCard.get(tag.cardId);
        if (specId) this.hud.setArmed(this.gen3dIdFor(specId), this.armedCards.has(tag.cardId));
      }
    }
    for (const cardId of this.modes.removals) this.ws.send('tag.remove', { cardId }, { to: 'server' });
    this.refreshTags(); this.refreshHome();
  }

  /** Identity corrections revoke the old controls while preserving the selected object's pose and conversation. */
  private invalidateIdentityControls(cardId: string, targetId: string): void {
    const ownsSetup = this.activeSetup === cardId || this.armRequest?.cardId === cardId;
    const uiIds = new Set<string>();
    const current = this.specByCard.get(cardId); if (current) uiIds.add(current);
    for (const [specId, owner] of this.cardOfSpec) if (owner === cardId) { uiIds.add(specId); this.cardOfSpec.delete(specId); }
    const rendered = this.generated.get(cardId);
    const renderedIds = new Set<string>(rendered ? [rendered.specId] : []);
    for (const [renderId, uiId] of this.uiSpecOfGen3d) if (uiIds.has(uiId)) { renderedIds.add(renderId); this.uiSpecOfGen3d.delete(renderId); }
    this.retiredUiSpecs ??= new Set();
    for (const id of [...uiIds, ...renderedIds]) this.retiredUiSpecs.add(id);
    for (const id of renderedIds) this.hud.removeSpec(id);
    for (const id of uiIds) this.hud.removeSpec(id);
    this.specByCard.delete(cardId); this.specRevisions?.delete(cardId); this.generated.delete(cardId); this.deferredSpecs.delete(cardId); this.gestureSpecs.delete(cardId);
    this.assistant?.forgetMappingOutcome?.(cardId);
    for (const [key, specId] of this.menuSpec) if (key === targetId || uiIds.has(specId)) this.menuSpec.delete(key);
    for (const key of this.controlValues.keys()) if ([...uiIds, ...renderedIds].some((id) => key.startsWith(`${id}:`))) this.controlValues.delete(key);
    this.hud.showHackMenu(targetId, { title: 'Object controls', items: [] });
    this.armedCards.delete(cardId); this.cancelledCards.delete(cardId); this.virtualCards.delete(cardId);
    this.setupProgress?.clear(cardId); this.controls.clear();
    if (this.handMapping?.targetId === targetId) this.clearHandControl();
    if (this.activeSetup === cardId) this.activeSetup = undefined;
    if (ownsSetup) {
      this.pendingArm = this.armRequest = this.acceptedArm = undefined;
      this.hud.showConfirm(null);
    }
  }

  private refreshTags(): void {
    for (const tag of this.modes.tags.values()) {
      const target = this.targets.get(tag.targetId);
      if (target) this.hud.upsertTarget(toHudTarget(target));
    }
    this.refreshAnnotations(true);
  }

  private locationHint(): string | undefined {
    const saved = [...this.roomAnchors.devices.values()].filter((device) => !device.hidden);
    if (saved.some((device) => this.roomAnchors.states.get(device.cardId) === 'locating')) return 'Locating saved devices…';
    const unlocated = saved.find((device) => this.roomAnchors.states.get(device.cardId) === 'unlocated');
    return unlocated ? `Look at ${unlocated.displayName} to place it` : undefined;
  }

  private locateSavedDevice(cardId: string, position: Vector3 | null): void {
    const tag = this.modes.byCard(cardId);
    if (!tag) return;
    let target = this.targets.byCard(cardId);
    if (!position && this.roomAnchors.states.get(cardId) === 'unlocated') {
      if (target?.locating) {
        this.targets.remove(target.id); this.observed.delete(target.id); this.eraseAnnotation(target.id);
      }
      this.refreshHome(); return;
    }
    if (!target) {
      // A locating chip is a view-relative status marker until the runtime supplies a real pose.
      const placeholder = position ?? new Vector3(0, -0.15, -0.9).applyQuaternion(this.lastFrame?.head.quaternion ?? this.desktopCam.quaternion)
        .add(this.lastFrame?.head.position ?? this.desktopCam.position);
      target = this.materializeTarget({ id: tag.targetId, label: tag.name ?? tag.label,
        position: [placeholder.x, placeholder.y, placeholder.z], status: 'locked', confirmed: !!position, sizeM: [0.01, 0.01, 0.01] }, cardId);
      this.targets.reattach(tag.targetId, target, cardId);
      target.method = 'persistent-anchor';
    }
    if (!target) { this.refreshHome(); return; }
    target.locating = !position;
    if (position) { target.position.copy(position); target.lastSeenAt = Date.now(); }
    this.hud.upsertTarget(toHudTarget(target));
    if (position) this.replayLocatedSpec(cardId);
  }

  private onLibraryState(payload: PayloadOf<'library.state'>): void {
    for (const device of payload.devices) this.modes.savedCards.add(device.cardId);
    this.roomAnchors.setDevices(payload.devices);
    // Tag acknowledgement and the library snapshot may arrive in either order.
    for (const target of this.targets.list()) {
      const tag = this.modes.tags.get(target.id);
      if (!target.locating && tag?.cardId && this.roomAnchors.devices.has(tag.cardId) && this.roomAnchors.states.get(tag.cardId) === 'unlocated') {
        this.roomAnchors.place(tag.cardId, target.position, target.facing);
      }
    }
    this.refreshHome();
  }

  private reassociateDetections(targets: Target[]): void {
    const saved = [...this.roomAnchors.devices.values()].filter((device) => !device.hidden);
    const matches = targets.map((target) => ({ target, match: matchSavedDevice(saved, target) }));
    for (const { target, match } of matches) {
      if (match.kind !== 'match') continue;
      if (matches.filter((candidate) => candidate.match.kind === 'match' && candidate.match.device.cardId === match.device.cardId).length !== 1) continue;
      if (this.roomAnchors.states.get(match.device.cardId) === 'located' && target.id === this.modes.byCard(match.device.cardId)?.targetId) continue;
      this.reattachSavedDevice(target, match.device);
    }
  }

  private reattachSavedDevice(target: Target, device: LibraryDevice): void {
    const oldId = target.id;
    if (device.hidden) this.modes.removals.delete(device.cardId);
    let tag = this.modes.byCard(device.cardId);
    if (!tag) tag = this.modes.accept({ cardId: device.cardId, label: device.identity.label,
      name: device.displayName, connection: device.connection });
    if (!tag) return;
    this.observed.delete(oldId); this.eraseAnnotation(oldId);
    const placed = this.targets.reattach(tag.targetId, target, device.cardId);
    placed.label = device.displayName;
    if (device.hidden) {
      this.modes.removals.delete(device.cardId);
      this.ws.send('tag.add', { cardId: device.cardId, targetId: tag.targetId, label: device.identity.label.slice(0, 80) }, { to: 'server' });
    }
    this.roomAnchors.place(device.cardId, placed.position, placed.facing);
    this.hud.upsertTarget(toHudTarget(placed)); this.replayLocatedSpec(device.cardId); this.refreshHome();
  }

  private replayLocatedSpec(cardId: string): void {
    const spec = this.deferredSpecs.get(cardId);
    if (!spec || this.modes.byCard(cardId)?.connection !== 'ready') return;
    this.deferredSpecs.delete(cardId); this.onUiSpec(spec);
  }

  private showPlacementChoice(): void {
    const pending = this.pendingPlacement;
    if (!pending) return;
    const device = pending.devices[pending.index];
    this.hud.showConfirm({ id: `place:${device.cardId}`, kind: 'place', title: `Place ${device.displayName}?`,
      summary: `Saved device ${pending.index + 1} of ${pending.devices.length}. ${device.identity.portName ?? device.identity.model ?? device.identity.label}. Pinch Place to attach its saved controls here.`,
      primaryLabel: 'Place', cancelLabel: pending.index + 1 < pending.devices.length ? 'Next' : 'Cancel' });
  }

  requestForget(targetId: string): void {
    const tag = this.modes.tags.get(targetId);
    if (!tag?.cardId) return;
    this.pendingForget = { id: `forget:${tag.cardId}`, cardId: tag.cardId, targetId };
    this.hud.showConfirm({ id: this.pendingForget.id, kind: 'forget', title: `Forget ${tag.name ?? tag.label}?`,
      summary: 'This deletes its saved setups, controls, and room placement. Untag keeps them in your library.', primaryLabel: 'Forget' });
  }

  untag(targetId: string): void {
    if (this.modes.mode !== 'annotate') return;
    const tag = this.modes.remove(targetId);
    if (!tag) return;
    const target = this.targets.get(targetId);
    if (target) target.label = tag.label;
    if (tag.cardId) {
      this.armedCards.delete(tag.cardId);
      this.ws.send('tag.remove', { cardId: tag.cardId }, { to: 'server' });
    }
    if (this.lockedId === targetId) this.release();
    this.observed.delete(targetId); this.hud.removeTarget(targetId);
    this.refreshHome();
  }

  /** Choose the known virtual instrument, without identifying a laptop or enabling any controls. */
  selectVisualSynth(deviceId?: string, from?: { label?: string; frameId?: string; detId?: string; position?: Vector3 }): boolean {
    if (!this.session || !this.lastFrame) { this.hud.toast('Enter AR first, then choose Visual synth.', 'info'); return false; }
    from ??= this.visualSynthFrom;
    this.visualSynthFrom = from;
    this.release();
    this.setMode('control');
    this.visualSynthIntent = { phase: 'pending', message: 'Opening visuals in your paired Mac companion…', deviceId, attemptedReadyKey: this.visualSynthReadyKey ?? '' };
    if (!this.ws.open) { this.visualSynthUnavailable('Reconnect to the server and keep your paired Mac companion tab visible.'); return false; }
    // A pinched laptop/monitor box places the ring on the real screen; the wrist palette places it ahead.
    const position = from?.position?.clone() ?? new Vector3(0, -.05, -1.2).applyQuaternion(this.lastFrame.head.quaternion).add(this.lastFrame.head.position);
    const requestId = `visual-${globalThis.crypto.randomUUID()}`;
    const timeout = setTimeout(() => {
      if (this.virtualSelection?.requestId !== requestId) return;
      this.clearVirtualSelection(false);
      this.visualSynthUnavailable('The Mac did not respond. Bring your paired companion tab to the front in Chrome, then Retry.');
    }, 10_000);
    this.virtualSelection = { requestId, position, timeout };
    const sent = this.ws.send('target.select', { virtual: 'visual-synth', requestId, deviceId,
      position: { x: position.x, y: position.y, z: position.z },
      ...(from?.label ? { label: from.label.slice(0, 80) } : {}),
      ...(from?.frameId && from.detId ? { frameId: from.frameId, detId: from.detId } : {}) }, { to: 'server' });
    if (!sent) { this.clearVirtualSelection(false); this.visualSynthUnavailable('The request was not sent. Reconnect and try again.'); return false; }
    this.refreshHome();
    return true;
  }

  private clearVirtualSelection(clearIntent = true): void {
    if (this.virtualSelection) clearTimeout(this.virtualSelection.timeout);
    this.virtualSelection = undefined;
    if (clearIntent) { this.visualSynthIntent = undefined; this.visualSynthFrom = undefined; }
  }

  /** The pinched screen (laptop/monitor/TV box) that started the current visual-synth selection. */
  private visualSynthFrom?: { label?: string; frameId?: string; detId?: string; position?: Vector3 };

  /** Annotate shows only these detector classes (plus any a lane allows, e.g. tangible cups). */
  private readonly annotationLabels = new Set(['laptop', 'tv', 'monitor', 'keyboard', 'cell phone']);
  allowAnnotationLabels(labels: string[]): void {
    for (const label of labels) this.annotationLabels.add(label.toLowerCase());
    for (const [id, seen] of this.observed) if (!this.annotationAllowed(seen.target)) this.eraseAnnotation(id);
  }
  private annotationAllowed(target: { label: string; rawLabel?: string; tagged?: boolean; cardId?: string }): boolean {
    if (labEnabled() || target.tagged || target.cardId) return true;
    const label = (target.rawLabel ?? target.label).trim().toLowerCase();
    // SAM's generic "electronic device" prompt can claim the Mac's YOLO box; the sim's screen is "… Visual Synth".
    return this.annotationLabels.has(label) || /^(laptop|macbook|monitor|tv|television|screen|display|computer|electronic device)\b|visual[\s-]?synth/.test(label);
  }
  /** A laptop/monitor/TV box is the Mac's screen: pinching it selects the visual synth (WP1 golden path). */
  private isScreenBox(label: string | undefined): boolean {
    return !!label && /\b(laptop|macbook|monitor|tv|television|screen|display|computer|visual[\s-]?synth)\b/i.test(label);
  }

  private visualSynthUnavailable(message: string): void {
    if (!this.visualSynthIntent) return;
    this.visualSynthIntent.phase = 'unavailable';
    this.visualSynthIntent.message = message;
    this.refreshHome();
    this.resumeVisualSynthSelection();
  }

  private disconnectVisualSynthSelection(): void {
    this.clearVirtualSelection(false);
    this.visualSynthReadyKey = '';
    if (!this.visualSynthIntent) return;
    this.visualSynthIntent.phase = 'unavailable';
    this.visualSynthIntent.message = 'Reconnect to the server. Keep the paired Mac companion tab visible.';
    this.visualSynthIntent.attemptedReadyKey = '';
  }

  /** A newly available renderer resumes only the requested selection, never setup or arming. */
  private resumeVisualSynthSelection(): void {
    const intent = this.visualSynthIntent;
    if (intent?.phase !== 'unavailable' || !this.session || this.modes.mode !== 'control' || !this.ws.open
      || !this.visualSynthReadyKey || intent.attemptedReadyKey === this.visualSynthReadyKey) return;
    const ready = this.visualSynthReadyKey.split('|');
    if (intent.deviceId ? !ready.includes(intent.deviceId) : ready.length !== 1) return;
    this.selectVisualSynth(intent.deviceId);
  }

  private updateVisualSynthPresence(devices: PayloadOf<'presence'>['devices']): void {
    this.visualSynthReadyKey = devices.filter((device) => device.online && device.capabilities.includes('midi') && (device.kind === 'sim' || device.kind === 'mac' && device.role === 'companion')
      && device.ports?.some((port) => port.id === 'ce-visual-synth' && port.kind === 'midi-out' && port.state === 'connected'))
      .map((device) => device.deviceId).sort().join('|');
    this.resumeVisualSynthSelection();
  }

  private askSelectedObject(targetId: string, text: string): void {
    if (this.lockedId !== targetId || this.modes.mode !== 'control') return;
    this.clearHandControl();
    this.assistant?.sendText(text);
  }

  private onVirtualSelection(result: PayloadOf<'target.select.result'>): void {
    const pending = this.virtualSelection;
    if (!pending || result.requestId !== pending.requestId) return;
    this.clearVirtualSelection(false);
    if (!this.session || this.modes.mode !== 'control') return;
    if (!result.ok || !result.cardId) { this.visualSynthUnavailable(result.reason ?? 'Bring your paired Mac companion tab to the front in Chrome.'); return; }
    const tag = this.modes.byCard(result.cardId);
    if (!tag) { this.visualSynthUnavailable('The device list is still updating. Choose Retry.'); return; }
    this.virtualCards.add(result.cardId);
    let target = this.targets.byCard(result.cardId);
    if (!target) {
      target = this.materializeTarget({ id: tag.targetId, label: tag.name ?? 'ControlAnything Visual Synth',
        position: pending.position.toArray(), status: 'locked', confirmed: false, sizeM: [.24, .14, .01] }, result.cardId);
      target = this.targets.reattach(tag.targetId, target, result.cardId);
    }
    target.position.copy(pending.position);
    target.locating = false; target.method = 'virtual-display'; target.confirmed = false;
    target.label = tag.name ?? 'ControlAnything Visual Synth';
    this.hud.upsertTarget(toHudTarget(target));
    this.lock(target.id, 'virtual-synth', { send: false });
    this.replayLocatedSpec(result.cardId);
    if (result.autoSetup && tag.connection !== 'ready') {
      // CE_DEMO=1: the server already started control.setup; track it as ours instead of asking for it again.
      this.activeSetup = result.cardId;
      this.cancelledCards.delete(result.cardId);
      tag.busy = true; tag.sentence = 'Writing a controller for your Mac…';
    }
    this.refreshHome();
  }

  setupControl(targetId: string): void {
    if (!this.modes.canSetup(targetId)) return;
    const tag = this.modes.tags.get(targetId)!;
    if (this.activeSetup && this.activeSetup !== tag.cardId) return;
    this.cancelledCards.delete(tag.cardId!);
    this.deferredSpecs.delete(tag.cardId!);
    // The server's new run resets a retry. Retain known artifacts until then so a
    // re-Enable request can truthfully show the existing setup instead of regenerating it.
    this.activeSetup = tag.cardId;
    tag.busy = true; tag.sentence = 'Connecting to this device.';
    if (!this.ws.send('control.setup', { cardId: tag.cardId! }, { to: 'server' })) {
      tag.busy = false; tag.connection = 'unknown'; this.activeSetup = undefined;
      tag.sentence = 'Waiting for the server connection.';
    }
    this.refreshHome();
  }

  cancelControl(targetId: string): void {
    const tag = this.modes.tags.get(targetId);
    if (this.modes.mode !== 'control' || !tag?.cardId || this.activeSetup !== tag.cardId) return;
    this.assistant?.cancel();
    this.cancelledCards.add(tag.cardId);
    this.setupProgress?.clear(tag.cardId);
    this.ws.send('control.cancel', { cardId: tag.cardId }, { to: 'server' });
    tag.busy = false; tag.sentence = 'Setup cancelled.';
    this.activeSetup = undefined; this.pendingArm = undefined; this.armRequest = undefined; this.acceptedArm = undefined;
    this.armedCards.delete(tag.cardId); this.controls.clear(); this.clearHandControl();
    const specId = this.specByCard.get(tag.cardId);
    if (specId) this.hud.setArmed(this.gen3dIdFor(specId), false);
    this.hud.showConfirm(null); this.refreshHome();
  }

  private canControl(cardId: string | undefined): boolean {
    const tag = cardId ? this.modes.byCard(cardId) : undefined;
    return this.session?.visibilityState !== 'hidden' && this.modes.mode === 'control' && !!cardId && !!tag && tag.connection === 'ready'
      && this.visibleTargets.has(tag.targetId) && !this.targets.get(tag.targetId)?.locating && this.armedCards.has(cardId) && !this.cancelledCards.has(cardId) && this.lockedId === tag.targetId;
  }

  private pairDevice(targetId: string): void {
    const tag = this.modes.tags.get(targetId);
    if (this.modes.mode !== 'control' || tag?.connection !== 'offline' || !['open-companion', 'pair-device'].includes(tag.action ?? '')) return;
    if (tag.action === 'pair-device') {
      this.pairingUntil = performance.now() + 30_000;
      this.pairCodeRequest = null;
      this.lastPairFrame = -Infinity;
      this.hud.showApprovals([]);
      void this.startCamera();
      this.refreshHome();
      return;
    }
    this.onboarding.show();
    this.pairCodeRequest = null;
    this.lastPairFrame = -Infinity;
    this.refreshHelper();
    void this.loadHelper();
  }

  /** Menu pairing is available independently of a selected device or its transport. */
  openHelper(): void {
    // This is the explicit Menu action; automatic setup pairing uses pairDevice().
    this.projects?.close(); this.assistant?.cancel();
    this.onboarding.show(true);
    this.pairingUntil = 0;
    this.pairCodeRequest = null;
    this.lastPairFrame = -Infinity;
    this.refreshHelper();
    void this.loadHelper();
  }

  private skipHelper(): void {
    this.onboarding.skip();
    this.pairCodeRequest = null;
    this.refreshHelper();
  }

  private async loadHelper(): Promise<void> {
    if (this.helperLoading) return;
    this.helperLoading = true;
    this.lastHelperPoll = performance.now();
    const revision = this.helperPresenceRevision;
    try {
      const url = new URL('/api/helper', this.ws.url);
      url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
      const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!response.ok) return;
      const info = await response.json() as HelperInfo;
      if (!Array.isArray(info.urls) || !Array.isArray(info.helpers)) return;
      // A newer socket snapshot takes priority over an HTTP request already in flight.
      if (revision === this.helperPresenceRevision) this.onboarding.update(info, performance.now());
      else this.onboarding.updateUrls(info.urls, performance.now());
      this.refreshHelper();
    } catch {
      // Retry while in AR; presence messages still keep the helper status current.
    } finally { this.helperLoading = false; }
  }

  private refreshHelper(): void {
    const flow = this.onboarding;
    if (flow.state === 'shown') {
      flow.scan();
      this.lastPairFrame = -Infinity;
      this.hud.showApprovals([]);
      void this.startCamera();
    }
    const view = flow.visible ? { urls: flow.urls, pairedName: flow.state === 'paired' ? flow.pairedName : undefined } : null;
    const key = JSON.stringify(view);
    if (key !== this.helperViewKey) {
      this.helperViewKey = key;
      this.hud.showHelperPairing?.(view);
    }
    if (flow.state === 'paired') this.pairCodeRequest = null;
    this.refreshOnboarding();
  }

  private refreshOnboarding(): void {
    const view = this.onboarding?.guide(this.modes.tags.size) ?? null;
    const key = JSON.stringify(view);
    if (key === this.onboardingViewKey) return;
    this.onboardingViewKey = key;
    if (view) this.hud.showApprovals([]);
    this.hud.setOnboarding?.(view);
  }

  private async capturePairing(time: number): Promise<void> {
    if (this.pairingUntil && (time >= this.pairingUntil || this.modes.mode !== 'control')) {
      this.pairingUntil = 0; this.pairCodeRequest = null;
      this.refreshHome();
    }
    if ((!this.onboarding.scanning && !this.pairingUntil) || this.pairCapturing || time - this.lastPairFrame < 500) return;
    if (this.pairingUntil) this.refreshHome();
    const generation = this.onboarding.generation;
    this.pairCapturing = true; this.lastPairFrame = time;
    try {
      const frame = await this.capture.capture('pair');
      if (frame && (this.onboarding.scanning && generation === this.onboarding.generation || this.pairingUntil && this.modes.mode === 'control')) {
        this.ws.send('scan.frame', frame.payload, { to: 'server', droppable: true });
      }
    } catch (error) {
      this.page.log(`Pairing camera: ${(error as Error).message}`, 'warn');
    } finally { this.pairCapturing = false; }
  }

  private submitPairCode(targetId: string, value: string): void {
    const code = pairingCode(value), tag = this.modes.tags.get(targetId);
    const helper = targetId === '__helper__' && this.onboarding.scanning;
    if (!code || !helper && (this.modes.mode !== 'control' || tag?.connection !== 'offline' || !tag.action)) return;
    // Approval goes through the authenticated socket, never a URL from the QR or an input field.
    this.pairCodeRequest = this.ws.send('pair.approve', { code }, { to: 'server' });
    this.hud.toast(this.pairCodeRequest ? 'Checking the code…' : 'Waiting for the server connection.', 'info');
  }

  private setHandControl(targetId: string, enabled: boolean): void {
    this.clearHandControl();
    const tag = this.modes.tags.get(targetId);
    const spec = tag?.cardId ? this.gestureSpecs.get(tag.cardId) : undefined;
    if (enabled && this.canControl(tag?.cardId) && spec?.gestureMap) {
      this.controls.clear();
      const lastMirror = new Map<string, number>();
      const session = new GestureSession({ ...spec, gestureMap: spec.gestureMap }, this.controlValues, (event) => {
        if (this.handMapping?.session !== session || !this.canControl(tag?.cardId)) return;
        this.controlValues.set(`${event.specId}:${event.widgetId}`, event.value);
        this.ws.send('control.event', event);
      }, (specId, controlId, value) => {
        this.controlValues.set(`${specId}:${controlId}`, value);
        const now = performance.now();
        if (now - (lastMirror.get(controlId) ?? -Infinity) >= 200) {
          lastMirror.set(controlId, now);
          this.hud.setControlValue(specId, controlId, value);
        }
      });
      this.handMapping = { targetId, session, live: false, controllerEngaged: !!(this.lastFrame?.hands.right?.controller || this.lastFrame?.hands.left?.controller),
        route: routeLabel(spec.gen3d?.device?.transport, spec.hackset?.device.channel.type) };
    }
    this.refreshHome();
  }

  private clearHandControl(): void {
    this.handMapping?.session.engine.reset();
    this.handMapping = undefined;
    this.handFeedback?.setHover('left'); this.handFeedback?.setHover('right');
    if (this.lastFrame) this.gestureFeedback?.update(this.lastFrame, null);
  }

  private updateHandControl(frame: ShellFrame, time: number): void {
    const mapping = this.handMapping;
    if (!mapping) { this.gestureFeedback?.update(frame, null); return; }
    const tag = this.modes.tags.get(mapping.targetId);
    if (!this.canControl(tag?.cardId)) { this.clearHandControl(); this.refreshHome(); return; }
    const state = mapping.session.engine.update(frame, time, mapping.controllerEngaged);
    if (state.stopped) { this.onDeck('panic', 'press'); return; }
    this.gestureFeedback?.update(frame, state);
    if (mapping.live !== state.engaged) { mapping.live = state.engaged; this.refreshHome(); }
  }

  private helloPayload(): PayloadOf<'hello'> {
    return { deviceToken: WsClient.allowsSavedToken(this.ws.url) || this.freshSocketIdentity ? this.identity?.deviceToken ?? '' : '', role: 'hmd', capabilities: ['camera', ...(this.mic.ready && this.params.get('mic') !== '0' ? ['mic' as const] : []), 'hands', 'display'], app: APP_VERSION };
  }

  private async repairPairing(): Promise<void> {
    try {
      const identity = await this.pairing.repair();
      this.identity = identity;
      this.ws.restart();
    } catch (error) {
      // Another explicit repair owns the current pairing flow; its stale predecessor
      // must neither restart the socket nor produce an unhandled rejection.
      if (error instanceof Error && error.message === 'pairing superseded') return;
      this.page.log(`pairing failed: ${error instanceof Error ? error.message : String(error)}`, 'warn');
    }
  }

  private async connect(): Promise<void> {
    try {
      this.identity = await this.pairing.ensure();
    } catch (e) {
      this.page.log(`pairing stopped: ${(e as Error).message}`, 'error');
      return;
    }
    this.ws.start();
  }

  // --- server messages ---------------------------------------------------------------------------

  private wireMessages(): void {
    const ws = this.ws;
    // Runs after typed handlers so selection, approval and terminal states are already current.
    ws.onAny((message) => this.onSetupProgress(message));
    ws.on('welcome', (m) => {
      this.welcome = m.payload as PayloadOf<'welcome'>;
      void this.loadHelper();
      this.serverMode = this.welcome.mode;
      if (this.room?.source.kind === 'sim' && !this.params.has('scan')) {
        if (this.serverMode === 'fixture') void this.useSimFixture();
        else this.fixture = undefined;
      }
      this.ws.send('mode.set', { mode: this.modes.mode }, { to: 'server' });
      this.canvas?.syncSelection();
      for (const tag of this.modes.tags.values()) if (tag.pending) this.ws.send('tag.add', tag.pending, { to: 'server' });
      for (const cardId of this.modes.removals) this.ws.send('tag.remove', { cardId }, { to: 'server' });
      this.page.badge('b-mode', this.welcome.mode === 'live' ? 'LIVE' : 'FIXTURE', this.welcome.mode === 'live' ? 'ok' : 'warn');
      this.page.log(`connected: ${this.welcome.name} (${this.welcome.kind}) · ${this.welcome.server} · ${this.welcome.mode}${this.welcome.canApprove ? ' · approver' : ''}`, 'ok');
    });
    ws.on('presence', (m) => {
      if (m.from !== 'server') return;
      this.helperPresenceRevision++;
      const helpers = (m.payload as PayloadOf<'presence'>).devices.filter((device) => device.kind === 'sim' || device.kind === 'mac' && device.role === 'companion');
      this.onboarding.updateHelpers(helpers, performance.now());
      this.refreshHelper();
      this.updateVisualSynthPresence((m.payload as PayloadOf<'presence'>).devices);
    });
    ws.on('mode.state', (m) => this.onModeState(m.payload as PayloadOf<'mode.state'>));
    ws.on('tags.state', (m) => this.onTagsState(m.payload as PayloadOf<'tags.state'>));
    ws.on('library.state', (m) => this.onLibraryState(m.payload as PayloadOf<'library.state'>));
    ws.on('log', (m) => {
      const p = m.payload as PayloadOf<'log'>;
      if (this.pairCodeRequest && p.ref === this.pairCodeRequest) {
        this.pairCodeRequest = null;
        this.hud.toast('That code did not connect. Check the current code on your Mac.', 'warn');
      }
      if (p.level === 'error' || p.level === 'warn') {
        this.page.log(`server: ${p.message}${p.issues?.length ? ` (${p.issues.slice(0, 3).join('; ')})` : ''}`, p.level === 'error' ? 'error' : 'warn');
      }
    });
    ws.on('scan.result', (m) => {
      const p = m.payload as ScanResultPayload;
      if (this.modes.mode === 'annotate') void this.scanner.onResult(p);
      if (p.qr?.some((q) => q.approved)) { this.pairingUntil = 0; this.refreshHome(); void this.loadHelper(); }
      if (p.qr?.length) for (const q of p.qr) this.page.log(`QR seen${q.approved ? ' → approved' : ''}: ${q.text.slice(0, 60)}`, q.approved ? 'ok' : 'info');
    });
    ws.on('pair.approved', (m) => {
      const p = m.payload as PayloadOf<'pair.approved'>;
      if (p.kind === 'mac') void this.loadHelper();
    });
    ws.on('target.status', (m) => this.onTargetStatus(m.payload as TargetStatusPayload));
    ws.on('target.select.result', (m) => { if (m.from === 'server') this.onVirtualSelection(m.payload as PayloadOf<'target.select.result'>); });
    ws.on('device.card', (m) => this.onDeviceCard(m.payload as PayloadOf<'device.card'>));
    ws.on('agent.step', (m) => this.onAgentStep(m.payload as AgentStepPayload));
    ws.on('link.request', (m) => this.onLinkRequest(m.payload as LinkRequestPayload));
    ws.on('link.result', (m) => this.onLinkResult(m.payload as LinkResultPayload));
    ws.on('driver.status', (m) => this.onDriverStatus(m.payload as PayloadOf<'driver.status'>));
    ws.on('verify.result', (m) => this.onVerify(m.payload as VerifyResultPayload));
    ws.on('arm.request', (m) => this.onArmRequest(m.payload as ArmRequestPayload));
    ws.on('arm.result', (m) => this.onArmResult(m.payload as PayloadOf<'arm.result'>));
    ws.on('ui.spec', (m) => this.onUiSpec(m.payload as UiSpecPayload));
    ws.on('canvas.state', (m) => this.onCanvasState(m));
    ws.on('project.catalog', (m) => { if (m.from === 'server') this.projects?.receiveCatalog(m.payload as PayloadOf<'project.catalog'>); });
    ws.on('project.state', (m) => { if (m.from === 'server') this.projects?.receive(m.payload as PayloadOf<'project.state'>); });
    ws.on('sense.request', (m) => void this.onSenseRequest(m.payload as SenseRequestPayload));
    ws.on('panic', (m) => {
      const p = m.payload as PayloadOf<'panic'>;
      this.stopControls();
      this.hud.toast(`Stopped${p.reason ? ` · ${p.reason}` : ''}`, 'warn');
    });
    ws.on('control.result', (m) => {
      if (m.from !== 'server') return;
      const p = m.payload as { specId: string; widgetId: string; ts: number; ok: boolean };
      this.hud.setCommandResult?.(this.gen3dIdFor(p.specId), p.widgetId, p.ts, p.ok);
    });
    ws.on('control.event', (m) => {
      // another client moved a control: mirror it without re-emitting
      const p = m.payload as PayloadOf<'control.event'>;
      if (m.from === this.identity?.deviceId || !p.specId) return;
      if (p.widgetId.startsWith('gesture:')) {
        this.controlValues.set(`${p.specId}:${p.widgetId}`, p.value);
        return;
      }
      const gen3dId = [...this.uiSpecOfGen3d.entries()].find(([, ui]) => ui === p.specId)?.[0] ?? p.specId;
      this.controlValues.set(`${gen3dId}:${p.widgetId}`, p.value);
      this.hud.setControlValue(gen3dId, p.widgetId, p.value);
    });
  }

  private lastShown?: { frameId: string; dets: ReturnType<typeof normalizeDetections> };

  private onModeState({ mode }: PayloadOf<'mode.state'>): void {
    // A room snapshot or another client's stale mode must never choose this user's mode.
    if (mode !== this.modes.mode) {
      this.ws.send('mode.set', { mode: this.modes.mode }, { to: 'server' });
    }
  }

  private targetForCard(cardId: string, hint: { frameId?: string; detId?: string } = {}): Target | undefined {
    let t = this.targets.byCard(cardId);
    if (t) return t;
    if (hint.frameId && hint.detId) t = this.targets.list().find((x) => x.frameId === hint.frameId && x.detId === hint.detId);
    if (!t) { const tag = this.modes.byCard(cardId); if (tag) t = this.targets.get(tag.targetId); }
    // A room spec can arrive while a device selection is still pending.
    if (t?.cardId && t.cardId !== cardId) return undefined;
    if (t && !t.cardId) t.cardId = cardId;
    return t;
  }

  private onDeviceCard(p: PayloadOf<'device.card'>): void {
    const t = this.targetForCard(p.cardId, { frameId: p.frameId, detId: p.detId });
    this.page.log(`device.card: ${p.maker} ${p.model || p.name} (${Math.round(p.confidence * 100)} %)${p.modelId ? ` · ${p.modelId}` : ''}`, 'ok');
    if (!t || !this.modes.tags.has(t.id)) return;
    const tag = this.modes.tags.get(t.id)!;
    tag.cardId = p.cardId;
    tag.name = p.name;
    t.label = p.name || `${p.maker} ${p.model}`.trim();
    if (!t.subtitle || t.subtitle.startsWith('locked')) t.subtitle = 'identified';
    this.hud.upsertTarget(toHudTarget(t));
    this.refreshHome();
  }

  private onTargetStatus(p: TargetStatusPayload): void {
    const tag = this.modes.byCard(p.cardId);
    if (!tag || this.activeSetup !== p.cardId || this.modes.mode !== 'control') return;
    tag.sentence = p.sentence ?? p.detail;
    if (p.state === 'failed') { tag.busy = false; this.activeSetup = undefined; }
    this.refreshHome();
    const t = this.targetForCard(p.cardId);
    const m = TARGET_STATES[p.state] ?? { status: 'locked' as HudStatus, sub: p.state };
    if (t) {
      t.status = m.status;
      t.subtitle = p.detail ? `${m.sub.replace('…', '')} · ${p.detail}`.slice(0, 60) : m.sub;
      this.hud.upsertTarget(toHudTarget(t));
    }
    if (p.state === 'failed') this.hud.toast(`${t?.label ?? p.cardId}: ${p.detail ?? 'failed'}`, 'error');
    this.page.log(`target ${p.cardId.slice(-6)} → ${p.state}${p.detail ? ` (${p.detail})` : ''}`);
  }

  private onAgentStep(s: AgentStepPayload): void {
    if (!s.cardId || this.activeSetup !== s.cardId || this.modes.mode !== 'control') return;
    const tag = this.modes.byCard(s.cardId);
    if (!tag) return;
    tag.sentence = s.sentence ?? s.title;
    this.refreshHome();
    this.hud.logStep(s);
    if (s.model) this.chip(s.model, s.status === 'running' || s.status === 'pending' ? 'live' : s.status === 'fail' ? 'error' : 'done');
    if (this.upload && (!s.cardId || s.cardId === this.upload.cardId)) {
      if ((s.phase === 'control' || s.phase === 'drive' || s.phase === 'verify') && this.upload.stepsDone < 2) this.setUploadSteps(2);
      if (s.phase === 'control' && s.status === 'ok' && this.upload.stepsDone < 3) this.setUploadSteps(3);
    }
  }

  private onLinkRequest(p: LinkRequestPayload): void {
    if (this.modes.mode !== 'control' || this.activeSetup !== p.cardId) return;
    const t = this.targetForCard(p.cardId);
    const channel: Channel = p.needs.includes('ir') ? 'ir' : p.needs.includes('midi') ? 'usb' : p.needs.includes('ble') ? 'ble' : 'wifi';
    this.links.set(p.cardId, { channel, proven: false, label: p.reason });
    if (t) {
      t.channel = channel;
      t.status = 'linking';
      t.subtitle = p.status === 'needs-companion' ? `needs a companion: ${p.suggestedClients.join(' / ') || p.needs.join(', ')}` : 'linking…';
      this.hud.upsertTarget(toHudTarget(t));
    }
    this.hud.toast(p.reason, 'info');
    this.page.log(`link.request: ${p.reason}`, 'warn');
    this.refreshHome();
  }

  private onLinkResult(p: LinkResultPayload): void {
    if (this.modes.mode !== 'control' || this.activeSetup !== p.cardId) return;
    const t = this.targetForCard(p.cardId);
    const proven = p.verdict === 'confirmed' || p.verdict === 'consistent';
    const channel = p.channel ? channelOf(p.channel) : (this.links.get(p.cardId)?.channel ?? 'wifi');
    this.links.set(p.cardId, { channel, proven, label: p.evidence.map((e) => `${e.ok ? '✓' : '✗'} ${e.detail}`).join(' · ') });
    if (t) {
      t.channel = channel;
      if (p.verdict === 'mismatch') {
        t.subtitle = 'wrong device · refused';
        t.status = 'failed';
      } else if (proven) {
        t.status = 'linked';
        t.subtitle = `linked · ${p.evidence.find((e) => e.ok)?.detail ?? p.verdict}`.slice(0, 60);
      }
      this.hud.upsertTarget(toHudTarget(t));
    }
    if (p.verdict === 'mismatch') this.hud.toast('wrong device · refused', 'error');
    this.page.log(`link.result ${p.verdict}${p.reason ? `: ${p.reason}` : ''}`, proven ? 'ok' : 'warn');
    this.refreshHome();
  }

  private onDriverStatus(p: PayloadOf<'driver.status'>): void {
    const verified = p.actions?.filter((a) => a.verified === 'pass').length ?? 0;
    this.page.log(`driver ${p.driverId.slice(-6)} ${p.phase ?? p.status ?? ''}${p.actions ? ` · ${verified}/${p.actions.length} verified` : ''}`);
    const specId = p.cardId ? this.specByCard.get(p.cardId) : undefined;
    if (specId && p.phase === 'disarmed') { if (p.cardId) this.armedCards.delete(p.cardId); this.hud.setArmed(this.gen3dIdFor(specId), false); this.controls.clear(); }
  }

  private onVerify(e: VerifyResultPayload): void {
    if (this.modes.mode !== 'control' || !e.cardId || this.activeSetup !== e.cardId) return;
    const s = evidenceSentence(e);
    const t = e.cardId ? this.targetForCard(e.cardId) : undefined;
    this.hud.showEvidence({ targetId: t?.id, ...s });
    this.page.log(`verify: sent ${s.sent} → ${s.expect} · ${s.seen} (attempt ${e.attempt})`, e.pass ? 'ok' : 'warn');
    if (this.upload && (!e.cardId || e.cardId === this.upload.cardId)) this.setUploadSteps(4, e.pass ? 'ok' : 'fail');
  }

  private onArmRequest(p: ArmRequestPayload): void {
    if (this.modes.mode !== 'control' || this.activeSetup !== p.cardId || !this.modes.byCard(p.cardId) || this.modes.byCard(p.cardId)?.connection === 'offline' || this.modes.byCard(p.cardId)?.connection === 'unknown') return;
    if (this.welcome && !this.welcome.canApprove) return;
    this.armRequest = p;
    this.pendingArm = p.armId;
    this.acceptedArm = undefined;
    const tag = this.modes.byCard(p.cardId)!;
    this.hud.showConfirm({ id: p.armId, kind: 'arm', title: `${tag.name?.trim() || tag.label} is ready`, summary: p.summary, hold: p.irreversible, expiresAt: p.expiresAt, targetId: tag.targetId });
    this.page.log('Controls verified. Enable controls when you are ready.', 'ok');
  }

  private pendingArm?: string;
  private mouseCursor?: { cursor: unknown; setTargets(o: unknown[]): void; update(): unknown };

  answerConfirm(armId: string, approve: boolean, hold?: boolean): void {
    if (this.pendingForget?.id === armId) {
      const pending = this.pendingForget; this.pendingForget = undefined; this.hud.showConfirm(null);
      if (approve && this.ws.send('library.forget', { cardId: pending.cardId }, { to: 'server' })) {
        this.setupProgress?.clear(pending.cardId);
        void this.roomAnchors.forget(pending.cardId);
        this.modes.tags.delete(pending.targetId); this.armedCards.delete(pending.cardId); this.controls.clear();
        const specId = this.specByCard.get(pending.cardId);
        if (specId) this.hud.removeSpec(this.gen3dIdFor(specId));
        this.targets.remove(pending.targetId); this.observed.delete(pending.targetId); this.hud.removeTarget(pending.targetId);
        this.release();
      }
      return;
    }
    if (this.pendingPlacement && armId === `place:${this.pendingPlacement.devices[this.pendingPlacement.index].cardId}`) {
      const pending = this.pendingPlacement;
      if (approve) { this.reattachSavedDevice(pending.target, pending.devices[pending.index]); this.pendingPlacement = undefined; this.hud.showConfirm(null); }
      else if (++pending.index < pending.devices.length) this.showPlacementChoice();
      else { this.pendingPlacement = undefined; this.hud.showConfirm(null); }
      return;
    }
    const request = this.armRequest;
    if (this.modes.mode !== 'control' || !request || this.pendingArm !== armId || request.armId !== armId || this.activeSetup !== request.cardId) return;
    if (approve && (Date.now() >= request.expiresAt || request.irreversible && !hold)) return;
    this.ws.send('arm.confirm', { armId, approve, ...(hold ? { hold } : {}) }, { to: 'server' });
    this.hud.showConfirm(null);
    this.pendingArm = undefined;
    this.acceptedArm = approve ? armId : undefined;
    if (!approve) this.cancelControl(this.modes.byCard(request.cardId)!.targetId);
    this.recorder.input('arm', { armId, approve });
  }

  private onArmResult(p: PayloadOf<'arm.result'>): void {
    if (this.modes.mode !== 'control') return;
    // CE_DEMO=1: the server arms after verification with no arm.request; accept it for our own active setup.
    const auto = !!p.auto && p.armed && this.activeSetup === p.cardId;
    if (!auto) {
      if (this.armRequest?.armId !== p.armId || this.armRequest.cardId !== p.cardId || this.activeSetup !== p.cardId) return;
      if (p.armed && this.acceptedArm !== p.armId) return;
    }
    if (this.pendingArm === p.armId) { this.hud.showConfirm(null); this.pendingArm = undefined; }
    if (p.armed) this.armedCards.add(p.cardId);
    else this.armedCards.delete(p.cardId);
    const specId = this.specByCard.get(p.cardId);
    if (specId) this.hud.setArmed(this.gen3dIdFor(specId), p.armed, p.reason);
    const tag = this.modes.byCard(p.cardId);
    if (tag) { tag.busy = false; tag.connection = p.armed ? 'ready' : tag.connection; tag.sentence = p.reason; }
    this.activeSetup = undefined; this.armRequest = undefined; this.acceptedArm = undefined;
    this.refreshTags(); this.refreshHome();
  }

  private gen3dIdFor(uiSpecId: string): string {
    for (const [g, u] of this.uiSpecOfGen3d) if (u === uiSpecId) return g;
    return uiSpecId;
  }

  /** HUD menu key → ui.spec id, so a hack pinch carries the spec it came from */
  private readonly menuSpec = new Map<string, string>();

  private onUiSpec(p: UiSpecPayload): void {
    if (!p.cardId) return;
    if (this.retiredUiSpecs?.has(p.specId) || p.gen3d && this.retiredUiSpecs?.has(p.gen3d.specId)) return;
    if (!this.modes.byCard(p.cardId) || (this.activeSetup !== p.cardId && this.modes.byCard(p.cardId)?.connection !== 'ready')) {
      this.deferredSpecs.set(p.cardId, p);
      while (this.deferredSpecs.size > 64) this.deferredSpecs.delete(this.deferredSpecs.keys().next().value!);
      return;
    }
    if (this.handMapping?.targetId === this.modes.byCard(p.cardId)?.targetId) this.clearHandControl();
    if (p.gestureMap && (p.gestureMap.axes.length || p.gestureMap.postures.length)) this.gestureSpecs.set(p.cardId, p);
    else this.gestureSpecs.delete(p.cardId);
    // a card's spec sits at that device; a room-level spec (no cardId: daemons, combos) floats on its own
    const t = p.cardId ? this.targetForCard(p.cardId) : undefined;
    if (!t || t.locating) { this.deferredSpecs.set(p.cardId, p); return; }
    const menuKey = p.cardId ? (t?.id ?? p.cardId) : `room:${p.specId}`;
    if (p.cardId) {
      this.specByCard.set(p.cardId, p.specId);
      (this.specRevisions ??= new Map()).set(p.cardId, p.rev ?? 1);
      this.cardOfSpec.set(p.specId, p.cardId);
    }
    if (p.gen3d) {
      this.uiSpecOfGen3d.set(p.gen3d.specId, p.specId);
      this.generated.set(p.cardId, p.gen3d);
      this.hud.renderSpec({ ...p.gen3d, state: { ...p.gen3d.state, armed: false } }, t ? { targetId: t.id } : {});
      this.hud.setArmed(p.gen3d.specId, this.armedCards.has(p.cardId));
    }
    if (p.hackset) {
      const ch = p.hackset.device.channel.type;
      const channel: Channel = ch === 'local' ? 'wifi' : (ch as Channel);
      const items: HackItem[] = p.hackset.hacks.map((h) => {
        const it: HackItem = { id: h.id, label: h.name.slice(0, 24), kind: h.kind, channel, controlId: h.id, status: h.status ?? 'ready' };
        if (h.blurb) it.detail = h.blurb.slice(0, 32);
        return it;
      });
      this.menuSpec.set(menuKey, p.specId);
      this.hud.showHackMenu(menuKey, { title: p.hackset.device.name, subtitle: 'Device controls', items });
    }
    this.page.log(`ui.spec ${p.title ?? p.specId} rev ${p.rev ?? 1}${p.cardId ? '' : ' (room)'}${p.modelId ? ` · ${p.modelId}` : ''}${p.source === 'fixture' ? ' · FIXTURE' : ''}`, 'ok');
    this.refreshHome();
  }

  /** Is a world point inside the current camera frame (with a 5 % margin)? */
  private inCameraView(p: Vector3): boolean {
    const f = this.lastFrame;
    if (!f) return true;
    const k = this.capture.last?.intrinsics ?? questIntrinsics(1280, 960);
    const cam = cameraPoseFromHead({ position: f.head.position, quaternion: f.head.quaternion }, this.camera.eye);
    const px = worldToPixel(p, k, cam);
    return Boolean(px && px.u > k.width * 0.05 && px.u < k.width * 0.95 && px.v > k.height * 0.05 && px.v < k.height * 0.95);
  }

  private exposureLocked = false;
  private exposureTimer?: ReturnType<typeof setTimeout>;

  private async onSenseRequest(p: SenseRequestPayload): Promise<void> {
    if (!this.identity || p.sensorDeviceId !== this.identity.deviceId) return;
    if (this.modes.mode !== 'control' || !p.cardId || !this.modes.byCard(p.cardId) || (this.activeSetup !== p.cardId && !this.canControl(p.cardId))) return;
    if (p.kind === 'audio-features') {
      try {
        if (this.params.get('mic') === '0' || !this.mic.ready) throw new Error('Enable the headset microphone before entering AR, then retry setup');
        const audio = await this.mic.measure(p.durationMs || 600, p.offsetMs ?? 0);
        if (this.modes.mode !== 'control' || this.activeSetup !== p.cardId && !this.canControl(p.cardId)) return;
        this.ws.send('sense.result', { senseId: p.senseId, kind: p.kind, at: Date.now(), ok: true, audio }, { to: 'server' });
      } catch (e) {
        this.ws.send('sense.result', { senseId: p.senseId, kind: p.kind, at: Date.now(), ok: false, error: (e as Error).message.slice(0, 300) }, { to: 'server' });
      }
      return;
    }
    if (p.kind !== 'frame') {
      this.ws.send('sense.result', { senseId: p.senseId, kind: p.kind, at: Date.now(), ok: false, error: 'the headset senses camera frames and microphone features' }, { to: 'server' });
      return;
    }
    // fixed exposure across the before/after pair when the camera allows it (released 4 s after the last request)
    if (this.camera instanceof LiveCamera && this.camera.info?.canLockExposure) {
      const cam = this.camera;
      if (!this.exposureLocked) this.exposureLocked = await cam.setExposureLock(true);
      clearTimeout(this.exposureTimer);
      this.exposureTimer = setTimeout(() => {
        void cam.setExposureLock(false);
        this.exposureLocked = false;
      }, 4000);
    }
    // the camera oracle compares the device region before/after: it must be in view, and the head still
    const t = p.cardId ? this.targetForCard(p.cardId) : undefined;
    // A direct virtual target is a UI marker, not the screen's measured physical position.
    if (t && !this.virtualCards?.has(p.cardId) && this.lastFrame && !this.inCameraView(t.position)) {
      this.hud.toast(`look at the ${t.label} · verifying`, 'warn');
      this.page.log(`verify: ${t.label} is not in the camera view`, 'warn');
    }
    for (let i = 0; i < 12 && this.poses.peakSpeed(performance.now(), 150) > 15; i++) await new Promise((res) => setTimeout(res, 50));
    let r: Awaited<ReturnType<FrameCapture['capture']>> = null;
    for (let i = 0; i < 30 && !r; i++) {
      r = await this.capture.capture('verify', p.senseId);
      if (!r) await new Promise((res) => setTimeout(res, 50));
    }
    if (this.modes.mode !== 'control' || this.activeSetup !== p.cardId && !this.canControl(p.cardId)) return;
    if (!r) {
      this.ws.send('sense.result', { senseId: p.senseId, kind: 'frame', at: Date.now(), ok: false, error: 'no camera frame available' }, { to: 'server' });
      this.page.log('sense.request: no camera frame to send', 'error');
      return;
    }
    if (p.cardId) r.payload.cardId = p.cardId;
    if (this.fixture && this.room) {
      r.payload.fixtureDetections = projectFixture(this.fixture, this.room, r.record).map((d) => ({
        detId: d.detId, label: d.label, prompt: d.prompt ?? d.label, score: d.score, box: d.box,
      }));
    }
    // tells the camera oracle whether absolute luma is comparable across the before/after pair
    if (r.payload.camera && this.camera instanceof LiveCamera) r.payload.camera.exposure = this.exposureLocked ? 'locked' : 'auto';
    this.ws.send('sense.result', { senseId: p.senseId, kind: 'frame', frame: r.payload, at: Date.now(), ok: true }, { to: 'server' });
    this.lastShown = { frameId: r.payload.frameId, dets: [] };
    this.showLastFrame(r.payload.jpeg, r.payload.width, r.payload.height, [], `verify frame${p.cardId ? ` · ${p.cardId.slice(-6)}` : ''}`);
    this.page.log(`sense.request → verify frame ${r.payload.frameId.slice(-6)} (${Math.round(r.record.bytes / 1024)} KB)`);
  }

  // --- HUD events ----------------------------------------------------------------------------------

  onDeck(key: string, phase: 'press' | 'release'): void {
    if (key === 'panic' && phase === 'press') { this.cancelManualRegion(); this.projects?.pauseForNavigation(); }
    if (key === 'mic' && phase === 'press' && this.lockedId) {
      this.clearHandControl();
      void this.assistant?.toggle(this.lockedId);
      return;
    }
    if (key !== 'panic' || phase !== 'press' || this.modes.mode !== 'control') return;
    this.stopControls();
    this.ws.send('panic', { reason: 'Stop from the home bar' }, { to: 'server' });
    this.hud.toast('Stopped', 'warn');
  }

  private stopControls(): void {
    this.setupProgress?.clear();
    for (const tag of this.modes.tags.values()) if (tag.cardId && (this.armedCards.has(tag.cardId) || this.activeSetup === tag.cardId)) {
      this.cancelledCards.add(tag.cardId);
      tag.busy = false; tag.sentence = 'Stopped. Set up control to continue.';
      if (tag.connection === 'ready') tag.connection = 'setup';
    }
    this.activeSetup = undefined; this.pendingArm = undefined; this.armRequest = undefined; this.acceptedArm = undefined;
    this.armedCards.clear(); this.controls.clear(); this.clearHandControl();
    for (const specId of this.specByCard.values()) this.hud.setArmed(this.gen3dIdFor(specId), false);
    this.hud.showConfirm(null); this.release(); this.refreshTags();
  }

  /** Desktop helper: scanning is automatic whenever Annotate is active. */
  toggleScan(): void {
    if (this.modes.mode !== 'annotate') return;
    this.cancelManualRegion(); this.scanner.setCategory(this.filter);
    if (this.cameraState !== 'on') void this.startCamera();
    this.scanner.start();
  }

  private lastHack = { key: '', at: 0 };

  private onHack(e: { ts?: number; targetId: string; itemId: string; controlId?: string; index: number; hold?: boolean }): void {
    // one pinch = one action on a real device: drop a repeat of the same hack within 400 ms
    const key = `${e.targetId}:${e.itemId}`;
    const now = performance.now();
    if (key === this.lastHack.key && now - this.lastHack.at < 400) return;
    this.lastHack = { key, at: now };
    // the pinch IS the human confirmation: an action hack fires as {widgetId: hackId, value: true, phase: 'end'}
    const t = this.targets.get(e.targetId);
    if (!t?.cardId || !this.canControl(t.cardId) || this.lockedId !== t.id) return;
    if (this.handMapping) { this.clearHandControl(); this.refreshHome(); }
    const specId = this.menuSpec.get(e.targetId) ?? (t?.cardId ? this.specByCard.get(t.cardId) : undefined);
    const payload: PayloadOf<'control.event'> = { widgetId: e.itemId, value: true, ts: e.ts ?? Date.now(), phase: 'end' };
    if (specId) payload.specId = specId;
    this.ws.send('control.event', payload);
    this.upload = { hackId: e.itemId, label: e.itemId, cardId: t?.cardId, stepsDone: 1, startedAt: performance.now() };
    this.setUploadSteps(1);
    this.recorder.input('hack', e as unknown as Record<string, unknown>);
    this.page.log(`hack ${e.itemId} → control.event (your pinch = confirmation)`, 'ok');
  }

  private setUploadSteps(n: number, verdict?: 'ok' | 'fail'): void {
    const u = this.upload;
    if (!u) return;
    u.stepsDone = Math.max(u.stepsDone, n);
    this.hud.setUpload({ hackId: u.hackId, label: u.label, stepsDone: u.stepsDone, verdict: verdict ?? 'pending', elapsedS: Math.round((performance.now() - u.startedAt) / 100) / 10 });
    if (verdict) this.upload = undefined;
  }

  private onControl(e: ControlEvent): void {
    // the live-box category chips are a local spec: they filter boxes and never reach the server
    if (e.specId === CHIPS_SPEC_ID) {
      const c = categoryFromControl(e.controlId);
      if (c && e.phase === 'start') this.setLiveCategory(c);
      return;
    }
    // only controls of specs the server sent drive devices; HUD-internal objects (hack menus, deck) never do
    const ui = this.uiSpecOfGen3d.get(e.specId);
    if (!ui || !this.canControl(this.cardOfSpec.get(ui))) return;
    this.controlValues.set(`${e.specId}:${e.controlId}`, e.value);
    const cardId = this.cardOfSpec.get(ui);
    const control = cardId ? this.generated.get(cardId)?.controls.find((c) => c.id === e.controlId) : undefined;
    if (!control || control.armed === false) return;
    // Touching an ordinary control explicitly leaves Perform and picks up normal widget input.
    if (this.handMapping) this.clearHandControl();
    const gestureSpec = cardId ? this.gestureSpecs.get(cardId) : undefined;
    if (gestureSpec?.gestureMap) for (const axis of gestureSpec.gestureMap.axes) this.controlValues.delete(`${ui}:gesture:${axis.axis}`);
    // One-shot commands execute on release; their activation value must stay true.
    this.controls.push({ ...e, value: control?.kind === 'trigger' ? true : e.value, specId: ui });
    // Let an ongoing drag finish before rebuilding the card to remove its Perform selection.
    if (e.phase === 'end') this.refreshHome();
  }

  private refreshPing(force = false): void {
    if (!this.pingVisible && !force) {
      this.hud.setPing([]);
      return;
    }
    const lines = [];
    for (const t of this.targets.list()) {
      const link = t.cardId ? this.links.get(t.cardId) : undefined;
      if (!link && !this.pingVisible) continue;
      lines.push({ id: `ping:${t.id}`, targetId: t.id, channel: link?.channel ?? t.channel ?? guessChannel(t.label), proven: link?.proven ?? false, label: link?.label });
    }
    this.hud.setPing(lines);
  }

  private chip(id: string, state: ModelChip['state']): void {
    this.chips.set(id, { id, state, at: Date.now() });
    const list = [...this.chips.values()].sort((a, b) => b.at - a.at).slice(0, 6);
    this.hud.setModelChips(list.map(({ id: cid, state: s }) => ({ id: cid, state: s })));
  }

  // --- targeting -----------------------------------------------------------------------------------

  private readonly targetHistory = { left: new PinchTargetHistory<string>(), right: new PinchTargetHistory<string>() };
  private readonly aimTargets = new Map<string, AimTarget>();
  private readonly aimBuffer: AimTarget[] = [];
  private readonly gazeHit: AimHit = { id: '', angleDeg: 0, distance: 0 };
  private readonly handHit: AimHit = { id: '', angleDeg: 0, distance: 0 };
  private readonly touchHit: AimHit = { id: '', angleDeg: 0, distance: 0 };

  private aimList(): AimTarget[] {
    const list = this.aimBuffer;
    list.length = 0;
    for (const t of this.targets.targets.values()) {
      if (!this.visibleTargets.has(t.id)) continue;
      let aim = this.aimTargets.get(t.id);
      if (!aim) {
        aim = { id: t.id, position: new Vector3(), size: 0 };
        this.aimTargets.set(t.id, aim);
      }
      aim.size = Math.max(0.06, t.sizeM[0], t.sizeM[1]);
      aim.position.copy(t.position);
      if (this.hud.getTargetAim && !this.hud.getTargetAim(t.id, aim)) continue;
      list.push(aim);
    }
    for (const id of this.aimTargets.keys()) if (!this.targets.get(id) && !this.visibleTargets.has(id)) this.aimTargets.delete(id);
    if (this.modes.mode === 'annotate') this.live?.appendAimables(list);
    for (let i = list.length - 1; i >= 0; i--) {
      const source = list[i]!;
      if (!this.visibleTargets.has(source.id)) { list.splice(i, 1); continue; }
      if (isLiveId(source.id) && this.hud.getTargetAim) {
        let aim = this.aimTargets.get(source.id);
        if (!aim) { aim = { id: source.id, position: new Vector3(), size: source.size }; this.aimTargets.set(source.id, aim); }
        if (this.hud.getTargetAim(source.id, aim)) list[i] = aim;
        else list.splice(i, 1);
      }
    }
    return list;
  }

  private interact(f: ShellFrame, time: number): void {
    this.handFeedback.setHover('left');
    this.handFeedback.setHover('right');
    // Performance pinches belong to the selected device until Perform is turned off.
    if (this.handMapping || this.modes.mode === 'control' && (this.lockedId || this.visualSynthIntent)) {
      this.candidate.id = this.candidate.shown = null;
      this.hud.setCandidate(null);
      for (const hand of HANDS) this.targetHistory[hand].reset();
      return;
    }
    const list = this.aimList();
    if (!list.length) {
      this.candidate.id = this.candidate.shown = null;
      this.hud.setCandidate(null);
      return;
    }
    const mouse = this.input.mouseAsHand && this.input.pointer.inside ? f.hands.right : undefined;
    const gaze = mouse?.ray ?? f.head.ray;
    const aim = aimAt(gaze.origin, gaze.dir, list, GAZE_AIM, this.gazeHit);
    const id = aim?.id ?? null;
    if (id !== this.candidate.id) {
      this.candidate.id = id;
      this.candidate.since = time;
    }
    const show = this.handAimId && this.handAimId !== this.lockedId ? this.handAimId
      : id && id !== this.lockedId && time - this.candidate.since >= 250 ? id : null;
    if (show !== this.candidate.shown) {
      this.candidate.shown = show;
      this.hud.setCandidate(show);
    }
    let handAimId: string | null = null;
    for (const hand of HANDS) {
      const h = f.hands[hand];
      if (!h || this.consumed[hand]) { this.targetHistory[hand].reset(); continue; }
      const handAim = h.ray.dir.lengthSq() > 0.5 ? aimAt(h.ray.origin, h.ray.dir, list, HAND_AIM, this.handHit) : null;
      if (handAim) this.handFeedback.setHover(hand, this.targets.get(handAim.id) ?? this.live?.hoverTarget(handAim.id));
      // A hand ray on a box is a deliberate hover: next frame its pill label shows at once (gaze needs 250 ms).
      if (handAim) handAimId = handAim.id;
      const raw = h.rawRay ?? h.ray;
      const previous = h.justPinched ? this.targetHistory[hand].compensate(time, handAim?.id ?? null, raw.origin, raw.dir) : null;
      this.targetHistory[hand].record(time, handAim?.id ?? null, raw.origin, raw.dir);
      if (!h.justPinched) continue;
      // A system pinch can arrive without joints; only a measured midpoint can refine a target.
      if (!h.controller && h.joints['thumb-tip'] && h.joints['index-finger-tip']) {
        const touch = touching(h.pinchPoint, list, 0.06, this.touchHit);
        if (touch) {
          this.lock(touch.id, 'touch');
          continue;
        }
      }
      const pick = previous && this.visibleTargets.has(previous) ? previous : handAim?.id ?? this.candidate.shown ?? null;
      if (!pick) continue;
      this.lock(pick, handAim ? 'ray' : 'gaze');
    }
    this.handAimId = handAimId;
  }
  private handAimId: string | null = null;

  /** Select a device; annotation only records an explicit tag. */
  lock(id: string, how = 'api', opts: { send?: boolean } = {}): void {
    // A chip/body pinch cannot replace an explicit control/assistant workspace. Menu → Change device
    // releases that workspace; annotation and explicit API selections remain available.
    if (this.modes.mode === 'control' && (this.visualSynthIntent || this.lockedId && this.lockedId !== id)
      && ['chip', 'touch', 'ray', 'gaze'].includes(how)) return;
    // In Annotate, a pinch on the Mac's screen (tagged or not) opens the visual synth; in Control it is already selected.
    if (['chip', 'touch', 'ray', 'gaze'].includes(how) && (this.modes.mode === 'annotate' || !this.modes.tags.get(id)?.cardId?.startsWith('visual-synth'))) {
      const live = isLiveId(id) ? this.live?.targetSnapshot(this.live?.claimOf(id) ?? id) : undefined;
      const t = this.targets.get(id);
      const label = t?.label ?? live?.label;
      if (this.isScreenBox(label) || this.isScreenBox(live?.rawLabel)) {
        const position = t ? t.position.clone() : live ? new Vector3().fromArray(live.position) : undefined;
        this.selectVisualSynth(undefined, { label: (live?.rawLabel ?? label)!, frameId: t?.frameId, detId: t?.detId, position });
        return;
      }
    }
    this.clearVirtualSelection();
    if (this.modes.mode === 'control' && !this.modes.tags.has(id)) return;
    if (isLiveId(id)) {
      const claimed = this.live?.claimOf(id);
      if (claimed) return this.lock(claimed, how, opts);
      const snapshot = this.live?.targetSnapshot(id);
      if (!snapshot) return;
      const target = this.materializeTarget(snapshot);
      this.live?.onSamTargets();
      id = target.id;
    }
    const t = this.targets.get(id);
    if (!t) return;
    if (this.modes.mode === 'annotate' && !this.modes.tags.has(id)) {
      const match = matchSavedDevice([...this.roomAnchors.devices.values()], t);
      if (match.kind === 'ambiguous') { this.pendingPlacement = { target: t, devices: match.devices, index: 0 }; this.showPlacementChoice(); return; }
      if (match.kind === 'match') { this.reattachSavedDevice(t, match.device); id = t.id; }
    }
    if (this.activeSetup && this.activeSetup !== this.modes.tags.get(id)?.cardId) {
      const active = this.modes.byCard(this.activeSetup);
      if (active) this.cancelControl(active.targetId);
    }
    this.clearHandControl();
    if (this.lockedId !== id) this.assistant?.cancel();
    this.pairingUntil = 0;
    this.lockedId = id;
    const savedCard = this.modes.tags.get(id)?.cardId;
    if (savedCard) this.roomAnchors.touch(savedCard);
    this.hud.setCandidate(null);
    this.candidate.shown = null;
    this.hud.setLocked(id);
    if (this.modes.mode === 'annotate' && !this.modes.tags.has(id)) {
      const payload: PayloadOf<'tag.add'> = { targetId: id, label: t.label.slice(0, 80), position: { x: t.position.x, y: t.position.y, z: t.position.z } };
      if (t.frameId && t.detId) { payload.frameId = t.frameId; payload.detId = t.detId; }
      if (t.cardId) this.modes.removals.delete(t.cardId);
      this.modes.add(id, payload);
      if (opts.send !== false) this.ws.send('tag.add', payload, { to: 'server' });
      this.recorder.input('tag', { targetId: id, label: t.label, how });
      this.lockedId = null;
      this.hud.setLocked(null);
    }
    this.hud.upsertTarget(toHudTarget(t));
    this.refreshHome();
  }

  release(): void {
    this.projects?.close();
    this.clearVirtualSelection();
    this.assistant?.cancel();
    this.clearHandControl();
    this.pairingUntil = 0;
    this.lockedId = null;
    this.hud.setLocked(null);
    this.hud.setDeviceState?.(null);
    this.refreshHome();
  }

  // --- extension points (other lanes register here; see wrist-palette.ts) ---------------------------

  /** Add a wrist-palette button (≤ 5 shown in all). Returns an unregister function. */
  registerPaletteItem(item: PaletteItem): () => void {
    const hud = this.hud as Hud & { registerPaletteItem?: (i: PaletteItem) => () => void };
    return hud.registerPaletteItem?.(item) ?? (() => {});
  }

  /** Add an action pill beside a selected object's ring label (annotate). Returns an unregister function. */
  registerObjectAction(action: { key: string; label: string; visible?: (targetId: string) => boolean; onSelect: (targetId: string) => void }): () => void {
    const hud = this.hud as Hud & { registerObjectAction?: (a: typeof action) => () => void };
    return hud.registerObjectAction?.(action) ?? (() => {});
  }

  /** Per-frame callback, after the HUD update and before render. Returns an unregister function. */
  addFrameHook(hook: (f: ShellFrame, dtSec: number, timeMs: number, xrFrame?: XRFrame) => void): () => void {
    this.frameHooks.push(hook);
    return () => { const i = this.frameHooks.indexOf(hook); if (i >= 0) this.frameHooks.splice(i, 1); };
  }

  // --- frame loop -----------------------------------------------------------------------------------

  private frameErrors = 0;

  /** three.js stops the animation loop after an uncaught exception in the callback: never let one escape. */
  private frame(time: number, xrFrame?: XRFrame): void {
    try {
      this.frameInner(time, xrFrame);
    } catch (e) {
      if (this.frameErrors++ < 5 || this.frameErrors % 300 === 0) this.page.log(`frame error #${this.frameErrors}: ${(e as Error).message}`, 'error');
      try {
        this.renderer.render(this.scene, this.desktopCam);
      } catch {
        // nothing more to do this frame
      }
    }
  }

  private frameInner(time: number, xrFrame?: XRFrame): void {
    // The headset's launcher is ordinary HTML. Keep its hidden 3D scene idle until AR starts.
    if (!xrFrame && !this.emulator && !this.player) {
      if (time - this.lastStatusAt > 500) { this.lastStatusAt = time; this.updateStatus(); }
      return;
    }
    // Read the manager's current space inside its active frame; a cached space may belong to an old session.
    const refSpace = frameReferenceSpace(this.renderer, xrFrame);
    if (xrFrame && !refSpace) return;
    const inXr = Boolean(xrFrame && refSpace);
    if (xrFrame && refSpace && refSpace !== this.refSpace) {
      this.refSpace = refSpace;
      this.xrHit.detach();
      this.xrHit.attach(xrFrame.session, refSpace);
    }
    if (this.emulator) {
      const h = this.emulator.head();
      this.desktopCam.position.copy(h.position);
      this.desktopCam.quaternion.copy(h.quaternion);
      const fov = (this.emulator.device.fovy * 180) / Math.PI;
      const rect = this.renderer.domElement.getBoundingClientRect();
      const aspect = rect.width > 0 && rect.height > 0 ? rect.width / rect.height : this.desktopCam.aspect;
      if (Math.abs(this.desktopCam.fov - fov) > 0.01 || Math.abs(this.desktopCam.aspect - aspect) > 0.001) {
        this.desktopCam.fov = fov;
        this.desktopCam.aspect = aspect;
        this.desktopCam.updateProjectionMatrix();
      }
    }
    this.desktopCam.updateMatrixWorld();
    const cam = inXr ? this.renderer.xr.getCamera() : this.desktopCam;
    const f = this.input.sample(time, cam, xrFrame, refSpace);
    this.lastFrame = f;
    this.poses.push(time, f.head.position, f.head.quaternion);
    if (this.recorder.recording) {
      if (refSpace !== this.recordingRefSpace) {
        this.recordingRefSpace?.removeEventListener('reset', this.onRecordingSpaceReset);
        this.recordingRefSpace = refSpace;
        refSpace?.addEventListener('reset', this.onRecordingSpaceReset);
        this.recorder.spaceBoundary('reference-change');
      }
      const visible = !this.session || this.session.visibilityState !== 'hidden';
      const viewer = visible && xrFrame && refSpace ? xrFrame.getViewerPose(refSpace) : null;
      const head = viewer ? { position: viewer.transform.position, quaternion: viewer.transform.orientation } : this.emulator && visible ? f.head : null;
      this.recorder.pose(head, visible && inXr ? f.hands : {});
    }
    if (inXr && xrFrame) this.xrHit.onFrame(xrFrame);
    if (xrFrame && refSpace) this.roomAnchors.update(xrFrame, refSpace);
    if (inXr && this.camera instanceof LiveCamera) this.camera.pollFromXr(time);
    this.room?.update(time);
    this.refreshAnnotations();
    this.updateHandControl(f, time);
    this.projects?.update(f);
    if (this.session) {
      this.onboarding.tick(time);
      this.refreshHelper();
      if (time - this.lastHelperPoll >= 2000) void this.loadHelper();
      if (this.onboarding.scanning || this.pairingUntil) void this.capturePairing(time);
    }
    for (const m of this.handheld.update(this.wrists(f), time, this.heldMoves)) {
      const t = this.targets.get(m.id);
      if (!t) continue;
      t.position.copy(m.position);
      this.hud.upsertTarget(toHudTarget(t));
    }
    this.consumed.left = this.consumed.right = false;
    // Pointer events (pokes, pinches, clicks) dispatch here, before the HUD reads them this frame.
    this.spatial?.update(f.dt, time);
    if (this.mouseCursor) {
      // gen3d gets the mouse as its dev cursor, not also as a hand
      this.mouseCursor.update();
      const hands = { ...f.hands };
      if (hands.right?.controller && this.input.mouseAsHand) delete hands.right;
      this.hud.update({ ...f, hands, ...(this.input.mouseAsHand ? { pointer: 'mouse' as const } : {}) });
    } else this.hud.update(this.input.mouseAsHand ? { ...f, pointer: 'mouse' } : f);
    if (this.manualRegion?.active) {
      if (this.hud.root.getObjectByName('main-menu')?.visible) this.cancelManualRegion();
      else { const region = this.manualRegion.update(f, this.camera.eye, this.camera.info); if (region) void this.scanManualRegion(region); }
    } else if (!this.manualScanPending && !this.onboarding?.visible && !this.projects?.open) this.interact(f, time);
    if (this.spatial) this.handFeedback.pointerInfo = this.spatial.describe();
    this.handFeedback.update(f, this.input.diagnostics, this.renderer.info.render.calls);
    for (const hook of this.frameHooks) {
      try { hook(f, f.dt, time, xrFrame); } catch (e) { if (this.frameErrors++ < 5) this.page.log(`frame hook error: ${(e as Error).message}`, 'error'); }
    }
    if (!this.onboarding?.visible) this.scanner.tick(time);
    if (this.live) {
      this.live.tick(time, f.dt * 1000);
      if (this.readout) this.readout.update(cam as PerspectiveCamera, time, this.liveReadoutLines());
    }
    this.renderer.render(this.scene, this.desktopCam);
    if (time - this.lastStatusAt > 300) {
      this.lastStatusAt = time;
      this.updateStatus();
    }
  }

  private readonly heldMoves: { id: string; position: Vector3 }[] = [];
  private readonly wristPoses: { left?: WristPose; right?: WristPose } = {};

  private wrists(f: ShellFrame | undefined = this.lastFrame): { left?: WristPose; right?: WristPose } {
    const out = this.wristPoses;
    for (const h of HANDS) {
      const w = f?.hands[h]?.joints.wrist;
      if (w) out[h] = w;
      else delete out[h];
    }
    return out;
  }

  // --- camera, XR ------------------------------------------------------------------------------------

  private cameraStartPromise?: Promise<void>;
  async startCamera(): Promise<void> {
    if (this.cameraState === 'on') return;
    if (this.cameraStartPromise) return this.cameraStartPromise;
    this.cameraStartPromise = this.openCamera();
    try { await this.cameraStartPromise; } finally { this.cameraStartPromise = undefined; }
  }

  private async openCamera(): Promise<void> {
    this.cameraState = 'starting';
    try {
      const info = await this.camera.start();
      this.cameraState = 'on';
      this.cameraNote = `${info.label || this.camera.kind} ${info.width}×${info.height}${info.frameRate ? ` @${Math.round(info.frameRate)}` : ''}`;
      this.page.log(`camera: ${this.cameraNote}`, 'ok');
      if (info.warning) this.page.log(info.warning, 'warn');
      if (info.devices?.length) this.page.log(`video inputs: ${info.devices.map((d) => d.label || d.deviceId.slice(0, 6)).join(' | ')}`);
      if (info.capabilities) this.page.log(`camera capabilities: ${info.capabilities}${info.canLockExposure ? ' · exposure lock available' : ''}`);
    } catch (e) {
      this.cameraState = 'error';
      this.cameraNote = (e as Error).message;
      this.page.log(`camera failed: ${(e as Error).message}`, 'error');
      if (e instanceof CameraError) this.page.log(e.hint, 'warn');
      this.hud.toast('camera unavailable: see the 2D page log', 'error');
    }
  }

  async prepareMedia(): Promise<void> {
    await this.startCamera();
    if (this.params.get('mic') === '0') return;
    try {
      await this.mic.prepare();
      this.ws.send('hello', this.helloPayload(), { to: 'server' });
      this.page.log(`mic: ${this.mic.label} · ${this.mic.rate} Hz PCM16`, 'ok');
    } catch (e) {
      this.page.log(`mic failed: ${(e as Error).message}`, 'warn');
    }
  }

  async enterXr(): Promise<void> {
    if (this.enteringXr) return;
    if (this.session) {
      await this.session.end();
      return;
    }
    this.enteringXr = true;
    try {
      // permissions before the session, so no prompt interrupts it (research/04 §2)
      await this.prepareMedia();
      const s = await startXr(this.renderer, { allowVr: Boolean(this.emulator) });
      this.session = s.session;
      this.scanner.stop();
      this.hud.setDeck({ open: false });
      // No world coordinate survives the reference-space boundary, including a second AR entry on this page.
      this.release();
      this.clearAnnotations();
      this.targets.targets.clear(); this.poses.clear();
      for (const tag of this.modes.tags.values()) tag.position = undefined;
      this.roomAnchors.begin(s.session, this.identity?.deviceId ?? this.welcome?.deviceId ?? '', location.origin);
      this.setMode('annotate');
      this.onboarding.enter(performance.now());
      this.refreshHelper();
      void this.loadHelper();
      this.refSpace = s.refSpace;
      this.xrHit.attach(s.session, s.refSpace);
      this.input.attach(s.session);
      this.page.log(`XR: ${s.mode} (${s.attempt}) · features: ${s.features.join(', ') || 'unknown'}`, 'ok');
      this.page.setButton(this.page.enter, 'Exit AR');
      this.recorder.input('xr', { on: true, mode: s.mode });
      this.recorder.spaceBoundary('xr-start');
      s.session.addEventListener('visibilitychange', () => {
        if (this.session !== s.session || s.session.visibilityState !== 'hidden') return;
        // Hidden sessions may stop delivering frames. Cancel immediately, so neither a queued
        // widget move nor a held clutch can resume control without the wearer's next action.
        this.cancelManualRegion(); this.projects?.pauseForNavigation(); this.assistant?.cancel(); this.clearVirtualSelection();
        this.controls.clear(); this.clearHandControl(); this.hud.cancelInteractions?.(); this.refreshHome();
        this.recorder.pose(null, {}, true);
      });
      s.session.addEventListener('end', () => {
        if (this.session !== s.session) return;
        this.cancelManualRegion(); this.release();
        this.scanner.stop();
        this.hud.setDeck({ open: false });
        this.onboarding.leave();
        this.pairingUntil = 0;
        this.pairCodeRequest = null;
        this.refreshHelper();
        this.clearHandControl(); this.refreshHome();
        this.session = undefined;
        this.refSpace = undefined;
        this.xrHit.detach();
        this.roomAnchors.end();
        this.clearAnnotations();
        this.targets.targets.clear(); this.poses.clear();
        for (const tag of this.modes.tags.values()) tag.position = undefined;
        this.input.detach();
        this.page.setButton(this.page.enter, this.emulator ? 'Enter AR (emulated)' : 'Enter AR');
        this.page.log('XR session ended');
        this.recorder.input('xr', { on: false });
        if (this.recorder.recording) {
          this.recorder.spaceBoundary('xr-end');
          void this.finishRecording('AR session ended.');
        }
        this.recordingRefSpace?.removeEventListener('reset', this.onRecordingSpaceReset);
        this.recordingRefSpace = undefined;
      }, { once: true });
      const canvasProject = this.params.get('canvasProject');
      if (canvasProject) { this.params.delete('canvasProject'); this.onboarding.leave(); this.setMode('control'); this.openProjects(canvasProject); }
    } catch (e) {
      this.page.log(`XR failed: ${(e as Error).message}`, 'error');
    } finally {
      this.enteringXr = false;
    }
  }

  // --- record / replay ---------------------------------------------------------------------------------

  toggleRecord(): void {
    if (this.recordingFinalizing) return;
    if (this.recorder.recording) { void this.finishRecording(); return; }
    const k = this.capture.last?.intrinsics;
    const take = this.recorder.start({
      app: APP_VERSION,
      device: { kind: this.emulator ? 'emulator' : 'quest', name: this.identity?.name ?? (this.emulator ? 'Desktop emulator' : 'Quest') },
      camera: k ? { width: k.width, height: k.height, fx: k.fx, fy: k.fy, cx: k.cx, cy: k.cy } : { width: 1280, height: 960, fx: 868.31, fy: 868.31, cx: 640.18, cy: 482.07 },
      space: 'local-floor',
      tracking: { source: this.emulator ? 'emulator' : 'webxr', sampleRateHz: 30, jointConvention: 'webxr-hand-25', units: 'meters', axes: 'right-handed-y-up-negative-z-forward' },
      notes: `${this.emulator ? 'desktop emulator' : 'headset'} · camera ${this.camera.kind} · server ${this.serverMode || 'unknown'} · camera intrinsics are approximate, not calibrated`,
    });
    this.recorder.onLimit = (reason) => { void this.finishRecording(reason); };
    this.recordingVideo = new TakeVideoRecorder();
    const warning = (message: string) => { this.recorder.warning(message); this.page.log(message, 'warn'); };
    const videoIssue = this.recordingVideo.start(this.camera.kind === 'passthrough' ? this.camera.element : undefined, this.recorder.elapsedMs, warning, () => { void this.finishRecording('Camera recording stopped.'); });
    this.recordingHasVideo = !videoIssue;
    if (videoIssue) warning(videoIssue);
    this.page.log(`recording ${take}: ${this.recordingHasVideo ? 'camera video + hand/head tracking' : 'tracking only'} · maximum 90 seconds · no microphone audio`, 'ok');
    this.page.recordStatus(this.recordingHasVideo ? 'Recording camera + hand/head tracking. Enter AR; exit AR to finish. No audio. Maximum 90 seconds.' : 'Recording tracking only — camera video is unavailable. Enter AR to capture hand/head poses.');
    this.page.setButton(this.page.record, 'Stop recording', true);
    this.page.save.disabled = true;
    this.hud.toast(this.recordingHasVideo ? 'Recording video + tracking · exit AR to finish' : 'Recording tracking only · camera unavailable', this.recordingHasVideo ? 'ok' : 'warn');
  }

  private async finishRecording(reason = ''): Promise<void> {
    if (this.recordingFinalizing) return;
    this.recordingFinalizing = true;
    this.recordingRefSpace?.removeEventListener('reset', this.onRecordingSpaceReset);
    this.recordingRefSpace = undefined;
    this.recorder.stop();
    this.page.setButton(this.page.record, 'Finishing recording…', false, true);
    this.page.save.disabled = true;
    this.page.recordStatus('Finishing video…');
    try {
      const video = await this.recordingVideo?.stop();
      if (video) this.recorder.attachVideo(video.metadata, video.bytes);
      else if (this.recordingHasVideo) this.recorder.warning('No playable video bytes were produced; this take contains tracking data only.');
      const c = this.recorder.count;
      const description = `${Math.round(this.recorder.elapsedMs / 1000)} seconds · ${c.lines} events · ${this.recorder.videoBytes ? 'video + tracking' : 'tracking only'}`;
      this.page.log(`recording stopped: ${description}${reason ? ` · ${reason}` : ''}`, 'ok');
      this.page.recordStatus(`Ready to save: ${description}. Open the take ZIP in the Mac Motion lab.${reason ? ` ${reason}` : ''}`);
      this.hud.toast('Recording ready. Save take on the launcher page.', 'ok');
    } catch (error) {
      this.recorder.warning(`Video finalization failed: ${(error as Error).message}`);
      this.page.recordStatus('Tracking saved in memory. Video could not finish; use Save take to keep the tracking data.');
      this.page.log(`recording: ${(error as Error).message}`, 'warn');
    } finally {
      this.recordingVideo = undefined; this.recordingFinalizing = false;
      this.page.setButton(this.page.record, 'Record take');
      this.page.save.disabled = false;
    }
  }

  saveTake(): void {
    if (this.recorder.recording || this.recordingFinalizing || !this.recorder.take) return;
    const zip = this.recorder.toZip();
    const name = this.recorder.download(zip);
    if (!name) return;
    this.page.log(`saved ${name} in Downloads`, 'ok');
    // on the Mac the server keeps a copy in the repo (apps/quest/public/takes/<take>/), ready to replay and commit
    if (!isLocalPage()) return;
    const take = name.replace(/\.zip$/, '');
    const body = new Blob([zip as unknown as BlobPart], { type: 'application/zip' });
    void fetch(`/api/takes/${encodeURIComponent(take)}`, { method: 'POST', headers: { 'content-type': 'application/zip' }, body })
      .then(async (r) => {
        const j = (await r.json().catch(() => ({}))) as { dir?: string; files?: string[]; message?: string };
        if (r.ok) this.page.log(`take kept by the server: ${j.dir} (${j.files?.length ?? 0} files) · replay: /sim/?take=${take}`, 'ok');
        else this.page.log(`the server did not keep the take: ${j.message ?? `HTTP ${r.status}`}`, 'warn');
      })
      .catch((e) => this.page.log(`the server did not keep the take: ${(e as Error).message}`, 'warn'));
  }

  async startReplay(src: string | Uint8Array, mode: ReplayMode): Promise<void> {
    try {
      this.take = await loadTake(src);
    } catch (e) {
      this.page.log(`replay: ${(e as Error).message}`, 'error');
      return;
    }
    const base = typeof src === 'string' ? new URL(src, location.href).toString() : undefined;
    this.player?.stop();
    this.controls.clear();
    this.ws.setPlayback(mode === 'playback');
    const player = new TakePlayer(this.take, mode, base);
    this.player = player;
    player.on('pose', (h) => {
      if (h && this.emulator) this.emulator.setHead(new Vector3(h.position.x, h.position.y, h.position.z), new Quaternion(h.orientation.x, h.orientation.y, h.orientation.z, h.orientation.w));
    });
    player.on('frame', ({ record }) => this.capture.remember(record));
    player.on('in', (env: Envelope) => this.ws.inject(env));
    player.on('input', (i) => {
      if (i.type === 'lock' && Array.isArray(i.position)) {
        const p = new Vector3(...(i.position as [number, number, number]));
        const near = this.targets.list().sort((a, b) => a.position.distanceTo(p) - b.position.distanceTo(p))[0];
        if (near && near.position.distanceTo(p) < 0.5) this.lock(near.id, 'replay', { send: mode === 'pipeline' });
      }
      if (i.type === 'scan' && mode === 'pipeline') {
        if (i.on && !this.scanner.active) this.toggleScan();
        if (!i.on && this.scanner.active) this.toggleScan();
      }
    });
    player.on('end', () => this.page.log(`replay of ${this.take?.meta.take} finished`, 'ok'));
    if (mode === 'pipeline') {
      this.camera = new ReplayCamera(player, base);
      this.capture = new FrameCapture({ camera: this.camera, poses: this.poses, encoder: this.encoder, handJoints: () => [] });
      this.cameraState = 'off';
      await this.startCamera();
    }
    this.page.log(`replay ${this.take.meta.take} (${mode}) · ${this.take.lines.length} lines · ${Math.round(player.duration / 1000)} s · ${this.take.meta.notes ?? ''}`, 'ok');
    player.play();
  }

  // --- 2D page -------------------------------------------------------------------------------------------

  private setupUi(): void {
    const p = this.page;
    p.enter.onclick = () => void this.enterXr();
    p.prepare.onclick = () => void this.prepareMedia();
    p.scan.hidden = true;
    p.record.onclick = () => this.toggleRecord();
    p.save.onclick = () => this.saveTake();
    p.repair.onclick = () => {
      this.ws.stop();
      void this.repairPairing();
    };
    p.takeFile.onchange = async () => {
      const file = p.takeFile.files?.[0];
      if (!file) return;
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (file.name.endsWith('.jsonl')) {
        const url = URL.createObjectURL(file);
        await this.startReplay(url, p.takeMode.value as ReplayMode);
      } else await this.startReplay(bytes, p.takeMode.value as ReplayMode);
    };
    if (isLocalPage()) p.log('localhost page: the server treats this browser as the owner (auto-approved pairing)');
    window.addEventListener('keydown', (e) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.tagName === 'SELECT')) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      switch (e.key.toLowerCase()) {
        case 's':
          this.setMode('annotate');
          break;
        case 'l':
        case 'enter':
          if (this.candidate.shown) this.lock(this.candidate.shown, 'key');
          break;
        case 'escape':
          this.release();
          break;
        case 'p':
          this.onDeck('ping', 'press');
          break;
        case 'v':
          this.onDeck('mic', 'press');
          break;
        case 'u':
          this.onDeck('undo', 'press');
          break;
        case 'x':
          this.onDeck('panic', 'press');
          break;
        case 'r':
          this.toggleRecord();
          break;
        case 'a':
          if (this.pendingArm) this.answerConfirm(this.pendingArm, true);
          else this.approvals.approveFirst();
          break;
        case 'h':
          // keyboard stand-in for pinch-and-hold (irreversible hacks: printing)
          if (this.pendingArm) this.answerConfirm(this.pendingArm, true, true);
          break;
        case 'y':
          this.toggleLive();
          break;
        case 'm':
          this.setMode(this.modes.mode === 'annotate' ? 'control' : 'annotate');
          break;
        case 'c':
          // cycle the object filter
          if (this.live) this.setLiveCategory(CATEGORIES[(CATEGORIES.findIndex((x) => x.id === this.live!.category) + 1) % CATEGORIES.length]!.id);
          break;
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.key.toLowerCase() === 'v') this.onDeck('mic', 'release');
    });
  }

  private showLastFrame(jpeg: string, w: number, h: number, dets: ReturnType<typeof normalizeDetections>, note = ''): void {
    this.lastFrameShownAt = performance.now();
    void this.page.showFrame(jpeg, w, h, dets, note);
  }

  private lastPreviewFrame = '';

  private liveReadoutLines(): string[] {
    const l = this.live;
    if (!l) return [];
    const s = l.stats;
    if (s.state !== 'ready') return [`LIVE ${s.state.toUpperCase()}`, (s.lastError ?? '').slice(0, 60)];
    return [
      `LIVE yolox-nano · ${s.ep}${s.ep === 'wasm' ? `x${s.threads}` : ''} · ${l.running ? `${s.fps} fps` : 'idle'} · ${s.shown} box · ${l.category}`,
      `infer ${Math.round(s.inferMs)} ms · lat ${Math.round(s.latencyMs)} ms · every ${s.intervalMs} ms · frame ${s.frameMs.toFixed(1)}/${s.baselineMs.toFixed(1)} ms`,
    ];
  }

  private updateStatus(): void {
    const s = this.scanner.stats;
    const head = this.lastFrame?.head.position;
    this.page.status({
      device: this.identity ? `${this.identity.name} · ${this.identity.deviceId.slice(0, 8)}` : this.pairing.state.kind,
      server: this.welcome ? `${this.welcome.server} · ${this.welcome.mode}` : this.ws.state,
      xr: this.session ? `in session${this.emulator ? ' (IWER)' : ''}` : this.emulator ? 'emulator ready' : 'not in XR',
      camera: `${this.camera.kind} · ${this.cameraState}${this.cameraNote ? ` · ${this.cameraNote}` : ''}`,
      'camera fps': this.camera.kind === 'passthrough' ? `${this.camera.stats.fps}${this.camera.stats.captureTime ? ' · captureTime ✓' : ''}` : undefined,
      'live boxes': this.live ? this.live.summary() : 'off (?yolo=0)',
      scan: `${this.scanner.active ? 'ON' : 'off'} · sent ${s.sent} · results ${s.results} · in flight ${s.inFlight}${s.lastModelId ? ` · ${s.lastModelId} ${s.lastLatencyMs} ms` : ''}${this.fixture ? ' · FIXTURE' : ''}`,
      targets: this.targets.list().map((t) => `${t.label}${t.id === this.lockedId ? '🔒' : ''}`).join(', ') || 'none',
      head: head ? `${head.x.toFixed(2)} ${head.y.toFixed(2)} ${head.z.toFixed(2)}` : '',
      hud: this.hudKind,
      render: `${this.renderer.info.render.calls} draws · ${this.renderer.info.render.triangles} triangles`,
      mic: this.mic.ready ? `${this.ptt.listening ? 'LISTENING' : 'ready'}` : 'not prepared',
      record: this.recorder.recording ? `REC ${Math.round(this.recorder.elapsedMs / 1000)} s · ${this.recordingHasVideo ? 'video + tracking' : 'tracking only'}` : undefined,
      replay: this.player ? `${this.player.mode} ${Math.round(this.player.clock() / 1000)} / ${Math.round(this.player.duration / 1000)} s` : undefined,
      ws: `${this.ws.stats.sent} out · ${this.ws.stats.received} in${this.ws.stats.dropped ? ` · ${this.ws.stats.dropped} dropped` : ''}`,
    });
    // the last scan frame with its boxes
    const ls = this.lastShown;
    if (ls && ls.frameId !== this.lastPreviewFrame) {
      this.lastPreviewFrame = ls.frameId;
      const rec = this.capture.get(ls.frameId);
      const jpeg = this.frameJpegs.get(ls.frameId);
      if (rec && jpeg) this.showLastFrame(jpeg, rec.width, rec.height, ls.dets, `${rec.width}×${rec.height} · ${ls.dets.length} detection(s) · ${s.lastModelId}`);
    }
  }

  /** last few JPEGs we sent, for the page preview */
  readonly frameJpegs = new Map<string, string>();

  rememberJpeg(frameId: string, jpeg: string): void {
    this.frameJpegs.set(frameId, jpeg);
    while (this.frameJpegs.size > 6) this.frameJpegs.delete(this.frameJpegs.keys().next().value as string);
  }
}

export async function startApp(params: URLSearchParams): Promise<QuestApp> {
  const app = new QuestApp(params);
  (window as unknown as { __ce: QuestApp }).__ce = app;
  await app.init();
  // keep the JPEGs we send for the preview
  app.ws.tap('out', (m) => {
    if (m.type === 'scan.frame') {
      const p = m.payload as { frameId: string; jpeg: string };
      app.rememberJpeg(p.frameId, p.jpeg);
    }
  });
  return app;
}
