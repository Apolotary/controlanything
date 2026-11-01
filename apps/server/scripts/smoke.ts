/**
 * End-to-end smoke test against a running server (npm run dev / npm start):
 *   npm run smoke                      # http://127.0.0.1:8787
 *   npm run smoke -- http://host:8787
 *
 * 1. "smoke-mac" pairs from localhost (owner: approved instantly) and connects to /ws.
 * 2. "smoke-cardputer" pairs through the LAN address (not loopback, so it needs approval):
 *    the Mac gets pair.pending over its socket and approves by code; the Cardputer polls for its token.
 *    Without a LAN address it falls back to localhost.
 * 3. Both exchange control.event; the round trip is timed.
 * 4. Both smoke devices are revoked again, so the space is left as it was.
 */
import { lanIPv4 } from '../src/net';
import { type AnyMessage, makeMessage, type MessageType, parseMessage, type PayloadOf } from '@ce/protocol';
import WebSocket from 'ws';

const base = (process.argv[2] ?? process.env.SMOKE_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const wsOf = (b: string) => `${b.replace(/^http/, 'ws')}/ws`;

function ok(msg: string) {
  console.log(`  ok  ${msg}`);
}

async function req<T>(method: string, url: string, body?: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> HTTP ${res.status} ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

class Peer {
  inbox: AnyMessage[] = [];
  private wake: (() => void)[] = [];
  private constructor(readonly name: string, readonly ws: WebSocket) {
    ws.on('message', (d) => {
      const r = parseMessage(d.toString());
      if (r.ok) this.inbox.push(r.message);
      for (const w of this.wake.splice(0)) w();
    });
  }
  static open(name: string, url: string): Promise<Peer> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.once('open', () => resolve(new Peer(name, ws)));
      ws.once('error', reject);
    });
  }
  send<T extends MessageType>(type: T, payload: PayloadOf<T>) {
    this.ws.send(JSON.stringify(makeMessage(type, payload)));
  }
  async next<T extends MessageType>(type: T, timeoutMs = 5000): Promise<Extract<AnyMessage, { type: T }> & { payload: PayloadOf<T> }> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const i = this.inbox.findIndex((m) => m.type === type);
      if (i >= 0) return this.inbox.splice(i, 1)[0] as never;
      const left = until - Date.now();
      if (left <= 0) throw new Error(`${this.name}: no ${type} within ${timeoutMs} ms (got: ${this.inbox.map((m) => m.type).join(', ') || 'nothing'})`);
      await new Promise<void>((r) => {
        const t = setTimeout(r, left);
        this.wake.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
  }
}

async function main() {
  console.log(`smoke test against ${base}`);
  const health = await req<{ mode: string; models: { chat: string }; clients: unknown }>('GET', `${base}/api/health`);
  ok(`health: mode=${health.mode} chat=${health.models.chat}`);

  // 1. the owner
  const mac = await req<{ status: string; deviceId: string; deviceToken: string }>('POST', `${base}/api/pair/start`, { name: 'smoke-mac', kind: 'mac', capabilities: ['midi'] });
  if (mac.status !== 'approved') throw new Error(`expected localhost to be approved instantly, got ${mac.status} (is CE_TRUST_LOOPBACK=0?)`);
  ok(`smoke-mac paired from localhost as ${mac.deviceId}`);
  const a = await Peer.open('mac', wsOf(base));
  a.send('hello', { deviceToken: mac.deviceToken, role: 'companion', capabilities: ['midi'], app: 'smoke' });
  const wa = await a.next('welcome');
  ok(`mac welcome: canApprove=${wa.payload.canApprove}`);

  // 2. a device that needs approval: reach the server through its LAN address
  const port = new URL(base).port || '80';
  const lan = lanIPv4()[0];
  let bBase = base;
  if (lan && /^http:\/\/(127\.0\.0\.1|localhost)/.test(base)) {
    const candidate = `http://${lan}:${port}`;
    try {
      await req('GET', `${candidate}/api/health`);
      bBase = candidate;
    } catch {
      console.log(`  ..  ${candidate} unreachable (HTTP bound to localhost only?); pairing the second device via localhost`);
    }
  }
  const card = await req<{ status: string; pairingId: string; pollSecret: string; code: string; display: string; qr: string; deviceId?: string; deviceToken?: string }>(
    'POST',
    `${bBase}/api/pair/start`,
    { name: 'smoke-cardputer', kind: 'cardputer', capabilities: ['ir', 'display'] },
  );
  let cardId = card.deviceId;
  let cardToken = card.deviceToken;
  if (card.status === 'pending') {
    ok(`smoke-cardputer waiting via ${bBase} · code ${card.display} · qr ${card.qr}`);
    const p = await a.next('pair.pending');
    if (p.payload.pairingId !== card.pairingId) throw new Error('mac saw a different pending request');
    ok(`mac got pair.pending "${p.payload.name}" ${p.payload.display}`);
    a.send('pair.approve', { code: p.payload.display, pairingId: p.payload.pairingId });
    for (let i = 0; i < 20 && !cardToken; i++) {
      const s = await req<{ status: string; deviceId?: string; deviceToken?: string }>('GET', `${bBase}/api/pair/status?pairingId=${card.pairingId}&pollSecret=${card.pollSecret}`);
      if (s.status === 'approved') {
        cardId = s.deviceId;
        cardToken = s.deviceToken;
      } else if (s.status !== 'pending') throw new Error(`pairing ended: ${s.status}`);
      else await new Promise((r) => setTimeout(r, 150));
    }
    if (!cardToken) throw new Error('no device token after approval');
    ok(`approved by code; token delivered once to the cardputer (${cardId})`);
  } else {
    ok(`smoke-cardputer approved instantly (${card.status}) as ${cardId}`);
  }

  const b = await Peer.open('cardputer', wsOf(bBase));
  b.send('hello', { deviceToken: cardToken!, app: 'smoke' });
  const wb = await b.next('welcome');
  ok(`cardputer welcome: kind=${wb.payload.kind} role=${wb.payload.role} canApprove=${wb.payload.canApprove}`);

  // 3. control.event both ways
  a.inbox = [];
  const t0 = performance.now();
  a.send('control.event', { widgetId: 'brightness', value: 0.42, ts: Date.now(), phase: 'move' });
  const got = await b.next('control.event');
  const t1 = performance.now();
  if (got.from !== mac.deviceId || got.payload.value !== 0.42) throw new Error(`unexpected relay: ${JSON.stringify(got)}`);
  b.send('control.event', { widgetId: 'ack', value: true, ts: Date.now() });
  const back = await a.next('control.event');
  const t2 = performance.now();
  if (back.from !== cardId) throw new Error('reply not stamped with the cardputer id');
  ok(`control.event mac -> cardputer in ${(t1 - t0).toFixed(1)} ms, round trip ${(t2 - t0).toFixed(1)} ms`);

  // 4. clean up
  a.ws.close();
  b.ws.close();
  for (const id of [cardId!, mac.deviceId]) await req('DELETE', `${base}/api/devices/${id}`);
  ok('revoked both smoke devices');
  console.log('PASS');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`FAIL: ${(e as Error).message}`);
    process.exit(1);
  },
);
