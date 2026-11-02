/**
 * Executes MidiOps from `exec.command` on Web MIDI outputs (or any MidiIO, e.g. a test double):
 * port routing by id/name, rate limiting via MidiScheduler, tracked notes with automatic note-off,
 * panic, the identity probe, and a last-line denylist (the server's allowlist is the first line).
 */
import { checkMidiOp, type ExecAckPayload, type ExecCommandPayload, type ExecErrorCode, type MidiOp } from './contracts';
import {
  controlChange,
  describeIdentity,
  IDENTITY_REQUEST,
  type IdentityReply,
  noteOff,
  noteOn,
  parseIdentityReply,
  programChange,
  toHex,
} from './midiDecode';
import { type Clock, MidiScheduler, realClock, type SendKind, type SendOutcome } from './midiScheduler';

export interface MidiPortLike {
  id: string;
  name?: string | null;
  manufacturer?: string | null;
  state?: string;
}

export interface MidiInEvent {
  portId: string;
  portName: string;
  data: Uint8Array;
  time: number;
}

/** What the executor needs from Web MIDI (MidiBridge implements it). */
export interface MidiIO {
  readonly enabled: boolean;
  readonly sysex: boolean;
  outputs(): MidiPortLike[];
  inputs(): MidiPortLike[];
  /** timestamp: performance.now()-based, for scheduled sends */
  send(outputId: string, bytes: number[], timestamp?: number): void;
  addListener(fn: (m: MidiInEvent) => void): () => void;
}

const portLabel = (p: MidiPortLike) => p.name || p.id;

/**
 * Pick an output: exact id, then exact name (case-insensitive), then substring; without a hint,
 * the only connected output. Among several substring matches a "standalone" port wins (Ableton Move
 * exposes four ports and only the Standalone Port reaches its tracks).
 */
export function resolvePort<T extends MidiPortLike>(ports: T[], want?: string): { port?: T; error?: string } {
  const live = ports.filter((p) => p.state !== 'disconnected');
  const names = live.map(portLabel).join(', ') || 'none';
  if (!want) {
    if (live.length === 1) return { port: live[0] };
    return { error: live.length ? `several MIDI outputs (${names}); say which port` : 'no MIDI outputs connected' };
  }
  const w = want.toLowerCase();
  const byId = live.find((p) => p.id === want);
  if (byId) return { port: byId };
  const byName = live.find((p) => (p.name ?? '').toLowerCase() === w);
  if (byName) return { port: byName };
  const partial = live.filter((p) => (p.name ?? '').toLowerCase().includes(w) || w.includes((p.name ?? '\u0000').toLowerCase()));
  if (partial.length) return { port: partial.find((p) => /standalone/i.test(p.name ?? '')) ?? partial[0] };
  return { error: `no MIDI output matches "${want}" (have: ${names})` };
}

/**
 * Messages the companion refuses whatever the driver says (research/devices/*.json `unsafeMessages`).
 * Returns the reason, or undefined when the message is allowed.
 */
export function unsafeReason(portName: string, bytes: readonly number[]): string | undefined {
  const name = portName.toLowerCase();
  if (bytes[0] === 0xf0) {
    const identity = bytes.length === IDENTITY_REQUEST.length && bytes.every((b, i) => b === IDENTITY_REQUEST[i]);
    if (!identity) return 'SysEx other than the identity request is never sent';
    if (/move/.test(name)) return 'Ableton Move gets no SysEx at all (its SysEx includes power-off commands)';
    return undefined;
  }
  if (/op-1/.test(name) && (bytes[0] & 0xf0) === 0xb0 && bytes[1] === 62 && (bytes[2] ?? 0) >= 64) {
    return 'CC 62 randomizes the OP-1 patch and cannot be undone over MIDI';
  }
  return undefined;
}

export interface IdentityResult {
  reply?: IdentityReply;
  /** the first identity-shaped reply */
  bytes?: number[];
  hex?: string;
  inputName?: string;
  ms: number;
}

export interface ExecLogEntry {
  at: number;
  dir: 'out' | 'in';
  port: string;
  bytes: number[];
  note?: string;
}

export interface MidiExecutorOptions {
  clock?: Clock;
  maxPerSecond?: number;
  keyIntervalMs?: number;
  identityTimeoutMs?: number;
  /** epoch ms (exec.ack sentAt is wall-clock) */
  wallNow?: () => number;
}

interface Tracked {
  portId: string;
  channel: number;
  note: number;
  timer?: unknown;
}

export class MidiExecutor {
  readonly scheduler: MidiScheduler;
  private readonly clock: Clock;
  private readonly wallNow: () => number;
  private readonly identityTimeoutMs: number;
  private readonly sounding = new Map<string, Tracked>();
  /** every byte sent or received, newest last (bounded) */
  readonly tape: ExecLogEntry[] = [];
  onTape: (e: ExecLogEntry) => void = () => {};

  constructor(
    private readonly io: MidiIO,
    opts: MidiExecutorOptions = {},
  ) {
    this.clock = opts.clock ?? realClock;
    this.wallNow = opts.wallNow ?? Date.now;
    this.identityTimeoutMs = opts.identityTimeoutMs ?? 800;
    this.scheduler = new MidiScheduler((portId, bytes) => this.rawSend(portId, bytes), {
      clock: this.clock,
      maxPerSecond: opts.maxPerSecond,
      keyIntervalMs: opts.keyIntervalMs,
    });
  }

  get soundingNotes(): number {
    return this.sounding.size;
  }

  private record(e: ExecLogEntry): void {
    this.tape.push(e);
    if (this.tape.length > 500) this.tape.shift();
    this.onTape(e);
  }

  private portName(portId: string): string {
    const p = this.io.outputs().find((o) => o.id === portId);
    return p ? portLabel(p) : portId;
  }

  private rawSend(portId: string, bytes: number[], timestamp?: number): void {
    this.io.send(portId, bytes, timestamp);
    this.record({ at: this.wallNow(), dir: 'out', port: this.portName(portId), bytes: [...bytes] });
  }

  /** Queue bytes through the rate limiter; resolves when they actually left. */
  private queue(portId: string, bytes: number[], kind: SendKind, key?: string) {
    return new Promise<SendOutcome>((resolve) => this.scheduler.enqueue({ portId, bytes, kind, key, done: resolve }));
  }

  private ack(cmd: ExecCommandPayload, t0: number, ok: boolean, extra: Partial<ExecAckPayload> = {}): ExecAckPayload {
    const a: ExecAckPayload = { execId: cmd.execId, ok, sentAt: this.wallNow(), latencyMs: Math.max(0, Math.round(this.clock.now() - t0)), ...extra };
    if (a.detail) a.detail = a.detail.slice(0, 1000);
    return a;
  }

  private fail(cmd: ExecCommandPayload, t0: number, error: ExecErrorCode, detail: string): ExecAckPayload {
    return this.ack(cmd, t0, false, { error, detail });
  }

  /** Run one MidiOp. Never throws; the ack says what happened. */
  async execute(cmd: ExecCommandPayload): Promise<ExecAckPayload> {
    const t0 = this.clock.now();
    if (cmd.op.kind !== 'midi') return this.fail(cmd, t0, 'bad_args', 'not a MIDI op');
    const op: MidiOp = cmd.op;
    const bad = checkMidiOp(op);
    if (bad) return this.fail(cmd, t0, 'bad_args', bad);
    if (!this.io.enabled) return this.fail(cmd, t0, 'no_midi', 'Web MIDI is not enabled on the companion (press ENABLE MIDI)');
    if (op.msg === 'panic') {
      if (cmd.dryRun) return this.ack(cmd, t0, true, { detail: 'dry run: panic' });
      const n = this.panic(cmd.port);
      return this.ack(cmd, t0, true, { detail: `panic: ${n} messages` });
    }
    const { port, error } = resolvePort(this.io.outputs(), cmd.port);
    if (!port) return this.fail(cmd, t0, 'no_port', error ?? 'no port');
    const name = portLabel(port);

    if (op.msg === 'sysex-identity') {
      const why = unsafeReason(name, IDENTITY_REQUEST);
      if (why) return this.fail(cmd, t0, 'refused', why);
      if (!this.io.sysex) return this.fail(cmd, t0, 'refused', 'MIDI was granted without SysEx; re-enable MIDI and allow SysEx');
      if (cmd.dryRun) return this.ack(cmd, t0, true, { detail: `dry run: ${toHex(IDENTITY_REQUEST)} → ${name}` });
      const r = await this.identify(port.id);
      if (!r.bytes) return this.ack(cmd, t0, true, { detail: `identity request sent to ${name}; no reply within ${this.identityTimeoutMs} ms` });
      return this.ack(cmd, t0, true, {
        reply: r.bytes.slice(0, 256),
        detail: r.reply ? `${name} answered: ${describeIdentity(r.reply)} (via ${r.inputName}, ${Math.round(r.ms)} ms)` : `${name} answered ${r.hex}`,
      });
    }

    const ch = op.channel!;
    let bytes: number[];
    let kind: SendKind;
    let key: string | undefined;
    if (op.msg === 'cc') {
      bytes = controlChange(ch, op.number!, op.value as number); // checkMidiOp ruled out the placeholder
      kind = 'cc';
      key = `${port.id}|${bytes[0]}|${bytes[1]}`;
    } else if (op.msg === 'pc') {
      bytes = programChange(ch, op.number!);
      kind = 'pc';
    } else {
      bytes = noteOn(ch, op.number!, op.velocity ?? 100);
      kind = 'note-on';
    }
    const why = unsafeReason(name, bytes);
    if (why) return this.fail(cmd, t0, 'refused', why);
    const label = `${toHex(bytes)} → ${name}`;
    if (cmd.dryRun) return this.ack(cmd, t0, true, { detail: `dry run: ${label}` });

    const out = await this.queue(port.id, bytes, kind, key);
    if (!out.sent) {
      if (out.reason === 'coalesced') return this.ack(cmd, t0, true, { detail: `coalesced: a newer value for this CC replaced it (${label})` });
      if (out.reason === 'rate_limited') return this.fail(cmd, t0, 'rate_limited', `MIDI queue full (≤ ${this.scheduler.maxPerSecond} msg/s)`);
      if (out.reason === 'cleared') return this.fail(cmd, t0, 'device_error', 'dropped by panic');
      return this.fail(cmd, t0, 'device_error', out.error ?? 'send failed');
    }
    if (op.msg === 'note') {
      const ms = op.durationMs ?? 250;
      if (ms > 0) this.track(port.id, ch, op.number!, ms);
      else this.sounding.set(this.noteKey(port.id, ch, op.number!), { portId: port.id, channel: ch, note: op.number! });
      return this.ack(cmd, t0, true, { detail: ms > 0 ? `${label} for ${ms} ms` : `${label} (held until panic)` });
    }
    return this.ack(cmd, t0, true, { detail: label });
  }

  private noteKey(portId: string, channel: number, note: number): string {
    return `${portId}|${channel}|${note}`;
  }

  private track(portId: string, channel: number, note: number, durationMs: number): void {
    const k = this.noteKey(portId, channel, note);
    const prev = this.sounding.get(k);
    if (prev?.timer !== undefined) this.clock.clear(prev.timer);
    const t: Tracked = { portId, channel, note };
    t.timer = this.clock.set(() => {
      t.timer = undefined;
      if (this.sounding.get(k) === t) this.sounding.delete(k);
      void this.queue(portId, noteOff(channel, note), 'note-off');
    }, durationMs);
    this.sounding.set(k, t);
  }

  /** Hold a note until releaseNote (spikes); returns false when it could not be sent. */
  async holdNote(portId: string, channel: number, note: number, velocity = 100): Promise<boolean> {
    const out = await this.queue(portId, noteOn(channel, note, velocity), 'note-on');
    if (!out.sent) return false;
    const k = this.noteKey(portId, channel, note);
    const prev = this.sounding.get(k);
    if (prev?.timer !== undefined) this.clock.clear(prev.timer);
    this.sounding.set(k, { portId, channel, note });
    return true;
  }

  async releaseNote(portId: string, channel: number, note: number): Promise<void> {
    const k = this.noteKey(portId, channel, note);
    const t = this.sounding.get(k);
    if (t?.timer !== undefined) this.clock.clear(t.timer);
    this.sounding.delete(k);
    await this.queue(portId, noteOff(channel, note), 'note-off');
  }

  /** Send one CC through the limiter (spikes and local tests). */
  async cc(portId: string, channel: number, cc: number, value: number): Promise<boolean> {
    const bytes = controlChange(channel, cc, value);
    const why = unsafeReason(this.portName(portId), bytes);
    if (why) throw new Error(why);
    const out = await this.queue(portId, bytes, 'cc', `${portId}|${bytes[0]}|${bytes[1]}`);
    return out.sent || out.reason === 'coalesced';
  }

  /**
   * All notes off: drop queued messages, note-off every tracked note, then CC 64=0, CC 123 and
   * CC 120 on all 16 channels, paced 1 ms apart with Web MIDI timestamps (Move truncates bursts).
   * Without a port: every output. Returns the number of messages scheduled.
   */
  panic(port?: string): number {
    this.scheduler.clear();
    const outs = port ? [resolvePort(this.io.outputs(), port).port].filter((p): p is MidiPortLike => Boolean(p)) : this.io.outputs().filter((p) => p.state !== 'disconnected');
    const ids = new Set(outs.map((o) => o.id));
    const t0 = this.clock.now();
    let n = 0;
    for (const id of ids) {
      const msgs: number[][] = [];
      for (const [k, t] of this.sounding) {
        if (t.portId !== id) continue;
        if (t.timer !== undefined) this.clock.clear(t.timer);
        this.sounding.delete(k);
        msgs.push(noteOff(t.channel, t.note));
      }
      for (let ch = 1; ch <= 16; ch++) msgs.push(controlChange(ch, 64, 0), controlChange(ch, 123, 0), controlChange(ch, 120, 0));
      msgs.forEach((m, i) => {
        try {
          this.rawSend(id, m, t0 + i);
          n++;
        } catch {
          // port vanished mid-panic: nothing else to do
        }
      });
    }
    return n;
  }

  /** Send the identity request and wait for the first identity-shaped reply on any input. */
  identify(portId: string, timeoutMs = this.identityTimeoutMs): Promise<IdentityResult> {
    const outName = this.portName(portId).toLowerCase();
    const t0 = this.clock.now();
    return new Promise<IdentityResult>((resolve) => {
      let done = false;
      let fallback: IdentityResult | undefined;
      const finish = (r: IdentityResult) => {
        if (done) return;
        done = true;
        off();
        this.clock.clear(timer);
        resolve(r);
      };
      const off = this.io.addListener((m) => {
        if (m.data[0] !== 0xf0 || m.data[1] !== 0x7e || m.data[3] !== 0x06 || m.data[4] !== 0x02) return;
        const bytes = Array.from(m.data);
        this.record({ at: this.wallNow(), dir: 'in', port: m.portName, bytes, note: 'identity reply' });
        const r: IdentityResult = { reply: parseIdentityReply(bytes), bytes, hex: toHex(bytes), inputName: m.portName, ms: this.clock.now() - t0 };
        // the input with the output's name is the device we asked; keep others as a fallback
        if (m.portName.toLowerCase() === outName || outName.includes(m.portName.toLowerCase()) || m.portName.toLowerCase().includes(outName)) finish(r);
        else fallback ??= r;
      });
      const timer = this.clock.set(() => finish(fallback ?? { ms: this.clock.now() - t0 }), timeoutMs);
      try {
        this.rawSend(portId, [...IDENTITY_REQUEST]);
      } catch (e) {
        finish({ ms: 0, inputName: (e as Error).message });
      }
    });
  }
}
