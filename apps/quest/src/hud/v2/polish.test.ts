import { afterEach, describe, expect, it, vi } from 'vitest';
import { Mesh, PerspectiveCamera, Quaternion, Scene, Vector3, type Object3D, type ShaderMaterial, type WebGLRenderer } from 'three';
import { EXAMPLES, type ControlEvent, type Gen3dSpec } from '@ce/gen3d';
import type { HandState, HudFrame, HudTarget } from '../contract';
import { createHud } from './index';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.restoreAllMocks(); });

function setup() {
  const camera = new PerspectiveCamera(75, 1, 0.01, 20);
  camera.position.set(0, 1.4, 0); camera.updateMatrixWorld();
  const hud = createHud({ scene: new Scene(), camera, renderer: {} as WebGLRenderer });
  cleanup.push(() => hud.dispose());
  const target: HudTarget = {
    id: 'lamp', label: 'Desk light', tagged: true, connection: 'ready', channel: 'ir', status: 'verified',
    position: [0, 1.4, -1], sizeM: [0.3, 0.2, 0.1], confirmed: true,
  };
  const spec: Gen3dSpec = {
    ...EXAMPLES['ceiling-dimmer']!, specId: 'lamp-controls', state: { armed: true },
    device: { ...EXAMPLES['ceiling-dimmer']!.device!, transport: 'ir' },
    controls: [{ id: 'power', label: 'Power', kind: 'toggle', default: false, armed: true, binding: { action: 'power' } }],
  };
  const controls: ControlEvent[] = [], exits: unknown[] = [];
  hud.on('control', (event) => controls.push(event));
  hud.on('exit', (event) => exits.push(event));
  hud.on('selectTarget', ({ targetId }) => hud.setLocked(targetId));
  hud.setHome?.({ mode: 'control', filter: 'lights', tagged: 1, status: 'Choose a device' });
  hud.upsertTarget(target); hud.setLocked(target.id);
  hud.renderSpec(spec, { targetId: target.id }); hud.setArmed(spec.specId, true);
  let time = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => 100_000 + Math.round(time));
  const node = (name: string): Object3D => {
    const object = hud.root.getObjectByName(name);
    if (!object) throw new Error(`Missing HUD node ${name}`);
    return object;
  };
  const step = (ms = 16, input?: Partial<HandState>) => {
    time += ms; camera.updateMatrixWorld();
    const frame: HudFrame = {
      time, dt: ms / 1000, pointer: 'mouse', head: { position: camera.position, quaternion: camera.quaternion },
      hands: input ? { right: {
        joints: {}, controller: true, pinchPoint: new Vector3(), ray: { origin: camera.position, dir: new Vector3(0, 0, -1) },
        pinching: false, justPinched: false, justReleased: false, ...input,
      } } : {},
    };
    hud.update(frame);
  };
  const press = (name: string) => {
    step(200);
    const point = node(name).getWorldPosition(new Vector3());
    const aim = { ray: { origin: camera.position.clone(), dir: point.sub(camera.position).normalize() } };
    step(16, aim);
    step(16, { ...aim, pinching: true, justPinched: true });
    return aim;
  };
  const release = (aim: ReturnType<typeof press>) => step(16, { ...aim, justReleased: true });
  const tap = (name: string) => { const aim = press(name); release(aim); };
  const status = () => (node('device-status') as Object3D & { text: string }).text;
  const result = (event: ControlEvent, ok: boolean) => hud.setCommandResult?.(event.specId, event.controlId, event.ts, ok);
  step(300); step(300);
  return { hud, camera, target, spec, controls, exits, node, step, press, release, tap, status, result };
}

describe('HUD interaction polish', () => {
  it.skip('pins the card through a long head turn and shows one geometric edge arrow for its workspace', () => {
    const f = setup(), card = f.node('device-card');
    f.hud.upsertTarget({ ...f.target, id: 'other', label: 'Other light', position: [-0.6, 1.4, -1] });
    f.tap('device-lock');
    expect(card.userData.pinned).toBe(true);
    const position = card.position.clone(), rotation = card.quaternion.clone();
    f.camera.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    f.step(3200);
    expect(card.position.distanceTo(position)).toBeLessThan(1e-6);
    expect(card.quaternion.angleTo(rotation)).toBeLessThan(1e-6);
    const edge = f.node('device-edge-pill'), arrow = f.node('edge-direction');
    expect(edge.visible).toBe(true);
    expect(arrow).toBeInstanceOf(Mesh);
    expect((arrow as Mesh).geometry.getAttribute('position').count).toBeGreaterThan(0);
    let visiblePills = 0;
    f.hud.root.traverseVisible((object) => { if (object.name === 'device-edge-pill') visiblePills++; });
    expect(visiblePills).toBe(1);
    f.camera.quaternion.identity(); f.step();
    f.tap('device-lock');
    expect(card.userData.pinned).toBe(false);
    f.tap('device-lock');
    expect(card.userData.pinned).toBe(true);
    f.tap('target-label:other');
    expect(card.userData.pinned).toBe(true);
    f.hud.on('changeDevice', () => f.hud.setLocked(null));
    f.tap('menu-toggle'); f.tap('menu-tools'); f.tap('change-device'); f.tap('target-label:other');
    expect(card.userData.pinned).toBe(false);
    expect((f.node('device-name') as Object3D & { text: string }).text).toBe('Other light');
  });

  it.skip('responds on the press frame, shimmers in flight, and only settles the matching result', () => {
    const f = setup(), button = f.node('control:power');
    const aim = f.press('control:power');
    expect(button.scale.x).toBe(0.92);
    expect(button.userData.feedbackStyle).toBe('pressed');
    expect(f.status()).toBe('Sending…');
    expect(f.controls).toHaveLength(1);
    f.release(aim); f.step(200);
    const sent = f.controls.at(-1)!;
    expect(sent).toMatchObject({ phase: 'end', value: true });
    expect(button.userData.feedbackStyle).toBe('sending');
    const material = (button.getObjectByName('button-plate') as Mesh).material as ShaderMaterial;
    expect(material.uniforms.shimmer!.value).toBe(1);
    f.hud.setCommandResult?.('old-spec', sent.controlId, sent.ts, true);
    f.hud.setCommandResult?.(sent.specId, 'old-control', sent.ts, true);
    f.hud.setCommandResult?.(sent.specId, sent.controlId, sent.ts - 1, true);
    expect(f.status()).toBe('Sending…');
    f.result(sent, true); f.step();
    expect(f.status()).toBe('On · via IR bridge');
    expect(f.node('control:power')).toBe(button);
    expect(button.scale.x).toBe(1);
    expect(button.userData.feedbackStyle).not.toBe('sending');
  });

  it.skip('preserves a held capture when a result arrives before release', () => {
    const f = setup(), button = f.node('control:power');
    const aim = f.press('control:power');
    f.result(f.controls[0]!, true);
    f.step(100, { ...aim, pinching: true });
    expect(f.node('control:power')).toBe(button);
    expect(button.scale.x).toBe(0.92);
    expect(f.controls).toHaveLength(1);
    f.release(aim);
    expect(f.controls.map((event) => event.phase)).toEqual(['start', 'end']);
    f.result(f.controls[0]!, true);
    expect(f.status()).toBe('Sending…');
    f.result(f.controls[1]!, true);
    expect(f.status()).toBe('On · via IR bridge');
  });

  it.skip('turns a command timeout amber and retries its stored value once', () => {
    const f = setup();
    f.tap('control:power');
    const sent = f.controls.at(-1)!;
    f.step(4999);
    expect(f.status()).toBe('Sending…');
    f.step(1);
    expect(f.status()).toContain('Retry');
    const button = f.node('control:power');
    expect(button.userData.feedbackStyle).toBe('failed');
    const material = (button.getObjectByName('button-plate') as Mesh).material as ShaderMaterial;
    expect(material.uniforms.edge!.value.getHexString()).toBe('fbbf24');
    let retryCount = 0;
    f.hud.root.traverseVisible((object) => { if (object.name === 'command-retry') retryCount++; });
    expect(retryCount).toBe(1);
    f.hud.setControlValue(f.spec.specId, 'power', false);
    const before = f.controls.length, aim = f.press('command-retry');
    f.step(300, { ...aim, pinching: true }); f.release(aim);
    expect(f.controls.slice(before)).toEqual([expect.objectContaining({ controlId: 'power', phase: 'end', value: sent.value })]);
    expect(f.status()).toBe('Sending…');
    expect(f.node('command-retry').visible).toBe(false);
    f.result(f.controls.at(-1)!, true); f.step();
    expect(f.status()).toBe('On · via IR bridge');
  });

  it.skip('offers retry immediately after an execution failure', () => {
    const f = setup();
    f.tap('control:power');
    f.result(f.controls.at(-1)!, false); f.step();
    expect(f.status()).toBe('Couldn’t send · Retry');
    expect(f.node('command-retry').visible).toBe(true);
    expect(f.node('control:power').userData.feedbackStyle).toBe('failed');
  });

  it('cancels an early Exit release and emits once after a complete hold', () => {
    const f = setup();
    f.hud.setDeck({ open: true }); f.step();
    let aim = f.press('exit-ar');
    f.step(250, { ...aim, pinching: true });
    expect(f.node('exit-ar').userData.holdProgress).toBeGreaterThan(0);
    expect(f.exits).toHaveLength(0);
    f.release(aim); f.step(500);
    expect(f.node('exit-ar').userData.holdProgress).toBe(0);
    expect(f.exits).toHaveLength(0);
    aim = f.press('exit-ar');
    f.step(599, { ...aim, pinching: true });
    expect(f.exits).toHaveLength(0);
    f.step(1, { ...aim, pinching: true });
    expect(f.exits).toEqual([{}]);
    f.step(800, { ...aim, pinching: true });
    expect(f.exits).toHaveLength(1);
    f.release(aim);
    expect(f.node('exit-ar').userData.holdProgress).toBe(0);
  });
});
