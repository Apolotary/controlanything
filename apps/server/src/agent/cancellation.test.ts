import { getEventListeners } from 'node:events';
import { ceilingDimmer } from '@ce/gen3d';
import type { Driver, ExecOp, PayloadOf, UiSpecPayload } from '@ce/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArmService } from './arm';
import { ControlRouter } from './control';
import { Dispatcher, IR_CAPTURE_GRACE_MS } from './dispatch';
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
  actions: [{ actionId: 'off', label: 'Off', kind: 'trigger', encode: ir }],
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('dispatcher cancellation cleanup', () => {
  it('never dispatches commands or sensor requests for a pre-aborted signal', async () => {
    const hub = new FakeHub();
    const dispatcher = new Dispatcher({ hub });
    const abort = new AbortController();
    abort.abort();
    await expect(dispatcher.exec('remote', ir, { signal: abort.signal })).rejects.toThrow('cancelled');
    await expect(dispatcher.sense('camera', 'frame', { signal: abort.signal })).rejects.toThrow('cancelled');
    expect(hub.sent).toEqual([]);
    expect(dispatcher.sent).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
  });

  it('cancels a rate-limit wait without sending an operation later', async () => {
    const hub = new FakeHub();
    const dispatcher = new Dispatcher({ hub });
    dispatcher.fire('remote', ir);
    const abort = new AbortController();
    const pending = dispatcher.exec('remote', ir, { waitForSlot: true, signal: abort.signal });
    const rejected = expect(pending).rejects.toThrow('cancelled');
    expect(vi.getTimerCount()).toBe(1);
    abort.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(hub.of('exec.command')).toHaveLength(1);
  });

  it('removes ACK timers and listeners on abort and rejects late replies', async () => {
    const hub = new FakeHub();
    const dispatcher = new Dispatcher({ hub });
    const abort = new AbortController();
    const pending = dispatcher.exec('remote', ir, { signal: abort.signal });
    const rejected = expect(pending).rejects.toThrow('cancelled');
    const command = hub.of<PayloadOf<'exec.command'>>('exec.command')[0]!;
    abort.abort();
    await rejected;
    expect(dispatcher.onAck({ execId: command.execId, ok: true, sentAt: 1 })).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
  });

  it.each(['ack', 'timeout'] as const)('removes the ACK abort listener on %s', async (completion) => {
    const hub = new FakeHub();
    const dispatcher = new Dispatcher({ hub, ackTimeoutMs: 100 });
    const abort = new AbortController();
    const pending = dispatcher.exec('remote', ir, { signal: abort.signal });
    const command = hub.of<PayloadOf<'exec.command'>>('exec.command')[0]!;
    if (completion === 'ack') {
      dispatcher.onAck({ execId: command.execId, ok: true, sentAt: 1 });
      await expect(pending).resolves.toMatchObject({ ok: true });
    } else {
      const rejected = expect(pending).rejects.toThrow('no exec.ack');
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
    }
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
  });

  it('clears both IR collection timers when aborted after the first press', async () => {
    const hub = new FakeHub();
    const dispatcher = new Dispatcher({ hub });
    const abort = new AbortController();
    const pending = dispatcher.sense('remote', 'ir-capture', { signal: abort.signal });
    const rejected = expect(pending).rejects.toThrow('cancelled');
    const senseId = dispatcher.pendingSenseIds()[0]!;
    dispatcher.onSense({ senseId, kind: 'ir-capture', ir: { rawUs: [9000, 4500] }, at: 1 });
    expect(vi.getTimerCount()).toBe(2);
    abort.abort();
    await rejected;
    expect(dispatcher.pendingSenseIds()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
    expect(dispatcher.onSense({ senseId, kind: 'ir-capture', at: 2 })).toBe(false);
    expect(dispatcher.unhealthy('remote')).toBe(false);
  });

  it.each(['result', 'timeout', 'grace', 'collection timeout'] as const)('cleans sensor listeners after %s', async (completion) => {
    const dispatcher = new Dispatcher({ hub: new FakeHub() });
    const abort = new AbortController();
    const collect = completion === 'grace' || completion === 'collection timeout';
    const kind = collect ? 'ir-capture' : 'frame';
    const pending = dispatcher.sense('sensor', kind, { signal: abort.signal, timeoutMs: completion === 'grace' ? 5000 : 100 });
    const senseId = dispatcher.pendingSenseIds()[0]!;
    if (completion === 'result' || completion === 'grace') {
      dispatcher.onSense({ senseId, kind, at: 1 });
      if (collect) await vi.advanceTimersByTimeAsync(IR_CAPTURE_GRACE_MS);
      await expect(pending).resolves.toHaveLength(1);
    } else if (completion === 'timeout') {
      const rejected = expect(pending).rejects.toThrow('no sense.result');
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
    } else {
      dispatcher.onSense({ senseId, kind, at: 1 });
      await vi.advanceTimersByTimeAsync(100);
      await expect(pending).resolves.toHaveLength(1);
    }
    expect(dispatcher.pendingSenseIds()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
  });

  it('closing clears ACK, sensor and rate wait timers and listeners', async () => {
    const dispatcher = new Dispatcher({ hub: new FakeHub() });
    const abort = new AbortController();
    const ack = dispatcher.exec('remote', ir, { signal: abort.signal });
    const ackRejected = expect(ack).rejects.toThrow('server closing');
    const waiting = dispatcher.exec('remote', ir, { signal: abort.signal, waitForSlot: true });
    const waitRejected = expect(waiting).rejects.toThrow('cancelled');
    const sensing = dispatcher.sense('camera', 'frame', { signal: abort.signal });
    dispatcher.close();
    await Promise.all([ackRejected, waitRejected, expect(sensing).resolves.toEqual([])]);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
  });

  it('flushes only the chosen target when targets share an executor and action name', async () => {
    const hub = new FakeHub();
    const dispatcher = new Dispatcher({ hub });
    dispatcher.fire('remote', ir, { cardId: 'first', actionId: 'off' });
    dispatcher.fire('remote', ir, { cardId: 'first', actionId: 'off' });
    dispatcher.fire('remote', ir, { cardId: 'second', actionId: 'off' });
    expect(vi.getTimerCount()).toBe(2);
    expect(dispatcher.flushQueued('first')).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    const commands = hub.of<PayloadOf<'exec.command'>>('exec.command');
    expect(commands.map((command) => command.cardId)).toEqual(['first', 'second']);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('confirmation cancellation cleanup', () => {
  function setup() {
    const hub = new FakeHub();
    const targets = new TargetStore(hub);
    const target = targets.create({ cardId: 'light', driver, specId: 'light-controls' });
    const arm = new ArmService({ hub, targets, steps: new StepLog(hub), timeoutMs: 100 });
    return { hub, targets, target, arm };
  }

  it('never requests confirmation when already cancelled', async () => {
    const { hub, target, arm } = setup();
    const abort = new AbortController();
    abort.abort();
    await expect(arm.request(target, driver, undefined, abort.signal)).resolves.toMatchObject({ armed: false, reason: 'cancelled' });
    expect(hub.sent).toEqual([]);
    expect(arm.pendingIds()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['signal', 'cancel', 'close'] as const)('removes confirmation on %s and refuses late approval', async (method) => {
    const { target, arm } = setup();
    const abort = new AbortController();
    const pending = arm.request(target, driver, undefined, abort.signal);
    const armId = arm.pendingIds()[0]!;
    if (method === 'signal') abort.abort();
    else if (method === 'cancel') expect(arm.cancel(target)).toBe(true);
    else arm.close();
    await expect(pending).resolves.toMatchObject({ armed: false });
    expect(arm.onConfirm({ armId, approve: true }, { canApprove: true })).toBe(false);
    expect(target.armed).toBe(false);
    expect(target.armId).toBeUndefined();
    expect(arm.pendingIds()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
  });

  it('does not broadcast a confirmation cancelled during its state change', async () => {
    const { hub, targets, target, arm } = setup();
    const abort = new AbortController();
    targets.onChange((changed) => {
      if (changed.state === 'arming') abort.abort();
    });
    await expect(arm.request(target, driver, undefined, abort.signal)).resolves.toMatchObject({ armed: false });
    expect(hub.of('arm.request')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['approved', 'declined', 'expired'] as const)('cleans confirmation after %s and explains recovery', async (completion) => {
    const { hub, target, arm } = setup();
    const abort = new AbortController();
    const pending = arm.request(target, driver, undefined, abort.signal);
    const armId = arm.pendingIds()[0]!;
    if (completion === 'expired') await vi.advanceTimersByTimeAsync(100);
    else arm.onConfirm({ armId, approve: completion === 'approved' }, { canApprove: true });
    await expect(pending).resolves.toMatchObject({ armed: completion === 'approved' });
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
    if (completion !== 'approved') {
      expect(hub.of<PayloadOf<'target.status'>>('target.status').at(-1)).toMatchObject({ sentence: expect.any(String), hint: expect.any(String), action: 'retry' });
    }
  });

  it('replacing a confirmation cancels the old one and keeps only the new timer', async () => {
    const { target, arm } = setup();
    const abort = new AbortController();
    const oldRequest = arm.request(target, driver, undefined, abort.signal);
    const oldId = arm.pendingIds()[0]!;
    const newRequest = arm.request(target, driver);
    await expect(oldRequest).resolves.toMatchObject({ armed: false });
    expect(arm.onConfirm({ armId: oldId, approve: true }, { canApprove: true })).toBe(false);
    expect(arm.pendingIds()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
    arm.cancel(target);
    await expect(newRequest).resolves.toMatchObject({ armed: false });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('control cancellation cleanup', () => {
  function setup() {
    const hub = new FakeHub();
    const targets = new TargetStore(hub);
    const dispatcher = new Dispatcher({ hub });
    const controlDriver: Driver = {
      ...driver,
      actions: [
        ...driver.actions,
        { actionId: 'up', label: 'Brighter', kind: 'trigger', encode: ir },
        { actionId: 'down', label: 'Dimmer', kind: 'trigger', encode: ir },
        { actionId: 'level', label: 'Level', kind: 'set', range: { min: 0, max: 100 }, encode: { kind: 'step', upActionId: 'up', downActionId: 'down', steps: 10, settleMs: 334 } },
      ],
    };
    const specs: UiSpecPayload[] = ['first', 'second'].map((cardId) => ({
      specId: `spec-${cardId}`, cardId, rev: 1,
      gen3d: { ...ceilingDimmer, controls: [{ ...ceilingDimmer.controls[0]!, id: 'stepper', binding: { action: 'ir.send', args: { drive: 'stepper' } } }] },
      hackset: {
        spec: 'ce.hackset/1', device: { id: cardId, name: 'Light', channel: { type: 'ir', via: cardId } },
        hacks: [
          { id: 'delay', name: 'Delayed off', kind: 'action', commands: [{ action: 'off', delayMs: 1000 }], oracle: { type: 'camera', expect: 'off' }, max_rate_hz: 3 },
          { id: 'steps', name: 'Level', kind: 'control', params: [{ id: 'value', name: 'Level', min: 0, max: 100, default: 50, step: 10 }], control: { archetype: 'ring', param: 'value' }, commands: [{ action: 'level', param: 'value' }], oracle: { type: 'camera', expect: 'luminance_tracks_param' }, max_rate_hz: 3 },
          { id: 'stepper', name: 'Brightness', kind: 'control', params: [{ id: 'value', name: 'Brightness', min: 0, max: 100, default: 50, step: 10 }], control: { archetype: 'ring', param: 'value' }, commands: [{ action: 'up' }, { action: 'down' }], oracle: { type: 'camera', expect: 'luminance_tracks_param' }, max_rate_hz: 3 },
        ],
      },
    }));
    const [first, second] = specs.map((spec) => targets.create({
      cardId: spec.cardId!, driver: { ...controlDriver, cardId: spec.cardId!, executor: { deviceId: spec.cardId! } },
      specId: spec.specId, armed: true, verification: { off: 'pass', up: 'pass', down: 'pass', level: 'pass' },
    }));
    const router = new ControlRouter({ hub, targets, dispatcher, steps: new StepLog(hub), specs: { list: () => specs, get: (id) => specs.find((spec) => spec.specId === id) } });
    return { hub, dispatcher, router, first: first!, second: second! };
  }

  it('cancel disarms only its target and removes delayed commands, step timers and queued output', async () => {
    const { hub, dispatcher, router, first, second } = setup();
    router.runHack(first, 'delay');
    router.runHack(second, 'delay');
    router.runHack(first, 'steps', 100);
    dispatcher.fire('first', ir, { cardId: first.cardId, lightCap: true, actionId: 'off' });
    const sentBefore = hub.of('exec.command').length;
    router.cancel(first);
    expect(first.armed).toBe(false);
    expect(second.armed).toBe(true);
    expect(hub.of('exec.command')).toHaveLength(sentBefore);
    expect(vi.getTimerCount()).toBe(1);
    first.runId = 'retry';
    first.armed = true;
    await vi.advanceTimersByTimeAsync(5000);
    const commands = hub.of<PayloadOf<'exec.command'>>('exec.command');
    expect(commands.slice(sentBefore).map((command) => command.cardId)).toEqual(['second']);
    expect(router.undo(first)).toMatchObject({ ok: false, reason: 'nothing to undo' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['delay', 'steps', 'stepper'])('a %s callback cannot send on a newer armed run', async (hack) => {
    const { hub, router, first } = setup();
    expect(router.runHack(first, hack, 100).ok).toBe(true);
    const sentBefore = hub.of('exec.command').length;
    first.runId = 'another-run';
    first.armed = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(hub.of('exec.command')).toHaveLength(sentBefore);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancel removes a pending stepper and close clears delayed commands', async () => {
    const { hub, router, first, second } = setup();
    router.runHack(first, 'stepper', 100);
    router.runHack(second, 'delay');
    router.cancel(first);
    expect(vi.getTimerCount()).toBe(1);
    router.close();
    expect(vi.getTimerCount()).toBe(0);
    const sentBefore = hub.of('exec.command').length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(hub.of('exec.command')).toHaveLength(sentBefore);
  });
});
