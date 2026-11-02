/**
 * Nature Remo bridge. A Nature Remo on the LAN (Remo-XXXXXX, mDNS `_remo._tcp`, local API on port 80) becomes a
 * paired "remo" device of this server with the IR capability: an IR LEARNER (GET /messages returns the last
 * signal the Remo received) and an IR BLASTER (POST /messages sends one). The bridge pairs over loopback like
 * any client and speaks the same exec.command / sense.request protocol, so LINK, LEARN, VERIFY and CONTROL
 * treat it exactly like the Cardputer's IR unit (pickExecutor prefers it for IR when both are online; the
 * Cardputer stays the alternative and the pairing story).
 *
 *   GET  http://<remo>/messages   X-Requested-With: local   -> {"format":"us","freq":38,"data":[µs, µs, …]}
 *   POST http://<remo>/messages   X-Requested-With: local      {"format":"us","freq":38,"data":[µs, µs, …]}
 *
 * Hard rules: nothing is POSTed unless `allowSend` is on (REMO_SEND=1 after the user approved firing IR):
 * exec.command is acknowledged `refused` until then, and LEARN only ever GETs. Sends are >= 1 s apart (the
 * server's IR cap of 4 Hz still applies on top). The bridge starts only when REMO_HOST is set or CE_REMO=1,
 * so a server without a Remo (the sim / judge path) never touches the LAN, and it never probes the Remo at
 * start-up: the first request happens when a learn window or a send asks for it.
 */
import dgram from 'node:dgram';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type AnyMessage, type ExecAckPayload, type ExecCommandPayload, type IrCapture, type IrOp, makeMessage, type MessageType, type PayloadOf, type SenseRequestPayload, type SenseResultPayload } from '@ce/protocol';
import WebSocket from 'ws';
import { fillRaw } from './ir';

export const REMO_SERVICE = '_remo._tcp.local';
export const REMO_HEADER = { 'X-Requested-With': 'local' } as const;
export const REMO_MIN_SEND_GAP_MS = 1000;
export const REMO_POLL_MS = 250;
export const REMO_HTTP_TIMEOUT_MS = 2500;
/** a leading mark shorter than this is a glitch before the leader, not the leader */
const LEADER_MIN_US = 1500;
/** a trailing space longer than this is the silence the Remo recorded after the press */
const TRAILING_SILENCE_US = 65_000;

/** The Remo local API's signal format: alternating mark/space durations in µs, mark first. */
export interface RemoFrame {
  format: 'us';
  freq: number;
  data: number[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- frames --------------------------------------------------------------------------------------

/** Read a Remo /messages body. `undefined` when the Remo has nothing stored yet (empty body or no data). */
export function parseRemoFrame(json: unknown): RemoFrame | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const f = json as Record<string, unknown>;
  if (!Array.isArray(f.data)) return undefined;
  const data = f.data.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (data.length < 2) return undefined;
  return { format: 'us', freq: typeof f.freq === 'number' && f.freq > 0 ? f.freq : 38, data };
}

/**
 * Clean a received frame: stray short mark/space pairs before the leader (receiver noise) and the long silence
 * the Remo records after the press are dropped; marks stay first. Unknown shapes are returned as they are.
 */
export function cleanFrame(data: number[]): number[] {
  let out = data.slice();
  while (out.length >= 4 && out[0] < LEADER_MIN_US) out = out.slice(2);
  if (out.length < 2) return data.slice();
  if (out.length % 2 === 0 && out[out.length - 1] > TRAILING_SILENCE_US) out = out.slice(0, -1);
  return out.map((v) => Math.min(200_000, Math.max(1, Math.round(v))));
}

/** The capture the learn step consumes (same shape the Cardputer sends). */
export function frameToCapture(f: RemoFrame): IrCapture {
  const rawUs = cleanFrame(f.data).slice(0, 1024);
  return { rawUs, khz: Math.min(60, Math.max(30, f.freq || 38)) };
}

/** The frame to POST for an IrOp: rawUs (filled from protocol + bytes when missing), repeats joined by the frame gap. */
export function opToFrame(op: IrOp): RemoFrame {
  const filled = fillRaw(op);
  const raw = filled.rawUs ?? [];
  if (raw.length < 2) throw new Error('IR op has no timings');
  const repeats = Math.min(5, Math.max(0, filled.repeats ?? 0));
  const gap = filled.frameGapUs ?? 40_000;
  const data: number[] = [];
  for (let i = 0; i <= repeats; i++) {
    if (i) data.push(gap);
    data.push(...raw);
  }
  return { format: 'us', freq: filled.khz ?? 38, data: data.map((v) => Math.max(1, Math.round(v))) };
}

/** The Remo stores the last signal it received; a different array means a new signal arrived. */
export function sameFrame(a: number[] | undefined, b: number[] | undefined): boolean {
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// --- the Remo's local API ------------------------------------------------------------------------

export class RemoClient {
  constructor(
    readonly base: string,
    private readonly o: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
  ) {}

  private async call(method: 'GET' | 'POST', body?: string, signal?: AbortSignal): Promise<Response> {
    const f = this.o.fetchImpl ?? fetch;
    const timeout = AbortSignal.timeout(this.o.timeoutMs ?? REMO_HTTP_TIMEOUT_MS);
    const res = await f(`${this.base.replace(/\/+$/, '')}/messages`, {
      method,
      headers: body ? { ...REMO_HEADER, 'content-type': 'application/json' } : { ...REMO_HEADER },
      body,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) throw new Error(`Remo answered HTTP ${res.status}`);
    return res;
  }

  /** The last IR signal the Remo received (undefined when it has none stored). GET only. */
  async getMessages(signal?: AbortSignal): Promise<RemoFrame | undefined> {
    const res = await this.call('GET', undefined, signal);
    const text = await res.text();
    if (!text.trim()) return undefined;
    try {
      return parseRemoFrame(JSON.parse(text));
    } catch {
      throw new Error('Remo returned something that is not JSON');
    }
  }

  /** Send one frame. Callers gate this behind the user's approval. */
  async postMessage(frame: RemoFrame, signal?: AbortSignal): Promise<void> {
    await this.call('POST', JSON.stringify(frame), signal);
  }
}

// --- the bridge: a loopback hub client ------------------------------------------------------------

export interface RemoBridgeOptions {
  /** this server's plain-HTTP base, for pairing and the websocket (loopback is auto-approved) */
  serverBase: string;
  remo: RemoClient;
  name?: string;
  /** POST /messages allowed (REMO_SEND=1 after the user said yes); default false: sends are acknowledged `refused` */
  allowSend?: boolean;
  /** the device token survives restarts here, so the Remo keeps one identity in the registry */
  tokenFile?: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  pollMs?: number;
  minSendGapMs?: number;
}

export class RemoBridge {
  deviceId = '';
  allowSend: boolean;
  sends = 0;
  captures = 0;
  lastError?: string;
  private token?: string;
  private ws?: WebSocket;
  private stopped = true;
  private backoff = 500;
  private lastSendAt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly log: (line: string) => void;

  constructor(private readonly o: RemoBridgeOptions) {
    this.allowSend = o.allowSend ?? false;
    this.log = o.log ?? (() => {});
  }

  get name(): string {
    return this.o.name ?? 'Nature Remo';
  }

  get remoBase(): string {
    return this.o.remo.base;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Pair (or reuse the stored token) and connect; reconnects with backoff until stop(). */
  async start(): Promise<void> {
    this.stopped = false;
    await this.pair();
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
  }

  private async pair(): Promise<void> {
    const f = this.o.tokenFile;
    if (f && existsSync(f)) {
      try {
        const j = JSON.parse(readFileSync(f, 'utf8')) as { deviceId?: string; deviceToken?: string };
        if (j.deviceId && j.deviceToken) {
          this.deviceId = j.deviceId;
          this.token = j.deviceToken;
          return;
        }
      } catch {
        // re-pair below
      }
    }
    const fetchImpl = this.o.fetchImpl ?? fetch;
    const res = await fetchImpl(`${this.o.serverBase}/api/pair/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: this.name.slice(0, 120), kind: 'remo', capabilities: ['ir'] }),
    });
    const j = (await res.json()) as { status?: string; deviceId?: string; deviceToken?: string; message?: string };
    if (!res.ok || j.status !== 'approved' || !j.deviceToken || !j.deviceId) {
      throw new Error(`loopback pairing was not approved (${j.status ?? res.status}); the bridge needs CE_TRUST_LOOPBACK (default on)`);
    }
    this.deviceId = j.deviceId;
    this.token = j.deviceToken;
    if (f) {
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, `${JSON.stringify({ deviceId: j.deviceId, deviceToken: j.deviceToken, name: this.name }, null, 2)}\n`, { mode: 0o600 });
    }
  }

  private connect(): Promise<void> {
    return new Promise((resolve) => {
      const url = `${this.o.serverBase.replace(/^http/, 'ws')}/ws`;
      const ws = new WebSocket(url);
      this.ws = ws;
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      ws.on('open', () => {
        this.backoff = 500;
        this.send('hello', { deviceToken: this.token!, role: 'device', capabilities: ['ir'], app: 'remo-bridge@0.1.0' });
      });
      ws.on('message', (d) => {
        let m: AnyMessage;
        try {
          m = JSON.parse(d.toString()) as AnyMessage;
        } catch {
          return;
        }
        if (m.type === 'welcome') {
          this.log(`[remo] bridge online as ${this.deviceId} (${this.name} at ${this.remoBase}) · IR send ${this.allowSend ? 'ON' : 'OFF until approved'}`);
          done();
        }
        this.onMessage(m);
      });
      ws.on('error', (e) => {
        this.lastError = e.message;
      });
      ws.on('close', (code) => {
        if (code === 4401) {
          // revoked: forget the token and pair again next time
          this.token = undefined;
          if (this.o.tokenFile && existsSync(this.o.tokenFile)) unlinkSync(this.o.tokenFile);
        }
        done();
        if (this.stopped) return;
        this.timer = setTimeout(() => void this.reconnect(), this.backoff);
        this.backoff = Math.min(8000, this.backoff * 2);
      });
    });
  }

  private async reconnect(): Promise<void> {
    if (this.stopped) return;
    try {
      if (!this.token) await this.pair();
    } catch (e) {
      this.lastError = (e as Error).message;
      this.log(`[remo] re-pair failed: ${this.lastError}`);
      this.timer = setTimeout(() => void this.reconnect(), this.backoff);
      return;
    }
    await this.connect();
  }

  private onMessage(m: AnyMessage): void {
    if (m.type === 'exec.command') void this.onExec(m.payload as ExecCommandPayload);
    else if (m.type === 'sense.request') void this.onSense(m.payload as SenseRequestPayload);
  }

  private async onExec(p: ExecCommandPayload): Promise<void> {
    const ack = (a: Partial<ExecAckPayload>) => this.send('exec.ack', { execId: p.execId, ok: false, sentAt: Date.now(), ...a }, { to: 'server' });
    const op = p.op;
    if (op.kind !== 'ir') return ack({ error: 'unsupported', detail: `the Nature Remo only sends IR (${op.kind} asked)` });
    let frame: RemoFrame;
    try {
      frame = opToFrame(op);
    } catch (e) {
      return ack({ error: 'bad_args', detail: (e as Error).message.slice(0, 200) });
    }
    if (p.dryRun) return ack({ ok: true, detail: `dry run: ${frame.data.length} timings at ${frame.freq} kHz, not sent` });
    if (!this.allowSend) return ack({ error: 'refused', detail: 'sending IR through the Nature Remo is not approved yet (REMO_SEND=1 once the user says yes)' });
    const wait = this.lastSendAt + (this.o.minSendGapMs ?? REMO_MIN_SEND_GAP_MS) - Date.now();
    if (wait > 0) await sleep(wait);
    const t0 = Date.now();
    try {
      await this.o.remo.postMessage(frame);
      this.lastSendAt = Date.now();
      this.sends++;
      ack({ ok: true, sentAt: this.lastSendAt, latencyMs: this.lastSendAt - t0, detail: `Remo sent ${frame.data.length} timings at ${frame.freq} kHz${op.ref ? ` [${op.ref}]` : ''}` });
    } catch (e) {
      this.lastError = (e as Error).message;
      ack({ error: 'device_error', detail: `the Remo did not take the frame: ${this.lastError}`.slice(0, 300) });
    }
  }

  /** LEARN: poll GET /messages for the window; every signal that differs from the previous one is a capture. */
  private async onSense(p: SenseRequestPayload): Promise<void> {
    const result = (r: Partial<SenseResultPayload>) => this.send('sense.result', { senseId: p.senseId, kind: p.kind, at: Date.now(), ...r }, { to: 'server' });
    if (p.kind !== 'ir-capture') return result({ ok: false, error: `the Nature Remo cannot sense ${p.kind}; it only receives IR` });
    const windowMs = Math.min(60_000, Math.max(1000, p.durationMs ?? 8000));
    const until = Date.now() + windowMs;
    let baseline: number[] | undefined;
    try {
      baseline = (await this.o.remo.getMessages())?.data;
    } catch (e) {
      this.lastError = (e as Error).message;
      return result({ ok: false, error: `the Remo is unreachable: ${this.lastError}`.slice(0, 300) });
    }
    let seen = 0;
    while (Date.now() < until && !this.stopped) {
      await sleep(this.o.pollMs ?? REMO_POLL_MS);
      let f: RemoFrame | undefined;
      try {
        f = await this.o.remo.getMessages();
      } catch (e) {
        this.lastError = (e as Error).message;
        continue;
      }
      if (!f || sameFrame(f.data, baseline)) continue;
      baseline = f.data;
      const ir = frameToCapture(f);
      if (ir.rawUs.length < 2) continue;
      seen++;
      this.captures++;
      result({ ok: true, ir });
      this.log(`[remo] new IR signal: ${ir.rawUs.length} timings at ${ir.khz} kHz${p.prompt ? ` (${p.prompt})` : ''}`);
    }
    if (!seen) result({ ok: false, error: `no new IR signal reached the Remo within ${Math.round(windowMs / 1000)} s` });
  }

  private send<T extends MessageType>(type: T, payload: PayloadOf<T>, opts: { to?: string } = {}): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(makeMessage(type, payload, opts)));
  }
}

// --- discovery (mDNS, no dependency) -------------------------------------------------------------

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;
const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_SRV = 33;

function encodeName(name: string): Buffer {
  const parts = name.replace(/\.$/, '').split('.');
  const out: number[] = [];
  for (const p of parts) {
    const b = Buffer.from(p, 'utf8');
    out.push(b.length, ...b);
  }
  out.push(0);
  return Buffer.from(out);
}

/** One PTR question for the service, asking for a unicast reply (QU bit) so no 5353 bind is needed. */
export function buildMdnsQuery(service = REMO_SERVICE): Buffer {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(0, 0); // id
  head.writeUInt16BE(0, 2); // flags: standard query
  head.writeUInt16BE(1, 4); // qdcount
  const q = Buffer.alloc(4);
  q.writeUInt16BE(TYPE_PTR, 0);
  q.writeUInt16BE(0x8001, 2); // IN, unicast response requested
  return Buffer.concat([head, encodeName(service), q]);
}

function readName(buf: Buffer, offset: number, depth = 0): { name: string; next: number } {
  const labels: string[] = [];
  let i = offset;
  let next = -1;
  while (i < buf.length) {
    const len = buf[i];
    if (len === 0) {
      i++;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (depth > 8) throw new Error('mDNS name loops');
      const ptr = ((len & 0x3f) << 8) | buf[i + 1];
      if (next < 0) next = i + 2;
      const inner = readName(buf, ptr, depth + 1);
      labels.push(inner.name);
      i = next;
      return { name: labels.filter(Boolean).join('.'), next: i };
    }
    labels.push(buf.toString('utf8', i + 1, i + 1 + len));
    i += 1 + len;
  }
  return { name: labels.join('.'), next: next < 0 ? i : next };
}

export interface MdnsRecord {
  name: string;
  type: number;
  ttl: number;
  /** PTR: target name; A: dotted IPv4; SRV: {target, port}; others: raw bytes */
  data: string | { target: string; port: number } | Buffer;
}

/** Parse the answer + authority + additional sections of an mDNS response. */
export function parseMdnsResponse(buf: Buffer): MdnsRecord[] {
  if (buf.length < 12) return [];
  const qd = buf.readUInt16BE(4);
  const counts = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let i = 12;
  for (let q = 0; q < qd; q++) i = readName(buf, i).next + 4;
  const out: MdnsRecord[] = [];
  for (let r = 0; r < counts && i + 10 <= buf.length; r++) {
    const { name, next } = readName(buf, i);
    const type = buf.readUInt16BE(next);
    const ttl = buf.readUInt32BE(next + 4);
    const len = buf.readUInt16BE(next + 8);
    const start = next + 10;
    const rdata = buf.subarray(start, start + len);
    if (type === TYPE_PTR) out.push({ name, type, ttl, data: readName(buf, start).name });
    else if (type === TYPE_A && len === 4) out.push({ name, type, ttl, data: [...rdata].join('.') });
    else if (type === TYPE_SRV && len >= 6) out.push({ name, type, ttl, data: { target: readName(buf, start + 6).name, port: rdata.readUInt16BE(4) } });
    else out.push({ name, type, ttl, data: Buffer.from(rdata) });
    i = start + len;
  }
  return out;
}

export interface RemoFound {
  host: string;
  port: number;
  name: string;
}

/** Pick the Remo out of parsed records: SRV target + its A record, else any A record for a "Remo-…" host. */
export function remoFromRecords(records: MdnsRecord[], service = REMO_SERVICE): RemoFound | undefined {
  const instance = records.find((r) => r.type === TYPE_PTR && r.name.toLowerCase() === service.toLowerCase());
  const srv = records.find((r) => r.type === TYPE_SRV && (!instance || r.name === instance.data)) as (MdnsRecord & { data: { target: string; port: number } }) | undefined;
  const a = (host: string) => records.find((r) => r.type === TYPE_A && r.name.toLowerCase() === host.toLowerCase()) as (MdnsRecord & { data: string }) | undefined;
  if (srv) {
    const ip = a(srv.data.target);
    return { host: ip?.data ?? srv.data.target, port: srv.data.port || 80, name: srv.name.replace(/\._remo\._tcp\.local$/i, '') };
  }
  const remoHost = records.find((r) => r.type === TYPE_A && /^remo-/i.test(r.name)) as (MdnsRecord & { data: string }) | undefined;
  if (remoHost) return { host: remoHost.data, port: 80, name: remoHost.name.replace(/\.local$/i, '') };
  return undefined;
}

/** Ask the LAN for `_remo._tcp` and return the first Remo that answers, or undefined after the timeout. */
export function discoverRemo(opts: { timeoutMs?: number; service?: string } = {}): Promise<RemoFound | undefined> {
  const service = opts.service ?? REMO_SERVICE;
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const records: MdnsRecord[] = [];
    let done = false;
    const finish = (r: RemoFound | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        // already closed
      }
      resolve(r);
    };
    const timer = setTimeout(() => finish(remoFromRecords(records, service)), opts.timeoutMs ?? 4000);
    sock.on('error', () => finish(remoFromRecords(records, service)));
    sock.on('message', (msg) => {
      try {
        records.push(...parseMdnsResponse(msg));
      } catch {
        return;
      }
      const found = remoFromRecords(records, service);
      if (found && /^\d+\.\d+\.\d+\.\d+$/.test(found.host)) finish(found);
    });
    sock.bind(0, () => {
      const q = buildMdnsQuery(service);
      sock.send(q, 0, q.length, MDNS_PORT, MDNS_ADDR, (e) => {
        if (e) finish(undefined);
      });
    });
  });
}

// --- start-up ------------------------------------------------------------------------------------

export interface RemoConfig {
  /** REMO_HOST: "192.168.1.11" or "192.168.1.11:80" or a full http:// base */
  host?: string;
  /** CE_REMO=1: find the Remo with mDNS when REMO_HOST is not set */
  discover: boolean;
  /** REMO_SEND=1: the user approved firing IR; otherwise sends are refused */
  send: boolean;
}

export function resolveRemoConfig(env: NodeJS.ProcessEnv): RemoConfig {
  return { host: env.REMO_HOST?.trim() || undefined, discover: env.CE_REMO === '1', send: env.REMO_SEND === '1' };
}

/**
 * Start the bridge when configured. Returns undefined (and touches no network) when neither REMO_HOST nor
 * CE_REMO=1 is set, or when discovery finds nothing.
 */
export async function startRemoBridge(o: { config: RemoConfig; serverBase: string; dataDir: string; log?: (line: string) => void; fetchImpl?: typeof fetch; discover?: typeof discoverRemo }): Promise<RemoBridge | undefined> {
  const log = o.log ?? (() => {});
  let host = o.config.host;
  let name = 'Nature Remo';
  if (!host && o.config.discover) {
    const found = await (o.discover ?? discoverRemo)({ timeoutMs: 4000 });
    if (!found) {
      log('[remo] no Nature Remo answered on the LAN (mDNS _remo._tcp); set REMO_HOST=<ip> to bridge one');
      return undefined;
    }
    host = found.port && found.port !== 80 ? `${found.host}:${found.port}` : found.host;
    name = `Nature Remo (${found.name})`;
  }
  if (!host) return undefined;
  const base = /^https?:\/\//.test(host) ? host : `http://${host}`;
  const bridge = new RemoBridge({ serverBase: o.serverBase, remo: new RemoClient(base, { fetchImpl: o.fetchImpl }), name, allowSend: o.config.send, tokenFile: join(o.dataDir, 'remo-bridge.json'), fetchImpl: o.fetchImpl, log });
  await bridge.start();
  return bridge;
}
