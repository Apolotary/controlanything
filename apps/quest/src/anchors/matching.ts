import type { LibraryDevice, LibraryIdentity } from '@ce/protocol';

export interface DeviceObservation extends Partial<LibraryIdentity> { label: string; cardId?: string; deviceId?: string }
export type DeviceMatch = { kind: 'none' } | { kind: 'match'; device: LibraryDevice } | { kind: 'ambiguous'; devices: LibraryDevice[] };
const normalized = (value?: string) => value?.trim().toLowerCase().replace(/\s+/g, ' ') ?? '';
const same = (a?: string, b?: string) => !!normalized(a) && normalized(a) === normalized(b);

/** Identity wins over appearance. A bridge alone cannot distinguish its several attached devices. */
function score(device: LibraryDevice, seen: DeviceObservation): number {
  const identity = device.identity;
  if (seen.cardId) return seen.cardId === device.cardId ? 100 : 0;
  const executor = seen.executorDeviceId ?? seen.deviceId;
  if (executor && identity.executorDeviceId && executor !== identity.executorDeviceId) return 0;
  if (seen.portId && identity.portId && seen.portId !== identity.portId) return 0;
  if (seen.irFingerprint && identity.irFingerprint && seen.irFingerprint !== identity.irFingerprint) return 0;
  if (executor && executor === identity.executorDeviceId && same(seen.portId, identity.portId)) return 90;
  if (same(seen.irFingerprint, identity.irFingerprint)) return executor ? 85 : 70;
  if (executor && executor === identity.executorDeviceId && same(seen.portName, identity.portName)
    && (!seen.manufacturer || same(seen.manufacturer, identity.manufacturer))) return 80;
  const appearance = identity.appearance ?? device.placement?.fallback.appearance;
  if (seen.appearance && appearance && !same(seen.appearance, appearance)) return 0;
  const labels = [identity.label, device.displayName, device.placement?.fallback.label, identity.model];
  if (!labels.some((label) => same(label, seen.label))) return 0;
  return same(seen.appearance, appearance) ? 40 : 20;
}

/** No coordinates are accepted here: old reference-space coordinates never identify a device. */
export function matchSavedDevice(devices: readonly LibraryDevice[], seen: DeviceObservation): DeviceMatch {
  if (/\b(person|people|human)\b/i.test(seen.label)) return { kind: 'none' };
  const ranked = devices.map((device) => ({ device, score: score(device, seen) })).filter((item) => item.score > 0);
  const best = Math.max(0, ...ranked.map((item) => item.score));
  const matches = ranked.filter((item) => item.score === best).map((item) => item.device);
  return matches.length === 1 ? { kind: 'match', device: matches[0] } : matches.length ? { kind: 'ambiguous', devices: matches } : { kind: 'none' };
}
