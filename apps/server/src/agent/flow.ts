import { PHASE_TIMEOUT_MS, type TimedPhase } from './guidance';

export class PhaseTimeout extends Error {
  constructor(readonly phase: TimedPhase) {
    super(`${phase} timed out`);
  }
}

/** One deadline per phase, including retries. All waits settle even if a provider ignores abort. */
export class FlowRun {
  phase: TimedPhase = 'identify';
  private timer?: ReturnType<typeof setTimeout>;
  constructor(readonly abort: AbortController, private readonly limits: Partial<Record<TimedPhase, number>> = {}) {}

  enter(phase: TimedPhase): void {
    this.check();
    this.clear();
    this.phase = phase;
    this.timer = setTimeout(() => this.abort.abort(new PhaseTimeout(phase)), this.limits[phase] ?? PHASE_TIMEOUT_MS[phase]);
  }

  clear(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
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
