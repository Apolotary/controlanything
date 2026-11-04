/**
 * MUSE BUDDY: a small AR mascot at desk height you show real objects to.
 *
 *   Wrist menu → "Buddy". It pops in beside you, waves, and says what to do in one line ("Hi! Show me something
 *   green. Hold it up in the frame!") while it looks at its SHOW-ME FRAME: a soft rounded viewfinder ~42 cm in
 *   front of your eyes, just above its quest card, labelled "Hold it here" (viewfinder.ts).
 *   Put a hand (with the thing in it) inside the frame: the frame lights up, says "Hold still…" and a gold ring
 *   fills for 1 s. Then it snaps exactly the frame's region of the passthrough camera (frame-crop.ts) — the photo
 *   pops out as a little polaroid the buddy holds while it thinks ("Looking… / asking muse-spark-1.3", then
 *   "Thinking…" after 700 ms with the seconds ticking, and a slow head-tilt sway) — Muse Spark (vision,
 *   json_schema, low effort) answers in character, the buddy plays it, and the polaroid flies onto its shelf,
 *   where Muse Image later repaints it as a sticker. Nothing seen → one concrete tip ("Bring it closer, inside the
 *   frame!") and the frame pulses once.
 *   Three quests per round ("Quest 1 of 3"), then a celebration and free play ("Again" starts three more).
 *   Close: wrist menu → Buddy again, the card's ×, or Stop.
 *
 * Cost when closed: one early-return frame hook. Open: ~10 mascot draw calls + 3 uikit roots + frame + polaroid,
 * no per-frame allocations; capture, encode and inference all happen off the render path (async).
 */
import { CanvasTexture, Group, Matrix4, Mesh, MeshBasicMaterial, type Object3D, PlaneGeometry, type Quaternion, SRGBColorSpace, Vector3, type Scene } from 'three';
import type { ShellFrame } from '../app/hud-contract';
import type { PaletteItem } from '../hud/v2/wrist-palette';
import type { CameraSource } from '../scan/camera';
import type { JpegEncoder } from '../scan/encode';
import type { PoseRing } from '../scan/poses';
import { buddyApi, type ReactResult, type ShowVia } from './api';
import { cropPresented, gazePresenter, type Presenter } from './crop';
import { cropFrame, type FrameCrop, type FramePresence, handInFrame } from './frame-crop';
import { Mascot } from './mascot';
import { BuddyPlacer, type CardSide, frameAnchor, MOVE_DEG } from './placement';
import { Polaroid } from './polaroid';
import { pick, POKE_LINES, QuestLog, ROUND } from './quests';
import { loadSticker, Shelf, type ShelfItem } from './shelf';
import { BuddyCard, SpeechBubble } from './ui';
import { FRAME_DIST, FRAME_SIZE, Viewfinder } from './viewfinder';

/** What the buddy needs from the shell (QuestApp satisfies it structurally). */
export interface BuddyHost {
  scene: Scene;
  camera: CameraSource;
  poses: PoseRing;
  encoder: JpegEncoder;
  identity?: { deviceToken: string };
  cameraState: 'off' | 'starting' | 'on' | 'error';
  startCamera(): Promise<void>;
  /** an everyday object bound as a controller and tracked right now (tangible lane); a crop hint, else null */
  tangible?: { heldObject(): { position: Vector3; sizeM: [number, number, number]; label: string } | null };
  /** the HUD's events: the wrist menu's Stop also closes the buddy */
  hud?: { on(k: 'deck', fn: (e: { key: string; phase: 'press' | 'release' }) => void): () => void };
  registerPaletteItem(item: PaletteItem): () => void;
  addFrameHook(hook: (f: ShellFrame, dtSec: number, timeMs: number, xrFrame?: XRFrame) => void): () => void;
  page: { log(msg: string, level?: 'info' | 'ok' | 'warn' | 'error'): void };
}

export type BuddyPhase = 'closed' | 'idle' | 'holding' | 'countdown' | 'capturing' | 'thinking' | 'reacting';

export interface BuddyState {
  asleep: boolean;
  phase: BuddyPhase;
  quest: string;
  kicker: string;
  done: number;
  met: number;
  collected: string[];
  lastReaction?: ReactResult;
  bubble: string;
  meta: string;
  frame: { label: string; mode: string; progress: number; visible: boolean; position: number[] };
  polaroid: string;
  lastCrop?: { box: number[]; frameBox: number[]; image: number[]; width: number; height: number; grewForHand: boolean };
}

export interface BuddyFeature {
  readonly root: Object3D;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  /** Show button: a short countdown, then capture what is in the frame. */
  show(): void;
  /** Dev/e2e: react to a static photo as if it were held up (no camera). */
  showImage(url: string): Promise<void>;
  /** Dev/e2e (emulator): hold a picture up inside the frame, as a hand would; the synthetic camera sees it. */
  holdUp(url?: string): Promise<void>;
  /** Dev/e2e: take the held-up picture away. */
  lower(): void;
  state(): BuddyState;
}

/** hold still this long inside the frame to snap */
const HOLD_S = 1.0;
/** a hand that leaves the frame for less than this keeps the ring */
const GRACE_S = 0.3;
const COOLDOWN_S = 1.2;
/** "Thinking…" appears after this (NVIDIA xr-ai pattern: no spinner for fast answers) */
const THINKING_AFTER_S = 0.7;

function b64ToBlob(b64: string, type = 'image/jpeg'): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

function blobToB64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsDataURL(blob);
  });
}

function metaLine(r: { model: string; source: 'live' | 'fixture'; recordedFrom?: string; latencyMs: number }): string {
  if (r.source === 'fixture') return r.recordedFrom ? `FIXTURE · replay of ${r.recordedFrom}` : 'FIXTURE · no Meta model called';
  return `${r.model} · ${(r.latencyMs / 1000).toFixed(1)} s`;
}

/** A stand-in object for the emulator: a little potted plant on a transparent canvas. */
function drawPlant(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#C4673A';
  g.beginPath(); g.moveTo(78, 150); g.lineTo(178, 150); g.lineTo(164, 236); g.lineTo(92, 236); g.closePath(); g.fill();
  g.fillStyle = '#A9532C'; g.fillRect(70, 140, 116, 20);
  const leaf = (x: number, y: number, rx: number, ry: number, a: number, col: string) => {
    g.fillStyle = col; g.beginPath(); g.ellipse(x, y, rx, ry, a, 0, Math.PI * 2); g.fill();
  };
  leaf(128, 70, 22, 58, 0, '#3FA34D'); leaf(92, 92, 18, 50, -0.6, '#4CB85A'); leaf(164, 92, 18, 50, 0.6, '#4CB85A');
  leaf(74, 122, 14, 36, -1.1, '#2F8F3E'); leaf(182, 122, 14, 36, 1.1, '#2F8F3E');
  return c;
}

export function installBuddy(app: BuddyHost): BuddyFeature {
  const stage = new Group();
  stage.name = 'buddy';
  stage.visible = false;
  let built: { mascot: Mascot; bubble: SpeechBubble; card: BuddyCard; viewfinder: Viewfinder; polaroid: Polaroid; shelf: Shelf | null } | null = null;

  let phase: BuddyPhase = 'closed';
  let time = 0;
  let openedAt = 0;
  let closingAt = -1;
  let yaw = 0;
  let hold = 0;
  let lostFor = 0;
  let rearmed = true;
  let emptyFor = 0;
  let cooldownUntil = 0;
  let countdown = 0;
  let countdownShown = -1;
  let reactingUntil = 0;
  let nextAskAt = Infinity;
  let lookAtFrameUntil = 0;
  let thinkingSince = 0;
  let thinkingShown = false;
  let thinkingSecs = -1;
  let nothingStreak = 0;
  let frameHint = '';
  let frameHintUntil = 0;
  let reactAbort: AbortController | null = null;
  let lastReaction: ReactResult | undefined;
  let lastCrop: FrameCrop | undefined;
  let lastF: ShellFrame | undefined;
  const quests = new QuestLog();
  const seen: string[] = [];

  // world-locked: it stays where it spawned, and only glides away when the selected device's card/dials get close
  const placer = new BuddyPlacer();
  const glideTo = new Vector3();
  const tmpFwd = new Vector3();
  let gliding = false;
  let placeT = 0;
  let cardSide: CardSide = 'left';
  // the show-me frame: on the line from the eyes to its anchor beside the buddy, FRAME_DIST from the eyes
  const anchor = { x: 0, y: 0 };
  const frameTarget = new Vector3();
  const frameTmp = new Vector3();
  let frameSnap = true;
  const corners: Vector3[] = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
  const presence: FramePresence = { inside: 0, point: new Vector3() };
  const lastPoint = new Vector3();
  let hasLastPoint = false;
  let speed = 0;
  const lookTarget = new Vector3();
  const holdPoint = new Vector3();
  const shelfPoint = new Vector3();
  const gazeBuf: Presenter = { kind: 'gaze', point: new Vector3(), distance: 0, score: 0 };
  const jointPool: Vector3[] = Array.from({ length: 26 }, () => new Vector3());
  const joints: Vector3[] = [];
  const frameMatrix = new Matrix4();
  // dev/e2e: a picture held up in the frame (emulator), seen by the synthetic camera's room scene too
  let sim: { mesh: Mesh; roomMesh?: Mesh; roomScene?: Scene } | null = null;

  const token = () => app.identity?.deviceToken;
  // the Meta model ids shown on screen while they work (from GET /api/buddy/status; FIXTURE says so)
  const models = { react: 'Muse Spark', sticker: 'Muse Image' };
  let modelsLoaded = false;
  const loadModels = () => {
    if (modelsLoaded) return;
    modelsLoaded = true;
    void fetch('/api/buddy/status').then((r) => r.json()).then((s: { mode?: string; models?: { react?: string; sticker?: string | null } }) => {
      const fx = s.mode === 'fixture' ? ' (FIXTURE)' : '';
      if (s.models?.react) models.react = `${s.models.react}${fx}`;
      if (s.models?.sticker) models.sticker = `${s.models.sticker}${fx}`;
    }).catch(() => { modelsLoaded = false; });
  };
  // after a minute without play it dozes off; a hand in the frame (or a poke) wakes it
  const AWAKE_S = 60;
  let awakeUntil = 0;
  let asleep = false;
  const wake = (now = time) => { awakeUntil = now + AWAKE_S; };
  const say = (text: string, meta = '', holdS = 6) => built?.bubble.say(text, meta, holdS);

  const refreshCard = (status = '') => {
    if (!built) return;
    const collected = built.shelf?.items.length ?? seen.length;
    const q = quests.current;
    built.card.set({
      kicker: quests.kicker,
      title: q ? `Show me ${q}` : `You did all ${ROUND} quests!`,
      status: status || (q ? `Hold it up in the frame · ${collected} on the shelf` : `${quests.met} of ${ROUND} found · ${collected} on the shelf`),
      finished: quests.finished,
    });
  };

  /** Ask for the current quest, looking at the frame so the eyes point the way. */
  let askKind: 'first' | 'next' | 'retry' = 'next';
  const ask = (kind: 'first' | 'next' | 'retry' = 'next') => {
    say(quests.ask(kind), '', 9);
    lookAtFrameUntil = time + 3;
    refreshCard();
  };

  function build(): NonNullable<typeof built> {
    const mascot = new Mascot();
    const bubble = new SpeechBubble();
    let shelf: Shelf | null = null;
    try {
      shelf = typeof document !== 'undefined' ? new Shelf() : null;
    } catch {
      shelf = null;
    }
    const card = new BuddyCard(shelf?.texture ?? null, { show: () => feature.show(), skip: () => skipQuest(), close: () => feature.close() });
    const viewfinder = new Viewfinder();
    const polaroid = new Polaroid();
    stage.add(mascot, bubble, card);
    app.scene.add(stage, viewfinder, polaroid);
    mascot.body.addEventListener('click' as never, (() => poke()) as never);
    const b = { mascot, bubble, card, viewfinder, polaroid, shelf };
    built = b;
    setSide(cardSide);
    return b;
  }

  /** Quest card (and bubble) on the given side of the mascot, or tucked away while a device is being played. */
  function setSide(side: CardSide): void {
    cardSide = side;
    stage.userData.cardSide = side;
    if (!built) return;
    const tucked = side === 'tucked';
    built.card.setVisible(!tucked && phase !== 'closed');
    if (!tucked) {
      built.card.setSide(side);
      built.card.position.set(side === 'left' ? -0.11 : 0.11, -0.03, 0);
    }
    // the bubble sits on the side away from the frame (which hangs above the card)
    const bx = side === 'right' ? -0.04 : 0.04;
    built.bubble.position.set(bx, 0.095, 0);
    built.bubble.setTail(-bx);
    frameAnchor(side, anchor);
  }

  /**
   * World-locked, except: when the selected device's card/dials come within 3° of it in your view, it glides to the
   * best free spot (≥ 8° of empty view around them, quest card on the far side, or tucked away while you play).
   */
  function keepClear(f: ShellFrame, force: boolean): void {
    placer.collect(app.scene, time);
    const q = f.head.quaternion as Quaternion;
    if (!force && !placer.count && cardSide === 'tucked') {
      // the device UI is gone: bring the quest card back on the side facing the middle of the view, in place
      tmpFwd.set(0, 0, -1).applyQuaternion(q);
      // (stage - head) · head-right, where right = (-fwd.z, 0, fwd.x)
      const lateral = -(stage.position.x - f.head.position.x) * tmpFwd.z + (stage.position.z - f.head.position.z) * tmpFwd.x;
      setSide(lateral >= 0 ? 'left' : 'right');
      return;
    }
    const clear = placer.clearanceAt(gliding ? glideTo : stage.position, cardSide, f.head.position, q);
    stage.userData.clearanceDeg = clear;
    if (!force && clear >= MOVE_DEG) return;
    const best = placer.choose(f.head.position, q);
    if (!force && best.clearanceDeg < clear + 2) return;
    glideTo.copy(best.position);
    gliding = !force;
    if (force) stage.position.copy(best.position);
    setSide(best.side);
    stage.userData.clearanceDeg = best.clearanceDeg;
    if (!force) app.page.log(`[buddy] stepped aside for the device controls (${Number.isFinite(best.clearanceDeg) ? `${Math.round(best.clearanceDeg)}° clear` : 'clear'}${best.side === 'tucked' ? ', card tucked' : ''})`);
  }

  /** stage-local (x, y) → world, ignoring the pop-in scale */
  function stageToWorld(x: number, y: number, z: number, out: Vector3): Vector3 {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return out.set(stage.position.x + x * c + z * s, stage.position.y + y, stage.position.z - x * s + z * c);
  }

  /** Where the frame wants to be: FRAME_DIST from the eyes, toward its anchor beside the buddy. */
  function placeFrame(f: ShellFrame, dt: number, frozen: boolean): void {
    if (!built) return;
    const v = built.viewfinder;
    if (!frozen) {
      stageToWorld(anchor.x, anchor.y, 0, frameTmp).sub(f.head.position);
      if (frameTmp.lengthSq() < 1e-6) frameTmp.set(0, 0, -1);
      frameTarget.copy(f.head.position).addScaledVector(frameTmp.normalize(), FRAME_DIST);
      if (frameSnap) { v.position.copy(frameTarget); frameSnap = false; }
      else v.position.lerp(frameTarget, 1 - Math.exp(-6 * dt));
      v.lookAt(f.head.position);
    }
  }

  function skipQuest(): void {
    wake();
    asleep = false;
    const wasFinished = quests.finished;
    quests.skip();
    built?.mascot.play(wasFinished ? 'hop' : 'nod');
    ask(wasFinished ? 'first' : 'next');
  }

  function poke(): void {
    if (!built || phase === 'closed' || phase === 'thinking' || phase === 'capturing') return;
    wake();
    if (asleep) {
      asleep = false;
      built.mascot.play('hop');
      built.mascot.setMood('surprised', 1.5);
      say(`Huh? I'm awake! ${quests.ask()}`, '', 6);
      lookAtFrameUntil = time + 3;
      return;
    }
    built.mascot.play('giggle');
    built.mascot.setMood('amused', 1.6);
    say(pick(POKE_LINES), '', 3);
  }

  function setPhase(p: BuddyPhase): void {
    phase = p;
    stage.userData.phase = p;
  }

  function setFrame(mode: 'idle' | 'lit' | 'busy', label: string): void {
    if (!built) return;
    built.viewfinder.mode = mode;
    built.viewfinder.setLabel(label);
  }

  function backToIdle(): void {
    setPhase('idle');
    hold = 0;
    if (built) built.viewfinder.progress = 0;
    setFrame('idle', 'Hold it here');
  }

  /** The photo pops out of the frame and floats next to the buddy, where it "holds" it while thinking. */
  function holdPhoto(photo: ImageBitmap | HTMLCanvasElement | undefined): void {
    if (!built || !photo) return;
    const pol = built.polaroid;
    pol.setPhoto(photo);
    const side = cardSide === 'right' ? 1 : -1;
    stageToWorld(side * 0.1, 0.02, 0.05, holdPoint);
    pol.go(holdPoint, 0.07, 0.55, { from: built.viewfinder.position, fromSize: FRAME_SIZE * 0.7, arc: 0.03 });
    pol.state = 'held';
  }

  async function react(jpeg: string, photo: ImageBitmap | HTMLCanvasElement | undefined, via: ShowVia): Promise<void> {
    if (!built) return;
    const b = built;
    setPhase('thinking');
    thinkingSince = time;
    thinkingShown = false;
    thinkingSecs = -1;
    b.mascot.setMood('thinking', Infinity);
    wake();
    asleep = false;
    say('Looking…', `asking ${models.react}`, Infinity);
    refreshCard(`${models.react} is looking…`);
    setFrame('busy', '');
    holdPhoto(photo);
    const quest = quests.current;
    reactAbort?.abort();
    const ctl = new AbortController();
    reactAbort = ctl;
    let r: ReactResult;
    try {
      r = await buddyApi.react(jpeg, quest, seen, via, token(), ctl.signal);
    } catch (e) {
      if (phase === 'closed' || ctl.signal.aborted) return;
      b.mascot.setMood('confused', 3);
      b.mascot.play('shiver');
      say('My brain hiccuped. Try again?', String((e as Error).message).slice(0, 60), 5);
      app.page.log(`[buddy] react failed: ${(e as Error).message}`, 'warn');
      b.polaroid.shrug();
      b.polaroid.go(b.polaroid.position, 0.02, 0.6, { fade: true });
      b.polaroid.state = 'fading';
      refreshCard();
      backToIdle();
      rearmed = true;
      cooldownUntil = time + 1.5;
      return;
    } finally {
      if (reactAbort === ctl) reactAbort = null;
    }
    if (phase === 'closed') return;
    lastReaction = r;
    stage.userData.lastReaction = r;
    const x = r.reaction;
    app.page.log(`[buddy] ${x.object} → ${x.emotion}/${x.action}${x.questMet ? ' · quest met' : ''} · ${metaLine(r)}`, 'ok');
    setPhase('reacting');
    reactingUntil = time + 2.5;
    cooldownUntil = time + COOLDOWN_S;
    setFrame('idle', 'Hold it here');
    b.viewfinder.progress = 0;

    if (x.object === 'nothing') {
      // the frame was empty (or the thing was too small / blurry): one concrete tip, the frame pulses once
      nothingStreak++;
      b.mascot.setMood('confused', 3.5);
      b.mascot.play('tilt');
      say(nothingStreak === 1 ? "Hmm, I couldn't see it. Bring it closer, inside the frame!" : 'Still nothing… hold it right in the middle of the frame.', metaLine(r), 7);
      b.viewfinder.attention();
      frameHint = 'Closer, inside the frame';
      frameHintUntil = time + 6;
      reactingUntil = time + 3.5;
      lookAtFrameUntil = time + 3;
      b.polaroid.shrug();
      b.polaroid.go(b.polaroid.position, 0.02, 0.9, { fade: true });
      b.polaroid.state = 'fading';
      // a hand still up can try again right away (it is probably moving closer)
      rearmed = true;
      refreshCard();
      return;
    }
    nothingStreak = 0;
    b.mascot.setMood(x.emotion, 4.5);
    b.mascot.play(x.action);
    say(x.quip, metaLine(r), 6);
    let roundOver = false;
    if (quest && x.questMet) {
      roundOver = quests.complete();
      b.mascot.celebrate(true);
      askKind = 'next';
      nextAskAt = roundOver ? Infinity : time + 4.2;
    } else if (quest) {
      const m = quests.miss();
      roundOver = m.roundOver;
      askKind = m.movedOn ? 'next' : 'retry';
      nextAskAt = roundOver ? Infinity : time + (m.movedOn ? 4.2 : 7);
      if (x.emotion === 'love' || x.emotion === 'delighted') b.mascot.celebrate(false);
    } else if (x.emotion === 'love' || x.emotion === 'delighted') {
      b.mascot.celebrate(false);
    }
    if (roundOver) {
      // after the quip, the big finish
      setTimeout(() => {
        if (phase === 'closed' || !built) return;
        built.mascot.play('dance');
        built.mascot.setMood('delighted', 4);
        built.mascot.celebrate(true);
        say(`You did all ${ROUND} quests! You're a treasure hunter!`, 'Show me anything, or press Again', 9);
        refreshCard();
      }, 3800);
    }
    refreshCard();

    // the polaroid flies onto the shelf; Muse Image repaints it as a sticker there (never blocking)
    seen.push(x.object);
    const item: ShelfItem = { name: x.object, questMet: x.questMet, painting: Boolean(b.shelf) };
    if (photo instanceof ImageBitmap) item.photo = photo;
    else if (photo) item.photo = await createImageBitmap(photo).catch(() => undefined);
    const landed = () => {
      if (!b.shelf || phase === 'closed') return;
      b.shelf.add(item);
      refreshCard(item.painting ? `${models.sticker} is painting a sticker…` : '');
    };
    if (b.shelf && cardSide !== 'tucked') {
      stageToWorld(b.card.position.x + b.card.shelfLocal(cardSide === 'right' ? 'right' : 'left'), b.card.position.y, 0.01, shelfPoint);
      b.polaroid.state = 'flying';
      setTimeout(() => {
        if (phase === 'closed' || !built) return;
        b.polaroid.go(shelfPoint, 0.035, 0.8, { arc: 0.05, done: () => { b.polaroid.hide(); landed(); } });
      }, 1200);
    } else {
      b.polaroid.go(b.polaroid.position, 0.02, 0.8, { fade: true });
      b.polaroid.state = 'fading';
      landed();
    }
    if (!b.shelf) return;
    void buddyApi.sticker(jpeg, x.object, token())
      .then(async (s) => {
        if (!s.ok || !s.url) throw new Error(s.error ?? 'no sticker');
        item.sticker = await loadSticker(s.url);
        app.page.log(`[buddy] sticker for ${x.object} · ${metaLine(s)}`, 'ok');
      })
      .catch((e) => app.page.log(`[buddy] sticker: ${(e as Error).message}`, 'warn'))
      .finally(() => {
        item.painting = false;
        b.shelf?.redraw();
        if (phase !== 'closed' && phase !== 'thinking') refreshCard();
      });
  }

  async function capture(): Promise<void> {
    if (!built) return;
    const b = built;
    setPhase('capturing');
    rearmed = false;
    emptyFor = 0;
    b.viewfinder.progress = 1;
    b.viewfinder.flash();
    setFrame('lit', 'Got it!');
    b.mascot.setMood('noticing', 2);
    if (app.cameraState !== 'on') {
      try { await app.startCamera(); } catch { /* reported below */ }
    }
    b.viewfinder.corners(corners, 1);
    let crop: FrameCrop | null = null;
    let fallback: { jpeg: string; via: ShowVia } | null = null;
    try {
      crop = await cropFrame({ camera: app.camera, poses: app.poses, encoder: app.encoder }, corners, joints);
      if (!crop && lastF) {
        // the frame is off the camera image (should not happen at 42 cm): the view's centre instead
        const c = await cropPresented({ camera: app.camera, poses: app.poses, encoder: app.encoder }, gazePresenter(lastF, gazeBuf), [], 384);
        if (c) fallback = { jpeg: c.jpeg, via: 'gaze' };
      }
    } catch (e) {
      app.page.log(`[buddy] crop failed: ${(e as Error).message}`, 'warn');
    }
    if (phase === 'closed') return;
    if (!crop && !fallback) {
      b.mascot.setMood('confused', 3);
      say("I can't see a thing! Is the camera on?", 'Camera + mic, then try again', 5);
      backToIdle();
      rearmed = true;
      cooldownUntil = time + 2;
      return;
    }
    if (crop) {
      lastCrop = crop;
      app.page.log(`[buddy] crop ${crop.width}×${crop.height} of the frame [${crop.box.join(',')}] in ${crop.image.join('×')}${crop.grewForHand ? ' (+hand)' : ''}`);
    }
    const jpeg = crop?.jpeg ?? fallback!.jpeg;
    const photo = await createImageBitmap(b64ToBlob(jpeg)).catch(() => undefined);
    await react(jpeg, photo, crop ? 'hand' : fallback!.via);
  }

  function snapshotJoints(f: ShellFrame, hand?: 'left' | 'right'): void {
    joints.length = 0;
    const h = hand ? f.hands[hand] : undefined;
    if (!h) return;
    let i = 0;
    for (const name in h.joints) {
      const j = h.joints[name as XRHandJoint];
      if (j && i < jointPool.length) joints.push(jointPool[i++].copy(j.position));
    }
  }

  function frame(f: ShellFrame, dtSec: number): void {
    if (phase === 'closed' && closingAt < 0) return;
    if (!built) return;
    const dt = Math.min(0.1, Math.max(0, dtSec));
    time += dt;
    lastF = f;
    const b = built;

    if (closingAt >= 0 && time >= closingAt) {
      closingAt = -1;
      stage.visible = false;
      b.viewfinder.wanted = false;
      b.viewfinder.visible = false;
      b.polaroid.hide();
      return;
    }

    // --- placement: world-locked; steps aside (glides) only when the selected device's card/dials come close ---
    const steady = phase === 'holding' || phase === 'countdown' || phase === 'capturing';
    placeT += dt;
    if (placeT >= 0.4 && !steady && closingAt < 0) {
      placeT = 0;
      keepClear(f, false);
    }
    if (gliding) {
      stage.position.lerp(glideTo, 1 - Math.exp(-5 * dt));
      if (stage.position.distanceToSquared(glideTo) < 1e-5) gliding = false;
    }
    const targetYaw = Math.atan2(f.head.position.x - stage.position.x, f.head.position.z - stage.position.z);
    let dy = targetYaw - yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    yaw += dy * (1 - Math.exp(-6 * dt));
    stage.rotation.set(0, yaw, 0);
    // pop in (overshoot) on open
    let pop = 1;
    if (closingAt >= 0) pop = Math.max(0.001, (closingAt - time) / 0.45);
    else {
      const u = Math.min(1, (time - openedAt) / 0.45) - 1;
      pop = 1 + 2.70158 * u * u * u + 1.70158 * u * u; // easeOutBack
    }
    stage.scale.setScalar(Math.max(0.001, pop));
    placeFrame(f, dt, steady);

    // --- is a hand (with something in it) inside the frame? ---
    let p: FramePresence | null = null;
    if (phase !== 'closed') {
      b.viewfinder.updateWorldMatrix(true, false);
      frameMatrix.copy(b.viewfinder.matrixWorld);
      p = handInFrame(f, frameMatrix, presence);
      if (!p && sim) {
        presence.hand = undefined;
        presence.inside = 7;
        presence.point.copy(b.viewfinder.position);
        p = presence;
      }
    }
    if (p && hasLastPoint) speed += (p.point.distanceTo(lastPoint) / Math.max(dt, 1e-3) - speed) * (1 - Math.exp(-10 * dt));
    if (p) { lastPoint.copy(p.point); hasLastPoint = true; } else { hasLastPoint = false; speed = 0; }
    emptyFor = p ? 0 : emptyFor + dt;
    if (!rearmed && emptyFor > 0.3) rearmed = true;
    stage.userData.inFrame = Boolean(p);

    if (phase === 'idle' || phase === 'reacting') {
      if (phase === 'reacting' && time > reactingUntil) {
        setPhase('idle');
        refreshCard();
      }
      // the line under the frame: the tip after "nothing", "lower it" while the shown thing is still up, else the how-to
      b.viewfinder.setLabel(time < frameHintUntil ? frameHint : p && !rearmed ? 'Lower it, then the next' : phase === 'reacting' ? '' : 'Hold it here');
      if (p && rearmed && time > cooldownUntil && phase === 'idle') {
        wake();
        if (asleep) {
          asleep = false;
          b.mascot.play('hop');
        }
        setPhase('holding');
        hold = 0;
        lostFor = 0;
        nextAskAt = Infinity;
        setFrame('lit', 'Hold still…');
        b.mascot.setMood('noticing', Infinity);
        say('Ooh, what is that? Hold still…', '', Infinity);
      }
    } else if (phase === 'holding') {
      if (!p) {
        lostFor += dt;
        hold = Math.max(0, hold - dt * 2);
        if (lostFor > GRACE_S) {
          backToIdle();
          b.mascot.setMood('neutral', Infinity);
          ask();
        }
      } else {
        lostFor = 0;
        // the ring only fills while the hand is still (it drains while you wave it about)
        hold = speed < 0.3 ? hold + dt : Math.max(0, hold - dt);
        b.viewfinder.setLabel(speed < 0.3 ? 'Hold still…' : 'Hold it still');
      }
      b.viewfinder.progress = Math.min(1, hold / HOLD_S);
      if (hold >= HOLD_S && p) {
        snapshotJoints(f, p.hand);
        void capture();
      }
    } else if (phase === 'countdown') {
      countdown -= dt;
      b.viewfinder.progress = 1 - Math.max(0, countdown) / 1.5;
      const n = Math.ceil(countdown / 0.5);
      if (n !== countdownShown && n > 0) {
        countdownShown = n;
        b.viewfinder.setLabel(`Snap in ${n}…`);
      }
      if (countdown <= 0) {
        snapshotJoints(f, p?.hand);
        void capture();
      }
    } else if (phase === 'thinking') {
      const el = time - thinkingSince;
      if (!thinkingShown && el >= THINKING_AFTER_S) {
        thinkingShown = true;
        say('Thinking…', `${models.react} · 1 s`, Infinity);
      }
      const secs = Math.floor(el);
      if (thinkingShown && secs !== thinkingSecs && secs >= 1) {
        thinkingSecs = secs;
        b.bubble.setMeta(`${models.react} · ${secs} s`);
      }
    }
    if (phase === 'idle' && !asleep && time > awakeUntil) {
      asleep = true;
      b.mascot.setMood('sleepy', Infinity);
      b.bubble.hide();
      refreshCard('Dozing… hold something in the frame');
    }
    if (phase === 'idle' && time > nextAskAt && !asleep) {
      nextAskAt = Infinity;
      b.mascot.play('hop');
      ask(askKind);
      askKind = 'next';
    }

    // --- gaze: the frame while showing (and while it asks: the eyes point the way), the photo while thinking ---
    if (phase === 'thinking') lookTarget.copy(b.polaroid.visible ? b.polaroid.position : b.viewfinder.position);
    else if (phase === 'holding' || phase === 'countdown' || phase === 'capturing') lookTarget.copy(p ? p.point : b.viewfinder.position);
    else if (time < lookAtFrameUntil) lookTarget.copy(b.viewfinder.position);
    else lookTarget.copy(f.head.position);
    b.mascot.update(dt, lookTarget);
    b.viewfinder.update(dt);
    b.polaroid.update(dt, f.head.position);
    b.bubble.update(dt * 1000);
    b.card.update(dt * 1000);
  }

  function removeSim(): void {
    if (!sim) return;
    sim.mesh.removeFromParent();
    sim.roomMesh?.removeFromParent();
    (sim.mesh.material as MeshBasicMaterial).map?.dispose();
    sim = null;
  }

  const feature: BuddyFeature = {
    root: stage,
    open() {
      if (phase !== 'closed' && closingAt < 0) return;
      const b = built ?? build();
      closingAt = -1;
      backToIdle();
      openedAt = time;
      stage.visible = true;
      b.card.setVisible(cardSide !== 'tucked');
      if (lastF) {
        keepClear(lastF, true);
        yaw = Math.atan2(lastF.head.position.x - stage.position.x, lastF.head.position.z - stage.position.z);
      }
      gliding = false;
      placeT = 0;
      frameSnap = true;
      b.viewfinder.wanted = true;
      b.mascot.setMood('delighted', 2.5);
      b.mascot.play('wave');
      if (quests.finished) quests.restart();
      ask('first');
      cooldownUntil = time + 0.8;
      rearmed = true;
      nothingStreak = 0;
      wake();
      asleep = false;
      loadModels();
      if (app.cameraState !== 'on' && app.cameraState !== 'starting') void app.startCamera().catch(() => undefined);
      app.page.log('[buddy] open: hold something up in the frame');
    },
    close() {
      if (phase === 'closed' || !built) return;
      reactAbort?.abort();
      reactAbort = null;
      built.mascot.play('wave');
      built.mascot.setMood('delighted', 1);
      say('Bye! Bring me treasures later.', '', 1.5);
      built.card.setVisible(false);
      built.viewfinder.wanted = false;
      built.viewfinder.progress = 0;
      built.polaroid.hide();
      removeSim();
      nextAskAt = Infinity;
      setPhase('closed');
      closingAt = time + 0.45;
      app.page.log('[buddy] closed');
    },
    toggle() {
      if (phase === 'closed') feature.open();
      else feature.close();
    },
    isOpen: () => phase !== 'closed',
    show() {
      if (!built || (phase !== 'idle' && phase !== 'reacting' && phase !== 'holding')) return;
      wake();
      asleep = false;
      setPhase('countdown');
      countdown = 1.5;
      countdownShown = -1;
      setFrame('lit', 'Snap in 3…');
      built.mascot.setMood('noticing', Infinity);
      say('Hold it in the frame…', '', 3);
    },
    async showImage(url: string) {
      if (phase === 'closed') feature.open();
      if (!built || phase === 'thinking' || phase === 'capturing') return;
      const blob = await (await fetch(url)).blob();
      built.viewfinder.flash();
      const photo = await createImageBitmap(blob).catch(() => undefined);
      await react(await blobToB64(blob), photo, 'photo');
    },
    async holdUp(url?: string) {
      if (phase === 'closed') feature.open();
      if (!built) return;
      removeSim();
      let tex: CanvasTexture;
      if (url) {
        const bmp = await createImageBitmap(await (await fetch(url)).blob());
        const c = document.createElement('canvas');
        c.width = bmp.width; c.height = bmp.height;
        c.getContext('2d')!.drawImage(bmp, 0, 0);
        bmp.close();
        tex = new CanvasTexture(c);
      } else tex = new CanvasTexture(drawPlant());
      tex.colorSpace = SRGBColorSpace;
      const geo = new PlaneGeometry(FRAME_SIZE * 0.7, FRAME_SIZE * 0.7);
      const mat = new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
      const mesh = new Mesh(geo, mat);
      mesh.name = 'buddy-sim-held';
      mesh.renderOrder = 5;
      // a few cm behind the frame plane, as a held object would be
      mesh.position.copy(built.viewfinder.position);
      mesh.quaternion.copy(built.viewfinder.quaternion);
      mesh.translateZ(-0.02);
      app.scene.add(mesh);
      const roomScene = (app.camera as unknown as { room?: { scene?: Scene } }).room?.scene;
      let roomMesh: Mesh | undefined;
      if (roomScene) {
        roomMesh = new Mesh(geo, mat);
        roomMesh.position.copy(mesh.position);
        roomMesh.quaternion.copy(mesh.quaternion);
        roomScene.add(roomMesh);
      }
      sim = { mesh, roomMesh, roomScene };
      app.page.log('[buddy] dev: a picture is held up in the frame');
    },
    lower() {
      removeSim();
    },
    state: () => ({
      asleep,
      phase,
      quest: quests.current ?? '',
      kicker: quests.kicker,
      done: quests.done,
      met: quests.met,
      collected: [...seen],
      lastReaction,
      bubble: String(built?.bubble.userData.text ?? ''),
      meta: String(built?.bubble.userData.meta ?? ''),
      frame: {
        label: built?.viewfinder.labelTextNow ?? '',
        mode: built?.viewfinder.mode ?? 'idle',
        progress: built?.viewfinder.progress ?? 0,
        visible: Boolean(built?.viewfinder.visible),
        position: built ? built.viewfinder.position.toArray() : [],
      },
      polaroid: built?.polaroid.state ?? 'hidden',
      ...(lastCrop ? { lastCrop: { box: lastCrop.box, frameBox: lastCrop.frameBox, image: lastCrop.image, width: lastCrop.width, height: lastCrop.height, grewForHand: lastCrop.grewForHand } } : {}),
    }),
  };

  app.addFrameHook((f, dt) => frame(f, dt));
  // track the head even while closed, so the first open spawns in front of you (cheap: one reference)
  app.addFrameHook((f) => { lastF = f; });
  app.registerPaletteItem({ key: 'buddy', label: 'Buddy', order: 10, onSelect: () => feature.toggle() });
  // the wrist menu's Stop stops the buddy too
  try {
    app.hud?.on('deck', (e) => { if (e.key === 'panic' && e.phase === 'press' && phase !== 'closed') feature.close(); });
  } catch { /* a HUD without events */ }
  return feature;
}
