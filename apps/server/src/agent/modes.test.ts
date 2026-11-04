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
import { TagStore } from './tags';
import type { TargetDetection } from './types';
import type { Forge } from '../gen3d/forge';
import type { WireWritten } from './wire';
import { MacLocalExecutor } from './maclocal';

vi.mock('./link', async (original) => ({ ...await original<typeof import('./link')>(), tryLink: vi.fn() }));

const owner = { deviceId: 'quest', name: 'Quest' };
const widgets: NonNullable<PayloadOf<'ui.spec'>['widgets']> = [{ id: 'off', kind: 'button', label: 'Off', binding: { action: 'off' } }];
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
  const specs = new Map<string, PayloadOf<'ui.spec'>>();
  const forge = { get: (id: string) => specs.get(id), list: () => [...specs.values()] } as Forge;
  const agent = createAgent(ctx, { macLocal: false, forge: () => forge, ...(options.dataDir ? {} : { tagsFile: null }) });
  const dispatch = vi.spyOn(agent.dispatcher, 'exec');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    agent.close();
    ctx.hub.close();
  };
  cleanups.push(close);
  const emit = <T extends MessageType>(type: T, payload: PayloadOf<T>, canApprove = true, local = false) => {
    const event: HubMessageEvent = {
      message: makeMessage(type, payload, { from: owner.deviceId, to: 'server' }),
      device: { ...owner, canApprove, kind: 'quest', capabilities: ['camera'], tokenHash: 'test-token', pairedAt: 1 },
      connection: { local } as HubMessageEvent['connection'],
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
  return { ctx, agent, dispatch, sent, emit, changePresence, of, addKnown, close, specs };
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
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('annotation and control mode boundary', () => {
  it('uses OS speech feedback only for the owner or local requester', async () => {
    const exec = vi.spyOn(MacLocalExecutor.prototype, 'exec').mockResolvedValue({ ok: true, detail: 'Stub OS speech; no sound played' });
    const s = setup();
    s.emit('audio.speak', { text: 'That is a book!' }, false);
    expect(exec).not.toHaveBeenCalled();
    s.emit('audio.speak', { text: 'That is a book!' }, true);
    expect(exec).toHaveBeenCalledWith({ kind: 'local', op: 'say', arg: 'That is a book!' });
    await Promise.resolve();
  });
  it('refuses peripheral selection, retry and setup while accepting an owner page', () => {
    const s = setup({ devices: [remo] });
    const target = s.addKnown();
    s.emit('mode.set', { mode: 'control' }, false);
    expect(s.agent.mode()).toBe('annotate');
    s.emit('target.select', { deviceId: 'remo' }, false);
    expect(s.agent.tagsState().tags).toHaveLength(1);
    s.agent.setMode('control');
    s.emit('control.setup', { cardId: target.cardId }, false);
    s.emit('target.retry', { cardId: target.cardId }, false);
    expect(tryLink).not.toHaveBeenCalled();
    expect(target.abort).toBeUndefined();
    s.emit('control.setup', { cardId: target.cardId }, false, true);
    expect(tryLink).toHaveBeenCalledTimes(1);
  });

  it.each(['socket', 'voice', 'direct'] as const)('shares complete Stop cancellation through %s', async (entry) => {
    const s = setup({ devices: [remo] });
    const target = s.addKnown();
    s.agent.setMode('control');
    s.agent.setup(target.cardId, owner);
    const abort = target.abort!;
    const cancelCombo = vi.spyOn(s.agent.combos, 'cancel');
    const stopDaemons = vi.spyOn(s.agent.daemons, 'stopAll');
    const consent = s.agent.arm.ask(target, { title: 'Arm?', summary: 'Confirm', actions: [] });
    const armId = s.of('arm.request').at(-1)!.armId;
    if (entry === 'socket') s.emit('panic', { reason: 'stop' });
    else if (entry === 'voice') s.emit('voice.text', { utteranceId: 'stop', text: 'stop everything', final: true });
    else s.agent.panic('stop');
    await consent;
    s.emit('arm.confirm', { armId, approve: true });
    expect(abort.signal.aborted).toBe(true);
    expect(s.agent.arm.pendingIds()).toEqual([]);
    expect(target.armed).toBe(false);
    expect(cancelCombo).toHaveBeenCalled();
    expect(stopDaemons).toHaveBeenCalled();
    expect(s.of('panic')).toHaveLength(1);
  });

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

  it('keeps a tagged laptop as the physical target through selection and explicit setup when a visual synth is available', () => {
    vi.stubEnv('CE_DEMO', '1');
    const mac: DeviceInfo = { deviceId: 'mac', name: 'Mac', kind: 'mac', role: 'companion', capabilities: ['local', 'midi'],
      online: true, canApprove: true, connections: 1, pairedAt: 1,
      ports: [{ id: 'ce-visual-synth', name: 'ControlAnything Visual Synth', kind: 'midi-out', state: 'connected' }] };
    const s = setup({ devices: [mac] });
    const laptop = s.addKnown({ ...lightCard, cardId: 'physical-laptop', name: 'Apple MacBook laptop', maker: 'Apple', model: 'MacBook',
      category: 'computer', protocols: ['other'], requires: ['local'] });
    const identity = structuredClone(laptop.card);
    expect(s.agent.mode()).toBe('annotate');
    expect(s.agent.targets.list()).toEqual([laptop]);
    expect(s.agent.tagsState().tags).toEqual([expect.objectContaining({ cardId: laptop.cardId, connection: 'setup', hint: 'Set up control for this device' })]);
    expect(s.sent.mock.calls.some(([, type]) => type === 'visual.open')).toBe(false);
    expect(tryLink).not.toHaveBeenCalled();

    s.agent.setMode('control');
    expect(s.agent.select({ cardId: laptop.cardId }, owner)).toBe(laptop);
    expect(tryLink).not.toHaveBeenCalled();
    expect(s.agent.setup(laptop.cardId, owner)).toBe(laptop);
    expect(tryLink).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ cardId: laptop.cardId, category: 'computer' }), 'local',
      expect.objectContaining({ preferDeviceId: mac.deviceId, probeIdentity: false }));
    expect(laptop.card).toEqual(identity);
    expect(s.agent.targets.list()).toEqual([laptop]);
    expect(laptop.armed).toBe(false);
    expect(s.sent.mock.calls.some(([, type]) => type === 'visual.open')).toBe(false);
    expect(s.dispatch).not.toHaveBeenCalled();
  });

  it('opens the visual synth only on an explicit software selection and retains physical laptop tags', () => {
    vi.stubEnv('CE_DEMO', '1');
    const mac: DeviceInfo = { deviceId: 'mac', name: 'Mac', kind: 'mac', role: 'companion', capabilities: ['local', 'midi'],
      online: true, canApprove: true, connections: 1, pairedAt: 1,
      ports: [{ id: 'ce-visual-synth', name: 'ControlAnything Visual Synth', kind: 'midi-out', state: 'disconnected' }] };
    const s = setup({ devices: [mac] });
    const laptop = s.addKnown({ ...lightCard, cardId: 'physical-laptop', name: 'Apple MacBook laptop', maker: 'Apple', model: 'MacBook',
      category: 'computer', protocols: ['other'], requires: ['local'] });
    const identity = structuredClone(laptop.card);
    expect(s.sent.mock.calls.some(([, type]) => type === 'visual.open')).toBe(false);
    expect(s.agent.mode()).toBe('annotate');
    s.agent.select({ virtual: 'visual-synth', requestId: 'explicit-software-demo' }, owner);
    expect(s.agent.mode()).toBe('control');
    expect(s.sent.mock.calls.some(([id, type]) => id === mac.deviceId && type === 'visual.open')).toBe(true);
    expect(s.agent.tagsState().tags.map(tag => tag.cardId)).toEqual(expect.arrayContaining([laptop.cardId, 'visual-synth-mac']));
    expect(s.agent.targets.get(laptop.cardId)).toBe(laptop);
    expect(laptop.card).toEqual(identity);
    expect(laptop.armed).toBe(false);
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

  it('persists a quietly identified tag before any setup or state transition', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ce-identified-tag-'));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const first = setup({ dataDir, devices: [remo] });
    const jpeg = Buffer.from(encodeJpeg({ width: 8, height: 8, data: new Uint8Array(8 * 8 * 4).fill(120) }, 85)).toString('base64');
    const target = first.agent.targets.create({ detection: {
      frameId: 'frame', detId: 'det', sensorDeviceId: owner.deviceId, label: 'ceiling light', prompt: 'ceiling light', score: 0.9,
      box: [1, 1, 4, 4], width: 8, height: 8, jpeg, capturedAt: Date.now(),
    } });
    first.emit('tag.add', { targetId: target.cardId, label: 'Ceiling light', position: { x: 0, y: 1, z: -2 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(target.card?.name).toBe('FIXTURE ceiling light');
    expect(first.of('target.status')).toEqual([]);
    first.close();

    const restored = setup({ dataDir, devices: [remo] });
    expect(restored.agent.tagsState().tags).toEqual([expect.objectContaining({
      cardId: target.cardId, name: 'FIXTURE ceiling light', category: 'lighting',
      position: { x: 0, y: 1, z: -2 }, connection: 'setup',
    })]);
    expect(tryLink).not.toHaveBeenCalled();
    expect(restored.dispatch).not.toHaveBeenCalled();
  });

  it('untags in Annotate without publishing a failed setup or leaving controls armed', () => {
    const s = setup({ devices: [remo] });
    const target = s.addKnown();
    Object.assign(target, { driver: lightDriver, specId: 'light-spec', verification: { off: 'pass' }, armed: true });
    s.emit('tag.remove', { cardId: target.cardId });
    expect(target.armed).toBe(false);
    expect(s.agent.targets.get(target.cardId)).toBeUndefined();
    expect(s.of('tags.state').at(-1)).toEqual({ tags: [] });
    expect(s.of('target.status')).toEqual([]);
    expect(s.of('agent.step')).toEqual([]);
    expect(s.dispatch).not.toHaveBeenCalled();
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

  it.each(['ready', 'writing'] as const)('retires %s wiring when its executor actually disconnects, without resuming on reconnect', async phase => {
    const s = setup({ devices: [remo] });
    const target = s.addKnown();
    Object.assign(target, { driver: lightDriver, specId: 'light-spec', verification: { off: 'pass' }, armed: true, state: 'armed' });
    s.specs.set('light-spec', { specId: 'light-spec', cardId: target.cardId, driverId: lightDriver.driverId, title: 'Light controls', widgets });
    s.agent.setMode('control');
    const written: WireWritten = { ok: true, title: 'Test gesture', explanation: 'Explicit test double.', code: "if(s.right && s.right.pinchTap) out.trigger('off');",
      needs: ['right'], model: 'fixture-test-double', source: 'fixture', latencyMs: 0, attempts: 1, used: ['off'], issues: [] };
    let finish: ((result: WireWritten) => void) | undefined;
    let writerSignal: AbortSignal | undefined;
    const write = vi.spyOn(s.agent.harness, 'write').mockImplementation(async (_input, _emit, options) => {
      writerSignal = options?.signal;
      if (phase === 'ready') return written;
      return new Promise<WireWritten>(resolve => { finish = resolve; });
    });
    const retire = vi.spyOn(s.agent.connectors, 'clear');
    s.emit('wire.request', { cardId: target.cardId, requestId: 'disconnect-check', text: 'Pinch to switch it off', source: 'voice' });
    await vi.advanceTimersByTimeAsync(0);
    expect(write).toHaveBeenCalledOnce();
    if (phase === 'ready') expect(s.agent.wireReady(target.cardId)).toBeDefined();
    s.changePresence([], 'leave', remo.deviceId);
    expect(writerSignal?.aborted).toBe(phase === 'writing');
    expect(s.agent.wireReady(target.cardId)).toBeUndefined();
    expect(retire).toHaveBeenCalledWith(target.cardId);
    expect(s.sent.mock.calls.some(([id, type, payload]) => id === owner.deviceId && type === 'wire.stopped'
      && (payload as PayloadOf<'wire.stopped'>).requestId === 'disconnect-check')).toBe(true);
    finish?.(written);
    await vi.advanceTimersByTimeAsync(0);
    const readyCount = s.of('wire.ready').length;
    s.changePresence([remo], 'join', remo.deviceId);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.agent.wireReady(target.cardId)).toBeUndefined();
    expect(s.of('wire.ready')).toHaveLength(readyCount);
    expect(write).toHaveBeenCalledOnce();
    expect(s.dispatch).not.toHaveBeenCalled();
  });

  it('uses the same connection sentence and action for the tag and a rejected setup', () => {
    const mac: DeviceInfo = { ...remo, deviceId: 'mac', name: 'Mac app', kind: 'mac', role: 'companion', capabilities: ['midi'], ports: [] };
    const s = setup();
    const target = s.addKnown({ ...lightCard, cardId: 'synth', name: 'Synth', category: 'synthesizer', protocols: ['midi'], requires: ['midi'] });
    s.agent.setMode('control');
    s.emit('control.setup', { cardId: target.cardId });
    const disconnected = s.agent.tagsState().tags[0];
    expect(disconnected).toMatchObject({ hint: 'Open ControlAnything on your Mac and plug in the synth', action: 'open-companion' });
    expect(s.of('agent.step').at(-1)).toMatchObject({ sentence: disconnected.hint, hint: disconnected.hint, action: disconnected.action });
    s.changePresence([mac], 'join', mac.deviceId);
    s.emit('control.setup', { cardId: target.cardId });
    const pluggedOut = s.agent.tagsState().tags[0];
    expect(pluggedOut.hint).toBe('Plug the synth into your Mac');
    expect(pluggedOut.action).toBeUndefined();
    expect(s.of('agent.step').at(-1)).toMatchObject({ sentence: pluggedOut.hint, hint: pluggedOut.hint });
    expect(s.of('agent.step').at(-1)?.action).toBeUndefined();
    expect(tryLink).not.toHaveBeenCalled();
  });

  it('restores a saved control spec after restart and hydrates a reloaded headset without setup', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ce-control-reload-'));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const first = setup({ dataDir, devices: [remo] });
    const target = first.addKnown();
    Object.assign(target, { driver: lightDriver, specId: 'light-spec', verification: { off: 'pass' }, armed: true });
    const spec = { specId: 'light-spec', cardId: target.cardId, driverId: lightDriver.driverId, title: 'Light controls', widgets };
    new TagStore(join(dataDir, 'tags.json')).sync(target, spec);
    first.close();
    const restored = setup({ dataDir, devices: [remo] });
    expect(restored.agent.mode()).toBe('annotate');
    restored.agent.setMode('control');
    expect(restored.of('ui.spec')).toEqual([spec]);
    expect(restored.of('driver.status')).toEqual([expect.objectContaining({ phase: 'armed' })]);
    restored.changePresence([remo], 'join', owner.deviceId);
    expect(restored.sent).toHaveBeenCalledWith(owner.deviceId, 'device.card', lightCard);
    expect(restored.sent).toHaveBeenCalledWith(owner.deviceId, 'driver.spec', lightDriver);
    expect(restored.sent).toHaveBeenCalledWith(owner.deviceId, 'ui.spec', spec);
    expect(restored.sent).toHaveBeenCalledWith(owner.deviceId, 'driver.status', expect.objectContaining({ phase: 'armed' }));
    expect(restored.sent).toHaveBeenCalledWith(owner.deviceId, 'target.status', expect.objectContaining({ state: 'armed', executorDeviceId: 'remo' }));
    expect(tryLink).not.toHaveBeenCalled();
    expect(restored.dispatch).not.toHaveBeenCalled();
  });

  it('keeps a hidden device in the library and reattaches its stable identity without identifying again', () => {
    const s = setup({ devices: [remo] });
    const target = s.addKnown();
    s.emit('tag.remove', { cardId: target.cardId });
    expect(s.agent.libraryState().devices).toEqual([expect.objectContaining({ cardId: target.cardId, hidden: true, enabled: false })]);
    s.emit('tag.add', { cardId: target.cardId, targetId: 'new-observation', label: 'Ceiling light' });
    expect(s.agent.tagsState().tags).toHaveLength(1);
    expect(s.agent.targets.get(target.cardId)?.card).toEqual(lightCard);
    expect(s.agent.targets.get('new-observation')).toBeUndefined();
    s.emit('library.forget', { cardId: target.cardId }, false);
    expect(s.agent.libraryState().devices).toHaveLength(1);
    s.emit('library.forget', { cardId: target.cardId });
    expect(s.agent.libraryState().devices).toEqual([]);
    expect(tryLink).not.toHaveBeenCalled();
    expect(s.dispatch).not.toHaveBeenCalled();
  });

  it('accepts placement only from its owning headset and preserves it on restart', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ce-placement-'));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const s = setup({ dataDir });
    const target = s.addKnown();
    const placement = { headsetId: 'another-headset', origin: 'https://room.example', handle: 'saved-anchor', panelOffset: { x: 0, y: 0.1, z: 0 }, fallback: { label: 'Ceiling light' }, updatedAt: 1 };
    s.emit('library.place', { cardId: target.cardId, placement });
    expect(s.agent.libraryState().devices[0].placement).toBeUndefined();
    placement.headsetId = owner.deviceId;
    s.emit('library.place', { cardId: target.cardId, placement });
    s.close();
    expect(setup({ dataDir }).agent.libraryState().devices[0].placement).toEqual(placement);
  });

  it('keeps the completed version Ready when an explicitly requested rerun fails', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ce-rerun-'));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const initial = setup({ dataDir, devices: [remo] });
    const target = initial.addKnown();
    Object.assign(target, { driver: lightDriver, specId: 'light-spec', verification: { off: 'pass' }, armed: true });
    const spec = { specId: 'light-spec', cardId: target.cardId, driverId: lightDriver.driverId, title: 'Saved light controls', widgets };
    new TagStore(join(dataDir, 'library.json')).sync(target, spec);
    initial.close();
    const s = setup({ dataDir, devices: [remo] });
    const active = s.agent.libraryState().devices[0].activeVersionId;
    s.agent.setMode('control');
    vi.mocked(tryLink).mockRejectedValueOnce(new Error('Bridge failed during rerun'));
    s.emit('control.setup', { cardId: target.cardId, rerun: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.agent.libraryState().devices[0]).toMatchObject({ activeVersionId: active, enabled: true, connection: 'ready' });
    expect(s.agent.targets.get(target.cardId)?.driver).toEqual(lightDriver);
    expect(s.dispatch).not.toHaveBeenCalled();
    s.agent.panic();
    s.emit('library.restore', { cardId: target.cardId, versionId: active! });
    expect(s.agent.libraryState().devices[0]).toMatchObject({ activeVersionId: active, enabled: false, connection: 'setup' });
    expect(s.agent.targets.get(target.cardId)?.armed).toBe(false);
  });

  it('replays the current setup and pending confirmation on reload without extending approval', async () => {
    const s = setup({ devices: [remo] });
    const target = s.addKnown();
    s.agent.setMode('control');
    s.agent.setup(target.cardId, owner);
    const consent = s.agent.arm.ask(target, { title: 'Enable controls', summary: 'Ready', actions: [] });
    const request = s.of('arm.request').at(-1)!;
    await vi.advanceTimersByTimeAsync(500);
    s.changePresence([remo], 'join', owner.deviceId);
    expect(s.sent).toHaveBeenCalledWith(owner.deviceId, 'target.status', expect.objectContaining({ state: 'arming', runId: target.runId }));
    expect(s.sent).toHaveBeenCalledWith(owner.deviceId, 'arm.request', request);
    expect(s.agent.arm.pendingIds()).toEqual([request.armId]);
    s.agent.cancel({ cardId: target.cardId });
    await consent;
    s.sent.mockClear();
    s.changePresence([remo], 'join', owner.deviceId);
    expect(s.sent.mock.calls.some(([, type]) => type === 'arm.request')).toBe(false);
    expect(s.dispatch).not.toHaveBeenCalled();
  });

  it('requires an armed verified spec and its current executor before showing Ready', () => {
    const s = setup({ devices: [remo] });
    const target = s.addKnown();
    Object.assign(target, { driver: lightDriver, specId: 'light-spec', verification: { off: 'pass' } });
    expect(s.agent.tagsState().tags[0].connection).toBe('setup');
    target.armed = true;
    s.changePresence([remo]);
    expect(s.of('tags.state').at(-1)?.tags[0].connection).toBe('setup');
    s.specs.set('light-spec', { specId: 'light-spec', cardId: target.cardId, driverId: lightDriver.driverId, title: 'Light controls', widgets });
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
