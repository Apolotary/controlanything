import { getEventListeners } from 'node:events';
import type { DeviceCardPayload, Driver, PayloadOf, TargetStatusPayload } from '@ce/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Forge, ForgeResult } from '../gen3d/forge';
import type { MuseChat } from '../muse/adapter';
import type { Sam } from '../scan/sam';
import type { WebSearcher } from '../research/websearch';
import { ArmService } from './arm';
import { Dispatcher } from './dispatch';
import { drive, type DriveResult } from './drive';
import { learnGuidance } from './guidance';
import { identify, type IdentifyResult } from './identify';
import { learnCodes } from './learn';
import { tryLink, type LinkOutcome } from './link';
import { runLoop, type LoopDeps } from './loop';
import { research } from './research';
import { StepLog } from './steps';
import { TargetStore } from './targets';
import type { LearnedCode, Research } from './types';
import { verifyDriver, type VerifySummary } from './verify';

vi.mock('./identify', async (original) => ({
  ...await original<typeof import('./identify')>(),
  identify: vi.fn(),
  cropJpeg: vi.fn(() => 'crop'),
  cropForSkin: vi.fn(() => ({ jpegBase64: 'crop', width: 1, height: 1 })),
}));
vi.mock('../oracle/image', async (original) => ({
  ...await original<typeof import('../oracle/image')>(),
  decodeJpeg: vi.fn(() => ({ width: 1, height: 1, data: new Uint8Array(4) })),
}));
vi.mock('./link', async (original) => ({ ...await original<typeof import('./link')>(), tryLink: vi.fn() }));
vi.mock('./research', () => ({ research: vi.fn() }));
vi.mock('./learn', () => ({ learnCodes: vi.fn() }));
vi.mock('./drive', async (original) => ({ ...await original<typeof import('./drive')>(), drive: vi.fn() }));
vi.mock('./verify', () => ({ verifyDriver: vi.fn() }));

class TestHub {
  readonly sent: { type: string; payload: unknown }[] = [];
  broadcast(type: string, payload: unknown): number {
    this.sent.push({ type, payload });
    return 1;
  }
  sendToDevice = vi.fn(() => 0);
  of<T extends 'target.status' | 'agent.step' | 'arm.request'>(type: T): PayloadOf<T>[] {
    return this.sent.filter((event) => event.type === type).map((event) => event.payload as PayloadOf<T>);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const card: DeviceCardPayload = {
  cardId: 'light', name: 'Ceiling light', maker: 'Example', model: 'Lamp',
  category: 'lighting', confidence: 0.9, protocols: ['ir'], requires: ['ir'], evidence: ['A visible label'],
};
const driver: Driver = {
  driverId: 'driver', cardId: card.cardId, transport: 'ir', executor: { deviceId: 'remo' }, provenance: [],
  actions: [{ actionId: 'off', label: 'Off', kind: 'trigger', encode: { kind: 'ir', protocol: 'NEC', bytes: [1, 2, 3, 4] }, expect: { sense: 'camera', effect: 'off' } }],
};
const identified: IdentifyResult = { card, model: 'muse-spark', effort: 'low', latencyMs: 1, source: 'fixture' };
const linked: LinkOutcome = {
  result: { linkId: 'link', cardId: card.cardId, executorDeviceId: 'remo', channel: 'ir', verdict: 'consistent', evidence: [] },
  executor: { deviceId: 'remo', name: 'Remo', kind: 'remo' },
};
const researched: Research = { brief: 'An approved light command.', provenance: [] };
const driven: DriveResult = {
  draft: driver, validation: { ok: true, driver, issues: [] }, model: 'muse-spark', effort: 'low', latencyMs: 1, attempts: 1, source: 'fixture',
};
const verified: VerifySummary = { driver, verification: { off: 'pass' }, evidence: [], passed: 1, failed: 0 };
// The loop consumes only these spec fields; the forge's schema tests cover the generated geometry.
const forged = {
  ok: true, model: 'muse-spark', effort: 'low', latencyMs: 1, source: 'fixture',
  uiSpec: { specId: 'spec-light', rev: 1, hackset: { hacks: [] }, gen3d: { controls: [{ id: 'off' }] } },
} as unknown as ForgeResult;

function setup() {
  const hub = new TestHub();
  const targets = new TargetStore(hub);
  const steps = new StepLog(hub);
  const arm = new ArmService({ hub, targets, steps });
  const dispatcher = new Dispatcher({ hub });
  const exec = vi.spyOn(dispatcher, 'exec');
  const generate = vi.fn<Forge['generate']>().mockResolvedValue(forged);
  const target = targets.create({
    cardId: card.cardId,
    detection: { frameId: 'frame', detId: 'det', sensorDeviceId: 'quest', label: 'light', prompt: 'light', score: 0.9, box: [0, 0, 1, 1], width: 1, height: 1, jpeg: 'frame', capturedAt: Date.now() },
  });
  const deps: LoopDeps = {
    hub, targets, steps, arm, dispatcher,
    roster: {
      macLocal: false,
      devices: () => [
        { deviceId: 'remo', name: 'Remo', kind: 'remo', role: 'device', capabilities: ['ir'], canApprove: false, online: true, connections: 1, pairedAt: 1 },
        { deviceId: 'quest', name: 'Quest', kind: 'quest', role: 'hmd', capabilities: ['camera'], canApprove: true, online: true, connections: 1, pairedAt: 1 },
      ],
    },
    profiles: { midi: new Map(), ir: undefined, koizumi: undefined, files: [] },
    spark: { model: 'muse-spark' } as MuseChat,
    sam: {} as Sam,
    web: {} as WebSearcher,
    forge: () => ({ generate } as unknown as Forge),
  };
  return { hub, targets, steps, arm, dispatcher, exec, generate, target, deps };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(identify).mockReset().mockResolvedValue(structuredClone(identified));
  vi.mocked(tryLink).mockReset().mockResolvedValue(structuredClone(linked));
  vi.mocked(research).mockReset().mockResolvedValue(structuredClone(researched));
  vi.mocked(drive).mockReset().mockResolvedValue(structuredClone(driven));
  vi.mocked(verifyDriver).mockReset().mockResolvedValue(structuredClone(verified));
  vi.mocked(learnCodes).mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

function expectRecovery(status: TargetStatusPayload | undefined) {
  expect(status).toMatchObject({ state: 'failed', action: 'retry' });
  expect(status?.sentence?.trim().length).toBeGreaterThan(0);
  expect(status?.hint?.trim().length).toBeGreaterThan(0);
}

describe('bounded discovery phases', () => {
  it.each([
    ['identify', 20_000], ['link', 45_000], ['learn', 60_000], ['research', 20_000],
    ['drive', 45_000], ['verify', 40_000], ['forge', 45_000],
  ] as const)('%s stops at %i ms and ignores a late result', async (phase, timeoutMs) => {
    const { hub, target, deps, generate, arm, exec } = setup();
    let release!: () => void;
    switch (phase) {
      case 'identify': {
        const pending = deferred<IdentifyResult>();
        vi.mocked(identify).mockReturnValue(pending.promise);
        release = () => pending.resolve(identified);
        break;
      }
      case 'link': {
        const pending = deferred<LinkOutcome>();
        vi.mocked(tryLink).mockReturnValue(pending.promise);
        release = () => pending.resolve(linked);
        break;
      }
      case 'learn': {
        vi.mocked(identify).mockResolvedValue({ ...identified, card: { ...card, maker: 'unknown' } });
        const pending = deferred<LearnedCode[]>();
        vi.mocked(learnCodes).mockReturnValue(pending.promise);
        release = () => pending.resolve([]);
        break;
      }
      case 'research': {
        const pending = deferred<Research>();
        vi.mocked(research).mockReturnValue(pending.promise);
        release = () => pending.resolve(researched);
        break;
      }
      case 'drive': {
        const pending = deferred<DriveResult>();
        vi.mocked(drive).mockReturnValue(pending.promise);
        release = () => pending.resolve(driven);
        break;
      }
      case 'verify': {
        const pending = deferred<VerifySummary>();
        vi.mocked(verifyDriver).mockReturnValue(pending.promise);
        release = () => pending.resolve(verified);
        break;
      }
      case 'forge': {
        const pending = deferred<ForgeResult>();
        generate.mockReturnValue(pending.promise);
        release = () => pending.resolve(forged);
        break;
      }
    }
    const running = runLoop(deps, target);
    const signal = target.abort!.signal;
    await vi.advanceTimersByTimeAsync(timeoutMs - 1);
    expect(target.state).not.toBe('failed');
    await vi.advanceTimersByTimeAsync(1);
    await running;
    expectRecovery(hub.of('target.status').at(-1));
    expect(target.abort).toBeUndefined();
    expect(target.armed).toBe(false);
    expect(arm.pendingIds()).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(signal, 'abort')).toEqual([]);
    const count = hub.sent.length;
    const before = deps.targets.summary(target);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(hub.sent).toHaveLength(count);
    expect(deps.targets.summary(target)).toEqual(before);
    expect(arm.pendingIds()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('explains a missing companion, then stops polling after 45 seconds', async () => {
    const { hub, target, deps } = setup();
    vi.mocked(tryLink).mockResolvedValue({ result: { linkId: 'link', cardId: card.cardId, verdict: 'none', evidence: [] } });
    const running = runLoop(deps, target);
    await vi.advanceTimersByTimeAsync(0);
    const waiting = hub.of('target.status').find((status) => status.state === 'needs-companion');
    expect(waiting?.sentence?.length).toBeGreaterThan(0);
    expect(waiting?.hint?.length).toBeGreaterThan(0);
    expect(waiting?.action).toMatch(/open-companion|pair-device/);
    await vi.advanceTimersByTimeAsync(45_000);
    await running;
    expectRecovery(hub.of('target.status').at(-1));
    const calls = vi.mocked(tryLink).mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tryLink).toHaveBeenCalledTimes(calls);
    expect(target.abort).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows a phase budget to be shortened without changing other phases', async () => {
    const { hub, target, deps } = setup();
    vi.mocked(identify).mockReturnValue(new Promise(() => {}));
    const running = runLoop({ ...deps, phaseTimeoutMs: { identify: 35 } }, target);
    await vi.advanceTimersByTimeAsync(34);
    expect(target.state).toBe('identifying');
    await vi.advanceTimersByTimeAsync(1);
    await running;
    expectRecovery(hub.of('target.status').at(-1));
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('discovery retries and consent', () => {
  it.each([false, true])('never sends a MIDI identity probe during link (output present: %s)', async (hasPort) => {
    const { hub, target, deps, exec } = setup();
    const actualLink = await vi.importActual<typeof import('./link')>('./link');
    vi.mocked(tryLink).mockImplementation(actualLink.tryLink);
    vi.mocked(identify).mockResolvedValue({ ...identified, card: { ...card, category: 'synthesizer', protocols: ['midi'], requires: ['midi'] } });
    vi.mocked(drive).mockReturnValue(new Promise(() => {}));
    deps.roster = {
      macLocal: false,
      devices: () => [{
        deviceId: 'mac', name: 'Mac', kind: 'mac', role: 'companion', capabilities: ['midi'],
        canApprove: true, online: true, connections: 1, pairedAt: 1,
        ports: hasPort ? [{ id: 'midi-out', name: 'Synth', kind: 'midi-out' }] : [],
      }],
    };
    const running = runLoop(deps, target);
    await vi.advanceTimersByTimeAsync(0);
    expect(target.state).toBe(hasPort ? 'driving' : 'needs-companion');
    expect(exec).not.toHaveBeenCalled();
    if (!hasPort) {
      expect(hub.of('target.status').at(-1)).toMatchObject({
        sentence: 'Plug the synth into your Mac',
      });
      expect(hub.of('target.status').at(-1)?.action).toBeUndefined();
    }
    target.abort!.abort();
    await running;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries a failed identification once, then explains how to recover', async () => {
    const { hub, target, deps } = setup();
    vi.mocked(identify).mockRejectedValue(new Error('model unavailable'));
    const running = runLoop(deps, target);
    await vi.advanceTimersByTimeAsync(1000);
    await running;
    expect(identify).toHaveBeenCalledTimes(2);
    expect(tryLink).not.toHaveBeenCalled();
    expectRecovery(hub.of('target.status').at(-1));
    expect(target.abort).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('continues after the identification retry succeeds', async () => {
    const { hub, target, deps, arm } = setup();
    vi.mocked(identify).mockRejectedValueOnce(new Error('temporary failure'));
    const running = runLoop(deps, target);
    await vi.advanceTimersByTimeAsync(1000);
    expect(identify).toHaveBeenCalledTimes(2);
    expect(target.state).toBe('arming');
    const request = hub.of('arm.request').at(-1)!;
    arm.onConfirm({ armId: request.armId, approve: false }, { canApprove: true });
    await running;
    expect(target.armed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the original deadline when a model call is retried', async () => {
    const { hub, target, deps } = setup();
    vi.mocked(identify)
      .mockImplementationOnce(() => new Promise((_, reject) => setTimeout(() => reject(new Error('temporary failure')), 19_000)))
      .mockReturnValueOnce(new Promise(() => {}));
    const running = runLoop(deps, target);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(identify).toHaveBeenCalledTimes(2);
    expect(target.state).toBe('identifying');
    await vi.advanceTimersByTimeAsync(1);
    await running;
    expectRecovery(hub.of('target.status').at(-1));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries a failed forge result once, then leaves controls disarmed with recovery guidance', async () => {
    const { hub, target, deps, generate, arm } = setup();
    generate.mockResolvedValue({ ...forged, ok: false, uiSpec: undefined, error: 'model unavailable' });
    const running = runLoop(deps, target);
    await vi.advanceTimersByTimeAsync(1000);
    await running;
    expect(generate).toHaveBeenCalledTimes(2);
    expectRecovery(hub.of('target.status').at(-1));
    expect(target.armed).toBe(false);
    expect(arm.pendingIds()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels immediately even when the model ignores its abort signal', async () => {
    const { hub, target, deps } = setup();
    const pending = deferred<IdentifyResult>();
    vi.mocked(identify).mockReturnValue(pending.promise);
    const running = runLoop(deps, target);
    await vi.advanceTimersByTimeAsync(0);
    target.abort!.abort();
    await vi.advanceTimersByTimeAsync(0);
    await running;
    expect(target.state).toBe('failed');
    expect(target.abort).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    const count = hub.sent.length;
    pending.resolve(identified);
    await vi.advanceTimersByTimeAsync(0);
    expect(hub.sent).toHaveLength(count);
    expect(target.card).toBeUndefined();
    expect(tryLink).not.toHaveBeenCalled();
  });

  it('keeps verification and the one-tap ARM confirmation before user control', async () => {
    const { hub, target, deps, arm, exec } = setup();
    const pending = deferred<VerifySummary>();
    vi.mocked(verifyDriver).mockReturnValue(pending.promise);
    const running = runLoop(deps, target);
    await vi.advanceTimersByTimeAsync(0);
    expect(target.state).toBe('verifying');
    expect(exec).not.toHaveBeenCalled();
    expect(target.armed).toBe(false);
    expect(hub.of('arm.request')).toEqual([]);
    pending.resolve(verified);
    await vi.advanceTimersByTimeAsync(0);
    expect(target.state).toBe('arming');
    expect(target.armed).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    const request = hub.of('arm.request').at(-1)!;
    expect(arm.onConfirm({ armId: request.armId, approve: true }, { canApprove: false })).toBe(false);
    expect(target.armed).toBe(false);
    expect(arm.onConfirm({ armId: request.armId, approve: true }, { canApprove: true, name: 'Owner' })).toBe(true);
    await running;
    expect(target.state).toBe('armed');
    expect(target.armed).toBe(true);
    expect(target.abort).toBeUndefined();
    expect(arm.pendingIds()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    for (const status of hub.of('target.status')) expect(status.sentence?.trim().length).toBeGreaterThan(0);
    for (const step of hub.of('agent.step')) expect(step.sentence?.trim().length).toBeGreaterThan(0);
  });
});

describe('plain-language guidance', () => {
  it.each([
    ['scan', 'Look at a device and pinch to choose it'],
    ['identify', 'Working out what this is…'],
    ['link', 'Finding a connection to your device…'],
    ['research', 'Looking up how to control it…'],
    ['drive', 'Preparing commands for your device…'],
    ['verify', 'Testing the device now…'],
    ['forge', 'Making your controls…'],
    ['arm', 'Tap once to enable the controls'],
    ['control', 'Your controls are ready'],
  ] as const)('supplies the %s sentence on agent.step', (phase, sentence) => {
    const { hub, steps } = setup();
    steps.begin(phase, 'internal detail', { cardId: card.cardId });
    expect(hub.of('agent.step').at(-1)).toMatchObject({ phase, sentence, hint: expect.any(String), action: 'cancel' });
  });

  it.each([
    ['scanned', 'Look at a device and pinch to choose it'],
    ['identifying', 'Working out what this is…'],
    ['linking', 'Finding a connection to your device…'],
    ['researching', 'Looking up how to control it…'],
    ['driving', 'Preparing commands for your device…'],
    ['verifying', 'Testing the light: keep it in view'],
    ['forging', 'Making your controls…'],
    ['arming', 'Tap once to enable the controls'],
    ['controlling', 'Ready: 3 controls'],
  ] as const)('supplies the %s sentence on target.status', (state, sentence) => {
    const { hub, target, targets } = setup();
    target.card = card;
    target.driver = driver;
    target.controlCount = 3;
    targets.setState(target, state);
    expect(hub.of('target.status').at(-1)).toMatchObject({ state, sentence });
  });

  it('tells the owner where to point the remote and stops when no button was captured', async () => {
    const { hub, target, deps } = setup();
    vi.mocked(identify).mockResolvedValue({ ...identified, card: { ...card, maker: 'unknown' } });
    await runLoop(deps, target);
    const sentence = 'Point your remote at the Remo and press each button once';
    expect(hub.of('target.status')).toContainEqual(expect.objectContaining({ sentence, hint: expect.any(String), action: 'cancel' }));
    expect(hub.of('agent.step')).toContainEqual(expect.objectContaining({ sentence, hint: expect.any(String), action: 'cancel' }));
    expect(learnGuidance('Remo').sentence).toBe(sentence);
    expectRecovery(hub.of('target.status').at(-1));
    expect(hub.of('target.status').at(-1)?.sentence).toMatch(/remote codes/);
    expect(drive).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, false])('keeps the testing instruction visible after a command result (pass: %s)', async (pass) => {
    const { hub, target, deps } = setup();
    vi.mocked(verifyDriver).mockImplementation(async (_deps, _target, _driver, options) => {
      options?.onStep?.('off', 'internal command detail');
      options?.onEvidence?.({
        evidenceId: 'evidence', execId: 'command', actionId: 'off', attempt: 1,
        sent: { op: { kind: 'ir', protocol: 'NEC', bytes: [1, 2, 3, 4] }, at: 1 },
        expected: { sense: 'camera', effect: 'off' },
        observed: { sense: 'camera', metric: 'luma-abs', before: 1, after: 0, delta: -1, threshold: 0.1 }, pass,
      });
      return structuredClone(verified);
    });
    await runLoop({ ...deps, forge: () => undefined }, target);

    const progress = hub.of('agent.step').filter((step) => step.phase === 'verify' && (step.title === 'off' || step.title.startsWith('off:')));
    expect(progress).toHaveLength(2);
    expect(progress.every((step) => step.sentence === 'Testing the light: keep it in view')).toBe(true);
  });

  it('explains a device the camera could not verify and keeps controls disarmed', async () => {
    const { hub, target, deps, generate } = setup();
    vi.mocked(verifyDriver).mockResolvedValue({ ...verified, verification: { off: 'fail' }, passed: 0, failed: 1 });
    await runLoop({ ...deps, learnIr: false }, target);
    expectRecovery(hub.of('target.status').at(-1));
    expect(hub.of('target.status').at(-1)?.hint).toMatch(/view.*camera/);
    expect(target.armed).toBe(false);
    expect(generate).not.toHaveBeenCalled();
    expect(hub.of('arm.request')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('explains when the controls generator is unavailable', async () => {
    const { hub, target, deps } = setup();
    await runLoop({ ...deps, forge: () => undefined }, target);
    expectRecovery(hub.of('target.status').at(-1));
    expect(hub.of('target.status').at(-1)?.sentence).toMatch(/controls/);
    expect(target.armed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
