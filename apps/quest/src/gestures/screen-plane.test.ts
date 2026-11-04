import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { clearPlane, loadPlane, planeFromCorners, planePoint, projectOnPlane, savePlane, type ScreenPlane } from './screen-plane';

const v = (x: number, y: number, z: number) => new Vector3(x, y, z);
const must = (r: ReturnType<typeof planeFromCorners>): ScreenPlane => { if ('error' in r) throw new Error(r.error); return r.plane; };
const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, s: string) => { m.set(k, s); }, removeItem: (k: string) => { m.delete(k); } }; };

describe('screen plane from two corners', () => {
  it('a monitor facing the wearer: corners are on the plane, the normal faces the head', () => {
    // wearer at +z looking toward -z; screen at z = 0, 0.5 m wide, 0.3 m tall
    const plane = must(planeFromCorners(v(-0.25, 1.3, 0), v(0.25, 1.0, 0), v(0, 1.4, 0.9), v(0, 1.15, 0)));
    expect(plane.width).toBeCloseTo(0.5, 3);
    expect(plane.height).toBeCloseTo(0.3, 3);
    expect(plane.normal[2]).toBeGreaterThan(0.99);
    const tl = projectOnPlane(plane, v(-0.25, 1.3, 0)), br = projectOnPlane(plane, v(0.25, 1.0, 0));
    expect(tl).toMatchObject({ inside: true }); expect(tl.u).toBeCloseTo(0, 3); expect(tl.v).toBeCloseTo(0, 3); expect(tl.distance).toBeCloseTo(0, 4);
    expect(br.u).toBeCloseTo(1, 3); expect(br.v).toBeCloseTo(1, 3); expect(br.distance).toBeCloseTo(0, 4);
    const mid = projectOnPlane(plane, v(0, 1.15, 0.012));
    expect(mid.u).toBeCloseTo(0.5, 3); expect(mid.v).toBeCloseTo(0.5, 3); expect(mid.distance).toBeCloseTo(0.012, 4);
    expect(projectOnPlane(plane, v(0, 1.15, -0.05)).distance).toBeLessThan(0);
    expect(projectOnPlane(plane, v(0.6, 1.15, 0)).inside).toBe(false);
  });

  it('a laptop lid leaning back keeps both corners on the plane and tilts the normal up', () => {
    const tl = v(-0.15, 1.25, -0.1), br = v(0.15, 1.05, 0.0);
    const plane = must(planeFromCorners(tl, br, v(0, 1.4, 0.8), v(0, 1.1, -0.05)));
    expect(projectOnPlane(plane, tl).distance).toBeCloseTo(0, 4);
    expect(projectOnPlane(plane, br).distance).toBeCloseTo(0, 4);
    expect(plane.normal[1]).toBeGreaterThan(0.2); // leaning back: the face looks a little upward
    expect(plane.normal[2]).toBeGreaterThan(0.8);
    expect(plane.height).toBeGreaterThan(0.2);
    // a point halfway along the diagonal, 1 cm in front along the normal, is 1 cm away
    const mid = planePoint(plane, 0.5, 0.5).add(new Vector3(...plane.normal).multiplyScalar(0.01));
    expect(projectOnPlane(plane, mid)).toMatchObject({ inside: true }); expect(projectOnPlane(plane, mid).distance).toBeCloseTo(0.01, 4);
  });

  it('limits the lean to what a screen can do when the wearer stands far to one side', () => {
    // flat diagonal is almost along the direction to the head: would be a 60+ degree lean without the clamp
    const r = planeFromCorners(v(0, 1.3, 0), v(0.4, 1.0, 0.5), v(0.1, 1.4, 1.5), v(0.2, 1.1, 0));
    const plane = must(r);
    expect(plane.width).toBeGreaterThan(0.1);
    const lean = Math.atan2(new Vector3(...plane.normal).y, Math.hypot(plane.normal[0], plane.normal[2]));
    expect(lean * 180 / Math.PI).toBeLessThan(36);
    expect(projectOnPlane(plane, v(0.4, 1.0, 0.5)).distance).toBeCloseTo(0, 4);
  });

  it('rejects corners given in the wrong order or too close together', () => {
    expect(planeFromCorners(v(0.25, 1.3, 0), v(-0.25, 1.0, 0), v(0, 1.4, 0.9), v(0, 1.15, 0))).toHaveProperty('error');
    expect(planeFromCorners(v(0, 1.3, 0), v(0.01, 1.28, 0), v(0, 1.4, 0.9), v(0, 1.15, 0))).toHaveProperty('error');
    expect(planeFromCorners(v(0, 1.0, 0), v(0.4, 1.3, 0), v(0, 1.4, 0.9), v(0, 1.15, 0))).toHaveProperty('error');
  });
});

describe('plane storage', () => {
  const plane = must(planeFromCorners(v(-0.25, 1.3, 0), v(0.25, 1.0, 0), v(0, 1.4, 0.9), v(0, 1.15, 0)));
  it('round-trips per card and drops a plane whose device moved', () => {
    const storage = memory();
    expect(savePlane('visual-synth-mac', plane, storage)).toBe(true);
    expect(loadPlane('visual-synth-mac', v(0, 1.15, 0), storage)?.width).toBeCloseTo(0.5, 3);
    expect(loadPlane('other-card', v(0, 1.15, 0), storage)).toBeNull();
    expect(loadPlane('visual-synth-mac', v(2, 1.15, 0), storage)).toBeNull();
    clearPlane('visual-synth-mac', storage);
    expect(loadPlane('visual-synth-mac', null, storage)).toBeNull();
  });
  it('never throws when storage is missing, full or holds junk', () => {
    const bad = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); }, removeItem: () => { throw new Error('denied'); } };
    expect(savePlane('c', plane, bad)).toBe(false);
    expect(loadPlane('c', null, bad)).toBeNull();
    expect(() => clearPlane('c', bad)).not.toThrow();
    expect(loadPlane('c', null, { getItem: () => '{"origin":1}' })).toBeNull();
    expect(loadPlane('c', null, { getItem: () => 'not json' })).toBeNull();
    expect(savePlane('c', plane, undefined)).toBe(false);
  });
});
