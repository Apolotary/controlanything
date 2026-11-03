import { describe, expect, it, vi } from 'vitest';
import { Box3, Vector3 } from 'three';
import { SpatialScene } from './spatial-scene';

describe('trusted generated AR recipes', () => {
  it.each(['orb', 'ripples'] as const)('renders bounded %s geometry only after an explicit native Run', kind => {
    const scene = new SpatialScene(), recipe = { kind, color: '#80eec2', actionId: 'amount' };
    scene.setState(recipe, .5, false); expect(scene.visible).toBe(false);
    scene.setState(recipe, .5, true);
    expect(scene.visible).toBe(true); expect(scene.userData).toMatchObject({ kind, normalized: .5, rendered: true });
    const before = scene.userData.radius;
    scene.setState(recipe, 99, true); expect(scene.userData.normalized).toBe(1); expect(scene.userData.radius).toBeGreaterThan(before);
    const visible = scene.children.filter(child => child.visible);
    expect(visible).toHaveLength(kind === 'orb' ? 1 : 5);
    for (const mesh of visible) {
      const bounds = new Box3().setFromObject(mesh).getSize(new Vector3());
      expect(bounds.x).toBeLessThanOrEqual(.12); expect(bounds.y).toBeLessThanOrEqual(.12);
    }
    scene.setState(recipe, NaN, true); expect(scene.userData.normalized).toBe(0);
    scene.setState(undefined, .5, false); expect(scene.visible).toBe(false); scene.dispose();
  });
  it('disposes the fixed geometry and each material', () => {
    const scene = new SpatialScene();
    const objects = [...scene.children] as any[];
    const geometries = [...new Set(objects.map(mesh => mesh.geometry))];
    const materials = [...new Set(objects.map(mesh => mesh.material))];
    const spies = [...geometries, ...materials].map(resource => vi.spyOn(resource, 'dispose'));
    scene.dispose(); expect(spies.every(spy => spy.mock.calls.length === 1)).toBe(true);
  });
});
