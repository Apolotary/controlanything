import { makeMessage, type MessageType, newId, parseMessage, type PayloadOf, PROTOCOL_VERSION } from '@ce/protocol';

export type WsState = 'idle' | 'connecting' | 'open' | 'closed';
export const CLOSE_UNAUTHORIZED = 4401;

/** Any message envelope as received (validated by @ce/protocol when it knows the type, else envelope-only). */
export interface Envelope<P = unknown> {
  v: 1;
  type: string;
  id: string;
  ts: number;
  from: string;
  to?: string;
  payload: P;
}

export interface SendOptions {
  to?: string;
  /** skip the message instead of queueing more bytes when the socket is backed up */
  droppable?: boolean;
}

type Handler = (m: Envelope) => void;

/** Above this many queued bytes, droppable messages (frames, control moves) are skipped. */
const BACKPRESSURE_BYTES = 2 * 1024 * 1024;

/**
 * WebSocket to the server hub: sends `hello` on every (re)connect, reconnects with jittered backoff,
 * stops on 4401 (token revoked) and reports it, and lets the recorder tap every message in and out.
 */
export class WsClient {
  private ws?: WebSocket;
  private backoff = 500;
  private stopped = true;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly taps = { in: new Set<Handler>(), out: new Set<Handler>() };
  state: WsState = 'idle';
  stats = { sent: 0, received: 0, bytesOut: 0, dropped: 0, reconnects: 0, lastError: '' };
  onState: (s: WsState, info?: { code: number; reason: string }) => void = () => {};
  onUnauthorized: () => void = () => {};
  onInvalid: (error: string, raw: string) => void = () => {};

  constructor(
    private readonly url: string,
    private readonly hello: () => PayloadOf<'hello'>,
  ) {}

  static sameOrigin(loc: Location = location): string {
    const override = new URLSearchParams(loc.search).get('ws');
    if (override) return override;
    return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;
  }

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.ws?.close();
  }

  /** Reconnect now (e.g. after a new device token). */
  restart(): void {
    this.stop();
    this.backoff = 500;
    this.start();
  }

  on(type: string, fn: Handler): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  /** Every received message. */
  onAny(fn: Handler): () => void {
    return this.on('*', fn);
  }

  /** Recorder taps: every envelope sent ('out') or received ('in'). */
  tap(dir: 'in' | 'out', fn: Handler): () => void {
    this.taps[dir].add(fn);
    return () => this.taps[dir].delete(fn);
  }

  /** Send a message. Types the protocol package knows are built with makeMessage; v1 types still landing are built the same way. */
  send(type: string, payload: unknown, opts: SendOptions = {}): string | null {
    if (!this.open) return null;
    if (opts.droppable && this.ws!.bufferedAmount > BACKPRESSURE_BYTES) {
      this.stats.dropped++;
      return null;
    }
    const env = makeMessage(type as MessageType, payload as never, opts.to ? { to: opts.to } : {}) as unknown as Envelope;
    const json = JSON.stringify(env);
    this.ws!.send(json);
    this.stats.sent++;
    this.stats.bytesOut += json.length;
    for (const fn of this.taps.out) fn(env);
    return env.id;
  }

  /** Feed a message as if it had arrived from the server (replay playback). */
  inject(env: Envelope): void {
    this.dispatch(env);
  }

  private connect(): void {
    this.setState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.stats.lastError = (e as Error).message;
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 500;
      const env = makeMessage('hello', this.hello()) as unknown as Envelope;
      ws.send(JSON.stringify(env));
      this.setState('open');
    };
    ws.onmessage = (ev) => {
      const text = typeof ev.data === 'string' ? ev.data : '';
      if (!text) return;
      const env = readEnvelope(text);
      if (!env.ok) {
        this.onInvalid(env.error, text.slice(0, 200));
        return;
      }
      this.stats.received++;
      for (const fn of this.taps.in) fn(env.message);
      this.dispatch(env.message);
    };
    ws.onerror = () => {
      this.stats.lastError = 'socket error';
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.setState('closed', { code: ev.code, reason: ev.reason });
      if (ev.code === CLOSE_UNAUTHORIZED) {
        this.stopped = true;
        this.onUnauthorized();
        return;
      }
      if (!this.stopped) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    const delay = this.backoff * (0.75 + Math.random() * 0.5);
    this.backoff = Math.min(this.backoff * 2, 8000);
    this.stats.reconnects++;
    this.timer = setTimeout(() => !this.stopped && this.connect(), delay);
  }

  private dispatch(m: Envelope): void {
    for (const fn of this.handlers.get(m.type) ?? []) {
      try {
        fn(m);
      } catch (e) {
        console.error(`[ws] handler for ${m.type} failed`, e);
      }
    }
    for (const fn of this.handlers.get('*') ?? []) {
      try {
        fn(m);
      } catch (e) {
        console.error('[ws] * handler failed', e);
      }
    }
  }

  private setState(s: WsState, info?: { code: number; reason: string }): void {
    this.state = s;
    this.onState(s, info);
  }
}

/**
 * Validate a received message with @ce/protocol. A type this build does not know yet (a v1 type the server
 * learned after this headset was built) is still accepted when its envelope is well-formed.
 */
export function readEnvelope(text: string): { ok: true; message: Envelope } | { ok: false; error: string } {
  const r = parseMessage(text);
  if (r.ok) return { ok: true, message: r.message as unknown as Envelope };
  if (!/^unknown message type/.test(r.error)) return { ok: false, error: r.error + (r.issues.length ? `: ${r.issues.join('; ')}` : '') };
  try {
    const o = JSON.parse(text) as Partial<Envelope>;
    if (o && o.v === PROTOCOL_VERSION && typeof o.type === 'string' && typeof o.id === 'string' && 'payload' in o) {
      return { ok: true, message: { v: 1, type: o.type, id: o.id, ts: Number(o.ts) || Date.now(), from: String(o.from ?? ''), to: o.to, payload: o.payload } };
    }
  } catch {
    // fall through
  }
  return { ok: false, error: r.error };
}

export { newId };
