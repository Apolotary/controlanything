import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dispatcher } from './dispatch';

afterEach(() => vi.useRealTimers());

describe('gesture dispatch without queued writes', () => {
  it('only calls the generated encoder after authorization and does not fall back after refusal', async () => {
    const send = vi.fn(() => 1), prepareMidi = vi.fn(() => { throw Error('Retired connector'); });
    const op = { kind: 'midi' as const, msg: 'cc' as const, channel: 1, number: 50, value: 42 };
    const forbidden = new Dispatcher({ hub: { sendToDevice: send }, canExec: () => false, prepareMidi });
    expect(forbidden.fire('mac', op)).toBe(false);
    expect(prepareMidi).not.toHaveBeenCalled();
    const dispatcher = new Dispatcher({ hub: { sendToDevice: send }, prepareMidi });
    expect(dispatcher.fire('mac', op)).toBe(false);
    await expect(dispatcher.exec('mac', op)).rejects.toMatchObject({ code: 'refused' });
    expect(send).not.toHaveBeenCalled();
    expect(dispatcher.sent).toEqual([]);
  });

  it('prepares verification packets at send time and passes the generated binding and bytes', async () => {
    const send = vi.fn((_deviceId: string, _type: string, _payload: unknown) => 1);
    const generatedMidi = { connectorId: 'fresh-1', hash: 'a'.repeat(64), portId: 'exact-id', bytes: [0xb0, 50, 42] };
    const dispatcher = new Dispatcher({ hub: { sendToDevice: send }, prepareMidi: () => generatedMidi });
    const pending = dispatcher.exec('mac', { kind: 'midi', msg: 'cc', channel: 1, number: 50, value: 42 }, { port: 'OP-1 field', actionId: 'cc50:verify' });
    const payload = send.mock.calls[0]![2];
    expect(payload).toMatchObject({ port: 'exact-id', actionId: 'cc50:verify', generatedMidi });
    dispatcher.onAck({ execId: (payload as { execId: string }).execId, ok: true, sentAt: 1 });
    await expect(pending).resolves.toMatchObject({ ok: true });
    dispatcher.close();
  });

  it('does not encode queued values until their final send boundary and rejects them after revocation', async () => {
    vi.useFakeTimers();
    let allowed = true;
    const send = vi.fn(() => 1), prepareMidi = vi.fn(() => ({ connectorId: 'fresh-1', hash: 'a'.repeat(64), portId: 'o1', bytes: [0xb0, 50, 42] }));
    const dispatcher = new Dispatcher({ hub: { sendToDevice: send }, canExec: () => allowed, prepareMidi });
    const op = { kind: 'midi' as const, msg: 'cc' as const, channel: 1, number: 50, value: 42 };
    for (let i = 0; i < 50; i++) dispatcher.fire('mac', op);
    expect(prepareMidi).toHaveBeenCalledTimes(50);
    expect(dispatcher.fire('mac', op)).toBe(true);
    expect(prepareMidi).toHaveBeenCalledTimes(50);
    allowed = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(50);
    expect(prepareMidi).toHaveBeenCalledTimes(50);
    dispatcher.close();
  });

  it('drops an exhausted MIDI bucket and never sends the value after release', async () => {
    vi.useFakeTimers();
    const send = vi.fn(() => 1);
    const dispatcher = new Dispatcher({ hub: { sendToDevice: send } });
    const op = { kind: 'midi' as const, msg: 'cc' as const, channel: 1, number: 52, value: 64 };
    for (let i = 0; i < 50; i++) expect(dispatcher.fire('mac', op, { dropIfLimited: true })).toBe(true);
    const result = vi.fn();
    expect(dispatcher.fire('mac', { ...op, value: 127 }, { dropIfLimited: true, onResult: result })).toBe(false);
    expect(result).toHaveBeenCalledExactlyOnceWith(false, 'Rate limited');
    expect(send).toHaveBeenCalledTimes(50);
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(50);
    expect(dispatcher.fire('mac', op, { dropIfLimited: true })).toBe(true);
    expect(send).toHaveBeenCalledTimes(51);
    dispatcher.flushQueued();
  });

  it('preserves ordinary control coalescing', async () => {
    vi.useFakeTimers();
    const send = vi.fn(() => 1);
    const dispatcher = new Dispatcher({ hub: { sendToDevice: send } });
    const op = { kind: 'midi' as const, msg: 'cc' as const, channel: 1, number: 52, value: 64 };
    for (let i = 0; i < 50; i++) dispatcher.fire('mac', op);
    expect(dispatcher.fire('mac', { ...op, value: 127 })).toBe(true);
    expect(send).toHaveBeenCalledTimes(50);
    await vi.advanceTimersByTimeAsync(10);
    expect(send).toHaveBeenCalledTimes(51);
    dispatcher.flushQueued();
  });
});
