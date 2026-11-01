/** Typed event emitter and the sink interface the renderer writes control events to (console, protocol, sim). */
import type { ControlEvent } from '@ce/gen3d';

export type Listener<T> = (e: T) => void;

export class Emitter<Events extends object> {
  private map = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(k: K, fn: Listener<Events[K]>): () => void {
    let set = this.map.get(k);
    if (!set) this.map.set(k, (set = new Set()));
    set.add(fn as Listener<never>);
    return () => set!.delete(fn as Listener<never>);
  }

  emit<K extends keyof Events>(k: K, e: Events[K]): void {
    const set = this.map.get(k);
    if (!set) return;
    for (const fn of set) (fn as Listener<Events[K]>)(e);
  }
}

/** Where control events go. The renderer never talks to a socket; sinks do. */
export interface EventSink {
  control(e: ControlEvent): void;
}

export class ConsoleSink implements EventSink {
  control(e: ControlEvent): void {
    console.log(`[gen3d] ${e.specId} ${e.controlId}${e.index !== undefined ? `[${e.index}]` : ''} ${e.phase} ${JSON.stringify(e.value)}`);
  }
}

/** Fan out to several sinks. */
export class MultiSink implements EventSink {
  constructor(private sinks: EventSink[]) {}
  add(s: EventSink): void {
    this.sinks.push(s);
  }
  control(e: ControlEvent): void {
    for (const s of this.sinks) s.control(e);
  }
}

/**
 * Rate limiter for a stream of move events: at most `hz` per control, always delivering start/end and the
 * last value. 30 Hz matches the companion's MIDI rate limits.
 */
export class RateLimitedSink implements EventSink {
  private last = new Map<string, number>();
  private pending = new Map<string, ControlEvent>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private inner: EventSink, private hz = 30) {}
  control(e: ControlEvent): void {
    const key = `${e.specId}/${e.controlId}/${e.index ?? ''}`;
    const now = performance.now();
    const minGap = 1000 / this.hz;
    if (e.phase !== 'move') {
      this.pending.delete(key);
      this.last.set(key, now);
      this.inner.control(e);
      return;
    }
    const prev = this.last.get(key) ?? 0;
    if (now - prev >= minGap) {
      this.last.set(key, now);
      this.pending.delete(key);
      this.inner.control(e);
    } else {
      this.pending.set(key, e);
      if (!this.timer) this.timer = setTimeout(() => this.flush(), minGap);
    }
  }
  private flush(): void {
    this.timer = null;
    const now = performance.now();
    for (const [key, e] of this.pending) {
      this.last.set(key, now);
      this.inner.control(e);
    }
    this.pending.clear();
  }
}

/** Shape of @ce/protocol's control.event payload (kept local so this module has no protocol dependency). */
export interface ControlEventPayloadLike {
  widgetId: string;
  value: ControlEvent['value'];
  ts: number;
  specId?: string;
  index?: number;
  phase?: 'start' | 'move' | 'end';
}

export function toControlEventPayload(e: ControlEvent): ControlEventPayloadLike {
  const out: ControlEventPayloadLike = { widgetId: e.controlId, value: e.value, ts: e.ts, specId: e.specId, phase: e.phase };
  if (e.index !== undefined) out.index = e.index;
  return out;
}
