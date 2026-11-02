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
 *   hud=debug          force the shell's debug HUD
 *   dominant=left      left-handed: the deck opens over the RIGHT palm
 *   ws=<url>           WebSocket override
 */
import type { Channel, ControlEvent, HackItem, HudStatus, ModelChip } from '@ce/gen3d';
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
  type TargetSelectPayload,
  type TargetStatusPayload,
  type UiSpecPayload,
  type VerifyResultPayload,
} from '../io/v1';
import { type Envelope, WsClient } from '../io/ws';
import { Approvals } from '../pair/approvals';
import { PairingFlow } from '../pair/self';
import { type ReplayMode, ReplayCamera, TakePlayer } from '../replay/player';
import { Recorder } from '../replay/recorder';
import { loadTake, type Take } from '../replay/take';
import { type AimTarget, aimAt, touching } from '../scan/aim';
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
import { Mic } from '../voice/mic';
import { PushToTalk } from '../voice/ptt';
import { ControlSender } from './controls';
import { type Emulator, installEmulator } from './emulator';
import type { Handedness, Hud, ShellFrame } from './hud-contract';
import { loadHud } from './hud-loader';
import { handJointPositions, InputSampler } from './input';
import { Page } from './page';
import { startXr, xrSupport } from './xr';

export const APP_VERSION = 'quest@0.1.0';

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
  readonly xrHit = new XrHitTester();
  readonly handheld = new HandheldTracker();
  readonly recorder = new Recorder();
  readonly mic = new Mic();
  renderer!: WebGLRenderer;
  hud!: Hud;
  hudKind: 'gen3d' | 'debug' = 'debug';
  camera!: CameraSource;
  capture!: FrameCapture;
  scanner!: Scanner;
  readonly ws: WsClient = new WsClient(WsClient.sameOrigin(), () => this.helloPayload());
  pairing!: PairingFlow;
  approvals!: Approvals;
  ptt!: PushToTalk;
  controls!: ControlSender;
  emulator?: Emulator;
  room?: VirtualRoom;
  fixture?: SamFixture;
  player?: TakePlayer;
  take?: Take;
  session?: XRSession;
  refSpace?: XRReferenceSpace;
  lastFrame?: ShellFrame;
  identity?: Identity;
  welcome?: PayloadOf<'welcome'>;
  cameraState: 'off' | 'starting' | 'on' | 'error' = 'off';
  cameraNote = '';
  private readonly nonDominant: Handedness;
  private candidate = { id: null as string | null, since: 0, shown: null as string | null };
  lockedId: string | null = null;
  private pendingSelect?: { targetId: string; frameId?: string; detId?: string; at: number };
  private readonly consumed = { left: false, right: false };
  private readonly specByCard = new Map<string, string>();
  private readonly cardOfSpec = new Map<string, string>();
  /** gen3d spec id → ui.spec id (control events carry the ui.spec id) */
  private readonly uiSpecOfGen3d = new Map<string, string>();
  private readonly links = new Map<string, { channel: Channel; proven: boolean; label?: string }>();
  private readonly chips = new Map<string, ModelChip & { at: number }>();
  private upload?: { hackId: string; label: string; cardId?: string; stepsDone: number; startedAt: number };
  private pingVisible = false;
  private deckSpawnedAt = 0;
  private lastStatusAt = 0;
  private lastFrameShownAt = 0;
  private serverMode = '';

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
    await this.setupCamera();
    await this.setupHud();
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
    try {
      r.xr.setFoveation(1);
    } catch {
      // not available before a session on some runtimes
    }
    this.renderer = r;
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
      log: (m, l) => this.page.log(m, l),
      fixture: () => (this.fixture && this.room ? { fix: this.fixture, room: this.room } : null),
      local: (dir, type, payload) => this.recorder.message(dir, { v: 1, type, id: `local-${type}-${Date.now()}`, ts: Date.now(), from: dir === 'in' ? 'fixture' : '', payload }),
    });
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
    this.scene.add(hud.root);
    if (error) this.page.log(error, 'warn');
    this.page.log(`HUD: ${kind === 'gen3d' ? 'gen3d renderer' : 'shell debug HUD'}`);
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
    hud.on('deck', (e) => this.onDeck(e.key, e.phase));
    hud.on('hack', (e) => this.onHack(e));
    hud.on('control', (e) => this.onControl(e));
    hud.on('approve', (e) => (e.approve ? this.approvals.approve(e.pairingId) : this.approvals.deny(e.pairingId)));
    hud.on('confirm', (e) => this.answerConfirm(e.id, e.approve, e.hold));
    hud.on('grab', (e) => this.recorder.input('grab', e as unknown as Record<string, unknown>));
  }

  private setupIo(): void {
    const name = this.emulator ? 'Quest (desktop emulator)' : /Quest 3S/i.test(navigator.userAgent) ? 'Quest 3S' : 'Quest 3';
    this.pairing = new PairingFlow({ name, capabilities: ['camera', 'mic', 'hands', 'display'] });
    this.controls = new ControlSender((p) => this.ws.send('control.event', p), 30);
    this.approvals = new Approvals(this.ws);
    this.ptt = new PushToTalk(this.mic, this.ws, () => this.identity?.deviceToken);
    this.ws.tap('out', (m) => this.recorder.message('out', m));
    this.ws.tap('in', (m) => this.recorder.message('in', m));
    this.ws.onState = (s, info) => {
      this.page.badge('b-ws', s, s === 'open' ? 'ok' : s === 'connecting' ? 'warn' : 'bad');
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

  private helloPayload(): PayloadOf<'hello'> {
    return { deviceToken: this.identity?.deviceToken ?? '', role: 'hmd', capabilities: ['camera', 'mic', 'hands', 'display'], app: APP_VERSION };
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
      this.page.badge('b-mode', this.welcome.mode === 'live' ? 'LIVE' : 'FIXTURE', this.welcome.mode === 'live' ? 'ok' : 'warn');
      this.page.log(`connected: ${this.welcome.name} (${this.welcome.kind}) · ${this.welcome.server} · ${this.welcome.mode}${this.welcome.canApprove ? ' · approver' : ''}`, 'ok');
    });
    ws.on('log', (m) => {
      const p = m.payload as PayloadOf<'log'>;
      if (p.level === 'error' || p.level === 'warn') {
        this.page.log(`server: ${p.message}${p.issues?.length ? ` (${p.issues.slice(0, 3).join('; ')})` : ''}`, p.level === 'error' ? 'error' : 'warn');
      }
    });
    ws.on('scan.result', (m) => {
      const p = m.payload as ScanResultPayload;
      void this.scanner.onResult(p);
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
      this.hud.toast(`STOP ALL${p.reason ? ` · ${p.reason}` : ''}`, 'warn');
      for (const specId of this.specByCard.values()) this.hud.setArmed(specId, false, 'stopped');
    });
    ws.on('control.event', (m) => {
      // another client moved a control: mirror it without re-emitting
      const p = m.payload as PayloadOf<'control.event'>;
      if (m.from === this.identity?.deviceId || !p.specId) return;
      const gen3dId = [...this.uiSpecOfGen3d.entries()].find(([, ui]) => ui === p.specId)?.[0] ?? p.specId;
      this.hud.setControlValue(gen3dId, p.widgetId, p.value);
    });
  }

  private lastShown?: { frameId: string; dets: ReturnType<typeof normalizeDetections> };

  private targetForCard(cardId: string, hint: { frameId?: string; detId?: string } = {}): Target | undefined {
    let t = this.targets.byCard(cardId);
    if (t) return t;
    if (hint.frameId && hint.detId) t = this.targets.list().find((x) => x.frameId === hint.frameId && x.detId === hint.detId);
    if (!t && this.pendingSelect && Date.now() - this.pendingSelect.at < 180_000) t = this.targets.get(this.pendingSelect.targetId);
    if (t && !t.cardId) t.cardId = cardId;
    return t;
  }

  private onDeviceCard(p: PayloadOf<'device.card'>): void {
    const t = this.targetForCard(p.cardId, { frameId: p.frameId, detId: p.detId });
    this.page.log(`device.card: ${p.maker} ${p.model || p.name} (${Math.round(p.confidence * 100)} %)${p.modelId ? ` · ${p.modelId}` : ''}`, 'ok');
    if (!t) return;
    t.label = p.name || `${p.maker} ${p.model}`.trim();
    if (!t.subtitle || t.subtitle.startsWith('locked')) t.subtitle = 'identified';
    this.hud.upsertTarget(toHudTarget(t));
  }

  private onTargetStatus(p: TargetStatusPayload): void {
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
    this.hud.logStep(s);
    if (s.model) this.chip(s.model, s.status === 'running' || s.status === 'pending' ? 'live' : s.status === 'fail' ? 'error' : 'done');
    if (this.upload && (!s.cardId || s.cardId === this.upload.cardId)) {
      if ((s.phase === 'control' || s.phase === 'drive' || s.phase === 'verify') && this.upload.stepsDone < 2) this.setUploadSteps(2);
      if (s.phase === 'control' && s.status === 'ok' && this.upload.stepsDone < 3) this.setUploadSteps(3);
    }
  }

  private onLinkRequest(p: LinkRequestPayload): void {
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
    this.refreshPing(true);
  }

  private onLinkResult(p: LinkResultPayload): void {
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
    this.refreshPing(true);
  }

  private onDriverStatus(p: PayloadOf<'driver.status'>): void {
    const verified = p.actions?.filter((a) => a.verified === 'pass').length ?? 0;
    this.page.log(`driver ${p.driverId.slice(-6)} ${p.phase ?? p.status ?? ''}${p.actions ? ` · ${verified}/${p.actions.length} verified` : ''}`);
    const specId = p.cardId ? this.specByCard.get(p.cardId) : undefined;
    if (specId && (p.phase === 'armed' || p.phase === 'disarmed')) this.hud.setArmed(this.gen3dIdFor(specId), p.phase === 'armed', p.phase === 'armed' ? 'armed' : 'disarmed');
  }

  private onVerify(e: VerifyResultPayload): void {
    const s = evidenceSentence(e);
    const t = e.cardId ? this.targetForCard(e.cardId) : undefined;
    this.hud.showEvidence({ targetId: t?.id, ...s });
    this.page.log(`verify: sent ${s.sent} → ${s.expect} · ${s.seen} (attempt ${e.attempt})`, e.pass ? 'ok' : 'warn');
    if (this.upload && (!e.cardId || e.cardId === this.upload.cardId)) this.setUploadSteps(4, e.pass ? 'ok' : 'fail');
  }

  private onArmRequest(p: ArmRequestPayload): void {
    if (this.welcome && !this.welcome.canApprove) return;
    const t = this.targetForCard(p.cardId);
    this.hud.showConfirm({ id: p.armId, title: p.title, summary: p.summary, hold: p.irreversible, expiresAt: p.expiresAt, targetId: t?.id });
    this.pendingArm = p.armId;
    this.page.log(`arm.request: ${p.title} — pinch ARM (or press A)`, 'warn');
  }

  private pendingArm?: string;
  private mouseCursor?: { cursor: unknown; setTargets(o: unknown[]): void; update(): unknown };

  answerConfirm(armId: string, approve: boolean, hold?: boolean): void {
    const payload: PayloadOf<'arm.confirm'> = { armId, approve };
    if (hold) payload.hold = true;
    this.ws.send('arm.confirm', payload, { to: 'server' });
    this.hud.showConfirm(null);
    if (this.pendingArm === armId) this.pendingArm = undefined;
    this.recorder.input('arm', { armId, approve });
    this.page.log(`arm.confirm ${approve ? 'ARM' : 'cancel'}`, approve ? 'ok' : 'warn');
  }

  private onArmResult(p: PayloadOf<'arm.result'>): void {
    this.hud.showConfirm(null);
    const specId = this.specByCard.get(p.cardId);
    if (specId) this.hud.setArmed(this.gen3dIdFor(specId), p.armed, p.armed ? `armed${p.by ? ` by ${p.by}` : ''}` : (p.reason ?? 'not armed'));
    this.page.log(`arm.result: ${p.armed ? 'ARMED' : 'not armed'}${p.reason ? ` (${p.reason})` : ''}`, p.armed ? 'ok' : 'warn');
  }

  private gen3dIdFor(uiSpecId: string): string {
    for (const [g, u] of this.uiSpecOfGen3d) if (u === uiSpecId) return g;
    return uiSpecId;
  }

  /** HUD menu key → ui.spec id, so a hack pinch carries the spec it came from */
  private readonly menuSpec = new Map<string, string>();

  private onUiSpec(p: UiSpecPayload): void {
    // a card's spec sits at that device; a room-level spec (no cardId: daemons, combos) floats on its own
    const t = p.cardId ? this.targetForCard(p.cardId) : undefined;
    const menuKey = p.cardId ? (t?.id ?? p.cardId) : `room:${p.specId}`;
    if (p.cardId) {
      this.specByCard.set(p.cardId, p.specId);
      this.cardOfSpec.set(p.specId, p.cardId);
    }
    if (p.gen3d) {
      this.uiSpecOfGen3d.set(p.gen3d.specId, p.specId);
      this.hud.renderSpec(p.gen3d, t ? { targetId: t.id } : {});
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
      this.hud.showHackMenu(menuKey, { title: p.hackset.device.name, subtitle: 'HACKS · your devices', items });
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
    this.recorder.input('deck', { key, phase });
    if (key === 'mic') {
      if (phase === 'press') void this.ptt.press();
      else this.ptt.release();
      return;
    }
    if (phase !== 'press') return;
    switch (key) {
      case 'scan':
        this.toggleScan();
        break;
      case 'ping':
        this.pingVisible = !this.pingVisible;
        this.refreshPing();
        this.hud.toast(this.pingVisible ? 'PING · grey dashed = hypothesis, solid = proven' : 'ping off');
        break;
      case 'undo':
        this.ws.send('voice.text', { text: 'undo', final: true }, { to: 'server' });
        this.hud.toast('undo requested');
        break;
      case 'panic':
        this.ws.send('panic', { reason: 'STOP ALL from the deck' }, { to: 'server' });
        this.hud.toast('STOP ALL', 'warn');
        break;
      case 'daemons':
        this.hud.toast('DAEMONS · automations: none running yet');
        break;
    }
  }

  toggleScan(): void {
    if (!this.scanner.active) {
      // a new scan clears what the user has not locked or linked
      const keep = (t: Target) => t.id === this.lockedId || Boolean(t.cardId) || t.status !== 'scanned';
      for (const id of this.targets.clearTransient(keep)) this.hud.removeTarget(id);
      if (this.cameraState !== 'on') void this.startCamera();
    }
    this.scanner.toggle();
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
    // only controls of specs the server sent drive devices; HUD-internal objects (hack menus, deck) never do
    const ui = this.uiSpecOfGen3d.get(e.specId);
    if (!ui) return;
    this.controls.push({ ...e, specId: ui });
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

  private aimList(): AimTarget[] {
    return this.targets.list().map((t) => ({ id: t.id, position: t.position, size: Math.max(0.06, ...t.sizeM.slice(0, 2)) }));
  }

  private interact(f: ShellFrame, time: number): void {
    const list = this.aimList();
    if (!list.length) return;
    const mouse = this.input.mouseAsHand && this.input.pointer.inside ? f.hands.right : undefined;
    const gaze = mouse?.ray ?? f.head.ray;
    const aim = aimAt(gaze.origin, gaze.dir, list, { marginDeg: 3 });
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
    for (const hand of ['left', 'right'] as const) {
      const h = f.hands[hand];
      if (!h?.justPinched || this.consumed[hand]) continue;
      if (!h.controller) {
        const touch = touching(h.pinchPoint, list, 0.06);
        if (touch) {
          const t = this.targets.refine(touch.id, h.pinchPoint);
          if (t) this.hud.upsertTarget(toHudTarget(t));
          if (touch.id !== this.lockedId) this.lock(touch.id, 'touch');
          continue;
        }
      }
      const handAim = aimAt(h.ray.origin, h.ray.dir, list, { marginDeg: 2, minDist: 0.3 });
      const pick = handAim?.id ?? this.candidate.shown ?? null;
      if (!pick) continue;
      if (pick === this.lockedId) this.release();
      else this.lock(pick, handAim ? 'ray' : 'gaze');
    }
  }

  /** Lock a target; `send: false` only shows it (replay playback must not drive the live server). */
  lock(id: string, how = 'api', opts: { send?: boolean } = {}): void {
    const t = this.targets.get(id);
    if (!t) return;
    if (this.lockedId && this.lockedId !== id) this.release();
    this.lockedId = id;
    if (t.status === 'scanned') {
      t.status = 'locked';
      t.subtitle = 'locked · identifying…';
    }
    this.hud.setCandidate(null);
    this.candidate.shown = null;
    this.hud.setLocked(id);
    this.hud.upsertTarget(toHudTarget(t));
    if (this.scanner.active) this.scanner.stop();
    if (opts.send === false) {
      this.page.log(`replay: locked ${t.label} (shown only, nothing sent)`);
      return;
    }
    const sel: TargetSelectPayload = t.cardId ? { cardId: t.cardId } : t.deviceId ? { deviceId: t.deviceId } : { frameId: t.frameId, detId: t.detId };
    const sent = this.ws.send('target.select', sel, { to: 'server' });
    this.pendingSelect = { targetId: id, frameId: t.frameId, detId: t.detId, at: Date.now() };
    this.recorder.input('lock', { targetId: id, label: t.label, how, position: [t.position.x, t.position.y, t.position.z] });
    this.page.log(`locked ${t.label} (${how}) → target.select${sent ? '' : ' NOT SENT (offline)'}`, sent ? 'ok' : 'warn');
  }

  release(): void {
    const t = this.lockedId ? this.targets.get(this.lockedId) : undefined;
    this.lockedId = null;
    this.hud.setLocked(null);
    if (t && t.status === 'locked' && !t.cardId) {
      t.status = 'scanned';
      t.subtitle = 'unverified';
      this.hud.upsertTarget(toHudTarget(t));
    }
    this.recorder.input('release', { targetId: t?.id });
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
    const inXr = Boolean(xrFrame && this.refSpace);
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
    const f = this.input.sample(time, cam, inXr ? xrFrame : undefined, inXr ? this.refSpace : undefined);
    this.lastFrame = f;
    this.poses.push(time, f.head.position, f.head.quaternion);
    this.recorder.pose(f.head);
    if (inXr && xrFrame) this.xrHit.onFrame(xrFrame);
    if (inXr && this.camera instanceof LiveCamera) this.camera.pollFromXr(time);
    this.room?.update(time);
    this.deckGesture(f, time);
    for (const m of this.handheld.update(this.wrists(f), time)) {
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
    this.scanner.tick(time);
    this.renderer.render(this.scene, this.desktopCam);
    if (time - this.lastStatusAt > 300) {
      this.lastStatusAt = time;
      this.updateStatus();
    }
  }

  private wrists(f: ShellFrame | undefined = this.lastFrame): { left?: WristPose; right?: WristPose } {
    const out: { left?: WristPose; right?: WristPose } = {};
    for (const h of ['left', 'right'] as const) {
      const w = f?.hands[h]?.joints.wrist;
      if (w) out[h] = { position: w.position, quaternion: w.quaternion };
    }
    return out;
  }

  private deckGesture(f: ShellFrame, time: number): void {
    const nd = f.hands[this.nonDominant];
    if (!nd?.palmUp || nd.palmUpMs < 500 || time - this.deckSpawnedAt < 3000) return;
    const wrist = nd.joints.wrist?.position;
    if (!wrist) return;
    this.deckSpawnedAt = time;
    this.hud.setDeck({ open: true, at: [wrist.x, wrist.y + 0.15, wrist.z] });
    this.recorder.input('deck-open', { at: [wrist.x, wrist.y + 0.15, wrist.z] });
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
    if (this.session) {
      await this.session.end();
      return;
    }
    // permissions before the session, so no prompt interrupts it (research/04 §2)
    await this.prepareMedia();
    try {
      const s = await startXr(this.renderer, { allowVr: Boolean(this.emulator) });
      this.session = s.session;
      this.refSpace = s.refSpace;
      this.xrHit.attach(s.session, s.refSpace);
      this.input.attach(s.session);
      this.page.log(`XR: ${s.mode} (${s.attempt}) · features: ${s.features.join(', ') || 'unknown'}`, 'ok');
      this.page.setButton(this.page.enter, 'Exit AR');
      this.recorder.input('xr', { on: true, mode: s.mode });
      s.session.addEventListener('end', () => {
        this.session = undefined;
        this.refSpace = undefined;
        this.xrHit.detach();
        this.input.detach();
        this.page.setButton(this.page.enter, this.emulator ? 'Enter AR (emulated)' : 'Enter AR');
        this.page.log('XR session ended');
        this.recorder.input('xr', { on: false });
      });
    } catch (e) {
      this.page.log(`XR failed: ${(e as Error).message}`, 'error');
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
    this.page.log(`saved ${name} (on the headset: adb pull /sdcard/Download/${name})`, 'ok');
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
    p.scan.onclick = () => this.toggleScan();
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
          this.toggleScan();
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

  private updateStatus(): void {
    const s = this.scanner.stats;
    const head = this.lastFrame?.head.position;
    this.page.status({
      device: this.identity ? `${this.identity.name} · ${this.identity.deviceId.slice(0, 8)}` : this.pairing.state.kind,
      server: this.welcome ? `${this.welcome.server} · ${this.welcome.mode}` : this.ws.state,
      xr: this.session ? `in session${this.emulator ? ' (IWER)' : ''}` : this.emulator ? 'emulator ready' : 'not in XR',
      camera: `${this.camera.kind} · ${this.cameraState}${this.cameraNote ? ` · ${this.cameraNote}` : ''}`,
      'camera fps': this.camera.kind === 'passthrough' ? `${this.camera.stats.fps}${this.camera.stats.captureTime ? ' · captureTime ✓' : ''}` : undefined,
      scan: `${this.scanner.active ? 'ON' : 'off'} · sent ${s.sent} · results ${s.results} · in flight ${s.inFlight}${s.lastModelId ? ` · ${s.lastModelId} ${s.lastLatencyMs} ms` : ''}${this.fixture ? ' · FIXTURE' : ''}`,
      targets: this.targets.list().map((t) => `${t.label}${t.id === this.lockedId ? '🔒' : ''}`).join(', ') || 'none',
      head: head ? `${head.x.toFixed(2)} ${head.y.toFixed(2)} ${head.z.toFixed(2)}` : '',
      hud: this.hudKind,
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
