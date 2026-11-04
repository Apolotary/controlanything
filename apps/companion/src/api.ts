import type { PairStartRequest, PairStartResponse, PairStatusResponse, PendingPairing } from '@ce/protocol';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'http_error', data.message ?? `HTTP ${res.status}`);
  return data as T;
}

export interface Health {
  mode: 'live' | 'fixture';
  version: string;
  models: { chat: string; transcribe: string };
  urls: { host: string; https?: string; http?: string; local?: string; lan: string[] };
  space?: { spaceId: string; pairedDevices: number };
}

/** One model call as GET /api/muse/calls lists it. */
export interface CallRecord {
  at: number;
  label: string;
  model: string;
  source: 'live' | 'fixture';
  ok: boolean;
  latencyMs: number;
  effort?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number; reasoningTokens?: number };
  recordedFrom?: string;
}

export interface CallsResponse {
  mode: 'live' | 'fixture';
  totals: { calls: number; failures: number; promptTokens: number; completionTokens: number; reasoningTokens: number };
  calls: CallRecord[];
}

export const api = {
  health: () => call<Health>('GET', '/api/health'),
  calls: (token?: string) => call<CallsResponse>('GET', '/api/muse/calls', undefined, token),
  pairStart: (req: PairStartRequest) => call<PairStartResponse>('POST', '/api/pair/start', req),
  pairStatus: (pairingId: string, pollSecret: string) =>
    call<PairStatusResponse>('GET', `/api/pair/status?pairingId=${encodeURIComponent(pairingId)}&pollSecret=${encodeURIComponent(pollSecret)}`),
  approve: (code: string, token?: string, pairingId?: string) => call<{ pairingId: string }>('POST', '/api/pair/approve', { code, pairingId }, token),
  deny: (pairingId: string, token?: string) => call<{ pairingId: string }>('POST', '/api/pair/deny', { pairingId }, token),
  pending: (token?: string) => call<{ pending: PendingPairing[] }>('GET', '/api/pair/pending', undefined, token),
  revoke: (deviceId: string, token?: string) => call<void>('DELETE', `/api/devices/${encodeURIComponent(deviceId)}`, undefined, token),
};
