import type { DeviceKind } from '@ce/protocol';

/**
 * This headset's device identity, stored in localStorage["ce.device"] = {deviceId, deviceToken, kind, name}
 * (the convention every web client on the origin follows).
 *
 * One identity per origin, with one exception: in a desktop browser the companion may already own
 * "ce.device" (kind "mac") on the same origin. The emulated Quest then keeps its own identity under
 * "ce.device.quest" instead of clobbering the companion's, so the two show up as two devices.
 */
export interface Identity {
  deviceId: string;
  deviceToken: string;
  kind: DeviceKind;
  name: string;
}

export const IDENTITY_KEY = 'ce.device';
export const QUEST_IDENTITY_KEY = 'ce.device.quest';

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** localStorage when it works (it can throw in private mode), else an in-memory store for this page. */
export function defaultStore(): KeyValueStore {
  try {
    const s = globalThis.localStorage;
    const probe = '__ce_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    const m = new Map<string, string>();
    return {
      getItem: (k) => m.get(k) ?? null,
      setItem: (k, v) => void m.set(k, v),
      removeItem: (k) => void m.delete(k),
    };
  }
}

function read(store: KeyValueStore, key: string): Identity | undefined {
  try {
    const raw = store.getItem(key);
    if (!raw) return undefined;
    const v = JSON.parse(raw) as Partial<Identity>;
    if (typeof v?.deviceId !== 'string' || typeof v.deviceToken !== 'string' || !v.deviceId || !v.deviceToken) return undefined;
    return { deviceId: v.deviceId, deviceToken: v.deviceToken, kind: (v.kind ?? 'quest') as DeviceKind, name: v.name ?? 'Quest' };
  } catch {
    return undefined;
  }
}

/** The quest identity: "ce.device" when it holds a quest, else "ce.device.quest". */
export function loadIdentity(store: KeyValueStore = defaultStore()): Identity | undefined {
  const main = read(store, IDENTITY_KEY);
  if (main?.kind === 'quest') return main;
  return read(store, QUEST_IDENTITY_KEY);
}

/** Which key the quest identity lives under right now. */
export function identityKey(store: KeyValueStore = defaultStore()): string {
  const main = read(store, IDENTITY_KEY);
  return !main || main.kind === 'quest' ? IDENTITY_KEY : QUEST_IDENTITY_KEY;
}

export function saveIdentity(id: Identity, store: KeyValueStore = defaultStore()): void {
  try {
    store.setItem(identityKey(store), JSON.stringify(id));
  } catch {
    // storage full or blocked: the identity lasts for this page only
  }
}

/** Forget the quest identity (e.g. after the server revoked it). Never touches a companion identity. */
export function clearIdentity(store: KeyValueStore = defaultStore()): void {
  try {
    const main = read(store, IDENTITY_KEY);
    if (main?.kind === 'quest') store.removeItem(IDENTITY_KEY);
    store.removeItem(QUEST_IDENTITY_KEY);
  } catch {
    // ignore
  }
}

/** Over `adb reverse` the page is http://localhost:8787, so the server treats this headset as the owner. */
export function isLocalPage(loc: { hostname: string } = globalThis.location): boolean {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(loc.hostname);
}
