import { describe, expect, it, vi } from 'vitest';
import { GlassSurfaces } from './surface';
import { makeText } from './text';
import { THEME } from './theme';

describe('shared HUD resources', () => {
  it('renders background, buttons and text in fixed layers independent of head-angle depth sorting', () => {
    const surfaces = new GlassSurfaces();
    const background = surfaces.create(0.44, 0.74), button = surfaces.create(0.39, 0.052, 'button', true), label = makeText({ text: 'Ask Muse' });
    expect(background.renderOrder).toBeLessThan(button.renderOrder); expect(button.renderOrder).toBeLessThan(label.renderOrder);
    expect(background.material.depthTest).toBe(false); expect(button.material.depthTest).toBe(false); expect(label.material.depthTest).toBe(false);
    surfaces.dispose(); label.dispose();
  });

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

  it('paints idle actions as Horizon glass and the primary action as the white "on" pill', () => {
    const surfaces = new GlassSurfaces();
    const button = surfaces.material(0.112, 0.048, 'button', true).uniforms;
    expect(button.fill!.value.getHexString()).toBe('34343a');
    expect(button.fillAlpha!.value).toBe(0.94);
    expect(button.edgeAlpha!.value).toBe(0.1);
    expect(button.stroke!.value).toBe(THEME.surface.stroke);
    const primary = surfaces.material(0.168, 0.048, 'primary', true).uniforms;
    expect(primary.fill!.value.getHexString()).toBe('ffffff');
    expect(primary.fillAlpha!.value).toBe(0.92);
    expect(primary.edgeAlpha!.value).toBe(0);
    const plate = surfaces.material(0.4, 0.3, 'plate').uniforms;
    expect(plate.fill!.value.getHexString()).toBe('2f2f37');
    expect(plate.fill2!.value.getHexString()).toBe('16161b');
    expect(plate.radius!.value).toBeCloseTo(0.028);
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
