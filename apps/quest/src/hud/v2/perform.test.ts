import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Quaternion, Scene, Vector3, type Object3D, type WebGLRenderer } from 'three';
import { EXAMPLES } from '@ce/gen3d';
import type { DeviceState, HandState, HudFrame } from '../contract';
import { createHud } from './index';

function setup() {
  const camera = new PerspectiveCamera(); camera.position.set(0, 1.4, 0); camera.updateMatrixWorld();
  const hud = createHud({ scene: new Scene(), camera, renderer: {} as WebGLRenderer });
  hud.setHome?.({ mode: 'control', filter: 'lights', tagged: 1, status: '' });
  hud.upsertTarget({ id: 'lamp', label: 'Desk lamp', tagged: true, connection: 'ready', status: 'verified', position: [0, 1.4, -1], confirmed: true });
  hud.setLocked('lamp');
  hud.renderSpec({ ...EXAMPLES['ceiling-dimmer']!, specId: 'lamp-controls', state: { armed: true } }, { targetId: 'lamp' });
  hud.setArmed('lamp-controls', true);
  const state: DeviceState = { targetId: 'lamp', connection: 'ready', performAvailable: true, handControl: false, performingLive: false, performanceRoute: 'via IR bridge' };
  hud.setDeviceState?.(state);
  let time = 0;
  const step = (hand?: Partial<HandState>, elapsed = 20) => {
    time += elapsed;
    const frame: HudFrame = { time, dt: elapsed / 1000, pointer: 'mouse', head: { position: camera.position, quaternion: camera.quaternion }, hands: hand ? { right: { joints: {}, pinchPoint: new Vector3(10, 10, 10), ray: { origin: camera.position, dir: new Vector3(0, 0, -1) }, pinching: false, justPinched: false, justReleased: false, ...hand } } : {} };
    hud.update(frame);
  };
  step(undefined, 300);
  const node = (name: string) => hud.root.getObjectByName(name)!;
  const click = (name: string, controller: boolean) => {
    const point = node(name).getWorldPosition(new Vector3());
    const hand = { controller, joints: controller ? {} : { 'index-finger-tip': { position: point, quaternion: new Quaternion(), radius: 0.008 } }, pinchPoint: point, ray: { origin: camera.position, dir: point.clone().sub(camera.position).normalize() } };
    step(hand); step({ ...hand, pinching: true, justPinched: true }); step({ ...hand, justReleased: true });
  };
  return { hud, state, node, step, click };
}

describe('Perform controls', () => {
  it('offers the toggle for any validated map and updates Live routes without rebuilding it', () => {
    const f = setup(), button = f.node('hand-control');
    expect((button.getObjectByName('sdf') as Object3D & { text: string }).text).toBe('Perform');
    f.hud.setDeviceState?.({ ...f.state, handControl: true });
    const enabled = f.node('hand-control');
    expect((enabled.getObjectByName('sdf') as Object3D & { text: string }).text).toBe('Perform on');
    f.hud.setDeviceState?.({ ...f.state, handControl: true, performingLive: true, performanceRoute: 'via Mac (USB MIDI)' });
    expect(f.node('hand-control')).toBe(enabled);
    expect((f.node('device-status') as Object3D & { text: string }).text).toBe('Live · via Mac (USB MIDI)');
    f.hud.setDeviceState?.({ ...f.state, performAvailable: false });
    expect(f.node('hand-control')).toBeUndefined();
    f.hud.dispose();
  });

  it('suppresses bare-hand buttons while live and lets controllers switch Perform off', () => {
    const f = setup(), events: boolean[] = [];
    f.hud.setDeviceState?.({ ...f.state, handControl: true, performingLive: true });
    f.hud.on('handControl', ({ enabled }) => events.push(enabled));
    f.click('hand-control', false); expect(events).toEqual([]);
    f.click('hand-control', true); expect(events).toEqual([false]);
    f.hud.dispose();
  });
});
