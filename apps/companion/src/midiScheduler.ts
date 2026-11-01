/**
 * Outgoing MIDI pacing, deterministic and clock-injectable (unit tested):
 * - at most `maxPerSecond` messages in any rolling second (default 200, SPEC §3.2);
 * - CCs carry a key (port|status|cc): while one is queued a newer value replaces it in place
 *   ("latest wins", the old one resolves as coalesced), and one key is sent at most every
 *   `keyIntervalMs` (default 15 ms ≈ 66 Hz; TE suggests 30-60 msg/s per parameter);
 * - note-offs are never dropped, even when the queue is full;
 * - everything else keeps FIFO order.
 */

export interface Clock {
  now(): number;
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => performance.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export type SendKind = 'cc' | 'note-on' | 'note-off' | 'pc' | 'sysex' | 'other';

export type SendOutcome =
  | { sent: true; at: number }
  | { sent: false; reason: 'coalesced' | 'rate_limited' | 'cleared' | 'error'; error?: string };

export interface QueueItem {
  portId: string;
  bytes: number[];
  kind: SendKind;
  /** coalescing key (CCs only) */
  key?: string;
  done: (outcome: SendOutcome) => void;
}

export interface SchedulerOptions {
  maxPerSecond?: number;
  keyIntervalMs?: number;
  maxQueue?: number;
  clock?: Clock;
}

export class MidiScheduler {
  readonly maxPerSecond: number;
  readonly keyIntervalMs: number;
  readonly maxQueue: number;
  private readonly clock: Clock;
  private queue: QueueItem[] = [];
  private sentTimes: number[] = [];
  private readonly lastByKey = new Map<string, number>();
  private timer: unknown;
  /** messages sent / coalesced / refused since start (for the UI) */
  readonly stats = { sent: 0, coalesced: 0, refused: 0 };

  constructor(
    private readonly send: (portId: string, bytes: number[]) => void,
    opts: SchedulerOptions = {},
  ) {
    this.maxPerSecond = opts.maxPerSecond ?? 200;
    this.keyIntervalMs = opts.keyIntervalMs ?? 15;
    this.maxQueue = opts.maxQueue ?? 512;
    this.clock = opts.clock ?? realClock;
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Messages sent in the last rolling second. */
  rate(): number {
    return this.windowCount(this.clock.now());
  }

  enqueue(item: QueueItem): void {
    if (item.key) {
      const i = this.queue.findIndex((q) => q.key === item.key);
      if (i >= 0) {
        const old = this.queue[i];
        this.queue[i] = item;
        this.stats.coalesced++;
        old.done({ sent: false, reason: 'coalesced' });
        this.pump();
        return;
      }
    }
    if (this.queue.length >= this.maxQueue && item.kind !== 'note-off') {
      this.stats.refused++;
      item.done({ sent: false, reason: 'rate_limited' });
      return;
    }
    this.queue.push(item);
    this.pump();
  }

  /** Drop queued items (e.g. on panic). Returns how many were dropped. */
  clear(match: (q: QueueItem) => boolean = () => true): number {
    const keep: QueueItem[] = [];
    const dropped: QueueItem[] = [];
    for (const q of this.queue) (match(q) ? dropped : keep).push(q);
    this.queue = keep;
    for (const q of dropped) q.done({ sent: false, reason: 'cleared' });
    if (!this.queue.length && this.timer !== undefined) {
      this.clock.clear(this.timer);
      this.timer = undefined;
    }
    return dropped.length;
  }

  private windowCount(now: number): number {
    while (this.sentTimes.length && now - this.sentTimes[0] >= 1000) this.sentTimes.shift();
    return this.sentTimes.length;
  }

  /** Send everything that is allowed now; schedule a wake-up for the rest. */
  pump(): void {
    if (this.timer !== undefined) {
      this.clock.clear(this.timer);
      this.timer = undefined;
    }
    const now = this.clock.now();
    let wakeIn = Infinity;
    let i = 0;
    while (i < this.queue.length) {
      if (this.windowCount(now) >= this.maxPerSecond) {
        wakeIn = Math.min(wakeIn, this.sentTimes[0] + 1000 - now);
        break;
      }
      const q = this.queue[i];
      if (q.key) {
        const last = this.lastByKey.get(q.key);
        if (last !== undefined && now - last < this.keyIntervalMs) {
          wakeIn = Math.min(wakeIn, last + this.keyIntervalMs - now);
          i++;
          continue;
        }
      }
      this.queue.splice(i, 1);
      try {
        this.send(q.portId, q.bytes);
      } catch (e) {
        q.done({ sent: false, reason: 'error', error: (e as Error).message });
        continue;
      }
      this.sentTimes.push(now);
      if (q.key) this.lastByKey.set(q.key, now);
      this.stats.sent++;
      q.done({ sent: true, at: now });
    }
    if (this.queue.length && Number.isFinite(wakeIn)) {
      this.timer = this.clock.set(
        () => {
          this.timer = undefined;
          this.pump();
        },
        Math.max(1, Math.ceil(wakeIn)),
      );
    }
  }
}

/** A manual clock for tests and simulations. */
export class FakeClock implements Clock {
  t = 0;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 1;

  now(): number {
    return this.t;
  }

  set(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  }

  clear(handle: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== handle);
  }

  /** Advance time, firing due timers in order. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}
