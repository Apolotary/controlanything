import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { TargetTether } from './tether';
import { THEME } from './theme';

describe('Target tether', () => {
  it('draws nothing while idle, after hiding, or when its endpoints overlap', () => {
    const tether = new TargetTether();
    const positions = tether.geometry.getAttribute('position');
    const idle = () => {
      expect(tether.visible).toBe(false);
      expect(tether.geometry.drawRange.count).toBe(0);
      expect(Array.from(positions.array).every((value) => value === 0)).toBe(true);
    };
    idle();
    tether.update(new Vector3(0, 1, -3), new Vector3(0.2, 0, -0.65), new Vector3());
    expect(tether.geometry.drawRange.count).toBe(6);
    expect(tether.visible).toBe(true);
    tether.hide(); idle();
    tether.update(new Vector3(0, 1, -3), new Vector3(0.2, 0, -0.65), new Vector3());
    tether.update(new Vector3(0, 0, -1), new Vector3(0, 0, -1), new Vector3());
    idle();
    tether.dispose();
  });

  it('connects the endpoints with the same angular stroke at each depth', () => {
    const tether = new TargetTether(), head = new Vector3(0, 1.6, 0);
    const start = new Vector3(0, 2.2, -3), end = new Vector3(0.2, 1.7, -0.65);
    tether.update(start, end, head);
    const positions = tether.geometry.getAttribute('position');
    for (const [i, point] of [start, end].entries()) {
      const a = new Vector3().fromBufferAttribute(positions, i * 2), b = new Vector3().fromBufferAttribute(positions, i * 2 + 1);
      expect(a.distanceTo(b) / point.distanceTo(head)).toBeCloseTo(THEME.box.stroke, 6);
      expect(a.add(b).multiplyScalar(0.5).distanceTo(point)).toBeLessThan(1e-6);
    }
    tether.dispose();
  });
});
