/**
 * The only way anything reaches a device: exec.command out, exec.ack back (matched by execId), with per-
 * executor rate limits (MIDI <= 200/s, IR <= 4 Hz, visible light <= 3 Hz) and the in-process Mac executor.
 * Also sense.request / sense.result pairing for the oracles and IR learning.
 */
import { type ExecAckPayload, type ExecOp, newId, RATE_LIMITS, type SenseKind, type SenseRequestPayload, type SenseResultPayload } from '@ce/protocol';
import type { Hub } from '../hub';
import { MAC_LOCAL_ID, type MacLocalExecutor } from './maclocal';

export class ExecError extends Error {
  constructor(
    message: string,
    readonly code: 'offline' | 'timeout' | 'rate_limited' | 'refused' | 'device',
    readonly ack?: ExecAckPayload,
  ) {
    super(message);
    this.name = 'ExecError';
  }
}

interface Pending<T> {
  resolve: (v: T) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface SenseCollector {
  results: SenseResultPayload[];
  resolve: (v: SenseResultPayload[]) => void;
  timer: ReturnType<typeof setTimeout>;
  /** resolve on the first result (frame/audio) or collect until the timer (ir-capture) */
  collect: boolean;
  /** ir-capture: once a press arrived, wait only this long for a second frame before resolving */
  grace?: ReturnType<typeof setTimeout>;
}

/** After the first captured press, the learn window closes this soon (a human presses once; the sim too). */
export const IR_CAPTURE_GRACE_MS = 700;

/** Token bucket: `rate` tokens per second, burst `burst`. */
export class RateLimiter {
  private tokens: number;
  private last: number;
  constructor(
    private readonly rate: number,
    private readonly burst: number = Math.max(1, Math.ceil(rate / 4)),
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.last = now();
  }
  /** Try to take one token; false when the caller must wait. */
  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
  /** Milliseconds until a token is available. */
  waitMs(): number {
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.rate) * 1000);
  }
}

export interface DispatcherOptions {
  hub: Pick<Hub, 'sendToDevice'>;
  macLocal?: MacLocalExecutor;
  log?: (line: string) => void;
  /** ack timeout per op kind */
  ackTimeoutMs?: number;
  now?: () => number;
}

export class Dispatcher {
  private readonly acks = new Map<string, Pending<ExecAckPayload>>();
  private readonly senses = new Map<string, SenseCollector>();
  private readonly limiters = new Map<string, RateLimiter>();
  private readonly trailing = new Map<string, { op: ExecOp; opts: { port?: string; cardId?: string; driverId?: string; actionId?: string; lightCap?: boolean }; timer: ReturnType<typeof setTimeout> }>();
  private readonly log: (line: string) => void;
  /** every exec sent, for the black-box monitor */
  readonly sent: { execId: string; executorDeviceId: string; op: ExecOp; at: number; ack?: ExecAckPayload }[] = [];

  constructor(private readonly o: DispatcherOptions) {
    this.log = o.log ?? (() => {});
  }

  private limiter(executorDeviceId: string, op: ExecOp, lightCap: boolean): RateLimiter {
    const key = `${executorDeviceId}:${op.kind}${lightCap ? ':light' : ''}`;
    let l = this.limiters.get(key);
    if (!l) {
      const rate = lightCap ? RATE_LIMITS.lightChangesPerSec : op.kind === 'midi' ? RATE_LIMITS.midiPerSec : op.kind === 'ir' ? RATE_LIMITS.irPerSec : 10;
      l = new RateLimiter(rate, op.kind === 'midi' ? 50 : 1, this.o.now);
      this.limiters.set(key, l);
    }
    return l;
  }

  /** Would an exec go out right now (rate limit)? */
  canSend(executorDeviceId: string, op: ExecOp, lightCap = false): boolean {
    return this.limiter(executorDeviceId, op, lightCap).waitMs() === 0;
  }

  /**
   * Send one op and wait for its ack. `waitForSlot` sleeps until the rate limiter allows it (verification);
   * without it a rate-limited call fails fast (the control loop drops instead of queueing).
   */
  async exec(
    executorDeviceId: string,
    op: ExecOp,
    opts: { port?: string; dryRun?: boolean; cardId?: string; driverId?: string; actionId?: string; lightCap?: boolean; waitForSlot?: boolean; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<ExecAckPayload> {
    const limiter = this.limiter(executorDeviceId, op, Boolean(opts.lightCap));
    if (!limiter.take()) {
      if (!opts.waitForSlot) throw new ExecError(`rate limit for ${executorDeviceId}:${op.kind}`, 'rate_limited');
      await new Promise<void>((r) => setTimeout(r, limiter.waitMs()));
      limiter.take();
    }
    const execId = newId('x');
    const at = Date.now();
    const record = { execId, executorDeviceId, op, at } as (typeof this.sent)[number];
    this.sent.push(record);
    if (this.sent.length > 500) this.sent.shift();

    if (executorDeviceId === MAC_LOCAL_ID) {
      if (!this.o.macLocal) throw new ExecError('the Mac executor is not available', 'offline');
      const r = await this.o.macLocal.exec(op, opts.dryRun);
      const ack: ExecAckPayload = { execId, ok: r.ok, sentAt: Date.now(), detail: r.detail, error: r.error, latencyMs: Date.now() - at };
      record.ack = ack;
      if (!ack.ok) throw new ExecError(ack.detail ?? 'local executor refused', 'device', ack);
      return ack;
    }

    const payload = { execId, executorDeviceId, op, port: opts.port, dryRun: opts.dryRun, cardId: opts.cardId, driverId: opts.driverId, actionId: opts.actionId };
    const n = this.o.hub.sendToDevice(executorDeviceId, 'exec.command', payload);
    if (!n) throw new ExecError(`executor ${executorDeviceId} is offline`, 'offline');
    const ack = await new Promise<ExecAckPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.acks.delete(execId);
        reject(new ExecError(`no exec.ack from ${executorDeviceId} within ${opts.timeoutMs ?? this.o.ackTimeoutMs ?? 3000} ms`, 'timeout'));
      }, opts.timeoutMs ?? this.o.ackTimeoutMs ?? 3000);
      this.acks.set(execId, { resolve, reject, timer });
      opts.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        this.acks.delete(execId);
        reject(new ExecError('cancelled', 'refused'));
      });
    });
    record.ack = ack;
    if (!ack.ok) throw new ExecError(`${executorDeviceId} refused: ${ack.error ?? ''} ${ack.detail ?? ''}`.trim(), 'device', ack);
    return ack;
  }

  /**
   * Fire without waiting for the ack (the control loop). Rate-limited ops are coalesced latest-wins per
   * executor and action and sent when the limiter allows (a trailing edge, so the last knob position always
   * lands). Returns false only when the executor is offline.
   */
  fire(executorDeviceId: string, op: ExecOp, opts: { port?: string; cardId?: string; driverId?: string; actionId?: string; lightCap?: boolean } = {}): boolean {
    const limiter = this.limiter(executorDeviceId, op, Boolean(opts.lightCap));
    if (!limiter.take()) {
      const key = `${executorDeviceId}:${op.kind}:${opts.actionId ?? (op.kind === 'midi' ? `${op.msg}:${op.channel}:${op.number ?? ''}` : op.kind)}`;
      const existing = this.trailing.get(key);
      if (existing) {
        existing.op = op;
        existing.opts = opts;
        return true;
      }
      const entry = { op, opts, timer: setTimeout(() => {
        this.trailing.delete(key);
        this.fire(executorDeviceId, entry.op, entry.opts);
      }, Math.max(1, limiter.waitMs())) };
      this.trailing.set(key, entry);
      return true;
    }
    const execId = newId('x');
    this.sent.push({ execId, executorDeviceId, op, at: Date.now() });
    if (this.sent.length > 500) this.sent.shift();
    if (executorDeviceId === MAC_LOCAL_ID) {
      void this.o.macLocal?.exec(op).then((r) => {
        if (!r.ok) this.log(`[exec] mac-local ${op.kind === 'local' ? op.op : op.kind}: ${r.detail}`);
      });
      return true;
    }
    return this.o.hub.sendToDevice(executorDeviceId, 'exec.command', { execId, executorDeviceId, op, port: opts.port, cardId: opts.cardId, driverId: opts.driverId, actionId: opts.actionId }) > 0;
  }

  /** Feed an exec.ack from the hub. */
  onAck(ack: ExecAckPayload): boolean {
    const p = this.acks.get(ack.execId);
    const rec = this.sent.find((s) => s.execId === ack.execId);
    if (rec) rec.ack = ack;
    if (!p) return false;
    clearTimeout(p.timer);
    this.acks.delete(ack.execId);
    p.resolve(ack);
    return true;
  }

  /**
   * Ask a sensor and wait. frame / audio-features resolve on the first result; ir-capture collects every
   * result until `durationMs` (+ grace) has passed.
   */
  async sense(sensorDeviceId: string, kind: SenseKind, opts: { durationMs?: number; offsetMs?: number; cardId?: string; prompt?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<SenseResultPayload[]> {
    const senseId = newId('sn');
    const payload: SenseRequestPayload = { senseId, sensorDeviceId, kind };
    if (opts.durationMs !== undefined) payload.durationMs = opts.durationMs;
    if (opts.offsetMs !== undefined) payload.offsetMs = opts.offsetMs;
    if (opts.cardId) payload.cardId = opts.cardId;
    if (opts.prompt) payload.prompt = opts.prompt;
    const collect = kind === 'ir-capture';
    const timeoutMs = opts.timeoutMs ?? (collect ? (opts.durationMs ?? 15_000) + 1500 : Math.max(4000, (opts.durationMs ?? 0) + 4000));
    const n = this.o.hub.sendToDevice(sensorDeviceId, 'sense.request', payload);
    if (!n) throw new ExecError(`sensor ${sensorDeviceId} is offline`, 'offline');
    return new Promise<SenseResultPayload[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        const c = this.senses.get(senseId);
        this.senses.delete(senseId);
        if (collect) resolve(c?.results ?? []);
        else reject(new ExecError(`no sense.result (${kind}) from ${sensorDeviceId} within ${timeoutMs} ms`, 'timeout'));
      }, timeoutMs);
      this.senses.set(senseId, { results: [], resolve, timer, collect });
      opts.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        this.senses.delete(senseId);
        reject(new ExecError('cancelled', 'refused'));
      });
    });
  }

  /** Feed a sense.result from the hub. */
  onSense(r: SenseResultPayload): boolean {
    const c = this.senses.get(r.senseId);
    if (!c) return false;
    if (r.ok === false && !c.collect) {
      clearTimeout(c.timer);
      this.senses.delete(r.senseId);
      c.resolve([r]);
      return true;
    }
    c.results.push(r);
    if (!c.collect) {
      clearTimeout(c.timer);
      this.senses.delete(r.senseId);
      c.resolve(c.results);
    } else if (!c.grace) {
      c.grace = setTimeout(() => {
        if (!this.senses.has(r.senseId)) return;
        clearTimeout(c.timer);
        this.senses.delete(r.senseId);
        c.resolve(c.results);
      }, IR_CAPTURE_GRACE_MS);
    }
    return true;
  }

  pendingSenseIds(): string[] {
    return [...this.senses.keys()];
  }

  /** Drop every queued (trailing) op, e.g. on panic. */
  flushQueued(): number {
    const n = this.trailing.size;
    for (const t of this.trailing.values()) clearTimeout(t.timer);
    this.trailing.clear();
    return n;
  }

  close(): void {
    this.flushQueued();
    for (const p of this.acks.values()) {
      clearTimeout(p.timer);
      p.reject(new ExecError('server closing', 'refused'));
    }
    this.acks.clear();
    for (const c of this.senses.values()) {
      clearTimeout(c.timer);
      if (c.grace) clearTimeout(c.grace);
      c.resolve(c.results);
    }
    this.senses.clear();
  }
}
