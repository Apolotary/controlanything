import { demoAudioMaster, type ExecAckPayload, type ExecCommandPayload, type PayloadOf, type WireReadyPayload } from '@ce/protocol';
import type { Control, Gen3dSpec } from '@ce/gen3d';
import { createVisualSynth, VISUAL_SYNTH_PORT, VISUAL_SYNTH_PORT_ID, WaterAudio, type VisualSynthRenderer } from '@ce/vsynth';
import { MusicalSynth } from '@ce/vsynth/musical';
import { MUSICAL_SCALE, MUSICAL_SYNTH_NAME, MUSICAL_SYNTH_PORT_ID } from '@ce/vsynth/musical-manifest';
import { generatedMidiPacket } from '../../../companion/src/generatedMidi';
import { checkMidiOp } from '../../../companion/src/contracts';
import { api } from '../io/api';
import type { Identity, KeyValueStore } from '../io/identity';
import { WsClient, newId } from '../io/ws';
import { PairingFlow, type PairState } from '../pair/self';

export type Instrument = 'visual-synth' | 'musical-synth';
interface View {
  pairing(text: string): void;
  status(text: string, error?: boolean): void;
  wire(text: string): void;
  code(text: string): void;
  ready(p: WireReadyPayload | undefined): void;
  receipt(text: string): void;
  selected(ready: boolean): void;
}
/** Dedicated per-tab identities cannot supersede the user's Quest or Mac companion. */
function scopedStore(prefix: string): KeyValueStore {
  const memory = new Map<string, string>();
  return {
    getItem(key) { try { return sessionStorage.getItem(`${prefix}.${key}`) ?? memory.get(key) ?? null; } catch { return memory.get(key) ?? null; } },
    setItem(key, value) { memory.set(key, value); try { sessionStorage.setItem(`${prefix}.${key}`, value); } catch { /* private browser */ } },
    removeItem(key) { memory.delete(key); try { sessionStorage.removeItem(`${prefix}.${key}`); } catch { /* private browser */ } },
  };
}

export class ReviewerConnection {
  private identity?: Identity;
  private executorIdentity?: Identity;
  private controller?: WsClient;
  private executor?: WsClient;
  private selectedCard?: string;
  private selection?: string;
  private requestId?: string;
  private wiringId?: string;
  private accepted?: WireReadyPayload;
  private connecting = false;
  private lifecycle = 0;
  private disposed = false;
  private code = '';
  private visual?: VisualSynthRenderer;
  readonly musical = new MusicalSynth({ changed: () => this.announce() });
  private readonly water = new WaterAudio();
  private instrument: Instrument = 'visual-synth';
  private outputs = 0;
  private received = 0;
  private readonly commands = new Map<string, Promise<ExecAckPayload>>();
  private readonly controlPair = new PairingFlow({ name: 'Camera demo controls', capabilities: ['display', 'camera'], store: scopedStore('ce.reviewer.controls') });
  private readonly synthPair = new PairingFlow({ name: 'Camera demo software instrument', capabilities: ['display', 'midi'], store: scopedStore('ce.reviewer.synth'),
    api: { ...api, pairStart: async req => {
      const epoch = this.lifecycle;
      const pair = await api.pairStart({ ...req, kind: 'web' });
      // The already approved controller authorizes only this same-page software
      // executor. A new reviewer still needs the owner's first code approval.
      if (this.current(epoch) && pair.status === 'pending' && this.identity) await api.approve(pair.code, this.identity.deviceToken, pair.pairingId);
      return pair;
    } } });
  constructor(private readonly canvas: HTMLCanvasElement, private readonly view: View) {
    this.controlPair.on('state', state => this.pairState('controls', state));
    this.synthPair.on('state', state => this.pairState('software instrument', state));
    demoAudioMaster.registerOutput(volume => { this.musical.setMasterVolume(volume); this.water.setVolume(volume); });
    demoAudioMaster.onUnlock(() => { void this.water.unlock().catch(() => {}); });
  }
  get token(): string | undefined { return this.identity?.deviceToken; }
  get connected(): boolean { return !!this.controller?.open && !!this.executor?.open; }
  private pairState(which: string, s: PairState): void {
    if (s.kind === 'pending') this.view.pairing(`Approve camera demo ${which} on the Mac companion: ${s.display}. This permission is separate from your headset.`);
    else if (s.kind === 'offline' || s.kind === 'denied') this.view.pairing(s.message);
    else if (s.kind === 'paired') this.view.pairing('');
  }
  /** Buddy pairing alone never selects a synth or changes the room mode. */
  private current(epoch: number): boolean { return !this.disposed && !document.hidden && epoch === this.lifecycle; }
  private assertCurrent(epoch: number): void { if (!this.current(epoch)) throw new Error('Camera demo action cancelled'); }
  async pairBuddy(): Promise<void> {
    const epoch = this.lifecycle; this.assertCurrent(epoch);
    if (!this.identity) { const identity = await this.controlPair.ensure(); this.assertCurrent(epoch); this.identity = identity; }
  }
  /** Called only by Connect demo / explicit instrument selection, never on page load. */
  async connect(instrument: Instrument): Promise<void> {
    if (this.connecting || this.disposed || document.hidden) return;
    const epoch = ++this.lifecycle; this.controlPair.cancel(); this.synthPair.cancel();
    this.connecting = true; this.stop('Reconnecting demo'); this.selectedCard = undefined; this.selection = undefined; this.view.selected(false); this.instrument = instrument;
    try {
      this.view.status('Connecting this camera demo and its software instrument…');
      if (!this.visual) this.visual = createVisualSynth(this.canvas);
      this.canvas.hidden = instrument !== 'visual-synth'; this.water.setActive(instrument === 'visual-synth');
      if (instrument === 'musical-synth') { await this.musical.unlock(); this.assertCurrent(epoch); }
      if (!this.identity) { const identity = await this.controlPair.ensure(); this.assertCurrent(epoch); this.identity = identity; }
      if (!this.executorIdentity) { const identity = await this.synthPair.ensure(); this.assertCurrent(epoch); this.executorIdentity = identity; }
      this.assertCurrent(epoch);
      if (!this.controller) this.createSockets();
      await this.open(this.executor!); this.assertCurrent(epoch); await this.open(this.controller!); this.assertCurrent(epoch);
      await this.publishPorts(); this.assertCurrent(epoch); this.view.status('Connected to your server. Ask Muse before using controls.');
      this.select();
    } catch (e) {
      if (!this.current(epoch)) return;
      this.view.status(`Could not connect: ${(e as Error).message}. Choose Connect demo to retry.`, true);
      this.view.selected(false);
    } finally { if (this.lifecycle === epoch) this.connecting = false; }
  }
  private createSockets(): void {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    this.controller = new WsClient(url, () => ({ deviceToken: this.identity!.deviceToken, role: 'hmd', capabilities: ['display', 'camera'], app: 'reviewer@1', foreground: !document.hidden }));
    this.executor = new WsClient(url, () => this.executorHello());
    for (const socket of [this.controller, this.executor]) {
      socket.onUnauthorized = () => {
        this.stop('Pairing revoked'); this.view.status('Pairing was revoked. Reload this page to connect again.', true);
      };
      socket.onState = state => {
        if (state === 'closed') { this.invalidate('Server disconnected. Reconnect, then ask Muse again.'); this.musical.lock(); }
      };
    }
    this.executor.on('exec.command', m => {
      if (m.from !== 'server' || m.to !== this.executorIdentity?.deviceId) return;
      const command = m.payload as ExecCommandPayload;
      if (command.executorDeviceId !== this.executorIdentity?.deviceId) return;
      let answer = this.commands.get(command.execId);
      if (!answer) {
        answer = this.execute(command); this.commands.set(command.execId, answer);
        if (this.commands.size > 80) this.commands.delete(this.commands.keys().next().value!);
      }
      void answer.then(ack => this.executor?.send('exec.ack', ack, { to: 'server' }));
    });
    this.executor.on('panic', () => { this.musical.lock(); this.visual?.reset(); this.invalidate('Stopped. Connect and ask Muse again.'); });
    this.controller.on('audio.master', m => demoAudioMaster.receive(m.payload as PayloadOf<'audio.master'>));
    demoAudioMaster.bind(state => { this.controller?.send('audio.master', state, { to: 'server' }); });
    this.controller.on('target.select.result', m => {
      const p = m.payload as PayloadOf<'target.select.result'>;
      if (this.disposed || document.hidden || p.requestId !== this.selection) return;
      if (!p.ok || !p.cardId) { this.view.status(p.reason ?? 'Could not select the software instrument.', true); this.view.selected(false); return; }
      this.selectedCard = p.cardId; this.view.selected(true); this.view.status('Software instrument selected. Tell Muse what to build.');
    });
    this.controller.on('wire.progress', m => {
      const p = m.payload as PayloadOf<'wire.progress'>;
      if (!this.requestId || p.requestId !== this.requestId || p.cardId !== this.selectedCard) return;
      this.wiringId = p.wiringId;
      if (p.code !== undefined) this.code = p.code; else if (p.codeDelta) this.code += p.codeDelta;
      this.view.code(this.code);
      this.view.wire(`${p.source === 'fixture' ? 'FIXTURE · ' : ''}${p.note ?? p.phase}${p.issues?.length ? ` · ${p.issues[0]}` : ''}`);
      if (p.phase === 'failed') { this.accepted = undefined; this.view.ready(undefined); this.view.selected(true); }
    });
    this.controller.on('wire.ready', m => {
      const p = m.payload as WireReadyPayload;
      if (!this.requestId || p.requestId !== this.requestId || p.cardId !== this.selectedCard) return;
      this.wiringId = p.wiringId; this.accepted = p; this.view.ready(p); this.view.selected(true);
      this.view.wire(`${p.source === 'fixture' ? 'FIXTURE · no live model call · ' : p.model + ' · '}${p.title} · ready for touch`);
      this.view.code(this.code || p.code);
    });
    this.controller.on('wire.stopped', m => {
      const p = m.payload as PayloadOf<'wire.stopped'>;
      if (p.requestId === this.requestId && p.cardId === this.selectedCard) this.invalidate('Stopped. Ask Muse again when you are ready.');
    });
    this.controller.on('control.result', m => {
      const p = m.payload as PayloadOf<'control.result'>;
      if (!p.ok) this.view.receipt(`Control was not applied: ${p.detail ?? 'the server refused it'}`);
    });
    this.controller.on('session.superseded', () => { this.stop('Another demo tab took over'); this.controller?.stop(); this.view.status('Another camera demo tab took over. Close it and reconnect here.', true); });
    this.controller.on('log', m => {
      const p = m.payload as { level: string; message: string };
      if (p.level === 'error') this.view.status(p.message, true);
    });
  }
  private executorHello(): PayloadOf<'hello'> {
    return { deviceToken: this.executorIdentity?.deviceToken ?? '-', role: 'companion', capabilities: ['display', 'midi'], executor: true, app: 'reviewer-software@1', ports: [
      { id: VISUAL_SYNTH_PORT_ID, name: VISUAL_SYNTH_PORT, kind: 'midi-out', state: this.visual && this.instrument === 'visual-synth' && !this.canvas.hidden && !document.hidden ? 'connected' : 'disconnected', manufacturer: 'ControlAnything' },
      { id: MUSICAL_SYNTH_PORT_ID, name: MUSICAL_SYNTH_NAME, kind: 'midi-out', state: this.musical.enabled && this.instrument === 'musical-synth' && !document.hidden ? 'connected' : 'disconnected', manufacturer: 'ControlAnything' },
    ] };
  }
  private async open(socket: WsClient): Promise<void> {
    if (socket.open) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { remove(); reject(new Error('server handshake timed out')); }, 12_000);
      const remove = socket.on('welcome', () => { clearTimeout(timer); remove(); resolve(); }); socket.start();
    });
  }
  private async publishPorts(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { remove(); reject(new Error('instrument presence did not update')); }, 4000);
      const expected = this.executorHello().ports;
      const remove = this.executor!.on('presence', message => {
        const presence = message.payload as PayloadOf<'presence'>;
        const current = presence.devices.find(device => device.deviceId === this.executorIdentity?.deviceId);
        if (presence.deviceId !== this.executorIdentity?.deviceId || !expected?.every(port => current?.ports?.some(p => p.id === port.id && p.kind === port.kind && p.state === port.state))) return;
        clearTimeout(timer); remove(); resolve();
      });
      this.announce();
    });
  }
  announce(): void { if (!this.disposed && !document.hidden) this.executor?.send('hello', this.executorHello()); }
  private select(): void {
    if (this.disposed || document.hidden) return;
    this.selection = newId('reviewer-select'); this.view.selected(false);
    this.controller?.send('mode.set', { mode: 'control' }, { to: 'server' });
    this.controller?.send('target.select', { requestId: this.selection, virtual: this.instrument, deviceId: this.executorIdentity?.deviceId, position: { x: 0, y: 1, z: -.7 } }, { to: 'server' });
  }
  async choose(instrument: Instrument): Promise<void> {
    if (this.disposed || document.hidden) return;
    const epoch = ++this.lifecycle; this.connecting = false; this.controlPair.cancel(); this.synthPair.cancel();
    this.stop('Choosing another instrument'); this.selectedCard = undefined; this.selection = undefined; this.view.selected(false); this.instrument = instrument; this.water.setActive(instrument === 'visual-synth');
    if (this.connected) {
      try {
        if (instrument === 'musical-synth') { await this.musical.unlock(); this.assertCurrent(epoch); }
        await this.publishPorts(); this.assertCurrent(epoch); this.select();
      } catch (error) { if (this.current(epoch)) this.view.status((error as Error).message, true); }
    }
  }
  ask(text: string): void {
    if (!this.selectedCard || !this.connected || !text.trim()) return;
    this.stop('New request');
    this.requestId = newId('reviewer-wire'); this.wiringId = undefined; this.code = '';
    this.view.code('Muse is starting…'); this.view.selected(false); this.view.wire('Muse is writing and testing your requested connector…');
    this.controller!.send('wire.request', { cardId: this.selectedCard, requestId: this.requestId, text: text.trim().slice(0, 500), source: 'text' }, { to: 'server' });
  }
  control(actionId: string, value: number | boolean): void {
    const p = this.accepted;
    if (!p || document.hidden || !this.connected || !p.actions.some(a => a.actionId === actionId)) return;
    this.outputs++;
    this.controller!.send('control.event', { widgetId: `wire:${actionId}`, value, ts: Date.now(), phase: 'move', requestId: this.requestId, wiringId: p.wiringId }, { to: 'server' });
    this.view.receipt(`Sent ${actionId}: ${typeof value === 'number' ? Math.round(value * 100) / 100 : value} · waiting for connector receipt`);
  }
  stop(reason = 'Stopped by reviewer'): void {
    if (this.requestId && this.selectedCard) this.controller?.send('wire.stop', { cardId: this.selectedCard, requestId: this.requestId, ...(this.wiringId ? { wiringId: this.wiringId } : {}), reason }, { to: 'server' });
    this.water.stop(); this.requestId = undefined; this.wiringId = undefined; this.accepted = undefined; this.view.ready(undefined); this.view.selected(!!this.selectedCard && this.connected);
    if (this.musical.enabled) this.musical.receiveMidi([0xb0, 17, 0]);
  }
  private invalidate(message: string): void { this.requestId = undefined; this.accepted = undefined; this.wiringId = undefined; this.view.ready(undefined); this.view.selected(false); this.view.wire(message); }
  hidden(): void {
    this.lifecycle++; this.connecting = false; this.controlPair.cancel(); this.synthPair.cancel();
    this.stop('Camera demo hidden'); this.selectedCard = undefined; this.selection = undefined; this.view.selected(false);
    this.water.setActive(false); this.musical.lock(); this.controller?.stop(); this.executor?.stop();
  }
  render(time: number): void { if (!document.hidden && this.instrument === 'visual-synth') this.visual?.render(time); }
  private async execute(cmd: ExecCommandPayload): Promise<ExecAckPayload> {
    const ack = (ok: boolean, extra: Partial<ExecAckPayload> = {}): ExecAckPayload => ({ execId: cmd.execId, ok, sentAt: Date.now(), ...extra });
    if (!this.connected || document.hidden) return ack(false, { error: 'no_port', detail: 'The camera demo must stay visible.' });
    const portId = cmd.port === VISUAL_SYNTH_PORT ? VISUAL_SYNTH_PORT_ID : cmd.port === MUSICAL_SYNTH_NAME ? MUSICAL_SYNTH_PORT_ID : cmd.port;
    if (cmd.op.kind !== 'midi' || ![VISUAL_SYNTH_PORT_ID, MUSICAL_SYNTH_PORT_ID].includes(portId ?? '')) return ack(false, { error: 'refused', detail: 'This reviewer page only hosts its two browser software ports.' });
    const op = cmd.op, error = checkMidiOp(op);
    if (error || op.channel !== 1) return ack(false, { error: 'bad_args', detail: error ?? 'Software instruments use channel 1.' });
    const generated = generatedMidiPacket(cmd, portId!);
    if (generated && !generated.ok) return ack(false, { error: 'refused', detail: generated.error });
    if (cmd.dryRun) return ack(true, { detail: 'Dry run; no software state change.' });
    if (op.msg === 'panic') { this.musical.receiveMidi([0xb0, 17, 0]); this.visual?.reset(); return ack(true); }
    if (op.msg !== 'cc' && op.msg !== 'pc') return ack(false, { error: 'unsupported', detail: 'Use the declared software instrument CC/program capabilities.' });
    const bytes = generated?.ok ? generated.bytes : op.msg === 'cc' ? [0xb0, op.number!, Number(op.value)] : [0xc0, op.number!];
    const visual = portId === VISUAL_SYNTH_PORT_ID;
    if (visual && (this.instrument !== 'visual-synth' || this.canvas.hidden)) return ack(false, { error: 'no_port', detail: 'The visual renderer is not visible.' });
    if (!visual && this.instrument !== 'musical-synth') return ack(false, { error: 'no_port', detail: 'Choose Musical synth to enable this software port.' });
    if (visual ? !this.visual?.receiveMidi(bytes) : !this.musical.receiveMidi(bytes)) return ack(false, { error: 'bad_args', detail: 'That parameter is unavailable, or software audio needs a new Connect demo click.' });
    this.received++;
    if (visual) {
      this.water.receive(this.visual!.getState()); this.visual!.render(performance.now()); this.view.receipt(`Applied by visual renderer · ${op.msg === 'cc' ? 'CC' : 'program '}${op.number} → ${op.value ?? ''}`);
      return ack(true, { detail: 'Applied by the reviewer browser software renderer.', applied: { source: 'renderer', params: { ...this.visual!.getState() }, visible: true, frame: this.visual!.stats().frames, at: Date.now() } });
    }
    if (op.msg === 'cc' && [16, 17].includes(op.number!)) await new Promise(resolve => setTimeout(resolve, 70));
    const receipt = this.musical.receipt(); this.view.receipt(`Applied by software synth · ${op.msg === 'cc' ? 'CC' : 'program '}${op.number} → ${op.value ?? ''}`);
    return ack(true, { detail: 'Applied by reviewer Web Audio instrument; this is software graph evidence.', applied: { source: 'musical-synth', params: receipt.params, audio: receipt.audio, visible: true, frame: receipt.frame, at: receipt.at } });
  }
  snapshot() { return { connected: this.connected, selectedCard: this.selectedCard, requestId: this.requestId, wiringId: this.wiringId, outputs: this.outputs, received: this.received, visual: this.visual?.getState(), musical: this.musical.receipt() }; }
  dispose(): void { this.lifecycle++; this.disposed = true; this.connecting = false; this.controlPair.cancel(); this.synthPair.cancel(); this.stop('Camera demo closed'); this.selectedCard = undefined; this.selection = undefined; this.controller?.stop(); this.executor?.stop(); this.musical.dispose(); this.water.dispose(); this.visual?.dispose(); }
}

/** Touch alternatives follow Muse's generated actions, ranges and colors; no authored hand mapping. */
export function renderControls(container: HTMLElement, payload: WireReadyPayload | undefined, send: (action: string, value: number | boolean) => void): void {
  container.replaceChildren(); if (!payload) return;
  const ui = (payload as WireReadyPayload & { ui?: Gen3dSpec }).ui;
  const controls: Control[] = ui?.controls ?? (payload.controls ?? []).map(c => ({ id: c.id, label: c.label, kind: c.kind === 'button' ? 'trigger' as const : c.kind === 'toggle' ? 'toggle' as const : 'continuous' as const,
    range: { min: c.min ?? 0, max: c.max ?? 127 }, default: c.value, binding: { action: c.actionId } }));
  const partFor = (id: string) => ui?.parts.find(p => p.controlId === id);
  for (const c of controls) {
    const box = document.createElement('section'); box.className = 'generated-control';
    const label = document.createElement('label'); label.textContent = c.label; box.append(label);
    const readout = document.createElement('output'); label.append(readout);
    const range = c.range ?? { min: 0, max: 1 }, min = range.min, max = range.max, step = range.step ?? (max - min > 2 ? 1 : .01);
    const action = c.binding.action.replace(/^wire:/, '');
    const push = (v: number | boolean) => { readout.value = String(typeof v === 'number' ? Math.round(v * 100) / 100 : v ? 'On' : 'Off'); send(action, v); };
    if (c.accent) box.style.borderColor = c.accent + '66';
    if (c.kind === 'xy' && c.yBinding) {
      box.classList.add('xy'); const surface = document.createElement('div'); surface.className = 'xy-surface'; surface.setAttribute('aria-label', `${c.label}. Touch or drag to change X and Y. Arrow keys also work.`); surface.tabIndex = 0; surface.setAttribute('role', 'group');
      const dot = document.createElement('span'); dot.className = 'xy-dot'; dot.style.left = dot.style.top = '50%';
      const hint = document.createElement('span'); hint.className = 'xy-label'; hint.textContent = 'Touch anywhere · drag to explore'; surface.append(dot, hint);
      let x = .5, y = .5, last = 0;
      const update = () => { dot.style.left = `${x * 100}%`; dot.style.top = `${y * 100}%`; push(min + x * (max - min)); const yr = c.yRange ?? range; send(c.yBinding!.action.replace(/^wire:/, ''), yr.min + y * (yr.max - yr.min)); };
      const pointer = (e: PointerEvent) => { const r = surface.getBoundingClientRect(); x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)); update(); };
      surface.onpointerdown = e => { surface.setPointerCapture(e.pointerId); pointer(e); };
      surface.onpointermove = e => { if (surface.hasPointerCapture(e.pointerId) && performance.now() - last > 40) { last = performance.now(); pointer(e); } };
      surface.onpointerup = pointer;
      surface.onkeydown = e => { if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) return; e.preventDefault(); x = Math.max(0, Math.min(1, x + (e.key === 'ArrowLeft' ? -.05 : e.key === 'ArrowRight' ? .05 : 0))); y = Math.max(0, Math.min(1, y + (e.key === 'ArrowUp' ? -.05 : e.key === 'ArrowDown' ? .05 : 0))); update(); };
      box.append(surface);
    } else if (c.kind === 'stepped' && ['keys', 'pads'].includes(partFor(c.id)?.archetype ?? '')) {
      box.classList.add('keys'); const keys = document.createElement('div'); keys.className = 'keybed';
      const count = Math.min(16, Math.floor((max - min) / step) + 1);
      for (let i = 0; i < count; i++) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = c.stepLabels?.[i] ?? String(i + 1); button.setAttribute('aria-label', `${c.label} ${button.textContent}`);
        button.onclick = () => { push(min + i * step); button.classList.add('active'); setTimeout(() => button.classList.remove('active'), 180); }; keys.append(button);
      }
      box.append(keys);
    } else if (c.kind === 'trigger' || c.kind === 'toggle') {
      let on = false; const button = document.createElement('button'); button.type = 'button'; button.textContent = c.label; button.onclick = () => { on = !on; push(c.kind === 'toggle' ? on : 1); if (c.kind === 'toggle') button.setAttribute('aria-pressed', String(on)); }; box.append(button);
    } else {
      const input = document.createElement('input'); input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(typeof c.default === 'number' ? c.default : (min + max) / 2); input.setAttribute('aria-label', c.label);
      if (c.accent) input.style.accentColor = c.accent; readout.value = input.value; input.oninput = () => push(Number(input.value));
      const row = document.createElement('div'); row.className = 'control-stepper';
      for (const [title, amount] of [['−', -1], ['+', 1]] as const) { const button = document.createElement('button'); button.type = 'button'; button.textContent = title; button.setAttribute('aria-label', `${title === '+' ? 'Increase' : 'Decrease'} ${c.label}`); button.onclick = () => { input.value = String(Math.max(min, Math.min(max, Number(input.value) + amount * (max - min) / 10))); push(Number(input.value)); }; row.append(button); }
      box.append(input, row);
    }
    container.append(box);
  }
}
