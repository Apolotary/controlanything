import { describe, expect, it, vi } from 'vitest';
import { LineSegments, Mesh, type BufferGeometry, type Material } from 'three';
import { EXAMPLES } from '@ce/gen3d';
import { SpecObject } from './build';
import { HoloMaterial, MaterialClock } from './materials';
import { Label } from './text';

function fixture() {
  const clock = new MaterialClock();
  const spec = structuredClone(EXAMPLES['op1-knobs']!);
  const obj = new SpecObject(spec, { clock, sink: { control: () => {} } });
  return { clock, obj, spec };
}

describe('generated controls resource lifetime', () => {
  it('disposes original shaders when a disarmed object is rebuilt', () => {
    const { clock, obj, spec } = fixture();
    const originals = new Set(obj.meshes.flatMap((mesh) => Array.isArray(mesh.material) ? mesh.material : [mesh.material]));
    const dispose = [...originals].map((material) => vi.spyOn(material, 'dispose'));
    clock.tick(1);
    obj.setArmed(false);
    obj.applySpec(structuredClone(spec), 'none');
    for (const spy of dispose) expect(spy).toHaveBeenCalledOnce();
    clock.tick(2);
    for (const material of originals) if (material instanceof HoloMaterial) expect(material.u.uTime.value).toBe(1);
    obj.dispose();
  });

  it('disposes child resources and shared geometry once', () => {
    const { obj } = fixture();
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    obj.traverse((node) => {
      if ((node instanceof Mesh && !(node instanceof Label)) || node instanceof LineSegments) {
        geometries.add(node.geometry);
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) materials.add(material);
      }
    });
    const dispose = [...geometries, ...materials].map((resource) => vi.spyOn(resource, 'dispose'));
    obj.dispose();
    for (const spy of dispose) expect(spy).toHaveBeenCalledOnce();
  });

  it('releases temporary ghost materials and edges on rearming', () => {
    const { obj } = fixture();
    const original = new Map(obj.meshes.map((mesh) => [mesh, mesh.material]));
    obj.setArmed(false);
    const mesh = obj.meshes.find((candidate) => candidate.material !== original.get(candidate))!;
    const ghost = mesh.material as Material;
    const edges = mesh.getObjectByName('_ghostEdges') as LineSegments;
    const materialDispose = vi.spyOn(ghost, 'dispose');
    const edgeDispose = vi.spyOn(edges.material as Material, 'dispose');
    const geometryDispose = vi.spyOn(edges.geometry, 'dispose');
    obj.setArmed(true);
    expect(mesh.material).toBe(original.get(mesh));
    expect(materialDispose).toHaveBeenCalledOnce();
    expect(edgeDispose).toHaveBeenCalledOnce();
    expect(geometryDispose).toHaveBeenCalledOnce();
    obj.dispose();
    expect(materialDispose).toHaveBeenCalledOnce();
  });

  it('does not globally arm a control marked unverified by its spec', () => {
    const { obj, spec } = fixture();
    spec.controls.find((control) => control.id === 'blue')!.armed = false;
    obj.applySpec(spec, 'none'); obj.setArmed(false); obj.setArmed(true);
    const emit = vi.fn(); obj.emitter.on('control', emit);
    obj.setValue('blue', 100, { phase: 'move' });
    expect(obj.getValue('blue')).toBe(64);
    expect(emit).not.toHaveBeenCalled();
    obj.dispose();
  });

  it('keeps a spec without explicit arming inert while allowing device echoes', () => {
    const { obj, spec } = fixture();
    delete spec.state;
    obj.applySpec(spec, 'none');
    const emit = vi.fn();
    obj.emitter.on('control', emit);
    obj.setValue('blue', 100, { phase: 'move' });
    expect(obj.getValue('blue')).toBe(64);
    expect(emit).not.toHaveBeenCalled();
    obj.setValue('blue', 90, { emit: false });
    expect(obj.getValue('blue')).toBe(90);
    obj.dispose();
  });
});
