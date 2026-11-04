import { PHASE_TIMEOUT_MS, type TimedPhase } from './guidance';

export class PhaseTimeout extends Error {
  constructor(readonly phase: TimedPhase) {
    super(`${phase} timed out`);
  }
}

/** One deadline per phase, including retries. All waits settle even if a provider ignores abort. */
export class FlowRun {
  phase: TimedPhase = 'identify';
  /** each finished phase and how long it took, in order */
  readonly timings: { phase: TimedPhase; ms: number }[] = [];
  readonly startedAt = Date.now();
  private timer?: ReturnType<typeof setTimeout>;
  private enteredAt?: number;
  constructor(readonly abort: AbortController, private readonly limits: Partial<Record<TimedPhase, number>> = {},
    private readonly onPhase?: (phase: TimedPhase, ms: number, limitMs: number) => void) {}

  enter(phase: TimedPhase): void {
    this.check();
    this.clear();
    this.phase = phase;
    this.enteredAt = Date.now();
    this.timer = setTimeout(() => this.abort.abort(new PhaseTimeout(phase)), this.limit(phase));
  }

  /** End the current phase (its timing is recorded once). */
  clear(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.enteredAt === undefined) return;
    const ms = Date.now() - this.enteredAt;
    this.enteredAt = undefined;
    this.timings.push({ phase: this.phase, ms });
    this.onPhase?.(this.phase, ms, this.limit(this.phase));
  }

  limit(phase: TimedPhase): number {
    return this.limits[phase] ?? PHASE_TIMEOUT_MS[phase];
  }

  check(): void {
    if (this.abort.signal.aborted) throw this.abort.signal.reason;
  }

  async wait<T>(work: Promise<T>): Promise<T> {
    const signal = this.abort.signal;
    let onAbort: () => void = () => {};
    const stopped = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const value = await Promise.race([work, stopped]);
      this.check();
      return value;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  async retry<T>(work: () => Promise<T>, onRetry: () => void): Promise<T> {
    try {
      return await this.wait(work());
    } catch (error) {
      this.check();
      onRetry();
      return this.wait(work());
    }
  }
}
