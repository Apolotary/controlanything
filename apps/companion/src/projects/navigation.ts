import { DeviceKind } from '@ce/protocol';
import type { Identity } from '../identity';

interface StorageReader { getItem(key: string): string | null }
function readIdentity(storage: StorageReader, key: string): Identity | undefined {
  try {
    const value = JSON.parse(storage.getItem(key) ?? 'null') as Partial<Identity> | null;
    if (!value || typeof value.deviceId !== 'string' || !value.deviceId || typeof value.deviceToken !== 'string' || !value.deviceToken) return;
    if (!DeviceKind.safeParse(value.kind).success) return;
    return value as Identity;
  } catch { return; }
}

/** A headset route must never borrow a desktop's identity in an emulated/shared browser. */
export function canvasIdentity(storage: StorageReader, headset: boolean): Identity | undefined {
  const main = readIdentity(storage, 'ce.device');
  if (!headset) return main;
  if (main?.kind === 'quest') return main;
  const quest = readIdentity(storage, 'ce.device.quest');
  return quest?.kind === 'quest' ? quest : undefined;
}
export function isHeadsetCanvas(search: string, userAgent = ''): boolean {
  return new URLSearchParams(search).get('headset') === '1' || /OculusBrowser|Quest/i.test(userAgent);
}
/** Only local, fixed navigation destinations. Tokens and generated code never enter the URL. */
export function questReturnUrl(projectId?: string): string {
  const query = new URLSearchParams();
  if (projectId) query.set('canvasProject', projectId);
  return `/quest/${query.size ? `?${query}` : ''}`;
}
export function prefilledPrompt(search: string): string {
  return (new URLSearchParams(search).get('prompt') ?? '').trim().slice(0, 4000);
}
