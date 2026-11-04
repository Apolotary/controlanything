/** HTTP calls to the server's buddy routes (apps/server/src/buddy/routes.ts). */
import type { BuddyAction, BuddyEmotion } from './mascot';

export interface Reaction {
  object: string;
  emotion: BuddyEmotion;
  quip: string;
  action: BuddyAction;
  questMet: boolean;
  traits?: string[];
}

export interface ReactResult {
  reaction: Reaction;
  model: string;
  source: 'live' | 'fixture';
  recordedFrom?: string;
  latencyMs: number;
}

export interface StickerResult {
  ok: boolean;
  url?: string;
  model: string;
  source: 'live' | 'fixture';
  recordedFrom?: string;
  latencyMs: number;
  error?: string;
}

/** how the crop was taken: the show-me frame / a raised hand ('hand'), the centre of the view ('gaze'), a test photo */
export type ShowVia = 'hand' | 'gaze' | 'photo';

async function post<T>(path: string, body: unknown, token: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const cancel = () => ctl.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
    const data = (await res.json().catch(() => ({}))) as T & { message?: string };
    if (!res.ok) throw new Error(data.message ?? `HTTP ${res.status}`);
    return data;
  } catch (e) {
    if (signal?.aborted) throw new Error('cancelled');
    if (ctl.signal.aborted) throw new Error('Muse took too long');
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

export const buddyApi = {
  react: (jpeg: string, quest: string | undefined, seen: string[], via: ShowVia, token?: string, signal?: AbortSignal) =>
    post<ReactResult>('/api/buddy/react', { jpeg, ...(quest ? { quest } : {}), seen: seen.slice(-8), via }, token, 30_000, signal),
  sticker: (jpeg: string, object: string | undefined, token?: string) => post<StickerResult>('/api/buddy/sticker', { jpeg, ...(object ? { object } : {}) }, token, 60_000),
};
