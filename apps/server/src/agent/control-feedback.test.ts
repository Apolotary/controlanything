import { parseMessage, type ControlEventPayload, type Driver, type ExecOp, type PayloadOf, type UiSpecPayload } from '@ce/protocol';
import { emptySpec } from '@ce/gen3d';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlRouter } from './control';
import { Dispatcher } from './dispatch';
import type { MacLocalExecutor } from './maclocal';
import { StepLog } from './steps';
import { TargetStore } from './targets';
import { Hub } from '../hub';

const midi: ExecOp = { kind: 'midi', msg: 'cc', channel: 1, number: 74, value: 64 };
const ir: ExecOp = { kind: 'ir', protocol: 'NEC', bytes: [1, 2, 3, 4] };

function network() {
  const commands: PayloadOf<'exec.command'>[] = [];
  const hub = {
    broadcast: vi.fn(() => 1),
    sendToDevice: vi.fn((_to: string, type: string, payload: unknown) => {
      if (type === 'exec.command') commands.push(payload as PayloadOf<'exec.command'>);
      return 1;
    }),
  };
  const dispatcher = new Dispatcher({ hub, ackTimeoutMs: 1000 });
  const acknowledge = (index: number, ok = true) => dispatcher.onAck({ execId: commands[index]!.execId, ok, sentAt: Date.now(), detail: ok ? 'Applied' : 'Device refused' });
  return { commands, hub, dispatcher, acknowledge };
}

function controls() {
  const n = network();
  const driver: Driver = {
    driverId: 'driver', cardId: 'device', transport: 'midi', executor: { deviceId: 'mac' }, provenance: [],
    actions: [
      { actionId: 'up', label: 'Up', kind: 'trigger', encode: midi },
      { actionId: 'down', label: 'Down', kind: 'trigger', encode: midi },
      { actionId: 'level', label: 'Level', kind: 'set', range: { min: 0, max: 100 }, encode: { kind: 'step', upActionId: 'up', downActionId: 'down', steps: 10, settleMs: 400 } },
    ],
  };
  const base = { name: 'Control', oracle: { type: 'wire' as const, expect: 'serial_ack' as const }, max_rate_hz: 5 };
  const spec: UiSpecPayload = {
    specId: 'spec', cardId: 'device', rev: 1,
    hackset: { spec: 'ce.hackset/1', device: { id: 'device', name: 'Device', channel: { type: 'midi', via: 'mac' } }, hacks: [
      { ...base, id: 'up', kind: 'action', commands: [{ action: 'up' }] },
      { ...base, id: 'pair', kind: 'action', commands: [{ action: 'up' }, { action: 'down', delayMs: 300 }] },
      { ...base, id: 'level', kind: 'control', commands: [{ action: 'level', param: 'p' }], params: [{ id: 'p', name: 'Level', min: 0, max: 100 }] },
    ] },
  };
  const targets = new TargetStore(n.hub);
  const target = targets.create({ cardId: 'device', specId: 'spec', driver, armed: true, verification: { up: 'pass', down: 'pass', level: 'pass' } });
  target.stepIndex.level = 5;
  const onResult = vi.fn();
  const router = new ControlRouter({ hub: n.hub, dispatcher: n.dispatcher, targets, steps: new StepLog(n.hub), specs: { get: () => spec, list: () => [spec] }, onResult });
  const send = (widgetId: string, value: number | boolean = true, ts = 123, phase: ControlEventPayload['phase'] = 'end') => router.onControlEvent({ specId: 'spec', widgetId, value, ts, phase }, 'quest');
  return { ...n, router, target, spec, onResult, send };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('dispatcher command feedback', () => {
  it('waits for the executor ack and reports failure only once', async () => {
    const n = network(), result = vi.fn();
    expect(n.dispatcher.fire('mac', midi, { onResult: result })).toBe(true);
    expect(result).not.toHaveBeenCalled();
    n.acknowledge(0, false);
    expect(result).toHaveBeenCalledExactlyOnceWith(false, 'Device refused');
    expect(n.acknowledge(0)).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(result).toHaveBeenCalledTimes(1);
  });

  it('reports timeout, offline and authorization rejection', async () => {
    const n = network(), timeout = vi.fn(), offline = vi.fn(), refused = vi.fn();
    n.dispatcher.fire('mac', midi, { onResult: timeout });
    await vi.advanceTimersByTimeAsync(1000);
    expect(timeout).toHaveBeenCalledExactlyOnceWith(false, 'Executor did not respond');
    n.hub.sendToDevice.mockReturnValue(0);
    expect(n.dispatcher.fire('mac', midi, { onResult: offline })).toBe(false);
    expect(offline).toHaveBeenCalledExactlyOnceWith(false, 'Executor is offline');
    const guarded = new Dispatcher({ hub: n.hub, canExec: () => false });
    expect(guarded.fire('mac', midi, { onResult: refused })).toBe(false);
    expect(refused).toHaveBeenCalledExactlyOnceWith(false, 'Control is no longer authorized');
  });

  it('preserves the final callback through coalescing and cancels replaced or flushed work', async () => {
    const n = network(), first = vi.fn(), replaced = vi.fn(), latest = vi.fn(), cancelled = vi.fn();
    n.dispatcher.fire('bridge', ir, { cardId: 'lamp', actionId: 'power', onResult: first });
    n.dispatcher.fire('bridge', ir, { cardId: 'lamp', actionId: 'power', onResult: replaced });
    n.dispatcher.fire('bridge', ir, { cardId: 'lamp', actionId: 'power', onResult: latest });
    expect(replaced).toHaveBeenCalledExactlyOnceWith(false, 'Superseded by a newer command');
    n.acknowledge(0);
    await vi.advanceTimersByTimeAsync(250);
    expect(latest).not.toHaveBeenCalled();
    n.acknowledge(1);
    expect(latest).toHaveBeenCalledExactlyOnceWith(true, 'Applied');
    n.dispatcher.fire('bridge', ir, { cardId: 'lamp', actionId: 'power', onResult: cancelled });
    n.dispatcher.flushQueued('lamp');
    expect(cancelled).toHaveBeenCalledExactlyOnceWith(false, 'Command cancelled');
  });

  it('waits for the local executor result without executing any real system command', async () => {
    const n = network(), result = vi.fn();
    let complete!: (result: { ok: boolean; detail: string }) => void;
    const macLocal = { exec: vi.fn(() => new Promise((resolve) => { complete = resolve; })) } as unknown as MacLocalExecutor;
    const dispatcher = new Dispatcher({ hub: n.hub, macLocal });
    dispatcher.fire('mac-local', { kind: 'local', op: 'screen', arg: 50 }, { onResult: result });
    expect(result).not.toHaveBeenCalled();
    complete({ ok: true, detail: 'Applied' });
    await Promise.resolve();
    expect(result).toHaveBeenCalledExactlyOnceWith(true, 'Applied');
    expect(n.commands).toHaveLength(0);
  });
});

describe('control event result correlation', () => {
  it('uses the real Hub envelope to send only to the originating device as server', () => {
    const hub = Object.create(Hub.prototype) as Hub;
    const wire: string[] = [];
    Object.assign(hub, {
      authed: () => [{ deviceId: 'quest' }, { deviceId: 'other' }],
      sendRaw: (_connection: unknown, json: string) => { wire.push(json); return true; },
    });
    expect(hub.sendToDevice('quest', 'control.result', { specId: 'spec', widgetId: 'up', ts: 123, ok: true })).toBe(1);
    expect(wire).toHaveLength(1);
    expect(parseMessage(wire[0])).toMatchObject({ ok: true, message: { from: 'server', to: 'quest', type: 'control.result', payload: { ts: 123 } } });
  });
  it('ignores gesture start and returns an actual ack to only the origin with its event timestamp', () => {
    const c = controls();
    c.send('up', true, 10, 'start');
    expect(c.commands).toHaveLength(0);
    expect(c.onResult).not.toHaveBeenCalled();
    c.send('up', true, 11);
    expect(c.onResult).not.toHaveBeenCalled();
    c.acknowledge(0);
    expect(c.onResult).toHaveBeenCalledExactlyOnceWith({ specId: 'spec', widgetId: 'up', ts: 11, ok: true, detail: 'Applied' }, 'quest');
  });

  it('waits for delayed operations and every ack before reporting success', async () => {
    const c = controls();
    c.send('pair');
    c.acknowledge(0);
    expect(c.onResult).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(c.commands).toHaveLength(2);
    expect(c.onResult).not.toHaveBeenCalled();
    c.acknowledge(1);
    expect(c.onResult).toHaveBeenCalledTimes(1);
    expect(c.onResult.mock.calls[0]![0]).toMatchObject({ widgetId: 'pair', ts: 123, ok: true });
  });

  it('keeps step composites pending after the first ack', async () => {
    const c = controls();
    c.send('level', 80);
    c.acknowledge(0);
    expect(c.onResult).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(c.commands).toHaveLength(2);
    expect(c.onResult).not.toHaveBeenCalled();
    c.acknowledge(1);
    expect(c.onResult).toHaveBeenCalledTimes(1);
    expect(c.onResult.mock.calls[0]![0]).toMatchObject({ widgetId: 'level', ok: true });
  });

  it('retries only unacknowledged steps after a partial failure', async () => {
    const c = controls();
    c.target.paramValues.p = 50;
    c.send('level', 80);
    expect(c.target.stepIndex.level).toBe(5);
    c.acknowledge(0, false);
    expect(c.target.paramValues.p).toBe(50);
    await vi.advanceTimersByTimeAsync(400);
    c.acknowledge(1);
    expect(c.target.stepIndex.level).toBe(6);
    c.send('level', 80, 456);
    expect(c.commands).toHaveLength(3);
    c.acknowledge(2);
    expect(c.target.stepIndex.level).toBe(7);
    expect(c.onResult.mock.calls[1]![0]).toMatchObject({ ts: 456, ok: true });
  });

  it('tracks fallback stepper values only after acknowledgements so Retry still sends', async () => {
    const c = controls();
    c.spec.gen3d = { ...emptySpec('generated'), controls: [{ id: 'level', kind: 'stepped', label: 'Level', binding: { action: 'midi.cc', args: { drive: 'stepper' } } }] };
    const hack = c.spec.hackset!.hacks[2]!;
    hack.commands = [{ action: 'up' }, { action: 'down' }];
    hack.params![0]!.step = 10;
    c.target.paramValues.p = 50;
    c.send('level', 70);
    expect(c.target.paramValues.p).toBe(50);
    c.acknowledge(0, false);
    await vi.advanceTimersByTimeAsync(400);
    c.acknowledge(1);
    expect(c.target.paramValues.p).toBe(60);
    c.send('level', 70, 456);
    expect(c.commands).toHaveLength(3);
    c.acknowledge(2);
    expect(c.target.paramValues.p).toBe(70);
    expect(c.onResult.mock.calls[1]![0]).toMatchObject({ ts: 456, ok: true });
  });

  it('fails a rejected operation once even if another operation later succeeds', async () => {
    const c = controls();
    c.send('pair');
    c.acknowledge(0, false);
    expect(c.onResult.mock.calls[0]![0]).toMatchObject({ ok: false, detail: 'Device refused' });
    await vi.advanceTimersByTimeAsync(300);
    c.acknowledge(1);
    expect(c.onResult).toHaveBeenCalledTimes(1);
  });

  it('fails cancelled delayed work and rejected controls without claiming a send succeeded', async () => {
    const c = controls();
    c.send('pair'); c.acknowledge(0);
    c.router.cancel(c.target);
    expect(c.onResult.mock.calls[0]![0]).toMatchObject({ ok: false, detail: 'Command cancelled' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.commands).toHaveLength(1);
    c.send('up', true, 456);
    expect(c.onResult.mock.calls[1]![0]).toMatchObject({ ts: 456, ok: false, detail: 'not armed' });
  });
});
