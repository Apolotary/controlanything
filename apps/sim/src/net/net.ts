/**
 * The sim pairs and connects exactly like any other client: POST /api/pair/start (kind "sim"), show the QR +
 * code until a trusted device approves (instant from localhost), store the device token, then /ws + hello.
 * Its identity lives under its own localStorage key, so it never collides with the companion's on this origin.
 */
import {
  type AnyMessage,
  type Capability,
  makeMessage,
  type MessageOf,
  type MessageType,
  type PairStartResponse,
  type PairStatusResponse,
  parseMessage,
  type PayloadOf,
  type Port,
} from '@ce/protocol';

export const SIM_APP = 'sim@0.1.0';
export const SIM_CAPABILITIES: Capability[] = ['ir', 'midi', 'camera', 'mic', 'speaker', 'display'];
export const SIM_PORTS: Port[] = [
  { id: 'sim-midi', kind: 'midi-out', name: 'CE Sim Synth (OP-1 Field CC map)', manufacturer: 'ControlEverything sim', state: 'connected' },
  { id: 'sim-ir', kind: 'ir', name: 'CE Sim IR (virtual ceiling light)', manufacturer: 'ControlEverything sim', state: 'connected' },
];

export interface Identity {
  deviceId: string;
  deviceToken: string;
  name: string;
}

const KEY = 'ce.sim.device';

export function loadIdentity(): Identity | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Identity | null;
    return v?.deviceId && v.deviceToken ? v : undefined;
  } catch {
    return undefined;
  }
}

export function saveIdentity(id: Identity): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(id));
  } catch {
    // private mode: lasts for this page only
  }
}

export function clearIdentity(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'http_error', data.message ?? `HTTP ${res.status}`);
  return data as T;
}

export interface Health {
  mode: 'live' | 'fixture';
  version: string;
  keyConfigured?: boolean;
  models: Record<string, string | null>;
  urls: { host: string; https?: string; http?: string; local?: string; lan: string[] };
}

export const api = {
  health: () => call<Health>('GET', '/api/health'),
  pairStart: (name: string) => call<PairStartResponse>('POST', '/api/pair/start', { name, kind: 'sim', capabilities: SIM_CAPABILITIES }),
  pairStatus: (pairingId: string, pollSecret: string) =>
    call<PairStatusResponse>('GET', `/api/pair/status?pairingId=${encodeURIComponent(pairingId)}&pollSecret=${encodeURIComponent(pollSecret)}`),
  /** stored device profile (OP-1 Field CC chart, lamp codes...) if the server has it */
  profile: (id: string) => call<unknown>('GET', `/api/profiles/${encodeURIComponent(id)}`),
};

export type ConnState = 'connecting' | 'open' | 'closed';
const CLOSE_UNAUTHORIZED = 4401;

/** WebSocket to /ws on the same origin: hello on every (re)connect, reconnect with backoff. */
export class Connection {
  private ws?: WebSocket;
  private backoff = 500;
  private stopped = true;
  private readonly handlers = new Map<string, Set<(m: AnyMessage) => void>>();
  onState: (s: ConnState, info?: { code: number; reason: string }) => void = () => {};
  onUnauthorized: () => void = () => {};
  /** every message sent or received, for the replay recorder and the log */
  onTraffic: (dir: 'in' | 'out', m: AnyMessage | Record<string, unknown>) => void = () => {};

  constructor(
    private readonly url: string,
    private readonly hello: () => PayloadOf<'hello'>,
  ) {}

  static sameOrigin(): string {
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  }

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }

  on<T extends MessageType>(type: T, fn: (m: MessageOf<T>) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn as (m: AnyMessage) => void);
    return () => set!.delete(fn as (m: AnyMessage) => void);
  }

  onAny(fn: (m: AnyMessage) => void): () => void {
    return this.on('*' as MessageType, fn as never);
  }

  send<T extends MessageType>(type: T, payload: PayloadOf<T>, opts: { to?: string } = {}): boolean {
    if (!this.open) return false;
    const m = makeMessage(type, payload, opts);
    this.ws!.send(JSON.stringify(m));
    this.onTraffic('out', m as AnyMessage);
    return true;
  }

  /** Send an already-built envelope (replay). */
  sendRaw(m: Record<string, unknown>): boolean {
    if (!this.open) return false;
    this.ws!.send(JSON.stringify(m));
    this.onTraffic('out', m);
    return true;
  }

  resendHello(): void {
    this.send('hello', this.hello());
  }

  private connect(): void {
    this.onState('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 500;
      ws.send(JSON.stringify(makeMessage('hello', this.hello())));
      this.onState('open');
    };
    ws.onmessage = (ev) => {
      const r = parseMessage(String(ev.data));
      if (!r.ok) return;
      this.onTraffic('in', r.message);
      for (const fn of this.handlers.get(r.message.type) ?? []) fn(r.message);
      for (const fn of this.handlers.get('*') ?? []) fn(r.message);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.onState('closed', { code: ev.code, reason: ev.reason });
      if (ev.code === CLOSE_UNAUTHORIZED) {
        this.stopped = true;
        this.onUnauthorized();
        return;
      }
      if (this.stopped) return;
      setTimeout(() => !this.stopped && this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 8000);
    };
  }
}
