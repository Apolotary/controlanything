import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { Connection } from '../connection';
import { CardputerBridge } from './bridge';
import type { CardputerLink } from './cardputer';

vi.mock('../api', () => ({ api: { pairStart: vi.fn(), pairStatus: vi.fn() }, ApiError: class extends Error {} }));
vi.mock('../connection', () => ({
  CLOSE_UNAUTHORIZED: 4001,
  Connection: class {
    static instances: unknown[] = [];
    static sameOrigin = () => 'ws://test.invalid/ws';
    onState?: (state: string, info?: { code: number }) => void;
    handlers = new Map<string, () => void>();
    constructor() { (this.constructor as { instances?: unknown[] }).instances?.push(this); }
    on(type: string, handler: () => void) { this.handlers.set(type, handler); }
    start() { this.onState?.('open'); }
    stop() {}
    welcome() { this.handlers.get('welcome')?.(); }
    revoke() { this.onState?.('closed', { code: 4001 }); }
  },
}));

function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const pending = (id: string) => ({ status: 'pending' as const, pairingId: id, pollSecret: 'secret', display: 'ABC-DEF', code: 'ABCDEF', qr: 'CE1:ABCDEF', expiresAt: 50_000 });
const approved = { status: 'approved' as const, deviceId: 'old-device', deviceToken: 'old-token' };

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
  vi.mocked(api.pairStart).mockImplementation(async () => pending('pair'));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Cardputer pairing identity', () => {
  it('waits for authenticated welcome and immediately withdraws approval after revocation', async () => {
    vi.mocked(api.pairStart).mockResolvedValueOnce({ ...pending('pair'), ...approved });
    const link = { ready: true, info: { chip: 'chip', caps: ['ir'] }, request: vi.fn(async () => ({ id: 'a', ok: true })) } as unknown as CardputerLink;
    const bridge = new CardputerBridge(link, 'test');
    await bridge.deviceReady();
    expect(bridge.state).toBe('connecting');
    expect(bridge.online).toBe(false);
    const conn = (Connection as unknown as { instances: { welcome(): void; revoke(): void }[] }).instances.at(-1)!;
    conn.welcome();
    expect(bridge.online).toBe(true);
    conn.revoke();
    expect(bridge.online).toBe(false);
    conn.welcome();
    expect(bridge.online).toBe(false);
  });

  it.each(['start', 'status', 'screen'])('ignores the previous chip after awaiting %s', async (stage) => {
    const request = vi.fn(async (_command: unknown) => ({ id: 'a', ok: true }));
    const link = { ready: true, info: { chip: 'old-chip', caps: ['ir'] }, request } as unknown as CardputerLink;
    const bridge = new CardputerBridge(link, 'test');
    const start = deferred<Awaited<ReturnType<typeof api.pairStart>>>();
    const status = deferred<Awaited<ReturnType<typeof api.pairStatus>>>();
    const screen = deferred<{ id: string; ok: boolean }>();
    if (stage === 'start') vi.mocked(api.pairStart).mockReturnValueOnce(start.promise);
    vi.mocked(api.pairStatus).mockReturnValueOnce(status.promise);
    const ready = bridge.deviceReady();
    if (stage !== 'start') {
      await ready;
      await vi.advanceTimersByTimeAsync(1500);
      if (stage === 'screen') {
        request.mockReturnValueOnce(screen.promise);
        status.resolve({ ...pending('pair'), ...approved });
        await Promise.resolve();
        expect(request).toHaveBeenCalledWith(expect.objectContaining({ state: 'approved' }));
      }
    }
    bridge.deviceGone();
    link.info!.chip = 'new-chip';
    await bridge.deviceReady();
    if (stage === 'start') start.resolve({ ...pending('pair'), ...approved });
    if (stage === 'status') status.resolve({ ...pending('pair'), ...approved });
    if (stage === 'screen') screen.resolve({ id: 'a', ok: true });
    await ready;
    await Promise.resolve();
    expect(bridge.stored).toBeUndefined();
    expect(bridge.state).toBe('pairing');
    expect(localStorage.setItem).not.toHaveBeenCalled();
  });
});
