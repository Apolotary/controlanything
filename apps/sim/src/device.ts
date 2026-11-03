/**
 * The sim as a paired device: the IR executor (virtual IR LED -> virtual lamp), the MIDI executor (virtual
 * synth), the camera sensor (frames of the virtual room) and the audio sensor (the synth's own analyser).
 *
 * Honesty rules: an exec.ack only says the bytes went out, never whether the lamp obeyed (that is for the
 * camera oracle to find out); the lamp obeys only its own code set; frames are developed from the lamp's real
 * state, including its fade, with sensor noise.
 */
import { recordClip } from './mic';
import { tempoFromCc } from './synth/ccmap';
import {
  type ExecAckPayload,
  type ExecCommandPayload,
  type IrCapture,
  newId,
  type ScanFramePayload,
  type ScanResultPayload,
  type SenseRequestPayload,
  type SenseResultPayload,
} from '@ce/protocol';
import { encodeFrame, hex, necBytes, receiverDistort } from './ir/codec';
import { type Channel, codeFor, type CodeSet, type LampCmd, matchTimings, type MatchResult, pressTimings, SIM_KZ, BUTTONS } from './ir/table';
import { applyCmd, DEFAULT_STATE, type LampAnimator, type LampState } from './room/lamp';
import type { RoomView, ViewId } from './room/view';
import { SIM_IDENTITY_REPLY } from './synth/ccmap';
import type { SynthEngine } from './synth/engine';
import type { FeatureMeter } from './synth/features';
import type { Connection } from './net/net';
import { SIM_PORTS } from './net/net';
import { VISUAL_SYNTH_IDENTITY_REPLY, VISUAL_SYNTH_PORT, VISUAL_SYNTH_PORT_ID } from '@ce/vsynth';

/** A MIDI output with no audio engine; the rendered screen is its physical result. */
export interface VisualSynthOutput {
  receiveMidi(bytes: readonly number[]): boolean;
  reset(): void;
}

export type LogKind = 'ir' | 'lamp' | 'midi' | 'sense' | 'scan' | 'agent' | 'net' | 'warn' | 'learn';
export interface LogLine {
  t: number;
  kind: LogKind;
  text: string;
}

export interface LearnWindow {
  senseId: string;
  prompt?: string;
  until: number;
  count: number;
}

const IR_MIN_GAP_MS = 120; // like the firmware: never two bursts closer than this
const SAME_PRESS_MS = 150; // a second identical frame this soon is the same press

export class SimDevice {
  state: LampState = { ...DEFAULT_STATE };
  codeSets: CodeSet[] = [SIM_KZ];
  codeSet: CodeSet = SIM_KZ;
  /** the channel the virtual remote's slide switch is on */
  remoteChannel: Channel = 1;
  conn?: Connection;
  deviceId?: string;
  learn?: LearnWindow;
  scanning = false;
  /** auto-press the button a learn prompt names (unattended runs) */
  autoPress = false;
  lastIr?: { at: number; result: MatchResult; source: 'remote' | 'exec' };
  private lastAccepted?: { key: string; at: number };
  private irQueue: Promise<unknown> = Promise.resolve();
  private irGeneration = 0;
  private lastIrTx = 0;
  private scanTimer?: ReturnType<typeof setTimeout>;
  private pendingFrames = new Map<string, ViewId>();
  private learnTimer?: ReturnType<typeof setTimeout>;
  private autoPressTimer?: ReturnType<typeof setTimeout>;
  private readonly listeners = new Set<() => void>();
  private readonly logListeners = new Set<(l: LogLine) => void>();
  readonly logLines: LogLine[] = [];

  constructor(
    readonly synth: SynthEngine,
    readonly meter: FeatureMeter,
    readonly room: RoomView,
    readonly animator: LampAnimator,
    readonly visualSynth?: VisualSynthOutput,
  ) {}

  /** Mirror a state from the leader page (followers): no IR, no log. */
  mirror(state: LampState): void {
    this.state = state;
    this.animator.setTarget(state);
    this.changed();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onLog(fn: (l: LogLine) => void): () => void {
    this.logListeners.add(fn);
    return () => this.logListeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  log(kind: LogKind, text: string): void {
    const l = { t: Date.now(), kind, text };
    this.logLines.push(l);
    if (this.logLines.length > 400) this.logLines.shift();
    for (const fn of this.logListeners) fn(l);
  }

  /** Stop all device work already scheduled by the server or the automatic remote. */
  panic(options: { resetVisual?: boolean } = {}): void {
    this.irGeneration++;
    this.irQueue = Promise.resolve();
    clearTimeout(this.learnTimer);
    clearTimeout(this.autoPressTimer);
    this.learn = undefined;
    this.synth.panic();
    if (options.resetVisual !== false) this.visualSynth?.reset();
    this.changed();
  }

  // --- lamp ----------------------------------------------------------------------------------------

  setLampState(next: LampState, why: string): void {
    const prev = this.state;
    this.state = next;
    saveLamp(next);
    this.animator.setTarget(next);
    if (prev.power !== next.power || prev.level !== next.level || prev.cctK !== next.cctK || prev.channel !== next.channel) {
      this.log('lamp', `${why} → ${describeLamp(next)}`);
    }
    this.changed();
  }

  /** The fixture's receiver: decode, match against the code set, act once per press. */
  receiveIr(us: readonly number[], source: 'remote' | 'exec'): MatchResult {
    const result = matchTimings(this.codeSet, us, this.state.channel);
    this.lastIr = { at: Date.now(), result, source };
    if (result.code) {
      const key = hex(result.code.bytes);
      const now = Date.now();
      if (this.lastAccepted && this.lastAccepted.key === key && now - this.lastAccepted.at < SAME_PRESS_MS) {
        this.log('ir', `lamp receiver: ${result.summary} (repeat of the same press, ignored)`);
      } else {
        this.lastAccepted = { key, at: now };
        this.log('ir', `lamp receiver: ${result.summary}`);
        this.setLampState(applyCmd(this.state, result.code.cmd), `${BUTTONS[result.code.cmd].ja} ${result.code.cmd}`);
      }
    } else {
      this.log('ir', `lamp receiver: ${result.summary}`);
    }
    this.changed();
    return result;
  }

  /** A press on the virtual remote: the lamp sees it, and so does a learning receiver (sense ir-capture). */
  remotePress(cmd: LampCmd): void {
    const code = codeFor(this.codeSet, cmd, this.remoteChannel);
    if (!code) {
      this.log('warn', `remote: no ${cmd} code in ${this.codeSet.name}`);
      return;
    }
    const us = pressTimings(code);
    this.log('ir', `remote: ${BUTTONS[cmd].ja} (${cmd}, CH${this.remoteChannel}) sends ${code.proto} ${hex(code.bytes)} ×${code.repeats + 1}`);
    this.receiveIr(us, 'remote');
    if (this.learn && Date.now() <= this.learn.until) this.captureForLearn(us, code.repeats + 1, code.frameGapUs);
  }

  private captureForLearn(us: readonly number[], frames: number, frameGapUs: number): void {
    const w = this.learn!;
    w.count++;
    const rawUs = receiverDistort(us, (Date.now() & 0xffff) | 1);
    const decoded = matchTimings(this.codeSet, rawUs, this.state.channel).frames[0];
    const ir: IrCapture = { rawUs, khz: 38, frames, frameGapUs };
    if (decoded) {
      ir.protocol = decoded.proto;
      ir.bytes = decoded.bytes;
      ir.unitUs = decoded.unitUs;
    }
    const sent = this.sendSense({ senseId: w.senseId, kind: 'ir-capture', ir, at: Date.now(), ok: true });
    this.log('learn', `captured press #${w.count} (${rawUs.length} edges${decoded ? `, ${decoded.proto} ${hex(decoded.bytes)}` : ''})${sent ? ' → server' : ' (not connected)'}`);
    this.changed();
  }

  // --- exec.command ----------------------------------------------------------------------------------

  async handleExec(p: ExecCommandPayload): Promise<ExecAckPayload> {
    const received = Date.now();
    const ack = (ok: boolean, extra: Partial<ExecAckPayload> = {}): ExecAckPayload => {
      const sentAt = Date.now();
      return { execId: p.execId, ok, sentAt, latencyMs: sentAt - received, ...extra };
    };
    const op = p.op;
    if (op.kind === 'local' || op.kind === 'ble') return ack(false, { error: 'unsupported', detail: `the sim has no ${op.kind} ops (volume, torch, print, gimbal...)` });
    if (op.kind === 'midi') {
      const output = p.port ? matchingPort(p.port, 'midi-out') : undefined;
      if (p.port && !output) return ack(false, { error: 'no_port', detail: `no MIDI output "${p.port}" on the sim (have "${SIM_PORTS[0]!.name}")` });
      if (op.value === '$value') return ack(false, { error: 'bad_args', detail: '"$value" was not substituted' });
      if (p.dryRun) return ack(true, { detail: 'dry run' });
      if (output?.id === VISUAL_SYNTH_PORT_ID) {
        if (!this.visualSynth) return ack(false, { error: 'no_port', detail: 'visual synth is unavailable' });
        if (op.msg === 'sysex-identity') return ack(true, { reply: [...VISUAL_SYNTH_IDENTITY_REPLY], detail: VISUAL_SYNTH_PORT });
        if (op.msg === 'panic') {
          this.visualSynth.reset();
          this.log('midi', 'visual synth reset');
          return ack(true, { detail: 'visual synth reset' });
        }
        const status = op.msg === 'cc' ? 0xb0 : 0xc0;
        const bytes = op.msg === 'cc' && op.number !== undefined && op.value !== undefined
          ? [status + op.channel - 1, op.number, op.value]
          : op.msg === 'pc' && op.number !== undefined ? [status + op.channel - 1, op.number] : undefined;
        if (!bytes || !this.visualSynth.receiveMidi(bytes)) return ack(false, { error: 'bad_args', detail: 'visual synth accepts mapped CCs and programs 0–2' });
        this.log('midi', `visual synth ${op.msg === 'cc' ? `CC${op.number}=${op.value}` : `pattern ${op.number}`} ch${op.channel}`);
        return ack(true, { detail: hex(bytes) });
      }
      switch (op.msg) {
        case 'cc': {
          if (op.number === undefined || op.value === undefined) return ack(false, { error: 'bad_args', detail: 'cc needs number and value' });
          const e = this.synth.controlChange(op.channel, op.number, op.value);
          this.log('midi', `CC${op.number}=${op.value} ch${op.channel}: ${e.note}`);
          return ack(true, { detail: `B${(op.channel - 1).toString(16).toUpperCase()} ${hex([op.number, op.value])}` });
        }
        case 'note': {
          if (op.number === undefined) return ack(false, { error: 'bad_args', detail: 'note needs number' });
          const vel = op.velocity ?? 100;
          const dur = op.durationMs ?? 250;
          const e = this.synth.noteOn(op.channel, op.number, vel, dur);
          this.log('midi', `note ${op.number} vel ${vel} ch${op.channel} ${dur}ms${e.accepted ? '' : this.synth.running ? ' (ignored: wrong channel)' : ' (audio off)'}`);
          return ack(true, { detail: e.accepted ? 'note on' : this.synth.running ? `ignored: the synth listens on channel ${this.synth.channel}` : 'audio is off on the sim page (click Start audio)' });
        }
        case 'pc':
          this.log('midi', `program change ${op.number} ch${op.channel} (one patch in the sim)`);
          return ack(true, { detail: 'program change accepted (the sim has one patch)' });
        case 'sysex-identity':
          this.log('midi', 'identity request F0 7E 7F 06 01 F7 → reply (non-commercial ID 7D)');
          return ack(true, { reply: SIM_IDENTITY_REPLY, detail: hex(SIM_IDENTITY_REPLY) });
        case 'panic':
          this.panic();
          this.log('midi', 'panic: all notes off');
          return ack(true, { detail: 'all notes off' });
      }
    }
    // IR
    if (p.port && !matchingPort(p.port, 'ir')) return ack(false, { error: 'no_port', detail: `no IR port "${p.port}" on the sim` });
    let us = op.rawUs;
    if (!us?.length) {
      const bytes = op.bytes ?? (op.address !== undefined && op.command !== undefined ? necBytes(op.address, op.command) : undefined);
      if ((op.protocol === 'NEC' || op.protocol === 'AEHA') && bytes) us = encodeFrame({ proto: op.protocol, bytes, unitUs: op.unitUs });
    }
    if (!us?.length) return ack(false, { error: 'bad_args', detail: 'IR op needs rawUs (or NEC/AEHA bytes)' });
    if (p.dryRun) return ack(true, { detail: 'dry run' });
    const timings = us;
    const generation = this.irGeneration;
    // one burst at a time, never closer than IR_MIN_GAP_MS (like the Cardputer firmware)
    const run = this.irQueue.then(async () => {
      if (generation !== this.irGeneration) return ack(false, { error: 'refused', detail: 'IR cancelled by Stop' });
      const wait = this.lastIrTx + IR_MIN_GAP_MS - Date.now();
      // hidden tabs may throttle timers to once a minute: never delay the control loop there
      if (wait > 0 && !(typeof document !== 'undefined' && document.hidden)) await new Promise((r) => setTimeout(r, wait));
      if (generation !== this.irGeneration) return ack(false, { error: 'refused', detail: 'IR cancelled by Stop' });
      this.lastIrTx = Date.now();
      this.log('ir', `IR LED: ${op.protocol}${op.bytes ? ' ' + hex(op.bytes) : ''} ${timings.length} edges${op.repeats ? ` +${op.repeats} repeat(s)` : ''}${op.ref ? ` [${op.ref}]` : ''}`);
      this.receiveIr(timings, 'exec');
      return ack(true, { detail: `IR sent: ${timings.length} edges @ ${op.khz ?? 38} kHz${op.repeats ? ` + ${op.repeats} repeat(s)` : ''}` });
    });
    this.irQueue = run.catch(() => {});
    return run;
  }

  // --- sense.request -----------------------------------------------------------------------------------

  async handleSense(p: SenseRequestPayload): Promise<void> {
    if (p.kind === 'frame') {
      const off = p.offsetMs ?? 0;
      if (off > 0) await new Promise((r) => setTimeout(r, off));
      const frame = await this.captureFrame('verify', { at: off < 0 ? Date.now() + off : undefined, senseId: p.senseId, cardId: p.cardId });
      this.sendSense({ senseId: p.senseId, kind: 'frame', frame, at: frame.capturedAt, ok: true });
      this.log('sense', `frame for ${p.senseId.slice(-6)} (${this.room.view} view${off ? `, offset ${off} ms` : ''}) → server`);
      return;
    }
    if (p.kind === 'audio-clip') {
      // the "say line" oracle: record the laptop microphone so the server can hear the Mac speak
      try {
        const ms = Math.min(10_000, Math.max(1000, p.durationMs ?? 3000));
        // a permission bubble nobody clicks must not stall the agent: answer "unavailable" soon after the window
        const deadline = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no microphone permission within the window; allow the microphone in the browser and run the hack again')), ms + 2500));
        const clip = await Promise.race([recordClip(ms), deadline]);
        this.sendSense({ senseId: p.senseId, kind: 'audio-clip', clip, at: Date.now(), ok: true });
        this.log('sense', `recorded ${clip.durationMs} ms from "${clip.input ?? 'microphone'}" → server (Muse Voice Transcribe listens)`);
      } catch (e) {
        this.sendSense({ senseId: p.senseId, kind: 'audio-clip', at: Date.now(), ok: false, error: `microphone unavailable: ${(e as Error).message}`.slice(0, 300) });
        this.log('warn', `audio clip requested but the microphone is unavailable (${(e as Error).message})`);
      }
      return;
    }
    if (p.kind === 'audio-features') {
      if (!this.synth.running) {
        const audio = await this.meter.measure(0, 0);
        this.sendSense({ senseId: p.senseId, kind: 'audio-features', audio, at: Date.now(), ok: false, error: 'sim audio is off: click "Start audio" on the sim page' });
        this.log('warn', 'audio features requested but audio is off (click Start audio)');
        return;
      }
      const audio = await this.meter.measure(p.durationMs ?? 600, p.offsetMs ?? 0);
      this.sendSense({ senseId: p.senseId, kind: 'audio-features', audio, at: Date.now(), ok: true });
      this.log('sense', `audio ${p.durationMs ?? 600} ms${p.offsetMs ? ` @${p.offsetMs}` : ''}: ${audio.rmsDb} dBFS, centroid ${audio.centroidHz} Hz → server`);
      return;
    }
    // ir-capture: open a learn window on the virtual remote
    const ms = p.durationMs ?? 15_000;
    if (this.learnTimer) clearTimeout(this.learnTimer);
    clearTimeout(this.autoPressTimer);
    this.learn = { senseId: p.senseId, prompt: p.prompt, until: Date.now() + ms, count: 0 };
    this.log('learn', `learn window ${Math.round(ms / 1000)} s${p.prompt ? `: "${p.prompt}"` : ''}`);
    this.changed();
    if (this.autoPress) {
      const cmd = promptedButton(p.prompt);
      if (cmd) this.autoPressTimer = setTimeout(() => {
        if (this.learn?.senseId === p.senseId) this.remotePress(cmd);
      }, 1200);
    }
    this.learnTimer = setTimeout(() => {
      const w = this.learn;
      if (w?.senseId !== p.senseId) return;
      if (!w.count) this.sendSense({ senseId: w.senseId, kind: 'ir-capture', at: Date.now(), ok: false, error: 'no remote press within the window' });
      this.learn = undefined;
      this.log('learn', `learn window closed (${w.count} press${w.count === 1 ? '' : 'es'})`);
      this.changed();
    }, ms);
  }

  private sendSense(payload: SenseResultPayload): boolean {
    return this.conn?.send('sense.result', payload, { to: 'server' }) ?? false;
  }

  // --- tempo signal (daemons: "breathe to tempo") ------------------------------------------------------

  private lastClockBpm?: number;
  private clockTimer?: ReturnType<typeof setInterval>;

  /** Report the synth's tempo as a MIDI-clock signal every 2 s while the synth runs (device.signal clock_bpm). */
  startClockSignal(): void {
    if (this.clockTimer) return;
    this.clockTimer = setInterval(() => {
      if (!this.conn?.open || !this.synth.running) return;
      const bpm = tempoFromCc(this.synth.cc.get(80) ?? 74);
      if (bpm === this.lastClockBpm) return;
      this.lastClockBpm = bpm;
      this.conn.send('device.signal', { signal: 'clock_bpm', value: bpm, unit: 'bpm', at: Date.now() }, { to: 'server' });
      this.log('midi', `clock: ${bpm} BPM → server (device.signal)`);
    }, 2000);
  }

  stopClockSignal(): void {
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.clockTimer = undefined;
  }

  // --- camera ------------------------------------------------------------------------------------------

  async captureFrame(purpose: 'scan' | 'verify', opts: { at?: number; senseId?: string; cardId?: string } = {}): Promise<ScanFramePayload> {
    const shot = await this.room.capture({ noise: 1, at: opts.at });
    const vm = this.room.meta?.views[shot.view];
    const frame: ScanFramePayload = {
      frameId: newId('simf'),
      jpeg: shot.jpeg,
      width: shot.width,
      height: shot.height,
      capturedAt: opts.at ?? Date.now(),
      space: 'local-floor',
      purpose,
    };
    if (vm) {
      frame.pose = vm.pose;
      frame.camera = {
        width: shot.width,
        height: shot.height,
        fovY: vm.fovYDeg,
        intrinsics: { fx: vm.intrinsics.fx, fy: vm.intrinsics.fy, cx: vm.intrinsics.cx, cy: vm.intrinsics.cy },
        eye: 'mono',
        source: 'synthetic',
        cameraPose: vm.pose,
      };
    }
    if (opts.senseId) frame.senseId = opts.senseId;
    if (opts.cardId) frame.cardId = opts.cardId;
    this.pendingFrames.set(frame.frameId, shot.view);
    if (this.pendingFrames.size > 50) this.pendingFrames.delete(this.pendingFrames.keys().next().value!);
    return frame;
  }

  async sendScanFrame(): Promise<boolean> {
    if (!this.conn?.open || !this.room.ready) return false;
    const frame = await this.captureFrame('scan');
    const ok = this.conn.send('scan.frame', frame, { to: 'server' });
    if (ok) this.log('scan', `scan.frame ${frame.frameId.slice(-6)} (${this.room.view} view, ${Math.round((frame.jpeg.length * 3) / 4 / 1024)} KB)`);
    return ok;
  }

  setScanning(on: boolean): void {
    this.scanning = on;
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = undefined;
    const tick = async () => {
      if (!this.scanning) return;
      await this.sendScanFrame().catch((e) => this.log('warn', `scan frame failed: ${(e as Error).message}`));
      if (this.scanning) this.scanTimer = setTimeout(tick, 1000); // <= 1 Hz
    };
    if (on) void tick();
    this.changed();
  }

  onScanResult(r: ScanResultPayload): void {
    const view = this.pendingFrames.get(r.frameId);
    if (!view) return;
    this.room.showDetections(r, view);
    const names = r.detections.map((d) => `${d.label} ${(d.score * 100).toFixed(0)}%`).join(', ') || 'nothing';
    this.log('scan', `scan.result ${r.frameId.slice(-6)}: ${names} (${r.modelId}, ${r.source}, ${Math.round(r.latencyMs)} ms)`);
  }
}

const LAMP_KEY = 'ce.sim.lamp';

/** A real lamp keeps its state when you reload the page; so does this one (per browser). */
export function loadLamp(): LampState | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(LAMP_KEY) ?? 'null') as LampState | null;
    return v && ['off', 'on', 'night'].includes(v.power) ? { ...DEFAULT_STATE, ...v } : undefined;
  } catch {
    return undefined;
  }
}

function saveLamp(s: LampState): void {
  try {
    localStorage.setItem(LAMP_KEY, JSON.stringify(s));
  } catch {
    // private mode: the state lasts for this page only
  }
}

function matchingPort(want: string, kind: 'midi-out' | 'ir') {
  const w = want.toLowerCase();
  return SIM_PORTS.find((p) => p.kind === kind && (p.id.toLowerCase() === w || p.name.toLowerCase().includes(w)));
}

export function describeLamp(s: LampState): string {
  const ch = `CH${s.channel}`;
  if (s.power === 'off') return `OFF · ${ch}`;
  if (s.power === 'night') return `NIGHT LIGHT · ${ch}`;
  return `ON · level ${s.level}/10 · ${s.cctK} K · ${ch}`;
}

/**
 * Which remote button a learn prompt asks for ("Press 全灯 (full on) once", "press 暖色 (warm)", "press Off"...).
 * Japanese remotes label the same keys differently (暖色 / 暖かい光 / 電球色), so match on families of words.
 */
const PROMPT_WORDS: [LampCmd, RegExp][] = [
  ['fullOn', /全灯|full[\s-]*on|\bfull\b|max(imum)? bright/i],
  ['night', /常夜灯|night/i],
  ['off', /消灯|\boff\b/i],
  ['warmer', /暖|電球色|warm/i],
  ['cooler', /白色|白い|昼光色|昼白色|cool|cold|daylight/i],
  ['brighter', /明るく|bright/i],
  ['dimmer', /暗く|\bdim/i],
  ['on', /点灯|\bon\b/i],
];

export function promptedButton(prompt?: string): LampCmd | undefined {
  if (!prompt) return undefined;
  return PROMPT_WORDS.find(([, re]) => re.test(prompt))?.[0];
}
