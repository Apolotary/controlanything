/**
 * ControlAnything without a headset: the Quest's golden path on a laptop webcam or a phone, AR view first.
 *   Start AR (one tap, for the camera permission) → passthrough: WebXR immersive-ar on Android Chrome, else the
 *   rear camera full screen (phones) or the mirrored webcam (laptops) → Annotate: SAM 3.1 outlines through the
 *   Quest's server path, tag by tapping (phone) or holding a hand over it / closing the hand (webcam) → Control:
 *   select a tagged device → ask with the Quest's chips or by voice (Muse Voice Transcribe) → the Muse agent
 *   writes and tests a connector, its code card streams beside the device → Muse's controls appear pinned to the
 *   device, and a hand program runs on webcam (or touch) Signals in the Quest's sandbox → Stop Muse.
 * Hand tracking on the webcam is classic computer vision (no AI model). Visual and musical synth on this page
 * are optional demos under More, as on the Quest.
 */
import './style.css';
import { demoAudioMaster, type DeviceInfo, type WireReadyPayload } from '@ce/protocol';
import { QuestDemoAudio } from '../audio/demo-audio';
import { renderControls } from '../reviewer/connection';
import { Mic } from '../voice/mic';
import { PushToTalk } from '../voice/ptt';
import { LAPTOP_WIRE_CHIPS, MUSICAL_WIRE_CHIPS, PHYSICAL_WIRE_CHIPS } from '../wiring/controller';
import { Annotator, FILTERS, type Detection, type Filter } from './annotate';
import { HandCamera } from './camera';
import { HandsConnection, type Instrument } from './connection';
import { nowView, Tutorial, type WirePhase } from './dashboard';
import { Overlay, type OverlayItem } from './overlay';
import { HandSound } from './sound';
import { HandTracker, coverScale, imageToDisplay, type TrackedHand } from './tracker';
import { HandVisuals, type Quality } from './visuals';
import { PhoneAR } from './xr';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const button = (id: string) => $<HTMLButtonElement>(id);
const params = new URLSearchParams(location.search);
const quiet = params.get('mute') === '1';
const phone = params.get('device') === 'phone' || (params.get('device') !== 'laptop' && (matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 600));
const input: 'hand' | 'touch' = phone ? 'touch' : 'hand';
const audio = new QuestDemoAudio(params);
const sound = new HandSound(quiet);
const isLaptop = (label: string) => /\b(laptop|macbook|mac|computer|notebook|monitor|screen|display|visual synth)\b/i.test(label);
/** The Quest's chips for the explicit visual synth demo, without the screen-touch one (no screen to touch here). */
const VISUAL_DEMO_CHIPS = ['Hands as knobs', 'Give me knobs for the visuals'] as const;

// --- state -------------------------------------------------------------------------------------------------------

let ar: 'off' | 'camera' | 'xr' = 'off';
let layer: 'annotate' | 'control' = 'annotate';
let selected: string | undefined;
let demo: Instrument | undefined;
let ready: WireReadyPayload | undefined;
let phase: WirePhase = 'idle';
let phaseLine = '';
let wireSource: WireReadyPayload['source'] | undefined;
let devices: DeviceInfo[] = [];
let synthMix = 0;
let lastHud = 0;
let dwell: { key: string; since: number; fired: boolean } | undefined;
let lastFist = false;
let menuOpen = false;
let ptt: PushToTalk | undefined;
let pendingAsk: { text: string; source: 'chip' | 'text' | 'voice' } | undefined;
const outputs = new Map<string, { value: number | boolean; at: number; pulsedAt: number; pulsedValue: number }>();

const quality: Quality = (params.get('quality') as Quality) || (phone ? 'low' : 'high');
const stage = $('stage');
const video = $<HTMLVideoElement>('camera');
const synthCanvas = document.createElement('canvas');
synthCanvas.width = 640; synthCanvas.height = 360;
let visuals: HandVisuals;
try { visuals = new HandVisuals(stage, quality); }
catch (e) { $('start-note').textContent = `This browser cannot run the GPU view (${(e as Error).message}). Try a current Chrome or Safari.`; throw e; }
visuals.setSynthCanvas(synthCanvas);
visuals.passthrough = 1;
const overlay = new Overlay($('overlay-host'));
const tutorial = new Tutorial(input);

const toast = (text: string, ms = 3400) => {
  const t = $('toast'); t.textContent = text; t.classList.add('show');
  clearTimeout((toast as unknown as { timer?: number }).timer);
  (toast as unknown as { timer?: number }).timer = window.setTimeout(() => t.classList.remove('show'), ms);
};

const tracker = new HandTracker({
  width: 192,
  onResult: (r) => { visuals.setFlow(r.flow, r.gw, r.gh); if (r.mask) visuals.setMask(r.mask, r.w, r.h); },
  onCalibrated: (c, ref) => {
    $('calib').hidden = true; audio.play(c.ok ? 'ready' : 'stop');
    toast(c.ok ? `${c.message}${ref ? '' : ' (No hand was seen in the box, so the open-hand size stays at its default.)'}` : c.message, 5200);
  },
});

const annotator = new Annotator((frame, filter) => connection.scanFrame(frame, filter));

const connection = new HandsConnection(synthCanvas, {
  pairing: text => { if (text) toast(text, 8000); },
  status: (text, error) => { if (error) toast(text, 6000); },
  wire: (text, p) => {
    phase = p; phaseLine = text;
    const el = $('wire-status'); el.textContent = text; el.dataset.phase = p;
    audio.setThinking('wire', p === 'working');
    $('code-wrap').hidden = p === 'idle';
    button('stop').hidden = !(p === 'working' || p === 'running' || p === 'ready');
    if (p === 'running') { audio.play('ready'); toast('Muse wired your hands. Move them.'); }
    if (p === 'failed') audio.play('stop');
    $('code-source').textContent = /FIXTURE/.test(text) ? 'FIXTURE · scripted' : p === 'running' || p === 'ready' ? 'Muse Spark' : p === 'working' ? 'Muse is writing…' : '';
  },
  code: text => { const el = $('code'); el.textContent = text; el.scrollTop = el.scrollHeight; $('code-wrap').hidden = false; },
  selected: on => {
    if (on && pendingAsk) { const a = pendingAsk; pendingAsk = undefined; if (connection.ask(a.text, a.source)) phase = 'working'; }
  },
  ready: payload => {
    ready = payload; wireSource = payload?.source; outputs.clear();
    renderControls($('controls'), payload, (action, value) => { unlock(); connection.control(action, value); });
    $('controls-card').hidden = !$('controls').childElementCount;
    if (payload?.code.trim()) tracker.resetSignals();
    if (payload?.explanation) audio.speak(payload.explanation.replace(/^(FIXTURE|Template)[^.]*\.\s*/i, '').slice(0, 180));
    document.body.classList.toggle('wired', !!payload);
  },
  receipt: text => { $('receipt').textContent = text; },
  output: (actionId, value) => {
    const now = performance.now();
    const o = outputs.get(actionId) ?? { value, at: now, pulsedAt: -Infinity, pulsedValue: typeof value === 'number' ? value : 0 };
    o.value = value; o.at = now;
    const action = ready?.actions.find(a => a.actionId === actionId);
    const range = action && action.min !== undefined && action.max !== undefined ? Math.abs(action.max - action.min) || 1 : 127;
    const n = typeof value === 'number' ? value : value ? range : 0;
    if (now - o.pulsedAt > 220 && (typeof value !== 'number' || Math.abs(n - o.pulsedValue) > range * 0.22)) {
      const lead = leadHand();
      if (lead) visuals.pulse(lead.x, lead.y, 0.6 + 0.6 * (typeof value === 'number' ? Math.min(1, Math.abs(n - o.pulsedValue) / range) : 1));
      o.pulsedAt = now; o.pulsedValue = n;
    }
    outputs.set(actionId, o);
  },
  applied: (which, label) => { $('receipt').textContent = `Applied by this page's ${which === 'visual-synth' ? 'visual synth' : 'Web Audio synth'} · ${label}`; },
  scan: (r) => annotator.onResult(r),
  tags: (list) => { annotator.syncTags(list); if (selected && !annotator.tags.has(selected)) deselect(); },
  card: (card) => { const t = annotator.tags.get(card.cardId); if (t && card.name) t.name = card.name; },
  mode: (m) => { if (m !== layer) setLayer(m, false); },
  presence: (list) => { devices = list; },
});

const camera = new HandCamera(video, (on, text, error) => {
  if (error) toast(text, 6000);
  if (!on) { tracker.stop(); visuals.setVideo(null); }
});
camera.facing = phone ? 'environment' : 'user';

const phoneAR = new PhoneAR(visuals, tracker, {
  changed: (active, message) => {
    document.body.classList.toggle('in-xr', active);
    if (message) toast(message, 7000);
    if (!active && ar === 'xr') { ar = 'off'; void startCamera(); }
  },
  frame: (canvas) => { xrFrame = canvas; },
});
let xrFrame: HTMLCanvasElement | null = null;

// --- helpers -----------------------------------------------------------------------------------------------------

const unlock = () => { demoAudioMaster.unlock(); audio.unlock(); sound.unlock(); };
const leadHand = (): TrackedHand | undefined => { const hs = tracker.hands(); return hs.find(h => h.side === 'right') ?? hs[0]; };
const frameCanvas = document.createElement('canvas');
const frameSource = {
  grab(): HTMLCanvasElement | null {
    if (ar === 'xr') { const c = xrFrame; xrFrame = null; return c; }
    if (!camera.active || video.readyState < 2 || !video.videoWidth) return null;
    if (frameCanvas.width !== video.videoWidth || frameCanvas.height !== video.videoHeight) { frameCanvas.width = video.videoWidth; frameCanvas.height = video.videoHeight; }
    frameCanvas.getContext('2d')!.drawImage(video, 0, 0);
    return frameCanvas;
  },
};
/** camera-image (0..1) → stage (0..1): the cover fit of the passthrough, mirrored for a front camera */
const toDisplay = (x: number, y: number) => ar === 'xr' ? phoneAR.imageToDisplay(x, y) : imageToDisplay(tracker.view, x, y);

function filterLabel(): string { return FILTERS.find(f => f.id === annotator.filter)?.label ?? 'All'; }

function renderFilters(): void {
  const box = $('filters'); box.replaceChildren();
  for (const f of FILTERS) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = f.label;
    b.classList.toggle('selected', f.id === annotator.filter); b.setAttribute('aria-pressed', String(f.id === annotator.filter));
    b.onclick = () => { unlock(); audio.play('tap'); annotator.filter = f.id as Filter; annotator.detections = []; renderFilters(); };
    box.append(b);
  }
}

function setLayer(next: 'annotate' | 'control', send = true): void {
  layer = next;
  button('layer-annotate').classList.toggle('selected', next === 'annotate'); button('layer-annotate').setAttribute('aria-pressed', String(next === 'annotate'));
  button('layer-control').classList.toggle('selected', next === 'control'); button('layer-control').setAttribute('aria-pressed', String(next === 'control'));
  $('filters').hidden = next !== 'annotate';
  annotator.active = next === 'annotate' && ar !== 'off';
  document.body.dataset.layer = next;
  if (send) connection.setMode(next);
  if (next === 'annotate') { if (selected || demo) deselect(); }
  else toast(annotator.tags.size ? (input === 'touch' ? 'Control: tap a tagged device to select it.' : 'Control: hold your hand over a tagged device (or click it) to select it.') : 'Control: tag a device in Annotate first, or open More for the optional demos.');
}

function chipsFor(): readonly string[] {
  if (demo === 'visual-synth') return VISUAL_DEMO_CHIPS;
  if (demo === 'musical-synth') return MUSICAL_WIRE_CHIPS;
  const t = selected ? annotator.tags.get(selected) : undefined;
  return t && isLaptop(`${t.label} ${t.name ?? ''}`) ? LAPTOP_WIRE_CHIPS : PHYSICAL_WIRE_CHIPS;
}

function openCard(): void {
  const t = selected ? annotator.tags.get(selected) : undefined;
  $('card').hidden = false;
  $('card-kind').textContent = demo ? 'OPTIONAL DEMO · ON THIS PAGE' : 'SELECTED · TAGGED IN ANNOTATE';
  $('card-title').textContent = demo === 'visual-synth' ? 'Visual synth' : demo === 'musical-synth' ? 'Musical synth' : t?.name ?? t?.label ?? 'Device';
  $('card-hint').textContent = demo ? 'Authored software instrument on this page. Muse writes the connector and the hand program.' : t?.hint ?? '';
  const box = $('card-chips'); box.replaceChildren();
  for (const text of chipsFor()) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = text;
    b.onclick = () => { unlock(); audio.play('tap'); ask(text, 'chip'); };
    box.append(b);
  }
  document.body.classList.add('card-open');
}

function select(cardId: string): void {
  if (selected === cardId) return;
  demo = undefined;
  selected = cardId; overlay.selected = cardId;
  connection.selectCard(cardId);
  audio.play('tap');
  phase = 'idle'; $('wire-status').textContent = ''; $('code').textContent = ''; $('code-wrap').hidden = true;
  openCard();
}

function deselect(): void {
  if (selected || demo) connection.deselect();
  selected = undefined; demo = undefined; overlay.selected = undefined;
  $('card').hidden = true; $('controls-card').hidden = true; document.body.classList.remove('card-open');
}

async function openDemo(instrument: Instrument): Promise<void> {
  unlock(); closeMenu();
  if (layer !== 'control') setLayer('control');
  selected = undefined; overlay.selected = undefined; demo = instrument;
  phase = 'idle'; $('wire-status').textContent = ''; $('code').textContent = ''; $('code-wrap').hidden = true;
  openCard();
  if (connection.connected) await connection.choose(instrument); else await connection.connect(instrument);
}

function ask(text: string, source: 'chip' | 'text' | 'voice'): void {
  if (!text.trim()) { toast('Tell Muse what your hands should do, or tap an idea.'); return; }
  if (!selected && !demo) { toast('Select a tagged device first (Control).'); return; }
  if (connection.ask(text, source)) { phase = 'working'; button('stop').hidden = false; return; }
  pendingAsk = { text, source };
  if (demo) void connection.choose(demo); else if (selected) connection.selectCard(selected);
}

/** A tap, a click or a held hand on the AR view. */
function act(item: OverlayItem | undefined): void {
  if (!item) return;
  if (layer === 'annotate') {
    if (item.kind === 'tag') { toast(`${item.label} is tagged. Choose Control to use it.`); return; }
    const det = item.det as Detection;
    if (/\b(person|people|human|face|hand|body)\b/i.test(det.label)) return;
    const tag = annotator.addTag(det);
    annotator.pending.add(tag.cardId);
    if (connection.tag({ targetId: tag.cardId, label: det.label, frameId: det.frameId, detId: det.detId })) {
      audio.play('ready'); visuals.pulse((item.box.x0 + item.box.x1) / 2, (item.box.y0 + item.box.y1) / 2, 1);
      toast(`Tagged ${det.label}. You stay in Annotate.`);
    }
  } else if (item.kind === 'tag' && item.tag) select(item.tag.cardId);
}

function closeMenu(): void { menuOpen = false; $('more-menu').hidden = true; button('more').setAttribute('aria-expanded', 'false'); }

// --- AR start ----------------------------------------------------------------------------------------------------

async function startCamera(): Promise<boolean> {
  const ok = await camera.start();
  if (!ok) return false;
  ar = 'camera';
  tracker.view.mirror = camera.mirror;
  if (!phone) tracker.start(video, camera.mirror, camera.facing === 'user');
  visuals.setVideo(video);
  $('ar-badge').textContent = phone ? (phoneAR.available === false ? 'Camera view · this browser has no WebXR AR' : 'Camera view') : 'Webcam passthrough · hands: classic computer vision, no AI model';
  return true;
}

async function startAR(): Promise<void> {
  unlock();
  button('start-ar').disabled = true;
  $('start-note').textContent = 'Starting… allow the camera when the browser asks.';
  const connecting = connection.connect();
  let ok = false;
  if (phone && phoneAR.available) {
    ok = await phoneAR.start();
    if (ok) { ar = 'xr'; $('ar-badge').textContent = 'WebXR AR'; }
  }
  if (!ok) ok = await startCamera();
  button('start-ar').disabled = false;
  if (!ok) { $('start-note').textContent = 'The camera did not start. Allow camera access and try again.'; return; }
  document.body.classList.remove('start-open'); document.body.classList.add('ar-on');
  await connecting;
  setLayer('annotate');
  audio.play('ready');
  toast(phone ? 'Annotate: point at a device. Tap its outline to tag it.' : 'Annotate: show the camera a device. Hold your hand over its outline (or click it) to tag it.', 5000);
}

// --- events ------------------------------------------------------------------------------------------------------

button('start-ar').onclick = () => void startAR();
button('layer-annotate').onclick = () => { unlock(); audio.play('tap'); setLayer('annotate'); };
button('layer-control').onclick = () => { unlock(); audio.play('tap'); setLayer('control'); };
button('more').onclick = () => { unlock(); menuOpen = !menuOpen; $('more-menu').hidden = !menuOpen; button('more').setAttribute('aria-expanded', String(menuOpen)); };
button('demo-visual').onclick = () => void openDemo('visual-synth');
button('demo-music').onclick = () => void openDemo('musical-synth');
button('buddy').onclick = () => { location.href = './reviewer.html?buddy=1'; };
button('calibrate').onclick = () => { closeMenu(); calibrate(); };
button('mask').onclick = () => { const on = visuals.maskMix === 0; visuals.maskMix = on ? 1 : 0; button('mask').setAttribute('aria-pressed', String(on)); if (on) toast('Purple = skin colour, green = a tracked hand, yellow = the face (ignored).', 5000); };
button('flip').onclick = async () => { closeMenu(); unlock(); if (ar !== 'camera') return; const ok = await camera.flip(); if (ok) { tracker.view.mirror = camera.mirror; if (!phone) tracker.start(video, camera.mirror, camera.facing === 'user'); visuals.setVideo(video); } };
button('hand-sound').onclick = () => { sound.setEnabled(!sound.enabled); button('hand-sound').setAttribute('aria-pressed', String(sound.enabled)); };
button('stop-all').onclick = () => { closeMenu(); pendingAsk = undefined; connection.stop('Stop all'); audio.play('stop'); deselect(); toast('Stopped. Nothing is wired now.'); };
button('card-close').onclick = () => { deselect(); };
button('stop').onclick = () => { pendingAsk = undefined; connection.stop('Stopped by you'); audio.play('stop'); button('stop').hidden = true; phase = 'stopped'; $('wire-status').textContent = 'Stopped. Ask again any time.'; $('wire-status').dataset.phase = 'stopped'; };
$<HTMLFormElement>('ask-form').onsubmit = e => { e.preventDefault(); unlock(); ask($<HTMLInputElement>('request').value, 'text'); };
$('now-toggle').onclick = () => { const open = !document.body.classList.toggle('now-closed'); button('now-toggle').setAttribute('aria-expanded', String(open)); };
const volume = $<HTMLInputElement>('volume');
volume.oninput = () => { unlock(); demoAudioMaster.set(Number(volume.value) / 100); };
button('mute').onclick = () => { unlock(); demoAudioMaster.set(demoAudioMaster.state.volume, !demoAudioMaster.state.muted); };
demoAudioMaster.subscribe(state => {
  volume.value = String(Math.round(state.volume * 100));
  button('mute').textContent = state.muted ? 'Unmute' : 'Mute'; button('mute').setAttribute('aria-pressed', String(state.muted));
});
document.addEventListener('pointerdown', unlock, { capture: true });
document.addEventListener('keydown', e => {
  if ((e.target as HTMLElement | null)?.closest?.('textarea, input')) return;
  if (e.key === 'Escape' && !button('stop').hidden) button('stop').click();
  else if (e.key === 'h' || e.key === 'H') document.body.classList.toggle('clean');
});

// Hold to talk: Muse Voice Transcribe on the server, then the same wire.request a chip sends.
const mic = button('mic');
const micDown = async (e: Event) => {
  e.preventDefault(); unlock();
  const ws = connection.controllerSocket;
  if (!ws || (!selected && !demo)) { toast('Select a device first.'); return; }
  if (!ptt) {
    ptt = new PushToTalk(new Mic(), ws, () => connection.token);
    ptt.on('text', (t) => { if (t.final && t.text.trim()) { $<HTMLInputElement>('request').value = t.text; ask(t.text, 'voice'); } });
    ptt.on('error', (m) => toast(`Voice: ${m}`, 5000));
    ptt.on('listening', ({ listening }) => { mic.classList.toggle('listening', listening); mic.textContent = listening ? '● Listening' : '🎙︎ Hold'; });
  }
  await ptt.press({ cardId: selected, local: true });
};
mic.addEventListener('pointerdown', e => void micDown(e));
for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) mic.addEventListener(type, () => ptt?.release());

// The AR view: a tap or click acts on the outline under it; fingers (phone) and the mouse also stand in for hands.
const host = $('overlay-host');
const toStage = (e: PointerEvent) => { const r = host.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }; };
let downAt: { x: number; y: number; t: number } | undefined;
host.addEventListener('pointerdown', e => {
  if (ar === 'off') return;
  host.setPointerCapture(e.pointerId); const p = toStage(e); downAt = { ...p, t: performance.now() };
  tracker.pointer(e.pointerId, e.pointerType, p.x, p.y, true);
});
host.addEventListener('pointermove', e => { if (ar === 'off') return; const p = toStage(e); tracker.pointer(e.pointerId, e.pointerType, p.x, p.y, e.buttons > 0 || e.pointerType !== 'mouse'); });
host.addEventListener('pointerup', e => {
  const p = toStage(e);
  tracker.pointer(e.pointerId, e.pointerType, p.x, p.y, false, e.pointerType !== 'mouse');
  // a short tap without much travel acts on the outline
  if (downAt && performance.now() - downAt.t < 450 && Math.hypot(p.x - downAt.x, p.y - downAt.y) < 0.03) {
    const item = overlay.hit(p.x, p.y, layer === 'annotate' ? ['detection', 'tag'] : ['tag']);
    if (item) { act(item); if (ar === 'xr') phoneAR.anchorTag(item.key, p.x, p.y); }
  }
  downAt = undefined;
});
host.addEventListener('pointercancel', e => { tracker.pointer(e.pointerId, e.pointerType, 0, 0, false, true); downAt = undefined; });

const resize = () => { visuals.resize(); overlay.resize(); tracker.view.sw = stage.clientWidth; tracker.view.sh = stage.clientHeight; };
addEventListener('resize', resize); resize();
new ResizeObserver(resize).observe(stage);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    pendingAsk = undefined; connection.hidden(); visuals.paused = true; deselect();
    if (camera.active) { camera.stop(undefined, true); ar = 'off'; document.body.classList.add('start-open'); document.body.classList.remove('ar-on'); $('start-note').textContent = 'The camera paused while the page was hidden. Start AR to continue.'; }
  } else visuals.paused = false;
});
addEventListener('pagehide', () => { connection.dispose(); camera.stop(undefined, true); tracker.dispose(); });

function calibrate(): void {
  if (!camera.active || phone) { toast('Hand calibration is for the webcam.'); return; }
  unlock(); audio.play('tap');
  const box = { x0: 0.66, y0: 0.3, x1: 0.84, y1: 0.66 };
  const el = $('calib'); el.hidden = false;
  const inner = el.querySelector<HTMLElement>('.calib-box')!;
  Object.assign(inner.style, { left: `${box.x0 * 100}%`, top: `${box.y0 * 100}%`, width: `${(box.x1 - box.x0) * 100}%`, height: `${(box.y1 - box.y0) * 100}%` });
  let n = 3;
  const tick = () => { $('calib-text').textContent = n > 0 ? `Hold your open palm here · ${n}` : 'Hold still…'; if (n-- > 0) { audio.play('tap'); setTimeout(tick, 800); } else tracker.calibrate(box); };
  tick();
}

// --- frame loop --------------------------------------------------------------------------------------------------

/** Webcam: the lead hand aims; holding it over an outline for 0.9 s (or closing it there) acts like a pinch. */
function aimWithHand(now: number): void {
  const lead = input === 'hand' && camera.active ? tracker.cameraHands().find(h => h.side === 'right') ?? tracker.cameraHands()[0] : undefined;
  if (!lead || connection.programRunning) { overlay.aim = undefined; dwell = undefined; lastFist = false; return; }
  const item = overlay.hit(lead.x, lead.y, layer === 'annotate' ? ['detection'] : ['tag']);
  const color = lead.side === 'left' ? '#40d8ff' : '#ff5ad8';
  if (!item || (layer === 'control' && item.key === selected)) { overlay.aim = { x: lead.x, y: lead.y, progress: 0, color }; dwell = undefined; lastFist = lead.fist; return; }
  if (!dwell || dwell.key !== item.key) dwell = { key: item.key, since: now, fired: false };
  const progress = (now - dwell.since) / 900;
  overlay.aim = { x: lead.x, y: lead.y, progress: dwell.fired ? 0 : progress, color };
  if (!dwell.fired && (progress >= 1 || (lead.fist && !lastFist))) { dwell.fired = true; act(item); }
  lastFist = lead.fist;
}

/** The device card and Muse's controls sit beside the selected device's outline (webcam: its SAM box). */
function placeCards(): void {
  const card = $('card'), controls = $('controls-card');
  const item = selected ? overlay.items.find(i => i.key === selected) : undefined;
  const W = innerWidth, H = innerHeight;
  if (phone) { card.style.left = card.style.top = ''; }
  else if (!card.hidden) {
    const w = card.offsetWidth, h = card.offsetHeight;
    let x = W - w - 16, y = 84;
    if (item) {
      const right = item.box.x1 * W + 18, left = item.box.x0 * W - w - 18;
      x = right + w < W - 8 ? right : left > 8 ? left : W - w - 16;
      y = Math.max(84, Math.min(H - h - 16, item.box.y0 * H - 20));
    }
    card.style.left = `${Math.round(x)}px`; card.style.top = `${Math.round(y)}px`;
  }
  if (!controls.hidden) {
    const w = controls.offsetWidth, h = controls.offsetHeight;
    const anchor = item ?? (ar === 'xr' && selected ? phoneAR.projected(selected) : undefined);
    let x = 16, y = H - h - (phone ? innerHeight * 0.45 : 90);
    if (anchor) {
      x = Math.max(8, Math.min(W - w - 8, ((anchor.box.x0 + anchor.box.x1) / 2) * W - w / 2));
      y = Math.max(84, Math.min(H - h - 8, anchor.box.y1 * H + 14));
    }
    controls.style.left = `${Math.round(x)}px`; controls.style.top = `${Math.round(y)}px`;
  }
}

function hud(now: number, hands: TrackedHand[]): void {
  if (now - lastHud < 125) return;
  lastHud = now;
  const mine = new Set([connection.selected]);
  const macs = devices.filter(d => d.online && d.role === 'companion' && !d.app?.startsWith('hands-software@') && !d.app?.startsWith('reviewer-software@'));
  const ports = macs.flatMap(d => (d.ports ?? []).filter(p => p.kind === 'midi-out' && p.state === 'connected' && !/^ce-/.test(p.id)).map(p => p.name));
  const deviceText = [...(macs.length ? ['Mac'] : []), ...ports.slice(0, 2), ...(demo ? ['this page'] : [])].join(' · ');
  void mine;
  const t = selected ? annotator.tags.get(selected) : undefined;
  const view = nowView({ server: connection.connected || ar === 'off', mode: layer, filter: filterLabel(), tagged: annotator.tags.size, detections: annotator.detections.length,
    selected: t ? t.name ?? t.label : undefined, devices: deviceText, phase, title: ready?.title, phaseLine: $('wire-status').textContent ?? '', source: wireSource, input,
    demo: demo === 'visual-synth' ? 'Visual synth' : demo === 'musical-synth' ? 'Musical synth' : undefined });
  const rows = $('now-rows'); rows.replaceChildren();
  for (const r of view.rows) {
    const row = document.createElement('div'); row.className = `now-row ${r.tone}`;
    row.innerHTML = '<i></i><span class="k"></span><span class="v"></span>';
    row.querySelector('.k')!.textContent = r.label; row.querySelector('.v')!.textContent = r.value;
    rows.append(row);
  }
  $('now-next').textContent = view.next;
  $('now-mode').textContent = layer === 'annotate' ? `Annotate · ${annotator.tags.size} tagged` : 'Control';
  // tutorial bubble (the Quest's steps)
  const bubble = tutorial.update({ inXr: ar !== 'off', busy: false, boxes: annotator.detections.length, selected: layer === 'annotate' ? annotator.tags.size > 0 : !!(selected || demo),
    controllable: layer === 'control' && !!(selected || demo) && connection.connected, mode: layer, cardId: selected ?? demo,
    wire: { phase: phase === 'working' ? 'writing' : phase, request: phase !== 'idle' ? phaseLine : undefined, needsScreen: false, touching: hands.length > 0, stats: { sent: connection.snapshot().programOutputs + connection.snapshot().outputs } },
    menuOpen, buddyOpen: false }, now);
  const b = $('bubble'); b.hidden = !bubble || document.body.classList.contains('clean');
  if (bubble) { $('bubble-title').textContent = bubble.title; $('bubble-detail').textContent = bubble.detail; b.dataset.step = bubble.id; }
  // hands
  for (const side of ['left', 'right'] as const) {
    const h = hands.find(x => x.side === side);
    const el = $(`hand-${side}`);
    el.classList.toggle('on', !!h); el.classList.toggle('closed', !!h?.fist);
    el.textContent = h ? `${side === 'left' ? 'L' : 'R'} ${h.fist ? '✊' : '✋'} ${h.source === 'touch' ? 'touch' : `${Math.round((1 - h.y) * 100)}↑ ${Math.round(h.x * 100)}→`}` : `${side === 'left' ? 'L' : 'R'} —`;
  }
  const s = tracker.stats, v = visuals.stats, a = annotator.stats;
  $('hud-stats').textContent = `${v.fps} fps · SAM ${a.results}/${a.sent}${a.modelId ? ` · ${a.source === 'fixture' ? 'FIXTURE' : a.modelId} ${Math.round(a.lastLatencyMs)} ms` : ''}${tracker.cameraOn ? ` · hands ${s.fps} fps` : ''}`;
  const live = [...outputs.entries()].filter(([, o]) => now - o.at < 1500).slice(0, 4).map(([id, o]) => `${id} ${typeof o.value === 'number' ? Math.round(o.value) : o.value ? 'on' : 'off'}`).join(' · ');
  $('hud-note').textContent = connection.programRunning ? `Muse's hand program is running in a sandboxed Worker${live ? ` · out: ${live}` : ''}` : '';
}

function frame(now: number): void {
  requestAnimationFrame(frame);
  if (document.hidden) return;
  tracker.view.sw = stage.clientWidth; tracker.view.sh = stage.clientHeight;
  visuals.cover = coverScale(tracker.view); visuals.mirror = camera.active ? camera.mirror : false;
  const hands = tracker.hands(now);
  annotator.active = layer === 'annotate' && ar !== 'off' && connection.connected;
  annotator.tick(now, frameSource);
  overlay.build(layer, annotator.detections, annotator.tags.values(), toDisplay, d => annotator.tagFor(d));
  if (ar === 'xr') phoneAR.updateOverlay(overlay, annotator.tags);
  aimWithHand(now);
  overlay.draw(layer, now);
  placeCards();
  // the instrument: once Muse wires the visual synth demo, it shows under the particles and colours them
  const vs = connection.visualState;
  const wiredVisual = !!ready && connection.instrument === 'visual-synth';
  synthMix += ((wiredVisual ? 0.75 : 0) - synthMix) * 0.05;
  if (synthMix > 0.01) connection.render(now);
  visuals.synthMix = synthMix;
  visuals.videoMix = ar === 'camera' ? (wiredVisual ? 0.5 : 1) : 0;
  visuals.passthrough = wiredVisual ? 0.3 : 1;
  if (vs && wiredVisual) visuals.look = { hue: vs.hue - 0.54, flow: 0.2 + vs.speed * 0.8, swirl: 0.3 + vs.warp, glow: 0.6 + vs.brightness * 0.5 };
  else if (connection.instrument === 'musical-synth' && ready) {
    const m = connection.musical.getState();
    visuals.look = { hue: 0.35 + (m.cutoff / 127) * 0.4, flow: 0.3 + (m.delay / 127) * 0.6, swirl: 0.5 + (m.resonance / 127) * 0.6, glow: m.gate > 0 ? 1.2 : 0.85 };
  } else visuals.look = { hue: 0, flow: 0.35, swirl: 0.6, glow: ready ? 1 : 0.45 };
  if (connection.programRunning) connection.tick(tracker.signals(false, now));
  sound.duck = connection.instrument === 'musical-synth' && ready ? 0.35 : 1;
  sound.update(hands);
  if (ar !== 'xr') visuals.render(hands);
  hud(now, hands);
}

// --- boot --------------------------------------------------------------------------------------------------------

renderFilters();
setLayer('annotate', false);
if (phone) document.body.classList.add('now-closed');
void (async () => {
  if (params.get('xremu') === '1') {
    const { XRDevice, metaQuest3 } = await import('iwer');
    new XRDevice(metaQuest3, { stereoEnabled: false }).installRuntime({ forceInstall: true });
  }
  const xr = await phoneAR.supported();
  $('start-note').textContent = !phone ? 'Laptop: your mirrored webcam is the passthrough. Hands are tracked with classic computer vision (no AI model).'
    : xr ? 'This phone supports WebXR AR: Start AR opens it with the camera passthrough.'
      : 'This browser has no WebXR AR (iPhone Safari does not offer it), so Start AR uses the camera view as the passthrough.';
})();
requestAnimationFrame(frame);
if (params.get('ar') === '1') void startAR();

declare global { interface Window { __ceHands?: unknown } }
window.__ceHands = {
  tracker, visuals, connection, camera, annotator, overlay, phoneAR,
  signals: () => tracker.signals(false),
  act: (x: number, y: number) => act(overlay.hit(x, y, layer === 'annotate' ? ['detection', 'tag'] : ['tag'])),
  state: () => ({
    ar, layer, phone, input, selected, demo, phase, camera: camera.active, cameraFacing: camera.facing, synthMix,
    tracking: { ...tracker.stats }, hands: tracker.hands().map(h => ({ side: h.side, x: h.x, y: h.y, closed: h.closed, fist: h.fist, speed: h.speed, source: h.source, area: h.area })),
    scan: { ...annotator.stats, detections: annotator.detections.map(d => ({ label: d.label, detId: d.detId, x: d.x, y: d.y, w: d.w, h: d.h })) },
    tags: [...annotator.tags.values()].map(t => ({ cardId: t.cardId, label: t.label, name: t.name, box: t.box })),
    items: overlay.items.map(i => ({ kind: i.kind, key: i.key, label: i.label, box: i.box })),
    aim: overlay.aim, xr: { active: phoneAR.active, frames: phoneAR.frames, cameraAccess: phoneAR.cameraAccess, anchors: phoneAR.anchorCount },
    visuals: { ...visuals.stats }, connection: connection.snapshot(), sound: { ...sound.stats }, audio: { ...audio.stats },
    wire: $('wire-status').textContent, bubble: $('bubble').hidden ? undefined : $('bubble-title').textContent, now: $('now-next').textContent,
    outputs: Object.fromEntries([...outputs.entries()].map(([k, v]) => [k, v.value])),
  }),
};
