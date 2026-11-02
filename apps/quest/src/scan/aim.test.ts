import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { aimAt, touching, type AimHit, type AimTarget } from './aim';

describe('reusable target picking', () => {
  const origin = new Vector3();
  const targets: AimTarget[] = [
    { id: 'laptop', position: new Vector3(0.3, 0, -2), size: 0.6 },
    { id: 'remote', position: new Vector3(0, 0, -1), size: 0.1 },
  ];

  it('writes the best angular hit into supplied storage without changing input vectors', () => {
    const ray = new Vector3(0, 0, -3);
    const out: AimHit = { id: '', angleDeg: 0, distance: 0 };
    expect(aimAt(origin, ray, targets, {}, out)).toBe(out);
    expect(out).toEqual({ id: 'remote', angleDeg: 0, distance: 1 });
    expect(ray.toArray()).toEqual([0, 0, -3]);
    expect(targets[1].position.toArray()).toEqual([0, 0, -1]);
  });

  it('honors distance limits and angular margin with reusable output', () => {
    const out: AimHit = { id: '', angleDeg: 0, distance: 0 };
    expect(aimAt(origin, new Vector3(0, 0, -1), targets, { minDist: 1.5 }, out)?.id).toBe('laptop');
    expect(aimAt(origin, new Vector3(0, 0, -1), targets, { maxDist: 0.5 }, out)).toBeNull();
    expect(aimAt(origin, new Vector3(0, 0, -1), targets.slice(0, 1), { marginDeg: -1 }, out)).toBeNull();
  });

  it('returns null on a miss and leaves the previous output intact', () => {
    const out: AimHit = { id: 'old', angleDeg: 3, distance: 2 };
    expect(aimAt(origin, new Vector3(1, 0, 0), targets, {}, out)).toBeNull();
    expect(out).toEqual({ id: 'old', angleDeg: 3, distance: 2 });
    expect(aimAt(origin, new Vector3(), targets, {}, out)).toBeNull();
  });

  it('returns the closest touched target using supplied storage', () => {
    const out: AimHit = { id: '', angleDeg: 10, distance: 0 };
    const point = new Vector3(0, 0, -1.04);
    expect(touching(point, targets, 0.06, out)).toBe(out);
    expect(out.id).toBe('remote');
    expect(out.angleDeg).toBe(0);
    expect(out.distance).toBeCloseTo(0.04);
    expect(touching(origin, targets, 0.06, out)).toBeNull();
  });
});
