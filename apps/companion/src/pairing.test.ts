import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPendingPairing, loadPendingPairing, savePendingPairing, type PendingSession } from './pairing';

const session: PendingSession = {
  device: { kind: 'mac', name: 'Mac companion' },
  request: { pairingId: 'pair', code: 'K7Q4M2', display: 'K7Q-4M2', qr: 'https://room.local/p/pair#K7Q4M2', pollSecret: 'private-poll-secret', status: 'pending', expiresAt: 5000 },
};
let values: Map<string, string>;
beforeEach(() => {
  values = new Map();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('pending companion pairing recovery', () => {
  it('recovers the same request and poll secret after reloading the tab', () => {
    savePendingPairing(session);
    expect(loadPendingPairing(1000)).toEqual(session);
    expect(loadPendingPairing(1500)?.request.pairingId).toBe('pair');
  });

  it('drops expired, completed and malformed requests', () => {
    savePendingPairing(session);
    expect(loadPendingPairing(5000)).toBeUndefined();
    expect(values.size).toBe(0);
    savePendingPairing({ ...session, request: { ...session.request, status: 'approved' } });
    expect(loadPendingPairing(1000)).toBeUndefined();
    values.set('ce.companion.pairing', JSON.stringify({ request: { expiresAt: 5000 } }));
    expect(loadPendingPairing(1000)).toBeUndefined();
  });

  it('clears the pending request once a token is saved or pairing is declined', () => {
    savePendingPairing(session);
    clearPendingPairing();
    expect(loadPendingPairing(1000)).toBeUndefined();
  });

  it('still pairs when private mode does not allow session storage', () => {
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('disabled'); }, setItem: () => { throw new Error('disabled'); }, removeItem: () => { throw new Error('disabled'); } });
    expect(() => savePendingPairing(session)).not.toThrow();
    expect(loadPendingPairing(1000)).toBeUndefined();
    expect(() => clearPendingPairing()).not.toThrow();
  });
});
