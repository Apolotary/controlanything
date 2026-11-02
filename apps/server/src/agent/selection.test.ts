import { type DeviceCardPayload, type DeviceInfo, type Driver, makeMessage, type MessageType, type PayloadOf } from '@ce/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config';
import { createContext } from '../context';
import type { HubMessageEvent } from '../hub';
import { ARM_TIMEOUT_MS } from './arm';
import { createAgent } from './index';
import { tryLink, type LinkOutcome } from './link';

vi.mock('./link', async (original) => ({ ...await original<typeof import('./link')>(), tryLink: vi.fn() }));

const owner = { deviceId: 'quest', name: 'Quest' };
const card: DeviceCardPayload = {
  cardId: 'light', name: 'Ceiling light', maker: 'Example', model: 'Lamp',
  category: 'lighting', confidence: 0.9, protocols: ['ir'], requires: ['ir'], evidence: ['A visible label'],
};
const driver: Driver = {
  driverId: 'driver-light', cardId: card.cardId, transport: 'ir', executor: { deviceId: 'remo' }, provenance: [],
  actions: [{ actionId: 'off', label: 'Off', kind: 'trigger', encode: { kind: 'ir', protocol: 'NEC', bytes: [1, 2, 3, 4] }, expect: { sense: 'camera', effect: 'off' } }],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const cleanups: (() => void)[] = [];

function setup() {
  const config = loadConfig({ MODEL_MODE: 'fixture', FIXTURE_DELAY_MS: '0', MUSE_REPLAY: '0', HTTP_PORT: '0', HTTPS_PORT: '0' });
  const ctx = createContext(config, { log: () => {}, registryFile: null });
  const broadcasts = vi.spyOn(ctx.hub, 'broadcast');
  const subscription = vi.spyOn(ctx.hub, 'onMessage');
  const agent = createAgent(ctx, { macLocal: false, forge: () => undefined });
  const dispatch = vi.spyOn(agent.dispatcher, 'exec');
  cleanups.push(() => { agent.close(); ctx.hub.close(); });
  const emit = <T extends MessageType>(type: T, payload: PayloadOf<T>) => {
    const event: HubMessageEvent = {
      message: makeMessage(type, payload, { from: owner.deviceId, to: 'server' }),
      device: { ...owner, canApprove: true, kind: 'quest', capabilities: ['camera'], tokenHash: 'test-token', pairedAt: 1 },
      connection: { local: false } as HubMessageEvent['connection'],
    };
    subscription.mock.calls[0]![0](event);
  };
  const of = <T extends MessageType>(type: T) => broadcasts.mock.calls
    .filter(([sentType]) => sentType === type).map(([, payload]) => payload as PayloadOf<T>);
  const addTarget = (id: string, state: 'failed' | 'forged' = 'failed') => agent.targets.create({
    cardId: id, card: { ...card, cardId: id }, state, selectedBy: owner.deviceId,
    ...(state === 'forged' ? { driver: { ...driver, cardId: id }, specId: `spec-${id}`, verification: { off: 'pass' as const } } : {}),
  });
  return { ctx, agent, dispatch, emit, of, addTarget };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(tryLink).mockReset().mockImplementation(() => new Promise(() => {}));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('target selection and recovery without sockets', () => {
  it('handles cancel/retry messages and ignores actions carrying an old runId', async () => {
    const { agent, emit, of, addTarget, dispatch } = setup();
    const target = addTarget('light');
    emit('target.select', { cardId: target.cardId });
    const firstRunId = target.runId;
    const firstAbort = target.abort!;
    expect(target.state).toBe('linking');

    emit('target.cancel', { cardId: target.cardId, runId: 'old-run' });
    emit('target.retry', { cardId: target.cardId, runId: 'old-run' });
    expect(firstAbort.signal.aborted).toBe(false);
    expect(target.runId).toBe(firstRunId);
    expect(tryLink).toHaveBeenCalledTimes(1);

    emit('target.cancel', { cardId: target.cardId, runId: firstRunId });
    expect(firstAbort.signal.aborted).toBe(true);
    expect(target.state).toBe('failed');
    expect(of('target.status').at(-1)).toMatchObject({ cardId: target.cardId, action: 'retry', sentence: expect.any(String) });
    await vi.advanceTimersByTimeAsync(0);
    expect(target.abort).toBeUndefined();

    emit('target.retry', { cardId: target.cardId, runId: firstRunId });
    expect(target.runId).not.toBe(firstRunId);
    expect(target.abort?.signal.aborted).toBe(false);
    expect(tryLink).toHaveBeenCalledTimes(2);
    emit('target.cancel', { cardId: target.cardId, runId: firstRunId });
    expect(target.abort?.signal.aborted).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(agent.arm.pendingIds()).toEqual([]);
  });

  it('switches paired devices immediately while keeping another client’s run active', () => {
    const { ctx, agent, addTarget } = setup();
    const devices: DeviceInfo[] = ['mac-a', 'mac-b'].map((deviceId) => ({
      deviceId, name: deviceId, kind: 'mac', role: 'companion', capabilities: ['local'],
      canApprove: true, online: true, connections: 1, pairedAt: 1,
    }));
    vi.spyOn(ctx.hub, 'devices').mockReturnValue(devices);
    const other = addTarget('other-light');
    agent.select({ cardId: other.cardId }, { deviceId: 'other-quest' });
    const otherAbort = other.abort!;
    const first = agent.select({ deviceId: 'mac-a' }, owner)!;
    const firstAbort = first.abort!;
    const second = agent.select({ deviceId: 'mac-b' }, owner)!;
    expect(firstAbort.signal.aborted).toBe(true);
    expect(first.state).toBe('failed');
    expect(second.abort?.signal.aborted).toBe(false);
    expect(second.selectedBy).toBe(owner.deviceId);
    expect(otherAbort.signal.aborted).toBe(false);
    expect(agent.targets.list()).toHaveLength(3);
  });

  it('leaves the current run active when a selection does not match a device', () => {
    const { agent, addTarget } = setup();
    const target = addTarget('light');
    agent.select({ cardId: target.cardId }, owner);
    const abort = target.abort!;
    for (const selection of [{ cardId: 'missing' }, { deviceId: 'missing' }, { frameId: 'missing', detId: 'missing' }, {}]) {
      expect(agent.select(selection, owner)).toBeUndefined();
    }
    expect(abort.signal.aborted).toBe(false);
    expect(target.state).toBe('linking');
    expect(tryLink).toHaveBeenCalledTimes(1);
  });

  it('starts retry with a fresh runId and clears old controls, consent and verification', () => {
    const { agent, addTarget } = setup();
    const target = addTarget('light');
    Object.assign(target, { armed: true, driver, specId: 'old-spec', controlCount: 3, verification: { off: 'pass' }, evidence: [], lastError: 'old failure' });
    const runId = target.runId;
    expect(agent.retry({ cardId: target.cardId, runId }, owner)).toBe(target);
    expect(target.runId).not.toBe(runId);
    expect(target.armed).toBe(false);
    expect(target.verification).toEqual({});
    expect(target.driver).toBeUndefined();
    expect(target.specId).toBeUndefined();
    expect(target.controlCount).toBeUndefined();
    expect(target.lastError).toBeUndefined();
    expect(target.abort?.signal.aborted).toBe(false);
  });

  it('ignores a late result from a cancelled attempt after its replacement starts', async () => {
    const { agent, of, addTarget, dispatch } = setup();
    const pending = deferred<LinkOutcome>();
    vi.mocked(tryLink).mockReturnValueOnce(pending.promise);
    const target = addTarget('light');
    agent.select({ cardId: target.cardId }, owner);
    const oldAbort = target.abort!;
    const runId = target.runId;
    agent.cancel({ cardId: target.cardId, runId });
    agent.retry({ cardId: target.cardId, runId }, owner);
    const replacementAbort = target.abort!;
    const replacementRunId = target.runId;
    await vi.advanceTimersByTimeAsync(0);
    const before = agent.targets.summary(target);
    const statuses = of('target.status').length;
    pending.resolve({ result: { linkId: 'late', cardId: target.cardId, verdict: 'confirmed', executorDeviceId: 'remo', channel: 'ir', evidence: [] }, executor: { deviceId: 'remo', name: 'Remo', kind: 'remo' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(oldAbort.signal.aborted).toBe(true);
    expect(target.abort).toBe(replacementAbort);
    expect(target.runId).toBe(replacementRunId);
    expect(agent.targets.summary(target)).toEqual(before);
    expect(of('target.status')).toHaveLength(statuses);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('cancels a pending ARM confirmation on a new selection and rejects a late tap', async () => {
    const { agent, emit, of, addTarget, dispatch } = setup();
    const first = addTarget('light', 'forged');
    const second = addTarget('another-light');
    agent.select({ cardId: first.cardId }, owner);
    const request = of('arm.request').at(-1)!;
    const abort = first.abort!;
    expect(first.armed).toBe(false);
    expect(agent.arm.pendingIds()).toEqual([request.armId]);
    agent.select({ cardId: second.cardId }, owner);
    expect(abort.signal.aborted).toBe(true);
    expect(agent.arm.pendingIds()).toEqual([]);
    expect(first.state).toBe('failed');
    emit('arm.confirm', { armId: request.armId, approve: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(first.armed).toBe(false);
    expect(first.state).toBe('failed');
    expect(second.state).toBe('linking');
    expect(dispatch).not.toHaveBeenCalled();
    expect(of('arm.result').filter((result) => result.armed)).toEqual([]);
  });

  it('retries an expired ARM confirmation without repeating physical discovery', async () => {
    const { agent, emit, of, addTarget, dispatch } = setup();
    const target = addTarget('light', 'forged');
    agent.select({ cardId: target.cardId }, owner);
    const runId = target.runId;
    const firstRequest = of('arm.request').at(-1)!;
    await vi.advanceTimersByTimeAsync(ARM_TIMEOUT_MS);
    expect(target.state).toBe('forged');
    expect(target.armed).toBe(false);
    expect(target.abort).toBeUndefined();
    expect(agent.arm.pendingIds()).toEqual([]);

    emit('target.retry', { cardId: target.cardId, runId });
    const secondRequest = of('arm.request').at(-1)!;
    expect(secondRequest.armId).not.toBe(firstRequest.armId);
    expect(target.runId).not.toBe(runId);
    expect(target.specId).toBe('spec-light');
    expect(target.verification).toEqual({ off: 'pass' });
    expect(tryLink).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    emit('arm.confirm', { armId: secondRequest.armId, approve: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(target.armed).toBe(true);
    expect(target.abort).toBeUndefined();
    expect(agent.arm.pendingIds()).toEqual([]);
  });
});
