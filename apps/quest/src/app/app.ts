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
 *   scan=fixture       answer scan frames locally with recorded SAM 3.1 boxes (emulator + photo only)
 *   replay=<url>       a take (session.jsonl or .zip); replayMode=playback|pipeline
 *   record=1           start recording at load
 *   mic=0              never open the microphone (no AudioContext at all)
 *   hud=v2|v1|debug    compact HUD (default), original HUD, or shell debug HUD
 *   dominant=left      left-handed: the deck opens over the RIGHT palm
 *   ws=<url>           WebSocket override
 *   yolo=0|1           live boxes from the on-device YOLOX-nano detector while scanning (default 1)
 *   yoloep=webgpu|wasm force the detector's execution provider (default: WebGPU when available)
 *   track=<category>   initial live-box category: everything|electronics|instruments|lights|remotes
 *   debug=1            in-headset hand tracking, rendering and detector diagnostics
 */
import type { Channel, ControlEvent, Gen3dSpec, HackItem, HudStatus, ModelChip } from '@ce/gen3d';
import type { AgentStepPayload, PayloadOf, TargetState } from '@ce/protocol';
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
import { type ReplayMode, ReplayCamera, TakePlayer } from '../replay/player';
import { Recorder } from '../replay/recorder';
import { loadTake, type Take } from '../replay/take';
import { type AimHit, type AimTarget, aimAt, touching } from '../scan/aim';
import { type CameraSource, CameraError, LiveCamera } from '../scan/camera';
import { FrameCapture } from '../scan/capture';
import { JpegEncoder } from '../scan/encode';
import { fixtureFromSimLayout, loadSamFixture, type SamFixture } from '../scan/fixture';
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
import { ControlSender } from './controls';
import { ModeState } from './modes';
import type { AppMode, HudTarget, ObjectFilter } from '../hud/contract';
import { annotationFadeMs, annotationRange, matchesAnnotationFilter, inAnnotationRange } from '../scan/policy';
import { type Emulator, installEmulator } from './emulator';
import { HandFeedback } from './hand-feedback';
import { THEME as HUD_V2_THEME } from '../hud/v2/theme';
import type { Handedness, Hud, ShellFrame } from './hud-contract';
import { type HudKind, loadHud } from './hud-loader';
import { handJointPositions, InputSampler } from './input';
import { Page } from './page';
import { frameReferenceSpace, startXr, xrSupport } from './xr';

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
  readonly modes = new ModeState();
  filter: ObjectFilter = 'everything';
  private readonly observed = new Map<string, { target: HudTarget; at: number }>();
  private readonly visibleTargets = new Set<string>();
  private readonly armedCards = new Set<string>();
  private readonly cancelledCards = new Set<string>();
  private lastAnnotationsAt = 0;
  private readonly deferredSpecs = new Map<string, UiSpecPayload>();
  private readonly controlValues = new Map<string, ControlEvent['value']>();
  private readonly generated = new Map<string, Gen3dSpec>();
  private drawTarget?: (target: HudTarget) => void;
  private eraseTarget?: (id: string) => void;
  private pendingMode?: AppMode;
  private activeSetup?: string;
  private armRequest?: ArmRequestPayload;
  private acceptedArm?: string;
  private pairingUntil = 0;
  private lastPairFrame = 0;
  private pairCapturing = false;
  private palmOpened = false;
  private handMapping?: { targetId: string; specId: string; controlId: string; originY?: number; value: number; current: number; lastAt: number };
  readonly xrHit = new XrHitTester();
  readonly handheld = new HandheldTracker();
  readonly recorder = new Recorder();
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
  private readonly consumed = { left: false, right: false };
  private readonly specByCard = new Map<string, string>();
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

  constructor(params: URLSearchParams) {
    this.params = params;
    this.nonDominant = params.get('dominant') === 'left' ? 'right' : 'left';
  }

  // --- boot ------------------------------------------------------------------------------------

  async init(): Promise<void> {
    this.setupRenderer();
    const support = await xrSupport();
    const emulate = this.params.has('emulate') ? this.params.get('emulate') !== '0' : !support.ar;
    if (emulate) {
      this.emulator = await installEmulator({ devui: this.params.get('devui') === '1', canvas: this.renderer.domElement });
      this.input.mouseAsHand = true;
      this.page.log(`desktop emulator: IWER ${this.emulator.device.version} (${this.emulator.device.name}${this.emulator.devui ? ', DevUI' : ''})`, 'ok');
    }
    await this.setupHud();
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
    if (this.params.get('record') === '1') this.toggleRecord();
    const xrOk = emulate || support.ar;
    this.page.setButton(this.page.enter, emulate ? 'Enter AR (emulated)' : 'Enter AR', false, !xrOk);
    this.page.xrMessage(xrOk ? (emulate ? 'IWER emulates a Quest 3 in this browser. Click = pinch, right-drag = look.' : 'Tap "Camera + mic" first, then Enter AR.') : 'This browser has no immersive-ar. Use Quest Browser, or open with ?emulate=1.');
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
        void this.room.ready.then(() => {
          const layout = this.room?.sim?.layout;
          if (!layout?.devices?.length) {
            this.page.log('scan fixture: the sim embed exposes no layout', 'warn');
            return;
          }
          this.fixture = fixtureFromSimLayout(layout);
          this.page.log(`scan fixture: ${layout.devices.length} exact boxes from the sim layout (labelled sim-layout, not a model)`, 'warn');
        });
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
      if (on && this.modes.mode === 'annotate') {
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
    const { hud, kind, error } = await loadHud({ scene: this.scene, camera: this.desktopCam, renderer: this.renderer }, this.params.get('hud'));
    this.hud = hud;
    this.hudKind = kind;
    this.drawTarget = hud.upsertTarget.bind(hud);
    this.eraseTarget = hud.removeTarget.bind(hud);
    hud.upsertTarget = (target) => this.observeTarget(target);
    hud.removeTarget = (id) => {
      this.observed.delete(id);
      if (!this.modes.tags.has(id)) { this.eraseTarget?.(id); this.visibleTargets.delete(id); }
    };
    this.refreshHome();
    if (kind === 'v2') this.handFeedback.setAppearance({ accent: HUD_V2_THEME.color.accent, showHover: false });
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
    hud.on('mode', (e) => this.setMode(e.mode));
    hud.on('filter', (e) => this.setLiveCategory(e.filter));
    hud.on('tagRemove', (e) => this.untag(e.targetId));
    hud.on('setup', (e) => this.setupControl(e.targetId));
    hud.on('cancel', (e) => this.cancelControl(e.targetId));
    hud.on('pair', (e) => this.pairDevice(e.targetId));
    hud.on('handControl', (e) => this.setHandControl(e.targetId, e.enabled));
    hud.on('deck', (e) => this.onDeck(e.key, e.phase));
    hud.on('hack', (e) => this.onHack(e));
    hud.on('control', (e) => this.onControl(e));
    hud.on('approve', (e) => (e.approve ? this.approvals.approve(e.pairingId) : this.approvals.deny(e.pairingId)));
    hud.on('confirm', (e) => this.answerConfirm(e.id, e.approve, e.hold));
    hud.on('grab', (e) => this.recorder.input('grab', e as unknown as Record<string, unknown>));
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
    this.controls = new ControlSender((p) => { if (p.specId && this.canControl(this.cardOfSpec.get(p.specId))) this.ws.send('control.event', p); }, 30);
    this.approvals = new Approvals(this.ws);
    this.ptt = new PushToTalk(this.mic, this.ws, () => WsClient.allowsSavedToken(this.ws.url) ? this.identity?.deviceToken : undefined, () => {
      const cardId = this.lockedId ? this.modes.tags.get(this.lockedId)?.cardId : undefined;
      return { cardId, specId: cardId ? this.specByCard.get(cardId) : undefined };
    });
    this.ws.tap('out', (m) => this.recorder.message('out', m));
    this.ws.tap('in', (m) => this.recorder.message('in', m));
    this.ws.onState = (s, info) => {
      this.page.badge('b-ws', s, s === 'open' ? 'ok' : s === 'connecting' ? 'warn' : 'bad');
      if (s === 'closed') {
        const active = this.activeSetup ? this.modes.byCard(this.activeSetup) : undefined;
        if (active) this.cancelControl(active.targetId);
        this.controls.clear(); this.modes.disconnected(); this.refreshHome(); this.refreshTags();
      }
      if (s === 'closed' && info) this.page.log(`socket closed (${info.code}${info.reason ? ` ${info.reason}` : ''}); reconnecting`, 'warn');
    };
    this.ws.onUnauthorized = () => {
      this.page.log('the server revoked this headset; pairing again', 'warn');
      void this.pairing.repair().then((id) => {
        this.identity = id;
        this.ws.restart();
      });
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
      this.hud.showApprovals(list);
      this.page.showApprovals(list, (id, ok) => (ok ? this.approvals.approve(id) : this.approvals.deny(id)));
      if (list.length) this.hud.toast(`${list[0].name} wants to join · ${list[0].display}`, 'info');
    });
    this.approvals.on('resolved', (r) => this.page.log(`pairing ${r.approved ? 'approved' : 'denied'}${r.name ? `: ${r.name}` : ''}`, r.approved ? 'ok' : 'warn'));
    this.ptt.on('listening', ({ listening }) => {
      this.hud.setVoice({ listening });
      if (listening) this.chip('muse-voice-transcribe-1.0', 'live');
    });
    this.ptt.on('level', (l) => this.ptt.listening && this.hud.setVoice({ listening: true, level: l }));
    this.ptt.on('text', (t) => {
      this.hud.setVoice(t.final ? { listening: false, final: t.text } : { listening: this.ptt.listening, partial: t.text });
      if (t.final) {
        this.chip(t.modelId ?? 'muse-voice-transcribe-1.0', 'done');
        this.page.log(`voice${t.via === 'http' ? ' (http fallback)' : ''}: “${t.text}”${t.modelId ? ` · ${t.modelId}` : ''}`, 'ok');
      }
    });
    this.ptt.on('error', (e) => {
      this.page.log(e, 'warn');
      this.hud.toast(e, 'warn');
    });
    this.wireMessages();
  }

  setMode(mode: AppMode, send = true): void {
    if (mode !== 'annotate' && mode !== 'control') return;
    if (mode !== this.modes.mode) {
      if (this.activeSetup) {
        const tag = this.modes.byCard(this.activeSetup);
        if (tag) this.cancelControl(tag.targetId);
      }
      this.controls?.clear();
      this.release();
      this.hud.hideHackMenu();
      this.hud.showConfirm(null);
    }
    this.modes.mode = mode;
    if (send) {
      this.pendingMode = mode;
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
    this.hud.setHome?.({ mode: this.modes.mode, filter: this.filter, tagged: this.modes.tags.size,
      status: homeHint(this.modes.mode, this.modes.tags.size, !!this.lockedId),
      canStop: !!this.activeSetup || this.armedCards.size > 0 });
    const tag = this.lockedId ? this.modes.tags.get(this.lockedId) : undefined;
    this.hud.setDeviceState?.(tag ? { targetId: tag.targetId, connection: tag.connection, hint: tag.hint,
      busy: tag.busy, sentence: tag.sentence, handControl: this.handMapping?.targetId === tag.targetId } : null);
  }

  private observeTarget(target: HudTarget): void {
    if (/\b(person|people|human)\b/i.test(target.label)) return;
    const tag = this.modes.tags.get(target.id);
    if (tag) {
      tag.position = { x: target.position[0], y: target.position[1], z: target.position[2] };
      target = { ...target, label: tag.name || tag.label, tagged: true, connection: tag.connection, identifying: !tag.name?.trim(), busy: tag.busy };
    }
    this.observed.set(target.id, { target, at: Date.now() });
    this.refreshAnnotations(true);
  }

  /** One budget shared by both detectors. Tagged anchors survive detection expiry. */
  private refreshAnnotations(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastAnnotationsAt < 80) return;
    this.lastAnnotationsAt = now;
    const head = this.lastFrame?.head.position ?? this.desktopCam.position;
    const range = annotationRange(this.params.get('range'));
    const show = new Set<string>();
    const draw: HudTarget[] = [];
    for (const [id, tag] of this.modes.tags) {
      const observed = this.observed.get(id);
      if (!observed || !inAnnotationRange(observed.target.position, head, range)) continue;
      show.add(id);
      if (force || !this.visibleTargets.has(id)) draw.push({ ...observed.target, tagged: true, connection: tag.connection,
        label: tag.name || tag.label, identifying: !tag.name?.trim(), busy: tag.busy });
    }
    if (this.modes.mode === 'annotate') {
      const candidates = [...this.observed.values()].filter(({ target, at }) => !this.modes.tags.has(target.id)
        && now - at <= annotationFadeMs(isLiveId(target.id)) && (target.score ?? 0) >= 0.5 && matchesAnnotationFilter(target.label, this.filter)
        && inAnnotationRange(target.position, head, range));
      candidates.sort((a, b) => (b.target.score ?? 0) - (a.target.score ?? 0));
      for (const { target } of candidates.slice(0, Math.max(0, 6 - show.size))) {
        show.add(target.id);
        if (force || !this.visibleTargets.has(target.id)) draw.push(target);
      }
    }
    for (const id of this.visibleTargets) if (!show.has(id)) this.eraseTarget?.(id);
    for (const target of draw) this.drawTarget?.(target);
    this.visibleTargets.clear();
    for (const id of show) if (this.hudKind !== 'v2' || this.hud.isTargetVisible?.(id)) this.visibleTargets.add(id);
    for (const [id, observed] of this.observed) if (now - observed.at > 15_000 && !this.modes.tags.has(id)) {
      this.observed.delete(id); this.targets.remove(id);
    }
  }

  private materializeTarget(snapshot: HudTarget): Target {
    const target = this.targets.upsert({ detId: '', label: snapshot.label, score: snapshot.score ?? 1, box: [0, 0, 1, 1] },
      { position: new Vector3().fromArray(snapshot.position), facing: new Vector3().fromArray(snapshot.facing ?? [0, 0, 1]),
        sizeM: snapshot.sizeM ?? [0.25, 0.2, 0.1], confirmed: snapshot.confirmed, method: 'tracked', depth: 1 }, '', snapshot.modelId).target;
    return target;
  }

  private onTagsState(payload: PayloadOf<'tags.state'>): void {
    if (this.activeSetup && !payload.tags.some((tag) => tag.cardId === this.activeSetup)) {
      const active = this.modes.byCard(this.activeSetup);
      if (active) this.cancelControl(active.targetId);
    }
    const removed = this.modes.snapshot(payload.tags);
    for (const tag of removed) {
      if (tag.cardId) { this.armedCards.delete(tag.cardId); this.controls.clear(); }
      const target = this.targets.get(tag.targetId);
      if (target) target.label = tag.label;
      if (this.lockedId === tag.targetId) this.release();
      this.hud.removeTarget(tag.targetId);
    }
    for (const tag of this.modes.tags.values()) {
      let target = this.targets.get(tag.targetId);
      if (!target && tag.position) {
        const p = tag.position;
        target = this.materializeTarget({ id: tag.targetId, label: tag.label, position: [p.x, p.y, p.z], confirmed: true, status: 'locked' });
        // A stored tag keeps one stable local id, including after reconnect.
        this.targets.targets.delete(target.id);
        target.id = tag.targetId;
        this.targets.targets.set(target.id, target);
      }
      if (target) { target.cardId = tag.cardId; target.label = tag.name ?? tag.label; }
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

  private refreshTags(): void {
    for (const tag of this.modes.tags.values()) {
      const target = this.targets.get(tag.targetId);
      if (target) this.hud.upsertTarget(toHudTarget(target));
    }
    this.refreshAnnotations(true);
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

  setupControl(targetId: string): void {
    if (!this.modes.canSetup(targetId)) return;
    const tag = this.modes.tags.get(targetId)!;
    if (this.activeSetup && this.activeSetup !== tag.cardId) return;
    this.cancelledCards.delete(tag.cardId!);
    this.deferredSpecs.delete(tag.cardId!);
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
    this.cancelledCards.add(tag.cardId);
    this.ws.send('control.cancel', { cardId: tag.cardId }, { to: 'server' });
    tag.busy = false; tag.sentence = 'Setup cancelled.';
    this.activeSetup = undefined; this.pendingArm = undefined; this.armRequest = undefined; this.acceptedArm = undefined;
    this.armedCards.delete(tag.cardId); this.controls.clear(); this.handMapping = undefined;
    const specId = this.specByCard.get(tag.cardId);
    if (specId) this.hud.setArmed(this.gen3dIdFor(specId), false);
    this.hud.showConfirm(null); this.refreshHome();
  }

  private canControl(cardId: string | undefined): boolean {
    const tag = cardId ? this.modes.byCard(cardId) : undefined;
    return this.modes.mode === 'control' && !!cardId && !!tag && tag.connection === 'ready'
      && this.visibleTargets.has(tag.targetId) && this.armedCards.has(cardId) && !this.cancelledCards.has(cardId) && this.lockedId === tag.targetId;
  }

  private pairDevice(targetId: string): void {
    if (this.modes.mode !== 'control' || !this.modes.tags.has(targetId)) return;
    this.pairingUntil = performance.now() + 30_000;
    this.lastPairFrame = 0;
    void this.startCamera();
    this.refreshHome();
  }

  private async capturePairing(time: number): Promise<void> {
    if (time >= this.pairingUntil || this.modes.mode !== 'control') { this.pairingUntil = 0; this.refreshHome(); return; }
    if (this.pairCapturing || time - this.lastPairFrame < 1000) return;
    this.pairCapturing = true; this.lastPairFrame = time;
    try {
      const frame = await this.capture.capture('pair');
      if (frame && this.pairingUntil && this.modes.mode === 'control') this.ws.send('scan.frame', frame.payload, { to: 'server', droppable: true });
    } finally { this.pairCapturing = false; }
  }

  private setHandControl(targetId: string, enabled: boolean): void {
    this.handMapping = undefined;
    const tag = this.modes.tags.get(targetId);
    const spec = tag?.cardId ? this.generated.get(tag.cardId) : undefined;
    if (enabled && this.canControl(tag?.cardId) && spec && /synth|keyboard|midi/i.test(`${tag?.category} ${spec.device?.category} ${tag?.label}`)) {
      const control = spec.controls.find((c) => (c.kind === 'continuous' || c.kind === 'stepped') && c.armed !== false);
      if (control) {
        const value = Number(this.controlValues.get(`${spec.specId}:${control.id}`) ?? control.default ?? control.range?.min ?? 0);
        this.handMapping = { targetId, specId: spec.specId, controlId: control.id, value, current: value, lastAt: 0 };
      }
    }
    this.refreshHome();
  }

  private updateHandControl(frame: ShellFrame, time: number): void {
    const mapping = this.handMapping;
    if (!mapping) return;
    const tag = this.modes.tags.get(mapping.targetId);
    if (!this.canControl(tag?.cardId)) { this.handMapping = undefined; this.refreshHome(); return; }
    const wrist = frame.hands.right?.joints.wrist?.position;
    if (!wrist) { mapping.originY = undefined; mapping.value = mapping.current; return; }
    if (mapping.originY === undefined) { mapping.originY = wrist.y; return; }
    if (time - mapping.lastAt < 50) return;
    const spec = this.generated.get(tag!.cardId!);
    const control = spec?.controls.find((c) => c.id === mapping.controlId);
    if (!control) return;
    const range = control.range ?? { min: 0, max: 1 };
    let value = Math.max(range.min, Math.min(range.max, mapping.value + (wrist.y - mapping.originY) / 0.4 * (range.max - range.min)));
    if (range.step) value = range.min + Math.round((value - range.min) / range.step) * range.step;
    mapping.lastAt = time; mapping.current = value;
    this.onControl({ specId: mapping.specId, controlId: mapping.controlId, value, phase: 'move', ts: Date.now() });
    this.hud.setControlValue(mapping.specId, mapping.controlId, value);
  }

  private helloPayload(): PayloadOf<'hello'> {
    return { deviceToken: WsClient.allowsSavedToken(this.ws.url) || this.freshSocketIdentity ? this.identity?.deviceToken ?? '' : '', role: 'hmd', capabilities: ['camera', 'mic', 'hands', 'display'], app: APP_VERSION };
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
    ws.on('welcome', (m) => {
      this.welcome = m.payload as PayloadOf<'welcome'>;
      this.serverMode = this.welcome.mode;
      this.pendingMode = this.modes.mode;
      this.ws.send('mode.set', { mode: this.modes.mode }, { to: 'server' });
      for (const tag of this.modes.tags.values()) if (tag.pending) this.ws.send('tag.add', tag.pending, { to: 'server' });
      for (const cardId of this.modes.removals) this.ws.send('tag.remove', { cardId }, { to: 'server' });
      this.page.badge('b-mode', this.welcome.mode === 'live' ? 'LIVE' : 'FIXTURE', this.welcome.mode === 'live' ? 'ok' : 'warn');
      this.page.log(`connected: ${this.welcome.name} (${this.welcome.kind}) · ${this.welcome.server} · ${this.welcome.mode}${this.welcome.canApprove ? ' · approver' : ''}`, 'ok');
    });
    ws.on('mode.state', (m) => {
      const { mode } = m.payload as PayloadOf<'mode.state'>;
      // An old acknowledgement must not undo a newer local toggle.
      if (this.pendingMode && this.pendingMode !== mode) return;
      this.pendingMode = undefined;
      this.setMode(mode, false);
    });
    ws.on('tags.state', (m) => this.onTagsState(m.payload as PayloadOf<'tags.state'>));
    ws.on('log', (m) => {
      const p = m.payload as PayloadOf<'log'>;
      if (p.level === 'error' || p.level === 'warn') {
        this.page.log(`server: ${p.message}${p.issues?.length ? ` (${p.issues.slice(0, 3).join('; ')})` : ''}`, p.level === 'error' ? 'error' : 'warn');
      }
    });
    ws.on('scan.result', (m) => {
      const p = m.payload as ScanResultPayload;
      if (this.modes.mode === 'annotate') void this.scanner.onResult(p);
      if (p.qr?.some((q) => q.approved)) { this.pairingUntil = 0; this.refreshHome(); }
      if (p.qr?.length) for (const q of p.qr) this.page.log(`QR seen${q.approved ? ' → approved' : ''}: ${q.text.slice(0, 60)}`, q.approved ? 'ok' : 'info');
    });
    ws.on('target.status', (m) => this.onTargetStatus(m.payload as TargetStatusPayload));
    ws.on('device.card', (m) => this.onDeviceCard(m.payload as PayloadOf<'device.card'>));
    ws.on('agent.step', (m) => this.onAgentStep(m.payload as AgentStepPayload));
    ws.on('link.request', (m) => this.onLinkRequest(m.payload as LinkRequestPayload));
    ws.on('link.result', (m) => this.onLinkResult(m.payload as LinkResultPayload));
    ws.on('driver.status', (m) => this.onDriverStatus(m.payload as PayloadOf<'driver.status'>));
    ws.on('verify.result', (m) => this.onVerify(m.payload as VerifyResultPayload));
    ws.on('arm.request', (m) => this.onArmRequest(m.payload as ArmRequestPayload));
    ws.on('arm.result', (m) => this.onArmResult(m.payload as PayloadOf<'arm.result'>));
    ws.on('ui.spec', (m) => this.onUiSpec(m.payload as UiSpecPayload));
    ws.on('sense.request', (m) => void this.onSenseRequest(m.payload as SenseRequestPayload));
    ws.on('panic', (m) => {
      const p = m.payload as PayloadOf<'panic'>;
      this.stopControls();
      this.hud.toast(`Stopped${p.reason ? ` · ${p.reason}` : ''}`, 'warn');
    });
    ws.on('control.event', (m) => {
      // another client moved a control: mirror it without re-emitting
      const p = m.payload as PayloadOf<'control.event'>;
      if (m.from === this.identity?.deviceId || !p.specId) return;
      const gen3dId = [...this.uiSpecOfGen3d.entries()].find(([, ui]) => ui === p.specId)?.[0] ?? p.specId;
      this.controlValues.set(`${gen3dId}:${p.widgetId}`, p.value);
      this.hud.setControlValue(gen3dId, p.widgetId, p.value);
    });
  }

  private lastShown?: { frameId: string; dets: ReturnType<typeof normalizeDetections> };

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
    if (this.armRequest?.armId !== p.armId || this.armRequest.cardId !== p.cardId || this.activeSetup !== p.cardId) return;
    if (p.armed && this.acceptedArm !== p.armId) return;
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
    if (!this.modes.byCard(p.cardId) || (this.activeSetup !== p.cardId && this.modes.byCard(p.cardId)?.connection !== 'ready')) {
      this.deferredSpecs.set(p.cardId, p);
      while (this.deferredSpecs.size > 64) this.deferredSpecs.delete(this.deferredSpecs.keys().next().value!);
      return;
    }
    // a card's spec sits at that device; a room-level spec (no cardId: daemons, combos) floats on its own
    const t = p.cardId ? this.targetForCard(p.cardId) : undefined;
    const menuKey = p.cardId ? (t?.id ?? p.cardId) : `room:${p.specId}`;
    if (p.cardId) {
      this.specByCard.set(p.cardId, p.specId);
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
    if (p.kind !== 'frame') {
      this.ws.send('sense.result', { senseId: p.senseId, kind: p.kind, at: Date.now(), ok: false, error: 'the headset senses frames only' }, { to: 'server' });
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
    if (t && this.lastFrame && !this.inCameraView(t.position)) {
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
    // tells the camera oracle whether absolute luma is comparable across the before/after pair
    if (r.payload.camera && this.camera instanceof LiveCamera) r.payload.camera.exposure = this.exposureLocked ? 'locked' : 'auto';
    this.ws.send('sense.result', { senseId: p.senseId, kind: 'frame', frame: r.payload, at: Date.now(), ok: true }, { to: 'server' });
    this.lastShown = { frameId: r.payload.frameId, dets: [] };
    this.showLastFrame(r.payload.jpeg, r.payload.width, r.payload.height, [], `verify frame${p.cardId ? ` · ${p.cardId.slice(-6)}` : ''}`);
    this.page.log(`sense.request → verify frame ${r.payload.frameId.slice(-6)} (${Math.round(r.record.bytes / 1024)} KB)`);
  }

  // --- HUD events ----------------------------------------------------------------------------------

  onDeck(key: string, phase: 'press' | 'release'): void {
    if (key !== 'panic' || phase !== 'press' || this.modes.mode !== 'control') return;
    this.stopControls();
    this.ws.send('panic', { reason: 'Stop from the home bar' }, { to: 'server' });
    this.hud.toast('Stopped', 'warn');
  }

  private stopControls(): void {
    for (const tag of this.modes.tags.values()) if (tag.cardId && (this.armedCards.has(tag.cardId) || this.activeSetup === tag.cardId)) {
      this.cancelledCards.add(tag.cardId);
      tag.busy = false; tag.sentence = 'Stopped. Set up control to continue.';
      if (tag.connection === 'ready') tag.connection = 'setup';
    }
    this.activeSetup = undefined; this.pendingArm = undefined; this.armRequest = undefined; this.acceptedArm = undefined;
    this.armedCards.clear(); this.controls.clear(); this.handMapping = undefined;
    for (const specId of this.specByCard.values()) this.hud.setArmed(this.gen3dIdFor(specId), false);
    this.hud.showConfirm(null); this.release(); this.refreshTags();
  }

  /** Desktop helper: scanning is automatic whenever Annotate is active. */
  toggleScan(): void {
    if (this.modes.mode !== 'annotate') return;
    if (this.cameraState !== 'on') void this.startCamera();
    this.scanner.start();
  }

  private lastHack = { key: '', at: 0 };

  private onHack(e: { targetId: string; itemId: string; controlId?: string; index: number; hold?: boolean }): void {
    // one pinch = one action on a real device: drop a repeat of the same hack within 400 ms
    const key = `${e.targetId}:${e.itemId}`;
    const now = performance.now();
    if (key === this.lastHack.key && now - this.lastHack.at < 400) return;
    this.lastHack = { key, at: now };
    // the pinch IS the human confirmation: an action hack fires as {widgetId: hackId, value: true, phase: 'end'}
    const t = this.targets.get(e.targetId);
    if (!t?.cardId || !this.canControl(t.cardId) || this.lockedId !== t.id) return;
    const specId = this.menuSpec.get(e.targetId) ?? (t?.cardId ? this.specByCard.get(t.cardId) : undefined);
    const payload: PayloadOf<'control.event'> = { widgetId: e.itemId, value: true, ts: Date.now(), phase: 'end' };
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
    // One-shot commands execute on release; their activation value must stay true.
    this.controls.push({ ...e, value: control?.kind === 'trigger' ? true : e.value, specId: ui });
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
        aim = { id: t.id, position: t.position, size: 0 };
        this.aimTargets.set(t.id, aim);
      }
      aim.size = Math.max(0.06, t.sizeM[0], t.sizeM[1]);
      list.push(aim);
    }
    for (const id of this.aimTargets.keys()) if (!this.targets.get(id)) this.aimTargets.delete(id);
    if (this.modes.mode === 'annotate') this.live?.appendAimables(list);
    for (let i = list.length - 1; i >= 0; i--) if (!this.visibleTargets.has(list[i]!.id)) list.splice(i, 1);
    return list;
  }

  private interact(f: ShellFrame, time: number): void {
    const list = this.aimList();
    this.handFeedback.setHover('left');
    this.handFeedback.setHover('right');
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
    const show = id && id !== this.lockedId && time - this.candidate.since >= 250 ? id : null;
    if (show !== this.candidate.shown) {
      this.candidate.shown = show;
      this.hud.setCandidate(show);
    }
    for (const hand of HANDS) {
      const h = f.hands[hand];
      if (!h || this.consumed[hand]) continue;
      const handAim = h.ray.dir.lengthSq() > 0.5 ? aimAt(h.ray.origin, h.ray.dir, list, HAND_AIM, this.handHit) : null;
      if (handAim) this.handFeedback.setHover(hand, this.targets.get(handAim.id) ?? this.live?.hoverTarget(handAim.id));
      if (!h.justPinched) continue;
      // A system pinch can arrive without joints; only a measured midpoint can refine a target.
      if (!h.controller && h.joints['thumb-tip'] && h.joints['index-finger-tip']) {
        const touch = touching(h.pinchPoint, list, 0.06, this.touchHit);
        if (touch) {
          this.lock(touch.id, 'touch');
          continue;
        }
      }
      const pick = handAim?.id ?? this.candidate.shown ?? null;
      if (!pick) continue;
      this.lock(pick, handAim ? 'ray' : 'gaze');
    }
  }

  /** Select a device; annotation only records an explicit tag. */
  lock(id: string, how = 'api', opts: { send?: boolean } = {}): void {
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
    if (this.activeSetup && this.activeSetup !== this.modes.tags.get(id)?.cardId) {
      const active = this.modes.byCard(this.activeSetup);
      if (active) this.cancelControl(active.targetId);
    }
    this.handMapping = undefined;
    this.pairingUntil = 0;
    this.lockedId = id;
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
    this.handMapping = undefined;
    this.pairingUntil = 0;
    this.lockedId = null;
    this.hud.setLocked(null);
    this.hud.setDeviceState?.(null);
    this.refreshHome();
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
    this.recorder.pose(f.head);
    if (inXr && xrFrame) this.xrHit.onFrame(xrFrame);
    if (inXr && this.camera instanceof LiveCamera) this.camera.pollFromXr(time);
    this.room?.update(time);
    this.deckGesture(f, time);
    this.refreshAnnotations();
    this.updateHandControl(f, time);
    if (this.pairingUntil) void this.capturePairing(time);
    for (const m of this.handheld.update(this.wrists(f), time, this.heldMoves)) {
      const t = this.targets.get(m.id);
      if (!t) continue;
      t.position.copy(m.position);
      this.hud.upsertTarget(toHudTarget(t));
    }
    this.consumed.left = this.consumed.right = false;
    if (this.mouseCursor) {
      // gen3d gets the mouse as its dev cursor, not also as a hand
      this.mouseCursor.update();
      const hands = { ...f.hands };
      if (hands.right?.controller && this.input.mouseAsHand) delete hands.right;
      this.hud.update({ ...f, hands });
    } else this.hud.update(f);
    this.interact(f, time);
    this.handFeedback.update(f, this.input.diagnostics, this.renderer.info.render.calls);
    this.scanner.tick(time);
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

  private deckGesture(f: ShellFrame, _time: number): void {
    const hand = f.hands[this.nonDominant];
    if (!hand?.palmUp) { if (this.palmOpened) this.hud.setDeck({ open: false }); this.palmOpened = false; return; }
    if (this.palmOpened || hand.palmUpMs < 500) return;
    const wrist = hand.joints.wrist?.position;
    if (!wrist) return;
    this.palmOpened = true;
    this.hud.setDeck({ open: true, at: [wrist.x, wrist.y + 0.15, wrist.z] });
  }

  // --- camera, XR ------------------------------------------------------------------------------------

  async startCamera(): Promise<void> {
    if (this.cameraState === 'on' || this.cameraState === 'starting') return;
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
      this.setMode('annotate');
      this.refSpace = s.refSpace;
      this.xrHit.attach(s.session, s.refSpace);
      this.input.attach(s.session);
      this.page.log(`XR: ${s.mode} (${s.attempt}) · features: ${s.features.join(', ') || 'unknown'}`, 'ok');
      this.page.setButton(this.page.enter, 'Exit AR');
      this.recorder.input('xr', { on: true, mode: s.mode });
      s.session.addEventListener('end', () => {
        if (this.session !== s.session) return;
        this.scanner.stop();
        this.session = undefined;
        this.refSpace = undefined;
        this.xrHit.detach();
        this.input.detach();
        this.page.setButton(this.page.enter, this.emulator ? 'Enter AR (emulated)' : 'Enter AR');
        this.page.log('XR session ended');
        this.recorder.input('xr', { on: false });
      }, { once: true });
    } catch (e) {
      this.page.log(`XR failed: ${(e as Error).message}`, 'error');
    } finally {
      this.enteringXr = false;
    }
  }

  // --- record / replay ---------------------------------------------------------------------------------

  toggleRecord(): void {
    if (this.recorder.recording) {
      this.recorder.stop();
      const c = this.recorder.count;
      this.page.log(`recording stopped: ${c.lines} lines, ${c.frames} frames (${Math.round(this.recorder.frameBytes / 1024)} KB)`, 'ok');
      this.page.setButton(this.page.record, 'Record');
      this.page.save.disabled = false;
      return;
    }
    const k = this.capture.last?.intrinsics;
    const take = this.recorder.start({
      app: APP_VERSION,
      device: { kind: 'quest', name: this.identity?.name ?? 'Quest' },
      camera: k ? { width: k.width, height: k.height, fx: k.fx, fy: k.fy, cx: k.cx, cy: k.cy } : { width: 1280, height: 960, fx: 868.31, fy: 868.31, cx: 640.18, cy: 482.07 },
      space: 'local-floor',
      notes: `${this.emulator ? 'desktop emulator' : 'headset'} · camera ${this.camera.kind} · server ${this.serverMode || 'unknown'}`,
    });
    this.page.log(`recording ${take}`, 'ok');
    this.page.setButton(this.page.record, 'Stop rec', true);
  }

  saveTake(): void {
    const name = this.recorder.download();
    if (!name) return;
    this.page.log(`saved ${name} in Downloads`, 'ok');
    // on the Mac the server keeps a copy in the repo (apps/quest/public/takes/<take>/), ready to replay and commit
    if (!isLocalPage()) return;
    const take = name.replace(/\.zip$/, '');
    const body = new Blob([this.recorder.toZip() as unknown as BlobPart], { type: 'application/zip' });
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
      if (this.emulator) this.emulator.setHead(new Vector3(h.position.x, h.position.y, h.position.z), new Quaternion(h.orientation.x, h.orientation.y, h.orientation.z, h.orientation.w));
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
      void this.pairing.repair().then((id) => {
        this.identity = id;
        this.ws.restart();
      });
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
      record: this.recorder.recording ? `REC ${Math.round(this.recorder.elapsedMs / 1000)} s · ${this.recorder.count.frames} frames` : undefined,
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
