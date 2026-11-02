import type { Driver, DriverAction, Hack, PayloadOf, UiSpecPayload } from '@ce/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadProfiles } from '../devices/profiles';
import { validateDriver } from '../devices/validate';
import type { Sam } from '../scan/sam';
import { ArmService } from './arm';
import { ComboRunner } from './combos';
import type { DaemonRunner } from './daemons';
import { ControlRouter } from './control';
import { Dispatcher, ExecError } from './dispatch';
import { StepLog } from './steps';
import { TargetStore } from './targets';
import { verifyDriver, verifyOnce } from './verify';

const ack = { execId: 'exec', ok: true, sentAt: 1 };
const screen: DriverAction = { actionId: 'screen', label: 'Screen', kind: 'set', range: { min: 0, max: 100 }, encode: { kind: 'local', op: 'screen', arg: '$value' }, expect: { sense: 'ack', effect: 'any' } };
const up: DriverAction = { actionId: 'up', label: 'Up', kind: 'trigger', encode: { kind: 'local', op: 'screen', arg: 1 }, expect: { sense: 'ack', effect: 'any' }, inverseActionId: 'down' };
const down: DriverAction = { ...up, actionId: 'down', label: 'Down', encode: { kind: 'local', op: 'screen', arg: 0 }, inverseActionId: 'up' };
const level: DriverAction = { actionId: 'level', label: 'Level', kind: 'set', range: { min: 0, max: 100 }, encode: { kind: 'step', upActionId: 'up', downActionId: 'down', steps: 10, settleMs: 334 }, expect: { sense: 'ack', effect: 'any' } };
const driver: Driver = { driverId: 'driver', cardId: 'device', transport: 'local', executor: { deviceId: 'mac-local' }, provenance: [], actions: [screen, up, down, level] };
const controlHack: Hack = { id: 'screen-control', name: 'Screen', kind: 'control', params: [{ id: 'value', name: 'Value', min: 0, max: 100 }], commands: [{ action: 'screen', param: 'value' }], oracle: { type: 'wire', expect: 'serial_ack' }, max_rate_hz: 5 };
const actionHack: Hack = { id: 'screen-up', name: 'Up', kind: 'action', commands: [{ action: 'up' }], inverse: { commands: [{ action: 'down' }] }, oracle: { type: 'wire', expect: 'serial_ack' }, max_rate_hz: 5 };
const compositeHack: Hack = { ...controlHack, id: 'screen-level', commands: [{ action: 'level', param: 'value' }] };
const spec: UiSpecPayload = { specId: 'spec', cardId: 'device', rev: 1, hackset: { spec: 'ce.hackset/1', device: { id: 'device', name: 'Screen', channel: { type: 'local' } }, hacks: [controlHack, actionHack, compositeHack] } };

function setup() {
  const hub = { broadcast: vi.fn(() => 1), sendToDevice: vi.fn(() => 1) };
  const targets = new TargetStore(hub);
  // The unit boundary represents a tagged, armed device in Control mode with a connected bridge.
  const target = targets.create({ cardId: 'device', driver: structuredClone(driver), specId: 'spec', armed: true, verification: { screen: 'pass', up: 'pass', down: 'pass', level: 'pass' } });
  const steps = new StepLog(hub);
  const fire = vi.fn(() => true);
  const exec = vi.fn(async () => ack);
  const dispatcher = { fire, exec, flushQueued: vi.fn() } as unknown as Dispatcher;
  const specs = { get: () => spec, list: () => [spec] };
  const router = new ControlRouter({ hub, targets, steps, dispatcher, specs, canControl: (t) => t.cardId === 'device' });
  const arm = new ArmService({ hub, targets, steps });
  const combos = new ComboRunner({ hub, targets, steps, dispatcher, arm, sam: {} as Sam, daemons: {} as DaemonRunner, roster: { devices: () => [], macLocal: true }, canControl: (t) => t.cardId === 'device' });
  return { hub, targets, target, dispatcher, fire, exec, router, combos, arm };
}

afterEach(() => { vi.useRealTimers(); });

describe('physical verification requirements', () => {
  it('rejects acknowledgement-only IR drafts and direct probes', async () => {
    const profiles = loadProfiles();
    const action: DriverAction = { actionId: 'off', label: 'Off', kind: 'trigger', encode: profiles.ir!.candidates[0]!.op, expect: { sense: 'ack', effect: 'off' } };
    const irDriver: Driver = { ...driver, transport: 'ir', actions: [action] };
    const result = validateDriver(irDriver, { driverId: driver.driverId, executor: driver.executor }, { irLibrary: profiles.ir });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'physical_oracle_required' }));
    const s = setup();
    await expect(verifyOnce({ dispatcher: s.dispatcher, sam: {} as Sam }, s.target, irDriver, action, 1, {})).rejects.toThrow('camera evidence');
    expect(s.exec).not.toHaveBeenCalled();
  });

  it('requires both directions to pass before enabling a composite', async () => {
    const s = setup();
    const exec = vi.fn(async (_device: string, _op: unknown, opts: { actionId?: string }) => {
      if (opts.actionId === 'down') throw new ExecError('refused', 'device', { ...ack, ok: false });
      return ack;
    });
    const result = await verifyDriver({ dispatcher: { exec } as unknown as Dispatcher, sam: {} as Sam }, s.target, { ...driver, actions: [level, up, down] }, {});
    expect(result.verification).toEqual({ level: 'fail', up: 'pass', down: 'fail' });
  });

  it('checks the concrete direction even if a stale composite status says pass', () => {
    const s = setup();
    s.target.verification.down = 'fail';
    s.target.stepIndex.level = 5;
    s.router.runHack(s.target, compositeHack.id, 0);
    expect(s.fire).not.toHaveBeenCalled();
  });

  it.each(['explicit', 'driver fallback'])('refuses an unverified %s inverse', (inverse) => {
    const s = setup();
    const localSpec = structuredClone(spec);
    if (inverse === 'driver fallback') localSpec.hackset!.hacks[1]!.inverse = undefined;
    const router = new ControlRouter({ hub: s.hub, targets: s.targets, steps: new StepLog(s.hub), dispatcher: s.dispatcher, specs: { get: () => localSpec, list: () => [localSpec] }, canControl: () => true });
    expect(router.runHack(s.target, actionHack.id).fired).toBe(1);
    s.target.verification.down = 'fail';
    expect(router.undo(s.target).ok).toBe(false);
    expect(s.fire).toHaveBeenCalledTimes(1);
  });

  it('rechecks verification before a delayed inverse dispatch', async () => {
    vi.useFakeTimers();
    const s = setup();
    const localSpec = structuredClone(spec);
    localSpec.hackset!.hacks[1]!.inverse!.commands![0]!.delayMs = 100;
    const router = new ControlRouter({ hub: s.hub, targets: s.targets, steps: new StepLog(s.hub), dispatcher: s.dispatcher, specs: { get: () => localSpec, list: () => [localSpec] }, canControl: () => true });
    router.runHack(s.target, actionHack.id);
    router.undo(s.target);
    s.target.verification.down = 'fail';
    await vi.advanceTimersByTimeAsync(100);
    expect(s.fire).toHaveBeenCalledTimes(1);
  });
});

describe('control output and Stop', () => {
  it('coalesces rate-limited knob updates and delivers the final value', async () => {
    vi.useFakeTimers();
    const s = setup();
    for (const value of [20, 40, 80]) expect(s.router.runHack(s.target, controlHack.id, value).ok).toBe(true);
    expect(s.fire).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(s.fire).toHaveBeenCalledTimes(2);
    expect(s.fire.mock.calls[1]).toEqual(['mac-local', { kind: 'local', op: 'screen', arg: 0.8 }, expect.any(Object)]);
    expect(s.target.paramValues.value).toBe(80);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops coalesced controls on Stop so a later re-arm cannot release them', async () => {
    vi.useFakeTimers();
    const s = setup();
    s.router.runHack(s.target, controlHack.id, 20);
    s.router.runHack(s.target, controlHack.id, 80);
    s.router.panic();
    s.target.armed = true;
    await vi.advanceTimersByTimeAsync(500);
    expect(s.fire).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sends a portless panic once to each MIDI executor', () => {
    const s = setup();
    for (const [cardId, deviceId, port] of [['synth-a', 'companion-a', 'port-a'], ['synth-b', 'companion-a', 'port-b'], ['synth-c', 'companion-b', 'port-c']] as const) {
      s.targets.create({ cardId, armed: true, driver: { ...driver, cardId, transport: 'midi', executor: { deviceId, port } } });
    }
    expect(s.router.panic().sent).toBe(2);
    expect(s.fire.mock.calls).toEqual([
      ['companion-a', { kind: 'midi', msg: 'panic', channel: 1 }, { cardId: 'synth-a', driverId: 'driver' }],
      ['companion-b', { kind: 'midi', msg: 'panic', channel: 1 }, { cardId: 'synth-c', driverId: 'driver' }],
    ]);
  });

  it('cancels a combo between commands and clears its delay', async () => {
    vi.useFakeTimers();
    const s = setup();
    const hack: Hack = { ...actionHack, commands: [{ cardId: 'device', action: 'up' }, { cardId: 'device', action: 'down', delayMs: 1000 }] };
    const run = s.combos.run(hack, spec, { confirm: false });
    const rejected = expect(run).rejects.toThrow(/cancelled/i);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.exec).toHaveBeenCalledTimes(1);
    s.combos.cancel();
    await rejected;
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.exec).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a combo confirmation and ignores a late approval', async () => {
    const s = setup();
    const run = s.combos.run({ ...actionHack, commands: [{ cardId: 'device', action: 'up' }] }, spec);
    const rejected = expect(run).rejects.toThrow(/cancelled/i);
    const armId = s.arm.pendingIds()[0]!;
    s.combos.cancel('device');
    await rejected;
    expect(s.arm.onConfirm({ armId, approve: true }, { canApprove: true })).toBe(false);
    expect(s.exec).not.toHaveBeenCalled();
  });

  it('does not undo a combo through a failed inverse', async () => {
    const s = setup();
    await s.combos.run({ ...actionHack, commands: [{ cardId: 'device', action: 'up' }] }, spec, { confirm: false });
    s.target.verification.down = 'fail';
    expect(await s.combos.undo()).toMatchObject({ restored: [], cannot: ['device: up'] });
    expect(s.exec).toHaveBeenCalledTimes(1);
  });

  it('cancels an in-flight combo undo before the next inverse', async () => {
    const s = setup();
    s.combos.lastRun = { hackId: actionHack.id, startedAt: 1, confirmed: true, evidence: [], steps: [
      { cardId: 'device', name: 'Screen', actionId: 'up', ok: true, undo: { actionId: 'down' } },
      { cardId: 'device', name: 'Screen', actionId: 'up', ok: true, undo: { actionId: 'down' } },
    ] };
    vi.spyOn(s.dispatcher, 'exec').mockImplementationOnce((_id, _op, opts) => new Promise((_resolve, reject) => {
      opts!.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }));
    const undo = s.combos.undo();
    const rejected = expect(undo).rejects.toThrow(/cancelled/i);
    s.combos.cancel();
    await rejected;
    expect(s.exec).toHaveBeenCalledTimes(1);
    expect(s.combos.lastRun).toBeUndefined();
  });
});

describe('volume probe restoration', () => {
  const volume: DriverAction = { ...screen, actionId: 'volume', label: 'Volume', encode: { kind: 'local', op: 'volume', arg: '$value' } };

  it.each(['ack', 'sensor failure', 'cancelled'])('restores the snapshot after %s with independent cleanup', async (completion) => {
    const s = setup();
    const abort = new AbortController();
    const sent: number[] = [];
    const exec = vi.fn(async (_device: string, op: PayloadOf<'exec.command'>['op'], opts: { signal?: AbortSignal; actionId?: string }) => {
      if (op.kind === 'local') sent.push(Number(op.arg));
      if (opts.actionId === 'volume' && completion === 'cancelled') {
        abort.abort();
        throw new Error('cancelled');
      }
      if (opts.actionId?.endsWith(':restore')) expect(opts.signal?.aborted).toBe(false);
      return ack;
    });
    const sense = vi.fn().mockResolvedValueOnce([{ audio: { rms: 0.1, peak: 0.2, zcr: 0.1, spectralCentroid: 100, durationMs: 600 } }]).mockRejectedValueOnce(new Error('sensor failed'));
    const result = verifyOnce({ dispatcher: { exec, sense } as unknown as Dispatcher, sam: {} as Sam, readVolume: async () => 55, settleMs: () => 0 }, s.target, driver, completion === 'sensor failure' ? { ...volume, expect: { sense: 'audio', effect: 'quieter' } } : volume, 1, { signal: abort.signal, micDeviceId: 'mic' });
    if (completion === 'ack') await expect(result).resolves.toMatchObject({ evidence: { pass: true } });
    else await expect(result).rejects.toThrow(completion === 'cancelled' ? 'cancelled' : 'sensor failed');
    expect(sent).toEqual([0, 55]);
  });

  it('does not probe if the current volume cannot be read', async () => {
    const s = setup();
    await expect(verifyOnce({ dispatcher: s.dispatcher, sam: {} as Sam, readVolume: async () => undefined }, s.target, driver, volume, 1, {})).rejects.toThrow('snapshot volume');
    expect(s.exec).not.toHaveBeenCalled();
  });

  it.each(['missing snapshot', 'another executor'])('does not verify volume with %s', async (reason) => {
    const s = setup();
    const readVolume = vi.fn(async () => 55);
    const restoreVolume = vi.fn(async () => {});
    const selectedDriver = { ...driver, actions: [volume], executor: { deviceId: reason === 'another executor' ? 'remote-mac' : 'mac-local' } };
    const result = await verifyDriver({ dispatcher: s.dispatcher, sam: {} as Sam, ...(reason === 'another executor' ? { readVolume, restoreVolume } : {}) }, s.target, selectedDriver, {});
    expect(result.verification.volume).toBe('untested');
    expect(s.exec).not.toHaveBeenCalled();
    expect(readVolume).not.toHaveBeenCalled();
    expect(restoreVolume).not.toHaveBeenCalled();
  });

  it('bounds cleanup even if a restore callback never resolves', async () => {
    vi.useFakeTimers();
    const s = setup();
    const log = vi.fn();
    const restoreVolume = vi.fn(() => new Promise<void>(() => {}));
    const result = verifyOnce({ dispatcher: s.dispatcher, sam: {} as Sam, readVolume: async () => 55, restoreVolume, log }, s.target, driver, volume, 1, {});
    await vi.advanceTimersByTimeAsync(4000);
    await expect(result).resolves.toMatchObject({ evidence: { pass: true } });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('timed out'));
    expect(vi.getTimerCount()).toBe(0);
  });
});
