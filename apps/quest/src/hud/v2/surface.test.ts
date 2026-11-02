import { describe, expect, it, vi } from 'vitest';
import { GlassSurfaces } from './surface';
import { makeText } from './text';
import { THEME } from './theme';

describe('shared HUD resources', () => {
  it('uses a bounded style cache across changing label dimensions', () => {
    const surfaces = new GlassSurfaces();
    const materials = new Set();
    for (let i = 1; i <= 1000; i++) materials.add(surfaces.create(i / 1000, 0.028, 'plate', true).material);
    expect(materials.size).toBe(1);
    surfaces.dispose();
  });

  it('keeps pill dimensions correct when shared materials render in a different order', () => {
    const surfaces = new GlassSurfaces();
    const first = surfaces.create(0.112, 0.048, 'button', true);
    const wide = surfaces.create(0.36, 0.036, 'button', true);
    expect(first.material).toBe(wide.material);
    for (const mesh of [wide, first, wide, first]) {
      Reflect.apply(mesh.onBeforeRender, mesh, []);
      expect(mesh.material.uniforms.size!.value.toArray()).toEqual([mesh.scale.x, mesh.scale.y]);
      expect(mesh.material.uniforms.radius!.value).toBe(mesh.scale.y / 2);
      expect(mesh.material.uniformsNeedUpdate).toBe(true);
      mesh.material.uniformsNeedUpdate = false;
    }
    first.material = surfaces.material(0.2, 0.048, 'primary', true);
    Reflect.apply(first.onBeforeRender, first, []);
    expect(first.material.uniforms.size!.value.toArray()).toEqual([0.112, 0.048]);
    surfaces.dispose();
  });

  it('gives every idle action a white pill and the primary action an accent pill', () => {
    const surfaces = new GlassSurfaces();
    const button = surfaces.material(0.112, 0.048, 'button', true).uniforms;
    expect(button.fill!.value.getHexString()).toBe('ffffff');
    expect(button.fillAlpha!.value).toBe(0.06);
    expect(button.edge!.value.getHexString()).toBe('ffffff');
    expect(button.edgeAlpha!.value).toBe(0.18);
    expect(button.stroke!.value).toBe(THEME.surface.stroke);
    const primary = surfaces.material(0.168, 0.048, 'primary', true).uniforms;
    expect(primary.fill!.value.getHexString()).toBe('38bdf8');
    expect(primary.fillAlpha!.value).toBe(0.28);
    expect(primary.edge!.value.getHexString()).toBe('38bdf8');
    expect(primary.edgeAlpha!.value).toBe(1);
    expect(primary.stroke!.value).toBe(THEME.surface.stroke * 1.5);
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
