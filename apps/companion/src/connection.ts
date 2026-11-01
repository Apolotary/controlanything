import { type AnyMessage, makeMessage, type MessageOf, type MessageType, parseMessage, type PayloadOf } from '@ce/protocol';

export type ConnState = 'connecting' | 'open' | 'closed';
export const CLOSE_UNAUTHORIZED = 4401;

/** WebSocket to /ws on the same origin: sends hello on every (re)connect, reconnects with backoff. */
export class Connection {
  private ws?: WebSocket;
  private backoff = 500;
  private stopped = true;
  private readonly handlers = new Map<string, Set<(m: AnyMessage) => void>>();
  onState: (s: ConnState, info?: { code: number; reason: string }) => void = () => {};
  onInvalid: (error: string) => void = () => {};

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

  /** Every message, including experimental x.* ones. */
  onAny(fn: (m: AnyMessage) => void): () => void {
    return this.on('*' as MessageType, fn as never);
  }

  send<T extends MessageType>(type: T, payload: PayloadOf<T>, opts: { to?: string } = {}): boolean {
    if (!this.open) return false;
    this.ws!.send(JSON.stringify(makeMessage(type, payload, opts)));
    return true;
  }

  /** Re-send hello, e.g. after MIDI ports changed. */
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
      if (!r.ok) {
        this.onInvalid(r.error);
        return;
      }
      for (const fn of this.handlers.get(r.message.type) ?? []) fn(r.message);
      for (const fn of this.handlers.get('*') ?? []) fn(r.message);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.onState('closed', { code: ev.code, reason: ev.reason });
      if (ev.code === CLOSE_UNAUTHORIZED) this.stopped = true;
      if (this.stopped) return;
      setTimeout(() => !this.stopped && this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 8000);
    };
  }
}
