import { describe, expect, it } from 'vitest';
import { EXAMPLES, type ControlEvent, type Gen3dSpec } from '@ce/gen3d';
import { Object3D, PerspectiveCamera, Quaternion, Scene, Vector3, type WebGLRenderer } from 'three';
import type { HudFrame } from '../contract';
import { createHud } from './index';
import { controlFraction, controlValue, DIAL_DIAMETER } from './control-shape';

function setup(shape: 'fader' | 'knob' | 'lever') {
  const original = EXAMPLES['op1-knobs']!;
  const spec: Gen3dSpec = { ...original, controls: original.controls.map(c => ({ ...c, armed: true })),
    parts: original.parts.map(p => p.id === 'k1' ? { ...p, archetype: shape } : p) };
  const scene = new Scene(), camera = new PerspectiveCamera();
  camera.position.set(0, 1.4, 0); camera.updateMatrixWorld();
  const hud = createHud({ scene, camera, renderer: {} as WebGLRenderer });
  hud.setHome?.({ mode: 'control', filter: 'electronics', tagged: 1, status: 'Choose a device' });
  hud.upsertTarget({ id: 'synth', label: 'Synth', tagged: true, connection: 'ready', status: 'verified', confirmed: true, position: [0, 1.4, -1] });
  hud.setLocked('synth'); hud.renderSpec(spec, { targetId: 'synth' }); hud.setArmed(spec.specId, true);
  const events: ControlEvent[] = []; hud.on('control', e => events.push(e));
  let time = 0;
  const frame = (point?: Vector3, pinching = false, justPinched = false, justReleased = false): HudFrame => ({
    time: time += 100, dt: .1, pointer: 'mouse', head: { position: camera.position, quaternion: camera.quaternion },
    hands: point ? { right: { joints: { 'index-finger-tip': { position: point, quaternion: new Quaternion(), radius: .008 } },
      pinchPoint: point, ray: { origin: camera.position.clone(), dir: new Vector3(0, 0, -1) }, pinching, justPinched, justReleased } } : {},
  });
  hud.update(frame()); hud.update(frame()); hud.update(frame());
  const group = () => hud.root.getObjectByName('main-control:blue')!;
  const drag = (points: [number, number][]) => {
    const control = group(); control.updateWorldMatrix(true, false);
    points.forEach(([x, y], index) => hud.update(frame(control.localToWorld(new Vector3(x, y, 0)), true, index === 0)));
    const last = points.at(-1)!; hud.update(frame(control.localToWorld(new Vector3(last[0], last[1], 0)), false, false, true));
  };
  return { hud, spec, events, group, drag };
}

describe('generated shapes in the stable device card', () => {
  it('a validated fader-to-knob patch changes the visible widget and keeps its current value and card anchor', () => {
    const { hud, spec, group } = setup('fader');
    hud.setControlValue(spec.specId, 'blue', 90);
    const card = hud.root.getObjectByName('device-card')!, position = card.position.clone();
    expect(group().userData.archetype).toBe('slider');
    expect(group().getObjectByName('slider-fill')).toBeTruthy();
    const result = hud.patchSpec(spec.specId, { specId: spec.specId, baseRev: spec.rev,
      ops: [{ op: 'upsert', collection: 'parts', part: { ...spec.parts.find(p => p.id === 'k1')!, archetype: 'knob' } }] });
    expect(result).toMatchObject({ ok: true });
    expect(group().userData.archetype).toBe('knob');
    expect(group().getObjectByName('slider-fill')).toBeUndefined();
    expect(group().getObjectByName('button-plate')!.scale.x).toBeCloseTo(DIAL_DIAMETER);
    expect((group().getObjectByName('control-value') as Object3D & { text: string }).text).toBe('90');
    expect(card.position).toEqual(position);
    hud.dispose();
  });

  it('turning the knob clockwise dispatches bounded values through the existing control events', () => {
    const { hud, events, drag } = setup('knob');
    drag([[0, 0], [.022, 0], [.022, -.022]]);
    expect(events.find(e => e.phase === 'start')?.value).toBe(64); // center acquisition does not jump
    expect(events.some(e => e.value === 106)).toBe(true);
    expect(events.at(-1)).toMatchObject({ controlId: 'blue', value: 127, phase: 'end' });
    expect(events.every(e => typeof e.value === 'number' && e.value >= 0 && e.value <= 127)).toBe(true);
    hud.setArmed(EXAMPLES['op1-knobs']!.specId, false);
    expect(hud.root.getObjectByName('main-control:blue')).toBeUndefined();
    hud.dispose();
  });

  it('the lever follows vertical motion instead of horizontal motion and updates its handle', () => {
    const { hud, group, drag, events } = setup('lever');
    expect(group().userData.archetype).toBe('lever');
    drag([[0, 0], [.01, .024]]);
    expect(events.at(-1)).toMatchObject({ value: 127, phase: 'end' });
    expect(group().getObjectByName('value')!.position.y).toBeCloseTo(.024);
    expect(group().getObjectByName('value')!.position.x).toBe(0);
    hud.dispose();
  });

  it('clamps the dial dead zone and obeys nonzero range minima and step sizes', () => {
    expect(controlFraction('knob', { x: 0, y: -.03 }, .9)).toBe(1);
    expect(controlFraction('knob', { x: -.001, y: -.03 }, .1)).toBe(0);
    expect(controlFraction('knob', { x: 0, y: 0 }, .7)).toBe(.7);
    expect(controlValue(.54, { min: 5, max: 95, step: 10 })).toBe(55);
    expect(controlValue(1, { min: 5, max: 92, step: 10 })).toBe(92);
    expect(controlFraction('lever', { x: 100, y: 0 }, .4)).toBe(.5);
  });
});
