import { describe, expect, it, vi } from 'vitest';
import { GlassSurfaces } from './surface';
import { makeText } from './text';

describe('shared HUD resources', () => {
  it('uses a bounded style cache across changing label dimensions', () => {
    const surfaces = new GlassSurfaces();
    const materials = new Set();
    for (let i = 1; i <= 1000; i++) materials.add(surfaces.create(i / 1000, 0.028, 'plate', true).material);
    expect(materials.size).toBe(1);
    surfaces.dispose();
  });

  it('disposing one text label keeps the shared text material alive', () => {
    const first = makeText({ text: 'First' }), second = makeText({ text: 'Second' });
    const dispose = vi.spyOn(first.material, 'dispose');
    first.dispose();
    expect(dispose).not.toHaveBeenCalled();
    second.dispose(); dispose.mockRestore();
  });
});
