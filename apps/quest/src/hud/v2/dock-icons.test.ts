import { describe, expect, it } from 'vitest';
import { Group, Mesh, type ShaderMaterial } from 'three';
import type { HomeState } from '../contract';
import { DockIcons } from './dock-icons';

const annotate: HomeState = { mode: 'annotate', filter: 'everything', tagged: 0, status: '' };

describe('hand dock icons', () => {
  it('shows mode buttons and annotation filters, then only modes and an available Stop in Control', () => {
    const dock = new DockIcons();
    const names = () => dock.buttons.map((button) => button.name);
    expect(names()).toEqual(['mode-annotate', 'mode-control', 'filter:everything', 'filter:lights', 'filter:electronics', 'exit-ar']);
    expect(dock.height).toBe(0.032); expect(dock.width).toBeCloseTo(0.252);
    expect(dock.buttons[1]!.position.x - dock.buttons[0]!.position.x).toBeCloseTo(0.044);
    dock.setState({ ...annotate, mode: 'control' }, false);
    expect(names()).toEqual(['mode-annotate', 'mode-control', 'exit-ar']);
    expect(dock.width).toBeCloseTo(0.12);
    dock.setState({ ...annotate, mode: 'control' }, true);
    expect(names()).toEqual(['mode-annotate', 'mode-control', 'deck:panic', 'exit-ar']);
    dock.setState(annotate, true);
    expect(names()).not.toContain('deck:panic');
    dock.dispose();
  });

  it('labels Exit on hover and fills its existing disc while a hold is active', () => {
    const dock = new DockIcons();
    const exit = dock.getObjectByName('exit-ar')!;
    exit.userData.hovered = true;
    dock.updateFeedback(1);
    expect(dock.getObjectByName('dock-label')).toMatchObject({ visible: true, text: 'Exit AR (hold)' });
    dock.beginExitHold(0);
    expect(dock.updateExitHold(300)).toBe(false);
    expect(exit.userData.holdProgress).toBe(0.5);
    const material = (dock.getObjectByName('dock-discs') as Mesh).material as ShaderMaterial;
    expect(material.uniforms.holdProgress!.value).toBe(0.5);
    expect(dock.updateExitHold(600)).toBe(true);
    expect(dock.updateExitHold(700)).toBe(false);
    dock.cancelExitHold();
    expect(exit.userData.holdProgress).toBe(0);
    expect(material.uniforms.holdProgress!.value).toBe(0);
    dock.dispose();
  });

  it('keeps button identities and caller children across state updates and shows a hover label only on demand', () => {
    const dock = new DockIcons(), hint = new Group();
    dock.add(hint);
    const control = dock.buttons[1]!, originalGeometry = (dock.getObjectByName('dock-glyphs') as Mesh).geometry.getAttribute('position');
    dock.setState({ ...annotate, filter: 'lights', tagged: 2 }, false);
    expect(dock.buttons[1]).toBe(control);
    expect(dock.getObjectByName('filter:lights')!.userData.selected).toBe(true);
    expect(dock.getObjectByName('filter:everything')!.userData.selected).toBe(false);
    expect(dock.getObjectByName('dock-label')!.visible).toBe(false);
    control.userData.hovered = true;
    dock.updateFeedback(0.5);
    expect(dock.getObjectByName('dock-label')).toMatchObject({ visible: true, text: 'Control · 2', fillOpacity: 0.5 });
    expect(dock.getObjectByName('dock-count')).toMatchObject({ visible: true, text: '2', fillOpacity: 0.5 });
    dock.setState({ ...annotate, mode: 'control' }, false);
    expect(hint.parent).toBe(dock);
    expect((dock.getObjectByName('dock-glyphs') as Mesh).geometry.getAttribute('position')).toBe(originalGeometry);
    dock.dispose();
  });

  it('batches glass discs and vector glyphs into two draws and fades the independent wrist cue to 60 percent', () => {
    const dock = new DockIcons();
    const meshes: Mesh[] = [];
    dock.traverseVisible((object) => { if (object instanceof Mesh) meshes.push(object); });
    expect(meshes.map((mesh) => mesh.name)).toEqual(['dock-discs', 'dock-glyphs']);
    dock.updateFeedback(0.25);
    for (const mesh of meshes) expect((mesh.material as ShaderMaterial).uniforms.opacity!.value).toBe(0.25);
    dock.setWrist('annotate', 0.6);
    expect(dock.wrist.visible).toBe(true);
    expect((dock.wrist.children[0] as Mesh).material).toMatchObject({ opacity: 0.6 });
    dock.setWrist('control', 1);
    expect((dock.wrist.children[0] as Mesh).material).toMatchObject({ opacity: 0.6 });
    dock.setWrist('control', 0.3);
    expect((dock.wrist.children[0] as Mesh).material).toMatchObject({ opacity: 0.3 });
    dock.setWrist('control', 0);
    expect(dock.wrist.visible).toBe(false);
    dock.dispose();
  });
});
