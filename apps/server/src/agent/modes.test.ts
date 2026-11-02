import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DeviceCardPayload, type DeviceInfo, type Driver, makeMessage, type MessageType, type PayloadOf } from '@ce/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config';
import { createContext } from '../context';
import type { HubMessageEvent } from '../hub';
import { encodeJpeg } from '../oracle/image';
import { createAgent } from './index';
import { tryLink } from './link';
import type { TargetDetection } from './types';

vi.mock('./link', async (original) => ({ ...await original<typeof import('./link')>(), tryLink: vi.fn() }));

const owner = { deviceId: 'quest', name: 'Quest' };
const lightCard: DeviceCardPayload = {
  cardId: 'light', name: 'Ceiling light', maker: 'Example', model: 'Lamp', category: 'lighting',
  confidence: 0.9, protocols: ['ir'], requires: ['ir'], evidence: ['A visible label'],
};
const lightDriver: Driver = {
  driverId: 'driver-light', cardId: 'light', transport: 'ir', executor: { deviceId: 'remo' }, provenance: [],
  actions: [{ actionId: 'off', label: 'Off', kind: 'trigger', encode: { kind: 'ir', protocol: 'NEC', bytes: [1, 2, 3, 4] }, expect: { sense: 'camera', effect: 'off' } }],
};
const remo: DeviceInfo = {
  deviceId: 'remo', name: 'Remo', kind: 'remo', role: 'device', capabilities: ['ir'], canApprove: false,
  online: true, connections: 1, pairedAt: 1,
};
const cleanups: (() => void)[] = [];

function setup(options: { dataDir?: string; devices?: DeviceInfo[] } = {}) {
  const config = loadConfig({
    CE_DATA_DIR: options.dataDir, MODEL_MODE: 'fixture', FIXTURE_DELAY_MS: '0', MUSE_REPLAY: '0', HTTP_PORT: '0', HTTPS_PORT: '0',
  });
  const ctx = createContext(config, { log: () => {}, registryFile: null });
  let devices = options.devices ?? [];
  vi.spyOn(ctx.hub, 'devices').mockImplementation(() => devices);
  const broadcasts = vi.spyOn(ctx.hub, 'broadcast');
  const sent = vi.spyOn(ctx.hub, 'sendToDevice');
  const messages = vi.spyOn(ctx.hub, 'onMessage');
  const presence = vi.spyOn(ctx.hub, 'onPresence');
  const agent = createAgent(ctx, { macLocal: false, forge: () => undefined, ...(options.dataDir ? {} : { tagsFile: null }) });
  const dispatch = vi.spyOn(agent.dispatcher, 'exec');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    agent.close();
    ctx.hub.close();
  };
  cleanups.push(close);
  const emit = <T extends MessageType>(type: T, payload: PayloadOf<T>) => {
    const event: HubMessageEvent = {
      message: makeMessage(type, payload, { from: owner.deviceId, to: 'server' }),
      device: { ...owner, canApprove: true, kind: 'quest', capabilities: ['camera'], tokenHash: 'test-token', pairedAt: 1 },
      connection: { local: false } as HubMessageEvent['connection'],
    };
    for (const [listener] of messages.mock.calls) listener(event);
  };
  const changePresence = (next: DeviceInfo[], reason: NonNullable<PayloadOf<'presence'>['reason']> = 'update', deviceId = 'quest') => {
    devices = next;
    for (const [listener] of presence.mock.calls) listener({ spaceId: ctx.registry.spaceId, devices, reason, deviceId });
  };
  const of = <T extends MessageType>(type: T) => broadcasts.mock.calls
    .filter(([sentType]) => sentType === type).map(([, payload]) => payload as PayloadOf<T>);
  const addKnown = (card: DeviceCardPayload = lightCard) => {
    const target = agent.targets.create({ cardId: card.cardId, card, state: 'identified' });
    expect(agent.addTag({ targetId: target.cardId, label: card.name, position: { x: 1, y: 0.5, z: -2 } }, owner)).toBe(target);
    return target;
  };
  return { ctx, agent, dispatch, sent, emit, changePresence, of, addKnown, close };
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

describe('annotation and control mode boundary', () => {
  it('defaults each space to annotation and sends the current mode and full tags on connection', () => {
    const s = setup();
    const another = setup();
    expect(s.agent.mode()).toBe('annotate');
    s.changePresence([], 'join');
    expect(s.sent).toHaveBeenCalledWith(owner.deviceId, 'mode.state', { mode: 'annotate' });
    expect(s.of('tags.state').at(-1)).toEqual({ tags: [] });
    s.emit('mode.set', { mode: 'control' });
    expect(s.agent.mode()).toBe('control');
    expect(s.of('mode.state').at(-1)).toEqual({ mode: 'control' });
    expect(another.agent.mode()).toBe('annotate');
    s.changePresence([], 'join', 'second-quest');
    expect(s.sent).toHaveBeenCalledWith('second-quest', 'mode.state', { mode: 'control' });
    s.emit('mode.set', { mode: 'annotate' });
    expect(s.agent.mode()).toBe('annotate');
    expect(tryLink).not.toHaveBeenCalled();
    expect(s.dispatch).not.toHaveBeenCalled();
  });

  it.each(['tag.add', 'target.select'] as const)('%s identifies a selected scan crop without starting setup', async (type) => {
    const s = setup({ devices: [remo] });
    const jpeg = Buffer.from(encodeJpeg({ width: 8, height: 8, data: new Uint8Array(8 * 8 * 4).fill(120) }, 85)).toString('base64');
    const detection: TargetDetection = {
      frameId: 'frame', detId: 'det', sensorDeviceId: owner.deviceId, label: 'ceiling light', prompt: 'ceiling light', score: 0.9,
      box: [1, 1, 4, 4], width: 8, height: 8, jpeg, capturedAt: Date.now(),
    };
    vi.spyOn(s.agent.scan, 'detection').mockReturnValue(detection);
    vi.spyOn(s.agent.scan, 'frame').mockReturnValue({
      frame: { frameId: detection.frameId, jpeg, width: 8, height: 8, capturedAt: Date.now(), purpose: 'scan' },
      deviceId: owner.deviceId,
      detections: [{ detId: detection.detId, label: detection.label, prompt: detection.prompt, score: detection.score, box: detection.box }],
      masks: new Map(),
    });
    vi.spyOn(s.agent.scan, 'tagDetection').mockReturnValue(detection);
    if (type === 'tag.add') s.emit(type, { frameId: 'frame', detId: 'det', label: 'Ceiling light' });
    else s.emit(type, { frameId: 'frame', detId: 'det' });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.agent.tagsState().tags).toEqual([expect.objectContaining({ name: 'FIXTURE ceiling light', category: 'lighting', connection: 'setup' })]);
    expect(s.of('device.card')).toEqual([expect.objectContaining({ frameId: 'frame', detId: 'det', source: 'fixture' })]);
    expect(s.of('agent.step').filter((step) => step.phase !== 'identify')).toEqual([]);
    for (const forbidden of ['link.request', 'link.result', 'driver.spec', 'verify.result', 'ui.spec', 'arm.request'] as const) {
      expect(s.of(forbidden)).toEqual([]);
    }
    expect(s.agent.mode()).toBe('annotate');
    expect(tryLink).not.toHaveBeenCalled();
    expect(s.dispatch).not.toHaveBeenCalled();
  });

  it('persists tags and their anchors, and persists removal without changing the mode on restart', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ce-modes-'));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const first = setup({ dataDir });
    const tagged = first.addKnown();
    first.emit('mode.set', { mode: 'control' });
    first.close();
    const restored = setup({ dataDir });
    expect(restored.agent.mode()).toBe('annotate');
    expect(restored.agent.tagsState().tags).toEqual([expect.objectContaining({
      cardId: tagged.cardId, label: 'Ceiling light', name: lightCard.name, position: { x: 1, y: 0.5, z: -2 }, connection: 'offline',
    })]);
    restored.emit('tag.remove', { cardId: tagged.cardId });
    expect(restored.of('tags.state').at(-1)).toEqual({ tags: [] });
    expect(restored.agent.removeTag(tagged.cardId)).toBe(false);
    restored.close();
    expect(setup({ dataDir }).agent.tagsState()).toEqual({ tags: [] });
  });

  it('refuses setup outside control, for an untagged target, and without a connected bridge', () => {
    const s = setup({ devices: [remo] });
    const tagged = s.addKnown();
    s.emit('control.setup', { cardId: tagged.cardId });
    expect(tryLink).not.toHaveBeenCalled();
    expect(s.of('agent.step').at(-1)?.sentence).toMatch(/control/i);
    expect(s.sent).toHaveBeenLastCalledWith(owner.deviceId, 'tags.state', { tags: [expect.objectContaining({ cardId: tagged.cardId, connection: 'offline', hint: expect.any(String) })] });
    s.agent.setMode('control');
    s.agent.targets.create({ cardId: 'untagged', card: { ...lightCard, cardId: 'untagged' } });
    expect(s.agent.setup('untagged', owner)).toBeUndefined();
    s.changePresence([]);
    s.emit('control.setup', { cardId: tagged.cardId });
    expect(s.of('tags.state').at(-1)?.tags[0]).toMatchObject({ cardId: tagged.cardId, connection: 'offline', hint: expect.stringMatching(/Cardputer|IR/i) });
    expect(s.of('agent.step').at(-1)?.sentence).toMatch(/connect|pair/i);
    expect(tryLink).not.toHaveBeenCalled();
    expect(s.dispatch).not.toHaveBeenCalled();
  });

  it('updates MIDI availability when companion output ports appear and disappear', () => {
    const mac: DeviceInfo = { ...remo, deviceId: 'mac', name: 'Mac app', kind: 'mac', role: 'companion', capabilities: ['midi'], ports: [] };
    const s = setup({ devices: [mac] });
    const target = s.addKnown({ ...lightCard, cardId: 'synth', name: 'Synthesizer', category: 'synthesizer', protocols: ['midi'], requires: ['midi'] });
    expect(s.agent.tagsState().tags[0]).toMatchObject({ cardId: target.cardId, connection: 'offline', hint: expect.stringMatching(/Mac|USB/i) });
    s.changePresence([{ ...mac, ports: [{ id: 'out', name: 'USB synth', kind: 'midi-out' }] }], 'update', mac.deviceId);
    expect(s.of('tags.state').at(-1)?.tags[0].connection).toBe('setup');
    s.changePresence([mac], 'update', mac.deviceId);
    expect(s.of('tags.state').at(-1)?.tags[0].connection).toBe('offline');
    expect(tryLink).not.toHaveBeenCalled();
    expect(s.dispatch).not.toHaveBeenCalled();
  });

  it('requires an armed verified spec and its current executor before showing Ready', () => {
    const s = setup({ devices: [remo] });
    const target = s.addKnown();
    Object.assign(target, { driver: lightDriver, specId: 'light-spec', verification: { off: 'pass' } });
    expect(s.agent.tagsState().tags[0].connection).toBe('setup');
    target.armed = true;
    s.changePresence([remo]);
    expect(s.of('tags.state').at(-1)?.tags[0]).toMatchObject({ connection: 'ready', specId: 'light-spec' });
    s.changePresence([{ ...remo, online: false, connections: 0 }], 'leave', remo.deviceId);
    expect(s.of('tags.state').at(-1)?.tags[0].connection).toBe('offline');
    s.changePresence([remo], 'join', remo.deviceId);
    expect(s.of('tags.state').at(-1)?.tags[0].connection).toBe('ready');
    expect(target.armed).toBe(true);
    expect(s.dispatch).not.toHaveBeenCalled();
  });

  it('starts only on setup, cancels cleanly, and aborts pending work when returning to annotation', async () => {
    const s = setup({ devices: [remo] });
    const target = s.addKnown();
    s.agent.setMode('control');
    s.emit('target.select', { cardId: target.cardId });
    expect(tryLink).not.toHaveBeenCalled();
    s.emit('control.setup', { cardId: target.cardId });
    expect(tryLink).toHaveBeenCalledTimes(1);
    const first = target.abort!;
    s.emit('control.cancel', { cardId: target.cardId });
    expect(first.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(target.abort).toBeUndefined();
    expect(s.agent.arm.pendingIds()).toEqual([]);
    s.emit('control.setup', { cardId: target.cardId });
    expect(tryLink).toHaveBeenCalledTimes(2);
    const second = target.abort!;
    s.emit('mode.set', { mode: 'annotate' });
    expect(second.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(target.abort).toBeUndefined();
    expect(s.dispatch).not.toHaveBeenCalled();
  });
});
