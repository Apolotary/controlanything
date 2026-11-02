import type { Driver, ExecOp, PayloadOf, UiSpecPayload } from '@ce/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArmService } from './arm';
import { ControlRouter } from './control';
import { Dispatcher } from './dispatch';
import { MacLocalExecutor } from './maclocal';
import { StepLog } from './steps';
import { TargetStore } from './targets';

class FakeHub {
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

const ir: ExecOp = { kind: 'ir', protocol: 'NEC', bytes: [1, 2, 3, 4] };
const driver: Driver = {
  driverId: 'driver-light', cardId: 'light', transport: 'ir', executor: { deviceId: 'remote' }, provenance: [],
  actions: [
    { actionId: 'on', label: 'On', kind: 'trigger', encode: ir, inverseActionId: 'off' },
    { actionId: 'off', label: 'Off', kind: 'trigger', encode: ir },
    { actionId: 'level', label: 'Level', kind: 'set', range: { min: 0, max: 100 }, encode: { kind: 'step', upActionId: 'on', downActionId: 'off', steps: 10, settleMs: 400 } },
  ],
};
const spec: UiSpecPayload = {
  specId: 'spec-light', cardId: 'light', rev: 1,
  hackset: {
    spec: 'ce.hackset/1', device: { id: 'light', name: 'Light', channel: { type: 'ir', via: 'remote' } },
    hacks: [
      { id: 'on', name: 'On', kind: 'action', commands: [{ action: 'on' }], oracle: { type: 'camera', expect: 'on' }, max_rate_hz: 10 },
      { id: 'later', name: 'Later', kind: 'action', commands: [{ action: 'on', delayMs: 100 }], oracle: { type: 'camera', expect: 'on' }, max_rate_hz: 10 },
      { id: 'level', name: 'Level', kind: 'control', commands: [{ action: 'level', param: 'p' }], params: [{ id: 'p', name: 'Level', min: 0, max: 100 }], control: { archetype: 'ring', param: 'p' }, oracle: { type: 'camera', expect: 'luminance_tracks_param' }, max_rate_hz: 3 },
    ],
  },
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('execution authorization', () => {
  it('rejects both network and local execution before sending or running anything', async () => {
    const hub = new FakeHub();
    const run = vi.fn(async () => 'done');
    const canExec = vi.fn(() => false);
    const dispatcher = new Dispatcher({ hub, macLocal: new MacLocalExecutor(run, true), canExec });
    await expect(dispatcher.exec('remote', ir, { cardId: 'light', driverId: 'driver-light', actionId: 'on', port: 'port-1' })).rejects.toMatchObject({ code: 'refused' });
    await expect(dispatcher.exec('mac-local', { kind: 'local', op: 'volume', arg: 0 })).rejects.toMatchObject({ code: 'refused' });
    expect(dispatcher.fire('remote', ir)).toBe(false);
    expect(dispatcher.fire('mac-local', { kind: 'local', op: 'volume', arg: 0 })).toBe(false);
    expect(canExec).toHaveBeenCalledWith(expect.objectContaining({ executorDeviceId: 'remote', cardId: 'light', driverId: 'driver-light', actionId: 'on', port: 'port-1', op: ir }));
    expect(run).not.toHaveBeenCalled();
    expect(hub.sent).toEqual([]);
    expect(dispatcher.sent).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rechecks an operation after waiting for a rate-limit slot', async () => {
    const hub = new FakeHub();
    let allowed = true;
    const dispatcher = new Dispatcher({ hub, canExec: () => allowed });
    dispatcher.fire('remote', ir, { cardId: 'light' });
    const pending = dispatcher.exec('remote', ir, { cardId: 'light', waitForSlot: true });
    const refused = expect(pending).rejects.toMatchObject({ code: 'refused' });
    allowed = false;
    await vi.advanceTimersByTimeAsync(500);
    await refused;
    expect(hub.of('exec.command')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops trailing controls when authorization changes while they are queued', async () => {
    const hub = new FakeHub();
    let allowed = true;
    const dispatcher = new Dispatcher({ hub, canExec: () => allowed });
    expect(dispatcher.fire('remote', ir, { cardId: 'light' })).toBe(true);
    expect(dispatcher.fire('remote', ir, { cardId: 'light' })).toBe(true);
    allowed = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(hub.of('exec.command')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

function controls() {
  const hub = new FakeHub();
  const targets = new TargetStore(hub);
  const steps = new StepLog(hub);
  const target = targets.create({ cardId: 'light', driver, specId: spec.specId, armed: true, verification: { on: 'pass', off: 'pass', level: 'pass' } });
  const policy = { allowed: true };
  const dispatcher = new Dispatcher({ hub });
  const onRoomHack = vi.fn(() => ({ ok: true, fired: 0, ms: 0 }));
  const router = new ControlRouter({ hub, targets, steps, dispatcher, specs: { list: () => [spec], get: () => spec }, canControl: () => policy.allowed, onRoomHack });
  return { hub, targets, steps, target, policy, dispatcher, router, onRoomHack };
}

describe('control policy', () => {
  it('rejects controls, named actions, undo and room actions after permission changes', () => {
    const { hub, target, policy, router, onRoomHack } = controls();
    expect(router.runHack(target, 'on').fired).toBe(1);
    policy.allowed = false;
    expect(router.onControlEvent({ widgetId: 'on', value: true, ts: 1 })).toMatchObject({ ok: false, fired: 0 });
    expect(router.runHack(target, 'on')).toMatchObject({ ok: false, fired: 0 });
    expect(router.undo(target)).toMatchObject({ ok: false, fired: 0 });
    const roomSpec = { ...spec, hackset: { ...spec.hackset!, hacks: [{ ...spec.hackset!.hacks[0], commands: [{ action: 'on', cardId: 'other' }] }] } };
    vi.spyOn(router, 'resolve').mockReturnValue({ target, spec: roomSpec, hack: roomSpec.hackset.hacks[0], driver });
    expect(router.onControlEvent({ widgetId: 'on', value: true, ts: 1 })).toMatchObject({ ok: false, fired: 0 });
    expect(onRoomHack).not.toHaveBeenCalled();
    expect(hub.of('exec.command')).toHaveLength(1);
  });

  it.each(['later', 'level'])('stops scheduled %s operations when authorization changes', async (hackId) => {
    const { hub, target, policy, router } = controls();
    expect(router.runHack(target, hackId, 100).ok).toBe(true);
    const sent = hub.of('exec.command').length;
    policy.allowed = false;
    await vi.advanceTimersByTimeAsync(3000);
    expect(hub.of('exec.command')).toHaveLength(sent);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains arm approval when suspending while removing delayed, repeated and queued writes', async () => {
    const { hub, target, router, dispatcher } = controls();
    router.runHack(target, 'later');
    router.runHack(target, 'level', 100);
    dispatcher.fire('remote', ir, { cardId: target.cardId, lightCap: true, actionId: 'off' });
    const sent = hub.of('exec.command').length;
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    router.cancel(target, { preserveArmed: true });
    expect(target.armed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(hub.of('exec.command')).toHaveLength(sent);
    expect(router.undo(target)).toMatchObject({ ok: false, reason: 'nothing to undo' });
    expect(router.runHack(target, 'on')).toMatchObject({ ok: true, fired: 1 });
  });

  it('sends an allowed MIDI stop before disarming, even when its rate budget is exhausted', () => {
    const { hub, targets, steps, target, policy } = controls();
    target.driver = { ...driver, transport: 'midi' };
    const dispatcher = new Dispatcher({ hub, canExec: () => target.armed && policy.allowed });
    const router = new ControlRouter({ hub, targets, steps, dispatcher, specs: { list: () => [spec], get: () => spec }, canControl: () => target.armed && policy.allowed });
    for (let i = 0; i < 50; i++) dispatcher.fire('remote', { kind: 'midi', msg: 'cc', channel: 1, number: 1, value: 1 });
    expect(router.panic().sent).toBe(1);
    expect(target.armed).toBe(false);
    expect(hub.of<PayloadOf<'exec.command'>>('exec.command').at(-1)?.op).toMatchObject({ kind: 'midi', msg: 'panic' });
    expect(vi.getTimerCount()).toBe(0);
    expect(router.panic().sent).toBe(0);
  });
});

describe('arm policy', () => {
  it('refuses requests and rechecks authorization when confirmation arrives', async () => {
    const { hub, targets, steps, target, policy } = controls();
    target.armed = false;
    const arm = new ArmService({ hub, targets, steps, canArm: () => policy.allowed });
    policy.allowed = false;
    await expect(arm.request(target, driver)).resolves.toMatchObject({ armed: false, reason: /not authorized/ });
    expect(hub.of('arm.request')).toEqual([]);
    policy.allowed = true;
    const pending = arm.request(target, { ...driver, actions: [{ ...driver.actions[0], confirm: 'hold' }] });
    const request = hub.of<PayloadOf<'arm.request'>>('arm.request')[0]!;
    policy.allowed = false;
    expect(arm.onConfirm({ armId: request.armId, approve: true }, { canApprove: true })).toBe(true);
    await expect(pending).resolves.toMatchObject({ armed: false, reason: /not authorized/ });
    expect(arm.pendingIds()).toEqual([]);
    expect(target.armed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
