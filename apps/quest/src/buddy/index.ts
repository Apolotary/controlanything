/**
 * MUSE BUDDY: a small AR mascot at desk height you show real objects to.
 *
 *   Wrist palette → "Buddy". It pops in beside you, waves, and asks for something ("Show me something green!").
 *   Hold an object up in front of your face and keep it still for ~1 s (or press Show): a viewfinder locks on,
 *   the app crops the object from the passthrough camera (crop.ts) and Muse Spark (vision, json_schema, low effort)
 *   answers in character: object name, emotion, a one-line quip, a body action, and whether it fits the quest.
 *   The buddy plays it (face + body), the quip types out in its speech bubble with the model id underneath, quests
 *   met throw confetti, and every object lands on its collection shelf, where Muse Image repaints it as a sticker
 *   (~10 s later, never blocking the reaction). Poke it for a giggle.
 *
 * Cost when closed: one early-return frame hook. Open: ~10 mascot draw calls + 2 uikit roots + viewfinder, no
 * per-frame allocations; capture, encode and inference all happen off the render path (async).
 */
import { Group, type Object3D, type Quaternion, Vector3, type Scene } from 'three';
import type { ShellFrame } from '../app/hud-contract';
import type { PaletteItem } from '../hud/v2/wrist-palette';
import type { CameraSource } from '../scan/camera';
import type { JpegEncoder } from '../scan/encode';
import type { PoseRing } from '../scan/poses';
import { buddyApi, type ReactResult } from './api';
import { cropPresented, findPresenter, gazePresenter, type Presenter } from './crop';
import { Mascot } from './mascot';
import { HELLO_LINES, pick, POKE_LINES, QuestLog } from './quests';
import { loadSticker, Shelf, type ShelfItem } from './shelf';
import { BuddyCard, SpeechBubble } from './ui';
import { Viewfinder } from './viewfinder';

/** What the buddy needs from the shell (QuestApp satisfies it structurally). */
export interface BuddyHost {
  scene: Scene;
  camera: CameraSource;
  poses: PoseRing;
  encoder: JpegEncoder;
  identity?: { deviceToken: string };
  cameraState: 'off' | 'starting' | 'on' | 'error';
  startCamera(): Promise<void>;
  live?: { running: boolean; aimables(): { id: string; position: Vector3; size: number }[] };
  registerPaletteItem(item: PaletteItem): () => void;
  addFrameHook(hook: (f: ShellFrame, dtSec: number, timeMs: number, xrFrame?: XRFrame) => void): () => void;
  page: { log(msg: string, level?: 'info' | 'ok' | 'warn' | 'error'): void };
}

export type BuddyPhase = 'closed' | 'idle' | 'noticing' | 'countdown' | 'capturing' | 'thinking' | 'reacting';

export interface BuddyFeature {
  readonly root: Object3D;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  /** Show button: a short countdown, then capture what is held up (or what you look at). */
  show(): void;
  /** Dev/e2e: react to a static photo as if it were held up (the emulator's stand-in for a real object). */
  showImage(url: string): Promise<void>;
  state(): { asleep: boolean; phase: BuddyPhase; quest: string; done: number; collected: string[]; lastReaction?: ReactResult; bubble: string };
}

const DWELL_START = 0.25;
const DWELL_FIRE = 1.15;
const COOLDOWN_S = 3.5;

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

export function installBuddy(app: BuddyHost): BuddyFeature {
  const stage = new Group();
  stage.name = 'buddy';
  stage.visible = false;
  let built: { mascot: Mascot; bubble: SpeechBubble; card: BuddyCard; viewfinder: Viewfinder; shelf: Shelf | null } | null = null;

  let phase: BuddyPhase = 'closed';
  let time = 0;
  let openedAt = 0;
  let closingAt = -1;
  let following = false;
  let yaw = 0;
  let dwell = 0;
  let cooldownUntil = 0;
  let countdown = 0;
  let countdownShown = -1;
  let reactingUntil = 0;
  let nextAskAt = Infinity;
  let lastReaction: ReactResult | undefined;
  let lastF: ShellFrame | undefined;
  const quests = new QuestLog();
  const seen: string[] = [];

  const home = new Vector3();
  const fwd = new Vector3();
  const right = new Vector3();
  const lastPresenter = new Vector3();
  const lookTarget = new Vector3();
  const presenterBuf: Presenter = { kind: 'gaze', point: new Vector3(), distance: 0, score: 0 };
  const gazeBuf: Presenter = { kind: 'gaze', point: new Vector3(), distance: 0, score: 0 };
  const jointPool: Vector3[] = Array.from({ length: 26 }, () => new Vector3());
  const joints: Vector3[] = [];
  let presenterSpeed = 0;
  let hasLastPresenter = false;

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
  // after a minute without play it dozes off (and stops auto-catching raised hands) until poked or shown something
  const AWAKE_S = 60;
  let awakeUntil = 0;
  let asleep = false;
  const wake = (now = time) => { awakeUntil = now + AWAKE_S; };
  const say = (text: string, meta = '', holdS = 6) => built?.bubble.say(text, meta, holdS);

  const refreshCard = (status = '') => {
    built?.card.set({ quest: quests.current, collected: built.shelf?.items.length ?? seen.length, done: quests.done, status });
  };

  function build(): NonNullable<typeof built> {
    const mascot = new Mascot();
    const bubble = new SpeechBubble();
    bubble.position.set(-0.025, 0.095, 0);
    let shelf: Shelf | null = null;
    try {
      shelf = typeof document !== 'undefined' ? new Shelf() : null;
    } catch {
      shelf = null;
    }
    const card = new BuddyCard(shelf?.texture ?? null, { show: () => feature.show(), skip: () => skipQuest(), close: () => feature.close() });
    card.position.set(-0.11, 0.0, 0);
    const viewfinder = new Viewfinder();
    stage.add(mascot, bubble, card);
    app.scene.add(stage, viewfinder);
    mascot.body.addEventListener('click' as never, (() => poke()) as never);
    return { mascot, bubble, card, viewfinder, shelf };
  }

  function placeHome(f: ShellFrame): void {
    fwd.set(0, 0, -1).applyQuaternion(f.head.quaternion as Quaternion);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    right.set(-fwd.z, 0, fwd.x);
    home.copy(f.head.position).addScaledVector(fwd, 0.55).addScaledVector(right, 0.15);
    home.y -= 0.2;
  }

  function skipQuest(): void {
    wake();
    asleep = false;
    quests.next();
    refreshCard();
    built?.mascot.play('nod');
    say(quests.ask());
  }

  function poke(): void {
    if (!built || phase === 'closed' || phase === 'thinking' || phase === 'capturing') return;
    wake();
    if (asleep) {
      asleep = false;
      built.mascot.play('hop');
      built.mascot.setMood('surprised', 1.5);
      say(`Huh? I'm awake! ${quests.ask()}`, '', 6);
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

  async function react(jpeg: string, photoBlob: Blob, via: 'hand' | 'yolo' | 'gaze' | 'photo'): Promise<void> {
    if (!built) return;
    const b = built;
    setPhase('thinking');
    b.mascot.setMood('thinking', Infinity);
    wake();
    asleep = false;
    say('Hmm, let me see…', `asking ${models.react}…`, Infinity);
    refreshCard(`${models.react} is looking…`);
    const photo = createImageBitmap(photoBlob).catch(() => undefined);
    const quest = quests.current;
    let r: ReactResult;
    try {
      r = await buddyApi.react(jpeg, quest, seen, via, token());
    } catch (e) {
      if (phase === 'closed') return;
      b.mascot.setMood('confused', 3);
      b.mascot.play('shiver');
      say('My brain hiccuped. Try again?', String((e as Error).message).slice(0, 60), 5);
      app.page.log(`[buddy] react failed: ${(e as Error).message}`, 'warn');
      refreshCard();
      setPhase('idle');
      cooldownUntil = time + 1.5;
      void photo.then((p) => p?.close());
      return;
    }
    if (phase === 'closed') return;
    lastReaction = r;
    stage.userData.lastReaction = r;
    const x = r.reaction;
    app.page.log(`[buddy] ${x.object} → ${x.emotion}/${x.action}${x.questMet ? ' · quest met' : ''} · ${metaLine(r)}`, 'ok');
    b.mascot.setMood(x.emotion, 4.5);
    b.mascot.play(x.action);
    say(x.quip, metaLine(r), 6);
    if (x.questMet) {
      b.mascot.celebrate(true);
      quests.complete();
      nextAskAt = time + 4.5;
    } else if (x.emotion === 'love' || x.emotion === 'delighted') {
      b.mascot.celebrate(false);
    }
    setPhase('reacting');
    reactingUntil = time + 2.5;
    cooldownUntil = time + COOLDOWN_S;
    const p = await photo;
    if (x.object === 'nothing' || !b.shelf) {
      p?.close();
      refreshCard();
      return;
    }
    seen.push(x.object);
    const item: ShelfItem = b.shelf.add({ name: x.object, questMet: x.questMet, photo: p, painting: true });
    refreshCard(`${models.sticker} is painting a sticker…`);
    // the sticker never blocks: the photo is on the shelf already
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
        if (phase !== 'closed') refreshCard();
      });
  }

  async function capture(p: Presenter): Promise<void> {
    if (!built) return;
    const b = built;
    setPhase('capturing');
    b.viewfinder.progress = 1;
    b.viewfinder.flash();
    b.mascot.setMood('noticing', 2);
    if (app.cameraState !== 'on') {
      try { await app.startCamera(); } catch { /* reported below */ }
    }
    let crop = null;
    try {
      crop = await cropPresented({ camera: app.camera, poses: app.poses, encoder: app.encoder, liveBoxes: () => (app.live?.running ? app.live.aimables() : []) }, p, joints);
    } catch (e) {
      app.page.log(`[buddy] crop failed: ${(e as Error).message}`, 'warn');
    }
    b.viewfinder.wanted = false;
    if (phase === 'closed') return;
    if (!crop) {
      b.mascot.setMood('confused', 3);
      say("I can't see a thing! Is the camera on?", 'Camera + mic, then try again', 5);
      setPhase('idle');
      cooldownUntil = time + 2;
      return;
    }
    app.page.log(`[buddy] crop ${crop.width}×${crop.height} via ${crop.via} (${Math.round(crop.sizeM * 100)} cm)`);
    await react(crop.jpeg, b64ToBlob(crop.jpeg), crop.via);
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

  function placeViewfinder(f: ShellFrame, p: Presenter): void {
    if (!built) return;
    const v = built.viewfinder;
    v.position.copy(p.point);
    v.quaternion.copy(f.head.quaternion as Quaternion);
    v.scale.setScalar(Math.max(0.12, Math.min(0.26, p.distance * 0.42)));
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
      return;
    }

    // --- placement: a pet on a soft leash (it stays put until you move away, then floats over) ---
    placeHome(f);
    const steady = phase === 'noticing' || phase === 'countdown' || phase === 'capturing';
    const d = stage.position.distanceTo(home);
    if (!steady && (following || d > 0.28)) {
      following = d > 0.03;
      stage.position.lerp(home, 1 - Math.exp(-2.2 * dt));
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

    // --- what is held up? (tracked hands only; the emulator mouse uses the Show button) ---
    const p = phase === 'closed' ? null : findPresenter(f, presenterBuf);
    const handBusy = p?.hand ? Boolean(f.hands[p.hand]?.pinching) : false;
    const nearCard = p ? p.point.distanceTo(stage.position) < 0.22 : false;
    if (p && hasLastPresenter) presenterSpeed += (p.point.distanceTo(lastPresenter) / Math.max(dt, 1e-3) - presenterSpeed) * (1 - Math.exp(-10 * dt));
    if (p) { lastPresenter.copy(p.point); hasLastPresenter = true; } else hasLastPresenter = false;

    if (phase === 'idle' || phase === 'noticing') {
      const eligible = p && !asleep && !handBusy && !nearCard && time > cooldownUntil && presenterSpeed < 0.35;
      dwell = eligible ? dwell + dt : Math.max(0, dwell - dt * 2);
      if (phase === 'idle' && dwell > DWELL_START && p) {
        setPhase('noticing');
        b.mascot.setMood('noticing', Infinity);
        say('Ooh, what is that?', '', Infinity);
        b.viewfinder.wanted = true;
      }
      if (phase === 'noticing') {
        if (dwell <= 0 || !p) {
          setPhase('idle');
          b.mascot.setMood('neutral', Infinity);
          b.viewfinder.wanted = false;
          b.bubble.hide();
        } else {
          placeViewfinder(f, p);
          b.viewfinder.progress = Math.min(1, (dwell - DWELL_START) / (DWELL_FIRE - DWELL_START));
          if (dwell >= DWELL_FIRE) {
            dwell = 0;
            snapshotJoints(f, p.hand);
            void capture({ ...p, point: p.point.clone() });
          }
        }
      }
    } else if (phase === 'countdown') {
      countdown -= dt;
      const target = p ?? gazePresenter(f, gazeBuf);
      placeViewfinder(f, target);
      b.viewfinder.progress = 1 - Math.max(0, countdown) / 1.5;
      const n = Math.ceil(countdown / 0.5);
      if (n !== countdownShown && n > 0) {
        countdownShown = n;
        say(`Hold it up… ${n}`, '', 2);
      }
      if (countdown <= 0) {
        snapshotJoints(f, target.hand);
        void capture({ ...target, point: target.point.clone() });
      }
    } else if (phase === 'reacting' && time > reactingUntil) {
      setPhase('idle');
      refreshCard();
    }
    if (phase === 'idle' && !asleep && time > awakeUntil) {
      asleep = true;
      b.mascot.setMood('sleepy', Infinity);
      b.bubble.hide();
      refreshCard('Dozing… poke me or press Show');
    }
    if (phase === 'idle' && time > nextAskAt && !asleep) {
      nextAskAt = Infinity;
      refreshCard();
      say(quests.ask(), '', 8);
      b.mascot.play('hop');
    }

    // --- gaze: the held thing while showing, else you (and a curious glance at a raised hand) ---
    if (phase === 'thinking') b.mascot.update(dt, null);
    else {
      if ((phase === 'noticing' || phase === 'countdown' || phase === 'capturing') && p) lookTarget.copy(p.point);
      else if (phase === 'countdown' || phase === 'capturing') lookTarget.copy(b.viewfinder.position);
      else if (p) lookTarget.copy(p.point);
      else lookTarget.copy(f.head.position);
      b.mascot.update(dt, lookTarget);
    }
    b.viewfinder.update(dt);
    b.bubble.update(dt * 1000);
    b.card.update(dt * 1000);
  }

  const feature: BuddyFeature = {
    root: stage,
    open() {
      if (phase !== 'closed' && closingAt < 0) return;
      if (!built) built = build();
      closingAt = -1;
      setPhase('idle');
      openedAt = time;
      stage.visible = true;
      built.card.setVisible(true);
      if (lastF) {
        placeHome(lastF);
        stage.position.copy(home);
        yaw = Math.atan2(lastF.head.position.x - home.x, lastF.head.position.z - home.z);
      }
      following = false;
      built.mascot.setMood('delighted', 2.5);
      built.mascot.play('wave');
      refreshCard();
      say(`${pick(HELLO_LINES)} ${quests.ask()}`, '', 8);
      cooldownUntil = time + 1.5;
      wake();
      asleep = false;
      loadModels();
      if (app.cameraState !== 'on' && app.cameraState !== 'starting') void app.startCamera().catch(() => undefined);
      app.page.log('[buddy] open');
    },
    close() {
      if (phase === 'closed' || !built) return;
      built.mascot.play('wave');
      built.mascot.setMood('delighted', 1);
      say('Bye! Bring me treasures later.', '', 1.5);
      built.card.setVisible(false);
      built.viewfinder.wanted = false;
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
      if (!built || (phase !== 'idle' && phase !== 'reacting' && phase !== 'noticing')) return;
      wake();
      asleep = false;
      setPhase('countdown');
      countdown = 1.5;
      countdownShown = -1;
      built.viewfinder.wanted = true;
      built.mascot.setMood('noticing', Infinity);
    },
    async showImage(url: string) {
      if (phase === 'closed') feature.open();
      if (!built || phase === 'thinking' || phase === 'capturing') return;
      const blob = await (await fetch(url)).blob();
      built.viewfinder.flash();
      await react(await blobToB64(blob), blob, 'photo');
    },
    state: () => ({ asleep, phase, quest: quests.current, done: quests.done, collected: [...seen], lastReaction, bubble: String(built?.bubble.userData.text ?? '') }),
  };

  app.addFrameHook((f, dt) => frame(f, dt));
  // track the head even while closed, so the first open spawns in front of you (cheap: one reference)
  app.addFrameHook((f) => { lastF = f; });
  app.registerPaletteItem({ key: 'buddy', label: 'Buddy', order: 10, onSelect: () => feature.toggle() });
  return feature;
}
