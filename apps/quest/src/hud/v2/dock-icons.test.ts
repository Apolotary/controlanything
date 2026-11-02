import { describe, expect, it } from 'vitest';
import { Group, Mesh, Quaternion, Vector3, type ShaderMaterial } from 'three';
import type { HomeState, HudFrame } from '../contract';
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

  it('keeps finger labels visible and shows the destination mode and current filter', () => {
    const dock = new DockIcons();
    dock.setState(annotate, false, true);
    expect(dock.buttons.map((button) => [button.name, button.userData.finger, button.userData.label])).toEqual([
      ['mode-control', 'middle', 'Control'], ['filter:lights', 'ring', 'All'], ['exit-ar', 'pinky', 'Hold to exit'],
    ]);
    expect(dock.getObjectByName('finger-label:middle')).toMatchObject({ text: 'Control', visible: true });
    expect(dock.getObjectByName('dock-label')!.visible).toBe(false);
    dock.setState({ ...annotate, filter: 'lights' }, false);
    expect(dock.buttons[1]!.name).toBe('filter:electronics');
    expect(dock.getObjectByName('finger-label:ring')).toMatchObject({ text: 'Lights' });
    dock.setState({ ...annotate, mode: 'control' }, false);
    expect(dock.buttons.map((button) => button.userData.finger)).toEqual(['middle', 'pinky']);
    expect(dock.getObjectByName('finger-label:middle')).toMatchObject({ text: 'Annotate' });
    dock.setState({ ...annotate, mode: 'control' }, true);
    expect(dock.getObjectByName('deck:panic')!.userData.label).toBe('Stop');
    dock.setWrist('control', 0.6);
    expect(dock.wrist.getObjectByName('wrist-mode-label')).toMatchObject({ text: 'Control', visible: true });
    dock.setState(annotate, false, false);
    expect(dock.buttons.map((button) => button.name)).toEqual(['mode-annotate', 'mode-control', 'filter:everything', 'filter:lights', 'filter:electronics', 'exit-ar']);
    dock.dispose();
  });

  it('follows each fingertip in 3D with smoothing, hides lost tips, and hints once per session', () => {
    const dock = new DockIcons();
    dock.setState({ ...annotate, filter: 'electronics' }, false, true);
    const joint = (x: number, y: number, z: number) => ({ position: new Vector3(x, y, z), quaternion: new Quaternion(), radius: 0.008 });
    const frame: HudFrame = { time: 300, dt: 0.08, head: { position: new Vector3(0, 1.6, 0), quaternion: new Quaternion() }, hands: { left: {
      joints: { wrist: joint(0, 1.1, -0.4), 'middle-finger-tip': joint(0, 1.2, -0.4), 'ring-finger-tip': joint(0.02, 1.19, -0.4), 'pinky-finger-tip': joint(0.06, 1.18, -0.36) },
      pinching: false, justPinched: false, justReleased: false, pinchPoint: new Vector3(), ray: { origin: new Vector3(), dir: new Vector3(0, 0, -1) },
    } } };
    dock.position.set(-0.2, 0.8, -0.2);
    dock.rotation.y = 0.3;
    dock.updateFingers(frame, 'left', true);
    const middle = dock.buttons[0]!;
    expect(middle.getWorldPosition(new Vector3()).distanceTo(new Vector3(0, 1.22, -0.4))).toBeLessThan(1e-8);
    expect(dock.getObjectByName('finger-menu-hint')).toMatchObject({ visible: true, text: 'Touch your thumb to a finger' });
    const tip = frame.hands.left!.joints['middle-finger-tip']!.position;
    tip.x += 0.1;
    const target = tip.clone().addScaledVector(tip.clone().sub(frame.hands.left!.joints.wrist!.position).normalize(), 0.02);
    dock.updateFingers(frame, 'left', true);
    expect(middle.getWorldPosition(new Vector3()).distanceTo(new Vector3(0, 1.22, -0.4).lerp(target, 1 - Math.exp(-1)))).toBeLessThan(1e-8);
    const labelY = (index: number) => {
      const button = dock.buttons[index]!;
      return button.position.y + button.children[0]!.position.y * button.scale.y;
    };
    expect(Math.abs(labelY(0) - labelY(1))).toBeGreaterThanOrEqual(0.0139);
    dock.setState({ ...annotate, mode: 'control' }, false);
    for (const joint of Object.values(frame.hands.left!.joints)) joint!.position.x += 0.3;
    dock.updateFingers(frame, 'left', true);
    dock.setState(annotate, false);
    dock.updateFingers(frame, 'left', true);
    const ring = frame.hands.left!.joints['ring-finger-tip']!.position;
    const ringTarget = ring.clone().addScaledVector(ring.clone().sub(frame.hands.left!.joints.wrist!.position).normalize(), 0.02);
    expect(dock.buttons[1]!.getWorldPosition(new Vector3()).distanceTo(ringTarget)).toBeLessThan(1e-8);
    delete frame.hands.left!.joints['ring-finger-tip'];
    frame.time = 3300;
    dock.updateFingers(frame, 'left', true);
    dock.updateFeedback(1);
    expect(dock.buttons[1]!.visible).toBe(false);
    const transforms = ((dock.getObjectByName('dock-discs') as Mesh).material as ShaderMaterial).uniforms.transforms!.value;
    expect(transforms[1].w).toBe(0);
    expect(transforms[0].z).toBeCloseTo(dock.buttons[0]!.position.z);
    expect(dock.getObjectByName('finger-menu-hint')!.visible).toBe(false);
    dock.updateFingers(frame, 'left', false);
    frame.time = 3500;
    dock.updateFingers(frame, 'left', true);
    expect(dock.getObjectByName('finger-menu-hint')!.visible).toBe(false);
    frame.frame = { session: {} } as XRFrame;
    dock.updateFingers(frame, 'left', true);
    expect(dock.getObjectByName('finger-menu-hint')!.visible).toBe(true);
    dock.dispose();
  });

});
