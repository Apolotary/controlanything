import { Quaternion, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { EXAMPLES } from '@ce/gen3d';
import { TargetStore, toHudTarget } from '../scan/targets';
import { QuestApp } from './app';
import { ModeState } from './modes';
import type { ShellFrame } from './hud-contract';
import { PinchTargetHistory } from './precision';
import { GestureMap } from '@ce/protocol';
import { makeGestureFrame, moveHand, setPosture } from '../gestures/fixtures.test-support';
import { RoomAnchors } from '../anchors/room';

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
    setHome: vi.fn(), setDeviceState: vi.fn(), setArmed: vi.fn(), showConfirm: vi.fn(), hideHackMenu: vi.fn(), renderSpec: vi.fn(), removeSpec: vi.fn(), showHackMenu: vi.fn() };
  const scanner = { active: true, stop: vi.fn(), start: vi.fn() };
  const ws = { send: vi.fn<(...args: [string, unknown, unknown?]) => string | null>(() => 'sent') };
  const modes = new ModeState();
  Object.assign(app, {
    roomAnchors: new RoomAnchors({ save: vi.fn(), locate: vi.fn() }),
    targets, live, hud, scanner, ws, modes, lockedId: null, filter: 'electronics', params: new URLSearchParams(), cameraState: 'on',
    desktopCam: { position: new Vector3(0, 1.6, 0), quaternion: new Quaternion() }, controls: { clear: vi.fn(), push: vi.fn() },
    handFeedback: { setHover: vi.fn() }, recorder: { input: vi.fn() }, page: { log: vi.fn() },
    input: { mouseAsHand: true, pointer: { inside: true } },
    candidate: { id: null, shown: null, since: 0 }, consumed: { left: false, right: false },
    targetHistory: { left: new PinchTargetHistory<string>(), right: new PinchTargetHistory<string>() }, annotationForward: new Vector3(),
    aimTargets: new Map(), aimBuffer: [], observed: new Map(), visibleTargets: new Set([target.id, liveBox.id]),
    armedCards: new Set(), cancelledCards: new Set(), generated: new Map(), gestureSpecs: new Map(), deferredSpecs: new Map(), controlValues: new Map(), specByCard: new Map(), cardOfSpec: new Map(), uiSpecOfGen3d: new Map(), menuSpec: new Map(),
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

describe('saved device placement', () => {
  const saved = (cardId: string) => ({ cardId, displayName: 'Saved laptop', identity: { label: 'Laptop' }, hidden: false,
    enabled: true, versions: [], createdAt: 1, updatedAt: 1, connection: 'ready',
    placement: { headsetId: 'quest', origin: 'https://room.test', panelOffset: { x: 0, y: 0, z: 0 }, fallback: { label: 'Laptop' }, updatedAt: 1 } });

  it('ignores stored XYZ and reattaches the identical interface to a fresh detection without setup', () => {
    const { app, target, receive, hud, ws, modes } = shell();
    app.roomAnchors.begin({}, 'quest', 'https://room.test');
    receive('onLibraryState', { devices: [saved('saved-card')] });
    receive('onTagsState', { tags: [{ cardId: 'saved-card', label: 'Laptop', connection: 'ready', position: { x: 100, y: 100, z: 100 } }] });
    expect(app.targets.byCard('saved-card')).toBeUndefined();
    const spec = { ...EXAMPLES.light, specId: 'saved-interface' };
    receive('onUiSpec', { cardId: 'saved-card', specId: 'saved-ui', gen3d: spec });
    expect(hud.renderSpec).not.toHaveBeenCalled();
    receive('reassociateDetections', [target]);
    const placed = app.targets.byCard('saved-card')!;
    expect(placed.position).toEqual(new Vector3(0, 1.6, -1)); expect(placed.method).toBe('reassociated');
    expect(modes.byCard('saved-card')?.connection).toBe('ready'); expect(app.roomAnchors.states.get('saved-card')).toBe('located');
    expect(hud.renderSpec).toHaveBeenCalledWith(expect.objectContaining({ specId: 'saved-interface' }), { targetId: placed.id });
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('requires a saved-device choice and a placement pinch for ambiguous twins', () => {
    const { app, target, receive, hud, ws, modes } = shell();
    app.roomAnchors.begin({}, 'quest', 'https://room.test');
    receive('onLibraryState', { devices: [saved('one'), saved('two')] });
    receive('reassociateDetections', [target]); expect(target.cardId).toBeUndefined();
    app.lock(target.id);
    expect(hud.showConfirm).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'place', id: 'place:one', cancelLabel: 'Next' }));
    app.answerConfirm('place:one', false); app.answerConfirm('place:two', true);
    expect(app.targets.byCard('two')).toBe(target); expect(modes.byCard('two')).toBeDefined(); expect(ws.send).not.toHaveBeenCalled();
  });

  it('sends forget only after confirmation and removes the saved controls from this client', () => {
    const { app, target, receive, hud, ws, modes } = shell();
    receive('onLibraryState', { devices: [saved('saved-card')] });
    receive('onTagsState', { tags: [{ cardId: 'saved-card', label: 'Laptop', connection: 'ready' }] });
    receive('reassociateDetections', [target]);
    app.requestForget(target.id); expect(ws.send).not.toHaveBeenCalled();
    expect(hud.showConfirm).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'forget', primaryLabel: 'Forget' }));
    app.answerConfirm('forget:saved-card', false); expect(ws.send).not.toHaveBeenCalled();
    app.requestForget(target.id); app.answerConfirm('forget:saved-card', true);
    expect(ws.send).toHaveBeenCalledExactlyOnceWith('library.forget', { cardId: 'saved-card' }, { to: 'server' });
    expect(modes.byCard('saved-card')).toBeUndefined(); expect(app.targets.byCard('saved-card')).toBeUndefined();
  });

  it('never treats a failed anchor locating marker as a new physical placement', () => {
    const { app, receive } = shell();
    app.roomAnchors.begin({}, 'quest', 'https://room.test');
    receive('onLibraryState', { devices: [saved('saved-card')] });
    receive('onTagsState', { tags: [{ cardId: 'saved-card', label: 'Laptop', connection: 'ready' }] });
    app.roomAnchors.states.set('saved-card', 'locating');
    Reflect.get(app, 'locateSavedDevice').call(app, 'saved-card', null);
    expect(app.targets.byCard('saved-card')?.locating).toBe(true);
    app.roomAnchors.states.set('saved-card', 'unlocated');
    const place = vi.spyOn(app.roomAnchors, 'place');
    receive('onLibraryState', { devices: [saved('saved-card')] });
    receive('onTagsState', { tags: [{ cardId: 'saved-card', label: 'Laptop', connection: 'ready' }] });
    expect(place).not.toHaveBeenCalled();
    Reflect.get(app, 'locateSavedDevice').call(app, 'saved-card', null);
    expect(app.targets.byCard('saved-card')).toBeUndefined();
  });
});

describe('explicit annotation and control', () => {
  it('requires Perform and a live selected connection before synthetic hand frames can send gesture controls', () => {
    const { app, target, connected, receive, ws, modes } = shell();
    connected('ready');
    const map = GestureMap.parse({ version: 1, clutchPosture: 'L_FIST', panicPosture: 'BOTH_PALMS_OUT', postures: [], axes: [{
      axis: 'right_height', actionId: 'visual-warp', label: 'Warp', outMin: 0, outMax: 127, curve: 'linear', deadzone: 0.02,
      smoothingMinCutoff: 1.2, smoothingBeta: 0.4, quantizeStep: 1, maxRateHz: 30,
    }] });
    receive('onUiSpec', { specId: 'ui', cardId: 'laptop', driverId: 'driver', gestureMap: map });
    const frame = makeGestureFrame();
    const update = (time: number) => Reflect.get(app, 'updateHandControl').call(app, frame, time);
    const gestures = () => ws.send.mock.calls.filter(([type, payload]) => type === 'control.event' && (payload as { widgetId: string }).widgetId.startsWith('gesture:'));
    update(0); update(50);
    expect(gestures()).toHaveLength(0);
    Reflect.get(app, 'setHandControl').call(app, target.id, true);
    update(60); update(110);
    moveHand(frame.hands.right!, 0.2, 1.5, -0.4);
    update(150);
    expect(gestures()).toHaveLength(1);
    expect(gestures()[0]![1]).toMatchObject({ specId: 'ui', widgetId: 'gesture:right_height', phase: 'move' });
    setPosture(frame.hands.left!, 'open_palm');
    moveHand(frame.hands.right!, 0.2, 0.8, -0.4);
    update(160); update(200);
    expect(gestures()).toHaveLength(1);
    setPosture(frame.hands.left!, 'fist');
    update(210); update(260);
    modes.tags.get(target.id)!.connection = 'offline';
    moveHand(frame.hands.right!, 0.2, 1.6, -0.4);
    update(300);
    expect(gestures()).toHaveLength(1);
    expect(Reflect.get(app, 'handMapping')).toBeUndefined();
  });

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

  it('keeps the tag identifying until the server supplies its device name', () => {
    const { app, target, receive } = shell();
    const observed = () => Reflect.get(app, 'observed').get(target.id).target;
    app.lock(target.id);
    receive('observeTarget', toHudTarget(target));
    expect(observed()).toMatchObject({ label: 'Laptop', tagged: true, identifying: true });
    receive('onTagsState', { tags: [{ cardId: 'laptop', label: 'Laptop', connection: 'setup' }] });
    expect(observed()).toMatchObject({ label: 'Laptop', identifying: true });
    receive('onTagsState', { tags: [{ cardId: 'laptop', label: 'Laptop', name: 'MacBook Pro', connection: 'setup' }] });
    expect(observed()).toMatchObject({ label: 'MacBook Pro', identifying: false });
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
    const { app, target, connected, receive, ws, hud } = shell();
    connected('offline');
    const hint = 'Open the Mac app to control this laptop.';
    receive('onTagsState', { tags: [{ cardId: 'laptop', label: 'Laptop', connection: 'offline', hint }] });
    app.setupControl(target.id);
    expect(hud.setDeviceState).toHaveBeenLastCalledWith(expect.objectContaining({ targetId: target.id, connection: 'offline', hint }));
    expect(ws.send.mock.calls.some(([type]) => type === 'control.setup')).toBe(false);
  });

  it('untags the selected outline and only tags it again after another explicit pick', () => {
    const { app, target, receive, ws, hud, modes } = shell();
    app.lock(target.id);
    receive('onTagsState', { tags: [{ cardId: 'laptop', label: 'Laptop', connection: 'offline', position: { x: 0, y: 1.6, z: -1 } }] });
    app.lock(target.id);
    app.untag(target.id);
    expect(ws.send).toHaveBeenCalledWith('tag.remove', { cardId: 'laptop' }, { to: 'server' });
    expect(modes.tags.size).toBe(0);
    expect(app.lockedId).toBeNull();
    expect(hud.removeTarget).toHaveBeenCalledWith(target.id);
    receive('onTagsState', { tags: [] });
    app.setMode('control'); app.lock(target.id); app.setupControl(target.id);
    expect(app.lockedId).toBeNull();
    expect(ws.send.mock.calls.some(([type]) => type === 'control.setup')).toBe(false);
    app.setMode('annotate'); app.lock(target.id);
    expect(ws.send.mock.calls.filter(([type]) => type === 'tag.add')).toHaveLength(2);
    expect(modes.tags.has(target.id)).toBe(true);
  });

  it.each(['untag', 'snapshot'] as const)('keeps a named synth eligible for re-tagging after %s removes its tag', (source) => {
    const { app, target, receive, ws, hud } = shell();
    target.label = target.prompt = 'Synthesizer';
    app.lock(target.id);
    receive('onTagsState', { tags: [{ cardId: 'synth', label: 'Synthesizer', name: 'OP-1 Field', connection: 'setup', position: { x: 0, y: 1.6, z: -1 } }] });
    expect(target.label).toBe('OP-1 Field');
    if (source === 'untag') app.untag(target.id);
    receive('onTagsState', { tags: [] });
    // The next detector result keeps the existing tracker, including its display label.
    hud.upsertTarget(toHudTarget(target));
    expect((Reflect.get(app, 'visibleTargets') as Set<string>).has(target.id)).toBe(true);
    app.lock(target.id);
    expect(ws.send).toHaveBeenLastCalledWith('tag.add', expect.objectContaining({ targetId: target.id, label: 'Synthesizer' }), { to: 'server' });
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

  it('names the ready device in the control confirmation and preserves its hold requirement', () => {
    const { app, target, connected, receive, hud, modes } = shell();
    connected(); app.setupControl(target.id);
    modes.tags.get(target.id)!.name = 'MacBook Pro';
    const request = { armId: 'arm', cardId: 'laptop', title: 'MacBook Pro is ready', summary: 'All 2 commands worked on the real device.', irreversible: true, expiresAt: Date.now() + 5000 };
    receive('onArmRequest', request);
    expect(hud.showConfirm).toHaveBeenLastCalledWith({ id: 'arm', kind: 'arm', title: 'MacBook Pro is ready', summary: request.summary, hold: true, expiresAt: request.expiresAt, targetId: target.id });
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

  it('removing a tag during setup closes ARM and allows setup for another tagged device', () => {
    const { app, target, connected, receive, ws, hud } = shell();
    connected(); app.setupControl(target.id);
    receive('onArmRequest', { armId: 'removed', cardId: 'laptop', expiresAt: Date.now() + 5000 });
    receive('onTagsState', { tags: [{ cardId: 'other', label: 'Keyboard', connection: 'setup', position: { x: 1, y: 1.6, z: -1 } }] });
    app.answerConfirm('removed', true);
    expect(ws.send.mock.calls.some(([type]) => type === 'arm.confirm')).toBe(false);
    expect(app.lockedId).toBeNull();
    expect(hud.showConfirm).toHaveBeenLastCalledWith(null);
    app.lock('tag:other'); app.setupControl('tag:other');
    expect(ws.send).toHaveBeenLastCalledWith('control.setup', { cardId: 'other' }, { to: 'server' });
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
    expect(app.lockedId).toBeNull();
    expect(hud.setDeviceState).toHaveBeenLastCalledWith(null);
    app.answerConfirm('pending', true);
    receive('onArmResult', { armId: 'pending', cardId: 'laptop', armed: true });
    receive('onTagsState', { tags: [{ cardId: 'laptop', label: 'Laptop', connection: 'ready' }] });
    expect(ws.send.mock.calls.some(([type]) => type === 'arm.confirm')).toBe(false);
    expect(app.modes.tags.get(target.id)).toMatchObject({ busy: false, connection: 'setup' });
  });

  it('Stop closes an armed card and rejects subsequent controls until setup is requested again', () => {
    const { app, target, connected, receive, hud } = shell();
    Object.assign(hud, { toast: vi.fn() });
    connected('ready');
    const spec = { ...EXAMPLES['ceiling-dimmer']!, specId: 'lamp' };
    receive('onUiSpec', { cardId: 'laptop', specId: 'ui', gen3d: spec });
    app.onDeck('panic', 'press');
    expect(app.lockedId).toBeNull();
    expect(hud.setDeviceState).toHaveBeenLastCalledWith(null);
    expect(hud.setArmed).toHaveBeenLastCalledWith('lamp', false);
    app.lock(target.id);
    receive('onControl', { specId: 'lamp', controlId: 'level', value: 80, phase: 'move', ts: 0 });
    expect(app.controls.push).not.toHaveBeenCalled();
    expect(app.modes.tags.get(target.id)?.connection).toBe('setup');
  });

  it('sends continuous light controls and a true trigger release only while ready and selected in Control', () => {
    const { app, target, connected, receive, scanner, ws } = shell();
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
    expect(scanner.start).toHaveBeenCalled();
    expect(app.lockedId).toBeNull();
    app.setMode('control'); app.lock(target.id);
    receive('onControl', { specId: 'lamp', controlId: 'level', value: 40, phase: 'move', ts: 0 });
    expect(push).toHaveBeenCalledTimes(3);
    expect(app.modes.tags.get(target.id)?.connection).toBe('ready');
    expect(ws.send.mock.calls.some(([type]) => type === 'control.setup')).toBe(false);
  });

  it('keeps five central candidates, fades stale detections, and hides distant or peripheral devices', () => {
    const { app, receive } = shell();
    const draw = vi.fn(), erase = vi.fn();
    Object.assign(app, { drawTarget: draw, eraseTarget: erase });
    for (let i = 0; i < 8; i++) receive('observeTarget', { id: i < 4 ? `yolo_box${i}` : `box${i}`, label: 'Laptop', score: 0.9,
      position: [i / 10, 1.6, -1], confirmed: true, status: 'scanned' });
    receive('observeTarget', { id: 'far', label: 'Laptop', score: 1, position: [0, 1.6, -4], confirmed: true, status: 'scanned' });
    const visible = Reflect.get(app, 'visibleTargets') as Set<string>;
    expect([...visible]).toEqual(['yolo_box0', 'yolo_box1', 'yolo_box2', 'yolo_box3', 'box4']);
    expect(visible.has('far')).toBe(false);
    const observed = Reflect.get(app, 'observed') as Map<string, { at: number }>;
    // live YOLO boxes fade after 0.4 s unseen; SAM-only boxes (refreshed once per scan cycle) after 3.5 s
    for (const entry of observed.values()) entry.at -= 401;
    receive('refreshAnnotations', true);
    expect([...visible].some((id) => id.startsWith('yolo_'))).toBe(false);
    expect([...visible]).toEqual(['box4', 'box5', 'box6', 'box7']); // 22-35° off-centre: inside the 40° cone
    expect(erase).toHaveBeenCalled();
    for (const entry of observed.values()) entry.at -= 3500;
    receive('refreshAnnotations', true);
    expect(visible.size).toBe(0);
  });

  it('filters annotations on the raw label, not the shortened display label', () => {
    const { app, receive } = shell();
    Object.assign(app, { drawTarget: vi.fn(), eraseTarget: vi.fn() });
    receive('observeTarget', { id: 'vsynth', label: 'Controlanything visua…', rawLabel: 'ControlAnything Visual Synth', score: 0.9,
      position: [0, 1.4, -1.5], confirmed: true, status: 'scanned' });
    expect((Reflect.get(app, 'visibleTargets') as Set<string>).has('vsynth')).toBe(true);
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


it('does not aim at an annotation the HUD could not allocate', () => {
  const { app, target, hud, receive } = shell();
  Object.assign(app, { hudKind: 'v2', drawTarget: vi.fn(), eraseTarget: vi.fn() });
  Object.assign(hud, { isTargetVisible: vi.fn(() => false) });
  receive('observeTarget', { id: target.id, label: 'Laptop', score: 0.9,
    position: target.position.toArray(), confirmed: true, status: 'scanned' });
  expect(Reflect.get(app, 'aimList').call(app)).toEqual([]);
  Object.assign(hud, { isTargetVisible: vi.fn((id: string) => id === target.id) });
  receive('refreshAnnotations', true);
  expect(Reflect.get(app, 'aimList').call(app).map((entry: { id: string }) => entry.id)).toEqual([target.id]);
});
