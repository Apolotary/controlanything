/**
 * Pairing this headset with the server (device-code flow, see packages/protocol/src/pairing.ts).
 *
 * - Over `adb reverse` the page is http://localhost:8787, the server treats the request as the owner's and
 *   approves on the spot: the token comes back in the POST /api/pair/start response.
 * - On the LAN (https://<mac>:8443/quest/) the request stays pending: the headset shows its code + QR
 *   (2D page and HUD) until the owner approves on the Mac, an iPhone or the server console.
 * The identity is stored in localStorage "ce.device" (see io/identity.ts).
 */
import type { Capability, PairStartResponse, PairStatusResponse } from '@ce/protocol';
import { Emitter } from '../app/emitter';
import { ApiError, api } from '../io/api';
import { clearIdentity, defaultStore, type Identity, type KeyValueStore, loadIdentity, saveIdentity } from '../io/identity';

export type PairState =
  | { kind: 'checking' }
  | { kind: 'paired'; identity: Identity; verified: boolean }
  | { kind: 'pending'; pairingId: string; display: string; qr: string; expiresAt: number }
  | { kind: 'denied'; message: string }
  | { kind: 'offline'; message: string };

export interface PairApi {
  me: typeof api.me;
  pairStart: typeof api.pairStart;
  pairStatus: typeof api.pairStatus;
}

export interface PairingOptions {
  name: string;
  capabilities: Capability[];
  store?: KeyValueStore;
  api?: PairApi;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class PairingFlow extends Emitter<{ state: PairState }> {
  state: PairState = { kind: 'checking' };
  private readonly store: KeyValueStore;
  private readonly api: PairApi;
  private readonly sleep: (ms: number) => Promise<void>;
  private generation = 0;

  constructor(private readonly o: PairingOptions) {
    super();
    this.store = o.store ?? defaultStore();
    this.api = o.api ?? api;
    this.sleep = o.sleep ?? defaultSleep;
  }

  get identity(): Identity | undefined {
    return this.state.kind === 'paired' ? this.state.identity : undefined;
  }

  /** Resolves with a usable identity; keeps retrying (offline) or re-pairing (expired/denied) until then. */
  async ensure(): Promise<Identity> {
    const gen = ++this.generation;
    this.set({ kind: 'checking' });
    const existing = loadIdentity(this.store);
    if (existing) {
      try {
        await this.api.me(existing.deviceToken);
        return this.paired(existing, true);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          clearIdentity(this.store);
        } else {
          // server unreachable: keep the identity; the WebSocket keeps retrying and reports a revoked token (4401)
          return this.paired(existing, false);
        }
      }
    }
    return this.pair(gen);
  }

  /** Forget the identity (revoked or user reset) and pair again. */
  async repair(): Promise<Identity> {
    clearIdentity(this.store);
    return this.ensure();
  }

  private async pair(gen: number): Promise<Identity> {
    let backoff = 1000;
    for (;;) {
      if (gen !== this.generation) throw new Error('pairing superseded');
      let start: PairStartResponse;
      try {
        start = await this.api.pairStart({ name: this.o.name, kind: 'quest', capabilities: this.o.capabilities });
      } catch (e) {
        this.set({ kind: 'offline', message: `Server unreachable (${(e as Error).message}); retrying…` });
        await this.sleep(backoff);
        backoff = Math.min(backoff * 2, 8000);
        continue;
      }
      backoff = 1000;
      if (start.status === 'approved' && start.deviceId && start.deviceToken) {
        return this.save(start.deviceId, start.deviceToken);
      }
      this.set({ kind: 'pending', pairingId: start.pairingId, display: start.display, qr: start.qr, expiresAt: start.expiresAt });
      const outcome = await this.poll(gen, start);
      if (outcome) return outcome;
      // expired or denied: loop and ask for a fresh code
    }
  }

  private async poll(gen: number, start: PairStartResponse): Promise<Identity | null> {
    for (;;) {
      await this.sleep(this.o.pollMs ?? 1500);
      if (gen !== this.generation) throw new Error('pairing superseded');
      let s: PairStatusResponse;
      try {
        s = await this.api.pairStatus(start.pairingId, start.pollSecret);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        continue; // transient network error: keep polling
      }
      if (s.status === 'approved' && s.deviceId && s.deviceToken) return this.save(s.deviceId, s.deviceToken);
      if (s.status === 'approved') return null; // token already taken by another reader: start over
      if (s.status === 'denied') {
        this.set({ kind: 'denied', message: s.reason ? `Pairing denied (${s.reason}).` : 'Pairing denied.' });
        await this.sleep(3000);
        return null;
      }
      if (s.status === 'expired' || Date.now() > start.expiresAt + 2000) return null;
    }
  }

  private save(deviceId: string, deviceToken: string): Identity {
    const identity: Identity = { deviceId, deviceToken, kind: 'quest', name: this.o.name };
    saveIdentity(identity, this.store);
    return this.paired(identity, true);
  }

  private paired(identity: Identity, verified: boolean): Identity {
    this.set({ kind: 'paired', identity, verified });
    return identity;
  }

  private set(s: PairState): void {
    this.state = s;
    this.emit('state', s);
  }
}
