/**
 * Muse Buddy: a companion for sharing objects and expressive gestures, without quests or scores.
 * Capture freezes a preview first; Show sends exactly that photo. Retake discards it locally.
 * Hands only draw Buddy's attention; they never trigger a camera upload.
 */
import { CanvasTexture, Group, Matrix4, Mesh, MeshBasicMaterial, type Object3D, PlaneGeometry, type Quaternion, SRGBColorSpace, Vector3, type Scene } from 'three';
import type { ShellFrame } from '../app/hud-contract';
import type { PaletteItem } from '../hud/v2/wrist-palette';
import type { CameraSource } from '../scan/camera';
import type { JpegEncoder } from '../scan/encode';
import type { PoseRing } from '../scan/poses';
import { buddyApi, type ReactResult, type ShowVia } from './api';
import { cropFrame, type FrameCrop, type FramePresence, handInFrame } from './frame-crop';
import { Mascot } from './mascot';
import { BuddyPlacer, type CardSide, frameAnchor, MOVE_DEG } from './placement';
import { Polaroid } from './polaroid';
import { pick, POKE_LINES } from './quests';
import { drawVirtualObject, VIRTUAL_OBJECTS } from './objects';
import { loadSticker, Shelf, type ShelfItem } from './shelf';
import { BuddyCard, SpeechBubble } from './ui';
import { FRAME_DIST, FRAME_SIZE, Viewfinder } from './viewfinder';

/** What the buddy needs from the shell (QuestApp satisfies it structurally). */
export interface BuddyHost {
  /** Browser/OS speech and reactions share the room master volume. */
  demoAudio?: { speak(text: string): void; play(cue: 'curious' | 'giggle' | 'celebrate'): void; setThinking(source: string, active: boolean): void };
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
  hud?: { root?: Object3D; on(k: 'deck', fn: (e: { key: string; phase: 'press' | 'release' }) => void): () => void };
  registerPaletteItem(item: PaletteItem): () => void;
  addFrameHook(hook: (f: ShellFrame, dtSec: number, timeMs: number, xrFrame?: XRFrame) => void): () => void;
  page: { log(msg: string, level?: 'info' | 'ok' | 'warn' | 'error'): void };
}

export type BuddyPhase = 'closed' | 'idle' | 'capturing' | 'preview' | 'thinking' | 'reacting';

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
  close(silent?: boolean): void;
  toggle(): void;
  isOpen(): boolean;
  /** Capture a preview, then Show the reviewed image on a second press. */
  show(): void;
  retake(): void;
  wave(): void;
  showVirtual(): void;
  /** Dev/e2e: react to a static photo as if it were held up (no camera). */
  showImage(url: string): Promise<void>;
  /** Dev/e2e (emulator): hold a picture up inside the frame, as a hand would; the synthetic camera sees it. */
  holdUp(url?: string): Promise<void>;
  /** Dev/e2e: take the held-up picture away. */
  lower(): void;
  state(): BuddyState;
}

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
  let reactingUntil = 0;
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
  let pendingPhoto: { jpeg: string; photo: ImageBitmap | HTMLCanvasElement; via: ShowVia } | undefined;
  let interactionEpoch = 0;
  let virtualIndex = 0;
  let gestureUntil = 0;
  let palmWasUp = false;
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
  const lookTarget = new Vector3();
  const holdPoint = new Vector3();
  const shelfPoint = new Vector3();
  const frameMatrix = new Matrix4();
  // dev/e2e: a picture held up in the frame (emulator), seen by the synthetic camera's room scene too
  let sim: { mesh: Mesh; roomMesh?: Mesh; roomScene?: Scene } | null = null;

  // the wrist menu showing = its hand is busy with the menu, not showing anything (cached lookup, retried every 2 s)
  let menuObj: Object3D | null = null;
  let menuLookAt = -Infinity;
  const wristMenuOpen = (): boolean => {
    if (!menuObj && time - menuLookAt > 2) {
      menuLookAt = time;
      menuObj = app.hud?.root?.getObjectByName('wrist-palette') ?? null;
    }
    return Boolean(menuObj?.visible);
  };

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
  const say = (text: string, meta = '', holdS = 6) => {
    built?.bubble.say(text, meta, holdS);
    // Short reactions get a voice; progress is a soft cue.
    if (!/^(?:Looking|Thinking)….*/.test(text)) app.demoAudio?.speak(text);
  };

  const refreshCard = (status = '') => {
    if (!built) return;
    built.card.set({
      kicker: 'MUSE BUDDY',
      title: phase === 'preview' ? 'Is this the object?' : 'Show me your world',
      status: status || (phase === 'preview' ? 'Only this photo is sent when you press Show.' : 'Capture an object, share a virtual one, or wave hello.'),
      preview: phase === 'preview',
      busy: phase === 'thinking' || phase === 'capturing',
    });
  };

  const ask = (_kind?: string) => {
    say('Show me anything you like. Capture first, then Show.', '', 8);
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
    const card = new BuddyCard(shelf?.texture ?? null, { show: () => feature.show(), retake: () => feature.retake(), wave: () => feature.wave(), virtual: () => feature.showVirtual(), close: () => feature.close() });
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

  /** Companion card (and bubble) on the given side of the mascot, or tucked away while a device is being played. */
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
   * best free spot (≥ 8° of empty view around them, companion card on the far side, or tucked away while you play).
   */
  function keepClear(f: ShellFrame, force: boolean): void {
    placer.collect(app.scene, time);
    const q = f.head.quaternion as Quaternion;
    if (!force && !placer.count && cardSide === 'tucked') {
      // the device UI is gone: bring the companion card back on the side facing the middle of the view, in place
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

  function poke(): void {
    if (!built || phase === 'closed' || phase === 'thinking' || phase === 'capturing') return;
    wake();
    if (asleep) {
      asleep = false;
      built.mascot.play('hop');
      built.mascot.setMood('surprised', 1.5);
      say("I'm here! What would you like to show me?", '', 6);
      lookAtFrameUntil = time + 3;
      return;
    }
    built.mascot.play('giggle');
    app.demoAudio?.play('giggle');
    built.mascot.setMood('amused', 1.6);
    say(pick(POKE_LINES), '', 3);
  }

  function setPhase(p: BuddyPhase): void {
    phase = p;
    app.demoAudio?.setThinking('buddy', p === 'thinking');
    stage.userData.phase = p;
  }

  function setFrame(mode: 'idle' | 'lit' | 'busy', label: string): void {
    if (!built) return;
    built.viewfinder.mode = mode;
    built.viewfinder.setLabel(label);
  }

  function backToIdle(): void {
    setPhase('idle');
    if (built) built.viewfinder.progress = 0;
    setFrame('idle', 'Aim, then Capture');
    frameSnap = true;
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
    const b = built, epoch = interactionEpoch;
    const current = () => interactionEpoch === epoch && phase !== 'closed';
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
    const quest = undefined;
    reactAbort?.abort();
    const ctl = new AbortController();
    reactAbort = ctl;
    let r: ReactResult;
    try {
      r = await buddyApi.react(jpeg, quest, seen, via, token(), ctl.signal);
    } catch (e) {
      if (!current() || ctl.signal.aborted) { if (photo instanceof ImageBitmap) photo.close(); return; }
      b.mascot.setMood('confused', 3);
      b.mascot.play('shiver');
      say('My brain hiccuped. Try again?', String((e as Error).message).slice(0, 60), 5);
      app.page.log(`[buddy] react failed: ${(e as Error).message}`, 'warn');
      b.polaroid.shrug();
      b.polaroid.go(b.polaroid.position, 0.02, 0.6, { fade: true });
      b.polaroid.state = 'fading';
      refreshCard();
      backToIdle();
      if (photo instanceof ImageBitmap) photo.close();
      return;
    } finally {
      if (reactAbort === ctl) reactAbort = null;
    }
    if (!current() || ctl.signal.aborted) { if (photo instanceof ImageBitmap) photo.close(); return; }
    lastReaction = r;
    stage.userData.lastReaction = r;
    const x = r.reaction;
    app.demoAudio?.play(x.emotion === 'love' || x.emotion === 'delighted' ? 'giggle' : 'curious');
    app.page.log(`[buddy] ${x.object} → ${x.emotion}/${x.action}${x.questMet ? ' · quest met' : ''} · ${metaLine(r)}`, 'ok');
    setPhase('reacting');
    reactingUntil = time + 2.5;
    setFrame('idle', 'Aim, then Capture');
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
      refreshCard();
      if (photo instanceof ImageBitmap) photo.close();
      return;
    }
    nothingStreak = 0;
    b.mascot.setMood(x.emotion, 4.5);
    b.mascot.play(x.action);
    say(x.quip, metaLine(r), 6);
    if (x.emotion === 'love' || x.emotion === 'delighted') b.mascot.celebrate(false);
    refreshCard();

    // the polaroid flies onto the shelf; Muse Image repaints it as a sticker there (never blocking)
    seen.push(x.object);
    const item: ShelfItem = { name: x.object, questMet: false, painting: Boolean(b.shelf) };
    if (photo instanceof ImageBitmap) item.photo = photo;
    else if (photo) item.photo = await createImageBitmap(photo).catch(() => undefined);
    if (!current()) { item.photo?.close(); return; }
    // The shelf owns this bitmap immediately; later photo animations may be
    // replaced by a new capture without orphaning the old image.
    b.shelf?.add(item);
    const landed = () => { if (current()) refreshCard(item.painting ? `${models.sticker} is painting a sticker…` : ''); };
    if (b.shelf && cardSide !== 'tucked') {
      stageToWorld(b.card.position.x + b.card.shelfLocal(cardSide === 'right' ? 'right' : 'left'), b.card.position.y, 0.01, shelfPoint);
      b.polaroid.state = 'flying';
      setTimeout(() => {
        if (!current() || !built) return;
        b.polaroid.go(shelfPoint, 0.035, 0.8, { arc: 0.05, done: () => { if (current()) { b.polaroid.hide(); landed(); } } });
      }, 1200);
    } else {
      b.polaroid.go(b.polaroid.position, 0.02, 0.8, { fade: true });
      b.polaroid.state = 'fading';
      landed();
    }
    if (!b.shelf) return;
    void buddyApi.sticker(jpeg, x.object, token())
      .then(async (s) => {
        if (!current()) return;
        if (!s.ok || !s.url) throw new Error(s.error ?? 'no sticker');
        const sticker = await loadSticker(s.url);
        if (!current()) return;
        item.sticker = sticker;
        app.page.log(`[buddy] sticker for ${x.object} · ${metaLine(s)}`, 'ok');
      })
      .catch((e) => app.page.log(`[buddy] sticker: ${(e as Error).message}`, 'warn'))
      .finally(() => {
        item.painting = false;
        if (current()) { b.shelf?.redraw(); if (phase !== 'thinking') refreshCard(); }
      });
  }

  async function capture(): Promise<void> {
    if (!built) return;
    const b = built, epoch = ++interactionEpoch;
    const current = () => interactionEpoch === epoch && phase !== 'closed';
    setPhase('capturing');
    b.viewfinder.progress = 1;
    b.viewfinder.flash();
    setFrame('lit', 'Got it!');
    b.mascot.setMood('noticing', 2);
    if (app.cameraState !== 'on') {
      try { await app.startCamera(); } catch { /* reported below */ }
    }
    if (!current()) return;
    b.viewfinder.corners(corners, 1);
    let crop: FrameCrop | null = null;
    try {
      crop = await cropFrame({ camera: app.camera, poses: app.poses, encoder: app.encoder }, corners, []);
    } catch (e) {
      app.page.log(`[buddy] crop failed: ${(e as Error).message}`, 'warn');
    }
    if (!current()) return;
    if (!crop) {
      b.mascot.setMood('confused', 3);
      say("The frame is outside the camera view. Try again.", 'Move it toward the centre, then Capture', 5);
      backToIdle();
      return;
    }
    if (crop) {
      lastCrop = crop;
      app.page.log(`[buddy] crop ${crop.width}×${crop.height} of the frame [${crop.box.join(',')}] in ${crop.image.join('×')}${crop.grewForHand ? ' (+hand)' : ''}`);
    }
    const jpeg = crop!.jpeg;
    const photo = await createImageBitmap(b64ToBlob(jpeg)).catch(() => undefined);
    if (!current()) { photo?.close(); return; }
    if (!photo) { backToIdle(); refreshCard('Could not prepare a preview. Capture again.'); return; }
    pendingPhoto?.photo instanceof ImageBitmap && pendingPhoto.photo.close();
    pendingPhoto = { jpeg, photo, via: 'photo' };
    setPhase('preview');
    holdPhoto(photo);
    b.viewfinder.position.copy(frameTarget); b.viewfinder.position.y += .045;
    b.polaroid.go(b.viewfinder.position, FRAME_SIZE * 1.05, 0.3);
    setFrame('busy', 'Review your photo');
    b.mascot.play('tilt');
    say('Is that the one? Show it to me, or Retake.', '', 5);
    refreshCard();
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
    const steady = phase === 'capturing' || phase === 'preview';
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
      p = handInFrame(f, frameMatrix, presence, wristMenuOpen());
      if (!p && sim) {
        presence.hand = undefined;
        presence.inside = 7;
        presence.point.copy(b.viewfinder.position);
        p = presence;
      }
    }
    stage.userData.inFrame = Boolean(p);

    if (phase === 'idle' || phase === 'reacting') {
      if (phase === 'reacting' && time > reactingUntil) { setPhase('idle'); refreshCard(); }
      b.viewfinder.mode = p ? 'lit' : 'idle';
      b.viewfinder.setLabel(time < frameHintUntil ? frameHint : p ? 'Ready when you are' : 'Aim, then Capture');
      // Natural social feedback never takes a picture. Wave with an open palm;
      // touch the head or meet the raised hand to pet/high-five Buddy.
      const palmUp = !!f.hands.left?.palmUp || !!f.hands.right?.palmUp;
      if (palmUp && !palmWasUp && time > gestureUntil && !wristMenuOpen()) {
        feature.wave(); gestureUntil = time + 3;
      }
      palmWasUp = palmUp;
      for (const side of ['left', 'right'] as const) {
        const tip = f.hands[side]?.joints['index-finger-tip']?.position;
        if (!tip || time < gestureUntil) continue;
        stageToWorld(0, 0.055, 0.02, holdPoint);
        if (tip.distanceToSquared(holdPoint) < 0.05 * 0.05) { poke(); gestureUntil = time + 2; break; }
        stageToWorld(0.081, 0.02, 0.04, holdPoint);
        if (tip.distanceToSquared(holdPoint) < 0.05 * 0.05) {
          b.mascot.play('clap'); b.mascot.setMood('delighted', 2.5); b.mascot.celebrate(false);
          app.demoAudio?.play('giggle'); say('High five!', '', 3); gestureUntil = time + 2; break;
        }
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
      refreshCard('Dozing… wave hello, or tap Buddy.');
    }


    // --- gaze: the frame while showing (and while it asks: the eyes point the way), the photo while thinking ---
    if (phase === 'thinking' || phase === 'preview') lookTarget.copy(b.polaroid.visible ? b.polaroid.position : b.viewfinder.position);
    else if (phase === 'capturing') lookTarget.copy(p ? p.point : b.viewfinder.position);
    else if (p && phase === 'idle') lookTarget.copy(p.point);
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
      interactionEpoch++;
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
      ask('first');
      nothingStreak = 0;
      wake();
      asleep = false;
      loadModels();
      if (app.cameraState !== 'on' && app.cameraState !== 'starting') void app.startCamera().catch(() => undefined);
      app.page.log('[buddy] open: Capture previews the object; Show shares the reviewed image');
    },
    close(silent = false) {
      if ((phase === 'closed' && !silent) || !built) return;
      interactionEpoch++;
      reactAbort?.abort();
      reactAbort = null;
      if (!silent) { built.mascot.play('wave'); built.mascot.setMood('delighted', 1); say('See you soon!', '', 1.5); }
      else { built.bubble.hide(); stage.visible = false; built.viewfinder.visible = false; }
      pendingPhoto?.photo instanceof ImageBitmap && pendingPhoto.photo.close();
      pendingPhoto = undefined;
      built.card.setVisible(false);
      built.viewfinder.wanted = false;
      built.viewfinder.progress = 0;
      built.polaroid.hide();
      removeSim();
      setPhase('closed');
      closingAt = silent ? -1 : time + 0.45;
      app.page.log('[buddy] closed');
    },
    toggle() {
      if (phase === 'closed') feature.open();
      else feature.close();
    },
    isOpen: () => phase !== 'closed',
    show() {
      if (!built) return;
      wake(); asleep = false;
      if (phase === 'preview' && pendingPhoto) {
        const captured = pendingPhoto; pendingPhoto = undefined;
        void react(captured.jpeg, captured.photo, captured.via); return;
      }
      if (phase !== 'idle' && phase !== 'reacting') return;
      void capture();
    },
    retake() {
      if (!built || phase !== 'preview') return;
      interactionEpoch++;
      pendingPhoto?.photo instanceof ImageBitmap && pendingPhoto.photo.close(); pendingPhoto = undefined;
      built.polaroid.hide(); backToIdle(); refreshCard('Aim the frame, then Capture again.');
    },
    wave() {
      if (!built || phase === 'closed' || phase === 'thinking' || phase === 'capturing') return;
      wake(); asleep = false; built.mascot.setMood('delighted', 3); built.mascot.play('wave');
      app.demoAudio?.play('curious'); say('Hi! Come say hello, or show me something.', '', 4);
    },
    showVirtual() {
      if (!built || phase === 'thinking' || phase === 'capturing') return;
      interactionEpoch++;
      const object = VIRTUAL_OBJECTS[virtualIndex++ % VIRTUAL_OBJECTS.length]!;
      const photo = drawVirtualObject(object);
      const jpeg = photo.toDataURL('image/jpeg', .85).split(',')[1]!;
      pendingPhoto?.photo instanceof ImageBitmap && pendingPhoto.photo.close();
      pendingPhoto = { jpeg, photo, via: 'virtual' };
      setPhase('preview'); holdPhoto(photo);
      built.viewfinder.position.copy(frameTarget); built.viewfinder.position.y += .045;
      built.polaroid.go(built.viewfinder.position, FRAME_SIZE * 1.05, .3);
      setFrame('busy', 'Virtual object'); built.mascot.play('tilt');
      refreshCard(`Virtual ${object}. Press Show, or choose Virtual for another.`);
    },
    async showImage(url: string) {
      if (phase === 'closed') feature.open();
      if (!built || phase === 'thinking' || phase === 'capturing') return;
      const epoch = ++interactionEpoch;
      const current = () => interactionEpoch === epoch && phase !== 'closed';
      const response = await fetch(url);
      if (!current()) return;
      const blob = await response.blob();
      if (!current()) return;
      const photo = await createImageBitmap(blob).catch(() => undefined);
      if (!current()) { photo?.close(); return; }
      const jpeg = await blobToB64(blob);
      if (!current()) { photo?.close(); return; }
      built.viewfinder.flash(); await react(jpeg, photo, 'photo');
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
      quest: '',
      kicker: 'MUSE BUDDY',
      done: 0,
      met: 0,
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
  // wrist menu → Buddy toggles it: a glass button while it is closed, the same slot as a white "on" pill while it is open
  // (white = on, as in the rest of the wrist menu), so the way out is the same button you came in with
  app.registerPaletteItem({ key: 'buddy', label: 'Buddy', order: 10, visible: () => phase === 'closed', onSelect: () => feature.toggle() });
  app.registerPaletteItem({ key: 'buddy:on', label: 'Buddy', order: 10, primary: true, visible: () => phase !== 'closed', onSelect: () => feature.toggle() });
  // the wrist menu's Stop stops the buddy too
  try {
    app.hud?.on('deck', (e) => { if (e.key === 'panic' && e.phase === 'press' && phase !== 'closed') feature.close(); });
  } catch { /* a HUD without events */ }
  return feature;
}
