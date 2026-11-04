/**
 * Byte pipes to a DJI Osmo Mobile. Everything above this file (framing, clamps, coalescing) is shared; a link only
 * opens the gimbal, writes packets and hands back notification chunks.
 *
 *   mock  an in-process twin of the gimbal: decodes the real DUML rotation packets, slews at the commanded speed,
 *         pushes attitude and battery as real DUML notifications. Default; never touches Bluetooth.
 *   ble   CoreBluetooth through the bleak helper (osmo_ble.py, run with uv). macOS asks the app that started the
 *         server (Terminal, iTerm…) for Bluetooth permission once; a process without that permission is killed by
 *         macOS, which this link reports instead of crashing the server.
 *   web   Chrome Web Bluetooth: the bridge serves a one-button page on localhost; the page pipes bytes over a
 *         loopback WebSocket. For when the server runs somewhere macOS will not grant Bluetooth.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { sameBridgeOrigin, trustedServerHost } from '../../origin';
import { isLoopback } from '../../net';
import { DumlStream, fromHex, parseDuml, toHex } from './duml';
import { type Attitude, attitudePushPacket, batteryPushPacket, decodeRotate, OSMO_LIMITS, OSMO_NOTIFY_UUID, OSMO_SERVICE_UUID, OSMO_WRITE_UUID } from './om';

export type LinkKind = 'mock' | 'ble' | 'web';

export interface LinkInfo {
  kind: LinkKind;
  /** the gimbal's advertised name (or "Osmo twin") */
  name: string;
  address?: string;
  mtu?: number;
}

export interface GimbalLink {
  readonly kind: LinkKind;
  readonly info?: LinkInfo;
  readonly connected: boolean;
  /** open the gimbal; rejects with a readable reason */
  open(signal?: AbortSignal): Promise<LinkInfo>;
  /** write one DUML packet (the link chunks it) */
  write(packet: Uint8Array): Promise<void>;
  /** raw notification bytes from the gimbal */
  onData(cb: (chunk: Uint8Array) => void): void;
  onClose(cb: (why: string) => void): void;
  close(): Promise<void>;
}

// --- mock ---------------------------------------------------------------------------------------------

/** A gimbal twin: what a real OM 4 reports, at the speed it was asked to move. */
export class MockGimbalLink implements GimbalLink {
  readonly kind = 'mock' as const;
  info?: LinkInfo;
  connected = false;
  /** every rotation the twin received (tests, the CLI's dry run) */
  readonly received: { mode: string; attitude: Attitude; durationMs: number; at: number }[] = [];
  attitude: Attitude = { yaw: 0, pitch: 0, roll: 0 };
  battery = 82;
  private from: Attitude = { yaw: 0, pitch: 0, roll: 0 };
  private to: Attitude = { yaw: 0, pitch: 0, roll: 0 };
  private t0 = 0;
  private t1 = 0;
  private seq = 0;
  private timer?: ReturnType<typeof setInterval>;
  private ticks = 0;
  private data: ((c: Uint8Array) => void)[] = [];
  private closed: ((why: string) => void)[] = [];
  private stream = new DumlStream();

  constructor(private readonly o: { pushHz?: number; now?: () => number; chunk?: number } = {}) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  async open(): Promise<LinkInfo> {
    this.connected = true;
    this.info = { kind: 'mock', name: 'Osmo twin (mock)', mtu: 23 };
    const hz = this.o.pushHz ?? 10;
    this.timer = setInterval(() => this.tick(), Math.round(1000 / hz));
    return this.info;
  }

  /** current interpolated attitude */
  sample(): Attitude {
    const t = this.now();
    if (t >= this.t1) return { ...this.to };
    const k = Math.max(0, Math.min(1, (t - this.t0) / Math.max(1, this.t1 - this.t0)));
    return { yaw: this.from.yaw + (this.to.yaw - this.from.yaw) * k, pitch: this.from.pitch + (this.to.pitch - this.from.pitch) * k, roll: this.from.roll + (this.to.roll - this.from.roll) * k };
  }

  private tick(): void {
    this.attitude = this.sample();
    this.emit(attitudePushPacket(this.attitude, this.seq++ & 0xffff));
    if (this.ticks++ % 20 === 0) this.emit(batteryPushPacket(this.battery, false, this.seq++ & 0xffff));
  }

  private emit(packet: Uint8Array): void {
    // real notifications arrive in MTU-sized pieces; the twin splits them too so the reassembly path runs
    const size = this.o.chunk ?? 20;
    for (let i = 0; i < packet.length; i += size) {
      const c = packet.slice(i, i + size);
      for (const cb of this.data) cb(c);
    }
  }

  async write(packet: Uint8Array): Promise<void> {
    if (!this.connected) throw new Error('mock gimbal is closed');
    for (const p of this.stream.feed(packet)) {
      const r = decodeRotate(p);
      if (!r) continue;
      const now = this.now();
      this.received.push({ ...r, at: now });
      const cur = this.sample();
      let target: Attitude;
      if (r.mode === 'absolute') target = r.attitude;
      else if (r.mode === 'relative') target = { yaw: cur.yaw + r.attitude.yaw, pitch: cur.pitch + r.attitude.pitch, roll: cur.roll + r.attitude.roll };
      else target = cur; // speed mode: the twin only models "speed 0 = hold"
      // the real gimbal's mechanical stops, a little wider than ControlAnything's own clamp
      target = { yaw: Math.max(-160, Math.min(170, target.yaw)), pitch: Math.max(-100, Math.min(100, target.pitch)), roll: Math.max(-130, Math.min(130, target.roll)) };
      this.from = cur;
      this.to = target;
      this.t0 = now;
      this.t1 = now + Math.max(r.durationMs, 1);
    }
  }

  onData(cb: (chunk: Uint8Array) => void): void {
    this.data.push(cb);
  }

  onClose(cb: (why: string) => void): void {
    this.closed.push(cb);
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (!this.connected) return;
    this.connected = false;
    for (const cb of this.closed) cb('closed');
  }
}

// --- ble (bleak helper) -------------------------------------------------------------------------------

export const HELPER_PATH = fileURLToPath(new URL('./osmo_ble.py', import.meta.url));
export const BLEAK_VERSION = '3.0.2';

/** `uv run` for the helper, resolving only packages published at least 8 days ago (supply-chain rule). */
export function helperCommand(args: string[], now = new Date()): { cmd: string; args: string[] } {
  const cutoff = new Date(now.getTime() - 8 * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z');
  return { cmd: process.env.OSMO_UV ?? 'uv', args: ['run', '--no-project', '--quiet', '--exclude-newer', cutoff, '--with', `bleak==${BLEAK_VERSION}`, 'python', HELPER_PATH, ...args] };
}

/** macOS kills a process that touches Bluetooth without permission (SIGABRT, exit 134): say what to do. */
export function explainExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal === 'SIGABRT' || code === 134) {
    return 'macOS blocked Bluetooth for this process (no Bluetooth permission). Start the server from Terminal or iTerm and allow Bluetooth when asked, or use CE_OSMO=web (Chrome Web Bluetooth).';
  }
  return `the BLE helper exited (${signal ?? `code ${code}`})`;
}

interface HelperEvent {
  ev: string;
  msg?: string;
  hex?: string;
  name?: string;
  address?: string;
  mtu?: number;
}

export class BleakGimbalLink implements GimbalLink {
  readonly kind = 'ble' as const;
  info?: LinkInfo;
  connected = false;
  private proc?: ChildProcess;
  private data: ((c: Uint8Array) => void)[] = [];
  private closed: ((why: string) => void)[] = [];
  private lastError = '';

  constructor(private readonly o: { address?: string; name?: string; timeoutS?: number; log?: (l: string) => void } = {}) {}

  open(signal?: AbortSignal): Promise<LinkInfo> {
    const args = ['connect', '--timeout', String(this.o.timeoutS ?? 15)];
    if (this.o.address) args.push('--address', this.o.address);
    if (this.o.name) args.push('--name', this.o.name);
    const { cmd, args: full } = helperCommand(args);
    return new Promise((resolve, reject) => {
      let settled = false;
      const proc = spawn(cmd, full, { stdio: ['pipe', 'pipe', 'pipe'] });
      // A write racing the helper's exit must not raise an unhandled EPIPE and crash the server.
      proc.stdin.on('error', () => {});
      this.proc = proc;
      const fail = (why: string) => {
        if (!settled) {
          settled = true;
          reject(new Error(why));
        }
      };
      signal?.addEventListener('abort', () => {
        proc.kill('SIGTERM');
        fail('cancelled');
      }, { once: true });
      let buf = '';
      proc.stdout!.setEncoding('utf8');
      proc.stdout!.on('data', (s: string) => {
        buf += s;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let e: HelperEvent;
          try {
            e = JSON.parse(line) as HelperEvent;
          } catch {
            continue;
          }
          if (e.ev === 'rx' && e.hex) {
            const chunk = fromHex(e.hex);
            for (const cb of this.data) cb(chunk);
          } else if (e.ev === 'connected') {
            this.connected = true;
            this.info = { kind: 'ble', name: e.name || 'DJI gimbal', address: e.address, mtu: e.mtu };
            if (!settled) {
              settled = true;
              resolve(this.info);
            }
          } else if (e.ev === 'error') {
            this.lastError = e.msg ?? 'error';
            this.o.log?.(`[osmo] ble: ${this.lastError}`);
            fail(this.lastError);
          } else if (e.ev === 'log') this.o.log?.(`[osmo] ble: ${e.msg}`);
        }
      });
      proc.stderr!.setEncoding('utf8');
      proc.stderr!.on('data', (s: string) => {
        const t = s.trim();
        if (t) this.o.log?.(`[osmo] ble helper: ${t.slice(0, 300)}`);
      });
      proc.on('error', (e) => fail(`could not start the BLE helper (${e.message}); is uv installed?`));
      proc.on('exit', (code, sig) => {
        const why = this.lastError || explainExit(code, sig);
        const was = this.connected;
        this.connected = false;
        fail(why);
        if (was) for (const cb of this.closed) cb(why);
      });
    });
  }

  async write(packet: Uint8Array): Promise<void> {
    if (!this.connected || !this.proc?.stdin?.writable) throw new Error('the gimbal is not connected');
    this.proc.stdin.write(`${JSON.stringify({ op: 'tx', hex: toHex(packet) })}\n`);
  }

  onData(cb: (chunk: Uint8Array) => void): void {
    this.data.push(cb);
  }

  onClose(cb: (why: string) => void): void {
    this.closed.push(cb);
  }

  async close(): Promise<void> {
    const p = this.proc;
    if (!p) return;
    try {
      p.stdin?.write(`${JSON.stringify({ op: 'close' })}\n`);
    } catch {
      // already gone
    }
    setTimeout(() => p.kill('SIGTERM'), 1500).unref();
  }
}

/** One scan without connecting: what is advertising nearby, and which ones look like a DJI gimbal. */
export function scanBle(seconds = 8): Promise<{ results: { name: string; address: string; rssi: number; gimbal: boolean; dji: boolean }[]; error?: string }> {
  const { cmd, args } = helperCommand(['scan', '--seconds', String(seconds)]);
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const results: { name: string; address: string; rssi: number; gimbal: boolean; dji: boolean }[] = [];
    let error: string | undefined;
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (s: string) => {
      buf += s;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const e = JSON.parse(line) as { ev: string; name: string; address: string; rssi: number; gimbal: boolean; dji: boolean; msg?: string };
          if (e.ev === 'seen') results.push({ name: e.name, address: e.address, rssi: e.rssi, gimbal: e.gimbal, dji: e.dji });
          if (e.ev === 'error') error = e.msg;
        } catch {
          // not ours
        }
      }
    });
    proc.on('error', (e) => resolve({ results, error: `could not start the BLE helper (${e.message})` }));
    proc.on('exit', (code, sig) => resolve({ results, error: error ?? (code === 0 ? undefined : explainExit(code, sig)) }));
  });
}

// --- web (Chrome Web Bluetooth on a loopback page) ----------------------------------------------------

export const WEB_LINK_PORT = 8799;

/** The whole page: one button, Web Bluetooth, a byte pipe. All protocol logic stays on the server. */
export function webLinkPage(wsPath: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Osmo link</title><style>
:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f16;color:#f8fafc;font:15px/1.5 Inter,system-ui,sans-serif}
main{width:min(420px,calc(100vw - 32px));padding:24px;border-radius:20px;background:rgba(15,20,29,.84);border:1px solid rgba(255,255,255,.16)}
h1{font-size:18px;font-weight:600;margin:0 0 6px}p{color:#94a3b8;margin:0 0 18px}button{font:inherit;font-weight:600;padding:12px 18px;border-radius:12px;border:0;background:#38bdf8;color:#04121c;cursor:pointer}
#s{margin-top:16px;font-family:"JetBrains Mono",monospace;font-size:13px;color:#94a3b8;white-space:pre-wrap}
</style></head><body><main><h1>Connect the Osmo</h1><p>ControlAnything talks to the DJI gimbal through this tab. Keep it open.</p>
<button id="b">Connect gimbal</button> <button id="a" style="background:transparent;color:#94a3b8;border:1px solid rgba(255,255,255,.16)">Show all devices</button><div id="s">idle</div></main><script>
const S="${OSMO_SERVICE_UUID}",N="${OSMO_NOTIFY_UUID}",W="${OSMO_WRITE_UUID}";
const s=document.getElementById('s');const say=t=>s.textContent=t;
let ws,wc,q=Promise.resolve(),dev,retry=0;
function pipe(name){const my=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+${JSON.stringify(wsPath)});ws=my;my.binaryType='arraybuffer';
my.onmessage=e=>{const d=new Uint8Array(e.data);q=q.then(async()=>{for(let i=0;i<d.length;i+=20){const c=d.slice(i,i+20);
if(wc.properties.writeWithoutResponse)await wc.writeValueWithoutResponse(c);else await wc.writeValue(c);}}).catch(x=>say('write failed: '+x.message));};
my.onopen=()=>{my.send(JSON.stringify({hello:name}));say('connected: '+name+'\\nleave this tab open');};
my.onclose=()=>{if(ws!==my||!dev||!dev.gatt.connected)return;say('server restarting · reconnecting…');setTimeout(()=>{if(ws===my&&dev&&dev.gatt.connected)pipe(name);},2000);};}
async function attach(){const name=dev.name||'DJI gimbal';say('connecting to '+name+'…');
const g=await dev.gatt.connect();const sv=await g.getPrimaryService(S);
const nc=await sv.getCharacteristic(N);wc=await sv.getCharacteristic(W);await nc.startNotifications();
nc.addEventListener('characteristicvaluechanged',e=>{const v=e.target.value;if(ws&&ws.readyState===1)ws.send(new Uint8Array(v.buffer,v.byteOffset,v.byteLength));});
retry=0;pipe(name);}
async function reconnect(){if(!dev)return;ws&&ws.close();
for(retry=1;retry<=30&&dev&&!dev.gatt.connected;retry++){say('gimbal disconnected · reconnecting ('+retry+')…');
await new Promise(r=>setTimeout(r,Math.min(10000,1500*retry)));try{await attach();return;}catch(x){}}
if(dev&&!dev.gatt.connected)say('gimbal disconnected · switch it on, then press Connect gimbal');}
const go=all=>async()=>{try{
dev=await navigator.bluetooth.requestDevice(all?{acceptAllDevices:true,optionalServices:[S]}:{filters:[{services:[S]},{namePrefix:'OM'},{namePrefix:'Osmo'},{namePrefix:'DJI'}],optionalServices:[S]});
dev.addEventListener('gattserverdisconnected',()=>{void reconnect();});
await attach();
}catch(x){say('not connected: '+x.message);}};
document.getElementById('b').onclick=go(false);document.getElementById('a').onclick=go(true);
</script></body></html>`;
}

export class WebBluetoothGimbalLink implements GimbalLink {
  readonly kind = 'web' as const;
  info?: LinkInfo;
  private server?: Server;
  private wss?: WebSocketServer;
  private sock?: WebSocket;
  private data: ((c: Uint8Array) => void)[] = [];
  private closed: ((why: string) => void)[] = [];
  private waiting?: { resolve: (i: LinkInfo) => void; reject: (e: Error) => void };

  constructor(private readonly o: { port?: number; log?: (l: string) => void } = {}) {}

  get connected(): boolean {
    return this.sock?.readyState === 1;
  }

  get url(): string {
    const address = this.server?.address();
    return `http://localhost:${address && typeof address !== 'string' ? address.port : this.o.port ?? WEB_LINK_PORT}/`;
  }

  /** Serve the page and wait (until `signal`) for a tab to pipe a gimbal in. */
  async open(signal?: AbortSignal): Promise<LinkInfo> {
    if (!this.server) await this.listen();
    if (this.connected && this.info) return this.info;
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
      signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    });
  }

  private listen(): Promise<void> {
    const port = this.o.port ?? WEB_LINK_PORT;
    const page = webLinkPage('/pipe');
    this.server = createServer((req, res) => {
      if (!trustedServerHost(req.headers.host)) { res.writeHead(403); res.end(); return; }
      if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(page);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    this.wss = new WebSocketServer({ server: this.server, path: '/pipe', maxPayload: 64 * 1024,
      verifyClient: ({ req }: { req: IncomingMessage }) => {
        const address = this.server?.address();
        const listeningPort = address && typeof address !== 'string' ? address.port : port;
        return isLoopback(req.socket.remoteAddress) && trustedServerHost(req.headers.host)
          && sameBridgeOrigin(req.headers, [listeningPort]);
      },
    });
    this.wss.on('connection', (ws, req) => {
      // loopback only: the page and the server are on this Mac
      const ip = req.socket.remoteAddress ?? '';
      if (!/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(ip)) return ws.close();
      this.sock?.close();
      this.sock = ws;
      ws.on('message', (d, isBinary) => {
        if (!isBinary) {
          try {
            const j = JSON.parse(d.toString()) as { hello?: string };
            if (j.hello) {
              this.info = { kind: 'web', name: j.hello.slice(0, 60) };
              this.o.log?.(`[osmo] web link: ${this.info.name} connected through Chrome`);
              this.waiting?.resolve(this.info);
              this.waiting = undefined;
            }
          } catch {
            // ignore
          }
          return;
        }
        const chunk = new Uint8Array(d as Buffer);
        for (const cb of this.data) cb(chunk);
      });
      ws.on('close', () => {
        if (this.sock !== ws) return;
        this.sock = undefined;
        for (const cb of this.closed) cb('the Chrome tab closed or the gimbal disconnected');
      });
    });
    const server = this.server;
    return new Promise((resolve, reject) => {
      server.once('error', (e) => {
        // A busy port must not leave a half-open server that the next retry mistakes for a listening one.
        this.wss?.close(); this.wss = undefined;
        server.close(); if (this.server === server) this.server = undefined;
        reject(e);
      });
      server.listen(port, '127.0.0.1', () => resolve());
    });
  }

  async write(packet: Uint8Array): Promise<void> {
    if (!this.connected) throw new Error('no Chrome tab is connected to the gimbal');
    this.sock!.send(packet);
  }

  onData(cb: (chunk: Uint8Array) => void): void {
    this.data.push(cb);
  }

  onClose(cb: (why: string) => void): void {
    this.closed.push(cb);
  }

  async close(): Promise<void> {
    this.sock?.close();
    this.wss?.close();
    this.server?.close();
    this.server = undefined;
  }
}

export function createLink(kind: LinkKind, o: { log?: (l: string) => void; address?: string; name?: string; port?: number } = {}): GimbalLink {
  if (kind === 'ble') return new BleakGimbalLink(o);
  if (kind === 'web') return new WebBluetoothGimbalLink(o);
  return new MockGimbalLink();
}

export { parseDuml, OSMO_LIMITS };
