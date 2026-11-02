/**
 * The Nature Remo bridge against a MOCK Remo (node http): frames, discovery parsing, and the whole loopback
 * path through the real hub and dispatcher — learn by polling GET /messages, sends refused until approved,
 * then POSTed >= 1 s apart. No real Remo is contacted anywhere in here.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeMessage, type AnyMessage, type ExecCommandPayload, type IrOp, type PayloadOf, type SenseRequestPayload } from '@ce/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAgent } from '../agent';
import { Dispatcher } from '../agent/dispatch';
import { pickExecutor, pickSensor } from '../agent/executors';
import { createApp } from '../app';
import type { ServerConfig } from '../config';
import { createContext, type RunningServers, startServers } from '../context';
import { resolveMuseConfig } from '../muse';
import { DeviceRegistry } from '../pairing/registry';
import { analyseCapture, encodeFrame } from './ir';
import { buildMdnsQuery, cleanFrame, frameToCapture, opToFrame, parseMdnsResponse, parseRemoFrame, RemoBridge, RemoClient, type RemoFrame, remoFromRecords, resolveRemoConfig, sameFrame, startRemoBridge } from './remo';

const SAMPLE = JSON.parse(readFileSync(new URL('../../fixtures/remo/messages.sample.json', import.meta.url), 'utf8')) as RemoFrame;
const OFF_BYTES = [0x2c, 0x52, 0x09, 0x2f, 0x26];

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  vi.useRealTimers();
});

// --- a fake Nature Remo ---------------------------------------------------------------------------

interface MockRemo {
  base: string;
  gets: number;
  posts: RemoFrame[];
  badHeader: number;
  /** the Remo "receives" a signal: GET returns it from now on */
  receive(f: RemoFrame | undefined): void;
}

function mockRemo(initial?: RemoFrame): Promise<MockRemo> {
  let frame = initial;
  const m: MockRemo = { base: '', gets: 0, posts: [], badHeader: 0, receive: (f) => (frame = f) };
  const server = http.createServer((req, res) => {
    if (req.headers['x-requested-with'] !== 'local') {
      m.badHeader++;
      res.writeHead(401).end();
      return;
    }
    if (req.url !== '/messages') {
      res.writeHead(404).end();
      return;
    }
    if (req.method === 'GET') {
      m.gets++;
      res.setHeader('content-type', 'application/json');
      res.end(frame ? JSON.stringify(frame) : '');
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        m.posts.push(JSON.parse(body) as RemoFrame);
        res.writeHead(200).end();
      });
      return;
    }
    res.writeHead(405).end();
  });
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      m.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve(m);
    });
  });
}

// --- a real server on a free port -----------------------------------------------------------------

async function startServer() {
  const tmp = mkdtempSync(join(tmpdir(), 'ce-remo-'));
  const config: ServerConfig = {
    https: { host: '127.0.0.1', port: 0, enabled: false },
    http: { host: '127.0.0.1', port: 0, enabled: true },
    publicHost: '127.0.0.1',
    certDir: join(tmp, 'certs'),
    dataDir: join(tmp, 'data'),
    staticDirs: { companion: join(tmp, 'c'), quest: join(tmp, 'q'), sim: join(tmp, 's') },
    trustFirstDevice: false,
    trustLoopback: true,
    consoleApprove: false,
    muse: { ...resolveMuseConfig({ FIXTURE_DELAY_MS: '0', MODEL_MODE: 'fixture' }), replayDir: undefined },
  };
  const ctx = createContext(config, { log: () => {}, registryFile: null });
  const agent = getAgent(ctx, { macLocal: false, settleMs: () => 10, companionWaitMs: 1000 });
  // This harness exercises bridge transport approval independently of the app's tag/mode policy.
  const dispatcher = new Dispatcher({ hub: ctx.hub });
  const unsubscribe = ctx.hub.onMessage(({ message }) => {
    if (message.type === 'exec.ack') dispatcher.onAck(message.payload as PayloadOf<'exec.ack'>);
    if (message.type === 'sense.result') dispatcher.onSense(message.payload as PayloadOf<'sense.result'>);
  });
  const servers: RunningServers = await startServers(ctx, createApp(ctx));
  cleanups.push(async () => {
    unsubscribe();
    dispatcher.close();
    agent.close();
    await servers.close();
    rmSync(tmp, { recursive: true, force: true });
  });
  const register = (name: string) => ctx.registry.add({ name, kind: 'remo', capabilities: ['ir'], canApprove: false });
  return { ctx, agent, dispatcher, register, tmp, base: `http://127.0.0.1:${ctx.bound.http}` };
}

const OFF_OP: IrOp = { kind: 'ir', protocol: 'AEHA', bytes: OFF_BYTES, ref: 'lib:panasonic/ch1/off' };

describe('Remo Stop', () => {
  it.each(['panic', 'disconnect'])('cancels delayed sends and learning polls on %s', async (stop) => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const remo = new RemoClient('http://unused.invalid');
    const post = vi.spyOn(remo, 'postMessage').mockResolvedValue(undefined);
    const get = vi.spyOn(remo, 'getMessages').mockResolvedValue(undefined);
    const bridge = new RemoBridge({ serverBase: 'http://unused.invalid', remo, allowSend: true, minSendGapMs: 1000, pollMs: 100 });
    Object.assign(bridge, { stopped: false, lastSendAt: Date.now() });
    const internal = bridge as unknown as {
      onExec(payload: ExecCommandPayload): Promise<void>;
      onSense(payload: SenseRequestPayload): Promise<void>;
      onMessage(message: AnyMessage): void;
    };
    const sending = internal.onExec({ execId: 'ir', executorDeviceId: 'remo', op: OFF_OP });
    const learning = internal.onSense({ senseId: 'learn', sensorDeviceId: 'remo', kind: 'ir-capture', durationMs: 1000 });
    await Promise.resolve();
    const signal = get.mock.calls[0][0]!;
    if (stop === 'panic') internal.onMessage(makeMessage('panic', {}));
    else bridge.stop();
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1500);
    await Promise.all([sending, learning]);
    expect(post).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledOnce();
    if (stop === 'panic') {
      await internal.onExec({ execId: 'new-ir', executorDeviceId: 'remo', op: OFF_OP });
      expect(post).toHaveBeenCalledOnce();
      expect(post.mock.calls[0][1]?.aborted).toBe(false);
    }
  });
});

describe('Remo frames', () => {
  it('reads the local API body, cleans receiver noise and keeps what the learn step needs', () => {
    expect(parseRemoFrame({ format: 'us', freq: 38, data: [3400, 1700, 425] })).toEqual({ format: 'us', freq: 38, data: [3400, 1700, 425] });
    expect(parseRemoFrame({})).toBeUndefined();
    expect(parseRemoFrame('')).toBeUndefined();
    // a glitch pair before the leader and the trailing silence go; marks stay first
    expect(cleanFrame([120, 300, 3400, 1700, 425, 1275, 425, 70_000])).toEqual([3400, 1700, 425, 1275, 425]);
    expect(cleanFrame([3400, 1700, 425])).toEqual([3400, 1700, 425]);
    expect(cleanFrame([100, 200])).toEqual([100, 200]); // not a frame we understand: untouched
    const cap = frameToCapture(SAMPLE);
    expect(cap.khz).toBe(38);
    expect(cap.rawUs.at(-1)).not.toBeGreaterThan(65_000);
    const analysed = analyseCapture(cap);
    expect(analysed.protocol).toBe('AEHA');
    expect(analysed.bytes).toEqual(OFF_BYTES);
    expect(analysed.frames).toBe(2);
    expect(sameFrame(SAMPLE.data, [...SAMPLE.data])).toBe(true);
    expect(sameFrame(SAMPLE.data, SAMPLE.data.map((v, i) => (i === 3 ? v + 1 : v)))).toBe(false);
    expect(sameFrame(undefined, SAMPLE.data)).toBe(false);
  });

  it('turns an IrOp into the frame to POST, repeats joined by the frame gap', () => {
    const raw = encodeFrame({ protocol: 'AEHA', bytes: OFF_BYTES, unitUs: 425 });
    expect(opToFrame(OFF_OP)).toEqual({ format: 'us', freq: 38, data: raw });
    const twice = opToFrame({ ...OFF_OP, repeats: 1, frameGapUs: 30_000, khz: 40 });
    expect(twice.freq).toBe(40);
    expect(twice.data).toEqual([...raw, 30_000, ...raw]);
    expect(opToFrame({ kind: 'ir', protocol: 'RAW', rawUs: [9000, 4500, 560] }).data).toEqual([9000, 4500, 560]);
    expect(() => opToFrame({ kind: 'ir', protocol: 'SONY', bytes: [1] })).toThrow(/rawUs/);
  });
});

// --- mDNS ------------------------------------------------------------------------------------------

function dnsName(parts: string[], tail?: number): Buffer {
  const out: number[] = [];
  for (const p of parts) out.push(p.length, ...Buffer.from(p));
  if (tail !== undefined) out.push(0xc0 | (tail >> 8), tail & 0xff);
  else out.push(0);
  return Buffer.from(out);
}

function record(name: Buffer, type: number, rdata: Buffer): Buffer {
  const h = Buffer.alloc(10);
  h.writeUInt16BE(type, 0);
  h.writeUInt16BE(0x8001, 2);
  h.writeUInt32BE(120, 4);
  h.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([name, h, rdata]);
}

describe('Remo discovery', () => {
  it('registers a configured bridge without HTTP pairing and persists a nonapprover identity', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ce-remo-register-'));
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
    const registry = new DeviceRegistry();
    const register = vi.fn((name: string) => registry.add({ name, kind: 'remo', capabilities: ['ir'], canApprove: false }));
    const fetchImpl = vi.fn();
    const tokenFile = join(tmp, 'token.json');
    const options = { serverBase: 'http://127.0.0.1:1', remo: new RemoClient('http://127.0.0.1:2'), tokenFile, register, fetchImpl };
    const bridge = new RemoBridge(options);
    await (bridge as unknown as { pair(): Promise<void> }).pair();
    const stored = JSON.parse(readFileSync(tokenFile, 'utf8'));
    expect(registry.authenticate(stored.deviceToken)).toMatchObject({ deviceId: bridge.deviceId, kind: 'remo', capabilities: ['ir'], canApprove: false });
    const again = new RemoBridge(options);
    await (again as unknown as { pair(): Promise<void> }).pair();
    expect(again.deviceId).toBe(bridge.deviceId);
    expect(register).toHaveBeenCalledOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('asks for _remo._tcp with a unicast reply and reads PTR, SRV and A records with name compression', () => {
    const q = buildMdnsQuery();
    expect(q.readUInt16BE(4)).toBe(1);
    expect(q.subarray(12, 12 + 6).toString('latin1')).toBe('\u0005_remo');
    expect(q.readUInt16BE(q.length - 2)).toBe(0x8001);

    // response: PTR _remo._tcp.local -> Remo-E61798._remo._tcp.local ; SRV -> Remo-E61798.local:80 ; A Remo-E61798.local -> 192.168.1.11
    const head = Buffer.alloc(12);
    head.writeUInt16BE(0x8400, 2);
    head.writeUInt16BE(3, 6);
    const service = dnsName(['_remo', '_tcp', 'local']); // at offset 12
    const ptr = record(service, 12, dnsName(['Remo-E61798'], 12)); // instance name compressed onto the service name
    const instanceOffset = 12 + service.length + 10; // where the PTR rdata (the instance name) starts
    const srvData = Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 80]), dnsName(['Remo-E61798', 'local'])]);
    const srv = record(dnsName([], instanceOffset), 33, srvData);
    const a = record(dnsName(['Remo-E61798', 'local']), 1, Buffer.from([192, 168, 1, 11]));
    const packet = Buffer.concat([head, ptr, srv, a]);
    const recs = parseMdnsResponse(packet);
    expect(recs.map((r) => [r.name, r.type])).toEqual([
      ['_remo._tcp.local', 12],
      ['Remo-E61798._remo._tcp.local', 33],
      ['Remo-E61798.local', 1],
    ]);
    expect(remoFromRecords(recs)).toEqual({ host: '192.168.1.11', port: 80, name: 'Remo-E61798' });
    // a bare A record for a Remo-… host is enough
    expect(remoFromRecords(parseMdnsResponse(Buffer.concat([head.subarray(0, 6), Buffer.from([0, 1, 0, 0, 0, 0]), a])))).toEqual({ host: '192.168.1.11', port: 80, name: 'Remo-E61798' });
    expect(remoFromRecords([])).toBeUndefined();
  });

  it('is off unless REMO_HOST or CE_REMO is set, and never probes the Remo at start-up', async () => {
    const fetchSpy = vi.fn();
    expect(resolveRemoConfig({})).toEqual({ host: undefined, discover: false, send: false });
    expect(resolveRemoConfig({ REMO_HOST: '192.168.1.11', REMO_SEND: '1', CE_REMO: '1' })).toEqual({ host: '192.168.1.11', discover: true, send: true });
    expect(await startRemoBridge({ config: resolveRemoConfig({}), serverBase: 'http://127.0.0.1:1', dataDir: '/nonexistent', fetchImpl: fetchSpy as never })).toBeUndefined();
    const discover = vi.fn(async () => undefined);
    expect(await startRemoBridge({ config: resolveRemoConfig({ CE_REMO: '1' }), serverBase: 'http://127.0.0.1:1', dataDir: '/nonexistent', fetchImpl: fetchSpy as never, discover })).toBeUndefined();
    expect(discover).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// --- the whole path through the hub ---------------------------------------------------------------

describe('Remo bridge through the hub', () => {
  it('registers the configured bridge, learns by polling, refuses to send until approved, then sends >= 1 s apart', { timeout: 20_000 }, async () => {
    const remo = await mockRemo();
    const { ctx, agent, dispatcher, register, tmp, base } = await startServer();
    const bridge = new RemoBridge({ serverBase: base, register, remo: new RemoClient(remo.base), name: 'Nature Remo (test)', tokenFile: join(tmp, 'remo.json'), pollMs: 30, minSendGapMs: 400 });
    cleanups.push(() => bridge.stop());
    await bridge.start();
    expect(bridge.connected).toBe(true);
    const dev = ctx.hub.devices().find((d) => d.kind === 'remo');
    expect(dev).toMatchObject({ deviceId: bridge.deviceId, online: true, capabilities: ['ir'], role: 'device', canApprove: false });
    expect(remo.gets).toBe(0); // nothing touched the Remo yet
    // the executor pick prefers the Remo for IR; a Cardputer would be the alternative
    expect(pickExecutor(agent.roster, 'ir')?.deviceId).toBe(bridge.deviceId);
    expect(pickSensor(agent.roster, 'ir', { preferDeviceId: bridge.deviceId })?.deviceId).toBe(bridge.deviceId);

    // LEARN: the window opens, the user presses the remote toward the Remo, the new frame is the capture
    const learn = dispatcher.sense(bridge.deviceId, 'ir-capture', { durationMs: 2500, prompt: 'Press 消灯 (off) once' });
    await new Promise((r) => setTimeout(r, 200));
    remo.receive(SAMPLE);
    const results = await learn;
    const caps = results.filter((r) => r.ir?.rawUs?.length);
    expect(caps).toHaveLength(1);
    expect(caps[0].ir!.rawUs).toEqual(cleanFrame(SAMPLE.data));
    expect(analyseCapture({ rawUs: caps[0].ir!.rawUs, khz: caps[0].ir!.khz })).toMatchObject({ protocol: 'AEHA', bytes: OFF_BYTES });
    expect(remo.gets).toBeGreaterThan(2);
    expect(remo.posts).toHaveLength(0);
    expect(remo.badHeader).toBe(0);

    // nothing new in the window: an honest "nothing received", not a stale capture
    const nothing = await dispatcher.sense(bridge.deviceId, 'ir-capture', { durationMs: 1000 });
    expect(nothing.some((r) => r.ir?.rawUs?.length)).toBe(false);
    expect(nothing.at(-1)?.error).toMatch(/no new IR signal/);

    // EXEC: refused until the user approves; dry runs never reach the Remo
    const postsBefore = remo.posts.length;
    await expect(dispatcher.exec(bridge.deviceId, OFF_OP, { lightCap: true, waitForSlot: true })).rejects.toThrow(/not approved/);
    const dry = await dispatcher.exec(bridge.deviceId, OFF_OP, { dryRun: true, lightCap: true, waitForSlot: true });
    expect(dry.ok).toBe(true);
    expect(dry.detail).toMatch(/dry run/);
    expect(remo.posts).toHaveLength(postsBefore);

    // approved: the frame goes out as the Remo expects, and a second send waits for the gap
    bridge.allowSend = true;
    const t0 = Date.now();
    const ack1 = await dispatcher.exec(bridge.deviceId, OFF_OP, { lightCap: true, waitForSlot: true });
    expect(ack1.ok).toBe(true);
    expect(remo.posts).toHaveLength(1);
    expect(remo.posts[0]).toEqual(opToFrame(OFF_OP));
    const ack2 = await dispatcher.exec(bridge.deviceId, { ...OFF_OP, repeats: 1 }, { lightCap: true, waitForSlot: true });
    expect(ack2.ok).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(380);
    expect(remo.posts[1].data.length).toBe(opToFrame(OFF_OP).data.length * 2 + 1);
    expect(bridge.sends).toBe(2);
    // non-IR ops are refused as unsupported without touching the Remo
    await expect(dispatcher.exec(bridge.deviceId, { kind: 'midi', msg: 'panic' } as never, { waitForSlot: true })).rejects.toThrow(/unsupported/);
    expect(remo.posts).toHaveLength(2);

    // the identity survives a restart: the stored token is reused, no second device appears
    const paired = ctx.registry.size;
    bridge.stop();
    await new Promise((r) => setTimeout(r, 50));
    const again = new RemoBridge({ serverBase: base, remo: new RemoClient(remo.base), name: 'Nature Remo (test)', tokenFile: join(tmp, 'remo.json') });
    cleanups.push(() => again.stop());
    await again.start();
    expect(again.deviceId).toBe(bridge.deviceId);
    expect(ctx.registry.size).toBe(paired);
    expect(ctx.hub.devices().filter((d) => d.kind === 'remo')).toHaveLength(1);
  });

  it('reports an unreachable Remo instead of stalling the learn window', { timeout: 10_000 }, async () => {
    const { dispatcher, register, tmp, base } = await startServer();
    const bridge = new RemoBridge({ serverBase: base, register, remo: new RemoClient('http://127.0.0.1:9', { timeoutMs: 300 }), tokenFile: join(tmp, 'remo.json'), pollMs: 30 });
    cleanups.push(() => bridge.stop());
    await bridge.start();
    const t0 = Date.now();
    const results = await dispatcher.sense(bridge.deviceId, 'ir-capture', { durationMs: 5000 });
    expect(results.some((r) => r.ir)).toBe(false);
    expect(results.at(-1)?.error).toMatch(/unreachable/);
    expect(Date.now() - t0).toBeLessThan(4000);
  });
});
