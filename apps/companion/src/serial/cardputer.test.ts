import { afterEach, describe, expect, it, vi } from 'vitest';
import { CardputerLink } from './cardputer';

afterEach(() => vi.useRealTimers());

describe('queued serial IR', () => {
  it.each(['panic', 'disconnect'])('drops queued frames, including a spacing wait, after %s', async (stop) => {
    vi.useFakeTimers();
    const sent: { t: string; id: string }[] = [];
    const link = new CardputerLink('test');
    const incoming = link as unknown as { onIncoming(line: string): void };
    Object.assign(link, {
      state: 'ready',
      writer: {
        write: async (bytes: Uint8Array) => {
          const command = JSON.parse(new TextDecoder().decode(bytes));
          sent.push(command);
          incoming.onIncoming(JSON.stringify({ t: 'ack', id: command.id, ok: true }));
        },
        releaseLock: () => {},
      },
    });
    const raw = { khz: 38, us: [9000, 4500], repeats: 0, gapMs: 40, label: 'test' };
    expect((await link.sendIr(raw)).ok).toBe(true);
    const waiting = link.sendIr(raw);
    const queued = link.sendIr(raw);
    await Promise.resolve();
    if (stop === 'panic') await link.request({ t: 'panic' });
    else await link.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await waiting).toMatchObject({ ok: false, err: 'cancelled' });
    expect(await queued).toMatchObject({ ok: false, err: 'cancelled' });
    expect(sent.map((command) => command.t)).toEqual(stop === 'panic' ? ['ir', 'panic'] : ['ir']);
  });
});
