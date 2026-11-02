import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { expandedRayBounds, OneEuroRayFilter, PinchTargetHistory, rayTargetWithinAngle } from './precision';

const ray = (degrees: number): Vector3 => new Vector3(Math.sin(degrees * Math.PI / 180), 0, -Math.cos(degrees * Math.PI / 180));

describe('One Euro hand rays', () => {
  it('suppresses resting jitter without changing unit direction or allocating output storage', () => {
    const filter = new OneEuroRayFilter();
    const origin = new Vector3(), direction = ray(0), filteredOrigin = new Vector3(), filteredDirection = new Vector3();
    filter.update(origin, direction, 0, filteredOrigin, filteredDirection);
    let largestOrigin = 0, largestAngle = 0;
    for (let index = 1; index <= 90; index++) {
      origin.x = index % 2 ? 0.005 : -0.005;
      direction.copy(ray(index % 2 ? 1 : -1));
      filter.update(origin, direction, index * 1000 / 90, filteredOrigin, filteredDirection);
      largestOrigin = Math.max(largestOrigin, Math.abs(filteredOrigin.x));
      largestAngle = Math.max(largestAngle, Math.abs(Math.asin(filteredDirection.x)));
      expect(filteredDirection.length()).toBeCloseTo(1, 10);
    }
    expect(largestOrigin).toBeLessThan(0.001);
    expect(largestAngle * 180 / Math.PI).toBeLessThan(0.2);
  });

  it('follows deliberate movement and resumes without a long sweep after tracking loss', () => {
    const filter = new OneEuroRayFilter();
    const origin = new Vector3(), direction = ray(0);
    filter.update(origin, direction, 0, origin, direction);
    for (let index = 1; index <= 90; index++) {
      origin.set(0.3, 0, 0); direction.copy(ray(30));
      filter.update(origin, direction, index * 1000 / 90, origin, direction);
    }
    expect(origin.x).toBeCloseTo(0.3, 2);
    expect(direction.angleTo(ray(30))).toBeLessThan(0.002);
    origin.set(1, 2, 3); direction.copy(ray(-45));
    filter.update(origin, direction, 1600, origin, direction);
    expect(origin.toArray()).toEqual([1, 2, 3]);
    expect(direction.angleTo(ray(-45))).toBeCloseTo(0);
  });

  it('is time based across headset frame rates and resets cleanly', () => {
    const run = (hz: number) => {
      const filter = new OneEuroRayFilter();
      const origin = new Vector3(), direction = ray(0), out = new Vector3();
      filter.update(origin, direction, 0, out, direction);
      for (let index = 1; index <= hz / 2; index++) filter.update(origin.set(1, 0, 0), ray(20), index * 1000 / hz, out, direction);
      filter.reset();
      const before = out.x;
      filter.update(origin.set(2, 0, 0), ray(0), 510, out, direction);
      expect(out.x).toBe(2);
      return before;
    };
    expect(Math.abs(run(72) - run(120))).toBeLessThan(0.01);
  });
});

describe('pre-pinch target compensation', () => {
  it('recovers the target hovered 120 ms earlier after a small pinch ray jump', () => {
    const history = new PinchTargetHistory<string>(), origin = new Vector3();
    history.record(0, 'older', origin, ray(-10));
    history.record(40, 'intended', origin, ray(0));
    history.record(70, 'recent', origin, ray(0));
    history.record(140, 'intended', origin, ray(0));
    expect(history.compensate(160, 'neighbor', origin, ray(2))).toBe('intended');
    expect(history.compensate(160, null, origin, ray(2))).toBe('intended');
  });

  it('keeps the current target without a ray jump and rejects stale, missing or too-short hover history', () => {
    const history = new PinchTargetHistory<string>(), origin = new Vector3();
    history.record(10, 'old', origin, ray(0));
    expect(history.compensate(130, 'current', origin, ray(0.5))).toBe('current');
    expect(history.compensate(161, 'current', origin, ray(2))).toBe('current');
    history.reset();
    history.record(100, 'old', origin, ray(0));
    expect(history.compensate(120, 'current', origin, ray(2))).toBe('current');
    history.record(120, null, origin, ray(0));
    expect(history.compensate(240, 'current', origin, ray(2))).toBe('current');
    history.reset();
    expect(history.compensate(240, 'current', origin, ray(2))).toBe('current');
  });

  it('handles wrapped frame storage and translation during the pinch', () => {
    const history = new PinchTargetHistory<string>(), origin = new Vector3();
    for (let index = 0; index < 100; index++) history.record(index * 10, String(index), origin, ray(0));
    expect(history.compensate(1000, 'now', new Vector3(0.02, 0, 0), ray(0))).toBe('88');
  });

  it('keeps a deliberately acquired target after a gradual sweep or a large ray movement', () => {
    const history = new PinchTargetHistory<string>(), origin = new Vector3();
    history.record(0, 'old', origin, ray(0));
    history.record(90, 'current', origin, ray(1.5));
    history.record(110, 'current', origin, ray(1.9));
    expect(history.compensate(120, 'current', origin, ray(2))).toBe('current');
    expect(history.compensate(120, 'current', origin, ray(8))).toBe('current');
  });

  it('does not infer an abrupt jump when there is no ray sample in the last 30 ms', () => {
    const history = new PinchTargetHistory<string>(), origin = new Vector3();
    history.record(0, 'old', origin, ray(0));
    history.record(80, 'old', origin, ray(0));
    expect(history.compensate(120, 'current', origin, ray(2))).toBe('current');
  });
});

describe('ray target assistance', () => {
  it('expands ray bounds 1.3 times without changing physical poke bounds', () => {
    expect(expandedRayBounds(0.064, 0.032, 0.1, 0.05)).toBe(true);
    expect(expandedRayBounds(0.066, 0, 0.1, 0.05)).toBe(false);
    expect(expandedRayBounds(0, -0.033, 0.1, 0.05)).toBe(false);
  });

  it('snaps only to targets in front and within the three degree cone', () => {
    const origin = new Vector3(), direction = ray(0);
    expect(rayTargetWithinAngle(origin, direction, ray(2.9).multiplyScalar(2))).toBeCloseTo(2);
    expect(rayTargetWithinAngle(origin, direction, ray(3.1))).toBe(Infinity);
    expect(rayTargetWithinAngle(origin, direction, new Vector3(0, 0, 1))).toBe(Infinity);
    expect(rayTargetWithinAngle(origin, new Vector3(), new Vector3(0, 0, -1))).toBe(Infinity);
  });
});
