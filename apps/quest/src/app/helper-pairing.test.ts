import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PayloadOf } from '@ce/protocol';
import { QuestApp } from './app';
import { ModeState } from './modes';
import { HelperOnboarding } from './onboarding';
import { Emitter } from './emitter';
import { VoiceAssistant } from '../voice/assistant';
import type { PttEvents, PushToTalk } from '../voice/ptt';

afterEach(() => vi.useRealTimers());

function setup(mode: 'annotate' | 'control' = 'annotate', openPairing = false) {
  const app = Object.create(QuestApp.prototype) as QuestApp;
  const onboarding = new HelperOnboarding();
  onboarding.update({ urls: ['http://localhost:8797/pair'], helpers: [] }, 0);
  onboarding.enter(0);
  if (openPairing) onboarding.show();
  const modes = new ModeState();
  modes.mode = mode;
  const frame = { payload: { frameId: 'helper-qr', purpose: 'pair' } };
  const capture = vi.fn(async () => frame);
  const send = vi.fn(() => 'pair-request');
  const hud = { showApprovals: vi.fn(), showHelperPairing: vi.fn(), setOnboarding: vi.fn(), toast: vi.fn() };
  Object.assign(app, {
    onboarding, modes, capture: { capture }, ws: { send }, hud,
    startCamera: vi.fn(async () => {}), page: { log: vi.fn() },
    loadHelper: vi.fn(async () => {}),
    pairingUntil: 0, pairCapturing: false, lastPairFrame: 0, pairCodeRequest: null,
  });
  const refresh = () => Reflect.get(app, 'refreshHelper').call(app) as void;
  const captureAt = (time: number) => Reflect.get(app, 'capturePairing').call(app, time) as Promise<void>;
  const submit = (value: string) => Reflect.get(app, 'submitPairCode').call(app, '__helper__', value) as void;
  const skip = () => Reflect.get(app, 'skipHelper').call(app) as void;
  refresh();
  return { app, onboarding, modes, frame, capture, send, hud, refresh, captureAt, submit, skip };
}

describe('helper pairing in the Quest app', () => {
  it('explains a missing device connection instead of silently re-pairing an already online Mac', () => {
    const { app, onboarding, modes, hud } = setup('control');
    onboarding.skip();
    onboarding.updateHelpers([{ deviceId: 'mac', name: 'Mac', kind: 'mac', online: true }], 1);
    modes.tags.set('physical-mac', { targetId: 'physical-mac', cardId: 'mac-card', label: 'MacBook', connection: 'offline',
      action: 'open-companion', hint: 'Open the Mac app and enable control of this Mac' });
    Reflect.get(app, 'pairDevice').call(app, 'physical-mac');
    expect(hud.toast).toHaveBeenLastCalledWith('Open the Mac app and enable control of this Mac', 'info');
    expect(onboarding.visible).toBe(false);
    expect(onboarding.scanning).toBe(false);
  });

  it('leaves annotation available on entry without a companion and captures no pairing frames', async () => {
    const { onboarding, capture, captureAt, send, hud } = setup();
    await captureAt(0); await captureAt(30_000);
    expect(onboarding.visible).toBe(false); expect(onboarding.scanning).toBe(false);
    expect(capture).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    expect(hud.showHelperPairing).toHaveBeenLastCalledWith(null);
    expect(hud.setOnboarding).toHaveBeenLastCalledWith(expect.objectContaining({ step: 'tag' }));
  });

  it.each(['thinking', 'proposal'] as const)('explicit helper navigation cancels a %s Muse request and ignores its late setup reply', (state) => {
    vi.useFakeTimers();
    const { app, skip } = setup();
    skip();
    const ptt = Object.assign(new Emitter<PttEvents>(), { cancel: vi.fn() });
    const send = vi.fn((_type: string, _payload: unknown) => true), setupControl = vi.fn(() => true), render = vi.fn();
    const assistant = new VoiceAssistant({ ptt: ptt as unknown as PushToTalk,
      selected: () => ({ targetId: 'target', cardId: 'card' }), identity: () => 'quest',
      microphoneError: () => undefined, send, setup: setupControl, render });
    Object.assign(app, { assistant });
    assistant.sendText('Connect this device and map my hand height.');
    const request = send.mock.calls.findLast(([type]) => type === 'voice.text')![1] as PayloadOf<'voice.text'>;
    const reply = { ...request, recipientId: 'quest', assistant: { state, text: 'Review this request.',
      ...(state === 'proposal' ? { proposalId: 'proposal' } : {}) } };
    assistant.receive(reply);
    expect(assistant.view?.state).toBe(state);

    app.openHelper();
    expect(assistant.view).toBeUndefined();
    expect(send).toHaveBeenLastCalledWith('voice.cancel', expect.objectContaining({ cardId: 'card', utteranceId: request.utteranceId }));
    skip();
    assistant.receive({ ...reply, assistant: { state: 'setup', text: 'Set up this device.' } });
    expect(assistant.view).toBeUndefined();
    expect(setupControl).not.toHaveBeenCalled();
  });

  it('opens helper pairing from the menu without a selected device or Control mode', () => {
    const { app, onboarding, modes, hud, skip } = setup();
    skip();
    expect(hud.setOnboarding).toHaveBeenLastCalledWith(expect.objectContaining({ step: 'tag' }));
    app.openHelper();
    expect(modes.mode).toBe('annotate');
    expect(onboarding.scanning).toBe(true);
    expect(hud.showHelperPairing).toHaveBeenLastCalledWith({ urls: ['http://localhost:8797/pair'], pairedName: undefined });
    expect(hud.showApprovals).toHaveBeenLastCalledWith([]);
    expect(hud.setOnboarding).toHaveBeenLastCalledWith(null);
  });

  it.each(['annotate', 'control'] as const)('captures at most twice a second in %s, including after 30 seconds', async (mode) => {
    const { onboarding, capture, captureAt, send, frame } = setup(mode, true);
    for (const time of [0, 499, 500, 999, 1000, 30_001, 300_000]) {
      onboarding.tick(time);
      await captureAt(time);
    }
    expect(onboarding.scanning).toBe(true);
    expect(capture).toHaveBeenCalledTimes(5);
    expect(capture).toHaveBeenCalledWith('pair');
    expect(send).toHaveBeenCalledTimes(5);
    expect(send).toHaveBeenLastCalledWith('scan.frame', frame.payload, { to: 'server', droppable: true });
  });

  it('keeps a single camera capture in flight', async () => {
    const { capture, captureAt, frame, send } = setup('annotate', true);
    let finish!: (value: typeof frame) => void;
    capture.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = captureAt(0);
    await captureAt(500);
    await captureAt(1000);
    expect(capture).toHaveBeenCalledOnce();
    finish(frame);
    await pending;
    expect(send).toHaveBeenCalledOnce();
  });

  it.each(['skip', 'leave'] as const)('drops an in-flight frame after %s and stops taking frames', async (stop) => {
    const { onboarding, capture, captureAt, frame, send, skip } = setup('annotate', true);
    let finish!: (value: typeof frame) => void;
    capture.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = captureAt(0);
    if (stop === 'skip') skip();
    else onboarding.leave();
    finish(frame);
    await pending;
    await captureAt(60_000);
    expect(send).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledOnce();
    expect(onboarding.scanning).toBe(false);
  });

  it.each(['skip', 'leave'] as const)('does not send a stale frame when pairing restarts after %s', async (stop) => {
    const { onboarding, capture, captureAt, frame, send, skip, refresh } = setup('annotate', true);
    let finish!: (value: typeof frame) => void;
    capture.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = captureAt(0);
    if (stop === 'skip') { skip(); onboarding.show(); }
    else { onboarding.leave(); onboarding.enter(500); onboarding.show(); }
    refresh();
    expect(onboarding.scanning).toBe(true);
    finish(frame);
    await pending;
    expect(send).not.toHaveBeenCalled();
    await captureAt(1000);
    expect(send).toHaveBeenCalledOnce();
  });

  it('allows a typed helper code in Annotate only while the onboarding loop is open', () => {
    const { app, onboarding, submit, send, hud, skip } = setup('annotate', true);
    submit(' k7q-4m2 ');
    expect(send).toHaveBeenCalledExactlyOnceWith('pair.approve', { code: 'K7Q4M2' }, { to: 'server' });
    expect(Reflect.get(app, 'pairCodeRequest')).toBe('pair-request');
    expect(hud.toast).toHaveBeenCalledWith('Checking the code…', 'info');
    skip();
    expect(onboarding.scanning).toBe(false);
    expect(Reflect.get(app, 'pairCodeRequest')).toBeNull();
    submit('K7Q4M2');
    expect(send).toHaveBeenCalledOnce();
  });

  it('does not approve malformed codes or accept a code after leaving AR', () => {
    const { onboarding, submit, send } = setup('annotate', true);
    submit('K7Q');
    submit('https://example.test/K7Q4M2');
    onboarding.leave();
    submit('K7Q4M2');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('headset identity repair completion', () => {
  it.each(['pairing superseded', 'server unavailable'])('handles a rejected %s repair without changing identity or restarting', async (message) => {
    const app = Object.create(QuestApp.prototype) as QuestApp;
    const identity = { deviceId: 'current' }, log = vi.fn(), restart = vi.fn();
    Object.assign(app, { identity, pairing: { repair: vi.fn().mockRejectedValue(new Error(message)) }, ws: { restart }, page: { log } });
    await expect(Reflect.get(app, 'repairPairing').call(app)).resolves.toBeUndefined();
    expect(Reflect.get(app, 'identity')).toBe(identity); expect(restart).not.toHaveBeenCalled();
    if (message === 'pairing superseded') expect(log).not.toHaveBeenCalled();
    else expect(log).toHaveBeenCalledWith('pairing failed: server unavailable', 'warn');
  });
});
