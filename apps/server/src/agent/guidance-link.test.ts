import type { DeviceCardPayload, DeviceInfo, Driver, PayloadOf, SenseResultPayload, TargetState } from '@ce/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MidiProfile } from '../devices/profiles';
import type { MuseChat } from '../muse/adapter';
import { encodeJpeg } from '../oracle/image';
import type { WebSearcher } from '../research/websearch';
import type { Sam, SamResult } from '../scan/sam';
import { ArmService } from './arm';
import { Dispatcher } from './dispatch';
import { drive } from './drive';
import { tryLink } from './link';
import { runLoop, type LoopDeps } from './loop';
import { StepLog } from './steps';
import { TargetStore } from './targets';
import { refreshPolygon, verifyDriver, verifyOnce } from './verify';

vi.mock('./link', async (original) => {
  const module = await original<typeof import('./link')>();
  return { ...module, tryLink: vi.fn(module.tryLink) };
});
vi.mock('./drive', async (original) => ({ ...await original<typeof import('./drive')>(), drive: vi.fn() }));
vi.mock('./verify', async (original) => ({ ...await original<typeof import('./verify')>(), verifyDriver: vi.fn() }));

class TestHub {
  sent: { type: string; payload: unknown }[] = [];
  broadcast(type: string, payload: unknown): number {
    this.sent.push({ type, payload });
    return 1;
  }
  sendToDevice(_deviceId: string, type: string, payload: unknown): number {
    return this.broadcast(type, payload);
  }
  of<T>(type: string): T[] {
    return this.sent.filter((entry) => entry.type === type).map((entry) => entry.payload as T);
  }
}

const midiCard: DeviceCardPayload = {
  cardId: 'synth', name: 'OP-1', maker: 'Teenage Engineering', model: 'OP-1', category: 'synthesizer',
  confidence: 0.9, protocols: ['midi'], requires: ['midi'], evidence: ['Label on device'],
};
const profile: MidiProfile = {
  id: 'op-1-field', device: 'OP-1', manufacturer: 'Teenage Engineering', sources: [],
  usb: { portNameHint: 'OP-1' }, parameters: [{ name: 'Parameter', cc: 1, range: [0, 127] }],
};
const midiDriver: Driver = {
  driverId: 'midi-driver', cardId: 'synth', transport: 'midi', executor: { deviceId: 'healthy', port: 'output' }, provenance: [],
  actions: [{ actionId: 'parameter', label: 'Parameter', kind: 'set', range: { min: 0, max: 127 }, encode: { kind: 'midi', msg: 'cc', channel: 1, number: 1, value: '$value' }, expect: { sense: 'ack', effect: 'any' } }],
};
const noPort: DeviceInfo = {
  deviceId: 'preferred', name: 'Mac without instrument', kind: 'mac', role: 'companion', capabilities: ['midi'],
  canApprove: true, online: true, connections: 1, pairedAt: 1,
};
const healthy: DeviceInfo = {
  ...noPort, deviceId: 'healthy', name: 'Mac with instrument', ports: [{ id: 'output', name: 'OP-1', kind: 'midi-out' }],
};
const emptySegmentation: SamResult = { prompt: 'light', records: [], model: 'sam-3.1', source: 'fixture', latencyMs: 1, text: '' };

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(tryLink).mockClear();
  vi.mocked(drive).mockReset().mockResolvedValue({
    draft: midiDriver, validation: { ok: true, driver: midiDriver, issues: [] },
    model: 'muse-spark', effort: 'low', latencyMs: 1, attempts: 1, source: 'fixture',
  });
  vi.mocked(verifyDriver).mockReset().mockResolvedValue({ driver: midiDriver, verification: { parameter: 'fail' }, evidence: [], passed: 0, failed: 1 });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('MIDI connection readiness', () => {
  it.each([
    ['no ports', undefined],
    ['input only', [{ id: 'input', name: 'OP-1', kind: 'midi-in' }]],
    ['disconnected output', [{ id: 'output', name: 'OP-1', kind: 'midi-out', state: 'disconnected' }]],
  ] as const)('does not select an executor or send MIDI with %s', async (_label, ports) => {
    const hub = new TestHub();
    const dispatcher = new Dispatcher({ hub });
    const exec = vi.spyOn(dispatcher, 'exec');
    const client: DeviceInfo = { ...noPort, ports: ports ? [...ports] : undefined };
    const result = await tryLink({ roster: { macLocal: false, devices: () => [client] }, dispatcher }, midiCard, 'midi', { linkId: 'link', profile });
    expect(result.executor).toBeUndefined();
    expect(result.result).toMatchObject({ verdict: 'none', reason: expect.stringMatching(/MIDI output/) });
    expect(exec).not.toHaveBeenCalled();
    expect(hub.of('exec.command')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('falls through a preferred client without a MIDI port to a usable output', async () => {
    const hub = new TestHub();
    const dispatcher = new Dispatcher({ hub });
    const exec = vi.spyOn(dispatcher, 'exec');
    const result = await tryLink({ roster: { macLocal: false, devices: () => [noPort, healthy] }, dispatcher }, midiCard, 'midi', {
      linkId: 'link', profile, preferDeviceId: noPort.deviceId, probeIdentity: false,
    });
    expect(result.executor).toMatchObject({ deviceId: healthy.deviceId, port: { id: 'output' } });
    expect(result.result).toMatchObject({ verdict: 'consistent', executorDeviceId: healthy.deviceId });
    expect(exec).not.toHaveBeenCalled();
    expect(hub.of('exec.command')).toEqual([]);
  });

  function loopSetup(reply?: number[]) {
    const hub = new TestHub();
    const targets = new TargetStore(hub);
    const steps = new StepLog(hub);
    const dispatcher = new Dispatcher({ hub });
    const target = targets.create({ cardId: midiCard.cardId, card: structuredClone(midiCard) });
    const dispatchStates: TargetState[] = [];
    const exec = vi.spyOn(dispatcher, 'exec').mockImplementation(async () => {
      dispatchStates.push(target.state);
      return { execId: 'identity', ok: true, sentAt: 1, reply };
    });
    const deps: LoopDeps = {
      hub, targets, steps, dispatcher, arm: new ArmService({ hub, targets, steps }),
      roster: { macLocal: false, devices: () => [noPort, healthy] },
      profiles: { midi: new Map([[profile.id, profile]]), ir: undefined, koizumi: undefined, files: [] },
      spark: { model: 'muse-spark' } as MuseChat, sam: {} as Sam, web: {} as WebSearcher, forge: () => undefined,
    };
    return { hub, target, deps, exec, dispatchStates };
  }

  it('uses a passive LINK check and waits until VERIFY to probe MIDI identity', async () => {
    const { target, deps, exec, dispatchStates } = loopSetup();
    await runLoop(deps, target, { preferDeviceId: noPort.deviceId });
    expect(vi.mocked(tryLink).mock.calls[0]?.[3]).toMatchObject({ probeIdentity: false });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]?.[1]).toMatchObject({ kind: 'midi', msg: 'sysex-identity' });
    expect(dispatchStates).toEqual(['verifying']);
    expect(verifyDriver).toHaveBeenCalledTimes(1);
    expect(target.armed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, false])('uses the headset microphone when available (%s) and describes the actual sensor', async (headsetOnline) => {
    const { hub, target, deps } = loopSetup();
    const mac: DeviceInfo = { ...healthy, capabilities: ['midi', 'mic'] };
    const quest: DeviceInfo = { ...healthy, deviceId: 'quest', name: 'Quest 3', kind: 'quest', role: 'hmd', capabilities: ['camera', 'mic'], online: headsetOnline };
    deps.roster.devices = () => [mac, quest];
    target.selectedBy = quest.deviceId;
    await runLoop(deps, target);
    expect(vi.mocked(verifyDriver).mock.calls[0]?.[3].micDeviceId).toBe(headsetOnline ? quest.deviceId : mac.deviceId);
    const sentence = headsetOnline ? 'Listening through the headset mic…' : 'Listening through the connected microphone…';
    expect(hub.of<PayloadOf<'target.status'>>('target.status')).toContainEqual(expect.objectContaining({ state: 'verifying', sentence }));
    expect(hub.of<PayloadOf<'agent.step'>>('agent.step')).toContainEqual(expect.objectContaining({ phase: 'verify', status: 'running', sentence }));
  });

  it('keeps the simulated synth on its own analyser even with a headset online', async () => {
    const { target, deps } = loopSetup();
    const sim: DeviceInfo = { ...healthy, kind: 'sim', capabilities: ['midi', 'mic'] };
    const quest: DeviceInfo = { ...healthy, deviceId: 'quest', kind: 'quest', role: 'hmd', capabilities: ['camera', 'mic'] };
    deps.roster.devices = () => [sim, quest];
    target.selectedBy = quest.deviceId;
    await runLoop(deps, target);
    expect(vi.mocked(verifyDriver).mock.calls[0]?.[3].micDeviceId).toBe(sim.deviceId);
  });

  it('refuses a mismatched MIDI identity before any action verification', async () => {
    const rolandReply = [0xf0, 0x7e, 0x7f, 0x06, 0x02, 0x41, 0x01, 0x00, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0xf7];
    const { hub, target, deps, exec, dispatchStates } = loopSetup(rolandReply);
    await runLoop(deps, target);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(dispatchStates).toEqual(['verifying']);
    expect(verifyDriver).not.toHaveBeenCalled();
    expect(target.armed).toBe(false);
    expect(hub.of<PayloadOf<'target.status'>>('target.status').at(-1)).toMatchObject({ state: 'failed', action: 'retry', sentence: 'Check the connected instrument', hint: expect.any(String) });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('camera visibility before verification output', () => {
  function setup() {
    const hub = new TestHub();
    const targets = new TargetStore(hub);
    const dispatcher = new Dispatcher({ hub });
    const jpeg = Buffer.from(encodeJpeg({ width: 32, height: 32, data: new Uint8Array(32 * 32 * 4).fill(180) })).toString('base64');
    const frame: SenseResultPayload = {
      senseId: 'frame-request', kind: 'frame', at: 1,
      frame: { frameId: 'frame', jpeg, width: 32, height: 32, capturedAt: 1, purpose: 'verify' },
    };
    const sense = vi.spyOn(dispatcher, 'sense').mockResolvedValue([frame]);
    const exec = vi.spyOn(dispatcher, 'exec');
    const sam: Sam = { mode: 'fixture', segment: vi.fn<Sam['segment']>().mockResolvedValue(emptySegmentation), segmentAll: vi.fn<Sam['segmentAll']>().mockResolvedValue([]) };
    const target = targets.create({
      cardId: 'light',
      detection: { frameId: 'scan', detId: 'light', sensorDeviceId: 'quest', label: 'light', prompt: 'light', score: 0.9, box: [8, 8, 16, 16], width: 32, height: 32, jpeg, capturedAt: 1 },
    });
    const driver: Driver = {
      driverId: 'light-driver', cardId: target.cardId, transport: 'ir', executor: { deviceId: 'remo' }, provenance: [],
      actions: [{ actionId: 'off', label: 'Off', kind: 'trigger', encode: { kind: 'ir', protocol: 'NEC', bytes: [1, 2, 3, 4] }, expect: { sense: 'camera', effect: 'off' } }],
    };
    const verify = (cameraDeviceId?: string, signal?: AbortSignal) => verifyOnce({ dispatcher, sam }, target, driver, driver.actions[0]!, 1, { cameraDeviceId, signal });
    return { hub, sense, exec, sam, verify };
  }

  it('does not send a command without an online camera', async () => {
    const { sense, exec, verify } = setup();
    await expect(verify()).rejects.toThrow(/no camera/i);
    expect(sense).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it('does not send a command when the camera cannot provide a frame', async () => {
    const { sense, exec, verify } = setup();
    sense.mockResolvedValue([{ senseId: 'frame-request', kind: 'frame', at: 1, ok: false, error: 'camera unavailable' }]);
    await expect(verify('quest')).rejects.toThrow(/no frame/i);
    expect(exec).not.toHaveBeenCalled();
  });

  it.each(['no matches', 'a different object'])('does not reuse the old outline when SAM sees %s', async (result) => {
    const { hub, exec, sam, verify } = setup();
    if (result === 'a different object') vi.mocked(sam.segment).mockResolvedValue({
      ...emptySegmentation, records: [{ id: 1, x1: 0, y1: 0, x2: 3, y2: 3, w: 32, h: 32 }],
    });
    await expect(verify('quest')).rejects.toThrow();
    expect(exec).not.toHaveBeenCalled();
    expect(hub.of('exec.command')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries a failed outline model once and stops without sending a command', async () => {
    const { exec, sam, verify } = setup();
    vi.mocked(sam.segment).mockRejectedValue(new Error('model unavailable'));
    await expect(verify('quest')).rejects.toThrow();
    expect(sam.segment).toHaveBeenCalledTimes(2);
    expect(exec).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops if cancellation arrives as the model returns a visible outline', async () => {
    const { exec, sam, verify } = setup();
    const abort = new AbortController();
    vi.mocked(sam.segment).mockImplementation(async () => {
      abort.abort();
      return { ...emptySegmentation, records: [{ id: 1, x1: 8, y1: 8, x2: 23, y2: 23, w: 32, h: 32 }] };
    });
    await expect(verify('quest', abort.signal)).rejects.toThrow();
    expect(sam.segment).toHaveBeenCalledTimes(1);
    expect(exec).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the central-frame fallback for a target with no stored detection', async () => {
    const { sam } = setup();
    const target = new TargetStore(new TestHub()).create({ cardId: 'unscanned-light' });
    await expect(refreshPolygon(sam, target, 'unused', 32, 32)).resolves.toMatchObject({
      fresh: false, model: 'none', polygon: [[8, 8], [24, 8], [24, 24], [8, 24]],
    });
    expect(sam.segment).not.toHaveBeenCalled();
  });
});
