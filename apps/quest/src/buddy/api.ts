/** HTTP calls to the server's buddy routes (apps/server/src/buddy/routes.ts). */
import type { BuddyAction, BuddyEmotion } from './mascot';

export interface Reaction {
  object: string;
  emotion: BuddyEmotion;
  quip: string;
  action: BuddyAction;
  questMet: boolean;
  traits: string[];
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

async function post<T>(path: string, body: unknown, token: string | undefined, timeoutMs: number): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
    const data = (await res.json().catch(() => ({}))) as T & { message?: string };
    if (!res.ok) throw new Error(data.message ?? `HTTP ${res.status}`);
    return data;
  } catch (e) {
    if (ctl.signal.aborted) throw new Error('Muse took too long');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export const buddyApi = {
  react: (jpeg: string, quest: string | undefined, seen: string[], via: 'hand' | 'yolo' | 'gaze' | 'photo', token?: string) =>
    post<ReactResult>('/api/buddy/react', { jpeg, ...(quest ? { quest } : {}), seen: seen.slice(-8), via }, token, 30_000),
  sticker: (jpeg: string, object: string | undefined, token?: string) => post<StickerResult>('/api/buddy/sticker', { jpeg, ...(object ? { object } : {}) }, token, 60_000),
};
