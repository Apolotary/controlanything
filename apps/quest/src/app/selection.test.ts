import { PerspectiveCamera, Quaternion, Scene, Vector3, type WebGLRenderer } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { EXAMPLES } from '@ce/gen3d';
import { TargetStore, toHudTarget } from '../scan/targets';
import { QuestApp } from './app';
import { ModeState } from './modes';
import type { ShellFrame } from './hud-contract';
import { PinchTargetHistory } from './precision';
import { GestureMap, makeMessage } from '@ce/protocol';
import { makeGestureFrame, moveHand, setPosture } from '../gestures/fixtures.test-support';
import { RoomAnchors } from '../anchors/room';
import { HelperOnboarding } from './onboarding';
import { createHud } from '../hud/v2';

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
    setHome: vi.fn(), setOnboarding: vi.fn(), showApprovals: vi.fn(), setDeviceState: vi.fn(), setSetupProgress: vi.fn(), setArmed: vi.fn(), showConfirm: vi.fn(), hideHackMenu: vi.fn(), renderSpec: vi.fn(), removeSpec: vi.fn(), showHackMenu: vi.fn(), toast: vi.fn(), recenter: vi.fn() };
  const scanner = { active: true, stop: vi.fn(), start: vi.fn() };
  const ws = { open: true, send: vi.fn<(...args: [string, unknown, unknown?]) => string | null>(() => 'sent') };
  const modes = new ModeState();
  Object.assign(app, {
    roomAnchors: new RoomAnchors({ save: vi.fn(), locate: vi.fn() }),
    targets, live, hud, scanner, ws, modes, onboarding: new HelperOnboarding(), lockedId: null, filter: 'electronics', params: new URLSearchParams(), cameraState: 'on',
    desktopCam: { position: new Vector3(0, 1.6, 0), quaternion: new Quaternion() }, controls: { clear: vi.fn(), push: vi.fn() },
    handFeedback: { setHover: vi.fn() }, recorder: { input: vi.fn() }, page: { log: vi.fn() },
    input: { mouseAsHand: true, pointer: { inside: true } },
    candidate: { id: null, shown: null, since: 0 }, consumed: { left: false, right: false },
    targetHistory: { left: new PinchTargetHistory<string>(), right: new PinchTargetHistory<string>() }, annotationForward: new Vector3(),
    aimTargets: new Map(), aimBuffer: [], observed: new Map(), mountedTargets: new Set(), visibleTargets: new Set([target.id, liveBox.id]),
    armedCards: new Set(), virtualCards: new Set(), cancelledCards: new Set(), generated: new Map(), gestureSpecs: new Map(), deferredSpecs: new Map(), controlValues: new Map(), specByCard: new Map(), specRevisions: new Map(), cardOfSpec: new Map(), uiSpecOfGen3d: new Map(), menuSpec: new Map(),
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

describe('selected device setup progress', () => {
  it('releases setup busy state when the server rejects missing MIDI-chart prerequisites', () => {
    const { app, target, modes, connected, receive, ws } = shell(); connected('setup');
    app.setupControl(target.id);
    expect(Reflect.get(app, 'activeSetup')).toBe('laptop');
    expect(modes.tags.get(target.id)?.busy).toBe(true);
    const sends = ws.send.mock.calls.length;
    receive('onTargetStatus', { cardId: 'laptop', runId: 'chart-preflight', state: 'failed', since: 1,
      sentence: 'Review the MIDI chart first', detail: 'Firmware is not confirmed. Review the incoming MIDI chart.', hint: 'Review the incoming MIDI chart on Mac Details.', action: 'retry' });
    expect(Reflect.get(app, 'activeSetup')).toBeUndefined();
    expect(modes.tags.get(target.id)?.busy).toBe(false);
    expect(modes.tags.get(target.id)?.sentence).toBe('Review the MIDI chart first');
    expect(modes.canSetup(target.id)).toBe(true);
    expect(app.lockedId).toBe(target.id);
    expect(ws.send.mock.calls.length).toBe(sends);
  });

  it('invalidates old identity controls without losing the selected pose or pending identity reply', () => {
    const { app, target, connected, receive, hud, ws, modes } = shell(); connected('ready');
    const cancel = vi.fn(), reset = vi.fn();
    Object.assign(app, { assistant: { cancel }, activeSetup: 'laptop', pendingArm: 'old-arm', armRequest: { cardId: 'laptop' },
      handMapping: { targetId: target.id, session: { engine: { reset } } } });
    modes.tags.get(target.id)!.specId = 'old-ui';
    const caches = ['specByCard', 'specRevisions', 'cardOfSpec', 'uiSpecOfGen3d', 'generated', 'deferredSpecs', 'gestureSpecs', 'menuSpec', 'controlValues'] as const;
    Reflect.get(app, 'specByCard').set('laptop', 'old-ui'); Reflect.get(app, 'cardOfSpec').set('old-ui', 'laptop');
    Reflect.get(app, 'uiSpecOfGen3d').set('old-render', 'old-ui');
    Reflect.get(app, 'generated').set('laptop', { ...EXAMPLES.light, specId: 'old-render' });
    Reflect.get(app, 'deferredSpecs').set('laptop', { cardId: 'laptop', specId: 'old-ui' });
    Reflect.get(app, 'gestureSpecs').set('laptop', { cardId: 'laptop', specId: 'old-ui' });
    Reflect.get(app, 'menuSpec').set(target.id, 'old-ui'); Reflect.get(app, 'controlValues').set('old-ui:cutoff', 20);
    const position = target.position.clone(); ws.send.mockClear();
    receive('onTagsState', { tags: [{ cardId: 'laptop', label: 'OP-1 Field', name: 'OP-1 Field', identityRevision: 1, connection: 'setup' }] });
    expect(app.lockedId).toBe(target.id); expect(target.position).toEqual(position); expect(target.label).toBe('OP-1 Field');
    for (const cache of caches) expect(Reflect.get(app, cache).size).toBe(0);
    expect(modes.tags.get(target.id)?.specId).toBeUndefined(); expect(Reflect.get(app, 'handMapping')).toBeUndefined();
    expect(Reflect.get(app, 'activeSetup')).toBeUndefined(); expect(Reflect.get(app, 'pendingArm')).toBeUndefined();
    expect(reset).toHaveBeenCalledOnce(); expect(cancel).not.toHaveBeenCalled();
    expect(hud.removeSpec).toHaveBeenCalledWith('old-render'); expect(hud.removeSpec).toHaveBeenCalledWith('old-ui');
    expect(ws.send).not.toHaveBeenCalled();
    expect(hud.setDeviceState).toHaveBeenLastCalledWith(expect.objectContaining({ targetId: target.id, performAvailable: false, connection: 'setup' }));
    receive('onUiSpec', { cardId: 'laptop', specId: 'old-ui', gen3d: { ...EXAMPLES.light, specId: 'old-render' } });
    expect(Reflect.get(app, 'deferredSpecs').size).toBe(0);
    receive('onTagsState', { tags: [{ cardId: 'laptop', label: 'Old keyboard', connection: 'ready', specId: 'old-ui', identityRevision: 0 }] });
    expect(target.label).toBe('OP-1 Field'); expect(modes.tags.get(target.id)?.connection).toBe('setup');
  });

  const progress = (cardId = 'laptop', from = 'server') => makeMessage('target.status', {
    cardId, runId: 'run-build', state: 'driving', since: 1,
  }, { from });

  it('shows only trusted progress for the selected tagged device', () => {
    const { connected, receive, hud, app } = shell();
    connected();
    receive('onSetupProgress', progress('laptop', 'other-headset'));
    expect(hud.setSetupProgress).toHaveBeenLastCalledWith(null);
    receive('onSetupProgress', progress('unselected-device'));
    expect(hud.setSetupProgress).toHaveBeenLastCalledWith(null);
    receive('onSetupProgress', progress());
    expect(hud.setSetupProgress).toHaveBeenLastCalledWith(expect.objectContaining({ cardId: 'laptop', working: true }));
    app.release();
    expect(hud.setSetupProgress).toHaveBeenLastCalledWith(null);
  });

  it('clears cancelled work and ignores late progress until an explicit retry', () => {
    const { connected, receive, hud, app, target } = shell();
    connected(); app.setupControl(target.id);
    receive('onSetupProgress', progress());
    app.cancelControl(target.id);
    expect(hud.setSetupProgress).toHaveBeenLastCalledWith(null);
    receive('onSetupProgress', progress());
    expect(hud.setSetupProgress).toHaveBeenLastCalledWith(null);
    app.setupControl(target.id);
    expect(hud.setSetupProgress).toHaveBeenLastCalledWith(null);
    receive('onSetupProgress', makeMessage('target.status', { cardId: 'laptop', runId: 'run-retry', state: 'linking', since: 2 }, { from: 'server' }));
    expect(hud.setSetupProgress).toHaveBeenLastCalledWith(expect.objectContaining({ runId: 'run-retry' }));
    expect(hud.setSetupProgress.mock.lastCall?.[0]?.artifact).toBeUndefined();
  });

  it('hides build history during hand performance and annotation mode', () => {
    const { connected, receive, hud, app, target } = shell();
    connected(); receive('onSetupProgress', progress());
    Object.assign(app, { handMapping: { targetId: target.id } });
    receive('refreshSetupProgress', undefined);
    expect(hud.setSetupProgress).toHaveBeenLastCalledWith(null);
    Object.assign(app, { handMapping: undefined });
    app.setMode('annotate');
    expect(hud.setSetupProgress).toHaveBeenLastCalledWith(null);
  });
});

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

describe('direct visual synth selection', () => {
  const headset = () => {
    const state = shell();
    Object.assign(state.app, { session: {}, lastFrame: {
      head: { position: new Vector3(0, 1.6, 0), quaternion: new Quaternion() },
    } });
    return state;
  };

  it('requires a connected AR session and never starts setup while selecting', () => {
    const { app, ws } = shell();
    expect(app.selectVisualSynth()).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
    Object.assign(app, { session: {}, lastFrame: { head: { position: new Vector3(), quaternion: new Quaternion() } } });
    ws.open = false;
    expect(app.selectVisualSynth()).toBe(false);
    expect(ws.send.mock.calls.some(([type]) => type === 'target.select')).toBe(false);
  });

  it.skip('selects a distinct known instrument instead of the previously selected MacBook', () => {
    const { app, target, ws, receive, hud, connected } = headset();
    connected();
    const oldPosition = target.position.clone();
    ws.send.mockClear();
    expect(app.selectVisualSynth()).toBe(true);
    const pending = Reflect.get(app, 'virtualSelection');
    expect(ws.send.mock.calls.map(([type]) => type)).toEqual(['mode.set', 'target.select']);
    expect(ws.send).toHaveBeenLastCalledWith('target.select', expect.objectContaining({
      virtual: 'visual-synth', requestId: pending.requestId, position: { x: 0, y: 1.55, z: -1.2 },
    }), { to: 'server' });
    receive('onTagsState', { tags: [
      { cardId: 'laptop', label: 'Laptop', connection: 'setup' },
      { cardId: 'virtual-one', name: 'ControlAnything Visual Synth', label: 'ControlAnything Visual Synth', connection: 'setup' },
    ] });
    receive('onVirtualSelection', { requestId: pending.requestId, ok: true, cardId: 'virtual-one' });
    const chosen = app.targets.byCard('virtual-one')!;
    expect(app.lockedId).toBe(chosen.id);
    expect(chosen).not.toBe(target);
    expect(chosen.method).toBe('virtual-display');
    expect(chosen.confirmed).toBe(false);
    expect(target.position).toEqual(oldPosition);
    expect(hud.setDeviceState).toHaveBeenLastCalledWith(expect.objectContaining({ connection: 'setup', screenGuide: true }));
    expect(hud.recenter).toHaveBeenCalledTimes(2);
    expect(ws.send.mock.calls.some(([type]) => ['control.setup', 'control.arm', 'control.invoke', 'gesture.apply'].includes(type))).toBe(false);
    expect(Reflect.get(app, 'virtualSelection')).toBeUndefined();
  });

  it('ignores unrelated and abandoned results, and surfaces a failed selection', () => {
    const { app, hud, receive } = headset();
    app.selectVisualSynth();
    const pending = Reflect.get(app, 'virtualSelection');
    receive('onVirtualSelection', { requestId: 'old', ok: true, cardId: 'wrong' });
    expect(Reflect.get(app, 'virtualSelection')).toBe(pending);
    receive('onVirtualSelection', { requestId: pending.requestId, ok: false, reason: 'Open visuals on your Mac.' });
    expect(hud.setHome).toHaveBeenLastCalledWith(expect.objectContaining({ visualSynthSelection: expect.objectContaining({ phase: 'unavailable', message: 'Open visuals on your Mac.' }) }));
    expect(app.lockedId).toBeNull();
    app.selectVisualSynth();
    const cancelled = Reflect.get(app, 'virtualSelection');
    app.setMode('annotate');
    receive('onVirtualSelection', { requestId: cancelled.requestId, ok: true, cardId: 'late' });
    expect(app.targets.byCard('late')).toBeUndefined();
    expect(app.modes.mode).toBe('annotate');
  });

  it('retains an actionable missing-screen state after ten seconds', () => {
    vi.useFakeTimers();
    try {
      const { app, hud } = headset();
      app.selectVisualSynth();
      vi.advanceTimersByTime(10_000);
      expect(Reflect.get(app, 'virtualSelection')).toBeUndefined();
      expect(hud.setHome).toHaveBeenLastCalledWith(expect.objectContaining({ visualSynthSelection: expect.objectContaining({ phase: 'unavailable', message: expect.stringContaining('did not respond') }) }));
      app.release();
    } finally { vi.useRealTimers(); }
  });

  it.skip('resumes selection once on a newly ready renderer, never setup, and stops after changing device', () => {
    const { app, ws, receive, connected, target } = headset(); connected();
    app.selectVisualSynth();
    receive('onVirtualSelection', { requestId: Reflect.get(app, 'virtualSelection').requestId, ok: false, reason: 'Open visuals on your Mac.' });
    expect(app.lockedId).toBeNull();
    app.lock(target.id, 'chip'); expect(app.lockedId).toBeNull();
    const devices = [{ deviceId: 'mac', name: 'Mac', kind: 'mac', role: 'companion', online: true, capabilities: ['midi'], ports: [{ id: 'ce-visual-synth', kind: 'midi-out', state: 'connected' }] }];
    ws.send.mockClear(); receive('updateVisualSynthPresence', devices);
    expect(ws.send.mock.calls.filter(([type]) => type === 'target.select')).toHaveLength(1);
    receive('onVirtualSelection', { requestId: Reflect.get(app, 'virtualSelection').requestId, ok: false, reason: 'Keep one screen open.' });
    receive('updateVisualSynthPresence', devices);
    expect(ws.send.mock.calls.filter(([type]) => type === 'target.select')).toHaveLength(1);
    expect(ws.send.mock.calls.some(([type]) => ['control.setup', 'control.arm', 'control.invoke'].includes(type))).toBe(false);
    app.release(); receive('updateVisualSynthPresence', []); receive('updateVisualSynthPresence', devices);
    expect(ws.send.mock.calls.filter(([type]) => type === 'target.select')).toHaveLength(1);
    app.lock(target.id, 'chip'); expect(app.lockedId).toBe(target.id);
  });

  it('keeps control selection stable for incidental pinches until explicitly released', () => {
    const { app, connected, target, receive, modes } = headset(); connected();
    receive('onTagsState', { tags: [{ cardId: 'laptop', label: 'Laptop', connection: 'ready' },
      { cardId: 'other', label: 'Other device', connection: 'ready', position: { x: 0.1, y: 1.6, z: -1 } }] });
    const other = modes.byCard('other')!.targetId;
    const placed = Reflect.get(app, 'materializeTarget').call(app, { id: other, label: 'Other device', position: [0.3, 1.6, -1], status: 'scanned', confirmed: true }, 'other');
    app.targets.reattach(other, placed, 'other');
    for (const how of ['chip', 'touch', 'ray', 'gaze']) { app.lock(other, how); expect(app.lockedId).toBe(target.id); }
    app.release(); app.lock(other, 'chip'); expect(app.lockedId).toBe(other);
  });

  it('retries selection once after server reconnection with the same ready renderer', () => {
    const { app, ws, receive } = headset();
    const devices = [{ deviceId: 'mac', kind: 'mac', role: 'companion', online: true, capabilities: ['midi'], ports: [{ id: 'ce-visual-synth', kind: 'midi-out', state: 'connected' }] }];
    receive('updateVisualSynthPresence', devices); app.selectVisualSynth();
    const stale = Reflect.get(app, 'virtualSelection').requestId;
    ws.open = false; receive('disconnectVisualSynthSelection', undefined); ws.send.mockClear();
    receive('onVirtualSelection', { requestId: stale, ok: true, cardId: 'stale' });
    expect(app.lockedId).toBeNull();
    receive('updateVisualSynthPresence', devices); expect(ws.send).not.toHaveBeenCalled();
    ws.open = true; receive('updateVisualSynthPresence', devices); receive('updateVisualSynthPresence', devices);
    expect(ws.send.mock.calls.filter(([type]) => type === 'target.select')).toHaveLength(1);
    app.release();
  });

  it('routes Inspect only to the current selection without invoking setup or needing a microphone', () => {
    const { app, connected, target, ws } = headset(); connected();
    const sendText = vi.fn(); Object.assign(app, { assistant: { sendText } }); ws.send.mockClear();
    Reflect.get(app, 'askSelectedObject').call(app, 'other', 'Inspect this object');
    expect(sendText).not.toHaveBeenCalled();
    Reflect.get(app, 'askSelectedObject').call(app, target.id, 'Inspect this object');
    expect(sendText).toHaveBeenCalledExactlyOnceWith('Inspect this object'); expect(ws.send).not.toHaveBeenCalled();
  });
});

describe('explicit annotation and control', () => {
  it('keeps mode changes local even after acknowledgement, reconnect snapshots, and delayed echoes', () => {
    const { app, receive, hud, ws } = shell();
    app.onboarding.update({ urls: ['http://localhost:8787/pair'], helpers: [] }, 0);
    app.onboarding.enter(0); app.onboarding.skip();
    app.setMode('annotate');
    receive('onModeState', { mode: 'annotate' });
    ws.send.mockClear();
    receive('onModeState', { mode: 'control' });
    expect(app.modes.mode).toBe('annotate');
    expect(app.onboarding.guide(0)?.step).toBe('tag');
    expect(ws.send).toHaveBeenLastCalledWith('mode.set', { mode: 'annotate' }, { to: 'server' });
    app.setMode('control');
    expect(hud.setOnboarding).toHaveBeenLastCalledWith(null);
    receive('onModeState', { mode: 'annotate' });
    expect(app.modes.mode).toBe('control');
    receive('onModeState', { mode: 'control' });
    expect(app.lockedId).toBeNull();
    expect(ws.send.mock.calls.some(([type]) => type === 'control.setup')).toBe(false);
  });

  it('replayed tags and pipeline updates cannot restore a busy card or select a device', () => {
    const { app, target, receive, hud, modes, ws } = shell();
    app.lock(target.id);
    receive('onTagsState', { tags: [{ cardId: 'laptop', label: 'Laptop', connection: 'ready', position: { x: 0, y: 1.6, z: -1 } }] });
    Object.assign(modes.tags.get(target.id)!, { busy: true, sentence: 'Testing the device' });
    receive('onTagsState', { tags: [{ cardId: 'laptop', label: 'Laptop', connection: 'ready' }] });
    receive('onTargetStatus', { cardId: 'laptop', state: 'verifying', sentence: 'Testing the device' });
    receive('onAgentStep', { cardId: 'laptop', sentence: 'Testing the device' });
    receive('onUiSpec', { cardId: 'laptop', specId: 'saved-ui', gen3d: { ...EXAMPLES.light, specId: 'saved' } });
    expect(modes.tags.get(target.id)).toMatchObject({ busy: false, sentence: undefined });
    expect(app.lockedId).toBeNull();
    app.setMode('control');
    expect(app.lockedId).toBeNull();
    expect(hud.setDeviceState).toHaveBeenLastCalledWith(null);
    expect(ws.send.mock.calls.some(([type]) => type === 'control.setup')).toBe(false);
  });

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

  it.skip.each(['untag', 'snapshot'] as const)('keeps a named synth eligible for re-tagging after %s removes its tag', (source) => {
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
    const request = { armId: 'arm', cardId: 'laptop', title: 'MacBook Pro is ready', summary: 'All 2 command checks passed.', irreversible: true, expiresAt: Date.now() + 5000 };
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

  it.skip('keeps three central candidates, fades stale detections, and hides distant or peripheral devices', () => {
    const { app, receive } = shell();
    const draw = vi.fn(), erase = vi.fn();
    Object.assign(app, { drawTarget: draw, eraseTarget: erase });
    for (let i = 0; i < 8; i++) receive('observeTarget', { id: i < 4 ? `yolo_box${i}` : `box${i}`, label: 'Laptop', score: 0.9,
      position: [i / 10, 1.6, -1], confirmed: true, status: 'scanned' });
    receive('observeTarget', { id: 'far', label: 'Laptop', score: 1, position: [0, 1.6, -4], confirmed: true, status: 'scanned' });
    const visible = Reflect.get(app, 'visibleTargets') as Set<string>;
    expect([...visible]).toEqual(['yolo_box0', 'yolo_box1', 'yolo_box2']);
    expect(visible.has('far')).toBe(false);
    const observed = Reflect.get(app, 'observed') as Map<string, { at: number }>;
    // live YOLO boxes fade after 0.4 s unseen; SAM-only boxes (refreshed once per scan cycle) after 3.5 s
    for (const entry of observed.values()) entry.at -= 401;
    receive('refreshAnnotations', true);
    expect([...visible].some((id) => id.startsWith('yolo_'))).toBe(false);
    expect([...visible]).toEqual(['box4', 'box5', 'box6']); // The same shared budget applies after the fast detections expire.
    expect(erase).toHaveBeenCalled();
    for (const entry of observed.values()) entry.at -= 3500;
    receive('refreshAnnotations', true);
    expect(visible.size).toBe(0);
  });

  it.skip.each([false, true])('removes an out-of-region renderer target hidden by Menu (saved=%s)', (saved) => {
    const { app, modes, receive } = shell();
    const hud = createHud({ scene: new Scene(), camera: new PerspectiveCamera(), renderer: {} as WebGLRenderer });
    Object.assign(app, { hud, hudKind: 'v2', drawTarget: hud.upsertTarget.bind(hud), eraseTarget: hud.removeTarget.bind(hud), visibleTargets: new Set(), filter: 'everything' });
    const frame = { time: 100, dt: 1 / 72, pointer: 'mouse' as const, head: { position: new Vector3(0, 1.6, 0), quaternion: new Quaternion() }, hands: {} };
    const visibleLabels = () => { const ids: string[] = []; hud.root.traverseVisible(node => { if (node.name.startsWith('target-label:')) ids.push(node.name.slice('target-label:'.length)); }); return ids.sort(); };
    try {
      hud.setHome?.({ mode: 'annotate', filter: 'everything', tagged: saved ? 1 : 0, status: '' }); hud.update(frame);
      if (saved) modes.tags.set('outside', { targetId: 'outside', cardId: 'saved-outside', label: 'Air conditioner', name: 'Air conditioner', connection: 'offline' });
      receive('observeTarget', { id: 'outside', label: 'Air conditioner', score: 0.9, position: [-0.2, 1.6, -1], confirmed: true, status: 'scanned' });
      receive('observeTarget', { id: 'inside', label: 'Ceiling light', score: 0.9, position: [0.2, 1.6, -1], confirmed: true, status: 'scanned' });
      hud.update({ ...frame, time: 200 }); receive('refreshAnnotations', true);
      expect(visibleLabels()).toEqual(['inside', 'outside']);
      hud.setDeck({ open: true }); receive('refreshAnnotations', true);
      expect(Reflect.get(app, 'visibleTargets').size).toBe(0);
      expect([...Reflect.get(app, 'mountedTargets')].sort()).toEqual(['inside', 'outside']);
      Object.assign(app, { manualRegion: { active: true }, manualFocusIds: new Set<string>() });
      receive('refreshAnnotations', true);
      expect(Reflect.get(app, 'mountedTargets').size).toBe(0);
      expect(hud.root.getObjectByName('target-label:outside')).toBeUndefined();
      Object.assign(app, { manualRegion: { active: false }, manualFocusIds: new Set(['inside']) });
      receive('refreshAnnotations', true); hud.setDeck({ open: false }); hud.update({ ...frame, time: 300 }); receive('refreshAnnotations', true);
      expect(visibleLabels()).toEqual(['inside']);
      expect([...Reflect.get(app, 'visibleTargets')]).toEqual(['inside']);
      hud.setDeck({ open: true }); receive('refreshAnnotations', true); hud.setDeck({ open: false }); hud.update({ ...frame, time: 400 });
      expect(visibleLabels()).toEqual(['inside']);
      receive('clearAnnotations', undefined);
      expect(visibleLabels()).toEqual([]); expect(Reflect.get(app, 'mountedTargets').size).toBe(0);
      expect(Reflect.get(app, 'observed').size).toBe(0);
    } finally { hud.dispose(); }
  });

  it.skip('filters annotations on the raw label, not the shortened display label', () => {
    const { app, receive } = shell();
    Object.assign(app, { drawTarget: vi.fn(), eraseTarget: vi.fn() });
    receive('observeTarget', { id: 'vsynth', label: 'Controlanything visua…', rawLabel: 'ControlAnything Visual Synth', score: 0.9,
      position: [0, 1.4, -1.5], confirmed: true, status: 'scanned' });
    expect((Reflect.get(app, 'visibleTargets') as Set<string>).has('vsynth')).toBe(true);
  });

  it('does not revive stale estimated tags when their label is repainted', () => {
    const { app, target, receive, connected } = shell();
    connected();
    app.setMode('annotate');
    target.lastSeenAt = Date.now() - 5_000;
    receive('observeTarget', toHudTarget(target));
    const visible = Reflect.get(app, 'visibleTargets') as Set<string>;
    expect(visible.has(target.id)).toBe(false);
    expect(app.modes.tags.has(target.id)).toBe(true); // Hiding an old estimate does not forget a saved device.
    target.confirmed = true;
    receive('observeTarget', toHudTarget(target));
    expect(visible.has(target.id)).toBe(true);
    target.position.z = 1;
    receive('observeTarget', toHudTarget(target));
    expect(visible.has(target.id)).toBe(false);
  });

  it('keeps the selected control mounted while looking away', () => {
    const { app, target, receive, connected } = shell();
    const erase = vi.fn();
    Object.assign(app, { eraseTarget: erase });
    connected();
    erase.mockClear();
    target.position.z = 1;
    receive('observeTarget', toHudTarget(target));
    expect((Reflect.get(app, 'visibleTargets') as Set<string>).has(target.id)).toBe(true);
    expect(erase).not.toHaveBeenCalledWith(target.id);
    expect(app.lockedId).toBe(target.id);
    app.release();
    receive('refreshAnnotations', true);
    expect(erase).toHaveBeenCalledWith(target.id);
  });

  it('refreshes a saved estimated target only when the runtime supplies a new anchor pose', () => {
    const { app, target, receive, connected } = shell();
    connected();
    app.setMode('annotate');
    target.lastSeenAt = Date.now() - 5_000;
    receive('observeTarget', toHudTarget(target));
    expect((Reflect.get(app, 'visibleTargets') as Set<string>).has(target.id)).toBe(false);
    Reflect.get(app, 'locateSavedDevice').call(app, 'laptop', new Vector3(0, 1.6, -1));
    expect((Reflect.get(app, 'visibleTargets') as Set<string>).has(target.id)).toBe(true);
    expect(target.confirmed).toBe(false);
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


it.skip('does not aim at an annotation the HUD could not allocate', () => {
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
