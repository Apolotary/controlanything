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
  const example = EXAMPLES['ceiling-dimmer']!;
  const spec = { ...example, specId: 'lamp-controls', state: { armed: true }, controls: example.controls.map((control) => ({ ...control, armed: true })) };
  hud.renderSpec(spec, { targetId: 'lamp' });
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
  return { hud, state, spec, node, step, click };
}

describe('Perform controls', () => {
  it('offers an explicit gesture proposal before Perform and explains a silent visual instrument', () => {
    const f = setup(), requests: string[] = [];
    f.hud.on('gestureSetup', ({ targetId }) => requests.push(targetId));
    f.hud.setDeviceState?.({ ...f.state, performAvailable: false, silentVisual: true });
    expect(f.node('hand-control')).toBeUndefined(); expect(f.node('gesture-setup')).toBeTruthy();
    expect(f.node('device-status')).toMatchObject({ text: 'Silent visuals · set up gestures first' });
    f.click('gesture-setup', true); expect(requests).toEqual(['lamp']);
    f.hud.setDeviceState?.({ ...f.state, performAvailable: true, silentVisual: true });
    expect(f.node('gesture-setup')).toBeUndefined(); expect(f.node('hand-control')).toBeTruthy();
    f.hud.dispose();
  });
  it('offers the toggle for any validated map and updates Live routes without rebuilding it', () => {
    const f = setup(), button = f.node('hand-control');
    expect((button.getObjectByName('sdf') as Object3D & { text: string }).text).toBe('Perform');
    f.hud.setDeviceState?.({ ...f.state, handControl: true });
    const enabled = f.node('hand-control');
    expect((enabled.getObjectByName('sdf') as Object3D & { text: string }).text).toBe('Stop hands');
    f.hud.setDeviceState?.({ ...f.state, handControl: true, performingLive: true, performanceRoute: 'via Mac (USB MIDI)' });
    expect(f.node('hand-control')).toBe(enabled);
    expect((f.node('device-status') as Object3D & { text: string }).text).toBe('Live · via Mac (USB MIDI)');
    f.hud.setDeviceState?.({ ...f.state, performAvailable: false });
    expect(f.node('hand-control')).toBeUndefined();
    f.hud.dispose();
  });

  it('shows the accepted mapping action as primary and keeps the other manual slider usable in Details', () => {
    const f = setup(), events: string[] = [];
    const continuous = f.spec.controls.find(c => c.kind !== 'trigger' && c.kind !== 'toggle')!;
    f.hud.renderSpec({ ...f.spec, controls: [
      { ...continuous, id: 'warp', label: 'Warp', range: { min: 0, max: 127 }, default: 51, binding: { action: 'cc71' } },
      { ...continuous, id: 'ripples', label: 'Water ripples', range: { min: 0, max: 127 }, default: 0, binding: { action: 'cc21' } },
    ] }, { targetId: 'lamp' });
    f.hud.on('control', event => events.push(event.controlId));
    const state = { ...f.state, mappingActionId: 'cc71', mappingSummary: 'Map r3 · Push/pull to Water ripples', mappingOutcome: 'applied' as const };
    f.hud.setDeviceState?.(state); f.step();
    expect(f.node('main-control:warp')).toBeTruthy();
    // Binding alone changes; even identical copy must refresh the visible control.
    f.hud.setDeviceState?.({ ...state, mappingActionId: 'cc21' }); f.step();
    expect(f.node('main-control:ripples')).toBeTruthy(); expect(f.node('main-control:warp')).toBeUndefined();
    expect(f.node('control-label')).toMatchObject({ text: 'Water ripples' });
    expect(f.node('hand-control').getObjectByName('sdf')).toMatchObject({ text: 'Perform' });
    expect(f.node('device-status')).toMatchObject({ text: expect.stringContaining('choose Perform') });
    expect(events).toEqual([]); // Presentation updates never send controls.
    f.click('main-control:ripples', true); expect(events).toContain('ripples'); events.length = 0;
    f.click('details-toggle', true); f.step();
    const manual = f.node('main-control:warp'); expect(manual).toBeTruthy();
    expect(f.node('control-label')).toMatchObject({ text: 'Warp' });
    const detail = f.node('details-panel').children.find(child => 'sync' in child)!;
    const textY = detail.getWorldPosition(new Vector3()).y, sliderY = manual.getWorldPosition(new Vector3()).y;
    const forgetY = f.node('device-forget').getWorldPosition(new Vector3()).y;
    expect(sliderY - .018).toBeGreaterThan(textY + .008);
    expect(textY - .025).toBeGreaterThan(forgetY + .024);
    f.click('main-control:warp', true); expect(events).toContain('warp');
    f.click('details-toggle', true); f.step();
    expect(f.node('main-control:ripples')).toBeTruthy(); expect(f.node('main-control:warp')).toBeUndefined();
    f.hud.dispose();
  });

  it.each(['working', 'review', 'failed', 'cancelled', 'unchanged', 'applied'] as const)('keeps the published action after a %s result instead of inferring a binding from reply text', mappingOutcome => {
    const f = setup();
    const continuous = f.spec.controls.find(c => c.kind !== 'trigger' && c.kind !== 'toggle')!;
    f.hud.renderSpec({ ...f.spec, controls: [
      { ...continuous, id: 'warp', label: 'Warp', binding: { action: 'cc71' } },
      { ...continuous, id: 'ripples', label: 'Water ripples', binding: { action: 'cc21' } },
    ] }, { targetId: 'lamp' });
    f.hud.setDeviceState?.({ ...f.state, mappingActionId: 'cc71', mappingSummary: 'Request says Water ripples', mappingOutcome }); f.step();
    expect(f.node('main-control:warp')).toBeTruthy(); expect(f.node('main-control:ripples')).toBeUndefined();
    f.hud.setDeviceState?.({ ...f.state, mappingActionId: 'cc21', mappingOutcome }); f.step();
    f.hud.setArmed('lamp-controls', false, undefined, ['ripples']); f.step();
    expect(f.node('main-control:warp')).toBeTruthy(); expect(f.node('main-control:ripples')).toBeUndefined();
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

  it('ignores near-poke travel during a paused Perform session but accepts an intentional pinch to leave it', () => {
    const f = setup(), events: boolean[] = [];
    f.hud.setDeviceState?.({ ...f.state, handControl: true, performingLive: false });
    f.hud.on('handControl', ({ enabled }) => events.push(enabled));
    const button = f.node('hand-control');
    const point = button.getWorldPosition(new Vector3()), normal = new Vector3(0, 0, 1).applyQuaternion(button.getWorldQuaternion(new Quaternion()));
    for (const distance of [0.04, -0.02, 0.04]) {
      const tip = point.clone().addScaledVector(normal, distance);
      f.step({ joints: { 'index-finger-tip': { position: tip, quaternion: new Quaternion(), radius: 0.008 } }, pinchPoint: tip,
        ray: { origin: point.clone().addScaledVector(normal, 0.5), dir: normal.clone().negate() } });
    }
    expect(events).toEqual([]);
    f.click('hand-control', false); expect(events).toEqual([false]);
    f.hud.dispose();
  });

  it('keeps the Live route visible for a validated map while unrelated controls remain unverified', () => {
    const f = setup();
    f.hud.renderSpec({ ...f.spec, controls: [...f.spec.controls,
      { id: 'untested', label: 'Untested action', kind: 'trigger', armed: false, binding: { action: 'untested' } },
    ] }, { targetId: 'lamp' });
    f.hud.setDeviceState?.({ ...f.state, handControl: true, performingLive: true, performanceRoute: 'via Mac (USB MIDI)' });
    expect((f.node('device-status') as Object3D & { text: string }).text).toBe('Live · via Mac (USB MIDI)');
    expect(f.node('verdict-chip').visible).toBe(false);
    expect(f.hud.root.getObjectByName('control:untested')).toBeUndefined();
    f.hud.dispose();
  });
});
