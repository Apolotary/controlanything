import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DeviceInfo } from '@ce/protocol';
import type { Roster } from './executors';
import { evaluateConnection, TagStore, tagSnapshot, tagCapability } from './tags';
import { TargetStore } from './targets';
import type { Target } from './types';

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function target(category: NonNullable<Target['card']>['category'] = 'synthesizer'): Target {
  return new TargetStore({ broadcast: () => 0 }).create({
    cardId: 'device-1',
    card: { cardId: 'device-1', name: 'Synth', maker: 'Maker', model: 'Model', category, confidence: 0.9, protocols: [], evidence: [] },
  });
}

function device(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    deviceId: 'companion', name: 'Mac', kind: 'mac', role: 'companion', capabilities: ['midi'],
    canApprove: true, online: true, connections: 1, pairedAt: 1,
    ports: [{ id: 'output', name: 'Synth', kind: 'midi-out', state: 'connected' }],
    ...overrides,
  };
}

function ready(t: Target): Target {
  t.driver = {
    driverId: 'driver', cardId: t.cardId, transport: 'midi', executor: { deviceId: 'companion', port: 'output' },
    provenance: [], actions: [{ actionId: 'cutoff', label: 'Cutoff', kind: 'set', encode: { kind: 'midi', msg: 'cc', channel: 1, number: 74, value: '$value' } }],
  };
  t.verification = { cutoff: 'pass' };
  t.specId = 'spec';
  t.armed = true;
  return t;
}

describe('TagStore', () => {
  it('persists tags, positions, identification and setup across restarts without transient work', () => {
    const dir = mkdtempSync(join(process.cwd(), '.tags-test-'));
    temporary.push(dir);
    const file = join(dir, 'tags.json');
    const store = new TagStore(file);
    const t = target();
    t.abort = new AbortController();
    store.add(t, 'Keyboard', { x: 1, y: 2, z: -1 });
    ready(t);
    store.sync(t, { specId: 'spec', cardId: t.cardId, driverId: 'driver', title: 'Synth control' });
    store.sync(t);
    const saved = new TagStore(file).get(t.cardId);
    expect(saved).toMatchObject({ label: 'Keyboard', position: { x: 1, y: 2, z: -1 }, card: t.card, driver: t.driver, verification: { cutoff: 'pass' }, specId: 'spec', uiSpec: { specId: 'spec', cardId: t.cardId, driverId: 'driver' }, armed: true });
    expect(readFileSync(join(dir, 'library.json'), 'utf8')).not.toContain('abort');
    const restored = new TargetStore({ broadcast: () => 0 }).create(saved);
    expect(evaluateConnection(restored, { devices: () => [device()], macLocal: false }).connection).toBe('ready');
  });

  it('removes a tag persistently and does not recreate it from a late setup update', () => {
    const dir = mkdtempSync(join(process.cwd(), '.tags-test-'));
    temporary.push(dir);
    const file = join(dir, 'tags.json');
    const store = new TagStore(file);
    const t = target();
    store.add(t, 'Synth');
    expect(store.remove(t.cardId)).toBe(true);
    expect(store.remove(t.cardId)).toBe(false);
    store.sync(ready(t));
    expect(new TagStore(file).list()).toEqual([]);
  });

  it('keeps duplicate tags singular and protects stored state from caller mutation', () => {
    const store = new TagStore();
    const t = target();
    store.add(t, 'Keyboard', { x: 0, y: 1, z: -2 });
    const updated = store.add(t, 'Synth');
    updated.label = 'Changed';
    store.list()[0].card!.name = 'Changed';
    expect(store.list()).toHaveLength(1);
    expect(store.get(t.cardId)).toMatchObject({ label: 'Synth', card: { name: 'Synth' }, position: { x: 0, y: 1, z: -2 } });
  });
});

describe('tag connection evaluation', () => {
  it.each([
    ['no ports', []],
    ['input only', [{ id: 'input', name: 'Synth', kind: 'midi-in' as const }]],
    ['disconnected output', [{ id: 'output', name: 'Synth', kind: 'midi-out' as const, state: 'disconnected' as const }]],
  ])('requires a connected MIDI output: %s', (_name, ports) => {
    expect(evaluateConnection(target(), { devices: () => [device({ ports })], macLocal: false })).toEqual({ connection: 'offline', hint: 'Plug the synth into your Mac' });
  });

  it.each([
    ['no companion', []],
    ['offline companion', [device({ online: false })]],
    ['only a headset', [device({ kind: 'quest', role: 'hmd', capabilities: ['camera', 'mic'], ports: [] })]],
  ])('offers Connect Mac for %s, without mistaking the server Mac for a MIDI bridge', (_name, devices) => {
    expect(evaluateConnection(target(), { devices: () => devices, macLocal: true })).toEqual({
      connection: 'offline', hint: 'Open ControlAnything on your Mac and plug in the synth', action: 'open-companion',
    });
  });

  it('asks for the cable without a pairing action while the companion has no MIDI permission or is a standby', () => {
    expect(evaluateConnection(target(), { devices: () => [device({ capabilities: [], ports: [] })], macLocal: false })).toEqual({
      connection: 'offline', hint: 'Plug the synth into your Mac',
    });
  });

  it('requires the original companion when a saved synth is assigned to it', () => {
    expect(evaluateConnection(ready(target()), { devices: () => [device({ deviceId: 'another-mac' })], macLocal: false })).toEqual({
      connection: 'offline', hint: 'Open ControlAnything on your Mac and plug in the synth', action: 'open-companion',
    });
  });

  it('re-evaluates presence and ports without caching a stale connection', () => {
    const t = ready(target());
    const bridge = device();
    const roster: Roster = { devices: () => [bridge], macLocal: false };
    expect(evaluateConnection(t, roster).connection).toBe('ready');
    bridge.online = false;
    expect(evaluateConnection(t, roster).connection).toBe('offline');
    bridge.online = true;
    bridge.ports = [];
    expect(evaluateConnection(t, roster).connection).toBe('offline');
    bridge.ports = device().ports;
    expect(evaluateConnection(t, roster).connection).toBe('ready');
  });

  it('requires verification, an armed spec and the assigned executor for Ready', () => {
    const t = ready(target());
    const roster: Roster = { devices: () => [device()], macLocal: false };
    t.verification.cutoff = 'fail';
    expect(evaluateConnection(t, roster).connection).toBe('setup');
    t.verification.cutoff = 'pass';
    t.armed = false;
    expect(evaluateConnection(t, roster).connection).toBe('setup');
    t.armed = true;
    t.specId = undefined;
    expect(evaluateConnection(t, roster).connection).toBe('setup');
    t.specId = 'spec';
    expect(evaluateConnection(t, { ...roster, devices: () => [device({ deviceId: 'another-companion' })] }).connection).toBe('offline');
    expect(evaluateConnection(t, { ...roster, devices: () => [device({ ports: [{ id: 'another-output', name: 'Synth', kind: 'midi-out' }] })] }).connection).toBe('offline');
  });

  it('requires a paired online IR bridge for lights and appliance controls', () => {
    const t = target('lighting');
    const bridge = device({ deviceId: 'ir', kind: 'cardputer', capabilities: ['ir'], ports: [] });
    const roster: Roster = { devices: () => [bridge], macLocal: false };
    expect(evaluateConnection(t, roster).connection).toBe('setup');
    bridge.online = false;
    expect(evaluateConnection(t, roster)).toMatchObject({ connection: 'offline', hint: expect.stringContaining('Cardputer') });
    bridge.kind = 'remo';
    bridge.online = true;
    expect(evaluateConnection(t, roster).connection).toBe('setup');
    const tv = target('appliance');
    tv.card!.name = 'TV';
    expect(evaluateConnection(tv, roster).connection).toBe('setup');
  });

  it('requires a helper before using the local Mac executor for a laptop, and supports the simulated room', () => {
    const t = target('computer');
    expect(evaluateConnection(t, { devices: () => [], macLocal: true })).toEqual({
      connection: 'offline', hint: 'Open localhost:8787/pair on this laptop', action: 'open-companion',
    });
    expect(evaluateConnection(t, { devices: () => [device()], macLocal: true }).connection).toBe('setup');
    expect(evaluateConnection(t, { devices: () => [device({ capabilities: ['midi'] })], macLocal: false }).connection).toBe('offline');
    expect(evaluateConnection(t, { devices: () => [device({ kind: 'sim', capabilities: ['local'] })], macLocal: false }).connection).toBe('setup');
    expect(evaluateConnection(t, { devices: () => [device({ kind: 'mac', capabilities: ['local'] })], macLocal: false }).connection).toBe('setup');
    expect(evaluateConnection(t, { devices: () => [device({ kind: 'devterm', capabilities: ['local'] })], macLocal: false }).connection).toBe('offline');
  });

  it.each(['laptop', 'computer', 'MacBook'])('maps a detected %s to local control and the server pairing URL', (label) => {
    const t = target('other');
    t.card!.name = label;
    expect(tagCapability(t)).toBe('local');
    expect(evaluateConnection(t, { devices: () => [], macLocal: true, helperUrl: () => 'http://localhost:9876/pair' })).toEqual({
      connection: 'offline', hint: 'Open localhost:9876/pair on this laptop', action: 'open-companion',
    });
  });

  it('offers pairing for a laptop detection before model identification completes', () => {
    const t = target();
    t.card = undefined;
    t.detection = { frameId: 'frame', detId: 'laptop', label: 'laptop', prompt: 'electronics', sensorDeviceId: 'headset',
      score: 0.9, box: [0, 0, 100, 100], width: 100, height: 100, jpeg: '', capturedAt: 1 };
    expect(evaluateConnection(t, { devices: () => [], macLocal: true })).toMatchObject({
      connection: 'offline', hint: 'Open localhost:8787/pair on this laptop', action: 'open-companion',
    });
  });

  it('keeps the laptop pairing hint when a local tag arrives before its camera frame', () => {
    const t = target();
    t.card = undefined;
    const tag = new TagStore().add(t, 'laptop');
    expect(tagSnapshot(tag, t, { devices: () => [], macLocal: true })).toMatchObject({
      label: 'laptop', connection: 'offline', hint: 'Open localhost:8787/pair on this laptop', action: 'open-companion',
    });
  });

  it('drops laptop readiness when its helper goes offline even if the internal Mac executor remains available', () => {
    const t = ready(target('computer'));
    t.driver!.executor = { deviceId: 'mac-local' };
    const helper = device({ capabilities: [] });
    const roster: Roster = { devices: () => [helper], macLocal: true };
    expect(evaluateConnection(t, roster).connection).toBe('ready');
    helper.online = false;
    expect(evaluateConnection(t, roster)).toMatchObject({ connection: 'offline', action: 'open-companion' });
  });

  it('keeps an explicitly selected local device offline when only another executor is online', () => {
    const t = target('computer');
    t.card!.notes = 'device:selected-mac';
    t.selection = { preferDeviceId: 'selected-mac' };
    expect(evaluateConnection(t, { devices: () => [], macLocal: true }).connection).toBe('offline');
    expect(evaluateConnection(t, { devices: () => [device({ deviceId: 'selected-mac', capabilities: ['local'] })], macLocal: true }).connection).toBe('setup');
  });

  it.each(['synthesizer', 'lighting', 'computer'] as const)('does not confuse the requesting headset with the selected %s', (category) => {
    const t = target(category);
    t.selection = { preferDeviceId: 'headset' };
    const headset = device({ deviceId: 'headset', kind: 'quest', capabilities: ['camera', 'mic'] });
    const bridge = device({ capabilities: ['midi', 'ir', 'local'] });
    expect(evaluateConnection(t, { devices: () => [headset, bridge], macLocal: false }).connection).toBe('setup');
  });

  it('publishes current names and connection state in the protocol snapshot', () => {
    const store = new TagStore();
    const t = target();
    const tag = store.add(t, 'Keyboard', { x: 0, y: 1, z: -1 });
    t.card!.name = 'Identified synth';
    expect(tagSnapshot(tag, t, { devices: () => [device()], macLocal: false })).toMatchObject({
      cardId: t.cardId, label: 'Keyboard', name: 'Identified synth', category: 'synthesizer',
      position: { x: 0, y: 1, z: -1 }, connection: 'setup',
    });
  });
});
