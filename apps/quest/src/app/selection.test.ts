import { Quaternion, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { EXAMPLES } from '@ce/gen3d';
import { TargetStore } from '../scan/targets';
import { QuestApp } from './app';
import { ModeState } from './modes';
import type { ShellFrame } from './hud-contract';

function shell() {
  const app = Object.create(QuestApp.prototype) as QuestApp;
  const targets = new TargetStore();
  const target = targets.upsert(
    { detId: 'sam-device', label: 'Laptop', score: 0.9, box: [20, 20, 200, 100] },
    { position: new Vector3(0, 1.6, -1), facing: new Vector3(0, 0, 1), confirmed: false, method: 'size-prior', depth: 1, sizeM: [0.3, 0.2, 0.1] }, 'sam-frame',
  ).target;
  const liveBox = { id: 'yolo_1', position: new Vector3(0.5, 1.6, -1), size: 0.3 };
  const live = {
    stop: vi.fn(), claimOf: vi.fn<() => string | undefined>(() => undefined), onSamTargets: vi.fn(),
    targetSnapshot: vi.fn(() => ({ id: liveBox.id, position: liveBox.position.toArray(), label: 'Keyboard', score: 0.9, status: 'scanned', confirmed: false })),
    appendAimables: (out: typeof liveBox[]) => out.push(liveBox), hoverTarget: vi.fn(),
  };
  const hud = { setCandidate: vi.fn(), setLocked: vi.fn(), upsertTarget: vi.fn(), removeTarget: vi.fn(),
    setHome: vi.fn(), setDeviceState: vi.fn(), setArmed: vi.fn(), showConfirm: vi.fn(), hideHackMenu: vi.fn(), renderSpec: vi.fn(), showHackMenu: vi.fn() };
  const scanner = { active: true, stop: vi.fn(), start: vi.fn() };
  const ws = { send: vi.fn<(...args: [string, unknown, unknown?]) => string | null>(() => 'sent') };
  const modes = new ModeState();
  Object.assign(app, {
    targets, live, hud, scanner, ws, modes, lockedId: null, filter: 'electronics', params: new URLSearchParams(), cameraState: 'on',
    desktopCam: { position: new Vector3(0, 1.6, 0) }, controls: { clear: vi.fn(), push: vi.fn() },
    handFeedback: { setHover: vi.fn() }, recorder: { input: vi.fn() }, page: { log: vi.fn() },
    input: { mouseAsHand: true, pointer: { inside: true } },
    candidate: { id: null, shown: null, since: 0 }, consumed: { left: false, right: false },
    aimTargets: new Map(), aimBuffer: [], observed: new Map(), visibleTargets: new Set([target.id, liveBox.id]),
    armedCards: new Set(), cancelledCards: new Set(), generated: new Map(), deferredSpecs: new Map(), controlValues: new Map(), specByCard: new Map(), cardOfSpec: new Map(), uiSpecOfGen3d: new Map(), menuSpec: new Map(),
    gazeHit: { id: '', angleDeg: 0, distance: 0 }, handHit: { id: '', angleDeg: 0, distance: 0 }, touchHit: { id: '', angleDeg: 0, distance: 0 },
  });
  const receive = (method: string, payload: unknown) => Reflect.get(app, method).call(app, payload);
  hud.upsertTarget.mockImplementation((target) => receive('observeTarget', target));
  const connected = (connection: 'ready' | 'setup' | 'offline' = 'setup') => {
    app.lock(target.id);
    receive('onTagsState', { tags: [{ cardId: 'laptop', label: 'Laptop', position: { x: 0, y: 1.6, z: -1 }, connection }] });
    app.setMode('control'); app.lock(target.id);
  };
  return { app, target, live, hud, scanner, ws, modes, receive, connected };
}

describe('explicit annotation and control', () => {
  it('pinches a SAM box to tag once, keeps scanning, and never starts control', () => {
    const { app, target, scanner, ws, modes } = shell();
    app.lock(target.id); app.lock(target.id);
    expect(modes.mode).toBe('annotate');
    expect(modes.tags.get(target.id)?.connection).toBe('unknown');
    expect(scanner.stop).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledExactlyOnceWith('tag.add', {
      targetId: target.id, frameId: 'sam-frame', detId: 'sam-device', label: 'Laptop', position: { x: 0, y: 1.6, z: -1 },
    }, { to: 'server' });
    app.setupControl(target.id);
    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it('tags a live box immediately with its world position before a SAM result', () => {
    const { app, scanner, ws, modes } = shell();
    app.lock('yolo_1');
    expect(modes.tags.size).toBe(1);
    expect(ws.send).toHaveBeenCalledWith('tag.add', expect.objectContaining({ label: 'Keyboard', position: { x: 0.5, y: 1.6, z: -1 } }), { to: 'server' });
    expect(ws.send.mock.calls[0]![1]).not.toHaveProperty('frameId');
    expect(scanner.stop).not.toHaveBeenCalled();
  });

  it('resolves an already claimed live box to the same tag', () => {
    const { app, target, live, modes } = shell();
    live.claimOf.mockReturnValue(target.id);
    app.lock('yolo_1');
    expect(modes.tags.has(target.id)).toBe(true);
  });

  it('keeps local tags while the server is offline', () => {
    const { app, target, ws, modes, receive } = shell();
    ws.send.mockReturnValue(null as unknown as string);
    app.lock(target.id);
    receive('onTagsState', { tags: [] });
    expect(modes.tags.get(target.id)).toMatchObject({ connection: 'unknown', pending: { label: 'Laptop' } });
    app.setMode('control'); app.setupControl(target.id);
    expect(ws.send.mock.calls.some(([type]) => type === 'control.setup')).toBe(false);
  });

  it('requires Control, a tag, and an online bridge before explicit setup', () => {
    const { app, target, connected, ws, scanner } = shell();
    connected();
    expect(scanner.stop).toHaveBeenCalled();
    expect(ws.send.mock.calls.some(([type]) => type === 'control.setup')).toBe(false);
    app.setupControl(target.id); app.setupControl(target.id);
    expect(ws.send.mock.calls.filter(([type]) => type === 'control.setup')).toEqual([['control.setup', { cardId: 'laptop' }, { to: 'server' }]]);
  });

  it('offline tags explain connection without starting setup', () => {
    const { app, target, connected, ws } = shell();
    connected('offline'); app.setupControl(target.id);
    expect(ws.send.mock.calls.some(([type]) => type === 'control.setup')).toBe(false);
  });

  it('cancels setup and closes cards when leaving Control', () => {
    const { app, target, connected, ws, hud } = shell();
    connected(); app.setupControl(target.id); app.setMode('annotate');
    expect(ws.send).toHaveBeenCalledWith('control.cancel', { cardId: 'laptop' }, { to: 'server' });
    expect(app.lockedId).toBeNull();
    expect(hud.setDeviceState).toHaveBeenLastCalledWith(null);
    expect(app.modes.tags.get(target.id)?.busy).toBe(false);
  });

  it('ignores unsolicited specs and requires a matching approved arm result', () => {
    const { app, target, connected, receive, hud } = shell();
    const spec = { ...EXAMPLES['ceiling-dimmer']!, specId: 'spec_light', state: { armed: true } };
    receive('onUiSpec', { cardId: 'unasked', specId: 'unasked', gen3d: spec });
    expect(hud.renderSpec).not.toHaveBeenCalled();
    connected(); app.setupControl(target.id);
    receive('onUiSpec', { cardId: 'laptop', specId: 'ui_laptop', gen3d: spec });
    expect(hud.renderSpec).toHaveBeenCalledWith(expect.objectContaining({ state: { armed: false } }), { targetId: target.id });
    const request = { armId: 'arm1', cardId: 'laptop', title: 'Arm', summary: 'Ready', expiresAt: Date.now() + 5000 };
    receive('onArmRequest', request);
    receive('onArmResult', { ...request, armed: true });
    expect(hud.setArmed).not.toHaveBeenCalledWith(spec.specId, true, undefined);
    app.answerConfirm('arm1', true);
    receive('onArmResult', { ...request, armed: true });
    expect(hud.setArmed).toHaveBeenLastCalledWith(spec.specId, true, undefined);
  });

  it('losing the bridge during setup cancels pending ARM and keeps the device offline', () => {
    const { app, target, connected, receive, ws } = shell();
    connected(); app.setupControl(target.id);
    receive('onArmRequest', { armId: 'pending', cardId: 'laptop', expiresAt: Date.now() + 5000 });
    receive('onTagsState', { tags: [{ cardId: 'laptop', label: 'Laptop', connection: 'offline', hint: 'Open the Mac app.' }] });
    app.answerConfirm('pending', true);
    receive('onArmResult', { armId: 'pending', cardId: 'laptop', armed: true });
    expect(ws.send.mock.calls.some(([type]) => type === 'arm.confirm')).toBe(false);
    expect(app.modes.tags.get(target.id)).toMatchObject({ connection: 'offline', busy: false });
  });

  it('an old arm result cannot close or arm a newer request, including after cancel', () => {
    const { app, target, connected, receive, hud } = shell();
    connected(); app.setupControl(target.id);
    receive('onArmRequest', { armId: 'new', cardId: 'laptop', expiresAt: Date.now() + 5000 });
    hud.showConfirm.mockClear();
    receive('onArmResult', { armId: 'old', cardId: 'laptop', armed: true });
    expect(hud.showConfirm).not.toHaveBeenCalled();
    app.cancelControl(target.id); hud.showConfirm.mockClear();
    receive('onArmResult', { armId: 'new', cardId: 'laptop', armed: true });
    expect(hud.showConfirm).not.toHaveBeenCalled();
  });

  it('replays a ready spec only once its tag snapshot establishes the connection', () => {
    const { app, target, receive, hud } = shell();
    app.lock(target.id);
    const spec = { ...EXAMPLES['ceiling-dimmer']!, specId: 'lamp' };
    receive('onUiSpec', { cardId: 'laptop', specId: 'ui', gen3d: spec });
    expect(hud.renderSpec).not.toHaveBeenCalled();
    receive('onTagsState', { tags: [{ cardId: 'laptop', label: 'Laptop', connection: 'ready', position: { x: 0, y: 1.6, z: -1 } }] });
    expect(hud.renderSpec).toHaveBeenCalledOnce();
    expect(hud.setArmed).toHaveBeenLastCalledWith('lamp', true);
  });

  it('Stop cancels pending ARM and a late ready snapshot cannot re-enable controls', () => {
    const { app, target, connected, receive, hud, ws } = shell();
    Object.assign(hud, { toast: vi.fn() });
    connected(); app.setupControl(target.id);
    receive('onArmRequest', { armId: 'pending', cardId: 'laptop', expiresAt: Date.now() + 5000 });
    app.onDeck('panic', 'press');
    app.answerConfirm('pending', true);
    receive('onArmResult', { armId: 'pending', cardId: 'laptop', armed: true });
    receive('onTagsState', { tags: [{ cardId: 'laptop', label: 'Laptop', connection: 'ready' }] });
    expect(ws.send.mock.calls.some(([type]) => type === 'arm.confirm')).toBe(false);
    expect(app.modes.tags.get(target.id)).toMatchObject({ busy: false, connection: 'setup' });
  });

  it('sends continuous light controls and a true trigger release only while ready and selected in Control', () => {
    const { app, target, connected, receive } = shell();
    connected('ready');
    const spec = { ...EXAMPLES['ceiling-dimmer']!, specId: 'lamp', controls: [
      { id: 'level', kind: 'continuous', label: 'Brightness', default: 20, binding: { action: 'brightness' } },
      { id: 'off', kind: 'trigger', label: 'Off', binding: { action: 'off' } },
    ] };
    receive('onUiSpec', { cardId: 'laptop', specId: 'ui', gen3d: spec });
    const push = vi.mocked(app.controls.push);
    receive('onControl', { specId: 'lamp', controlId: 'level', value: 80, phase: 'move', ts: 0 });
    receive('onControl', { specId: 'lamp', controlId: 'off', value: false, phase: 'end', ts: 0 });
    expect(push.mock.calls.map(([event]) => [event.controlId, event.value])).toEqual([['level', 80], ['off', true]]);
    app.setMode('annotate');
    receive('onControl', { specId: 'lamp', controlId: 'level', value: 0, phase: 'move', ts: 0 });
    expect(push).toHaveBeenCalledTimes(2);
    expect(app.modes.tags.has(target.id)).toBe(true);
  });

  it('applies one six-box budget, fades stale detections, and hides out-of-range devices', () => {
    const { app, receive } = shell();
    const draw = vi.fn(), erase = vi.fn();
    Object.assign(app, { drawTarget: draw, eraseTarget: erase });
    for (let i = 0; i < 8; i++) receive('observeTarget', { id: `box${i}`, label: 'Laptop', score: 0.9,
      position: [i / 10, 1.6, -1], confirmed: true, status: 'scanned' });
    receive('observeTarget', { id: 'far', label: 'Laptop', score: 1, position: [0, 1.6, -4], confirmed: true, status: 'scanned' });
    const visible = Reflect.get(app, 'visibleTargets') as Set<string>;
    expect(visible.size).toBe(6); expect(visible.has('far')).toBe(false);
    const observed = Reflect.get(app, 'observed') as Map<string, { at: number }>;
    for (const entry of observed.values()) entry.at -= 401;
    receive('refreshAnnotations', true);
    expect(visible.size).toBe(0);
    expect(erase).toHaveBeenCalled();
  });

  it('a HUD-consumed pinch never tags an object behind the panel', () => {
    const { app, target, ws } = shell();
    Reflect.set(app, 'consumed', { left: false, right: true });
    const origin = new Vector3(0, 1.6, 0), ray = { origin, dir: target.position.clone().sub(origin).normalize() };
    const frame = { time: 100, dt: 1 / 90, head: { position: origin, quaternion: new Quaternion(), ray },
      hands: { right: { joints: {}, ray, pinchPoint: new Vector3(), pinching: true, justPinched: true, justReleased: false, controller: true } } } as ShellFrame;
    Reflect.get(app, 'interact').call(app, frame, 100);
    expect(ws.send).not.toHaveBeenCalled();
  });
});
