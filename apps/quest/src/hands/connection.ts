/**
 * The webcam/phone page's link to the ControlAnything server, adapted from the reviewer page's connection
 * (reviewer/connection.ts): two separate paired identities on this tab.
 *   - a controller (role hmd, app "hands@1") that follows the Quest's protocol: Annotate scan frames (SAM 3.1),
 *     tag.add, a deliberate mode.set control, target.select, wire.request, control events and wire.stop;
 *   - a same-page software executor (role companion, app "hands-software@1") that hosts the two browser
 *     instruments (visual synth, musical synth) and applies the MIDI the Muse-written connector sends.
 * Muse writes the connector on the Mac and, for hand requests, a hand program. The program runs here in the same
 * sandboxed Worker the Quest uses (wiring/runtime.ts), fed with webcam Signals; its outputs go out as
 * control.event `wire:<action>` with the wiring id, like the Quest's.
 */
import { demoAudioMaster, type DeviceCardPayload, type DeviceInfo, type ExecAckPayload, type ExecCommandPayload, type PayloadOf, type ScanFramePayload, type ScanResultPayload, type TaggedDevice, type WireReadyPayload } from '@ce/protocol';
import { createVisualSynth, VISUAL_SYNTH_PORT, VISUAL_SYNTH_PORT_ID, WaterAudio, type VisualSynthParameters, type VisualSynthRenderer } from '@ce/vsynth';
import { MusicalSynth } from '@ce/vsynth/musical';
import { MUSICAL_SYNTH_NAME, MUSICAL_SYNTH_PORT_ID } from '@ce/vsynth/musical-manifest';
import { generatedMidiPacket } from '../../../companion/src/generatedMidi';
import { checkMidiOp } from '../../../companion/src/contracts';
import type { Signals } from '../gestures/signals';
import { api } from '../io/api';
import type { Identity, KeyValueStore } from '../io/identity';
import { WsClient, newId } from '../io/ws';
import { PairingFlow, type PairState } from '../pair/self';
import { WiringRuntime, type StopKind } from '../wiring/runtime';

export type Instrument = 'visual-synth' | 'musical-synth';
export const HANDS_EXECUTOR_APP = 'hands-software@1';

export interface HandsView {
  pairing(text: string): void;
  status(text: string, error?: boolean): void;
  wire(text: string, phase: 'idle' | 'working' | 'ready' | 'running' | 'failed' | 'stopped'): void;
  code(text: string): void;
  ready(p: WireReadyPayload | undefined): void;
  receipt(text: string): void;
  selected(ready: boolean): void;
  /** a value went out (a hand program output or a touch control) */
  output(actionId: string, value: number | boolean, from: 'program' | 'control'): void;
  /** the instrument applied a command */
  applied(instrument: Instrument, label: string): void;
  /** SAM 3.1 detections for a frame this page sent (Annotate) */
  scan?(result: ScanResultPayload): void;
  /** the server's tagged devices (the same list the Quest gets) */
  tags?(tags: TaggedDevice[]): void;
  /** an identified card (name, maker) for a tag */
  card?(card: DeviceCardPayload): void;
  /** the room's layer, as the server holds it */
  mode?(mode: 'annotate' | 'control'): void;
  /** paired devices online (for the Devices row) */
  presence?(devices: DeviceInfo[]): void;
}

/** Per-tab identities: this page can never supersede the user's Quest or Mac companion. */
function scopedStore(prefix: string): KeyValueStore {
  const memory = new Map<string, string>();
  return {
    getItem(key) { try { return sessionStorage.getItem(`${prefix}.${key}`) ?? memory.get(key) ?? null; } catch { return memory.get(key) ?? null; } },
    setItem(key, value) { memory.set(key, value); try { sessionStorage.setItem(`${prefix}.${key}`, value); } catch { /* private browser */ } },
    removeItem(key) { memory.delete(key); try { sessionStorage.removeItem(`${prefix}.${key}`); } catch { /* private browser */ } },
  };
}

export class HandsConnection {
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
  private codeText = '';
  private visual?: VisualSynthRenderer;
  readonly musical = new MusicalSynth({ changed: () => this.announce() });
  private readonly water = new WaterAudio();
  /** the page's own instrument while an explicit demo (More → Visual synth / Music) is selected */
  instrument: Instrument | undefined;
  private readonly sentFrames = new Set<string>();
  room: 'annotate' | 'control' = 'annotate';
  private outputs = 0;
  private received = 0;
  private programOutputs = 0;
  private readonly commands = new Map<string, Promise<ExecAckPayload>>();
  readonly runtime: WiringRuntime;
  private lastRuntimeStop = '';
  private readonly controlPair = new PairingFlow({ name: 'Webcam hand demo controls', capabilities: ['display', 'camera'], store: scopedStore('ce.hands.controls') });
  private readonly synthPair = new PairingFlow({ name: 'Webcam hand demo instruments', capabilities: ['display', 'midi'], store: scopedStore('ce.hands.synth'),
    api: { ...api, pairStart: async req => {
      const epoch = this.lifecycle;
      const pair = await api.pairStart({ ...req, kind: 'web' });
      // The already approved controller authorizes only this same-page software executor.
      if (this.current(epoch) && pair.status === 'pending' && this.identity) await api.approve(pair.code, this.identity.deviceToken, pair.pairingId);
      return pair;
    } } });

  constructor(readonly synthCanvas: HTMLCanvasElement, private readonly view: HandsView) {
    this.controlPair.on('state', state => this.pairState('controls', state));
    this.synthPair.on('state', state => this.pairState('instruments', state));
    demoAudioMaster.registerOutput(volume => { this.musical.setMasterVolume(volume); this.water.setVolume(volume); });
    demoAudioMaster.onUnlock(() => { void this.water.unlock().catch(() => {}); });
    this.runtime = new WiringRuntime({
      send: (event) => {
        const p = this.accepted;
        if (!p || !this.controller?.open || document.hidden) return false;
        const actionId = event.widgetId.replace(/^wire:/, '');
        this.programOutputs++;
        this.controller.send('control.event', { widgetId: event.widgetId, value: event.value, ts: Date.now(), phase: event.phase, requestId: this.requestId, wiringId: p.wiringId }, { to: 'server' });
        this.view.output(actionId, event.value, 'program');
        return true;
      },
      onStop: (reason, kind) => this.runtimeStopped(reason, kind),
    });
  }

  get token(): string | undefined { return this.identity?.deviceToken; }
  get connected(): boolean { return !!this.controller?.open && !!this.executor?.open; }
  get ready(): WireReadyPayload | undefined { return this.accepted; }
  get visualState(): VisualSynthParameters | undefined { return this.visual?.getState(); }
  get visualRenderer(): VisualSynthRenderer | undefined { return this.visual; }

  private pairState(which: string, s: PairState): void {
    if (s.kind === 'pending') this.view.pairing(`Approve the webcam hand demo ${which} on the Mac companion: ${s.display}. This permission is separate from your headset.`);
    else if (s.kind === 'offline' || s.kind === 'denied') this.view.pairing(s.message);
    else if (s.kind === 'paired') this.view.pairing('');
  }
  private current(epoch: number): boolean { return !this.disposed && !document.hidden && epoch === this.lifecycle; }
  private assertCurrent(epoch: number): void { if (!this.current(epoch)) throw new Error('cancelled'); }

  /** Only on an explicit Connect click (or choosing an instrument), never on page load. */
  /**
   * Called by Start AR (an explicit tap), never on page load. With `instrument`, also selects that explicit demo
   * (More → Visual synth / Music); without it the page just joins the room in Annotate, like the Quest.
   */
  async connect(instrument?: Instrument): Promise<void> {
    if (this.connecting || this.disposed || document.hidden) return;
    const epoch = ++this.lifecycle; this.controlPair.cancel(); this.synthPair.cancel();
    this.connecting = true; this.stop('Reconnecting'); this.selectedCard = undefined; this.selection = undefined; this.view.selected(false); this.instrument = instrument;
    try {
      this.view.status('Connecting this page to your ControlAnything server…');
      if (!this.visual) this.visual = createVisualSynth(this.synthCanvas);
      this.water.setActive(instrument === 'visual-synth');
      if (instrument === 'musical-synth') { await this.musical.unlock(); this.assertCurrent(epoch); }
      if (!this.identity) { const identity = await this.controlPair.ensure(); this.assertCurrent(epoch); this.identity = identity; }
      if (!this.executorIdentity) { const identity = await this.synthPair.ensure(); this.assertCurrent(epoch); this.executorIdentity = identity; }
      if (!this.controller) this.createSockets();
      await this.open(this.executor!); this.assertCurrent(epoch); await this.open(this.controller!); this.assertCurrent(epoch);
      await this.publishPorts(); this.assertCurrent(epoch);
      this.view.status('Connected.');
      if (instrument) this.select();
      else this.view.selected(false);
    } catch (e) {
      if (!this.current(epoch)) return;
      this.view.status(`Could not connect: ${(e as Error).message}. Choose Connect to retry.`, true);
      this.view.selected(false);
    } finally { if (this.lifecycle === epoch) this.connecting = false; }
  }

  private createSockets(): void {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    this.controller = new WsClient(url, () => ({ deviceToken: this.identity!.deviceToken, role: 'hmd', capabilities: ['display', 'camera'], app: 'hands@1', foreground: !document.hidden }));
    this.executor = new WsClient(url, () => this.executorHello());
    for (const socket of [this.controller, this.executor]) {
      socket.onUnauthorized = () => { this.stop('Pairing revoked'); this.view.status('Pairing was revoked. Reload this page to connect again.', true); };
      socket.onState = state => { if (state === 'closed') { this.invalidate('Server disconnected. Connect again, then ask Muse.'); this.musical.lock(); } };
    }
    this.executor.on('exec.command', m => {
      if (m.from !== 'server' || m.to !== this.executorIdentity?.deviceId) return;
      const command = m.payload as ExecCommandPayload;
      if (command.executorDeviceId !== this.executorIdentity?.deviceId) return;
      let answer = this.commands.get(command.execId);
      if (!answer) {
        answer = this.execute(command); this.commands.set(command.execId, answer);
        if (this.commands.size > 120) this.commands.delete(this.commands.keys().next().value!);
      }
      void answer.then(ack => this.executor?.send('exec.ack', ack, { to: 'server' }));
    });
    this.executor.on('panic', () => { this.musical.lock(); this.visual?.reset(); this.invalidate('Stopped. Connect and ask Muse again.'); });
    this.controller.on('audio.master', m => demoAudioMaster.receive(m.payload as PayloadOf<'audio.master'>));
    this.controller.on('scan.result', m => {
      const p = m.payload as ScanResultPayload;
      if (!this.sentFrames.has(p.frameId)) return;
      this.sentFrames.delete(p.frameId);
      this.view.scan?.(p);
    });
    this.controller.on('tags.state', m => this.view.tags?.((m.payload as PayloadOf<'tags.state'>).tags));
    this.controller.on('device.card', m => this.view.card?.(m.payload as DeviceCardPayload));
    this.controller.on('mode.state', m => { this.room = (m.payload as PayloadOf<'mode.state'>).mode as 'annotate' | 'control'; this.view.mode?.(this.room); });
    this.controller.on('presence', m => this.view.presence?.((m.payload as PayloadOf<'presence'>).devices));
    demoAudioMaster.bind(state => { this.controller?.send('audio.master', state, { to: 'server' }); });
    this.controller.on('target.select.result', m => {
      const p = m.payload as PayloadOf<'target.select.result'>;
      if (this.disposed || document.hidden || p.requestId !== this.selection) return;
      if (!p.ok || !p.cardId) { this.view.status(p.reason ?? 'Could not select the instrument.', true); this.view.selected(false); return; }
      this.selectedCard = p.cardId; this.view.selected(true);
      this.view.status(`${this.instrument === 'visual-synth' ? 'Visual synth' : 'Musical synth'} selected (an optional demo on this page). Ask Muse to wire your hands to it.`);
    });
    this.controller.on('wire.progress', m => {
      const p = m.payload as PayloadOf<'wire.progress'>;
      if (!this.requestId || p.requestId !== this.requestId || p.cardId !== this.selectedCard) return;
      this.wiringId = p.wiringId;
      if (p.code !== undefined) this.codeText = p.code; else if (p.codeDelta) this.codeText += p.codeDelta;
      this.view.code(this.codeText);
      const failed = p.phase === 'failed';
      this.view.wire(`${p.source === 'fixture' ? 'FIXTURE · ' : ''}${p.note ?? p.phase}${p.issues?.length ? ` · ${p.issues[0]}` : ''}`, failed ? 'failed' : 'working');
      if (failed) { this.accepted = undefined; this.view.ready(undefined); this.view.selected(true); }
    });
    this.controller.on('wire.ready', m => {
      const p = m.payload as WireReadyPayload;
      if (!this.requestId || p.requestId !== this.requestId || p.cardId !== this.selectedCard) return;
      if (this.accepted?.wiringId === p.wiringId) return;
      this.wiringId = p.wiringId; this.accepted = p; this.view.selected(true);
      this.view.code(this.codeText || p.code);
      const who = p.source === 'fixture' ? 'FIXTURE · no live model call' : p.source === 'template' ? 'Template · no model wrote this' : p.model;
      if (p.code.trim()) {
        const refusal = this.runtime.start({ wiringId: p.wiringId, requestId: this.requestId, cardId: p.cardId, code: p.code, title: p.title, explanation: p.explanation, model: p.model, source: p.source, actions: p.actions });
        if (refusal) { this.view.wire(`${who} · ${p.title} · the hand program could not start: ${refusal}`, 'failed'); this.view.ready(p); return; }
        this.view.wire(`${who} · ${p.title} · your hands are wired`, 'running');
      } else this.view.wire(`${who} · ${p.title} · controls only (no hand program): use Muse's controls`, 'ready');
      this.view.ready(p);
    });
    this.controller.on('wire.stopped', m => {
      const p = m.payload as PayloadOf<'wire.stopped'>;
      if (p.requestId === this.requestId && p.cardId === this.selectedCard) this.invalidate('Stopped. Ask Muse again when you are ready.');
    });
    this.controller.on('control.result', m => {
      const p = m.payload as PayloadOf<'control.result'>;
      if (!p.ok) this.view.receipt(`Not applied: ${p.detail ?? 'the server refused it'}`);
    });
    this.controller.on('session.superseded', () => { this.stop('Another tab took over'); this.controller?.stop(); this.view.status('Another hand demo tab took over. Close it and reconnect here.', true); });
    this.controller.on('log', m => {
      const p = m.payload as { level: string; message: string };
      if (p.level === 'error') this.view.status(p.message, true);
    });
  }

  private executorHello(): PayloadOf<'hello'> {
    const visible = !document.hidden;
    return { deviceToken: this.executorIdentity?.deviceToken ?? '-', role: 'companion', capabilities: ['display', 'midi'], executor: true, app: HANDS_EXECUTOR_APP, ports: [
      { id: VISUAL_SYNTH_PORT_ID, name: VISUAL_SYNTH_PORT, kind: 'midi-out', state: this.visual && this.instrument === 'visual-synth' && visible ? 'connected' : 'disconnected', manufacturer: 'ControlAnything' },
      { id: MUSICAL_SYNTH_PORT_ID, name: MUSICAL_SYNTH_NAME, kind: 'midi-out', state: this.musical.enabled && this.instrument === 'musical-synth' && visible ? 'connected' : 'disconnected', manufacturer: 'ControlAnything' },
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
    this.selection = newId('hands-select'); this.view.selected(false);
    this.controller?.send('mode.set', { mode: 'control' }, { to: 'server' });
    this.controller?.send('target.select', { requestId: this.selection, virtual: this.instrument, deviceId: this.executorIdentity?.deviceId, position: { x: 0, y: 1, z: -.7 } }, { to: 'server' });
  }

  get controllerSocket(): WsClient | undefined { return this.controller; }
  get selected(): string | undefined { return this.selectedCard; }

  /** Annotate: one camera frame to SAM 3.1 through the same server path as the Quest (scan.frame → scan.result). */
  scanFrame(frame: Omit<ScanFramePayload, 'purpose'>, filter: 'electronics' | 'objects' | 'everything'): boolean {
    if (!this.controller?.open || document.hidden) return false;
    const id = this.controller.send('scan.frame', { ...frame, purpose: 'scan', filter }, { to: 'server', droppable: true });
    if (!id) return false;
    this.sentFrames.add(frame.frameId);
    if (this.sentFrames.size > 12) this.sentFrames.delete(this.sentFrames.values().next().value!);
    return true;
  }

  /** The room's layer (Annotate / Control), like the Quest's wrist menu. */
  setMode(mode: 'annotate' | 'control'): void {
    this.room = mode;
    this.controller?.send('mode.set', { mode }, { to: 'server' });
  }

  /** Tag a SAM detection (Annotate). The tag id becomes the card id; the page stays in Annotate. */
  tag(det: { targetId: string; label: string; frameId?: string; detId?: string }): boolean {
    if (!this.controller?.open) return false;
    return !!this.controller.send('tag.add', { targetId: det.targetId, label: det.label.slice(0, 80), ...(det.frameId && det.detId ? { frameId: det.frameId, detId: det.detId } : {}) }, { to: 'server' });
  }
  untag(cardId: string): void { this.controller?.send('tag.remove', { cardId }, { to: 'server' }); }

  /** Control: select a tagged device (the Quest's pinch on a tagged box in Control). */
  selectCard(cardId: string): void {
    if (!this.controller?.open) return;
    if (this.selectedCard !== cardId) this.stop('Selected another device');
    if (this.instrument) { this.instrument = undefined; this.water.setActive(false); this.announce(); }
    this.selectedCard = cardId;
    this.controller.send('target.select', { cardId, requestId: newId('hands-select') }, { to: 'server' });
    this.view.selected(true);
  }
  deselect(): void { this.stop('Deselected'); this.selectedCard = undefined; this.view.selected(false); }

  async choose(instrument: Instrument): Promise<void> {
    if (this.disposed || document.hidden) return;
    const epoch = ++this.lifecycle; this.connecting = false; this.controlPair.cancel(); this.synthPair.cancel();
    this.stop('Choosing another instrument'); this.selectedCard = undefined; this.selection = undefined; this.view.selected(false);
    this.instrument = instrument; this.water.setActive(instrument === 'visual-synth');
    if (this.connected) {
      try {
        if (instrument === 'musical-synth') { await this.musical.unlock(); this.assertCurrent(epoch); }
        await this.publishPorts(); this.assertCurrent(epoch); this.select();
      } catch (error) { if (this.current(epoch)) this.view.status((error as Error).message, true); }
    }
  }

  /** Ask Muse. The user's words go to the server as they are. */
  ask(text: string, source: 'text' | 'chip' | 'voice' = 'text'): boolean {
    if (!this.selectedCard || !this.connected || !text.trim()) return false;
    this.stop('New request');
    this.requestId = newId('hands-wire'); this.wiringId = undefined; this.codeText = '';
    this.view.code('Muse is starting…'); this.view.selected(false); this.view.wire('Muse is writing and testing the glue…', 'working');
    this.controller!.send('wire.request', { cardId: this.selectedCard, requestId: this.requestId, text: text.trim().slice(0, 500), source }, { to: 'server' });
    return true;
  }

  /** Once per frame while a hand program runs. */
  tick(signals: Signals): void { if (this.runtime.ready && !document.hidden) this.runtime.tick(signals); }
  get programRunning(): boolean { return this.runtime.running; }

  /** A touch control Muse generated (the fallback when you'd rather not use hands). */
  control(actionId: string, value: number | boolean): void {
    const p = this.accepted;
    if (!p || document.hidden || !this.connected || !p.actions.some(a => a.actionId === actionId)) return;
    this.outputs++;
    this.controller!.send('control.event', { widgetId: `wire:${actionId}`, value, ts: Date.now(), phase: 'move', requestId: this.requestId, wiringId: p.wiringId }, { to: 'server' });
    this.view.output(actionId, value, 'control');
  }

  stop(reason = 'Stopped'): void {
    if (this.runtime.running) this.runtime.stop(reason, 'user', true);
    if (this.requestId && this.selectedCard) this.controller?.send('wire.stop', { cardId: this.selectedCard, requestId: this.requestId, ...(this.wiringId ? { wiringId: this.wiringId } : {}), reason }, { to: 'server' });
    this.water.stop(); this.requestId = undefined; this.wiringId = undefined; this.accepted = undefined; this.view.ready(undefined); this.view.selected(!!this.selectedCard && this.connected);
    if (this.musical.enabled) this.musical.receiveMidi([0xb0, 17, 0]);
  }
  private runtimeStopped(reason: string, kind: StopKind): void {
    this.lastRuntimeStop = reason;
    if (kind !== 'user' && kind !== 'external') this.view.wire(`The hand program stopped: ${reason}. Ask Muse again.`, 'failed');
  }
  private invalidate(message: string): void {
    if (this.runtime.running) this.runtime.stop(message, 'external', false);
    this.requestId = undefined; this.accepted = undefined; this.wiringId = undefined; this.view.ready(undefined); this.view.selected(false); this.view.wire(message, 'stopped');
  }
  hidden(): void {
    this.lifecycle++; this.connecting = false; this.controlPair.cancel(); this.synthPair.cancel();
    this.stop('Page hidden'); this.selectedCard = undefined; this.selection = undefined; this.view.selected(false);
    this.water.setActive(false); this.musical.lock(); this.controller?.stop(); this.executor?.stop();
  }
  render(time: number): void { if (!document.hidden && this.instrument === 'visual-synth') this.visual?.render(time); }
  /** Muse is writing for the current request (Stop Muse cancels it mid-generation). */
  get working(): boolean { return !!this.requestId && !this.accepted; }

  private async execute(cmd: ExecCommandPayload): Promise<ExecAckPayload> {
    const ack = (ok: boolean, extra: Partial<ExecAckPayload> = {}): ExecAckPayload => ({ execId: cmd.execId, ok, sentAt: Date.now(), ...extra });
    if (!this.connected || document.hidden) return ack(false, { error: 'no_port', detail: 'The hand demo page must stay visible.' });
    const portId = cmd.port === VISUAL_SYNTH_PORT ? VISUAL_SYNTH_PORT_ID : cmd.port === MUSICAL_SYNTH_NAME ? MUSICAL_SYNTH_PORT_ID : cmd.port;
    if (cmd.op.kind !== 'midi' || ![VISUAL_SYNTH_PORT_ID, MUSICAL_SYNTH_PORT_ID].includes(portId ?? '')) return ack(false, { error: 'refused', detail: 'This page only hosts its two browser software instruments.' });
    const op = cmd.op, error = checkMidiOp(op);
    if (error || op.channel !== 1) return ack(false, { error: 'bad_args', detail: error ?? 'Software instruments use channel 1.' });
    const generated = generatedMidiPacket(cmd, portId!);
    if (generated && !generated.ok) return ack(false, { error: 'refused', detail: generated.error });
    if (cmd.dryRun) return ack(true, { detail: 'Dry run; no software state change.' });
    if (op.msg === 'panic') { this.musical.receiveMidi([0xb0, 17, 0]); this.visual?.reset(); return ack(true); }
    if (op.msg !== 'cc' && op.msg !== 'pc') return ack(false, { error: 'unsupported', detail: 'Use the declared software instrument CC/program capabilities.' });
    const bytes = generated?.ok ? generated.bytes : op.msg === 'cc' ? [0xb0, op.number!, Number(op.value)] : [0xc0, op.number!];
    const visual = portId === VISUAL_SYNTH_PORT_ID;
    if (visual && this.instrument !== 'visual-synth') return ack(false, { error: 'no_port', detail: 'Choose Visual synth to enable this software port.' });
    if (!visual && this.instrument !== 'musical-synth') return ack(false, { error: 'no_port', detail: 'Choose Musical synth to enable this software port.' });
    if (visual ? !this.visual?.receiveMidi(bytes) : !this.musical.receiveMidi(bytes)) return ack(false, { error: 'bad_args', detail: 'That parameter is unavailable, or software audio needs another Connect click.' });
    this.received++;
    const label = `${op.msg === 'cc' ? 'CC' : 'program '}${op.number} → ${op.value ?? ''}`;
    if (visual) {
      this.water.receive(this.visual!.getState());
      this.view.applied('visual-synth', label);
      return ack(true, { detail: 'Applied by the hand demo page\'s visual synth renderer.', applied: { source: 'renderer', params: { ...this.visual!.getState() }, visible: true, frame: this.visual!.stats().frames, at: Date.now() } });
    }
    if (op.msg === 'cc' && [16, 17].includes(op.number!)) await new Promise(resolve => setTimeout(resolve, 70));
    const receipt = this.musical.receipt();
    this.view.applied('musical-synth', label);
    return ack(true, { detail: 'Applied by the hand demo page\'s Web Audio instrument (software graph evidence).', applied: { source: 'musical-synth', params: receipt.params, audio: receipt.audio, visible: true, frame: receipt.frame, at: receipt.at } });
  }

  snapshot() {
    return { connected: this.connected, selectedCard: this.selectedCard, requestId: this.requestId, wiringId: this.wiringId, instrument: this.instrument,
      outputs: this.outputs, programOutputs: this.programOutputs, received: this.received, running: this.runtime.running, runtime: { ...this.runtime.stats }, lastRuntimeStop: this.lastRuntimeStop,
      ready: this.accepted ? { title: this.accepted.title, source: this.accepted.source, needs: this.accepted.needs, hasCode: !!this.accepted.code.trim(), actions: this.accepted.actions.map(a => a.actionId) } : undefined,
      visual: this.visual?.getState(), musical: this.musical.receipt() };
  }
  dispose(): void { this.lifecycle++; this.disposed = true; this.connecting = false; this.controlPair.cancel(); this.synthPair.cancel(); this.stop('Closed'); this.selectedCard = undefined; this.selection = undefined; this.controller?.stop(); this.executor?.stop(); this.musical.dispose(); this.water.dispose(); this.visual?.dispose(); }
}
