import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { PoseRing } from './poses';

const yaw = (deg: number) => new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (deg * Math.PI) / 180);

describe('PoseRing', () => {
  it('interpolates between the samples around a time', () => {
    const r = new PoseRing(8);
    r.push(1000, new Vector3(0, 1.6, 0), yaw(0));
    r.push(1100, new Vector3(1, 1.6, 0), yaw(20));
    const p = r.lookup(1050)!;
    expect(p.position.x).toBeCloseTo(0.5, 6);
    expect(p.gapMs).toBe(0);
    const fwd = new Vector3(0, 0, -1).applyQuaternion(p.quaternion);
    expect((Math.atan2(-fwd.x, -fwd.z) * 180) / Math.PI).toBeCloseTo(10, 4);
  });

  it('measures head angular speed', () => {
    const r = new PoseRing(8);
    r.push(0, new Vector3(), yaw(0));
    r.push(100, new Vector3(), yaw(10));
    expect(r.latest()!.speedDeg).toBeCloseTo(100, 3);
    expect(r.peakSpeed(100, 150)).toBeCloseTo(100, 3);
    expect(r.peakSpeed(1000, 150)).toBe(0);
  });

  it('clamps to the newest sample and reports the gap', () => {
    const r = new PoseRing(4);
    for (let i = 0; i < 10; i++) r.push(i * 10, new Vector3(i, 0, 0), yaw(0));
    expect(r.size).toBe(4);
    const late = r.lookup(500)!;
    expect(late.position.x).toBe(9);
    expect(late.gapMs).toBe(410);
    // older than the buffer: the oldest kept sample
    expect(r.lookup(0)!.position.x).toBe(6);
  });

  it('is empty until the first push', () => {
    expect(new PoseRing().lookup(5)).toBeNull();
  });
});
