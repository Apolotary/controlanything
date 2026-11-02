import { describe, expect, it, vi } from 'vitest';
import { QuestApp } from './app';
import { ModeState } from './modes';
import { HelperOnboarding } from './onboarding';

function setup(mode: 'annotate' | 'control' = 'annotate') {
  const app = Object.create(QuestApp.prototype) as QuestApp;
  const onboarding = new HelperOnboarding();
  onboarding.update({ urls: ['http://localhost:8797/pair'], helpers: [] }, 0);
  onboarding.enter(0);
  const modes = new ModeState();
  modes.mode = mode;
  const frame = { payload: { frameId: 'helper-qr', purpose: 'pair' } };
  const capture = vi.fn(async () => frame);
  const send = vi.fn(() => 'pair-request');
  const hud = { showApprovals: vi.fn(), showHelperPairing: vi.fn(), toast: vi.fn() };
  Object.assign(app, {
    onboarding, modes, capture: { capture }, ws: { send }, hud,
    startCamera: vi.fn(async () => {}), page: { log: vi.fn() },
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
  it.each(['annotate', 'control'] as const)('captures at most twice a second in %s, including after 30 seconds', async (mode) => {
    const { onboarding, capture, captureAt, send, frame } = setup(mode);
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
    const { capture, captureAt, frame, send } = setup();
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
    const { onboarding, capture, captureAt, frame, send, skip } = setup();
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
    const { onboarding, capture, captureAt, frame, send, skip, refresh } = setup();
    let finish!: (value: typeof frame) => void;
    capture.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = captureAt(0);
    if (stop === 'skip') { skip(); onboarding.show(); }
    else { onboarding.leave(); onboarding.enter(500); }
    refresh();
    expect(onboarding.scanning).toBe(true);
    finish(frame);
    await pending;
    expect(send).not.toHaveBeenCalled();
    await captureAt(1000);
    expect(send).toHaveBeenCalledOnce();
  });

  it('allows a typed helper code in Annotate only while the onboarding loop is open', () => {
    const { app, onboarding, submit, send, hud, skip } = setup();
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
    const { onboarding, submit, send } = setup();
    submit('K7Q');
    submit('https://example.test/K7Q4M2');
    onboarding.leave();
    submit('K7Q4M2');
    expect(send).not.toHaveBeenCalled();
  });
});
