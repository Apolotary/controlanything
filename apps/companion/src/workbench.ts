/**
 * The Mac companion: a calm status surface with diagnostics in Details.
 * - pairs this browser (owner on localhost), approves other devices, shows the "add a device" QR;
 * - executes the agent's work: MIDI (Web MIDI), the Cardputer (Web Serial, paired on its behalf),
 *   the audio oracle (synth USB audio or mic);
 * - shows agent steps with Meta model IDs and latency, the generated driver, physical checks,
 *   IR captures, connections and automations.
 * Everything from the wire is rendered with textContent.
 */
import {
  type AgentStepPayload,
  type ArmRequestPayload,
  type DeviceCardPayload,
  type DeviceInfo,
  type DriverSpecPayload,
  type DriverStatusPayload,
  formatCode,
  isValidCode,
  type LinkRequestPayload,
  type LinkResultPayload,
  type PayloadOf,
  type PendingPairing,
  type Port,
  type TargetStatusPayload,
  type UiSpecPayload,
  type VerifyResultPayload,
} from '@ce/protocol';
import { toString as qrSvg } from 'qrcode';
import { api, ApiError, type CallRecord, type CallsResponse, type Health } from './api';
import { AudioOracle } from './audio/oracle';
import { CLOSE_UNAUTHORIZED, Connection } from './connection';
import { Executor } from './executor';
import { clearIdentity, defaultDevice, type Identity, isLocalPage, loadIdentity, saveIdentity } from './identity';
import { MidiBridge } from './midi';
import { describeMidi, isRealtimeNoise, toHex } from './midiDecode';
import { VisualSynthExecutor, visualSynthPort } from './vsynthExecutor';
import { MidiExecutor } from './midiExec';
import { clearPendingPairing, loadPendingPairing, savePendingPairing } from './pairing';
import { CardputerBridge } from './serial/bridge';
import { CardputerLink } from './serial/cardputer';
import { $, ago, appendLine, button, clock, el, scheduler, secs, untilText } from './ui/dom';
import { jsonView } from './ui/json';
import { pulseTrain, sparkline } from './ui/spark';
import { agentPhaseName, companionText, evidenceSentence, linkProof, opSummary } from './ui/words';
import { PRODUCT_NAME } from './ui/product';
import { buildCheckSteps, type CheckProgress } from './ui/checks';
import { createStatusPresenter, type CalmStatus } from './ui/status';
import { companionPorts, companionView, setupActivity, type SetupActivity } from './ui/onboarding';
import { replayArmResult, runReplay } from './replay';

const APP = 'companion@0.2.0';
const params = new URLSearchParams(location.search);
const pairNow = params.get('pair') === '1';

// --- state ----------------------------------------------------------------------------------

let health: Health | undefined;
let identity: Identity | undefined = loadIdentity();
let conn: Connection | undefined;
let canApprove = false;
let welcome: PayloadOf<'welcome'> | undefined;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let selfExpiresAt = 0;
let selfPairing = false;
let selfPairingError = false;
let selfPairGeneration = 0;
let pairedWithQuest = false;
const pending = new Map<string, PendingPairing>();
const settledPairings = new Set<string>();
let devices: DeviceInfo[] = [];
const steps = new Map<string, AgentStepPayload & { seenAt: number }>();
const cards = new Map<string, DeviceCardPayload>();
const drivers = new Map<string, DriverSpecPayload>();
const driverStatus = new Map<string, DriverStatusPayload>();
const evidence: VerifyResultPayload[] = [];
const linkResults = new Map<string, LinkResultPayload>();
/** "wrong device · refused" verdicts stay in EVIDENCE even after the right cable goes in */
const refusals: LinkResultPayload[] = [];
const replaying = params.get('replay') === '1';
/** Larger status type for recordings; details remain available. */
const stage = params.get('stage') === '1';
let replayStarted = false;
const linkRequests = new Map<string, LinkRequestPayload>();
const specs = new Map<string, UiSpecPayload>();
let lastSpec: UiSpecPayload | undefined;
let arm: ArmRequestPayload | undefined;
let armNote: { text: string; ok: boolean; at: number } | undefined;
let focusCardId: string | undefined;
let focusPinned = false;
let calls: CallsResponse | undefined;
let mainTab: 'code' | 'tape' | 'spec' = 'code';
let tabChosenByUser = false;
let addTarget: 'phone' | 'quest' | 'devterm' = 'phone';
let qrShown = '';
let headsetQrShown = '';
const targets = new Map<string, TargetStatusPayload>();
let currentSetup: SetupActivity | undefined;
let currentView: 'home' | 'devices' | 'activity' | 'details' = 'home';
let stopTarget: TargetStatusPayload | undefined;
let serverDown = false;
const presenter = createStatusPresenter();
let activity: CalmStatus = { text: 'Idle', working: false };
let shownStatus = '';
let statusAnimation: Animation | undefined;
let pairingBusy = false;
let shownPair = '';
const bridgeBusy = new Set<string>();
const dialogTimers = new Map<HTMLDialogElement, ReturnType<typeof setTimeout>>();

const midi = new MidiBridge();
const midiExec = new MidiExecutor(midi);
const link = new CardputerLink(APP);
const bridge = new CardputerBridge(link, APP);
const oracle = new AudioOracle();
const executor = new Executor(midiExec, bridge, oracle, new VisualSynthExecutor());

/** /p/<id>#<code> redirects here as /companion/?approve=<id>#<code> */
let intent = (() => {
  const pairingId = params.get('approve');
  const code = location.hash.slice(1);
  return pairingId && isValidCode(code) ? { pairingId, code } : undefined;
})();

// --- log ------------------------------------------------------------------------------------

type Level = 'debug' | 'info' | 'warn' | 'error';
function log(level: Level, text: string): void {
  appendLine($('log'), `${clock()} ${level.padEnd(5)} ${companionText(text)}`, `lvl-${level}`);
}
executor.log = log;
bridge.log = log;

const render = scheduler({
  calm: renderCalm,
  top: renderTop,
  banners: renderBanners,
  device: renderDevice,
  code: renderCode,
  tape: renderTape,
  spec: renderSpec,
  agent: renderAgent,
  calls: renderCalls,
  evidence: renderEvidence,
  learn: renderLearn,
  links: renderLinks,
  approve: renderApprove,
  daemons: renderDaemons,
});
const renderAll = () => ['calm', 'top', 'banners', 'device', 'code', 'tape', 'spec', 'agent', 'calls', 'evidence', 'learn', 'links', 'approve', 'daemons'].forEach(render);

// --- helpers --------------------------------------------------------------------------------

const KIND_GLYPH: Record<string, string> = { quest: '◉', mac: '▱', iphone: '▯', devterm: '⌨', cardputer: '⌁', web: '◇', sim: '▧' };
const CHANNEL_GLYPH: Record<string, string> = { midi: '▥', ir: '⌁', local: '▱', sim: '▧' };

function setFocus(cardId: string | undefined, byUser = false): void {
  if (byUser) focusPinned = true;
  else if (focusPinned) return;
  if (!cardId || cardId === focusCardId) return;
  focusCardId = cardId;
  ['device', 'code', 'tape', 'spec', 'evidence', 'daemons'].forEach(render);
}

function focusDriver(): DriverSpecPayload | undefined {
  const all = [...drivers.values()];
  return focusCardId ? all.filter((d) => d.cardId === focusCardId).at(-1) : all.at(-1);
}

function deviceName(deviceId?: string): string | undefined {
  return devices.find((d) => d.deviceId === deviceId)?.name;
}

function controlNameFor(actionId: string): string | undefined {
  for (const s of specs.values()) {
    if (focusCardId && s.cardId !== focusCardId) continue;
    for (const h of s.hackset?.hacks ?? []) if (h.commands.some((c) => c.action === actionId)) return h.name;
  }
  return undefined;
}

/** epoch ms → performance.now() timeline (the oracle's level history uses the latter) */
const perfAt = (epoch: number) => epoch - Date.now() + performance.now();

async function renderQr(target: HTMLElement, text: string): Promise<void> {
  // qrcode returns SVG markup it generated itself from `text`; nothing untrusted is interpreted as HTML
  target.innerHTML = await qrSvg(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#1E1E1E', light: '#FFFFFF' } });
}

function chip(text: string, cls = ''): HTMLElement {
  return el('span', { className: `chip ${cls}`, text });
}

// --- calm surface ---------------------------------------------------------------------------

function openDialog(id: string): void {
  if (id === 'drawer') { showView('details'); return; }
  const dialog = $<HTMLDialogElement>(id);
  clearTimeout(dialogTimers.get(dialog));
  dialogTimers.delete(dialog);
  dialog.classList.remove('closing');
  if (!dialog.open) dialog.showModal();
}

function closeDialog(id: string): void {
  if (id === 'drawer') { showView('home'); return; }
  const dialog = $<HTMLDialogElement>(id);
  if (!dialog.open || dialogTimers.has(dialog)) return;
  const finish = () => {
    dialog.close();
    dialog.classList.remove('closing');
    dialogTimers.delete(dialog);
  };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { finish(); return; }
  dialog.classList.add('closing');
  dialogTimers.set(dialog, setTimeout(finish, 180));
}

function showView(view: typeof currentView, focus = true): void {
  currentView = view;
  $('workbench').dataset.view = view;
  $('home-view').hidden = view === 'details' || view === 'activity';
  $('drawer').hidden = view !== 'details';
  $('activity-view').hidden = view !== 'activity';
  for (const [id, target] of [['nav-home', 'home'], ['nav-devices', 'devices'], ['nav-activity', 'activity'], ['details-open', 'details']]) {
    $(id).setAttribute('aria-current', view === target ? 'page' : 'false');
    $(id).classList.toggle('active', view === target);
  }
  $('details-open').setAttribute('aria-expanded', String(view === 'details'));
  if (focus) {
    const heading = $(view === 'details' ? 'details-title' : view === 'activity' ? 'activity-title' : 'home-title');
    heading.tabIndex = -1;
    heading.focus();
  }
  render('calm');
}

function renderStatus(text: string): void {
  if (text === shownStatus) return;
  const host = $('status-text');
  const shouldAnimate = shownStatus !== '' && !statusAnimation && !matchMedia('(prefers-reduced-motion: reduce)').matches && typeof host.animate === 'function';
  shownStatus = text;
  if (statusAnimation) {
    statusAnimation.onfinish = null;
    statusAnimation.cancel();
    statusAnimation = undefined;
  }
  if (!shouldAnimate) {
    host.textContent = text;
    return;
  }
  const motion = getComputedStyle(host);
  const easing = motion.getPropertyValue('--ease').trim();
  const outgoing = host.animate([
    { opacity: 1, transform: 'translateY(0)' },
    { opacity: 0, transform: 'translateY(-4px)' },
  ], { duration: parseFloat(motion.getPropertyValue('--status-exit')), easing, fill: 'forwards' });
  statusAnimation = outgoing;
  outgoing.onfinish = () => {
    if (statusAnimation !== outgoing) return;
    host.textContent = text;
    outgoing.cancel();
    const incoming = host.animate([
      { opacity: 0, transform: 'translateY(4px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ], { duration: parseFloat(motion.getPropertyValue('--status-enter')), easing });
    statusAnimation = incoming;
    incoming.onfinish = () => {
      if (statusAnimation === incoming) statusAnimation = undefined;
    };
  };
}

function renderCalm(): void {
  renderOnboarding();
  const learning = bridge.learning && bridge.learning.until > Date.now() ? bridge.learning : undefined;
  const status: CalmStatus = !replaying && serverDown
    ? { text: 'Waiting for the server to reconnect', working: false }
    : !replaying && !conn?.open
      ? { text: 'Connecting to your room', working: true }
      : learning
        ? { text: `Learning your remote: ${learning.prompt ?? 'press each button once'}`, working: true }
        : activity;
  $('status-dot').className = `dot on${status.working ? ' working' : ''}`;
  renderStatus(status.text);
  const relevant = (target: TargetStatusPayload) => !target.executorDeviceId || target.executorDeviceId === identity?.deviceId || linkResults.get(target.cardId)?.channel === 'local';
  const latestTarget = [...targets.values()].reverse().find(relevant);
  const activeStates: Record<string, string> = { identifying: 'Identifying', linking: 'Connecting to', researching: 'Reading instructions for', driving: 'Writing controls for', verifying: 'Checking', forging: 'Making controls for' };
  stopTarget = !serverDown && conn?.open ? [...targets.values()].reverse().find((target) => relevant(target) && target.state in activeStates) : undefined;
  const working = Boolean(stopTarget || status.working && (!targets.size || learning));
  $('setup-activity').hidden = currentView === 'devices' || $('workbench').classList.contains('pairing') || Boolean(targets.size && !latestTarget);
  $('setup-activity-text').textContent = stopTarget
    ? currentSetup?.cardId === stopTarget.cardId ? currentSetup.text : companionText(stopTarget.sentence ?? `${activeStates[stopTarget.state]} ${cards.get(stopTarget.cardId)?.name ?? 'your device'}…`)
    : status.text;
  $('setup-activity').classList.toggle('working', working);
  $('setup-progress').hidden = !working;
  $('setup-stop').hidden = !working || !(stopTarget || learning) || !conn?.open;
  $<HTMLButtonElement>('setup-stop').disabled = replaying;
  $('device-dots').replaceChildren(...devices.map((d) => {
    const row = el('li', { className: `device-dot-item${d.online ? ' online' : ''}`, title: `${d.name} · ${d.online ? 'online' : 'offline'}` }, el('span', { className: `dot${d.online ? ' on' : ''}` }), el('span', { text: d.name }));
    row.setAttribute('aria-label', `${d.name}, ${d.online ? 'online' : 'offline'}`);
    return row;
  }));
  const pill = (id: string, name: string, on: boolean, supported: boolean, detail?: string) => {
    const b = $<HTMLButtonElement>(`bridge-${id}`);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    b.disabled = replaying || !executor.leader || !supported || bridgeBusy.has(id);
    b.title = replaying ? 'Display-only demo' : !supported ? `${name} needs Chrome on localhost or HTTPS` : !executor.leader ? 'Another companion tab runs the bridges' : detail ?? `${name}: ${on ? 'on' : 'off — click to enable'}`;
    b.setAttribute('aria-label', `${name}, ${on ? 'on' : 'off'}`);
  };
  pill('midi', 'MIDI', midi.enabled, MidiBridge.supported);
  pill('serial', 'Cardputer', link.ready, CardputerLink.supported, link.lastError);
  pill('mic', 'Microphone', oracle.state === 'on', AudioOracle.supported, oracle.error);
  $('details-open').classList.toggle('attention', Boolean(arm));
}

function renderOnboarding(): void {
  const ownId = identity?.deviceId;
  const ports = companionPorts(ownId, devices, midi.ports(), executor.leader);
  currentSetup = undefined;
  for (const target of [...targets.values()].reverse()) {
    const result = linkResults.get(target.cardId);
    const candidate = [...linkRequests.values()].some((request) => request.cardId === target.cardId && request.needs.includes('midi') && request.candidates?.some((c) => c.deviceId === ownId));
    if (!ownId || (target.executorDeviceId ?? result?.executorDeviceId) !== ownId && !(target.state === 'linking' && candidate)) continue;
    const card = cards.get(target.cardId);
    if (card && !card.protocols.includes('midi')) continue;
    const step = [...steps.values()].reverse().find((s) => s.cardId === target.cardId);
    const next = setupActivity(card?.name ?? ports[0]?.name ?? 'your synth', target, step);
    if (next) { currentSetup = next; break; }
  }
  const view = companionView({
    connected: replaying || Boolean(conn?.open), authenticated: Boolean(identity), pairing: selfPairing || selfPairingError,
    devices, ports, midiSupported: MidiBridge.supported, midiEnabled: midi.enabled, leader: executor.leader, headsetPaired: pairedWithQuest, activity: currentSetup,
  });
  const pairOnly = pairNow && !identity;
  const paired = Boolean(identity && !selfPairing && (pairedWithQuest || devices.some((d) => d.kind === 'quest')));
  $('workbench').classList.toggle('pair-only', pairOnly);
  const pairing = !paired && !replaying && ['pairing', 'connecting', 'headset'].includes(view.stage);
  $('app-header').hidden = pairing;
  $('workbench').classList.toggle('pairing', pairing);
  $('onboarding').classList.toggle('has-paired', paired);
  $('paired-summary').hidden = !paired;
  $('onboarding').dataset.state = view.stage;
  $('onboarding-title').textContent = view.title;
  $('onboarding-next').textContent = view.next;
  $('headset-status').textContent = view.headset;
  $('headset-status').classList.toggle('connected', devices.some((d) => d.kind === 'quest' && d.online));
  $('synth-status').textContent = view.synth;
  $('synth-status').classList.toggle('connected', ports.length > 0);
  $('home-title').textContent = currentView === 'activity' ? 'Activity' : currentView === 'details' ? 'Device details' : view.headset;
  const quest = devices.find((d) => d.kind === 'quest' && d.online);
  $('home-chips').replaceChildren(
    ...(ports.length ? [chip('USB MIDI ready')] : []),
    ...(quest?.capabilities.includes('mic') ? [chip('Headset mic active')] : []),
  );
  $('devices-panel').hidden = pairing;
  $('connection-steps').hidden = view.stage === 'pairing' || view.stage === 'connecting';
  $('pairscreen').hidden = view.stage !== 'pairing';
  $('headset-open').hidden = view.stage !== 'headset';
  const questUrl = health?.urls.https ? `${health.urls.https}/quest/` : undefined;
  $('headset-url').textContent = questUrl ?? 'Open the server’s Quest address in Quest Browser.';
  $('headset-qr').hidden = !questUrl;
  if (questUrl && questUrl !== headsetQrShown) {
    headsetQrShown = questUrl;
    void renderQr($('headset-qr'), questUrl);
  }
  $('approve-panel').hidden = !canApprove || view.stage !== 'headset';
  $('enable-midi').hidden = !view.enableMidi;
  $<HTMLButtonElement>('enable-midi').disabled = replaying || bridgeBusy.has('midi');
  renderHomeDevices(ports);
}

function renderHomeDevices(ports: Port[]): void {
  const rows: HTMLElement[] = [];
  const usedPorts = new Set<string>();
  const addRow = (icon: string, name: string, transport: string, state: string, subtitle: string, tone: string, action?: HTMLButtonElement) => {
    const dot = el('span', { className: `dot ${tone}` });
    dot.setAttribute('aria-hidden', 'true');
    const glyph = el('span', { className: 'device-icon' }, deviceIcon(icon));
    glyph.setAttribute('aria-hidden', 'true');
    rows.push(el('div', { className: 'device-row' }, glyph,
      el('div', { className: 'device-info' }, el('div', { className: 'device-name', text: `${name} · ${transport} · ${state}` }), el('p', { className: 'device-subtitle', text: subtitle })),
      el('span', { className: `status-word ${tone}` }, dot, state), action));
  };
  for (const card of cards.values()) {
    const connection = linkResults.get(card.cardId);
    const target = targets.get(card.cardId);
    const driver = [...drivers.values()].filter((d) => d.cardId === card.cardId).at(-1);
    const transport = connection?.channel ?? driver?.transport ?? card.protocols[0];
    const port = ports.find((p) => p.id === connection?.port?.id || p.id === driver?.executor.port || p.name === connection?.port?.name);
    if (port) usedPorts.add(port.id);
    const connected = connection?.verdict === 'confirmed' || connection?.verdict === 'consistent' || Boolean(port);
    const ready = target?.state === 'armed' || target?.state === 'controlling';
    const failed = target?.state === 'failed' || connection?.verdict === 'mismatch';
    const offline = target?.detail === 'offline' || transport === 'midi' && midi.enabled && !port;
    const state = failed ? 'Needs attention' : offline ? 'Not connected' : ready ? 'Ready' : 'Needs setup';
    const spec = specs.get(card.cardId);
    const count = spec?.hackset?.hacks.length ?? spec?.gen3d?.controls.length;
    const subtitle = companionText(target?.sentence ?? (count ? `${count} controls ready${ready ? ' · Enabled in your headset' : ' · Waiting for headset confirmation'}` : [card.maker, card.model, connected ? 'Connected to this Mac' : 'Select the device in your headset to set up controls'].filter(Boolean).join(' · ')));
    addRow(transport === 'midi' ? '▥' : transport === 'local' ? '▱' : '⌁', card.name, transport === 'midi' ? 'USB MIDI' : transport === 'local' ? 'This Mac' : transport === 'ir' ? 'Infrared' : 'Device', state, subtitle, failed ? 'danger' : offline ? '' : ready ? 'on' : 'warn', button('Details', () => { setFocus(card.cardId, true); showView('details'); }));
  }
  for (const port of ports) {
    if (usedPorts.has(port.id)) continue;
    if (/visual[\s-]synth/i.test(port.name) || port.id === 'ce-visual-synth') {
      addRow('▱', 'Visual synth', 'Virtual', 'Ready', 'Silent visuals on this Mac · open them, then select the screen in your headset.', 'on',
        button('Open visuals', () => { window.open('/vsynth/', '_blank', 'noopener'); }));
      continue;
    }
    addRow('▥', port.name, 'USB MIDI', 'Ready', 'USB connected · Select the synth in your headset to set up controls.', 'on', button('Details', () => showView('details')));
  }
  if (!ports.length && ![...cards.values()].some((c) => c.protocols.includes('midi'))) {
    addRow('▥', 'USB MIDI', 'This Mac', midi.enabled ? 'Not connected' : 'Off', midi.enabled ? 'Plug in your synth with a USB cable.' : MidiBridge.supported ? 'Allow access to connect your synth over USB.' : 'Open this page in Chrome or Edge to connect USB devices.', '');
  }
  const serialAction = button(link.hasPort ? 'Details' : 'Connect', () => {
    if (link.hasPort) showView('details');
    else $<HTMLButtonElement>('bridge-serial').click();
  });
  serialAction.disabled = replaying || !executor.leader || !CardputerLink.supported || bridgeBusy.has('serial');
  addRow('⌁', 'Cardputer', 'Serial', bridge.online ? 'Ready' : link.ready ? 'Needs setup' : 'Not connected', link.lastError ?? 'Plug in via USB-C to send and capture infrared remote controls.', bridge.online ? 'on' : link.ready ? 'warn' : '', serialAction);
  for (const device of devices) {
    if (device.deviceId === identity?.deviceId || device.kind === 'quest' || device.kind === 'cardputer') continue;
    addRow('▱', device.name, device.kind === 'mac' ? 'Mac' : 'Network', device.online ? 'Connected' : 'Not connected', device.online ? 'Paired with your room' : 'Open the device app to reconnect.', device.online ? 'on' : '', button('Details', () => showView('details')));
  }
  $('home-devices').replaceChildren(...rows);
}

function deviceIcon(kind: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', kind === '▥' ? 'M2 4h16v12H2ZM6 5v7m4-7v7m4-7v7'
    : kind === '⌁' ? 'M3 7a10 10 0 0 1 14 0M6 10a6 6 0 0 1 8 0m-5 3h2m-1 3h.01'
      : 'M3 3h14v11H3ZM1 17h18');
  svg.append(path);
  return svg;
}

function removePending(pairingId: string): void {
  pending.delete(pairingId);
  settledPairings.add(pairingId);
  if (settledPairings.size > 100) settledPairings.delete(settledPairings.values().next().value!);
  if (intent?.pairingId === pairingId) clearIntent();
}

function renderPairSheet(): void {
  const request = [...pending.values()].find((p) => p.expiresAt > Date.now());
  const pairing = request ?? (intent ? { ...intent, name: 'Your device', display: formatCode(intent.code), expiresAt: undefined } : undefined);
  if (!pairing || !canApprove || replaying) {
    shownPair = '';
    closeDialog('pair-sheet');
    return;
  }
  if (shownPair !== pairing.pairingId) {
    shownPair = pairing.pairingId;
    const title = el('h2', { id: 'pair-title', className: 'pair-name', text: `Pair ${pairing.name}?` });
    const code = el('div', { className: 'passcode', text: pairing.display });
    const expiry = el('p', { className: 'dim small', text: pairing.expiresAt ? untilText(pairing.expiresAt) : 'Check that this code matches your device.' });
    if (pairing.expiresAt) expiry.dataset.expires = String(pairing.expiresAt);
    const error = el('p', { id: 'pair-error', className: 'small' });
    error.setAttribute('role', 'alert');
    const actions = el('div', { className: 'pair-actions' }, button('Deny', () => void deny(pairing.pairingId)), button('Approve', () => void approve(pairing.code, pairing.pairingId), 'primary'));
    $('pending').replaceChildren(title, code, expiry, error, actions);
  }
  for (const b of $('pending').querySelectorAll('button')) b.disabled = pairingBusy;
  openDialog('pair-sheet');
}

function setupCalm(): void {
  for (const view of ['home', 'devices', 'activity'] as const) $('nav-' + view).addEventListener('click', () => showView(view));
  $('details-open').addEventListener('click', () => openDialog('drawer'));
  $('details-close').addEventListener('click', () => closeDialog('drawer'));
  $('pair-sheet').addEventListener('cancel', (e) => e.preventDefault());
  const bind = (id: string, action: () => void | Promise<void>) => {
    $(`bridge-${id}`).addEventListener('click', async () => {
      if (replaying || !executor.leader || bridgeBusy.has(id)) return;
      bridgeBusy.add(id);
      $('bridge-msg').textContent = '';
      render('calm');
      try { await action(); }
      catch (e) {
        $('bridge-msg').textContent = (e as Error).message;
        log('warn', (e as Error).message);
      } finally {
        bridgeBusy.delete(id);
        renderAll();
      }
    });
  };
  bind('midi', () => midi.enabled ? openDialog('drawer') : enableMidi());
  $('enable-midi').addEventListener('click', async () => {
    if (replaying || !executor.leader || bridgeBusy.has('midi')) return;
    bridgeBusy.add('midi');
    render('calm');
    try { await enableMidi(); }
    finally { bridgeBusy.delete('midi'); render('calm'); }
  });
  $('setup-stop').addEventListener('click', () => {
    if (replaying) return;
    if (bridge.learning && bridge.learning.until > Date.now()) { bridge.stopLearning(); return; }
    if (!stopTarget) return;
    if (conn?.send('control.cancel', { cardId: stopTarget.cardId, ...(stopTarget.runId ? { runId: stopTarget.runId } : {}) }, { to: 'server' })) {
      $('setup-activity-text').textContent = 'Stopping setup and controls…';
      $<HTMLButtonElement>('setup-stop').disabled = true;
    }
  });
  bind('serial', () => link.hasPort ? link.close() : connectCardputer());
  bind('mic', () => oracle.state === 'on' ? oracle.stop() : startOracle());
  showView('home', false);
}

// --- top bar and banners --------------------------------------------------------------------

function renderTop(): void {
  const pill = $('pill');
  const live = health?.mode === 'live';
  if (replaying) {
    $('pill-text').textContent = 'Demo · display only';
    pill.className = 'pill';
  } else if (!executor.leader && health && !serverDown) {
    // one pill, one state: a second tab says so here instead of in a banner
    $('pill-text').textContent = 'Standby · another tab runs the devices';
    pill.className = 'pill standby';
  } else {
    $('pill-text').textContent = serverDown ? 'Server unreachable' : !health ? 'Connecting' : live ? 'Live' : 'Recorded answers';

    pill.className = `pill ${health && !live ? 'fixture' : ''}`;
  }
  const model = [...steps.values()].filter((step) => step.model).at(-1)?.model ?? health?.models.chat;
  $('model-in-use').textContent = model ?? (replaying ? 'Demo' : 'Waiting for model');
  $('model-in-use').title = `Model in use: ${model ?? 'waiting for connection'}`;
  $('conn-dot').className = `dot ${conn?.open ? 'on' : ''}`;
  $('conn-dot').title = conn?.open ? 'connected to the server' : 'offline';
  const space = welcome?.spaceId ?? health?.space?.spaceId;
  $('session').textContent = space ? `Space ${space.slice(-6).toUpperCase()}${welcome ? ` · ${welcome.name}` : ''}` : 'Space —';
  const role = $('exec-role');
  role.textContent = replaying ? 'Display only' : executor.leader ? 'Runs local bridges' : 'standby';
  role.className = `chip ${executor.leader ? '' : 'muted'}`;
  role.title = replaying ? 'A local demonstration. No device commands or server connection.' : executor.leader ? 'This tab runs MIDI, the Cardputer and the audio oracle.' : 'Another companion tab is the executor; this one only watches.';
}

function renderBanners(): void {
  const box = $('banners');
  box.replaceChildren();
  if (serverDown) box.append(el('div', { className: 'banner' }, el('span', { className: 'title', text: 'Server unreachable' }), el('span', { className: 'small', text: 'Start it with npm run dev. MIDI tools still work: open ?spike=midi.' })));

  if (arm && arm.expiresAt > Date.now()) {
    const a = arm;
    const actions = el('div', { className: 'chips' }, ...a.actions.map((x) => chip(`${x.label} · ${x.verified === 'pass' ? 'verified' : x.verified}`, x.verified === 'pass' ? 'ok' : 'muted')));
    const row = el(
      'div',
      { className: 'banner' },
      el('span', { className: 'title', text: `Enable · ${a.title}` }),
      el('span', { className: 'grow small', text: companionText(a.summary) }),
      el('span', { className: 'tiny dim mono', text: untilText(a.expiresAt), data: { expires: String(a.expiresAt) } }),
      actions,
    );
    if (a.irreversible) row.append(holdButton('Hold to enable', () => confirmArm(a, true, true)));
    else row.append(button('Enable', () => confirmArm(a, true, false), 'primary'));
    row.append(button('Cancel', () => confirmArm(a, false, false)));
    box.append(row);
  } else if (armNote && Date.now() - armNote.at < 8000) {
    box.append(el('div', { className: 'banner info' }, el('span', { className: `title ${armNote.ok ? 'ok-text' : ''}`, text: armNote.ok ? 'Enabled' : 'Not enabled' }), el('span', { className: 'small', text: companionText(armNote.text) })));
  }

  for (const r of linkRequests.values()) {
    const done = linkResults.get(r.cardId);
    if (done && done.verdict !== 'none' && done.verdict !== 'unknown') continue;
    const card = cards.get(r.cardId);
    const row = el(
      'div',
      { className: 'banner link' },
      el('span', { className: 'title', text: `Connect · ${card?.name ?? 'device'}` }),
      el('span', { className: 'grow small', text: r.reason }),
      el('span', { className: 'row' }, ...r.needs.map((n) => chip(`needs ${n}`, 'accent')), ...r.suggestedClients.map((k) => chip(k, 'muted'))),
    );
    if (r.needs.includes('ir') && !link.ready && CardputerLink.supported && executor.leader) row.append(button('Connect', () => void connectCardputer(), 'primary'));
    if (r.needs.includes('midi') && !midi.enabled && MidiBridge.supported && executor.leader) row.append(button('Allow USB MIDI', () => void enableMidi(), 'primary'));
    if (r.needs.includes('mic') && oracle.state !== 'on' && executor.leader) row.append(button('Listen', () => void startOracle(), 'primary'));
    box.append(row);
  }
}

function holdButton(label: string, onHeld: () => void): HTMLButtonElement {
  const b = el('button', { className: 'primary', text: label });
  b.type = 'button';
  let t: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    clearTimeout(t);
    t = undefined;
    b.textContent = label;
  };
  const begin = () => {
    if (t) return;
    b.textContent = 'Holding…';
    t = setTimeout(() => {
      t = undefined;
      b.textContent = label;
      onHeld();
    }, 600);
  };
  b.addEventListener('pointerdown', begin);
  b.addEventListener('keydown', (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); begin(); }
  });
  b.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') cancel(); });
  b.addEventListener('blur', cancel);
  b.addEventListener('pointercancel', cancel);
  b.addEventListener('pointerup', cancel);
  b.addEventListener('pointerleave', cancel);
  return b;
}

function confirmArm(a: ArmRequestPayload, approve: boolean, hold: boolean): void {
  if (replaying && conn) {
    conn.inject(replayArmResult(a.armId, approve));
    return;
  }
  if (!conn?.send('arm.confirm', { armId: a.armId, approve, ...(hold ? { hold } : {}) }, { to: 'server' })) {
    log('error', 'Not connected: could not answer the approval request');
    return;
  }
  log('info', `${approve ? 'enabled' : 'cancelled'} ${a.title}`);
  arm = undefined;
  render('banners');
}

// --- device card, code, tape, spec ----------------------------------------------------------

function renderDevice(): void {
  const box = $('device-card');
  box.replaceChildren();
  const card = focusCardId ? cards.get(focusCardId) : undefined;
  const drv = focusDriver();
  const lr = focusCardId ? linkResults.get(focusCardId) : undefined;
  const hs = focusCardId ? specs.get(focusCardId)?.hackset : lastSpec?.hackset;
  const name = card?.name ?? drv?.name ?? hs?.device.name;
  if (!name) {
    const outs = midi.outputs();
    box.append(
      el('div', { className: 'name', text: 'No target yet' }),
      el('span', { className: 'chip muted', text: 'Scan from your headset' }),
      el(
        'div',
        { className: 'facts' },
        el('span', { text: outs.length ? `USB MIDI: ${outs.map((o) => o.name ?? o.id).join(', ')}` : midi.enabled ? 'waiting for USB… plug in a synth' : 'USB MIDI · Off' }),
        el('span', { text: link.ready ? `Cardputer: ${link.info?.board ?? 'ready'}` : 'Cardputer: not connected' }),
        el('span', { text: oracle.state === 'on' ? `listening: ${oracle.input?.label ?? 'input'}` : 'Microphone · Off' }),
      ),
    );
    return;
  }
  const channel = lr?.channel ?? drv?.transport;
  const port = lr?.port?.name ?? drv?.executor.port;
  const facts = el('div', { className: 'facts' });
  const fact = (k: string, v: string | undefined) => {
    if (v) facts.append(el('span', {}, `${k} `, el('b', { text: v })));
  };
  fact('maker', card?.maker);
  fact('model', card?.model || undefined);
  fact('kind', card?.category ?? hs?.device.kind);
  fact('channel', channel === 'local' ? 'Local' : channel?.toUpperCase());
  fact('port', port ? `"${port}"` : undefined);
  fact('via', deviceName(lr?.executorDeviceId ?? drv?.executor.deviceId));
  // opinion (the camera's reading) and proof (what the wire says): never a numeric model confidence
  const chips = el('span', { className: 'row' });
  if (card) chips.append(chip('Seen by camera', 'opinion'));
  chips.append(proofChip(lr));
  box.append(el('div', { className: 'name', text: name }), chips, facts);
}

/** The wire's verdict as words: "USB says OP-1 ✓", "wrong device · refused", or still a hypothesis. */
function proofChip(lr: LinkResultPayload | undefined): HTMLElement {
  if (!lr || lr.verdict === 'none' || lr.verdict === 'unknown') return chip('Not connected', 'muted');
  if (lr.verdict === 'mismatch') return chip('Wrong device · Not connected', 'fail');
  const ok = lr.evidence.filter((e) => e.ok);
  const id = ok.find((e) => e.kind === 'midi-identity' && !/no reply/i.test(e.detail));
  if (id) return chip(`MIDI identity says ${cards.get(lr.cardId)?.name ?? 'match'} ✓`, 'ok');
  if (ok.some((e) => e.kind === 'port-name') && lr.port) return chip(`USB says ${lr.port.name} ✓`, 'ok');
  if (ok.some((e) => e.kind === 'ir-reply')) return chip('IR seen ✓', 'ok');
  if (ok.some((e) => e.kind === 'sim')) return chip('sim linked ✓', 'ok');
  return chip(`${lr.channel === 'local' ? 'Local' : lr.channel === 'midi' ? 'USB MIDI' : 'Device'} connected ✓`, 'ok');
}


function setTab(t: typeof mainTab, byUser = false): void {
  mainTab = t;
  if (byUser) tabChosenByUser = true;
  for (const id of ['code', 'tape', 'spec'] as const) {
    $(`tab-${id}`).setAttribute('aria-selected', String(id === t));
    $(`tab-${id}`).tabIndex = id === t ? 0 : -1;
    $(id).hidden = id !== t;
  }
  render(t);
}

function runningGen(): (AgentStepPayload & { seenAt: number }) | undefined {
  return [...steps.values()].filter((s) => (!focusCardId || s.cardId === focusCardId) && ['drive', 'codegen', 'forge'].includes(s.phase)).at(-1);
}

function renderCode(): void {
  const box = $('code');
  const drv = focusDriver();
  const gen = runningGen();
  const genChip = $('gen-chip');
  genChip.replaceChildren();
  if (gen?.model) {
    const running = gen.status === 'running' || gen.status === 'pending';
    const since = gen.startedAt ?? gen.seenAt;
    const c = chip(`${running ? 'Writing · ' : ''}${gen.model}${gen.effort ? ` · ${gen.effort}` : ''} · ${running ? secs(Date.now() - since) : secs(gen.latencyMs ?? (gen.endedAt && gen.startedAt ? gen.endedAt - gen.startedAt : 0))}`, 'model');
    if (running) c.dataset.since = String(since);
    if (running) c.dataset.prefix = `Writing · ${gen.model}${gen.effort ? ` · ${gen.effort}` : ''} · `;
    genChip.append(c);
  } else if (drv?.modelId) genChip.append(chip(drv.modelId, 'model'));
  $('filetab').textContent = drv ? `driver · ${drv.cardId}.json${drv.version ? ` · v${drv.version}` : ''}` : '';
  box.replaceChildren();
  if (!drv) {
    const waiting = gen && (gen.status === 'running' || gen.status === 'pending');
    box.append(jsonView(undefined, waiting ? `waiting for ${gen.model ?? 'the model'} to write the driver…` : 'No driver yet. Select a device in your headset to make controls.\nThe agent checks each action before enabling it.'));
    return;
  }
  const prov = drv.provenance.map((p) => `${p.source}: ${p.ref}`).join('\n');
  box.append(jsonView(drv, `driver.spec · ${drv.transport.toUpperCase()} · written by ${drv.modelId ?? 'the agent'}${drv.source === 'fixture' ? ' (recorded example)' : ''}${prov ? `\n${prov}` : ''}`));
}

function renderTape(): void {
  const box = $('tape');
  box.replaceChildren();
  const driver = focusDriver();
  const rows = executor.tape.filter((row) => !focusCardId || row.cardId === focusCardId || Boolean(driver && row.driverId === driver.driverId)).slice(-120);
  if (!rows.length) {
    box.append(el('div', { className: 'empty', text: 'Nothing sent yet. Every command this Mac sends to a device appears here with its ack and verdict.' }));
    return;
  }
  for (const r of rows) {
    const status = r.ack ? (r.ack.ok ? `sent · ${r.ack.latencyMs ?? 0} ms` : `${r.ack.error ?? 'failed'}`) : 'sending';
    const right = el('span', { className: 'row' }, el('span', { className: r.ack && !r.ack.ok ? 'fail-text' : 'dim', text: status }));
    if (r.verdict) right.append(chip(companionText(r.verdict.text), r.verdict.pass ? 'ok' : 'fail'));
    box.append(el('div', { className: 'r', title: r.ack?.detail ?? '' }, el('span', { className: 'dim', text: clock(r.at) }), el('span', { text: companionText(r.what) }), el('span', { className: 'dim target', text: r.target }), right));
  }
  box.scrollTop = box.scrollHeight;
}

function renderSpec(): void {
  const box = $('spec');
  box.replaceChildren();
  const selectedSpec = focusCardId ? specs.get(focusCardId) : lastSpec;
  if (!selectedSpec) {
    box.append(jsonView(undefined, 'No controls yet. Checked controls and their interface specification appear here.'));
    return;
  }
  const { gen3d, ...rest } = selectedSpec;
  box.append(jsonView({ ...rest, gen3d: gen3d ? { spec: gen3d.spec, title: gen3d.title, controls: gen3d.controls.map((c) => c.id), parts: gen3d.parts.length, modelId: gen3d.modelId } : undefined }, `ui.spec rev ${selectedSpec.rev ?? 1} · ${selectedSpec.modelId ?? ''}${selectedSpec.check ? ` · checks ${selectedSpec.check.ok ? 'passed' : 'failed'} after ${selectedSpec.check.attempts} attempt(s)` : ''}`));
}

// --- agent log and model calls --------------------------------------------------------------

function renderAgent(): void {
  const box = $('worklog');
  const list = [...steps.values()].sort((a, b) => (a.startedAt ?? a.seenAt) - (b.startedAt ?? b.seenAt)).slice(-80);
  if (!list.length) {
    box.replaceChildren(el('p', { className: 'empty', text: 'Agent steps, models, and timings will appear here.' }));
    return;
  }
  const table = el('table', { className: 'agent-table' });
  table.setAttribute('aria-label', 'Agent steps and model latency');
  const headings = ['Time', 'Step', 'Message', 'Model'].map((text) => {
    const heading = el('th', { text });
    heading.setAttribute('scope', 'col');
    return heading;
  });
  const body = el('tbody');
  table.append(el('thead', {}, el('tr', {}, ...headings)), body);
  for (const s of list) {
    const running = s.status === 'running' || s.status === 'pending';
    const since = s.startedAt ?? s.seenAt;
    const latency = s.latencyMs ?? (s.endedAt && s.startedAt ? s.endedAt - s.startedAt : undefined);
    const prefix = [s.model, s.effort].filter(Boolean).join(' · ');
    const duration = running ? secs(Date.now() - since) : latency !== undefined ? secs(latency) : '';
    const model = chip([prefix, duration].filter(Boolean).join(' · ') || 'Local check', s.model ? 'model' : 'muted');
    if (running) {
      model.dataset.since = String(since);
      model.dataset.prefix = prefix ? `${prefix} · ` : '';
    }
    const message = el('td', {}, el('div', { className: 'title', text: companionText(s.title) }));
    const detail = [s.evidence, s.detail].filter(Boolean).join(' · ');
    if (detail) message.append(el('div', { className: 'detail', text: companionText(detail.slice(0, 300)) }));
    if (s.source === 'fixture') message.append(chip('Recorded example', 'muted'));
    body.append(el('tr', {},
      el('td', { className: 'mono dim', text: clock(s.startedAt ?? s.seenAt) }),
      el('td', { className: `phase status-${s.status}`, text: agentPhaseName(s.phase) }),
      message, el('td', {}, model)));
  }
  box.replaceChildren(table);
}

function renderCalls(): void {
  const box = $('calls');
  box.replaceChildren();
  if (!calls) return;
  const by = new Map<string, { n: number; ms: number; fixture: number }>();
  for (const c of calls.calls as CallRecord[]) {
    const m = by.get(c.model) ?? { n: 0, ms: 0, fixture: 0 };
    m.n++;
    m.ms += c.latencyMs;
    if (c.source === 'fixture') m.fixture++;
    by.set(c.model, m);
  }
  for (const [model, m] of by) box.append(chip(`${model} ×${m.n} · ${secs(m.ms / m.n)} avg${m.fixture ? ` · ${m.fixture} fixture` : ''}`, model === 'fixture' ? 'muted' : 'model'));
  const t = calls.totals;
  $('calls-total').textContent = t.calls ? `${t.calls} model calls · ${Math.round((t.promptTokens + t.completionTokens) / 100) / 10}k tokens${t.failures ? ` · ${t.failures} failed` : ''}` : '';
}

async function pollCalls(): Promise<void> {
  if (document.visibilityState === 'visible' && !serverDown) {
    try {
      calls = await api.calls();
      render('calls');
    } catch {
      // the server may be restarting
    }
  }
  setTimeout(() => void pollCalls(), 4000);
}

// --- evidence -------------------------------------------------------------------------------

function checkPills(progress: CheckProgress): HTMLElement {
  return el('div', { className: 'step-pills' }, ...buildCheckSteps(progress).map(({ label, state }) => {
    const pill = el('span', { className: `step-pill ${state}`, text: label });
    pill.setAttribute('aria-label', `${label}: ${state}`);
    pill.title = `${label}: ${state}`;
    return pill;
  }));
}

function evidenceSpark(e: VerifyResultPayload): SVGSVGElement | undefined {
  if (e.observed.sense === 'audio' && oracle.levels.length) {
    const t0 = perfAt(e.sent.at);
    const vals = oracle.levels.filter((l) => l.at >= t0 - 1000 && l.at <= t0 + 2000).map((l) => l.db);
    if (vals.length > 4) return sparkline(vals, { w: 76, h: 26, mark: 1 / 3, minSpan: 12 });
  }
  const o = e.observed;
  return sparkline([o.before, o.before, o.after, o.after], { w: 76, h: 26, mark: 0.5, minSpan: Math.max(Math.abs(o.before) * 0.5, Math.abs(o.threshold)) });
}

function evidenceRow(title: string, e: VerifyResultPayload | undefined, progress: CheckProgress, waitingText: string, key: string): HTMLElement {
  const row = el('div', { className: 'ev' });
  row.append(el('span', { className: 'control-name', text: title }));
  const sentence = e ? evidenceSentence(e) : undefined;
  row.append(chip(sentence?.verdict ?? waitingText, sentence ? sentence.pass ? 'ok' : 'fail' : 'muted'));
  row.append(checkPills({ ...progress, ...(e ? { sent: true, observation: { sense: e.observed.sense, pass: e.pass } } : {}) }));
  const drawer = el('details', { className: 'evidence-drawer', data: { check: key } });
  drawer.append(el('summary', { text: 'View check details' }));
  const content = el('div', { className: 'sentence' });
  if (e && sentence) {
    const extra = [e.attempt > 1 ? `Attempt ${e.attempt}` : '', e.note ?? ''].filter(Boolean).join(' · ');
    content.append(el('span', { className: 'text', text: companionText(`${sentence.text}${extra ? ` · ${extra}` : ''}`) }));
    const spark = evidenceSpark(e);
    if (spark) content.append(spark);
    content.title = `${e.observed.metric}: before ${e.observed.before.toFixed(3)} → after ${e.observed.after.toFixed(3)} (Δ ${e.observed.delta.toFixed(3)}, threshold ${e.observed.threshold})`;
  } else content.append(el('span', { className: 'text', text: waitingText }));
  drawer.append(content);
  row.append(drawer);
  return row;
}

function renderEvidence(): void {
  const box = $('evidence');
  const expanded = new Set([...box.querySelectorAll<HTMLDetailsElement>('details')].filter((d) => d.open).map((d) => d.dataset.check));
  const rows: HTMLElement[] = [];
  const drv = focusDriver();
  const selectedEvidence = evidence.filter((e) => {
    if (focusCardId && e.cardId && e.cardId !== focusCardId) return false;
    if (e.driverId && drv && e.driverId !== drv.driverId) return false;
    return !focusCardId || e.cardId === focusCardId || Boolean(drv && e.driverId === drv.driverId);
  });
  for (const r of refusals.filter((r) => !focusCardId || r.cardId === focusCardId)) {
    rows.push(el('div', { className: 'ev refused' },
      el('span', { className: 'control-name', text: cards.get(r.cardId)?.name ?? 'Connection' }),
      chip('Wrong device · Not connected', 'fail'),
      el('div', { className: 'sentence', text: r.reason ?? r.evidence.map((x) => `${x.ok ? '✓' : '✗'} ${x.detail}`).join(' · ') })));
  }
  const known = new Set<string>();
  if (drv) {
    const st = driverStatus.get(drv.driverId);
    for (const action of drv.actions) {
      known.add(action.actionId);
      let result = selectedEvidence.filter((e) => e.actionId === action.actionId).at(-1);
      // A driver is published only after validation; failed verification does not undo that check.
      const verified = st?.actions?.find((a) => a.actionId === action.actionId)?.verified ?? action.verified;
      const sent = executor.tape.filter((t) => t.actionId === action.actionId && (t.driverId === drv.driverId || !t.driverId && t.cardId === drv.cardId)).at(-1);
      if (result && sent && sent.execId !== result.execId && sent.at >= result.sent.at) result = undefined;
      const summary = !result && !sent && (verified === 'pass' || verified === 'fail')
        ? { sense: action.expect?.sense ?? 'none' as const, pass: verified === 'pass' } : undefined;
      const waiting = sent?.ack?.ok === false ? 'Send failed' : sent ? sent.ack ? 'Waiting for a physical check' : 'Sending' : verified === 'fail' ? 'Check failed' : verified === 'pass' ? 'Checked' : 'Waiting for a physical check';
      rows.push(evidenceRow(controlNameFor(action.actionId) ?? action.label, result,
        { generated: true, checked: true, sent: Boolean(result || sent?.ack?.ok), sense: action.expect?.sense, sendFailed: sent?.ack?.ok === false || result?.observed.metric === 'ack' && result.observed.after < 1, ...(summary ? { observation: summary } : {}) }, waiting, `${drv.driverId}:${action.actionId}`));
    }
  }
  for (const result of selectedEvidence.filter((e) => !known.has(e.actionId)).slice(-6)) {
    rows.push(evidenceRow(result.expected.effect === 'none' ? 'Negative control' : opSummary(result.sent.op), result,
      { generated: true, checked: true, sent: true }, '', `${result.driverId ?? result.cardId}:${result.actionId}`));
  }
  box.replaceChildren(...(rows.length ? rows : [el('p', { className: 'empty', text: 'Each action will show what was generated, checked, sent, and observed.' })]));
  for (const drawer of box.querySelectorAll<HTMLDetailsElement>('details')) drawer.open = expanded.has(drawer.dataset.check);
}

// --- learn (IR captures) --------------------------------------------------------------------

function captureVerdict(us: readonly number[]): VerifyResultPayload | undefined {
  return evidence.filter((e) => e.sent.op.kind === 'ir' && e.sent.op.rawUs && e.sent.op.rawUs.length === us.length && e.sent.op.rawUs.slice(0, 8).every((x, i) => Math.abs(x - us[i]) <= Math.max(60, us[i] * 0.15))).at(-1);
}

function renderLearn(): void {
  const panel = $('learn-panel');
  const show = link.ready || bridge.learned.length > 0;
  panel.hidden = !show;
  if (!show) return;
  const actions = $('learn-actions');
  actions.replaceChildren();
  if (bridge.learning) {
    actions.append(chip(`listening · ${Math.max(0, Math.round((bridge.learning.until - Date.now()) / 1000))} s`, 'accent'), button('Stop', () => bridge.stopLearning()));
  } else if (link.ready && executor.leader) {
    actions.append(button('Learn 15 s', () => void bridge.startLearning(15_000)));
  }
  const box = $('learn');
  box.replaceChildren();
  if (!bridge.learned.length) {
    box.append(el('div', { className: 'empty', text: 'Point your remote at the Cardputer and press a button. Each capture appears here; replay it to check the connection.' }));
    return;
  }
  for (const r of bridge.learned.slice(-12).reverse()) {
    const v = captureVerdict(r.capture.rawUs);
    const row = el('div', { className: 'ev' });
    row.append(el('span', { className: 'control-name', text: `#${r.n}${r.prompt ? ` · ${r.prompt}` : ''}` }));
    row.append(v ? chip(evidenceSentence(v).pass ? `seen: ${evidenceSentence(v).text.split('→').pop()?.trim() ?? ''} ✓` : 'no change ✗', evidenceSentence(v).pass ? 'ok' : 'fail') : chip('not replayed', 'muted'));
    const line = el('div', { className: 'sentence' }, pulseTrain(r.capture.rawUs), el('span', { className: 'text', text: `${r.label} · ${r.capture.rawUs.length} timings · ${r.capture.frames ?? 1} frame${(r.capture.frames ?? 1) === 1 ? '' : 's'}` }));
    if (link.ready && executor.leader) {
      line.append(
        button('Replay', async () => {
          const ack = await bridge.exec({ execId: `local-${Date.now()}`, executorDeviceId: bridge.deviceId ?? 'local', op: { kind: 'ir', protocol: r.capture.protocol && r.capture.protocol !== 'UNKNOWN' ? r.capture.protocol : 'RAW', rawUs: r.capture.rawUs.map((x) => Math.min(65_000, x)), khz: r.capture.khz ?? 38 } });
          log(ack.ok ? 'info' : 'warn', `replay #${r.n}: ${ack.ok ? 'sent' : ack.error} ${ack.detail ?? ''}`);
        }, 'ghost'),
      );
    }
    row.append(line);
    box.append(row);
  }
}

// --- links ------------------------------------------------------------------------------------

function linkRow(glyph: string, name: string | Node, state: Node | string, proof?: string | Node, proven = false, actions: Node[] = []): HTMLElement {
  const head = el('span', { className: 'name' }, name, ' · ', typeof state === 'string' ? el('span', { className: 'state', text: companionText(state) }) : state);
  const li = el('div', { className: 'li' }, el('span', { className: 'glyph', text: glyph }), head, el('span', { className: 'row acts' }, ...actions));
  if (proof) li.append(el('div', { className: `proof ${proven ? 'proven' : ''}` }, proof));
  return li;
}

function renderLinks(): void {
  const box = $('links');
  box.replaceChildren();
  const lead = executor.leader;

  // MIDI on this Mac
  if (!MidiBridge.supported) box.append(linkRow('▥', 'USB MIDI', 'needs Chrome or Edge on localhost'));
  else if (!midi.enabled) box.append(linkRow('▥', 'USB MIDI', 'off', 'Allow USB MIDI to connect devices to this Mac', false, lead ? [button('Allow USB MIDI', () => void enableMidi(), 'primary')] : []));
  else {
    const outs = midi.outputs();
    const lines = outs.length ? outs.map((o) => `${o.name ?? o.id}${o.manufacturer ? ` · ${o.manufacturer}` : ''} · out ${o.state === 'connected' ? '✓' : '✗'}`).join('\n') : 'waiting for USB… plug in a synth';
    const proof = el('span', { text: lines });
    proof.style.whiteSpace = 'pre-line';
    box.append(linkRow('▥', `USB MIDI${midi.sysex ? ' + SysEx' : ''}`, `${outs.length} out · ${midi.inputs().length} in · ${midiExec.scheduler.rate()} msg/s`, proof, outs.length > 0));
  }

  // Cardputer over Web Serial
  const cpName = link.info ? `${link.info.board === 'cardputer-adv' ? 'Cardputer-Adv' : (link.info.name ?? 'Cardputer')}` : 'Cardputer';
  if (!CardputerLink.supported) box.append(linkRow('⌁', cpName, 'Web Serial needs Chrome or Edge'));
  else {
    const acts: Node[] = [];
    let state = '';
    let proof = '';
    switch (link.state) {
      case 'idle':
      case 'disconnected':
      case 'error':
        state = link.state === 'idle' ? 'not connected' : link.state === 'error' ? 'error' : 'unplugged';
        proof = link.lastError ?? 'Plug in via USB-C, then choose Connect.';
        if (lead) acts.push(button('Connect', () => void connectCardputer(), 'primary'));
        break;
      case 'connecting':
        state = 'opening…';
        break;
      case 'no-reply':
        state = 'no reply';
        proof = 'the port is open but the firmware did not answer hello (flash ce-cardputer, or wait for boot)';
        if (lead) acts.push(button('Close', () => void link.close(), 'ghost'));
        break;
      case 'ready': {
        const b = bridge.state;
        state = b === 'online' ? 'linked' : b === 'pairing' ? `pairing · ${bridge.pairing?.display ?? ''}` : b === 'denied' ? 'not paired' : b === 'connecting' ? 'joining…' : b === 'offline' ? 'server offline' : 'ready';
        const i = link.info;
        proof = `${i?.fw ?? 'firmware ?'} · chip ${i?.chip ?? '?'} · ${i?.caps.join(', ') ?? ''}${bridge.deviceId ? ` · ${bridge.deviceId}` : ''}`;
        if (b === 'denied' && lead) acts.push(button('Pair again', () => void bridge.startPairing(), 'primary'));
        if (lead) {
          const tx = el('select', { title: 'IR emitter' });
          tx.append(Object.assign(el('option', { text: 'built-in LED' }), { value: 'led' }), Object.assign(el('option', { text: 'IR Unit (Grove)' }), { value: 'grove' }));
          tx.value = bridge.tx;
          tx.addEventListener('change', () => bridge.setTx(tx.value === 'grove' ? 'grove' : 'led'));
          acts.push(tx);
        }
        if (b === 'online' && lead) acts.push(button('Re-pair', () => void bridge.repair(), 'ghost'));
        if (lead) acts.push(button('Close', () => void link.close(), 'ghost'));
        break;
      }
      default:
        state = link.state;
    }
    box.append(linkRow('⌁', cpName, state, proof, link.ready && bridge.online, acts));
  }

  // audio oracle
  if (!AudioOracle.supported) box.append(linkRow('◉', 'Microphone', 'no microphone API here'));
  else if (oracle.state !== 'on') {
    box.append(linkRow('◉', 'Microphone', oracle.state === 'starting' ? 'starting…' : oracle.state === 'error' ? 'error' : 'off', oracle.error ?? 'listens to the synth’s own USB audio (or the Mac mic) to prove CCs change the sound', false, lead ? [button('Listen', () => void startOracle(), 'primary')] : []));
  } else {
    const meter = el('span', { className: 'meter' }, el('i', { data: { meter: '1' } }));
    const sel = el('select', { title: 'audio input' });
    void AudioOracle.inputs().then((ins) => {
      for (const i of ins) sel.append(Object.assign(el('option', { text: `${i.label}${i.synth ? ' (synth)' : ''}` }), { value: i.deviceId, selected: i.deviceId === oracle.input?.deviceId }));
    });
    sel.addEventListener('change', () => void startOracle(sel.value));
    box.append(linkRow('◉', 'Microphone', meter, el('span', {}, `${oracle.input?.synth ? 'synth USB audio' : 'microphone'} · ${oracle.input?.label ?? ''} · ${oracle.sampleRate / 1000} kHz `, sel), true, [button('Stop', () => void oracle.stop(), 'ghost')]));
  }

  // link verdicts from the agent
  for (const r of linkResults.values()) {
    const card = cards.get(r.cardId);
    const p = linkProof(r);
    box.append(linkRow(CHANNEL_GLYPH[r.channel ?? ''] ?? 'LNK', `${card?.name ?? r.cardId}`, chip(p.proven ? 'proven' : r.verdict === 'mismatch' ? 'refused' : 'hypothesis', p.proven ? 'ok' : r.verdict === 'mismatch' ? 'fail' : 'muted'), p.text, p.proven));
  }

  // other paired devices
  for (const d of devices) {
    if (d.deviceId === identity?.deviceId) continue;
    const acts: Node[] = [];
    if (canApprove && !replaying) {
      acts.push(
        button('Revoke', async () => {
          if (!confirm(`Revoke ${d.name}? It will have to pair again.`)) return;
          try {
            await api.revoke(d.deviceId, identity?.deviceToken);
            log('info', `revoked ${d.name}`);
          } catch (e) {
            log('error', `revoke failed: ${(e as Error).message}`);
          }
        }, 'ghost'),
      );
    }
    const caps = d.capabilities.length ? d.capabilities.join(', ') : 'no capabilities';
    box.append(linkRow(KIND_GLYPH[d.kind] ?? 'DEV', el('span', {}, el('span', { className: `dot ${d.online ? 'on' : ''}` }), ` ${d.name}`), d.online ? d.role : 'offline', `${d.kind} · ${caps}${d.app ? ` · ${d.app}` : ''}${d.online ? '' : d.lastSeen ? ` · seen ${ago(d.lastSeen)}` : ''}`, d.online, acts));
  }
}

// --- approvals and add-a-device ---------------------------------------------------------------

function renderApprove(): void {
  const input = $('code-input') as HTMLInputElement;
  input.disabled = !canApprove || replaying;
  ($('code-form').querySelector('button') as HTMLButtonElement).disabled = !canApprove || replaying || pairingBusy;
  renderOnboarding();
  renderPairSheet();
  const tabs = $('add-tabs');
  tabs.replaceChildren();
  for (const t of ['phone', 'quest', 'devterm'] as const) {
    const b = button(t, () => {
      addTarget = t;
      render('approve');
    }, 'tab');
    b.setAttribute('aria-selected', String(t === addTarget));
    tabs.append(b);
  }
  const u = health?.urls;
  const httpsBase = u?.https;
  const httpBase = u?.http;
  const url = addTarget === 'phone' ? (httpsBase ? `${httpsBase}/` : undefined) : addTarget === 'quest' ? (httpsBase ? `${httpsBase}/quest/` : undefined) : httpBase ? `${httpBase.replace(/^http/, 'ws')}/ws` : undefined;
  $('add-url').textContent = url ?? 'no LAN address (is the server on Wi-Fi?)';
  $('add-hint').textContent =
    addTarget === 'phone'
      ? 'Scan with the phone camera (or the iPhone app). Accept the self-signed certificate once; the phone shows a code to approve here.'
      : addTarget === 'quest'
        ? 'Open this address in Quest Browser, then approve its pairing code here.'
        : 'Plain WebSocket for the DevTerm CLI and ESP32 clients on the LAN.';
  if (url && url !== qrShown) {
    qrShown = url;
    void renderQr($('add-qr'), url);
  }
}

async function approve(code: string, pairingId?: string): Promise<boolean> {
  if (replaying || !canApprove || pairingBusy) return false;
  pairingBusy = true;
  render('approve');
  try {
    const result = await api.approve(code, identity?.deviceToken, pairingId);
    removePending(result.pairingId);
    $('code-msg').textContent = 'Device paired.';
    $('code-msg').className = 'small ok-text';
    return true;
  } catch (e) {
    const message = e instanceof ApiError ? e.message : `Could not pair: ${(e as Error).message}`;
    $('code-msg').textContent = message;
    $('code-msg').className = 'small fail-text';
    if ($('pair-error')) $('pair-error').textContent = message;
    return false;
  } finally {
    pairingBusy = false;
    render('approve');
  }
}

async function deny(pairingId: string): Promise<void> {
  if (replaying || !canApprove || pairingBusy) return;
  pairingBusy = true;
  render('approve');
  try {
    await api.deny(pairingId, identity?.deviceToken);
    removePending(pairingId);
  } catch (e) {
    const message = `Could not deny: ${(e as Error).message}`;
    log('error', message);
    if ($('pair-error')) $('pair-error').textContent = message;
  } finally {
    pairingBusy = false;
    render('approve');
  }
}

function clearIntent(): void {
  intent = undefined;
  const url = new URL(location.href);
  url.searchParams.delete('approve');
  url.hash = '';
  history.replaceState(null, '', url.pathname + url.search);
}

// --- daemons ----------------------------------------------------------------------------------

function renderDaemons(): void {
  const daemons = [...specs.values()].flatMap((s) => (s.hackset?.daemons ?? []).map((d) => ({ d, device: s.hackset!.device.name })));
  $('daemons-panel').hidden = !daemons.length;
  const box = $('daemons');
  box.replaceChildren();
  for (const { d, device } of daemons) {
    box.append(
      el(
        'div',
        { className: 'ev' },
        el('span', { className: 'control-name accent-text', text: d.name }),
        chip(d.status ?? 'proposed', d.status === 'running' ? 'accent' : 'muted'),
        el('div', { className: 'sentence' }, el('span', { className: 'text', text: `${device} · ${d.trigger.source} → ${d.targets.map((t) => t.hack).join(', ')} · ≤ ${d.max_rate_hz} Hz${d.blurb ? ` · ${d.blurb}` : ''}` })),
      ),
    );
  }
}

// --- executors: MIDI, Cardputer, oracle ------------------------------------------------------

async function enableMidi(restore = false): Promise<void> {
  if (replaying || !executor.leader) return;
  try {
    $('midi-message').textContent = '';
    await midi.enable(restore);
    log('info', `Web MIDI on${midi.sysex ? ' with SysEx' : ' (no SysEx: identity checks off)'}`);
    conn?.resendHello();
  } catch (e) {
    log('warn', (e as Error).message);
    $('bridge-msg').textContent = (e as Error).message;
    $('midi-message').textContent = 'USB access was not enabled. Choose Allow USB MIDI and allow access in your browser.';
  }
  ['calm', 'links', 'device', 'banners'].forEach(render);
}

async function connectCardputer(): Promise<void> {
  if (replaying || !executor.leader) return;
  await link.choose();
}

async function startOracle(deviceId?: string): Promise<void> {
  if (replaying || !executor.leader) return;
  await oracle.start(deviceId);
  if (oracle.state === 'on') log('info', `audio oracle listening to ${oracle.input?.label} (${oracle.input?.synth ? 'synth USB audio' : 'microphone'}, ${oracle.sampleRate} Hz)`);
  else if (oracle.error) {
    log('warn', `audio oracle: ${oracle.error}`);
    $('bridge-msg').textContent = oracle.error;
  }
  conn?.resendHello();
}

function setupExecutors(): void {
  const ch = el('select', { title: 'channel' });
  for (let i = 1; i <= 16; i++) ch.append(Object.assign(el('option', { text: `ch ${i}` }), { value: String(i) }));
  const out = el('select', { title: 'output' });
  const fillOuts = () => {
    const keep = out.value;
    out.replaceChildren(...midi.outputs().map((o) => Object.assign(el('option', { text: o.name ?? o.id }), { value: o.id })));
    if (midi.outputs().some((o) => o.id === keep)) out.value = keep;
  };
  $('midi-test-row').append(
    out,
    ch,
    button('Test note', () => {
      if (!out.value || replaying || !executor.leader) return;
      try {
        midi.testNote(out.value, Number(ch.value));
        appendLine($('midi-monitor'), `${clock()} → ${out.selectedOptions[0]?.text ?? ''} test note C4 ch${ch.value}`, 'out');
      } catch (e) {
        log('error', (e as Error).message);
      }
    }),
    el('a', { className: 'small', text: 'MIDI spike ↗' }),
  );
  ($('midi-test-row').lastElementChild as HTMLAnchorElement).href = '?spike=midi';
  midi.onChange = () => {
    fillOuts();
    ['calm', 'links', 'device'].forEach(render);
    conn?.resendHello();
  };
  midi.onMessage = (m) => {
    if (isRealtimeNoise(m.data) && !($('midi-clock') as HTMLInputElement).checked) return;
    appendLine($('midi-monitor'), `${clock()} ← ${m.portName.slice(0, 16).padEnd(16)} ${toHex(m.data).padEnd(9)} ${describeMidi(m.data)}`, 'in');
  };
  midiExec.onTape = (e) => {
    if (e.dir === 'out') appendLine($('midi-monitor'), `${clock(e.at)} → ${e.port.slice(0, 16).padEnd(16)} ${toHex(e.bytes).padEnd(9)} ${describeMidi(e.bytes)}`, 'out');
  };
  executor.onTape = () => {
    render('tape');
    render('evidence');
    if (!tabChosenByUser && mainTab === 'code' && executor.tape.length && armedOnce) setTab('tape');
  };
  executor.onLeader = (leader) => {
    conn?.resendHello();
    log('info', leader ? 'this tab is the executor' : 'standby');
    renderAll();
    if (leader && !replaying) {
      link.listenForPlug();
      void takeDevices();
    }
  };

  link.onLine = (dir, text) => appendLine($('serial-monitor'), `${clock()} ${dir === 'out' ? '→' : '←'} ${text}`, dir);
  link.onState = (s) => {
    $('serial-state').textContent = s;
    if (s === 'ready' && executor.leader && !replaying) {
      log('info', `Cardputer ready: ${link.info?.fw ?? '?'} on ${link.info?.board ?? '?'} (chip ${link.info?.chip ?? '?'})`);
      void bridge.deviceReady();
    }
    if (s === 'disconnected' || s === 'idle') bridge.deviceGone();
    conn?.resendHello();
    ['calm', 'links', 'learn', 'banners', 'device'].forEach(render);
  };
  link.onMessage = (m) => {
    if (m.t === 'log') log(m.lvl === 'error' ? 'error' : m.lvl === 'warn' ? 'warn' : 'debug', `[cardputer] ${m.msg}`);
    if (executor.leader && !replaying) bridge.onDeviceMessage(m);
  };
  bridge.onChange = () => {
    conn?.resendHello();
    ['calm', 'links', 'learn', 'banners'].forEach(render);
  };
  oracle.onState = () => {
    ['calm', 'links', 'device', 'banners'].forEach(render);
    conn?.resendHello();
  };
  // Only the executing tab may reopen a serial port on a plug event.

}

let armedOnce = false;

/** Re-open what this Mac had granted before (no prompts): MIDI, the Cardputer port, the microphone. */
async function takeDevices(): Promise<void> {
  if (replaying || !executor.leader) return;
  if (MidiBridge.supported && !midi.enabled && (await MidiBridge.alreadyGranted())) await enableMidi(true);
  if (CardputerLink.supported && !link.hasPort) await link.reconnect();
  if (AudioOracle.supported && oracle.state === 'off') {
    try {
      const s = await navigator.permissions.query({ name: 'microphone' as PermissionName });
      if (s.state === 'granted') await startOracle();
    } catch {
      // permissions API without "microphone": wait for a click
    }
  }
}

function meterLoop(): void {
  const m = document.querySelector<HTMLElement>('[data-meter]');
  if (m && !$('drawer').hidden && oracle.state === 'on') {
    const db = oracle.levelDb();
    m.style.width = `${Math.max(0, Math.min(100, ((db + 70) / 70) * 100))}%`;
  }
  requestAnimationFrame(meterLoop);
}

// --- pairing this browser ---------------------------------------------------------------------

async function pairThisBrowser(): Promise<void> {
  if (selfPairing) return;
  selfPairing = true;
  showView('home', false);
  selfPairingError = false;
  const generation = ++selfPairGeneration;
  clearTimeout(pollTimer);
  conn?.stop();
  conn = undefined;
  canApprove = false;
  const screen = $('pairscreen');
  screen.hidden = false;
  $('workbench').hidden = false;
  $('self-retry').hidden = true;
  $('self-msg').textContent = 'Waiting for Quest 3 on your local network';
  $('self-msg').className = 'small waiting-status';
  $('self-qr').replaceChildren();
  $('self-code').textContent = 'Creating code…';
  $('self-expiry').textContent = '';
  render('calm');
  const resumed = loadPendingPairing();
  const me = resumed?.device ?? defaultDevice();
  // A new Mac joins the headset's existing room through an explicit owner approval.
  // An empty room retains the local bootstrap so the owner can pair their first headset.
  // Unknown room state (health not loaded yet, e.g. right after a revoke) must not fall back to self-approval.
  const requireApproval = pairNow || (health?.space?.pairedDevices ?? 1) > 0;
  try {
    const r = resumed?.request ?? await api.pairStart({ name: me.name, kind: me.kind, capabilities: hello().capabilities ?? [], ...(requireApproval ? { requireApproval } : {}) });
    if (generation !== selfPairGeneration) return;
    if (r.status === 'approved' && r.deviceId && r.deviceToken) {
      log('info', `paired instantly as the owner (${isLocalPage() ? 'localhost' : 'trusted'})`);
      adopt({ deviceId: r.deviceId, deviceToken: r.deviceToken, kind: me.kind, name: me.name });
      return;
    }
    $('self-code').textContent = r.display;
    savePendingPairing({ request: r, device: me });
    selfExpiresAt = r.expiresAt;
    $('self-expiry').textContent = untilText(r.expiresAt);
    await renderQr($('self-qr'), r.qr);
    log('info', `waiting for approval · code ${r.display}`);
    const poll = async () => {
      if (generation !== selfPairGeneration) return;
      try {
        const s = await api.pairStatus(r.pairingId, r.pollSecret);
        if (generation !== selfPairGeneration) return;
        if (s.status === 'approved' && s.deviceId && s.deviceToken) {
          pairedWithQuest = pairNow;
          adopt({ deviceId: s.deviceId, deviceToken: s.deviceToken, kind: me.kind, name: me.name });
          return;
        }
        if (s.status === 'expired') {
          clearPendingPairing();
          selfPairing = false;
          void pairThisBrowser();
          return;
        }
        if (s.status !== 'pending') {
          pairingFailed('Pairing was declined. Choose Try again when you are ready.');
          return;
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          clearPendingPairing();
          selfPairing = false;
          void pairThisBrowser();
          return;
        }
      }
      if (Date.now() >= r.expiresAt) {
        clearPendingPairing();
        selfPairing = false;
        void pairThisBrowser();
        return;
      }
      pollTimer = setTimeout(poll, 500);
    };
    pollTimer = setTimeout(poll, 500);
  } catch (e) {
    pairingFailed(`Could not start pairing: ${(e as Error).message}`);
    if (!(e instanceof ApiError) || e.status >= 500) pollTimer = setTimeout(() => void pairThisBrowser(), 1500);
  }
}

function pairingFailed(message: string): void {
  clearPendingPairing();
  selfPairing = false;
  selfPairingError = true;
  selfExpiresAt = 0;
  $('self-msg').textContent = message;
  $('self-msg').className = 'small fail-text';
  $('self-retry').hidden = false;
  $('self-qr').replaceChildren();
  $('self-code').textContent = 'No active code';
  $('self-expiry').textContent = '';
  render('calm');
  log('warn', message);
}

function adopt(id: Identity): void {
  clearPendingPairing();
  selfPairing = false;
  selfPairingError = false;
  identity = id;
  saveIdentity(id);
  selfExpiresAt = 0;
  if (pairNow) history.replaceState(null, '', location.pathname);
  $('pairscreen').hidden = true;
  $('workbench').hidden = false;
  connect();
}

// --- connection -----------------------------------------------------------------------------

function hello(): PayloadOf<'hello'> {
  const p: PayloadOf<'hello'> = { deviceToken: identity?.deviceToken ?? '-', app: APP, executor: executor.leader };
  // another app on this origin (e.g. the Quest page) may own the identity: then don't claim its role
  if (!identity || identity.kind === 'mac' || identity.kind === 'web') {
    p.role = 'companion';
    const caps: NonNullable<PayloadOf<'hello'>['capabilities']> = [];
    caps.push('midi');
    if (CardputerLink.supported) caps.push('serial');
    if (bridge.online) caps.push('ir');
    if (AudioOracle.supported) caps.push('mic');
    p.capabilities = caps;
    const ports: Port[] = [visualSynthPort, ...(midi.enabled ? midi.ports() : [])];
    if (bridge.online) ports.push({ id: `serial:${link.info?.chip ?? 'cardputer'}`, kind: 'serial', name: `Cardputer USB serial (${link.info?.board ?? 'cardputer'})`, state: 'connected' });
    p.ports = ports;
  }
  return p;
}

function connect(): void {
  conn?.stop();
  const c = new Connection(Connection.sameOrigin(), hello);
  conn = c;
  c.onState = (s, info) => {
    serverDown = s === 'closed';
    ['calm', 'top'].forEach(render);
    if (s === 'closed' && info?.code === CLOSE_UNAUTHORIZED) {
      log('warn', 'This browser is no longer paired (revoked or unknown token); pairing again.');
      clearIdentity();
      identity = undefined;
      pairedWithQuest = false;
      void pairThisBrowser();
    }
  };
  c.onInvalid = (error) => log('warn', `ignored a message from the server: ${error}`);
  c.on('welcome', (m) => {
    welcome = m.payload;
    canApprove = m.payload.canApprove;
    pending.clear();
    log('info', `connected as ${m.payload.name} (${m.payload.kind}, ${m.payload.deviceId}) · ${m.payload.server} · ${m.payload.mode}`);
    ['calm', 'top', 'approve', 'banners', 'links'].forEach(render);
    if (!replaying && canApprove) void api.pending(identity?.deviceToken).then((r) => {
      // A snapshot can finish after a live approval or denial. Do not restore a settled request.
      for (const p of r.pending) if (!settledPairings.has(p.pairingId)) pending.set(p.pairingId, p);
      render('approve');
    }).catch(() => {});
  });
  c.on('presence', (m) => {
    devices = m.payload.devices;
    ['calm', 'links'].forEach(render);
  });
  c.on('pair.pending', (m) => {
    if (settledPairings.has(m.payload.pairingId)) return;
    pending.set(m.payload.pairingId, m.payload);
    log('info', `${m.payload.name} (${m.payload.kind}) wants to join · ${m.payload.display}`);
    ['approve', 'banners'].forEach(render);
  });
  c.on('pair.approved', (m) => {
    removePending(m.payload.pairingId);
    log('info', `paired ${m.payload.name} (${m.payload.kind})${m.payload.approvedBy ? ` · approved by ${m.payload.approvedBy}` : ''}`);
    render('approve');
  });
  c.on('pair.denied', (m) => {
    removePending(m.payload.pairingId);
    log('info', `pairing request ${m.payload.reason}`);
    render('approve');
  });
  c.on('log', (m) => log(m.payload.level, `${m.payload.code ? `[${m.payload.code}] ` : ''}${m.payload.message}`));
  c.on('agent.step', (m) => {
    const prev = steps.get(m.payload.stepId);
    steps.set(m.payload.stepId, { ...m.payload, seenAt: prev?.seenAt ?? Date.now() });
    if (steps.size > 300) steps.delete(steps.keys().next().value!);
    setFocus(m.payload.cardId);
    ['agent', 'code', 'top'].forEach(render);
  });
  c.on('device.card', (m) => {
    cards.set(m.payload.cardId, m.payload);
    setFocus(m.payload.cardId);
    ['calm', 'device', 'evidence', 'links', 'banners'].forEach(render);
  });
  c.on('target.status', (m) => {
    targets.delete(m.payload.cardId);
    targets.set(m.payload.cardId, m.payload);
    render('calm');
  });
  c.on('tags.state', (m) => {
    const tagged = new Set(m.payload.tags.map((tag) => tag.cardId));
    for (const cardId of targets.keys()) if (!tagged.has(cardId)) targets.delete(cardId);
    render('calm');
  });
  c.on('driver.spec', (m) => {
    drivers.set(m.payload.driverId, m.payload);
    setFocus(m.payload.cardId);
    if (!tabChosenByUser) setTab('code');
    ['code', 'device', 'evidence'].forEach(render);
  });
  c.on('driver.status', (m) => {
    driverStatus.set(m.payload.driverId, m.payload);
    render('evidence');
  });
  c.on('verify.result', (m) => {
    evidence.push(m.payload);
    if (evidence.length > 100) evidence.shift();
    ['evidence', 'learn', 'tape'].forEach(render);
  });
  c.on('link.request', (m) => {
    linkRequests.set(m.payload.linkId, m.payload);
    setFocus(m.payload.cardId);
    ['calm', 'banners'].forEach(render);
  });
  c.on('link.result', (m) => {
    linkResults.set(m.payload.cardId, m.payload);
    if (m.payload.verdict === 'mismatch') {
      refusals.push(m.payload);
      if (refusals.length > 3) refusals.shift();
    }
    log(m.payload.verdict === 'mismatch' ? 'warn' : 'info', `link ${m.payload.verdict}: ${m.payload.reason ?? m.payload.evidence.map((e) => e.detail).join(' · ')}`);
    ['calm', 'links', 'evidence', 'device', 'banners'].forEach(render);
  });
  c.on('arm.request', (m) => {
    arm = m.payload;
    setFocus(m.payload.cardId);
    render('banners');
  });
  c.on('arm.result', (m) => {
    if (arm?.armId === m.payload.armId) arm = undefined;
    armNote = { text: m.payload.armed ? `${cards.get(m.payload.cardId)?.name ?? 'Device'} enabled${m.payload.by ? ` by ${m.payload.by}` : ''}` : (m.payload.reason ?? 'cancelled'), ok: m.payload.armed, at: Date.now() };
    if (m.payload.armed) {
      armedOnce = true;
      if (!tabChosenByUser) setTab('tape');
    }
    ['banners', 'calm'].forEach(render);
  });
  c.on('ui.spec', (m) => {
    const key = m.payload.cardId ?? m.payload.specId;
    specs.set(key, m.payload);
    lastSpec = m.payload;
    setFocus(m.payload.cardId);
    ['spec', 'daemons', 'evidence', 'device'].forEach(render);
  });
  if (!replaying) executor.attach(c);
  c.onAny((m) => {
    const next = presenter.update(m);
    if (next) { activity = next; render('calm'); }
  });
  if (!replaying) c.start();
  if (replaying && !replayStarted) {
    replayStarted = true;
    log('info', 'Demo: showing a recorded OP-1 Field run (display only)');
    runReplay(
      (m) => c.inject(m),
      () => log('info', 'Replay finished. Open Details to enable or cancel the example controls.'),
    );
  }
}

// --- boot -------------------------------------------------------------------------------------

function setupForms(): void {
  $('self-retry').addEventListener('click', () => void pairThisBrowser());
  $('log-clear').addEventListener('click', () => $('log').replaceChildren());
  $('code-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const input = $('code-input') as HTMLInputElement;
    if (replaying || !canApprove) return;
    if (!isValidCode(input.value)) {
      $('code-msg').textContent = 'Codes are 6 characters, like K7Q-4M2.';
      $('code-msg').className = 'small fail-text';
      return;
    }
    if (await approve(input.value)) input.value = '';
  });
  $<HTMLButtonElement>('panic').disabled = replaying;
  $('panic').addEventListener('click', () => {
    if (replaying) return;
    void executor.panicLocal('button');
    conn?.send('panic', { reason: 'Stop all button on the Mac' }, { to: 'server' });
  });
  const tabs = ['code', 'tape', 'spec'] as const;
  for (const [i, t] of tabs.entries()) {
    $(`tab-${t}`).addEventListener('click', () => setTab(t, true));
    $(`tab-${t}`).addEventListener('keydown', (e) => {
      const next = e.key === 'ArrowRight' ? (i + 1) % 3 : e.key === 'ArrowLeft' ? (i + 2) % 3 : e.key === 'Home' ? 0 : e.key === 'End' ? 2 : undefined;
      if (next === undefined) return;
      e.preventDefault();
      setTab(tabs[next], true);
      $(`tab-${tabs[next]}`).focus();
    });
  }
  setTab('code');
  setInterval(() => {
    if (selfExpiresAt) $('self-expiry').textContent = untilText(selfExpiresAt);
    for (const e of document.querySelectorAll<HTMLElement>('[data-expires]')) e.textContent = untilText(Number(e.dataset.expires));
    // honest running counters: seconds since a model call started
    for (const e of document.querySelectorAll<HTMLElement>('[data-since]')) e.textContent = `${e.dataset.prefix ?? ''}${secs(Date.now() - Number(e.dataset.since))}`;
    if (bridge.learning) { render('learn'); render('calm'); }
    let expired = false;
    for (const [id, p] of pending) if (p.expiresAt <= Date.now()) {
      removePending(id);
      expired = true;
    }
    if (expired) render('approve');
    if (arm && arm.expiresAt <= Date.now()) {
      arm = undefined;
      activity = { text: 'Approval expired: open Details', working: false };
      ['banners', 'calm'].forEach(render);
    }
  }, 1000);
}

async function reachServer(retryMs = 1000): Promise<void> {
  try {
    health = await api.health();
    serverDown = false;
  } catch {
    serverDown = true;
    log('warn', 'Cannot reach the server; retrying shortly.');
    renderAll();
    setTimeout(() => void reachServer(Math.min(30_000, retryMs * 2)), retryMs);
    return;
  }
  renderAll();
  if (!identity) await pairThisBrowser();
}

export async function bootWorkbench(): Promise<void> {
  $('workbench').hidden = false;
  document.title = `${PRODUCT_NAME} Companion`;
  $('product-name').textContent = PRODUCT_NAME;
  $('headset-qr').setAttribute('aria-label', `Open ${PRODUCT_NAME} in Quest Browser`);
  document.body.classList.toggle('stage', stage);
  if (replaying) {
    const tag = el('a', { className: 'cornertag', text: 'Demo · display only', title: 'A scripted run injected into this page; nothing is executed or sent. Click to leave.' });
    tag.href = location.pathname;
    document.body.append(tag);
  }
  setupCalm();
  setupForms();
  setupExecutors();
  renderAll();
  requestAnimationFrame(meterLoop);
  // a replay tab never executes, so it must not take the executor role from the real workbench
  if (!replaying) executor.claim();
  if (replaying) { connect(); return; }
  void pollCalls();
  if (identity) connect();
  if (pairNow && !identity) await Promise.all([pairThisBrowser(), reachServer()]);
  else await reachServer();
}
