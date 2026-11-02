import { describe, expect, it } from 'vitest';
import { YoloTelemetry } from './stats';

describe('YOLO DevTools telemetry', () => {
  it('reports p50/p95 from a bounded window and a Hz count that decays to zero', () => {
    const stats = new YoloTelemetry();
    for (let n = 1; n <= 100; n++) stats.result(n * 100, n);
    expect(stats.value.inferMs).toEqual({ p50: 68, p95: 97 });
    expect(stats.value.hz).toBe(10);
    stats.tick(11000);
    expect(stats.value.hz).toBe(0);
  });
});
