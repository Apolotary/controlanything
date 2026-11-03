import type { PairStartResponse, PairStatusResponse } from '@ce/protocol';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../io/api';
import type { KeyValueStore } from '../io/identity';
import { type PairApi, PairingFlow, type PairState } from './self';

function memStore(): KeyValueStore & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v), removeItem: (k) => void delete data[k] };
}

const start = (over: Partial<PairStartResponse> = {}): PairStartResponse => ({
  pairingId: 'p1',
  code: 'K7Q4M2',
  display: 'K7Q-4M2',
  qr: 'https://mac:8443/p/p1#K7Q4M2',
  expiresAt: Date.now() + 300_000,
  pollSecret: 's',
  status: 'pending',
  ...over,
});

function fakeApi(o: { me?: () => Promise<unknown>; starts: PairStartResponse[]; statuses?: PairStatusResponse[] }): PairApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    me: (async () => {
      calls.push('me');
      if (o.me) return o.me();
      throw new ApiError(401, 'unauthorized', 'no');
    }) as PairApi['me'],
    pairStart: (async () => {
      calls.push('start');
      const r = o.starts.shift();
      if (!r) throw new Error('offline');
      return r;
    }) as PairApi['pairStart'],
    pairStatus: (async () => {
      calls.push('status');
      return o.statuses?.shift() ?? { pairingId: 'p1', status: 'pending', expiresAt: Date.now() + 1000 };
    }) as PairApi['pairStatus'],
  };
}

const sleep = async () => {};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('PairingFlow (device-code)', () => {
  it('over adb reverse the server approves on the spot', async () => {
    const store = memStore();
    const api = fakeApi({ starts: [start({ status: 'approved', deviceId: 'quest-1', deviceToken: 'tok' })] });
    const id = await new PairingFlow({ name: 'Quest 3', capabilities: ['camera'], store, api, sleep }).ensure();
    expect(id).toMatchObject({ deviceId: 'quest-1', deviceToken: 'tok', kind: 'quest' });
    expect(JSON.parse(store.data['ce.device'])).toMatchObject({ deviceId: 'quest-1' });
  });

  it('on the LAN it shows the code and waits for approval', async () => {
    const store = memStore();
    const states: PairState[] = [];
    const api = fakeApi({
      starts: [start()],
      statuses: [
        { pairingId: 'p1', status: 'pending', expiresAt: Date.now() + 1000 },
        { pairingId: 'p1', status: 'approved', expiresAt: Date.now() + 1000, deviceId: 'quest-2', deviceToken: 'tok2' },
      ],
    });
    const flow = new PairingFlow({ name: 'Quest 3', capabilities: ['camera'], store, api, sleep });
    flow.on('state', (s) => states.push(s));
    const id = await flow.ensure();
    expect(id.deviceId).toBe('quest-2');
    expect(states.map((s) => s.kind)).toEqual(['checking', 'pending', 'paired']);
    expect(states[1]).toMatchObject({ display: 'K7Q-4M2' });
  });

  it('re-pairs when the stored token was revoked, and asks for a fresh code after expiry', async () => {
    const store = memStore();
    store.setItem('ce.device', JSON.stringify({ deviceId: 'old', deviceToken: 'revoked', kind: 'quest', name: 'Quest' }));
    const api = fakeApi({
      starts: [start({ pairingId: 'p1' }), start({ pairingId: 'p2', status: 'approved', deviceId: 'quest-3', deviceToken: 't3' })],
      statuses: [{ pairingId: 'p1', status: 'expired', expiresAt: 0 }],
    });
    const id = await new PairingFlow({ name: 'Quest 3', capabilities: [], store, api, sleep }).ensure();
    expect(id.deviceId).toBe('quest-3');
    expect(api.calls).toEqual(['me', 'start', 'status', 'start']);
  });

  it('keeps a stored identity when the server is unreachable', async () => {
    const store = memStore();
    store.setItem('ce.device', JSON.stringify({ deviceId: 'q', deviceToken: 't', kind: 'quest', name: 'Quest' }));
    const api = fakeApi({ me: () => Promise.reject(new TypeError('fetch failed')), starts: [] });
    const flow = new PairingFlow({ name: 'Quest 3', capabilities: [], store, api, sleep });
    const id = await flow.ensure();
    expect(id.deviceId).toBe('q');
    expect(flow.state).toMatchObject({ kind: 'paired', verified: false });
  });

  it.each(['approved', 'revoked', 'offline'] as const)('ignores a superseded identity check returning %s after Repair', async (outcome) => {
    const store = memStore(), pending = deferred<unknown>();
    store.setItem('ce.device', JSON.stringify({ deviceId: 'old', deviceToken: 'old-token', kind: 'quest', name: 'Quest' }));
    const api = fakeApi({ me: () => pending.promise, starts: [start({ status: 'approved', deviceId: 'new', deviceToken: 'new-token' })] });
    const flow = new PairingFlow({ name: 'Quest 3', capabilities: [], store, api, sleep });
    const states: PairState[] = []; flow.on('state', state => states.push(state));
    const stale = expect(flow.ensure()).rejects.toThrow('pairing superseded');
    const current = await flow.repair(), stateCount = states.length;
    if (outcome === 'approved') pending.resolve({});
    else pending.reject(outcome === 'revoked' ? new ApiError(401, 'unauthorized', 'revoked') : new TypeError('offline'));
    await stale;
    expect(flow.identity).toEqual(current); expect(flow.identity?.deviceId).toBe('new');
    expect(JSON.parse(store.data['ce.device']).deviceId).toBe('new');
    expect(states).toHaveLength(stateCount); expect(api.calls).toEqual(['me', 'start']);
  });

  it.each(['approved', 'pending', 'failed'] as const)('ignores a superseded pairing start returning %s after Repair', async (outcome) => {
    const store = memStore(), pending = deferred<PairStartResponse>();
    const api = fakeApi({ starts: [start({ status: 'approved', deviceId: 'new', deviceToken: 'new-token' })] });
    const nextStart = api.pairStart; let first = true;
    api.pairStart = req => { if (!first) return nextStart(req); first = false; return pending.promise; };
    const flow = new PairingFlow({ name: 'Quest 3', capabilities: [], store, api, sleep });
    const states: PairState[] = []; flow.on('state', state => states.push(state));
    const stale = expect(flow.ensure()).rejects.toThrow('pairing superseded');
    const current = await flow.repair(), stateCount = states.length;
    if (outcome === 'failed') pending.reject(new TypeError('offline'));
    else pending.resolve(start(outcome === 'approved' ? { status: 'approved', deviceId: 'old', deviceToken: 'old-token' } : {}));
    await stale;
    expect(flow.identity).toEqual(current); expect(flow.identity?.deviceId).toBe('new');
    expect(JSON.parse(store.data['ce.device']).deviceId).toBe('new');
    expect(states).toHaveLength(stateCount); expect(api.calls).toEqual(['start']);
  });

  it.each(['approved', 'denied', 'failed'] as const)('ignores a superseded pairing poll returning %s after Repair', async (outcome) => {
    const store = memStore(), pending = deferred<PairStatusResponse>(), polling = deferred<void>();
    const api = fakeApi({ starts: [start(), start({ status: 'approved', deviceId: 'new', deviceToken: 'new-token' })] });
    api.pairStatus = () => { polling.resolve(); return pending.promise; };
    const flow = new PairingFlow({ name: 'Quest 3', capabilities: [], store, api, sleep });
    const states: PairState[] = []; flow.on('state', state => states.push(state));
    const stale = expect(flow.ensure()).rejects.toThrow('pairing superseded');
    await polling.promise;
    const current = await flow.repair(), stateCount = states.length;
    if (outcome === 'failed') pending.reject(new ApiError(404, 'not_found', 'old pairing gone'));
    else pending.resolve({ pairingId: 'p1', expiresAt: Date.now() + 1000, status: outcome,
      ...(outcome === 'approved' ? { deviceId: 'old', deviceToken: 'old-token' } : {}) });
    await stale;
    expect(flow.identity).toEqual(current); expect(flow.identity?.deviceId).toBe('new');
    expect(JSON.parse(store.data['ce.device']).deviceId).toBe('new');
    expect(states).toHaveLength(stateCount); expect(api.calls).toEqual(['start', 'start']);
  });
});
