import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GestureMap } from '@ce/protocol';
import { QuestApp } from './app';
import { ControlSender, type ControlEventPayload } from './controls';
import { startXr } from './xr';
import { makeGestureFrame, moveHand } from '../gestures/fixtures.test-support';

vi.mock('./xr', async (importOriginal) => ({
  ...await importOriginal<typeof import('./xr')>(), startXr: vi.fn(),
}));

const map: GestureMap = {
  version: 1, clutchPosture: 'L_FIST', panicPosture: 'BOTH_PALMS_OUT', postures: [],
  axes: [{ axis: 'right_height', actionId: 'warp', label: 'Warp', outMin: 0, outMax: 100,
    curve: 'linear', deadzone: 0, smoothingMinCutoff: 20, smoothingBeta: 10, quantizeStep: 1, maxRateHz: 30 }],
};

async function setup() {
  // Run the real lifecycle listener without initializing media, a renderer, or a device connection.
  vi.stubGlobal('location', { origin: 'https://fixture.invalid' });
  const session = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  vi.mocked(startXr).mockResolvedValue({ session: session as unknown as XRSession,
    refSpace: {} as XRReferenceSpace, mode: 'immersive-ar', attempt: 'test', features: [] });
  const app = Object.create(QuestApp.prototype) as any;
  const sent: ControlEventPayload[] = [];
  const tag = { targetId: 'target', cardId: 'card', connection: 'ready' };
  const controls = new ControlSender(event => { if (app.canControl('card')) sent.push(event); }, 30, () => 0);
  Object.assign(app, {
    prepareMedia: vi.fn(), renderer: {}, scanner: { stop: vi.fn() }, hud: { setDeck: vi.fn(), cancelInteractions: vi.fn() },
    release: vi.fn(), clearAnnotations: vi.fn(), setMode: vi.fn(), refreshHome: vi.fn(), refreshHelper: vi.fn(), loadHelper: vi.fn(),
    roomAnchors: { begin: vi.fn() }, identity: { deviceId: 'headset' }, params: new URLSearchParams(),
    targets: { targets: new Map(), get: () => ({ locating: false }) }, poses: { clear: vi.fn() },
    modes: { mode: 'control', tags: new Map([['target', tag]]), byCard: () => tag },
    onboarding: { enter: vi.fn() }, xrHit: { attach: vi.fn() }, input: { attach: vi.fn() },
    page: { log: vi.fn(), setButton: vi.fn() }, recorder: { input: vi.fn(), spaceBoundary: vi.fn(), pose: vi.fn() },
    projects: { pauseForNavigation: vi.fn() }, assistant: { cancel: vi.fn() },
    controls, visibleTargets: new Set(['target']), armedCards: new Set(['card']), cancelledCards: new Set(), lockedId: 'target',
    handFeedback: { setHover: vi.fn() }, gestureFeedback: { update: vi.fn() },
    gestureSpecs: new Map([['card', { specId: 'ui', gestureMap: map }]]), controlValues: new Map(),
    ws: { send: vi.fn((_type: string, event: ControlEventPayload) => { sent.push(event); return true; }) },
  });
  await app.enterXr();
  expect(app.session).toBe(session);
  const frame = makeGestureFrame();
  const step = (time: number) => { frame.time = time; app.lastFrame = frame; app.updateHandControl(frame, time); };
  const visibility = (value: string) => { session.visibilityState = value; session.dispatchEvent(new Event('visibilitychange')); };
  return { app, frame, step, visibility, sent, controls };
}

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('device controls across XR visibility changes', () => {
  it('cancels hands without needing another frame and needs a fresh, still pickup after resume', async () => {
    const f = await setup();
    // Hands start by themselves for the armed selection; the raised hand settles, then plays.
    f.step(0); f.step(50); f.step(120);
    moveHand(f.frame.hands.right!, 0.2, 1.4, -0.4); f.step(150);
    expect(f.sent.length).toBeGreaterThan(0);
    const before = f.sent.length;

    f.visibility('hidden');
    expect(f.app.handMapping).toBeUndefined();
    expect(f.app.hud.cancelInteractions).toHaveBeenCalledOnce();
    expect(f.app.projects.pauseForNavigation).toHaveBeenCalledOnce();
    f.visibility('visible');
    // Hands come back on their own, but a moving hand never continues the old take: it must settle first.
    f.step(5000); moveHand(f.frame.hands.right!, 0.2, 1.5, -0.4); f.step(5050);
    moveHand(f.frame.hands.right!, 0.2, 1.6, -0.4); f.step(5100);
    expect(f.sent).toHaveLength(before);
    expect(f.app.handMapping).toBeDefined();
    f.step(5150); f.step(5250); f.step(5300); f.step(5400);
    expect(f.sent).toHaveLength(before);
    moveHand(f.frame.hands.right!, 0.2, 1.45, -0.4); f.step(5450);
    expect(f.sent.length).toBeGreaterThan(before);
  });

  it('discards a queued widget move even if the session resumes before its timer fires', async () => {
    vi.useFakeTimers();
    const f = await setup();
    f.controls.push({ specId: 'ui', controlId: 'level', value: 10, phase: 'start', ts: 0 });
    f.controls.push({ specId: 'ui', controlId: 'level', value: 80, phase: 'move', ts: 1 });
    f.visibility('hidden'); f.visibility('visible');
    vi.runAllTimers();
    expect(f.sent.map(event => event.value)).toEqual([10]);
  });

  it('rejects control dispatch while hidden without disarming the selected setup', async () => {
    const f = await setup();
    expect(f.app.canControl('card')).toBe(true);
    f.visibility('hidden');
    expect(f.app.canControl('card')).toBe(false);
    f.app.setHandControl('target', true);
    expect(f.app.handMapping).toBeUndefined();
    expect(f.app.armedCards.has('card')).toBe(true);
    expect(f.app.lockedId).toBe('target');
    f.visibility('visible');
    expect(f.app.canControl('card')).toBe(true);
  });
});
