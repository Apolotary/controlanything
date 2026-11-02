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
}

/** a sensor whose last request timed out is avoided for this long when another one is online */
export const SENSE_UNHEALTHY_MS = 30_000;

interface SenseCollector extends Pending<SenseResultPayload[]> {
  sensorDeviceId: string;
  results: SenseResultPayload[];
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
  /** Rechecked at the send boundary, including rate-limited and trailing operations. */
  canExec?: (request: ExecRequest) => boolean;
}

export interface ExecRequest {
  executorDeviceId: string;
  op: ExecOp;
  port?: string;
  cardId?: string;
  driverId?: string;
  actionId?: string;
  dryRun?: boolean;
}

export type ExecResult = (ok: boolean, detail?: string) => void;
interface FireOptions {
  /** Performance gestures freeze immediately: a missed send is never queued. */
  dropIfLimited?: boolean;
  port?: string;
  cardId?: string;
  driverId?: string;
  actionId?: string;
  lightCap?: boolean;
  onResult?: ExecResult;
}

export class Dispatcher {
  private readonly acks = new Map<string, Pending<ExecAckPayload>>();
  private readonly controlAcks = new Map<string, string | undefined>();
  private readonly senses = new Map<string, SenseCollector>();
  /** sensor device id -> when its last sense.request timed out (cleared by the next good reply) */
  private readonly senseTimeouts = new Map<string, number>();
  private readonly limiters = new Map<string, RateLimiter>();
  private readonly slotWaits = new Set<() => void>();
  private readonly trailing = new Map<string, { op: ExecOp; opts: FireOptions; timer: ReturnType<typeof setTimeout> }>();
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
    this.checkSignal(opts.signal);
    this.checkExec({ ...opts, executorDeviceId, op });
    const limiter = this.limiter(executorDeviceId, op, Boolean(opts.lightCap));
    while (!limiter.take()) {
      if (!opts.waitForSlot) throw new ExecError(`rate limit for ${executorDeviceId}:${op.kind}`, 'rate_limited');
      await this.waitForSlot(limiter.waitMs(), opts.signal);
    }
    this.checkSignal(opts.signal);
    this.checkExec({ ...opts, executorDeviceId, op });
    const execId = newId('x');
    const at = Date.now();
    const record = { execId, executorDeviceId, op, at } as (typeof this.sent)[number];
    this.sent.push(record);
    if (this.sent.length > 500) this.sent.shift();

    if (executorDeviceId === MAC_LOCAL_ID) {
      if (!this.o.macLocal) throw new ExecError('the Mac executor is not available', 'offline');
      const r = await this.o.macLocal.exec(op, opts.dryRun);
      this.checkSignal(opts.signal);
      const ack: ExecAckPayload = { execId, ok: r.ok, sentAt: Date.now(), detail: r.detail, error: r.error, latencyMs: Date.now() - at };
      record.ack = ack;
      if (!ack.ok) throw new ExecError(ack.detail ?? 'local executor refused', 'device', ack);
      return ack;
    }

    const payload = { execId, executorDeviceId, op, port: opts.port, dryRun: opts.dryRun, cardId: opts.cardId, driverId: opts.driverId, actionId: opts.actionId };
    const ack = await new Promise<ExecAckPayload>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        return this.acks.delete(execId);
      };
      const pending: Pending<ExecAckPayload> = {
        resolve: (value) => { if (cleanup()) resolve(value); },
        reject: (error) => { if (cleanup()) reject(error); },
      };
      const onAbort = () => pending.reject(new ExecError('cancelled', 'refused'));
      const timer = setTimeout(() => {
        pending.reject(new ExecError(`no exec.ack from ${executorDeviceId} within ${opts.timeoutMs ?? this.o.ackTimeoutMs ?? 3000} ms`, 'timeout'));
      }, opts.timeoutMs ?? this.o.ackTimeoutMs ?? 3000);
      this.acks.set(execId, pending);
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      if (opts.signal?.aborted) return onAbort();
      try {
        if (!this.o.hub.sendToDevice(executorDeviceId, 'exec.command', payload)) pending.reject(new ExecError(`executor ${executorDeviceId} is offline`, 'offline'));
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    record.ack = ack;
    if (!ack.ok) throw new ExecError(`${executorDeviceId} refused: ${ack.error ?? ''} ${ack.detail ?? ''}`.trim(), 'device', ack);
    return ack;
  }

  private checkSignal(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ExecError('cancelled', 'refused');
  }

  private checkExec(request: ExecRequest): void {
    if (this.o.canExec && !this.o.canExec(request)) throw new ExecError('control is not authorized for this device', 'refused');
  }

  private waitForSlot(ms: number, signal?: AbortSignal): Promise<void> {
    this.checkSignal(signal);
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.slotWaits.delete(onAbort);
      };
      const onAbort = () => { cleanup(); reject(new ExecError('cancelled', 'refused')); };
      const timer = setTimeout(() => { cleanup(); resolve(); }, Math.max(1, ms));
      this.slotWaits.add(onAbort);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  /**
   * Fire without waiting for the ack (the control loop). Rate-limited ops are coalesced latest-wins per
   * executor and action and sent when the limiter allows (a trailing edge, so the last knob position always
   * lands). Returns false when authorization is refused or the executor is offline.
   */
  fire(executorDeviceId: string, op: ExecOp, opts: FireOptions = {}): boolean {
    if (this.o.canExec && !this.o.canExec({ ...opts, executorDeviceId, op })) {
      opts.onResult?.(false, 'Control is no longer authorized');
      return false;
    }
    const limiter = this.limiter(executorDeviceId, op, Boolean(opts.lightCap));
    // Stop must reach the executor before the caller disarms and clears queued work.
    if (!(op.kind === 'midi' && op.msg === 'panic') && !limiter.take()) {
      if (opts.dropIfLimited) {
        opts.onResult?.(false, 'Rate limited');
        return false;
      }
      const key = `${executorDeviceId}:${opts.cardId ?? ''}:${op.kind}:${opts.actionId ?? (op.kind === 'midi' ? `${op.msg}:${op.channel}:${op.number ?? ''}` : op.kind)}`;
      const existing = this.trailing.get(key);
      if (existing) {
        existing.opts.onResult?.(false, 'Superseded by a newer command');
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
    const record = { execId, executorDeviceId, op, at: Date.now() } as (typeof this.sent)[number];
    this.sent.push(record);
    if (this.sent.length > 500) this.sent.shift();
    if (opts.onResult) {
      const done = (ok: boolean, detail?: string) => {
        if (!this.acks.delete(execId)) return;
        this.controlAcks.delete(execId);
        clearTimeout(timer);
        opts.onResult!(ok, detail);
      };
      const timer = setTimeout(() => done(false, 'Executor did not respond'), this.o.ackTimeoutMs ?? 3000);
      this.acks.set(execId, { resolve: (ack) => done(ack.ok, ack.detail ?? ack.error), reject: (error) => done(false, error.message) });
      this.controlAcks.set(execId, opts.cardId);
    }
    if (executorDeviceId === MAC_LOCAL_ID) {
      if (!this.o.macLocal) { this.acks.get(execId)?.reject(new ExecError('Mac executor is offline', 'offline')); return false; }
      void this.o.macLocal.exec(op).then((r) => {
        record.ack = { execId, ok: r.ok, sentAt: Date.now(), detail: r.detail, error: r.error };
        this.acks.get(execId)?.resolve(record.ack);
        if (!r.ok) this.log(`[exec] mac-local ${op.kind === 'local' ? op.op : op.kind}: ${r.detail}`);
      }).catch((error: unknown) => this.acks.get(execId)?.reject(error instanceof Error ? error : new Error(String(error))));
      return true;
    }
    try {
      const sent = this.o.hub.sendToDevice(executorDeviceId, 'exec.command', { execId, executorDeviceId, op, port: opts.port, cardId: opts.cardId, driverId: opts.driverId, actionId: opts.actionId }) > 0;
      if (!sent) this.acks.get(execId)?.reject(new ExecError('Executor is offline', 'offline'));
      return sent;
    } catch (error) {
      this.acks.get(execId)?.reject(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  /** Feed an exec.ack from the hub. */
  onAck(ack: ExecAckPayload): boolean {
    const p = this.acks.get(ack.execId);
    const rec = this.sent.find((s) => s.execId === ack.execId);
    if (rec) rec.ack = ack;
    if (!p) return false;
    p.resolve(ack);
    return true;
  }

  /**
   * Ask a sensor and wait. frame / audio-features resolve on the first result; ir-capture collects every
   * result until `durationMs` (+ grace) has passed.
   */
  async sense(sensorDeviceId: string, kind: SenseKind, opts: { durationMs?: number; offsetMs?: number; cardId?: string; prompt?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<SenseResultPayload[]> {
    this.checkSignal(opts.signal);
    const senseId = newId('sn');
    const payload: SenseRequestPayload = { senseId, sensorDeviceId, kind };
    if (opts.durationMs !== undefined) payload.durationMs = opts.durationMs;
    if (opts.offsetMs !== undefined) payload.offsetMs = opts.offsetMs;
    if (opts.cardId) payload.cardId = opts.cardId;
    if (opts.prompt) payload.prompt = opts.prompt;
    const collect = kind === 'ir-capture';
    const timeoutMs = opts.timeoutMs ?? (collect ? (opts.durationMs ?? 15_000) + 1500 : Math.max(4000, (opts.durationMs ?? 0) + 4000));
    return new Promise<SenseResultPayload[]>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        if (collector.grace) clearTimeout(collector.grace);
        opts.signal?.removeEventListener('abort', onAbort);
        return this.senses.delete(senseId);
      };
      const collector: SenseCollector = {
        sensorDeviceId, results: [], collect,
        resolve: (value) => { if (cleanup()) resolve(value); },
        reject: (error) => { if (cleanup()) reject(error); },
      };
      const onAbort = () => collector.reject(new ExecError('cancelled', 'refused'));
      const timer = setTimeout(() => {
        if (collect) collector.resolve(collector.results);
        else {
          this.senseTimeouts.set(sensorDeviceId, Date.now());
          collector.reject(new ExecError(`no sense.result (${kind}) from ${sensorDeviceId} within ${timeoutMs} ms`, 'timeout'));
        }
      }, timeoutMs);
      this.senses.set(senseId, collector);
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      if (opts.signal?.aborted) return onAbort();
      try {
        if (!this.o.hub.sendToDevice(sensorDeviceId, 'sense.request', payload)) collector.reject(new ExecError(`sensor ${sensorDeviceId} is offline`, 'offline'));
      } catch (error) {
        collector.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Feed a sense.result from the hub. */
  /** Did this sensor's last sense.request time out within the last ~30 s (and no good reply since)? */
  unhealthy(deviceId: string, withinMs = SENSE_UNHEALTHY_MS): boolean {
    const at = this.senseTimeouts.get(deviceId);
    return at !== undefined && Date.now() - at < withinMs;
  }

  onSense(r: SenseResultPayload): boolean {
    const c = this.senses.get(r.senseId);
    if (!c) return false;
    if (r.ok !== false) this.senseTimeouts.delete(c.sensorDeviceId);
    if (r.ok === false && !c.collect) {
      c.resolve([r]);
      return true;
    }
    c.results.push(r);
    if (!c.collect) {
      c.resolve(c.results);
    } else if (!c.grace) {
      c.grace = setTimeout(() => {
        c.resolve(c.results);
      }, IR_CAPTURE_GRACE_MS);
    }
    return true;
  }

  pendingSenseIds(): string[] {
    return [...this.senses.keys()];
  }

  /** Drop queued operations and control acknowledgement waits for one target, or all on panic. */
  flushQueued(cardId?: string): number {
    let n = 0;
    for (const [key, queued] of this.trailing) {
      if (cardId !== undefined && queued.opts.cardId !== cardId) continue;
      clearTimeout(queued.timer);
      this.trailing.delete(key);
      queued.opts.onResult?.(false, 'Command cancelled');
      n++;
    }
    for (const [execId, owner] of this.controlAcks) {
      if (cardId !== undefined && owner !== cardId) continue;
      this.acks.get(execId)?.reject(new ExecError('Command cancelled', 'refused'));
      n++;
    }
    return n;
  }

  close(): void {
    this.flushQueued();
    for (const cancel of this.slotWaits) cancel();
    for (const p of this.acks.values()) {
      p.reject(new ExecError('server closing', 'refused'));
    }
    this.acks.clear();
    for (const c of this.senses.values()) {
      c.resolve(c.results);
    }
    this.senses.clear();
  }
}
