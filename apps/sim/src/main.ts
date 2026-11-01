import '@fontsource/chakra-petch/latin-500.css';
import '@fontsource/chakra-petch/latin-600.css';
import '@fontsource/share-tech-mono/latin-400.css';
import './style.css';
import type { AnyMessage, PresencePayload } from '@ce/protocol';
import QRCode from 'qrcode';
import { describeLamp, loadLamp, type LogLine, promptedButton, SimDevice } from './device';
import { hex } from './ir/codec';
import { type CodeSet, fromLearned, type LampCmd, SIM_KZ } from './ir/table';
import { api, clearIdentity, Connection, type Identity, loadIdentity, saveIdentity, SIM_APP, SIM_CAPABILITIES, SIM_PORTS } from './net/net';
import { loadTakeFromFiles, loadTakeFromUrl, TakePlayer } from './replay/player';
import { DEFAULT_STATE, LampAnimator, type LampState } from './room/lamp';
import { RoomView, type ViewId } from './room/view';
import { PAGES, CC_BY_NUMBER } from './synth/ccmap';
import { SynthEngine } from './synth/engine';
import { FeatureMeter } from './synth/features';
import { SynthScreen } from './synth/screen';
import { SimSync, type SyncMsg } from './sync';

const params = new URLSearchParams(location.search);
const embedView = params.get('embed') as ViewId | null;
const EMBED = embedView === 'room' || embedView === 'desk';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// --- the device -----------------------------------------------------------------------------------

const synth = new SynthEngine();
// ?mute=1: no speaker output (the audio features the server verifies by are read from the analyser, so they are unchanged)
synth.muted = params.get('mute') === '1';
const meter = new FeatureMeter(
  () => synth.analyser,
  () => synth.running,
  (fn) => synth.onTick(fn),
);
const animator = new LampAnimator(DEFAULT_STATE);
let roomCanvas: HTMLCanvasElement;
let overlayCanvas: HTMLCanvasElement;
if (EMBED) {
  document.body.classList.add('embed');
  roomCanvas = document.createElement('canvas');
  roomCanvas.className = 'embed-canvas';
  document.body.appendChild(roomCanvas);
  overlayCanvas = document.createElement('canvas');
} else {
  roomCanvas = $<HTMLCanvasElement>('room');
  overlayCanvas = $<HTMLCanvasElement>('overlay');
}
const room = new RoomView(roomCanvas, overlayCanvas, animator);
const device = new SimDevice(synth, meter, room, animator);
// the embed has no remote anyone can reach, so it answers learn prompts itself unless ?autopress=0
device.autoPress = EMBED ? params.get('autopress') !== '0' : params.get('autopress') === '1';
device.startClockSignal(); // tempo -> device.signal clock_bpm for the "breathe to tempo" daemon
const saved = loadLamp();
if (saved) {
  device.state = saved;
  animator.setTarget(saved, { instant: true });
}
const sync = new SimSync(!EMBED);
let conn: Connection | undefined;
let player: TakePlayer | undefined;

declare global {
  interface Window {
    ceSim?: {
      version: 1;
      canvas: HTMLCanvasElement;
      view: ViewId;
      layout: { width: number; height: number; devices: { id: string; kind: string; label: string; box: [number, number, number, number] }[] };
      lamp: () => LampState;
      leader: () => boolean;
      /** press a button on the virtual remote (works from any sim page; the paired one transmits) */
      press: (cmd: LampCmd, channel?: 1 | 2) => void;
      /** the open learn window (the agent asked to "press 全灯 once"), if any */
      learn: () => { prompt?: string; until: number; count: number } | null;
      /** auto-press the button a learn prompt names (default on in ?embed, off on the full page) */
      setAutoPress: (on: boolean) => void;
    };
  }
}

// --- leader: pair, connect, execute ------------------------------------------------------------------

async function startLeader(): Promise<void> {
  setRole();
  const health = await api.health().catch(() => undefined);
  if (health) {
    const b = $('b-mode');
    if (b) {
      b.textContent = health.mode === 'live' ? 'SERVER LIVE' : 'SERVER FIXTURE';
      b.className = `pill ${health.mode === 'live' ? 'live' : ''}`;
    }
  }
  let id = loadIdentity();
  if (!id) id = await pair();
  if (!sync.leader) return;
  connect(id);
}

async function pair(): Promise<Identity> {
  for (;;) {
    try {
      const r = await api.pairStart('Sim room');
      if (r.status === 'approved' && r.deviceId && r.deviceToken) {
        const id = { deviceId: r.deviceId, deviceToken: r.deviceToken, name: 'Sim room' };
        saveIdentity(id);
        hidePair();
        device.log('net', `paired instantly as ${r.deviceId} (localhost)`);
        return id;
      }
      showPair(r.qr, r.display, r.expiresAt);
      for (;;) {
        await new Promise((res) => setTimeout(res, 2000));
        const s = await api.pairStatus(r.pairingId, r.pollSecret);
        if (s.status === 'approved' && s.deviceId && s.deviceToken) {
          const id = { deviceId: s.deviceId, deviceToken: s.deviceToken, name: 'Sim room' };
          saveIdentity(id);
          hidePair();
          device.log('net', `paired as ${s.deviceId}`);
          return id;
        }
        if (s.status === 'denied' || s.status === 'expired') {
          setText('pair-msg', `Pairing ${s.status}; starting again.`);
          break;
        }
      }
    } catch (e) {
      setText('pair-msg', `Server not reachable (${(e as Error).message}); retrying.`);
      if (!EMBED) $('pair').hidden = false;
      await new Promise((res) => setTimeout(res, 3000));
    }
  }
}

function showPair(qr: string, code: string, expiresAt: number): void {
  if (EMBED) return;
  $('pair').hidden = false;
  setText('pair-code', code);
  setText('pair-msg', `Code expires at ${new Date(expiresAt).toLocaleTimeString()}.`);
  void QRCode.toDataURL(qr, { margin: 0, width: 360, color: { dark: '#0a0e12', light: '#f6f3ea' } }).then((url) => {
    $('pair-qr').innerHTML = `<img alt="Pairing QR code" src="${url}" />`;
  });
}

function hidePair(): void {
  if (!EMBED) $('pair').hidden = true;
}

function connect(id: Identity): void {
  conn?.stop();
  const c = new Connection(Connection.sameOrigin(), () => ({ deviceToken: id.deviceToken, role: 'device', capabilities: SIM_CAPABILITIES, ports: SIM_PORTS, app: SIM_APP }));
  conn = c;
  device.conn = c;
  device.deviceId = id.deviceId;
  c.onState = (s, info) => {
    const b = $('b-conn');
    if (b) {
      b.textContent = s === 'open' ? 'PAIRED · ONLINE' : s === 'connecting' ? 'CONNECTING' : 'OFFLINE';
      b.className = `pill ${s === 'open' ? 'on' : s === 'closed' ? 'warn' : ''}`;
    }
    if (s === 'closed' && info?.code && info.code !== 1000 && info.code !== 1005) device.log('net', `socket closed (${info.code}${info.reason ? ` ${info.reason}` : ''})`);
  };
  c.onUnauthorized = () => {
    device.log('warn', 'the server no longer knows this sim (revoked or new space): pairing again');
    clearIdentity();
    void startLeader();
  };
  c.on('welcome', (m) => {
    device.deviceId = m.payload.deviceId;
    device.log('net', `online as "${m.payload.name}" (${m.payload.kind}, ${m.payload.deviceId}) · server ${m.payload.mode.toUpperCase()}`);
  });
  c.on('exec.command', async (m) => {
    if (device.deviceId && m.payload.executorDeviceId !== device.deviceId) return;
    const ack = await device.handleExec(m.payload);
    c.send('exec.ack', ack, { to: 'server' });
  });
  c.on('sense.request', async (m) => {
    if (device.deviceId && m.payload.sensorDeviceId !== device.deviceId) return;
    if (player?.playing && (await player.answer(m.payload))) return;
    await device.handleSense(m.payload).catch((e) => device.log('warn', `sense failed: ${(e as Error).message}`));
  });
  c.on('scan.result', (m) => device.onScanResult(m.payload));
  c.on('panic', (m) => {
    synth.panic();
    device.log('midi', `panic from the server${m.payload.reason ? `: ${m.payload.reason}` : ''}`);
  });
  c.on('presence', (m) => renderPresence(m.payload));
  c.onAny((m) => {
    agentLine(m);
    player?.observe(m);
  });
  c.start();
}

function stopLeader(): void {
  device.setScanning(false);
  conn?.stop();
  conn = undefined;
  device.conn = undefined;
  setRole();
}

function setRole(): void {
  const b = $('b-role');
  if (!b) return;
  b.hidden = sync.leader;
  b.textContent = 'MIRROR (another sim page is the device)';
}

// --- leader election and mirroring --------------------------------------------------------------------

function announceRole(): void {
  const detail = { leader: sync.leader, view: room.view };
  window.dispatchEvent(new CustomEvent('ce-sim-role', { detail }));
  if (window.parent !== window) window.parent.postMessage({ type: 'ce-sim-role', ...detail }, location.origin);
}

sync.onLeader = (leader) => {
  if (leader) void startLeader();
  else stopLeader();
  announceRole();
};
sync.onMessage = (m: SyncMsg) => {
  if (m.type === 'state' && !sync.leader) {
    device.mirror(m.state);
    const set = device.codeSets.find((c) => c.id === m.codeSetId);
    if (set) device.codeSet = set;
  } else if (m.type === 'press' && sync.leader) {
    device.remoteChannel = m.channel;
    device.remotePress(m.cmd);
  } else if (m.type === 'ask' && sync.leader) {
    sync.broadcastState(device.state, device.codeSet);
  }
};
device.onChange(() => {
  if (sync.leader) sync.broadcastState(device.state, device.codeSet);
});
setInterval(() => {
  if (sync.leader) sync.broadcastState(device.state, device.codeSet);
}, 2000);

// --- code sets (synthetic, plus learned real codes once the server has them) -----------------------------

async function loadLearnedCodes(): Promise<void> {
  for (const id of ['koizumi-krh-tg-9a.learned', 'koizumi-krh-tg-9a']) {
    const json = await api.profile(id).catch(() => undefined);
    const learned = (json as { learned?: unknown })?.learned ?? json;
    const set = learned ? fromLearned(learned, 'koizumi-learned') : undefined;
    if (set) {
      device.codeSets = [SIM_KZ, set];
      device.log('ir', `learned real codes available: ${set.name}, ${set.codes.length} codes`);
      renderCodeSets();
      return;
    }
  }
}

// --- UI ---------------------------------------------------------------------------------------------

function setText(id: string, text: string): void {
  const el = $(id);
  if (el) el.textContent = text;
}

function time(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour12: false });
}

function logLine(l: LogLine): void {
  const ol = $('log');
  if (!ol) return;
  const li = document.createElement('li');
  li.innerHTML = `<time>${time(l.t)}</time><span class="k k-${l.kind}">${l.kind.toUpperCase()}</span> `;
  li.append(document.createTextNode(l.text));
  ol.prepend(li);
  while (ol.children.length > 250) ol.lastChild?.remove();
}

const AGENT_TYPES = new Set(['agent.step', 'device.card', 'link.request', 'link.result', 'target.status', 'driver.spec', 'driver.status', 'verify.result', 'arm.request', 'arm.result', 'ui.spec', 'voice.text']);
const seenSteps = new Map<string, HTMLLIElement>();

function agentLine(m: AnyMessage): void {
  if (!AGENT_TYPES.has(m.type)) return;
  const ol = $('agent');
  if (!ol) return;
  const p = m.payload as Record<string, unknown>;
  let text = m.type;
  let cls = '';
  switch (m.type) {
    case 'agent.step':
      text = `${String(p.phase).toUpperCase()} · ${p.title}${p.model ? ` · ${p.model}` : ''}${p.source === 'fixture' ? ' · FIXTURE' : ''} · ${p.status}`;
      cls = p.status === 'ok' ? 'v-ok' : p.status === 'fail' ? 'v-fail' : '';
      break;
    case 'device.card':
      text = `identified: ${p.name} (${p.category}, ${Math.round(Number(p.confidence) * 100)} %)`;
      break;
    case 'verify.result': {
      const o = p.observed as { metric: string; before: number; after: number; delta: number };
      const e = p.expected as { effect: string };
      text = `verify ${p.actionId}: expected ${e.effect}, observed ${o.metric} ${o.before.toFixed(2)} → ${o.after.toFixed(2)} → ${p.pass ? 'SEEN ✓' : 'NO REACTION ✗'}`;
      cls = p.pass ? 'v-ok' : 'v-fail';
      break;
    }
    case 'link.request':
      text = `link needed: ${(p.needs as string[] | undefined)?.join(', ') ?? ''} ${p.reason ?? ''}`;
      break;
    case 'target.status':
      text = `target ${String(p.cardId).slice(-6)}: ${p.state}`;
      break;
    case 'driver.status':
      text = `driver ${String(p.driverId).slice(-6)}: ${p.phase ?? p.status ?? ''}`;
      break;
    case 'ui.spec':
      text = `controls generated (rev ${p.rev ?? 1})`;
      break;
    default:
      text = `${m.type}`;
  }
  const key = m.type === 'agent.step' ? String(p.stepId) : '';
  let li = key ? seenSteps.get(key) : undefined;
  if (!li) {
    li = document.createElement('li');
    ol.prepend(li);
    if (key) seenSteps.set(key, li);
  }
  li.className = cls;
  li.innerHTML = `<time>${time(m.ts)}</time>`;
  li.append(document.createTextNode(text));
  while (ol.children.length > 200) ol.lastChild?.remove();
}

let lastPresence = '';
function renderPresence(p: PresencePayload): void {
  const others = p.devices.filter((d) => d.deviceId !== device.deviceId && d.online);
  const text = others.map((d) => `${d.name} (${d.kind})`).join(', ');
  if (text === lastPresence) return;
  lastPresence = text;
  device.log('net', others.length ? `also online: ${text}` : 'no other device online');
}

function renderCodeSets(): void {
  const sel = $<HTMLSelectElement>('codeset');
  if (!sel) return;
  sel.innerHTML = '';
  for (const set of device.codeSets) {
    const o = document.createElement('option');
    o.value = set.id;
    o.textContent = set.name;
    o.selected = set.id === device.codeSet.id;
    sel.append(o);
  }
  setText('codeset-name', device.codeSet.synthetic ? 'SIM-KZ · synthetic codes' : device.codeSet.name);
  setText('codeset-note', device.codeSet.note);
}

function renderLamp(): void {
  setText('lamp-state', `LAMP ${describeLamp(device.state)}`);
  const ir = device.lastIr;
  if (ir) setText('ir-last', `IR receiver (${ir.source === 'remote' ? 'remote' : 'agent'} ${time(ir.at)}): ${ir.result.summary}`);
  document.querySelectorAll<HTMLButtonElement>('#lamp-ch button').forEach((b) => b.classList.toggle('on', Number(b.dataset.ch) === device.state.channel));
  document.querySelectorAll<HTMLButtonElement>('.remote-ch button').forEach((b) => b.classList.toggle('on', Number(b.dataset.ch) === device.remoteChannel));
  const scan = $('scan');
  if (scan) scan.setAttribute('aria-pressed', String(device.scanning));
  renderLearn();
}

function renderLearn(): void {
  const box = $('learn');
  if (!box) return;
  const w = device.learn;
  box.hidden = !w;
  const want = promptedButton(w?.prompt);
  document.querySelectorAll<HTMLButtonElement>('.rb').forEach((b) => b.classList.toggle('prompted', Boolean(w) && b.dataset.cmd === want));
  if (!w) return;
  setText('learn-prompt', w.prompt ?? 'Press a button on the remote');
  setText('learn-left', `${Math.max(0, Math.ceil((w.until - Date.now()) / 1000))} s left · ${w.count} captured`);
}

function pulseLed(): void {
  const led = $('remote-led');
  if (!led) return;
  led.classList.add('tx');
  setTimeout(() => led.classList.remove('tx'), 220);
}

function press(cmd: LampCmd): void {
  pulseLed();
  if (sync.leader) device.remotePress(cmd);
  else sync.post({ type: 'press', cmd, channel: device.remoteChannel });
}

// encoders (manual knobs for the page the synth shows) and keyboard
let encPage = 0;
function renderEncoders(): void {
  const box = $('encoders');
  if (!box) return;
  const page = PAGES[encPage]!;
  box.innerHTML = '';
  for (const cc of page.ccs) {
    const def = CC_BY_NUMBER.get(cc)!;
    const wrap = document.createElement('div');
    wrap.className = 'enc';
    const id = `enc-${cc}`;
    wrap.innerHTML = `<label for="${id}"><span>${def.sim}</span><span class="dim">CC${cc}</span></label><input id="${id}" type="range" min="0" max="127" value="${synth.cc.get(cc) ?? 0}" />`;
    const input = wrap.querySelector('input')!;
    input.style.accentColor = def.encoder ? { blue: '#2f6bff', ochre: '#e0a21a', grey: '#9aa0a6', orange: '#ff5a1f' }[def.encoder] : '';
    input.addEventListener('input', () => synth.controlChange(synth.channel, cc, Number(input.value)));
    box.append(wrap);
  }
}

function buildKeys(): void {
  const box = $('keys');
  if (!box) return;
  const first = 48; // C3
  const whites: number[] = [];
  for (let n = first; n < first + 24; n++) if (![1, 3, 6, 8, 10].includes(n % 12)) whites.push(n);
  const wW = 100 / whites.length;
  const make = (n: number, black: boolean, leftPct: number, widthPct: number) => {
    const k = document.createElement('div');
    k.className = `key ${black ? 'b' : 'w'}`;
    k.style.left = `${leftPct}%`;
    k.style.width = `${widthPct}%`;
    k.dataset.note = String(n);
    const down = (e: PointerEvent) => {
      e.preventDefault();
      void synth.start().then(() => meter.start());
      k.classList.add('down');
      synth.noteOn(synth.channel, n, 100);
    };
    const up = () => {
      if (!k.classList.contains('down')) return;
      k.classList.remove('down');
      synth.noteOff(synth.channel, n);
    };
    k.addEventListener('pointerdown', down);
    k.addEventListener('pointerup', up);
    k.addEventListener('pointerleave', up);
    box.append(k);
  };
  whites.forEach((n, i) => make(n, false, i * wW, wW));
  whites.forEach((n, i) => {
    if ([4, 11].includes(n % 12) || i === whites.length - 1) return;
    make(n + 1, true, (i + 1) * wW - wW * 0.3, wW * 0.6);
  });
}

function wireUi(): void {
  device.onLog(logLine);
  for (const l of device.logLines) logLine(l);
  device.onChange(renderLamp);
  setInterval(renderLearn, 250);

  document.querySelectorAll<HTMLButtonElement>('#views button').forEach((b) =>
    b.addEventListener('click', async () => {
      document.querySelectorAll('#views button').forEach((x) => x.classList.toggle('on', x === b));
      await room.setView(b.dataset.view as ViewId);
      device.log('scan', `camera looks at the ${b.dataset.view === 'room' ? 'ceiling light' : 'desk'}`);
    }),
  );
  $('scan').addEventListener('click', () => {
    if (!sync.leader) return;
    device.setScanning(!device.scanning);
    device.log('scan', device.scanning ? 'SCAN on: one frame per second to the server' : 'SCAN off');
  });
  $('shot').addEventListener('click', () => void device.sendScanFrame().then((ok) => !ok && device.log('warn', 'not connected')));
  document.querySelectorAll<HTMLButtonElement>('.rb').forEach((b) => b.addEventListener('click', () => press(b.dataset.cmd as LampCmd)));
  document.querySelectorAll<HTMLButtonElement>('.remote-ch button').forEach((b) =>
    b.addEventListener('click', () => {
      device.remoteChannel = Number(b.dataset.ch) as 1 | 2;
      renderLamp();
    }),
  );
  document.querySelectorAll<HTMLButtonElement>('#lamp-ch button').forEach((b) =>
    b.addEventListener('click', () => device.setLampState({ ...device.state, channel: Number(b.dataset.ch) as 1 | 2 }, `fixture set to CH${b.dataset.ch}`)),
  );
  $<HTMLSelectElement>('codeset').addEventListener('change', (e) => {
    const set = device.codeSets.find((c) => c.id === (e.target as HTMLSelectElement).value);
    if (set) device.codeSet = set as CodeSet;
    renderCodeSets();
    device.log('ir', `lamp now obeys ${device.codeSet.name}`);
  });
  $('wall').addEventListener('click', () => device.setLampState({ ...device.state, power: 'on', level: 10 }, 'wall switch power cycle'));
  $<HTMLInputElement>('autopress').checked = device.autoPress;
  $<HTMLInputElement>('autopress').addEventListener('change', (e) => (device.autoPress = (e.target as HTMLInputElement).checked));

  // synth
  const screen = new SynthScreen($<HTMLCanvasElement>('screen'), synth);
  screen.start();
  room.screenSource = screen.canvas;
  screen.onDraw = () => room.screenChanged();
  const audioBtn = $<HTMLButtonElement>('audio');
  const startAudio = async () => {
    const ok = await synth.start();
    if (ok) meter.start();
    audioBtn.textContent = ok ? (synth.muted ? 'AUDIO ON · MUTED' : 'AUDIO ON') : 'START AUDIO';
    audioBtn.disabled = ok;
  };
  audioBtn.addEventListener('click', () => void startAudio());
  // any first click on the page also unlocks audio (browser autoplay rules)
  window.addEventListener('pointerdown', () => void startAudio(), { once: true });
  const loopBtn = $('loop');
  loopBtn.addEventListener('click', async () => {
    await startAudio();
    synth.setLoop(!synth.looping);
    loopBtn.setAttribute('aria-pressed', String(synth.looping));
  });
  $('panic').addEventListener('click', () => synth.panic());
  const chSel = $<HTMLSelectElement>('midi-ch');
  for (let ch = 1; ch <= 16; ch++) chSel.append(new Option(`ch ${ch}`, String(ch), ch === 1, ch === 1));
  chSel.addEventListener('change', () => (synth.channel = Number(chSel.value)));
  synth.onCc((e) => {
    const idx = PAGES.findIndex((p) => p.ccs.includes(e.cc));
    if (idx >= 0 && e.applied && idx !== encPage) {
      encPage = idx;
      renderEncoders();
    }
    const input = document.getElementById(`enc-${e.cc}`) as HTMLInputElement | null;
    if (input && e.applied) input.value = String(e.value);
  });
  synth.onState(() => loopBtn.setAttribute('aria-pressed', String(synth.looping)));
  renderEncoders();
  buildKeys();
  const meterBar = $('meter').querySelector('i') as HTMLElement;
  const tick = () => {
    const f = meter.latest;
    const db = f && f.rms > 0 ? 20 * Math.log10(f.rms) : -90;
    meterBar.style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // logs
  $('log-clear').addEventListener('click', () => ($('log').innerHTML = ''));

  // replay
  const takeLog = (text: string, cls = '') => {
    const ol = $('take-log');
    const li = document.createElement('li');
    li.className = cls;
    li.innerHTML = `<time>${time(Date.now())}</time>`;
    li.append(document.createTextNode(text));
    ol.prepend(li);
  };
  const hooks = { send: (m: Record<string, unknown>) => conn?.sendRaw(m) ?? false, log: takeLog };
  const setTake = (p: TakePlayer) => {
    player?.stop();
    player = p;
    setText('take-info', p.summary());
    $<HTMLButtonElement>('take-play').disabled = false;
    $<HTMLButtonElement>('take-stop').disabled = false;
    takeLog(`loaded ${p.summary()}`);
  };
  $('take-load').addEventListener('click', async () => {
    const url = $<HTMLInputElement>('take-url').value.trim();
    if (!url) return;
    try {
      setTake(new TakePlayer(await loadTakeFromUrl(url), hooks));
    } catch (e) {
      takeLog(`load failed: ${(e as Error).message}`, 'v-fail');
    }
  });
  $<HTMLInputElement>('take-files').addEventListener('change', async (e) => {
    const files = (e.target as HTMLInputElement).files;
    if (!files?.length) return;
    try {
      setTake(new TakePlayer(await loadTakeFromFiles(files), hooks));
    } catch (err) {
      takeLog(`load failed: ${(err as Error).message}`, 'v-fail');
    }
  });
  $('take-play').addEventListener('click', () => {
    if (!conn?.open) takeLog('not connected to the server: the replay needs the live pipeline', 'v-fail');
    player?.play($<HTMLInputElement>('take-fast').checked ? 4 : 1);
  });
  $('take-stop').addEventListener('click', () => {
    player?.stop();
    takeLog('stopped');
  });
  const preset = params.get('take');
  if (preset) $<HTMLInputElement>('take-url').value = preset.includes('/') ? preset : `/quest/takes/${preset}/session.jsonl`;

  renderCodeSets();
  renderLamp();
}

// --- boot ----------------------------------------------------------------------------------------------

async function boot(): Promise<void> {
  if (!EMBED) wireUi();
  if (EMBED && embedView) room.view = embedView;
  try {
    await room.init((m) => device.log('scan', m));
    if (!EMBED) $('loading').hidden = true;
  } catch (e) {
    if (!EMBED) setText('loading', `Could not load the room: ${(e as Error).message}`);
    throw e;
  }
  room.start();
  const meta = room.meta!;
  window.ceSim = {
    version: 1,
    canvas: roomCanvas,
    view: room.view,
    layout: {
      width: meta.width,
      height: meta.height,
      devices: (meta.views[room.view]?.devices ?? []).map((d) => ({ id: d.id, kind: d.kind, label: d.label, box: d.box })),
    },
    lamp: () => device.state,
    leader: () => sync.leader,
    press: (cmd, channel) => {
      if (channel) device.remoteChannel = channel;
      press(cmd);
    },
    learn: () => (device.learn ? { prompt: device.learn.prompt, until: device.learn.until, count: device.learn.count } : null),
    setAutoPress: (on) => {
      device.autoPress = on;
      const box = document.getElementById('autopress') as HTMLInputElement | null;
      if (box) box.checked = on;
    },
  };
  // devtools handle (and scripted tests): the same objects the page uses
  (window as unknown as { ceSimDebug: unknown }).ceSimDebug = { device, synth, meter, room, sync };
  device.log('lamp', `virtual lamp ready: ${describeLamp(device.state)} · obeys ${device.codeSet.name} (e.g. off = ${hex(device.codeSet.codes.find((c) => c.cmd === 'off' && c.channel === 1)!.bytes)})`);
  // elect first, then announce, so leader() is already right when 'ce-sim-ready' fires
  await sync.start();
  window.dispatchEvent(new CustomEvent('ce-sim-ready', { detail: { leader: sync.leader, view: room.view } }));
  if (window.parent !== window) window.parent.postMessage({ type: 'ce-sim-ready', view: room.view, leader: sync.leader }, location.origin);
  void loadLearnedCodes();
}

void boot();
