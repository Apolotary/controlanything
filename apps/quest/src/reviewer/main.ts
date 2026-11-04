import './style.css';
import { demoAudioMaster, type WireReadyPayload } from '@ce/protocol';
import { QuestDemoAudio } from '../audio/demo-audio';
import { buddyApi, type ShowVia } from '../buddy/api';
import { drawVirtualObject, VIRTUAL_OBJECTS } from '../buddy/objects';
import { api } from '../io/api';
import { ReviewerCamera } from './camera';
import { ReviewerConnection, renderControls, type Instrument } from './connection';
import { ReviewerScene } from './scene';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const button = (id: string) => $<HTMLButtonElement>(id);
const params = new URLSearchParams(location.search), audio = new QuestDemoAudio(params);
let pending: { jpeg: string; via: ShowVia } | undefined;
let abort: AbortController | undefined, modelGeneration = 0, virtualIndex = 0, started = false;
let selected: Instrument = 'visual-synth', ready: WireReadyPayload | undefined;
const seen: string[] = [];
const bubble = (text: string, speak = false) => { $('bubble').textContent = text; if (speak) audio.speak(text); };
const unlock = () => { demoAudioMaster.unlock(); audio.unlock(); };
const status = (text: string, error = false) => { $('connection-status').textContent = text; $('connection-status').classList.toggle('error', error); };
const connection = new ReviewerConnection($<HTMLCanvasElement>('visual'), {
  pairing: text => { $('pairing').hidden = !text; $('pairing').textContent = text; if (text) $('pairing').scrollIntoView({ block: 'nearest' }); },
  status,
  wire: text => { $('wire-status').textContent = text; audio.setThinking('wire', /writing|testing|starting/.test(text)); },
  code: text => { $('code').textContent = text; },
  selected: on => { button('ask').disabled = !on; button('connect').textContent = connection.connected ? 'Reconnect / enable sound' : 'Connect demo'; },
  ready: payload => {
    ready = payload; renderControls($('controls'), payload, (action, value) => { unlock(); connection.control(action, value); });
    button('stop').hidden = !payload; if (payload) { audio.setThinking('wire', false); audio.play('ready'); }
  },
  receipt: text => { $('receipt').textContent = text; },
});
const scene = new ReviewerScene($('three'), (active, message) => {
  document.body.classList.toggle('native-ar', active); document.documentElement.classList.toggle('native-ar-page', active);
  button('xr').textContent = active ? 'Exit AR' : 'Place Buddy in AR'; $('mode').textContent = active ? 'Native WebXR AR · touch controls' : 'Camera + touch demo';
  if (active) { retake(); camera.stop('Native AR is active. Use Virtual object here; exit AR to capture a camera photo.'); $('photo').hidden = true; }
  if (message) $('camera-status').textContent = message;
});
const camera = new ReviewerCamera($<HTMLVideoElement>('camera'), $<HTMLCanvasElement>('photo'), (on, text) => {
  button('camera-start').hidden = on; button('camera-stop').hidden = !on; button('camera-flip').hidden = !on;
  button('capture').disabled = !on || !!abort; $('camera-status').textContent = text; scene?.cameraOn(on || !!pending);
});
const setPending = (jpeg: string, via: ShowVia) => {
  pending = { jpeg, via }; button('show').disabled = false; button('retake').hidden = false; $('scene-tag').textContent = via === 'virtual' ? 'Virtual object · preview' : 'Captured photo · preview';
  $('camera-status').textContent = 'Review this exact image. Show sends only this still to Muse; Retake discards it locally.';
  scene.cameraOn(true); scene.pose('curious', 'tilt'); bubble('Is that the one? Show me, or Retake.');
};
const retake = () => {
  abort?.abort(); abort = undefined; modelGeneration++; pending = undefined; camera.retake(); $('photo').hidden = true;
  button('show').disabled = true; button('retake').hidden = true; button('capture').disabled = !camera.active; button('virtual').disabled = false;
  scene.cameraOn(camera.active); $('scene-tag').textContent = 'Buddy · interactive 3D'; $('source').textContent = '';
  $('camera-status').textContent = camera.active ? 'Aim, then Capture. No image is sent until you choose Show.' : 'Use your camera or choose a virtual object.'; audio.setThinking('buddy', false);
};
button('camera-start').onclick = () => { unlock(); retake(); void camera.start(); };
button('camera-flip').onclick = () => { unlock(); retake(); void camera.flip(); };
button('camera-stop').onclick = () => { retake(); camera.stop(); };
button('capture').onclick = () => { unlock(); const jpeg = camera.capture(); if (jpeg) { audio.play('tap'); setPending(jpeg, 'photo'); } };
button('retake').onclick = retake;
button('virtual').onclick = () => {
  unlock(); const kind = VIRTUAL_OBJECTS[virtualIndex++ % VIRTUAL_OBJECTS.length]!;
  const jpeg = camera.setVirtual(drawVirtualObject(kind)); setPending(jpeg, 'virtual');
};
button('show').onclick = async () => {
  if (!pending || abort) return;
  unlock(); const captured = pending, generation = ++modelGeneration; const ctl = abort = new AbortController();
  button('show').disabled = true; button('capture').disabled = true; button('virtual').disabled = true;
  bubble('Let me take a look…'); scene.pose('thinking', 'tilt'); audio.setThinking('buddy', true);
  $('source').textContent = 'Connecting to Muse Spark…';
  try {
    if (!connection.token) await connection.pairBuddy();
    if (ctl.signal.aborted || generation !== modelGeneration) return;
    const result = await buddyApi.react(captured.jpeg, undefined, seen, captured.via, connection.token, ctl.signal);
    if (ctl.signal.aborted || generation !== modelGeneration) return;
    const r = result.reaction; seen.push(r.object); seen.splice(0, Math.max(0, seen.length - 8));
    bubble(r.quip, true); scene.pose(r.emotion, r.action); if (r.emotion === 'love' || r.emotion === 'delighted') scene.celebrate(); audio.play('curious');
    $('source').textContent = result.source === 'fixture' ? `FIXTURE · ${result.recordedFrom ? 'recorded ' + result.recordedFrom : 'no live model call'}` : `${result.model} · ${(result.latencyMs / 1000).toFixed(1)} s`;
    $('camera-status').textContent = `${captured.via === 'virtual' ? 'Virtual object' : 'Photo'} shown: ${r.object}. Retake for another object, or choose Virtual.`;
  } catch (e) {
    if (!ctl.signal.aborted && generation === modelGeneration) { bubble('I could not look at that yet. Your preview is still here.'); $('source').textContent = (e as Error).message; scene.pose('confused', 'tilt'); }
  } finally {
    if (abort === ctl) { abort = undefined; audio.setThinking('buddy', false); button('show').disabled = !pending; button('capture').disabled = !camera.active; button('virtual').disabled = false; }
  }
};
const social = (kind: 'wave' | 'pet' | 'high-five') => {
  unlock(); audio.play(kind === 'wave' ? 'curious' : 'giggle');
  if (kind === 'wave') { scene.pose('delighted', 'wave'); bubble('Hello! I’m listening. Show me something you love.', true); }
  else if (kind === 'pet') { scene.pose('love', 'wiggle'); bubble('That’s the spot!', true); }
  else { scene.pose('delighted', 'clap'); scene.celebrate(); bubble('High five!', true); }
};
button('wave').onclick = () => social('wave'); button('pet').onclick = () => social('pet'); button('high-five').onclick = () => social('high-five');
$('scene').addEventListener('pointerup', event => { if (scene.tap(event.clientX, event.clientY)) social('pet'); });
const choose = async (instrument: Instrument) => {
  unlock(); selected = instrument; ready = undefined;
  button('choose-visual').classList.toggle('selected', instrument === 'visual-synth'); button('choose-visual').setAttribute('aria-pressed', String(instrument === 'visual-synth'));
  button('choose-music').classList.toggle('selected', instrument === 'musical-synth'); button('choose-music').setAttribute('aria-pressed', String(instrument === 'musical-synth'));
  $<HTMLTextAreaElement>('request').value = instrument === 'musical-synth' ? 'Design touch keys and colorful filter knobs for this software synth. Touch and mouse controls only.' : 'Design an XY water surface and colorful knobs for ripples and hue. Touch and mouse controls only.';
  $('visual').hidden = instrument !== 'visual-synth' || !started; $('meter').hidden = instrument !== 'musical-synth' || !started;
  await connection.choose(instrument);
};
button('choose-visual').onclick = () => { void choose('visual-synth'); }; button('choose-music').onclick = () => { void choose('musical-synth'); };
button('connect').onclick = async () => {
  unlock(); button('connect').disabled = true;
  try { await connection.connect(selected); started = connection.connected; $('visual').hidden = selected !== 'visual-synth' || !started; $('meter').hidden = selected !== 'musical-synth' || !started; }
  finally { button('connect').disabled = false; }
};
$('ask-form').onsubmit = event => { event.preventDefault(); unlock(); connection.ask($<HTMLTextAreaElement>('request').value); button('stop').hidden = false; };
button('stop').onclick = () => { connection.stop(); audio.setThinking('wire', false); audio.play('stop'); $('wire-status').textContent = 'Stopped. Ask Muse again to build something new.'; };
button('mute').onclick = () => { unlock(); const state = demoAudioMaster.state; demoAudioMaster.set(state.volume, !state.muted); };
$<HTMLInputElement>('volume').oninput = event => { unlock(); demoAudioMaster.set(Number((event.target as HTMLInputElement).value) / 100); };
demoAudioMaster.subscribe(state => { button('mute').textContent = state.muted ? 'Unmute' : 'Mute'; button('mute').setAttribute('aria-pressed', String(state.muted)); $<HTMLInputElement>('volume').value = String(Math.round(state.volume * 100)); });
void api.health().then(health => { $('model-status').textContent = health.mode === 'fixture' ? 'FIXTURE mode · no live Meta model calls' : `Meta ${health.models.chat}`; }).catch(() => { $('model-status').textContent = 'Server unavailable · local Buddy interactions still work'; });
void scene.supported().then(supported => { button('xr').hidden = !supported; if (!supported) $('mode').textContent = 'Camera + touch · native AR unavailable'; });
button('xr').onclick = () => {
  unlock();
  if (!scene.snapshot().nativeAR) { retake(); camera.stop('Camera paused for AR. If AR is unavailable, choose Use camera to return.'); }
  void scene.enter();
};
const meter = $<HTMLCanvasElement>('meter'), meterContext = meter.getContext('2d')!;
let lastMeter = 0;
function animate(time: number): void {
  if (!document.hidden) {
    connection.render(time);
    if (selected === 'musical-synth' && started && time - lastMeter > 60) {
      lastMeter = time; const audioState = connection.musical.receipt().audio;
      meterContext.fillStyle = '#152027'; meterContext.fillRect(0, 0, meter.width, meter.height);
      meterContext.strokeStyle = '#a3e4d2'; meterContext.lineWidth = 2; meterContext.beginPath();
      const amplitude = Math.min(42, audioState.peak * 100), waves = Math.max(2, audioState.frequency / 45);
      for (let x = 0; x <= meter.width; x += 2) { const y = meter.height / 2 + Math.sin(x / meter.width * Math.PI * 2 * waves + time / 180) * amplitude; if (!x) meterContext.moveTo(x, y); else meterContext.lineTo(x, y); }
      meterContext.stroke(); meterContext.fillStyle = '#d3e9e5'; meterContext.font = '16px system-ui'; meterContext.fillText(audioState.activeNote !== undefined ? `${audioState.frequency.toFixed(0)} Hz · software analyser` : 'Ask Muse, then touch a key', 16, 27);
    }
  }
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);
document.addEventListener('visibilitychange', () => { if (document.hidden) { retake(); camera.stop('Camera and instrument paused because this page was hidden. Choose Use camera or Connect demo to resume.'); connection.hidden(); audio.suspend(); } else connection.announce(); });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
window.addEventListener('pagehide', () => { abort?.abort(); camera.stop(); connection.dispose(); audio.dispose(); scene.dispose(); });
// Read-only evidence/debug entry point: never exposes pairing tokens or direct hardware methods.
Object.assign(window, { __ceReviewer: { state: () => ({ camera: camera.active, pending: pending?.via, buddy: scene.snapshot(), connection: connection.snapshot(), controls: ready?.controls?.length ?? 0 }) } });
