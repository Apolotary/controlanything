/**
 * The sim as a paired device: the IR executor (virtual IR LED -> virtual lamp), the MIDI executor (virtual
 * synth), the camera sensor (frames of the virtual room) and the audio sensor (the synth's own analyser).
 *
 * Honesty rules: an exec.ack only says the bytes went out, never whether the lamp obeyed (that is for the
 * camera oracle to find out); the lamp obeys only its own code set; frames are developed from the lamp's real
 * state, including its fade, with sensor noise.
 */
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
  private lastIrTx = 0;
  private scanTimer?: ReturnType<typeof setTimeout>;
  private pendingFrames = new Map<string, ViewId>();
  private learnTimer?: ReturnType<typeof setTimeout>;
  private readonly listeners = new Set<() => void>();
  private readonly logListeners = new Set<(l: LogLine) => void>();
  readonly logLines: LogLine[] = [];

  constructor(
    readonly synth: SynthEngine,
    readonly meter: FeatureMeter,
    readonly room: RoomView,
    readonly animator: LampAnimator,
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
    if (op.kind === 'local') return ack(false, { error: 'unsupported', detail: 'the sim has no local ops (volume, torch, print...)' });
    if (op.kind === 'midi') {
      if (p.port && !portMatches(p.port, 'midi-out')) return ack(false, { error: 'no_port', detail: `no MIDI output "${p.port}" on the sim (have "${SIM_PORTS[0]!.name}")` });
      if (op.value === '$value') return ack(false, { error: 'bad_args', detail: '"$value" was not substituted' });
      if (p.dryRun) return ack(true, { detail: 'dry run' });
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
          this.synth.panic();
          this.log('midi', 'panic: all notes off');
          return ack(true, { detail: 'all notes off' });
      }
    }
    // IR
    if (p.port && !portMatches(p.port, 'ir')) return ack(false, { error: 'no_port', detail: `no IR port "${p.port}" on the sim` });
    let us = op.rawUs;
    if (!us?.length) {
      const bytes = op.bytes ?? (op.address !== undefined && op.command !== undefined ? necBytes(op.address, op.command) : undefined);
      if ((op.protocol === 'NEC' || op.protocol === 'AEHA') && bytes) us = encodeFrame({ proto: op.protocol, bytes, unitUs: op.unitUs });
    }
    if (!us?.length) return ack(false, { error: 'bad_args', detail: 'IR op needs rawUs (or NEC/AEHA bytes)' });
    if (p.dryRun) return ack(true, { detail: 'dry run' });
    const timings = us;
    // one burst at a time, never closer than IR_MIN_GAP_MS (like the Cardputer firmware)
    const run = this.irQueue.then(async () => {
      const wait = this.lastIrTx + IR_MIN_GAP_MS - Date.now();
      // hidden tabs may throttle timers to once a minute: never delay the control loop there
      if (wait > 0 && !(typeof document !== 'undefined' && document.hidden)) await new Promise((r) => setTimeout(r, wait));
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
    this.learn = { senseId: p.senseId, prompt: p.prompt, until: Date.now() + ms, count: 0 };
    this.log('learn', `learn window ${Math.round(ms / 1000)} s${p.prompt ? `: "${p.prompt}"` : ''}`);
    this.changed();
    if (this.autoPress) {
      const cmd = promptedButton(p.prompt);
      if (cmd) setTimeout(() => this.remotePress(cmd), 1200);
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

function portMatches(want: string, kind: 'midi-out' | 'ir'): boolean {
  const w = want.toLowerCase();
  return SIM_PORTS.some((p) => p.kind === kind && (p.id.toLowerCase() === w || p.name.toLowerCase().includes(w)));
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
