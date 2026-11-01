/**
 * Companion web app (Mac, Chrome): pairs itself, approves other devices, bridges Web MIDI, shows the log.
 *
 * - On localhost the server treats this page as the owner: it pairs instantly and can approve others.
 * - Elsewhere it shows its own QR + code and waits until a trusted device approves it.
 * - Device names come from other clients: render them with textContent only.
 */
import './style.css';
import { type DeviceInfo, formatCode, isValidCode, type PayloadOf, type PendingPairing } from '@ce/protocol';
import { toString as qrSvg } from 'qrcode';
import { api, ApiError, type Health } from './api';
import { CLOSE_UNAUTHORIZED, Connection } from './connection';
import { clearIdentity, defaultDevice, type Identity, isLocalPage, loadIdentity, saveIdentity } from './identity';
import { MidiBridge } from './midi';
import { describeMidi, isRealtimeNoise, toHex } from './midiDecode';

const APP = 'companion@0.1.0';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: { className?: string; text?: string; title?: string } = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props.className) e.className = props.className;
  if (props.text !== undefined) e.textContent = props.text;
  if (props.title) e.title = props.title;
  for (const c of children) e.append(c);
  return e;
}

function button(label: string, onClick: () => void, secondary = false): HTMLButtonElement {
  const b = el('button', { text: label, className: secondary ? 'secondary' : '' });
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function clock(t = Date.now()): string {
  return new Date(t).toLocaleTimeString([], { hour12: false });
}

function untilText(expiresAt: number): string {
  const s = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
  return s ? `expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'expired';
}

async function renderQr(target: HTMLElement, text: string): Promise<void> {
  // qrcode returns SVG markup it generated itself from `text`; nothing untrusted is interpreted as HTML
  target.innerHTML = await qrSvg(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#111111', light: '#ffffff' } });
}

// --- log ----------------------------------------------------------------------------------

type Level = 'debug' | 'info' | 'warn' | 'error';
function appendLine(pre: HTMLElement, text: string, className = '', max = 300): void {
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
  pre.append(el('div', { text, className }));
  while (pre.childElementCount > max) pre.firstElementChild?.remove();
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}
function log(level: Level, text: string): void {
  appendLine($('log'), `${clock()} ${level.padEnd(5)} ${text}`, `lvl-${level}`);
}

// --- state --------------------------------------------------------------------------------

let health: Health | undefined;
let identity: Identity | undefined = loadIdentity();
let conn: Connection | undefined;
let canApprove = false;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let selfExpiresAt = 0;
let controlCount = 0;
const pending = new Map<string, PendingPairing>();
const midi = new MidiBridge();

/** `/p/<id>#<code>` redirects here as /companion/?approve=<id>#<code> */
const intent = (() => {
  const pairingId = new URLSearchParams(location.search).get('approve');
  const code = location.hash.slice(1);
  return pairingId && isValidCode(code) ? { pairingId, code } : undefined;
})();

function setStatus(text: string, kind: 'ok' | 'warn' | 'bad' | '' = ''): void {
  const s = $('status');
  s.textContent = text;
  s.className = `badge ${kind}`;
}

// --- pairing this browser -----------------------------------------------------------------

async function pairThisBrowser(): Promise<void> {
  clearTimeout(pollTimer);
  conn?.stop();
  conn = undefined;
  canApprove = false;
  renderApprovals();
  const card = $('pair-self');
  card.hidden = false;
  $('self-retry').hidden = true;
  $('self-msg').textContent = '';
  setStatus('pairing', 'warn');
  const me = defaultDevice();
  try {
    const r = await api.pairStart({ name: me.name, kind: me.kind, capabilities: MidiBridge.supported ? ['midi'] : [] });
    if (r.status === 'approved' && r.deviceId && r.deviceToken) {
      log('info', `paired instantly as the owner (${isLocalPage() ? 'localhost' : 'trusted'})`);
      adopt({ deviceId: r.deviceId, deviceToken: r.deviceToken, kind: me.kind, name: me.name });
      return;
    }
    $('self-code').textContent = r.display;
    selfExpiresAt = r.expiresAt;
    $('self-expiry').textContent = untilText(r.expiresAt);
    await renderQr($('self-qr'), r.qr);
    log('info', `waiting for approval · code ${r.display}`);
    const poll = async () => {
      try {
        const s = await api.pairStatus(r.pairingId, r.pollSecret);
        if (s.status === 'approved' && s.deviceId && s.deviceToken) {
          log('info', 'approved');
          adopt({ deviceId: s.deviceId, deviceToken: s.deviceToken, kind: me.kind, name: me.name });
          return;
        }
        if (s.status !== 'pending') {
          pairingFailed(s.status === 'expired' ? 'The code expired.' : 'The request was denied.');
          return;
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          pairingFailed('The server forgot this request (restarted?).');
          return;
        }
      }
      pollTimer = setTimeout(poll, 1500);
    };
    pollTimer = setTimeout(poll, 1500);
  } catch (e) {
    pairingFailed(`Could not start pairing: ${(e as Error).message}`);
  }
}

function pairingFailed(message: string): void {
  selfExpiresAt = 0;
  $('self-msg').textContent = message;
  $('self-msg').className = 'small bad-text';
  $('self-retry').hidden = false;
  setStatus('not paired', 'bad');
  log('warn', message);
}

function adopt(id: Identity): void {
  identity = id;
  saveIdentity(id);
  $('pair-self').hidden = true;
  selfExpiresAt = 0;
  connect();
}

// --- connection ---------------------------------------------------------------------------

function hello(): PayloadOf<'hello'> {
  const p: PayloadOf<'hello'> = { deviceToken: identity!.deviceToken, app: APP };
  // another app on this origin (e.g. the Quest app) may own the identity; then do not overwrite its role/capabilities
  if (identity!.kind === 'mac' || identity!.kind === 'web') {
    p.role = 'companion';
    p.capabilities = MidiBridge.supported ? ['midi'] : [];
    if (midi.access) p.ports = midi.ports();
  }
  return p;
}

const QUIET = new Set(['presence', 'control.event', 'snapshot', 'log', 'welcome', 'pair.pending', 'pair.approved', 'pair.denied']);

function connect(): void {
  conn?.stop();
  const c = new Connection(Connection.sameOrigin(), hello);
  conn = c;
  c.onState = (s, info) => {
    if (s === 'connecting') setStatus('connecting', 'warn');
    if (s === 'open') setStatus('connected', 'ok');
    if (s === 'closed') {
      setStatus('offline', 'bad');
      if (info?.code === CLOSE_UNAUTHORIZED) {
        log('warn', 'This browser is no longer paired (revoked or unknown token); pairing again.');
        clearIdentity();
        identity = undefined;
        void pairThisBrowser();
      }
    }
  };
  c.onInvalid = (error) => log('warn', `ignored a message from the server: ${error}`);
  c.on('welcome', (m) => {
    canApprove = m.payload.canApprove;
    pending.clear();
    log('info', `connected as ${m.payload.name} (${m.payload.kind}, ${m.payload.deviceId}) · server ${m.payload.server} · ${m.payload.mode}`);
    renderApprovals();
    renderIntent();
  });
  c.on('presence', (m) => renderDevices(m.payload.devices));
  c.on('pair.pending', (m) => {
    pending.set(m.payload.pairingId, m.payload);
    log('info', `${m.payload.name} (${m.payload.kind}) wants to join · ${m.payload.display}`);
    renderApprovals();
    renderIntent();
  });
  c.on('pair.approved', (m) => {
    pending.delete(m.payload.pairingId);
    log('info', `paired ${m.payload.name} (${m.payload.kind})${m.payload.approvedBy ? ` · approved by ${m.payload.approvedBy}` : ''}`);
    renderApprovals();
  });
  c.on('pair.denied', (m) => {
    pending.delete(m.payload.pairingId);
    log('info', `pairing request ${m.payload.reason}`);
    renderApprovals();
  });
  c.on('log', (m) => log(m.payload.level, `${m.payload.code ? `[${m.payload.code}] ` : ''}${m.payload.message}`));
  c.on('control.event', (m) => {
    controlCount++;
    $('control-last').textContent = `control.event #${controlCount}: ${m.payload.widgetId} = ${JSON.stringify(m.payload.value)} (from ${m.from})`;
    // device-control: route to the deployed driver / MIDI binding here
  });
  c.onAny((m) => {
    if (!QUIET.has(m.type)) log('debug', `← ${m.type} from ${m.from}`);
  });
  c.start();
}

// --- rendering ----------------------------------------------------------------------------

function renderDevices(list: DeviceInfo[]): void {
  const ul = $('devices');
  ul.replaceChildren();
  if (!list.length) ul.append(el('li', { className: 'muted', text: 'No devices paired yet.' }));
  for (const d of list) {
    const me = d.deviceId === identity?.deviceId;
    const caps = d.capabilities.length ? d.capabilities.join(', ') : 'no capabilities';
    const ports = d.ports?.length ? ` · ${d.ports.length} port${d.ports.length > 1 ? 's' : ''}` : '';
    const li = el(
      'li',
      {},
      el('span', { className: `dot ${d.online ? 'on' : ''}`, title: d.online ? 'online' : 'offline' }),
      el('span', { className: 'grow' }, el('strong', { text: `${d.name}${me ? ' (this browser)' : ''}` }), el('span', { className: 'muted small', text: `  ${d.kind} · ${d.role} · ${caps}${ports}` })),
    );
    if (canApprove && !me) {
      li.append(
        button('Revoke', async () => {
          if (!confirm(`Revoke ${d.name}? It will have to pair again.`)) return;
          try {
            await api.revoke(d.deviceId, identity?.deviceToken);
            log('info', `revoked ${d.name}`);
          } catch (e) {
            log('error', `revoke failed: ${(e as Error).message}`);
          }
        }, true),
      );
    }
    ul.append(li);
  }
}

function renderApprovals(): void {
  $('approvals').hidden = !canApprove;
  $('open-elsewhere').hidden = !canApprove || !health?.urls.https;
  if (!canApprove) return;
  const ul = $('pending');
  ul.replaceChildren();
  if (!pending.size) ul.append(el('li', { className: 'muted', text: 'Nobody is waiting. New devices show a QR code and a code like K7Q-4M2.' }));
  for (const p of pending.values()) {
    const expiry = el('span', { className: 'muted small', text: untilText(p.expiresAt) });
    expiry.dataset.expires = String(p.expiresAt);
    ul.append(
      el(
        'li',
        {},
        el('span', { className: 'grow' }, el('strong', { text: p.name }), el('span', { className: 'muted small', text: `  ${p.kind}${p.origin ? ` · ${p.origin}` : ''}  ` }), expiry),
        el('span', { className: 'mono', text: p.display }),
        button('Approve', () => void approve(p.code, p.pairingId)),
        button('Deny', () => void deny(p.pairingId), true),
      ),
    );
  }
}

function renderIntent(): void {
  const box = $('intent');
  if (!intent || !identity) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const p = pending.get(intent.pairingId);
  const who = p ? `${p.name} (${p.kind})` : 'the device you scanned';
  $('intent-text').textContent = canApprove
    ? `Approve ${who} with code ${formatCode(intent.code)}?`
    : `This browser (${identity.kind}) cannot approve devices. Open the code on a paired Quest, iPhone or Mac.`;
  ($('intent-approve') as HTMLButtonElement).disabled = !canApprove;
  ($('intent-deny') as HTMLButtonElement).disabled = !canApprove;
}

function clearIntent(): void {
  history.replaceState(null, '', location.pathname);
  $('intent').hidden = true;
}

async function approve(code: string, pairingId?: string): Promise<boolean> {
  const msg = $('code-msg');
  try {
    await api.approve(code, identity?.deviceToken, pairingId);
    msg.textContent = `Approved ${formatCode(code)}.`;
    msg.className = 'small ok-text';
    return true;
  } catch (e) {
    msg.textContent = e instanceof ApiError ? e.message : `Approve failed: ${(e as Error).message}`;
    msg.className = 'small bad-text';
    return false;
  }
}

async function deny(pairingId: string): Promise<void> {
  try {
    await api.deny(pairingId, identity?.deviceToken);
  } catch (e) {
    log('error', `deny failed: ${(e as Error).message}`);
  }
}

async function renderOpenElsewhere(): Promise<void> {
  const https = health?.urls.https;
  if (!https) return;
  $('lan-quest').textContent = `${https}/quest/`;
  $('lan-companion').textContent = `${https}/companion/`;
  await renderQr($('lan-qr'), `${https}/quest/`);
}

// --- MIDI ---------------------------------------------------------------------------------

function renderMidi(): void {
  const portLi = (p: MIDIPort) =>
    el('li', {}, el('span', { className: `dot ${p.state === 'connected' ? 'on' : ''}` }), el('span', { className: 'grow', text: p.name ?? p.id }), el('span', { className: 'muted small', text: p.manufacturer ?? '' }));
  const outs = midi.outputs();
  const ins = midi.inputs();
  $('midi-outs').replaceChildren(...(outs.length ? outs.map(portLi) : [el('li', { className: 'muted', text: 'No outputs. Plug in a synth over USB.' })]));
  $('midi-ins').replaceChildren(...(ins.length ? ins.map(portLi) : [el('li', { className: 'muted', text: 'No inputs.' })]));
  const select = $('midi-out') as HTMLSelectElement;
  const keep = select.value;
  select.replaceChildren(...outs.map((o) => Object.assign(el('option', { text: o.name ?? o.id }), { value: o.id })));
  if (outs.some((o) => o.id === keep)) select.value = keep;
  ($('midi-test') as HTMLButtonElement).disabled = !outs.length;
  $('midi-msg').textContent = midi.access ? `Web MIDI on${midi.sysex ? ' (sysex)' : ''} · ${outs.length} out, ${ins.length} in` : '';
}

async function enableMidi(): Promise<void> {
  try {
    await midi.enable();
    ($('midi-enable') as HTMLButtonElement).hidden = true;
    log('info', `Web MIDI enabled${midi.sysex ? ' with sysex' : ''}`);
    conn?.resendHello();
  } catch (e) {
    $('midi-msg').textContent = (e as Error).message;
    log('warn', (e as Error).message);
  }
}

function setupMidi(): void {
  const ch = $('midi-ch') as HTMLSelectElement;
  for (let i = 1; i <= 16; i++) ch.append(Object.assign(el('option', { text: String(i) }), { value: String(i) }));
  midi.onChange = () => {
    renderMidi();
    conn?.resendHello();
  };
  midi.onMessage = (m) => {
    if (isRealtimeNoise(m.data) && !($('midi-clock') as HTMLInputElement).checked) return;
    appendLine($('midi-monitor'), `${clock()} ${m.portName.padEnd(18).slice(0, 18)} ${toHex(m.data).padEnd(9)} ${describeMidi(m.data)}`, '', 500);
  };
  $('midi-enable').addEventListener('click', () => void enableMidi());
  $('midi-test').addEventListener('click', () => {
    const out = ($('midi-out') as HTMLSelectElement).value;
    try {
      midi.testNote(out, Number(ch.value));
      log('info', `test note C4 → ${midi.outputs().find((o) => o.id === out)?.name ?? out} ch${ch.value}`);
    } catch (e) {
      log('error', (e as Error).message);
    }
  });
  $('midi-clear').addEventListener('click', () => $('midi-monitor').replaceChildren());
  if (!MidiBridge.supported) {
    $('midi-msg').textContent = 'Web MIDI is not available here. Use Chrome or Edge on localhost or https.';
    ($('midi-enable') as HTMLButtonElement).disabled = true;
    return;
  }
  void MidiBridge.alreadyGranted().then((granted) => {
    if (granted) void enableMidi();
  });
}

// --- boot ---------------------------------------------------------------------------------

function setupForms(): void {
  $('self-retry').addEventListener('click', () => void pairThisBrowser());
  $('log-clear').addEventListener('click', () => $('log').replaceChildren());
  $('code-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const input = $('code-input') as HTMLInputElement;
    if (!isValidCode(input.value)) {
      $('code-msg').textContent = 'Codes are 6 characters, like K7Q-4M2.';
      $('code-msg').className = 'small bad-text';
      return;
    }
    if (await approve(input.value)) input.value = '';
  });
  $('intent-approve').addEventListener('click', async () => {
    if (intent && (await approve(intent.code, intent.pairingId))) clearIntent();
  });
  $('intent-deny').addEventListener('click', async () => {
    if (intent) await deny(intent.pairingId);
    clearIntent();
  });
  setInterval(() => {
    if (selfExpiresAt) $('self-expiry').textContent = untilText(selfExpiresAt);
    for (const e of document.querySelectorAll<HTMLElement>('[data-expires]')) e.textContent = untilText(Number(e.dataset.expires));
  }, 1000);
}

async function boot(): Promise<void> {
  setupForms();
  setupMidi();
  try {
    health = await api.health();
    const mode = $('mode');
    mode.textContent = health.mode === 'live' ? `LIVE · ${health.models.chat}` : 'FIXTURE';
    mode.className = `badge ${health.mode === 'live' ? 'ok' : 'warn'}`;
    void renderOpenElsewhere();
  } catch {
    $('mode').textContent = 'server unreachable';
    setStatus('offline', 'bad');
    log('error', 'Cannot reach /api/health. Is the server running?');
  }
  if (identity) connect();
  else await pairThisBrowser();
}

void boot();
