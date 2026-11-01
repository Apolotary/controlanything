import type { DeviceKind } from '@ce/protocol';

/**
 * This browser's device identity. Convention for every web client on the same origin (companion, quest):
 * localStorage["ce.device"] = {deviceId, deviceToken, kind, name}. One identity per origin.
 */
export interface Identity {
  deviceId: string;
  deviceToken: string;
  kind: DeviceKind;
  name: string;
}

const KEY = 'ce.device';

export function loadIdentity(): Identity | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as Identity) : undefined;
    return v?.deviceToken && v.deviceId ? v : undefined;
  } catch {
    return undefined;
  }
}

export function saveIdentity(id: Identity): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(id));
  } catch {
    // private mode: the identity lasts for this page only
  }
}

export function clearIdentity(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

export function isLocalPage(): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
}

/** Desktop browsers pair as "mac" (an approver); phones and headsets opening this page as "web". */
export function defaultDevice(): { kind: DeviceKind; name: string } {
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad|Mobile|OculusBrowser|Quest/i.test(ua)) return { kind: 'web', name: 'Web companion' };
  return { kind: 'mac', name: /Mac/i.test(ua) ? 'Mac companion' : 'Desktop companion' };
}
