import { PairStartResponse, type DeviceKind } from '@ce/protocol';

const KEY = 'ce.companion.pairing';
export interface PendingSession {
  request: ReturnType<typeof PairStartResponse.parse>;
  device: { kind: DeviceKind; name: string };
}

/** A reload resumes this tab's request; storage and API paths stay on the current origin. */
export function loadPendingPairing(now = Date.now()): PendingSession | undefined {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as PendingSession;
    const parsed = PairStartResponse.safeParse(value.request);
    if (!parsed.success || parsed.data.status !== 'pending' || parsed.data.expiresAt <= now || !value.device?.name || !['mac', 'web'].includes(value.device.kind)) {
      clearPendingPairing();
      return undefined;
    }
    return { request: parsed.data, device: value.device };
  } catch {
    return undefined;
  }
}

export function savePendingPairing(session: PendingSession): void {
  try { sessionStorage.setItem(KEY, JSON.stringify(session)); }
  catch { /* The request can still complete when session storage is unavailable. */ }
}

export function clearPendingPairing(): void {
  try { sessionStorage.removeItem(KEY); }
  catch { /* Storage may be unavailable in a private tab. */ }
}
