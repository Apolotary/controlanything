import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dispatcher } from './dispatch';

afterEach(() => vi.useRealTimers());

describe('gesture dispatch without queued writes', () => {
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
