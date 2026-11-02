import { afterEach, describe, expect, it, vi } from 'vitest';
import { LineLoop, Mesh, MeshBasicMaterial, Quaternion, Raycaster, Scene, SphereGeometry, Vector3 } from 'three';
import { HandFeedback } from './hand-feedback';
import type { ShellFrame, ShellHand } from './hud-contract';

const diagnostics = {
  left: { tracked: true, jointCount: 25, pinchDistanceCm: 1.5, selectEvents: 3, selectDown: true },
  right: { tracked: false, jointCount: 0, pinchDistanceCm: null, selectEvents: 0, selectDown: false },
};

function hand(pinching = false): ShellHand {
  return {
    joints: { 'index-finger-tip': { position: new Vector3(0, 0, -0.4), quaternion: new Quaternion(), radius: 0.008 } },
    pinching, justPinched: false, justReleased: false, pinchPoint: new Vector3(),
    ray: { origin: new Vector3(), dir: new Vector3(0, 0, -1) },
    palmUp: false, palmUpMs: 0, controller: false,
  };
}

function frame(time: number, hands: ShellFrame['hands'] = {}): ShellFrame {
  return {
    time, dt: 0.1, hands,
    head: { position: new Vector3(0, 1.6, 0), quaternion: new Quaternion(), ray: { origin: new Vector3(), dir: new Vector3(0, 0, -1) } },
  };
}

describe('HandFeedback', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shares fingertip resources without allocating a canvas when debug is off', () => {
    const createElement = vi.fn();
    vi.stubGlobal('document', { createElement });
    const feedback = new HandFeedback(false);
    const left = feedback.root.getObjectByName('fingertip-left') as Mesh<SphereGeometry, MeshBasicMaterial>;
    const right = feedback.root.getObjectByName('fingertip-right') as Mesh<SphereGeometry, MeshBasicMaterial>;
    feedback.update(frame(0, { left: hand(), right: hand() }), diagnostics, 8);
    expect(createElement).not.toHaveBeenCalled();
    expect(feedback.root.children).toHaveLength(4);
    expect(left.geometry).toBe(right.geometry);
    expect(left.material).toBe(right.material);
    expect(left.geometry.parameters.widthSegments).toBe(8);
    expect(left.position.toArray()).toEqual([0, 0, -0.4]);
    expect(left.visible).toBe(true);
    feedback.root.updateMatrixWorld(true);
    expect(new Raycaster(new Vector3(), new Vector3(0, 0, -1)).intersectObjects(feedback.root.children)).toHaveLength(0);
    feedback.dispose();
  });

  it('shares a simple hover outline and clears it when the hand has no target', () => {
    const feedback = new HandFeedback(false);
    const left = feedback.root.getObjectByName('hand-hover-left') as LineLoop;
    const right = feedback.root.getObjectByName('hand-hover-right') as LineLoop;
    feedback.setHover('left', { position: new Vector3(1, 2, 3), facing: new Vector3(0, 1, 0), sizeM: [0.3, 0.2, 0.1] });
    expect(left.visible).toBe(true);
    expect(right.visible).toBe(false);
    expect(left.geometry).toBe(right.geometry);
    expect(left.material).toBe(right.material);
    expect(left.position.y).toBeCloseTo(2.006);
    expect(left.scale.x).toBeCloseTo(0.335);
    expect(new Vector3(0, 0, 1).applyQuaternion(left.quaternion).y).toBeCloseTo(1);
    feedback.setHover('left');
    expect(left.visible).toBe(false);
    feedback.dispose();
  });

  it('brightens both pinching fingertips with one material and hides lost joints immediately', () => {
    const feedback = new HandFeedback(false);
    const left = feedback.root.getObjectByName('fingertip-left') as Mesh<SphereGeometry, MeshBasicMaterial>;
    const right = feedback.root.getObjectByName('fingertip-right') as Mesh<SphereGeometry, MeshBasicMaterial>;
    const idle = left.material;
    feedback.update(frame(0, { left: hand(true), right: hand(true) }), diagnostics, 8);
    expect(left.material).toBe(right.material);
    expect(left.material).not.toBe(idle);
    expect(left.material.color.getHex()).toBe(0xffffff);
    feedback.update(frame(20, { left: { ...hand(true), joints: {} }, right: hand() }), diagnostics, 8);
    expect(left.visible).toBe(false);
    expect(right.material).toBe(idle);
    feedback.update(frame(40), diagnostics, 8);
    expect(right.visible).toBe(false);
    feedback.dispose();
  });

  it('shows diagnostics on one throttled plate, measures real frame time, and disposes its resources', () => {
    const fillText = vi.fn();
    const context = { fillRect: vi.fn(), fillText };
    vi.stubGlobal('document', { createElement: vi.fn(() => ({ getContext: () => context })) });
    const feedback = new HandFeedback(true);
    const scene = new Scene();
    scene.add(feedback.root);
    const plate = feedback.root.getObjectByName('hand-debug') as Mesh;
    const geometryDispose = vi.spyOn(plate.geometry, 'dispose');
    const material = plate.material as MeshBasicMaterial;
    const materialDispose = vi.spyOn(material, 'dispose');
    const textureDispose = vi.spyOn(material.map!, 'dispose');
    feedback.update(frame(0, { left: hand(true) }), diagnostics, 17);
    expect(feedback.root.children).toHaveLength(5);
    expect(fillText).toHaveBeenCalledTimes(5);
    expect(fillText.mock.calls.map(([text]) => text)).toEqual([
      'Hands   FPS --   calls 17',
      'L tracked   joints 25   distance 1.5 cm',
      '   select events 3   down yes   pinch yes',
      'R untracked   joints 0   distance -- cm',
      '   select events 0   down no   pinch no',
    ]);
    feedback.update(frame(125), diagnostics, 19);
    expect(fillText).toHaveBeenCalledTimes(5);
    feedback.update(frame(250), diagnostics, 21);
    expect(fillText).toHaveBeenCalledTimes(10);
    expect(fillText.mock.calls[5]?.[0]).toBe('Hands   FPS 8.0   calls 21');
    expect(plate.position.x).toBe(0);
    expect(plate.position.y).toBeCloseTo(1.18);
    expect(plate.position.z).toBe(-0.9);
    feedback.dispose();
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
    expect(textureDispose).toHaveBeenCalledOnce();
    expect(scene.children).toHaveLength(0);
  });
});
