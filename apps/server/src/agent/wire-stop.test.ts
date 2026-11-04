import { describe, expect, it, vi } from 'vitest';
import type { Driver, ExecCommandPayload, ExecOp } from '@ce/protocol';
import { musicalSynthDraft } from '../devices/musicalSynth';
import { extendWithTouch, visualSynthDraft } from '../devices/visualSynth';
import { Dispatcher } from './dispatch';
import type { Target } from './types';
import { heldWireRelease, releaseWireOutputs } from './wire-stop';

const driver: Driver = { ...musicalSynthDraft('music', []), driverId: 'd', executor: { deviceId: 'mac', port: 'ce-musical-synth' } };
const target = (): Target => ({ cardId: 'music', driver, armed: true, verification: { cc17: 'pass' }, state: 'armed', runId: 'r', since: 0, evidence: [], stepIndex: {}, paramValues: {} } as Target);

describe('wire-only neutral release', () => {
  it('clears queued outputs, sends only gate zero, and retains verified device approval', async () => {
    const t = target(); const order: string[] = [];
    const cancelQueued = vi.fn(() => { order.push('cancel'); });
    const exec = vi.fn(async () => { order.push('release'); return { execId: 'release', ok: true, sentAt: 0 }; });
    expect(await releaseWireOutputs(t, { cancelQueued, dispatcher: { exec } as unknown as Dispatcher })).toEqual({ released: true });
    expect(order).toEqual(['cancel', 'release']); expect(t.armed).toBe(true); expect(t.verification.cc17).toBe('pass');
    expect(exec).toHaveBeenCalledWith('mac', { kind: 'midi', msg: 'cc', channel: 1, number: 17, value: 0 }, expect.objectContaining({ port: 'ce-musical-synth', actionId: 'cc17', priorityRelease: true }));
  });
  it('lifts visual pressure and never invents physical MIDI neutral controls', () => {
    const visual: Driver = { ...visualSynthDraft('visual', []), driverId: 'v', executor: { deviceId: 'mac', port: 'ce-visual-synth' } };
    expect(heldWireRelease(extendWithTouch(visual).driver, { cc24: 'pass' })).toMatchObject({ op: { number: 24, value: 0 } });
    expect(heldWireRelease({ ...driver, executor: { deviceId: 'mac', port: 'OP-1 Field' } }, { cc17: 'pass' })).toBeUndefined();
    expect(heldWireRelease(driver, {})).toMatchObject({ op: { number: 17, value: 0 } });
  });
  it('priority zero-release survives saturation while nonneutral or unauthorized ops remain refused', async () => {
    vi.useFakeTimers();
    let dispatcher!: Dispatcher;
    const hub = { sendToDevice: vi.fn((_id: string, _type: string, command: ExecCommandPayload) => {
      queueMicrotask(() => dispatcher.onAck({ execId: command.execId, ok: true, sentAt: 0 })); return 1;
    }) };
    let authorized = true;
    dispatcher = new Dispatcher({ hub: hub as never, now: () => 0, canExec: () => authorized });
    const op: ExecOp = { kind: 'midi', msg: 'cc', channel: 1, number: 17, value: 0 };
    try {
      for (let i = 0; i < 50; i++) dispatcher.fire('mac', { ...op, value: 127 }, { dropIfLimited: true });
      const release = dispatcher.exec('mac', op, { port: 'ce-musical-synth', priorityRelease: true });
      await vi.runAllTicks(); expect((await release).ok).toBe(true);
      await expect(dispatcher.exec('mac', { ...op, value: 1 }, { port: 'ce-musical-synth', priorityRelease: true })).rejects.toMatchObject({ code: 'rate_limited' });
      authorized = false;
      await expect(dispatcher.exec('mac', op, { port: 'ce-musical-synth', priorityRelease: true })).rejects.toMatchObject({ code: 'refused' });
    } finally { dispatcher.close(); vi.useRealTimers(); }
  });
  it('refuses a delayed old restore even when a new verification authorizes the same action', async () => {
    vi.useFakeTimers();
    let dispatcher!: Dispatcher, now = 0;
    let verifying = new Set(['cc16']); const original = verifying;
    const hub = { sendToDevice: vi.fn((_id: string, _type: string, command: ExecCommandPayload) => {
      queueMicrotask(() => dispatcher.onAck({ execId: command.execId, ok: true, sentAt: now })); return 1;
    }) };
    dispatcher = new Dispatcher({ hub: hub as never, now: () => now,
      canExec: request => !!request.actionId && verifying.has(request.actionId.split(':')[0]!) });
    const op: ExecOp = { kind: 'midi', msg: 'cc', channel: 1, number: 16, value: 7 };
    try {
      for (let i = 0; i < 50; i++) dispatcher.fire('mac', op, { actionId: 'cc16', dropIfLimited: true });
      const restoring = dispatcher.exec('mac', op, { port: 'ce-musical-synth', actionId: 'cc16:restore-parameter',
        waitForSlot: true, stillCurrent: () => verifying === original });
      const refused = expect(restoring).rejects.toMatchObject({ code: 'refused', message: 'Operation was superseded' });
      verifying = new Set(['cc16']); // Stop/Ask again; the same action ID belongs to a new request.
      now = 10; await vi.advanceTimersByTimeAsync(10); await refused;
      expect(hub.sendToDevice).toHaveBeenCalledTimes(50);
      const current = dispatcher.exec('mac', { ...op, value: 9 }, { actionId: 'cc16' });
      await vi.runAllTicks(); expect((await current).ok).toBe(true);
      expect(hub.sendToDevice).toHaveBeenCalledTimes(51);
    } finally { dispatcher.close(); vi.useRealTimers(); }
  });
});
