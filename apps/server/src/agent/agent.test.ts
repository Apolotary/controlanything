/**
 * End-to-end discovery loop in sim mode, no hardware and no key (FIXTURE): a "sim room" client plays the
 * headset camera, the IR executor, the IR receiver and the lamp; a "quest" client selects, arms and controls.
 * scan.frame -> scan.result -> target.select -> identify -> link -> learn -> research -> drive -> verify
 * (camera oracle on the sim's frames) -> forge (fake) -> arm (pinch) -> control.event -> exec.command < 50 ms
 * -> panic.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptySpec } from '@ce/gen3d';
import { type AnyMessage, type Driver, type HackSet, makeMessage, type MessageType, type PayloadOf, type UiSpecPayload } from '@ce/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp } from '../app';
import type { ServerConfig } from '../config';
import { createContext, type RunningServers, type ServerContext, startServers } from '../context';
import { decodeFrame, encodeFrame } from '../devices/ir';
import type { Forge, ForgeRequest, ForgeResult } from '../gen3d/forge';
import { resolveMuseConfig } from '../muse';
import { encodeJpeg } from '../oracle/image';
import { roomImage } from '../oracle/oracle.test';
import { getAgent } from './index';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

// --- a fake forge: turns the verified driver into one hack per action, no model ------------------------

function fakeForge(ctx: ServerContext): Forge {
  const specs = new Map<string, UiSpecPayload>();
  const subs = new Set<(e: { type: 'spec'; uiSpec: UiSpecPayload } | { type: 'progress'; progress: never }) => void>();
  const specIdFor = (cardId: string) => `spec_${cardId}`;
  const build = (req: ForgeRequest): UiSpecPayload => {
    const driver = req.driver as unknown as Driver;
    const verification = req.verification ?? {};
    const hacks: HackSet['hacks'] = [];
    for (const a of driver.actions) {
      if (a.kind === 'set' && a.range) {
        hacks.push({ id: `h_${a.actionId}`, name: a.label.slice(0, 24), kind: 'control', params: [{ id: 'p', name: 'Level', min: a.range.min, max: a.range.max, default: (a.range.min + a.range.max) / 2, step: a.range.step }], control: { archetype: 'ring', param: 'p' }, commands: [{ action: a.actionId, param: 'p' }], oracle: { type: 'camera', expect: 'luminance_tracks_param' }, inverse: { restore: 'p' }, max_rate_hz: 3, status: verification[a.actionId] === 'pass' ? 'verified' : 'locked' });
      } else {
        hacks.push({ id: `h_${a.actionId}`, name: a.label.slice(0, 24), kind: 'action', commands: [{ action: a.actionId }], oracle: { type: 'camera', expect: a.expect?.effect === 'off' ? 'off' : a.expect?.effect === 'on' ? 'on' : 'brighter' }, inverse: a.inverseActionId ? { commands: [{ action: a.inverseActionId }] } : undefined, max_rate_hz: 1, status: verification[a.actionId] === 'pass' ? 'verified' : 'locked' });
      }
    }
    const gen3d = emptySpec(specIdFor(req.device.cardId), req.device.name.slice(0, 40));
    gen3d.controls = hacks.map((h) => ({ id: h.id, kind: h.kind === 'control' ? ('continuous' as const) : ('trigger' as const), label: h.name.slice(0, 16).toUpperCase(), binding: { action: h.commands[0].action, driverId: driver.driverId, args: { hack: h.id } }, armed: h.status === 'verified' }));
    gen3d.parts = [{ id: 'handle', kind: 'archetype', archetype: 'handle' }];
    return { specId: gen3d.specId, cardId: req.device.cardId, driverId: driver.driverId, title: gen3d.title, rev: 1, gen3d, hackset: { spec: 'ce.hackset/1', device: { id: req.device.cardId, name: req.device.name.slice(0, 60), channel: { type: driver.transport, via: driver.executor.deviceId } }, hacks }, source: 'fixture', modelId: 'fake-forge', check: { ok: true, attempts: 1, errors: 0, warnings: 0 } };
  };
  const result = (uiSpec: UiSpecPayload): ForgeResult => ({ ok: true, uiSpec: uiSpec as ForgeResult['uiSpec'], report: { ok: true, attempts: 1, stages: {} as never, errors: [], warnings: [], fixes: [], history: [] }, model: 'fake-forge', effort: 'low', source: 'fixture', latencyMs: 1, usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0 }, costUsd: 0 });
  const f: Forge = {
    mode: 'fixture',
    async generate(req) {
      const spec = build(req);
      specs.set(spec.specId, spec);
      ctx.hub.broadcast('ui.spec', spec);
      for (const s of subs) s({ type: 'spec', uiSpec: spec });
      return result(spec);
    },
    forge: (req) => f.generate(req),
    generateFor: async (cardId) => {
      const s = specs.get(specIdFor(cardId));
      if (!s) throw new Error('not forged');
      return result(s);
    },
    target: () => undefined,
    edit: async ({ specId }) => ({ ...result(specs.get(specId)!), touched: [], untouchedIdentical: true }),
    undo: (specId) => ({ ...result(specs.get(specId)!), touched: [], untouchedIdentical: true, history: 'undo' }),
    redo: (specId) => ({ ...result(specs.get(specId)!), touched: [], untouchedIdentical: true, history: 'redo' }),
    rearm: (specId) => specs.get(specId) as never,
    get: (specId) => specs.get(specId) as never,
    specIdFor,
    list: () => [...specs.values()] as never,
    subscribe: (fn) => {
      subs.add(fn as never);
      return () => subs.delete(fn as never);
    },
  };
  return f;
}

// --- harness ----------------------------------------------------------------------------------------

interface Harness {
  ctx: ServerContext;
  servers: RunningServers;
  base: string;
  wsUrl: string;
}

async function start(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'ce-agent-'));
  const companion = join(tmp, 'companion');
  mkdirSync(companion);
  writeFileSync(join(companion, 'index.html'), '<!doctype html>');
  const config: ServerConfig = {
    https: { host: '127.0.0.1', port: 0, enabled: false },
    http: { host: '127.0.0.1', port: 0, enabled: true },
    publicHost: '127.0.0.1',
    certDir: join(tmp, 'certs'),
    dataDir: join(tmp, 'data'),
    staticDirs: { companion, quest: join(tmp, 'q'), sim: join(tmp, 's') },
    trustFirstDevice: false,
    trustLoopback: true,
    consoleApprove: false,
    muse: { ...resolveMuseConfig({ FIXTURE_DELAY_MS: '0', MODEL_MODE: 'fixture' }), replayDir: undefined },
  };
  const ctx = createContext(config, { log: () => {}, registryFile: null });
  const forge = fakeForge(ctx); // one instance: the loop forges into it and the control router reads from it
  const agent = getAgent(ctx, { macLocal: false, settleMs: () => 10, companionWaitMs: 4000, forge: () => forge });
  const servers = await startServers(ctx, createApp(ctx));
  cleanups.push(async () => {
    agent.close();
    await servers.close();
    rmSync(tmp, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${ctx.bound.http}`;
  return { ctx, servers, base, wsUrl: `ws://127.0.0.1:${ctx.bound.http}/ws` };
}

class Client {
  readonly inbox: AnyMessage[] = [];
  readonly seen: AnyMessage[] = [];
  private waiters: (() => void)[] = [];
  deviceId = '';
  handlers: ((m: AnyMessage) => void)[] = [];
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as AnyMessage;
      this.inbox.push(m);
      this.seen.push(m);
      for (const h of this.handlers) h(m);
      for (const w of this.waiters.splice(0)) w();
    });
  }
  static async pairAndOpen(h: Harness, kind: string, name: string, capabilities: string[], hello: Partial<PayloadOf<'hello'>> = {}): Promise<Client> {
    const r = await fetch(`${h.base}/api/pair/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, kind, capabilities }) });
    const j = (await r.json()) as { status: string; deviceToken: string; deviceId: string };
    expect(j.status).toBe('approved');
    const c = await new Promise<Client>((resolve, reject) => {
      const ws = new WebSocket(h.wsUrl);
      const cl = new Client(ws);
      ws.once('open', () => resolve(cl));
      ws.once('error', reject);
      cleanups.push(() => ws.terminate());
    });
    c.deviceId = j.deviceId;
    c.send('hello', { deviceToken: j.deviceToken, capabilities: capabilities as never, ...hello });
    await c.next('welcome');
    return c;
  }
  send<T extends MessageType>(type: T, payload: PayloadOf<T>, opts: { to?: string } = {}): string {
    const m = makeMessage(type, payload, opts);
    this.ws.send(JSON.stringify(m));
    return m.id;
  }
  async next<T extends MessageType>(type: T, timeoutMs = 4000, where: (p: PayloadOf<T>) => boolean = () => true): Promise<PayloadOf<T>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.inbox.findIndex((m) => m.type === type && where(m.payload as PayloadOf<T>));
      if (i >= 0) return this.inbox.splice(i, 1)[0].payload as PayloadOf<T>;
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
}

/** The virtual room: a lamp with 4 levels + colour, driven by its own learned AEHA codes. */
class SimRoom {
  on = true;
  level = 2;
  warm = 0;
  readonly codes: Record<string, number[]> = {
    全灯: [0xaa, 0x55, 0x00, 0x01, 0x01],
    消灯: [0xaa, 0x55, 0x00, 0x02, 0x02],
    明るく: [0xaa, 0x55, 0x00, 0x03, 0x03],
    暗く: [0xaa, 0x55, 0x00, 0x04, 0x04],
    常夜灯: [0xaa, 0x55, 0x00, 0x05, 0x05],
    暖色: [0xaa, 0x55, 0x00, 0x06, 0x06],
    白色: [0xaa, 0x55, 0x00, 0x07, 0x07],
  };
  execs: { at: number; op: PayloadOf<'exec.command'>['op'] }[] = [];

  frame(): string {
    // the lamp lights the ceiling around it: the ambient rises with the level (a real shade clips long before)
    const lamp = this.on ? 120 + this.level * 40 : 60;
    const bg = this.on ? 70 + this.level * 12 : 50;
    return Buffer.from(encodeJpeg(roomImage({ bg, lamp, warm: this.on ? this.warm : 0, width: 320, height: 240 }), 90)).toString('base64');
  }

  apply(op: PayloadOf<'exec.command'>['op']): boolean {
    this.execs.push({ at: Date.now(), op });
    if (op.kind !== 'ir' || !op.rawUs) return false;
    const f = decodeFrame(op.rawUs);
    if (!f) return false;
    const key = Object.entries(this.codes).find(([, b]) => b.join() === f.bytes.join())?.[0];
    switch (key) {
      case '全灯':
        this.on = true;
        this.level = 2;
        break;
      case '消灯':
        this.on = false;
        break;
      case '明るく':
        this.level = Math.min(3, this.level + 1);
        break;
      case '暗く':
        this.level = Math.max(0, this.level - 1);
        break;
      case '常夜灯':
        this.on = true;
        this.level = 0;
        this.warm = 40;
        break;
      case '暖色':
        this.warm = 40;
        break;
      case '白色':
        this.warm = -30;
        break;
      default:
        return false;
    }
    return true;
  }

  capture(prompt: string): number[] | undefined {
    const key = Object.keys(this.codes).find((k) => prompt.includes(k));
    return key ? encodeFrame({ protocol: 'AEHA', bytes: this.codes[key], unitUs: 425 }) : undefined;
  }
}

/** Wire a client as the sim room: answers exec.command, sense.request (frame, ir-capture) and sends scan frames. */
function attachSim(c: Client, room: SimRoom): void {
  c.handlers.push((m) => {
    if (m.type === 'exec.command') {
      const p = m.payload as PayloadOf<'exec.command'>;
      if (p.executorDeviceId !== c.deviceId) return;
      const ok = room.apply(p.op);
      c.send('exec.ack', { execId: p.execId, ok: true, sentAt: Date.now(), detail: ok ? 'lamp reacted' : 'unknown code', latencyMs: 1 }, { to: 'server' });
    } else if (m.type === 'sense.request') {
      const p = m.payload as PayloadOf<'sense.request'>;
      if (p.sensorDeviceId !== c.deviceId) return;
      if (p.kind === 'frame') {
        c.send('sense.result', { senseId: p.senseId, kind: 'frame', at: Date.now(), frame: { frameId: `vf-${p.senseId}`, jpeg: room.frame(), width: 320, height: 240, capturedAt: Date.now(), purpose: 'verify', senseId: p.senseId, cardId: p.cardId, camera: { width: 320, height: 240, source: 'synthetic' } } }, { to: 'server' });
      } else if (p.kind === 'ir-capture') {
        const rawUs = room.capture(p.prompt ?? '');
        if (rawUs) c.send('sense.result', { senseId: p.senseId, kind: 'ir-capture', at: Date.now(), ir: { rawUs, khz: 38, frames: 1 } }, { to: 'server' });
      } else c.send('sense.result', { senseId: p.senseId, kind: p.kind, at: Date.now(), ok: false, error: 'unsupported' }, { to: 'server' });
    }
  });
}

describe('discovery loop end to end (sim mode, FIXTURE models)', () => {
  it('scans, identifies, links, learns the remote, drives, verifies by camera, forges, arms and controls the sim lamp', { timeout: 30_000 }, async () => {
    const h = await start();
    const room = new SimRoom();
    const sim = await Client.pairAndOpen(h, 'sim', 'Sim room', ['ir', 'camera', 'speaker', 'display'], { role: 'device', ports: [{ id: 'sim-ir', kind: 'ir', name: 'CE Sim IR' }] });
    attachSim(sim, room);
    const quest = await Client.pairAndOpen(h, 'quest', 'Quest', ['camera', 'hands', 'display'], { role: 'hmd' });

    // SCAN: the sim plays the headset camera; the FIXTURE SAM finds a ceiling light at the top centre
    const frameId = 'f1';
    sim.send('scan.frame', { frameId, jpeg: room.frame(), width: 320, height: 240, capturedAt: Date.now(), purpose: 'scan', camera: { width: 320, height: 240, source: 'synthetic' } }, { to: 'server' });
    const scan = await sim.next('scan.result', 6000, (p) => p.frameId === frameId);
    const light = scan.detections.find((d) => d.label === 'ceiling light');
    expect(light, JSON.stringify(scan.detections)).toBeDefined();
    expect(light!.polygon!.length).toBeGreaterThanOrEqual(4);
    expect(scan.source).toBe('fixture');
    await quest.next('scan.result', 2000, (p) => p.frameId === frameId); // HUD clients get it too

    // SELECT: the user pinches the light
    quest.send('target.select', { frameId, detId: light!.detId, text: 'control this light' }, { to: 'server' });
    const identified = await quest.next('device.card', 6000);
    expect(identified.category).toBe('lighting');
    expect(identified.requires).toContain('ir');
    const cardId = identified.cardId;

    // LINK: the sim room has "ir", so it becomes the executor; the receiver learns the remote
    const link = await quest.next('link.result', 6000, (p) => p.cardId === cardId);
    expect(link.executorDeviceId).toBe(sim.deviceId);
    expect(link.channel).toBe('sim');

    // DRIVE + VERIFY: the driver is broadcast, then evidence streams in while the camera watches the sim lamp
    const driver = await quest.next('driver.spec', 15_000, (p) => p.cardId === cardId);
    expect(driver.transport).toBe('ir');
    expect(driver.provenance.some((p) => p.source === 'learned')).toBe(true);
    const off = driver.actions.find((a) => a.actionId === 'off')!;
    expect(off.encode.kind).toBe('ir');
    const forged = await quest.next('target.status', 20_000, (p) => p.cardId === cardId && (p.state === 'forged' || p.state === 'failed' || p.state === 'arming'));
    expect(forged.state, forged.detail).not.toBe('failed');
    const evidence = quest.seen.filter((m) => m.type === 'verify.result').map((m) => m.payload as PayloadOf<'verify.result'>);
    expect(evidence.length).toBeGreaterThanOrEqual(4);
    const offEv = evidence.find((e) => e.actionId === 'off' && e.pass);
    expect(offEv, JSON.stringify(evidence.map((e) => [e.actionId, e.pass, e.note]))).toBeDefined();
    expect(['luma-mask-vs-ring', 'luma-abs']).toContain(offEv!.observed.metric);
    expect(offEv!.observed.delta).toBeLessThan(-0.33);
    const status = quest.seen.filter((m) => m.type === 'driver.status').map((m) => m.payload as PayloadOf<'driver.status'>).at(-1)!;
    const verified = Object.fromEntries((status.actions ?? []).map((a) => [a.actionId, a.verified]));
    // order matters on a real lamp: off, full, dimmer, brighter, colour, night last (colour keys do nothing in night mode)
    expect(verified, JSON.stringify(evidence.map((e) => [e.actionId, e.pass, e.note]))).toMatchObject({ off: 'pass', full: 'pass', dimmer: 'pass', brighter: 'pass', warmer: 'pass', cooler: 'pass', night: 'pass', level: 'pass' });
    const order = evidence.filter((e) => e.pass).map((e) => e.actionId);
    expect(order.indexOf('dimmer')).toBeLessThan(order.indexOf('brighter'));
    expect(order.indexOf('night')).toBeGreaterThan(order.indexOf('cooler'));
    expect(evidence.filter((e) => e.actionId === 'brighter' && e.pass)[0].observed.metric).toBe('luma-abs');

    // FORGE: the (fake) forge published a ui.spec with one hack per action
    const spec = quest.seen.map((m) => m.payload as UiSpecPayload).find((p) => p && 'hackset' in p && p.cardId === cardId)!;
    expect(spec.hackset?.hacks.some((hk) => hk.id === 'h_off')).toBe(true);

    // ARM: a pinch from the Quest (an approver)
    const armReq = await quest.next('arm.request', 6000, (p) => p.cardId === cardId);
    expect(armReq.actions.filter((a) => a.verified === 'pass').length).toBeGreaterThanOrEqual(2);
    const before = room.execs.length;
    quest.send('control.event', { widgetId: 'h_off', value: true, ts: Date.now(), specId: spec.specId, phase: 'end' }, { to: 'server' });
    await new Promise((r) => setTimeout(r, 100));
    expect(room.execs.length).toBe(before); // not armed yet: nothing reaches the device
    quest.send('arm.confirm', { armId: armReq.armId, approve: true }, { to: 'server' });
    const armed = await quest.next('arm.result', 6000, (p) => p.armId === armReq.armId);
    expect(armed.armed).toBe(true);
    await quest.next('target.status', 4000, (p) => p.cardId === cardId && p.state === 'armed');

    // CONTROL: pinch "Lights off" -> exec.command at the sim within 50 ms server time
    room.on = true;
    sim.inbox.length = 0; // forget the verification traffic
    await new Promise((r) => setTimeout(r, 400)); // let the 3 Hz light cap refill after VERIFY
    const t0 = Date.now();
    quest.send('control.event', { widgetId: 'h_off', value: true, ts: t0, specId: spec.specId, phase: 'end' }, { to: 'server' });
    const cmd = await sim.next('exec.command', 2000, (p) => p.actionId === 'off');
    const t1 = Date.now();
    expect(t1 - t0).toBeLessThan(50 + 20); // includes two loopback hops
    expect(cmd.op.kind === 'ir' && cmd.op.rawUs?.length).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(room.on).toBe(false);

    // PANIC disarms; a control afterwards is ignored
    quest.send('panic', { reason: 'test' }, { to: 'server' });
    await quest.next('target.status', 4000, (p) => p.cardId === cardId && p.state !== 'armed' && p.state !== 'controlling');
    const n = room.execs.length;
    quest.send('control.event', { widgetId: 'h_full', value: true, ts: Date.now(), specId: spec.specId, phase: 'end' }, { to: 'server' });
    await new Promise((r) => setTimeout(r, 500));
    expect(room.execs.length).toBe(n);

    // the work log carries model ids on every model step, and the HTTP views agree
    const steps = h.ctx.hub.devices().length ? (await (await fetch(`${h.base}/api/agent/steps?cardId=${cardId}`)).json()) as { steps: PayloadOf<'agent.step'>[] } : { steps: [] };
    expect(steps.steps.some((s) => s.phase === 'identify' && s.model)).toBe(true);
    expect(steps.steps.some((s) => s.phase === 'verify' && s.status === 'ok')).toBe(true);
    const targets = (await (await fetch(`${h.base}/api/agent/targets`)).json()) as { targets: { cardId: string; state: string }[] };
    expect(targets.targets.find((t) => t.cardId === cardId)?.state).toMatch(/forged|verified/);
    const exec = (await (await fetch(`${h.base}/api/agent/exec`)).json()) as { sent: unknown[] };
    expect(exec.sent.length).toBeGreaterThan(5);
  });

  it('asks for a companion when nothing online can reach the device, then links when one appears', { timeout: 20_000 }, async () => {
    const h = await start();
    const room = new SimRoom();
    const quest = await Client.pairAndOpen(h, 'quest', 'Quest', ['camera', 'hands', 'display'], { role: 'hmd' });
    const frameId = 'f2';
    quest.send('scan.frame', { frameId, jpeg: room.frame(), width: 320, height: 240, capturedAt: Date.now(), purpose: 'scan' }, { to: 'server' });
    const scan = await quest.next('scan.result', 6000, (p) => p.frameId === frameId);
    const light = scan.detections.find((d) => d.label === 'ceiling light')!;
    quest.send('target.select', { frameId, detId: light.detId }, { to: 'server' });
    const req = await quest.next('link.request', 8000);
    expect(req.needs).toEqual(['ir']);
    expect(req.suggestedClients).toContain('cardputer');
    expect(req.status).toBe('needs-companion');
    await quest.next('target.status', 4000, (p) => p.state === 'needs-companion');
    // a Cardputer-like executor joins
    const sim = await Client.pairAndOpen(h, 'sim', 'Sim IR node', ['ir', 'camera'], { role: 'device' });
    attachSim(sim, room);
    const link = await quest.next('link.result', 8000);
    expect(link.executorDeviceId).toBe(sim.deviceId);
  });
});
