import type { YoloEp } from './protocol';

/** DevTools snapshot. Inference percentiles cover the last 64 completed frames. */
export interface YoloStats {
  backend: YoloEp | 'off' | 'loading' | 'error';
  inferMs: { p50: number; p95: number };
  hz: number;
  boxes: number;
  /** Frame opportunities skipped, failed or discarded; never the number of filtered objects. */
  dropped: number;
}

export class YoloTelemetry {
  readonly value: YoloStats = { backend: 'off', inferMs: { p50: 0, p95: 0 }, hz: 0, boxes: 0, dropped: 0 };
  private readonly inference: number[] = [];
  private readonly results: number[] = [];

  result(now: number, inferMs: number): void {
    if (Number.isFinite(inferMs) && inferMs >= 0) {
      this.inference.push(inferMs);
      if (this.inference.length > 64) this.inference.shift();
      const sorted = [...this.inference].sort((a, b) => a - b);
      this.value.inferMs.p50 = sorted[Math.ceil(sorted.length * 0.5) - 1]!;
      this.value.inferMs.p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
    }
    this.results.push(now);
    this.tick(now);
  }

  tick(now: number): void {
    while (this.results.length && now - this.results[0]! >= 1000) this.results.shift();
    this.value.hz = this.results.length;
  }
}
