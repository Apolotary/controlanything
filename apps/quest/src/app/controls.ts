/**
 * HUD control events → protocol control.event, at most `hz` per control (latest value wins; start/end and
 * discrete values go out at once). The deterministic control loop on the server does the rest (< 50 ms LAN).
 */
import type { ControlEvent } from '@ce/gen3d';
import type { PayloadOf } from '@ce/protocol';

export type ControlEventPayload = PayloadOf<'control.event'>;

export function toProtocol(e: ControlEvent): ControlEventPayload {
  const p: ControlEventPayload = { widgetId: e.controlId, value: e.value, ts: e.ts, phase: e.phase };
  if (e.specId) p.specId = e.specId;
  if (e.index !== undefined) p.index = e.index;
  return p;
}

export class ControlSender {
  private readonly last = new Map<string, number>();
  private readonly pending = new Map<string, { e: ControlEvent; timer: ReturnType<typeof setTimeout> }>();
  sent = 0;

  constructor(
    private readonly send: (p: ControlEventPayload) => void,
    private readonly hz = 30,
    private readonly now: () => number = () => performance.now(),
  ) {}

  push(e: ControlEvent): void {
    const key = `${e.specId}:${e.controlId}:${e.index ?? ''}`;
    const discrete = e.phase !== 'move' || typeof e.value !== 'number';
    const p = this.pending.get(key);
    if (discrete) {
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(key);
      }
      this.fire(key, e);
      return;
    }
    const gap = 1000 / this.hz;
    const since = this.now() - (this.last.get(key) ?? -Infinity);
    if (since >= gap && !p) {
      this.fire(key, e);
      return;
    }
    if (p) {
      p.e = e; // latest wins
      return;
    }
    const timer = setTimeout(() => {
      const q = this.pending.get(key);
      this.pending.delete(key);
      if (q) this.fire(key, q.e);
    }, Math.max(0, gap - since));
    this.pending.set(key, { e, timer });
  }

  /** Drop delayed moves as soon as the user leaves Control, cancels, or loses connectivity. */
  clear(): void {
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.last.clear();
  }

  private fire(key: string, e: ControlEvent): void {
    this.last.set(key, this.now());
    this.sent++;
    this.send(toProtocol(e));
  }
}
