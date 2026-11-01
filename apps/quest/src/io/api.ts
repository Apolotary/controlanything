import type { PairStartRequest, PairStartResponse, PairStatusResponse } from '@ce/protocol';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Same-origin JSON call. `base` lets tests or a split dev setup point elsewhere. */
async function call<T>(method: string, path: string, opts: { body?: unknown; token?: string; base?: string; timeoutMs?: number } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetch(`${opts.base ?? ''}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: ctl.signal,
    });
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    if (!res.ok) throw new ApiError(res.status, data.error ?? 'http_error', data.message ?? `HTTP ${res.status}`);
    return data as T;
  } finally {
    clearTimeout(timer);
  }
}

export interface Health {
  ok: boolean;
  mode: 'live' | 'fixture';
  version: string;
  models: { chat: string; transcribe: string; reasoningEffort?: string | null };
  urls: { host: string; https?: string; http?: string; local?: string; lan: string[] };
}

export interface TranscribeResult {
  text: string;
  model?: string;
  source?: string;
  latencyMs?: number;
}

export const api = {
  health: () => call<Health>('GET', '/api/health', { timeoutMs: 4000 }),
  me: (token: string) => call<{ device: { deviceId: string; name: string; kind: string }; local: boolean }>('GET', '/api/me', { token, timeoutMs: 5000 }),
  pairStart: (req: PairStartRequest) => call<PairStartResponse>('POST', '/api/pair/start', { body: req }),
  pairStatus: (pairingId: string, pollSecret: string) =>
    call<PairStatusResponse>('GET', `/api/pair/status?pairingId=${encodeURIComponent(pairingId)}&pollSecret=${encodeURIComponent(pollSecret)}`),
  approve: (code: string, token?: string, pairingId?: string) => call<{ pairingId: string }>('POST', '/api/pair/approve', { body: { code, pairingId }, token }),
  deny: (pairingId: string, token?: string) => call<{ pairingId: string }>('POST', '/api/pair/deny', { body: { pairingId }, token }),
  /** Batch speech-to-text: mono 16-bit WAV at 16 kHz, posted raw. */
  async transcribe(wav: Uint8Array, token?: string): Promise<TranscribeResult> {
    const headers: Record<string, string> = { 'Content-Type': 'audio/wav' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch('/api/transcribe', { method: 'POST', headers, body: wav as unknown as BodyInit });
    const data = (await res.json().catch(() => ({}))) as TranscribeResult & { error?: string; message?: string };
    if (!res.ok) throw new ApiError(res.status, data.error ?? 'http_error', data.message ?? `HTTP ${res.status}`);
    return data;
  },
};
