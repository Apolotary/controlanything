import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AnyMessage, makeMessage, type MessageType, type PayloadOf } from '@ce/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp } from './app';
import type { ServerConfig } from './config';
import { createContext, type RunningServers, type ServerContext, startServers } from './context';
import { CLOSE_UNAUTHORIZED } from './hub';
import { resolveMuseConfig } from './muse';

// --- harness ------------------------------------------------------------------------------

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Harness {
  ctx: ServerContext;
  servers: RunningServers;
  base: string;
  wsUrl: string;
  /** flip to simulate requests/sockets from another machine (all test traffic is really loopback) */
  setLocal(v: boolean): void;
  tmp: string;
}

async function start(over: Partial<ServerConfig> = {}): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'ce-hub-'));
  const companion = join(tmp, 'companion');
  mkdirSync(companion);
  writeFileSync(join(companion, 'index.html'), '<!doctype html><title>companion test</title>');
  let local = true;
  const config: ServerConfig = {
    https: { host: '127.0.0.1', port: 0, enabled: false },
    http: { host: '127.0.0.1', port: 0, enabled: true },
    publicHost: '127.0.0.1',
    certDir: join(tmp, 'certs'),
    dataDir: join(tmp, 'data'),
    staticDirs: { companion, quest: join(tmp, 'quest-missing'), sim: join(tmp, 'sim-missing') },
    trustFirstDevice: false,
    trustLoopback: true,
    consoleApprove: false,
    muse: resolveMuseConfig({ FIXTURE_DELAY_MS: '0' }),
    ...over,
  };
  const ctx = createContext(config, { log: () => {}, registryFile: null, isLocal: () => local });
  const servers = await startServers(ctx, createApp(ctx));
  cleanups.push(async () => {
    await servers.close();
    rmSync(tmp, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${ctx.bound.http}`;
  return { ctx, servers, base, wsUrl: `ws://127.0.0.1:${ctx.bound.http}/ws`, setLocal: (v) => (local = v), tmp };
}

class Client {
  readonly inbox: AnyMessage[] = [];
  private waiters: (() => void)[] = [];
  closeCode?: number;
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      this.inbox.push(JSON.parse(d.toString()));
      for (const w of this.waiters.splice(0)) w();
    });
    ws.on('close', (code) => {
      this.closeCode = code;
      for (const w of this.waiters.splice(0)) w();
    });
  }
  static open(url: string, opts?: WebSocket.ClientOptions): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, opts);
      const c = new Client(ws);
      ws.once('open', () => resolve(c));
      ws.once('error', reject);
      cleanups.push(() => ws.terminate());
    });
  }
  send<T extends MessageType>(type: T, payload: PayloadOf<T>, opts: { to?: string } = {}): string {
    const m = makeMessage(type, payload, opts);
    this.ws.send(JSON.stringify(m));
    return m.id;
  }
  sendRaw(data: unknown): void {
    this.ws.send(typeof data === 'string' ? data : JSON.stringify(data));
  }
  /** Next message of `type` (consumed from the inbox). */
  async next<T extends MessageType>(type: T, timeoutMs = 2000): Promise<Extract<AnyMessage, { type: T }> & { payload: PayloadOf<T> }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.inbox.findIndex((m) => m.type === type);
      if (i >= 0) return this.inbox.splice(i, 1)[0] as any;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for ${type}; inbox: ${this.inbox.map((m) => m.type).join(', ') || '(empty)'}`);
      await new Promise<void>((r) => {
        const t = setTimeout(r, left);
        this.waiters.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
  }
  async closed(timeoutMs = 2000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (this.closeCode === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    return this.closeCode ?? -1;
  }
  has(type: string): boolean {
    return this.inbox.some((m) => m.type === type);
  }
}

async function json(res: Response): Promise<any> {
  return res.json();
}

async function pairLocally(h: Harness, name: string, kind: 'mac' | 'quest' | 'devterm' | 'cardputer' = 'mac') {
  h.setLocal(true);
  const res = await fetch(`${h.base}/api/pair/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: h.base }, body: JSON.stringify({ name, kind, capabilities: ['midi'] }) });
  expect(res.status).toBe(201);
  const body = await json(res);
  expect(body.status).toBe('approved');
  return body as { deviceId: string; deviceToken: string };
}

async function connect(h: Harness, token: string, extra: Partial<PayloadOf<'hello'>> = {}) {
  const c = await Client.open(h.wsUrl);
  c.send('hello', { deviceToken: token, ...extra });
  const welcome = await c.next('welcome');
  return { c, welcome: welcome.payload };
}

// --- tests --------------------------------------------------------------------------------

describe('pairing over WebSocket and relay', () => {
  it('shares owner master volume with all clients and late joins, while refusing a non-owner change', async () => {
    const h = await start(), mac = await pairLocally(h, 'Audio master'), guest = await pairLocally(h, 'Observer', 'devterm');
    h.setLocal(false);
    const { c: owner } = await connect(h, mac.deviceToken);
    expect((await owner.next('audio.master')).payload).toEqual({ volume: .35, muted: false });
    owner.send('audio.master', { volume: .62, muted: true }, { to: 'server' });
    expect((await owner.next('audio.master')).payload).toEqual({ volume: .62, muted: true });
    const { c: observer } = await connect(h, guest.deviceToken);
    expect((await observer.next('audio.master')).payload).toEqual({ volume: .62, muted: true });
    observer.send('audio.master', { volume: 1, muted: false }, { to: 'server' });
    expect((await observer.next('log')).payload.code).toBe('forbidden');
    expect(h.ctx.hub.audioMasterState).toEqual({ volume: .62, muted: true });
  });

  it('pairs a remote Cardputer via a paired Mac and relays control.event between them', async () => {
    const h = await start();
    const mac = await pairLocally(h, 'MacBook companion');
    h.setLocal(false); // from here on every socket looks like another machine on the LAN

    const { c: macWs, welcome } = await connect(h, mac.deviceToken, { ports: [{ id: 'out-1', kind: 'midi-out', name: 'Digitakt II' }] });
    expect(welcome).toMatchObject({ deviceId: mac.deviceId, kind: 'mac', role: 'companion', canApprove: true, mode: 'fixture' });
    const p0 = await macWs.next('presence');
    expect(p0.payload.devices.find((d) => d.deviceId === mac.deviceId)).toMatchObject({ online: true, ports: [{ name: 'Digitakt II' }] });

    // the Cardputer pairs over its socket
    const card = await Client.open(h.wsUrl);
    card.send('pair.start', { name: 'Cardputer', kind: 'cardputer', capabilities: ['ir', 'display'] });
    const status = await card.next('pair.status');
    expect(status.payload).toMatchObject({ status: 'pending' });
    expect(status.payload.qr).toBe(`http://127.0.0.1:${h.ctx.bound.http}/p/${status.payload.pairingId}#${status.payload.code}`);

    // the Mac sees it and approves by the code shown on the Cardputer
    const pending = await macWs.next('pair.pending');
    expect(pending.payload).toMatchObject({ name: 'Cardputer', kind: 'cardputer', display: status.payload.display });
    macWs.send('pair.approve', { code: status.payload.display! });

    const approved = await card.next('pair.approved');
    expect(approved.payload).toMatchObject({ name: 'Cardputer', kind: 'cardputer', canApprove: false, approvedBy: 'MacBook companion' });
    expect(approved.payload.deviceToken).toBeTruthy();
    const macCopy = await macWs.next('pair.approved');
    expect(macCopy.payload.deviceToken).toBeUndefined();

    // the token was delivered once over the socket, so polling no longer returns it
    const poll = await json(await fetch(`${h.base}/api/pair/status?pairingId=${status.payload.pairingId}&pollSecret=${status.payload.pollSecret}`));
    expect(poll).toMatchObject({ status: 'approved', deviceId: approved.payload.deviceId });
    expect(poll.deviceToken).toBeUndefined();

    // the Cardputer authenticates on the same socket; the server decides its kind and rights
    card.send('hello', { deviceToken: approved.payload.deviceToken!, role: 'device' });
    const cw = await card.next('welcome');
    expect(cw.payload).toMatchObject({ kind: 'cardputer', canApprove: false, role: 'device' });
    const joined = await macWs.next('presence');
    expect(joined.payload.devices.map((d) => d.kind).sort()).toEqual(['cardputer', 'mac']);

    // control.event mac -> cardputer, stamped with the sender's deviceId; the sender gets no echo
    macWs.inbox.length = 0;
    const sentId = macWs.send('control.event', { widgetId: 'brightness', value: 0.42, ts: Date.now(), phase: 'move' });
    const ev = await card.next('control.event');
    expect(ev).toMatchObject({ id: sentId, from: mac.deviceId, payload: { widgetId: 'brightness', value: 0.42 } });
    // and back
    card.send('driver.status', { driverId: 'ir-lamp', status: 'running' });
    expect((await macWs.next('driver.status')).from).toBe(approved.payload.deviceId);
    expect(macWs.has('control.event')).toBe(false);
  });

  it('runs one headset session per deviceId: the newest claim wins, the old tab is told, ignored and closed with 4409', async () => {
    const h = await start();
    const mac = await pairLocally(h, 'Mac');
    const quest = await pairLocally(h, 'Quest 3', 'quest');
    const { c: macWs } = await connect(h, mac.deviceToken);
    const { c: oldTab, welcome: w1 } = await connect(h, quest.deviceToken);
    expect(w1.role).toBe('hmd');
    const { c: newTab, welcome: w2 } = await connect(h, quest.deviceToken);
    const sup = await oldTab.next('session.superseded');
    expect(sup.payload).toMatchObject({ reason: 'newer-tab', graceMs: 500 });
    // presence counts only the newest headset socket
    const devices = h.ctx.hub.devices();
    expect(devices.find((d) => d.deviceId === quest.deviceId)).toMatchObject({ online: true, connections: 1 });
    // the old tab no longer steers anything; the new one does
    macWs.inbox.length = 0;
    oldTab.send('control.event', { widgetId: 'warp', value: 0.9, ts: Date.now(), phase: 'move' });
    newTab.send('control.event', { widgetId: 'warp', value: 0.2, ts: Date.now(), phase: 'move' });
    expect((await macWs.next('control.event')).payload).toMatchObject({ value: 0.2 });
    await new Promise((r) => setTimeout(r, 50));
    expect(macWs.has('control.event')).toBe(false);
    // server messages reach only the owner
    expect(h.ctx.hub.sendToDevice(quest.deviceId, 'log', { level: 'info', message: 'only new' })).toBe(1);
    expect((await newTab.next('log')).payload.message).toBe('only new');
    let report = await json(await fetch(`${h.base}/api/clients`));
    const row = report.devices.find((d: { deviceId: string }) => d.deviceId === quest.deviceId);
    expect(row.connections.map((c: { clientId: string; state: string }) => [c.clientId, c.state]).sort()).toEqual([[w1.clientId, 'superseded'], [w2.clientId, 'owner']].sort());
    expect(row.duplicateRoles).toEqual([]);
    expect(await oldTab.closed(3000)).toBe(4409);
    // a newer (visible) tab takes over again
    const { c: third } = await connect(h, quest.deviceToken, { foreground: true });
    expect((await newTab.next('session.superseded')).payload.reason).toBe('newer-tab');
    expect(await newTab.closed(3000)).toBe(4409);
    report = await json(await fetch(`${h.base}/api/clients`));
    expect(report.devices.find((d: { deviceId: string }) => d.deviceId === quest.deviceId).connections).toHaveLength(1);
    third.send('session.claim', {});
    await new Promise((r) => setTimeout(r, 50));
    expect(third.has('session.superseded')).toBe(false);
    // companion tabs are not single-instance (they elect their executor with Web Locks)
    const { c: mac2 } = await connect(h, mac.deviceToken, { executor: false });
    await new Promise((r) => setTimeout(r, 50));
    expect(mac2.has('session.superseded') || macWs.has('session.superseded')).toBe(false);
    expect((await json(await fetch(`${h.base}/api/health`))).clients.duplicates).toEqual([`${mac.deviceId}:companion`]);
  });

  it('a hidden (or older-build) headset tab that reconnects does not take over the visible tab in use', async () => {
    const h = await start();
    const quest = await pairLocally(h, 'Quest 3', 'quest');
    const { c: visible } = await connect(h, quest.deviceToken, { foreground: true });
    const hidden = await Client.open(h.wsUrl);
    hidden.send('hello', { deviceToken: quest.deviceToken, foreground: false });
    expect((await hidden.next('session.superseded')).payload.reason).toBe('other-tab-active');
    expect(hidden.has('welcome')).toBe(false);
    expect(await hidden.closed(3000)).toBe(4409);
    // an old build reports no visibility: it does not kick a tab that does
    const old = await Client.open(h.wsUrl);
    old.send('hello', { deviceToken: quest.deviceToken });
    expect((await old.next('session.superseded')).payload.reason).toBe('other-tab-active');
    expect(visible.has('session.superseded')).toBe(false);
    expect(h.ctx.hub.devices().find((d) => d.deviceId === quest.deviceId)).toMatchObject({ online: true, connections: 1 });
    // with nobody else in session, a hidden tab is the session (e.g. after a server restart it reconnected first)
    visible.ws.close();
    await visible.closed();
    const { c: alone } = await connect(h, quest.deviceToken, { foreground: false });
    const { c: front } = await connect(h, quest.deviceToken, { foreground: true });
    expect((await alone.next('session.superseded')).payload.reason).toBe('newer-tab');
    expect(front.has('session.superseded')).toBe(false);
  });

  it('two tabs of an old headset build (no visibility, reconnect after 4409) settle on one owner instead of ping-ponging', async () => {
    const h = await start();
    const quest = await pairLocally(h, 'Quest 3', 'quest');
    const { c: a } = await connect(h, quest.deviceToken);
    const { c: b, welcome: wb } = await connect(h, quest.deviceToken);
    expect((await a.next('session.superseded')).payload.reason).toBe('newer-tab');
    expect(await a.closed(3000)).toBe(4409);
    // the old build of tab A reconnects by itself: it must not kick B
    for (let i = 0; i < 3; i++) {
      const again = await Client.open(h.wsUrl);
      again.send('hello', { deviceToken: quest.deviceToken });
      expect((await again.next('session.superseded')).payload.reason).toBe('other-tab-active');
      expect(await again.closed(3000)).toBe(4409);
    }
    expect(b.has('session.superseded')).toBe(false);
    const owner = h.ctx.hub.clients().devices.find((d) => d.deviceId === quest.deviceId)!.connections.filter((r) => r.state === 'owner');
    expect(owner.map((r) => r.clientId)).toEqual([wb.clientId]);
  }, 20_000);

  it('refuses invalid, unauthenticated and server-only messages with log errors', async () => {
    const h = await start();
    const anon = await Client.open(h.wsUrl);
    anon.sendRaw('{not json');
    expect((await anon.next('log')).payload).toMatchObject({ level: 'error', code: 'invalid_message' });
    anon.send('control.event', { widgetId: 'w', value: 1, ts: 1 });
    expect((await anon.next('log')).payload.code).toBe('not_authenticated');
    anon.sendRaw({ ...makeMessage('control.event', { widgetId: 'w', value: 1, ts: 1 }), payload: { widgetId: 7 } });
    const invalid = (await anon.next('log')).payload;
    expect(invalid.code).toBe('invalid_message');
    expect(invalid.issues?.join()).toMatch(/widgetId/);

    const mac = await pairLocally(h, 'Mac');
    const { c } = await connect(h, mac.deviceToken);
    c.send('presence', { spaceId: 'x', devices: [] });
    expect((await c.next('log')).payload.code).toBe('server_only');

    const bad = await Client.open(h.wsUrl);
    bad.send('hello', { deviceToken: 'not-a-real-token' });
    expect((await bad.next('log')).payload.code).toBe('unauthorized');
    expect(await bad.closed()).toBe(CLOSE_UNAUTHORIZED);
  });

  it('only approvers may approve over the socket', async () => {
    const h = await start();
    const devterm = await pairLocally(h, 'DevTerm', 'devterm');
    h.setLocal(false);
    const { c } = await connect(h, devterm.deviceToken);
    const res = await fetch(`${h.base}/api/pair/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Cardputer', kind: 'cardputer' }) });
    const started = await json(res);
    expect(started.status).toBe('pending');
    expect(c.has('pair.pending')).toBe(false);
    c.send('pair.approve', { code: started.code });
    expect((await c.next('log')).payload.code).toBe('forbidden');
  });

  it('routes `to`, keeps to:"server" off the wire, relays x.* and lets the server talk back', async () => {
    const h = await start();
    // Helpers pair locally before the headset owns the room (afterwards the headset must approve them).
    const b = await pairLocally(h, 'Mac');
    const d = await pairLocally(h, 'DevTerm', 'devterm');
    const a = await pairLocally(h, 'Quest', 'quest');
    const qa = await connect(h, a.deviceToken);
    const mb = await connect(h, b.deviceToken);
    const dc = await connect(h, d.deviceToken);
    const seen: string[] = [];
    h.ctx.hub.onMessage((e) => seen.push(`${e.device.kind}:${e.message.type}`));

    qa.c.send('control.event', { widgetId: 'cutoff', value: 64, ts: 1 }, { to: b.deviceId });
    expect((await mb.c.next('control.event')).payload.value).toBe(64);
    qa.c.send('snapshot', { snapshotId: 's1', jpegBase64: '/9j/AA', capturedAt: 1, text: 'what is this?' }, { to: 'server' });
    qa.c.sendRaw({ v: 1, type: 'x.hand.pose', id: 'x1', ts: 1, from: 'spoofed', payload: { pinch: 0.9 }, extra: 'kept' });
    const x = (await dc.c.next('x.hand.pose' as MessageType)) as unknown as Record<string, unknown>;
    expect(x).toMatchObject({ from: a.deviceId, extra: 'kept', payload: { pinch: 0.9 } });
    qa.c.send('control.event', { widgetId: 'w', value: 1, ts: 1 }, { to: 'nobody' });
    expect((await qa.c.next('log')).payload.code).toBe('unknown_target');

    expect(dc.c.has('control.event')).toBe(false);
    expect(mb.c.has('snapshot') || dc.c.has('snapshot')).toBe(false);
    expect(seen).toEqual(['quest:control.event', 'quest:snapshot', 'quest:x.hand.pose', 'quest:control.event']);

    h.ctx.hub.broadcast('agent.step', { stepId: 'st1', phase: 'identify', status: 'running', title: 'Identifying the device', model: 'fixture', source: 'fixture' });
    const step = await mb.c.next('agent.step');
    expect(step.from).toBe('server');
    expect(h.ctx.hub.sendToDevice(d.deviceId, 'log', { level: 'info', message: 'hi' })).toBe(1);
    expect((await dc.c.next('log')).payload.message).toBe('hi');
  });
});

describe('HTTP API', () => {
  it('reports health without secrets', async () => {
    const h = await start({ muse: resolveMuseConfig({ MODEL_API_KEY: 'sk-never-print', FIXTURE_DELAY_MS: '0' }) });
    const res = await fetch(`${h.base}/api/health`);
    const text = await res.text();
    expect(text).not.toContain('sk-never-print');
    const body = JSON.parse(text);
    expect(body).toMatchObject({ ok: true, mode: 'live', keyConfigured: true, models: { chat: 'muse-spark-1.3', transcribe: 'muse-voice-transcribe-1.0' }, protocol: 1 });
    expect(body.clients).toMatchObject({ connections: 0, devicesOnline: 0 });
    expect(typeof body.uptimeSec).toBe('number');
  });

  it('runs the HTTP pairing flow, with approval rights and revocation', async () => {
    const h = await start();
    const mac = await pairLocally(h, 'Mac');
    h.setLocal(false);
    const post = (path: string, body: unknown, token?: string) =>
      fetch(`${h.base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

    expect((await post('/api/pair/start', { name: 'x' })).status).toBe(400);
    const started = await json(await post('/api/pair/start', { name: 'DevTerm', kind: 'devterm', capabilities: ['serial'] }));
    expect(started).toMatchObject({ status: 'pending' });
    expect(started.qr).toMatch(new RegExp(`/p/${started.pairingId}#${started.code}$`));

    expect((await post('/api/pair/approve', { code: started.code })).status).toBe(401);
    expect((await fetch(`${h.base}/api/pair/pending`)).status).toBe(401);
    const pending = await json(await fetch(`${h.base}/api/pair/pending`, { headers: { Authorization: `Bearer ${mac.deviceToken}` } }));
    expect(pending.pending).toHaveLength(1);
    expect((await post('/api/pair/approve', { code: 'ZZZZZZ' }, mac.deviceToken)).status).toBe(400);
    const ok = await post('/api/pair/approve', { code: started.display }, mac.deviceToken);
    expect(ok.status).toBe(200);
    expect((await json(ok)).device).not.toHaveProperty('tokenHash');

    const s1 = await json(await fetch(`${h.base}/api/pair/status?pairingId=${started.pairingId}&pollSecret=${started.pollSecret}`));
    expect(s1.deviceToken).toBeTruthy();
    const s2 = await json(await fetch(`${h.base}/api/pair/status?pairingId=${started.pairingId}&pollSecret=${started.pollSecret}`));
    expect(s2.deviceToken).toBeUndefined();
    expect((await fetch(`${h.base}/api/pair/status?pairingId=${started.pairingId}&pollSecret=nope`)).status).toBe(403);

    // a devterm may not approve or list devices
    const another = await json(await post('/api/pair/start', { name: 'Cardputer', kind: 'cardputer' }));
    expect((await post('/api/pair/approve', { code: another.code }, s1.deviceToken)).status).toBe(403);
    expect((await fetch(`${h.base}/api/devices`, { headers: { Authorization: `Bearer ${s1.deviceToken}` } })).status).toBe(403);
    expect((await json(await fetch(`${h.base}/api/me`, { headers: { Authorization: `Bearer ${s1.deviceToken}` } }))).device.kind).toBe('devterm');

    // revoke: the connected socket is closed with 4401 and the token stops working
    const { c } = await connect(h, s1.deviceToken);
    const del = await fetch(`${h.base}/api/devices/${s1.deviceId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${mac.deviceToken}` } });
    expect(del.status).toBe(204);
    expect(await c.closed()).toBe(CLOSE_UNAUTHORIZED);
    expect((await fetch(`${h.base}/api/me`, { headers: { Authorization: `Bearer ${s1.deviceToken}` } })).status).toBe(401);
    const list = await json(await fetch(`${h.base}/api/devices`, { headers: { Authorization: `Bearer ${mac.deviceToken}` } }));
    expect(list.devices.map((d: { kind: string }) => d.kind)).toEqual(['mac']);
  });

  it('serves built apps, a not-built page, the QR redirect and transcription', async () => {
    const h = await start();
    const page = await fetch(`${h.base}/companion/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('companion test');
    expect((await fetch(`${h.base}/companion?x=1`, { redirect: 'manual' })).headers.get('location')).toBe('/companion/?x=1');
    expect((await fetch(`${h.base}/quest/`)).status).toBe(503);
    expect((await fetch(`${h.base}/p/abc123`, { redirect: 'manual' })).headers.get('location')).toBe('/companion/?approve=abc123');
    expect((await fetch(`${h.base}/api/nope`)).status).toBe(404);

    const { encodeWav } = await import('./muse');
    const wav = encodeWav(new Float32Array(2400), 24_000);
    const t = await fetch(`${h.base}/api/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav });
    expect(await json(t)).toMatchObject({ source: 'fixture', text: expect.stringContaining('FIXTURE') });
    h.setLocal(false);
    expect((await fetch(`${h.base}/api/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav })).status).toBe(401);
  });

  it('serves HTTPS and WSS with the generated dev certificate', async () => {
    const h = await start({ https: { host: '127.0.0.1', port: 0, enabled: true }, http: { host: '127.0.0.1', port: 0, enabled: false } });
    expect(h.servers.certRegenerated).toBe(true);
    expect(h.servers.certAltNames).toContain('IP:127.0.0.1');
    const ws = await Client.open(`wss://127.0.0.1:${h.ctx.bound.https}/ws`, { rejectUnauthorized: false, origin: `https://127.0.0.1:${h.ctx.bound.https}` });
    ws.send('pair.start', { name: 'Quest 3', kind: 'quest' });
    const st = await ws.next('pair.status');
    expect(st.payload.status).toBe('approved'); // loopback = owner
    expect((await ws.next('pair.approved')).payload.deviceToken).toBeTruthy();
    expect(st.payload.qr).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/p\//);
  }, 20_000);
});
