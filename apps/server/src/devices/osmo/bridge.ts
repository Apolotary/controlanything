/**
 * DJI Osmo Mobile bridge: the gimbal becomes a paired "gimbal" device of this server with the `ble` capability,
 * through a loopback hub client (the same pattern as the Nature Remo bridge). LINK, VERIFY and CONTROL treat it
 * like any executor: `exec.command` with a BleOp in, `exec.ack` out.
 *
 * Every BleOp becomes ONE absolute DUML rotation after the safety envelope (om.ts OSMO_LIMITS): targets clamped to
 * pan ±120°, tilt ±45°, roll ±30°, slew ≤ 90°/s, ≤ 10 commands/s with latest-wins coalescing (hand control streams
 * pan and tilt as separate actions; the bridge merges them into one aim). Stop/panic holds the current aim.
 *
 * The ack is sent when the move should have finished (≤ 2 s). It carries the gimbal's own attitude report when the
 * model pushes one (`applied.source: "port"`): reached the target within OSMO_REACHED_DEG -> ok; reported but
 * nowhere near -> ok:false device_error (an honest miss); no report -> ok, "sent; no angle report".
 *
 * Start: CE_OSMO=mock (in-process twin, no Bluetooth) | ble (CoreBluetooth via the bleak helper) | web (Chrome Web
 * Bluetooth page on http://localhost:8799). Absent = off. OSMO_ADDRESS / OSMO_NAME pick one gimbal.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type AnyMessage, type BleArgs, type BleOp, type ExecAckPayload, type ExecCommandPayload, makeMessage, type MessageType, type PayloadOf, type Port, VALUE_PLACEHOLDER } from '@ce/protocol';
import WebSocket from 'ws';
import { DumlStream, toHex } from './duml';
import { type Attitude, clampAttitude, decodeReport, moveDurationMs, OSMO_LIMITS, rotatePacket } from './om';
import { createLink, type GimbalLink, type LinkKind, WebBluetoothGimbalLink } from './links';

export const OSMO_PORT_ID = 'dji-osmo';
/** a report within this many degrees of the target counts as "the gimbal got there" */
export const OSMO_REACHED_DEG = 6;
/** an attitude report older than this is not evidence */
const REPORT_FRESH_MS = 1500;
const ACK_SETTLE_MAX_MS = 2000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const r1 = (v: number) => Math.round(v * 10) / 10;

export interface OsmoState {
  connected: boolean;
  link: LinkKind;
  name?: string;
  /** what ControlAnything last commanded */
  target: Attitude;
  /** what the gimbal last said about itself */
  reported?: Attitude & { at: number };
  battery?: { percent: number; charging: boolean; at: number };
  sends: number;
  /** notification packets seen, by "set/id" (the hardware test prints these) */
  pushes: Record<string, number>;
  lastError?: string;
}

/**
 * The gimbal side: link + framing + clamps + coalescing. Usable without the hub (the CLI test drives it directly).
 */
export class OsmoController {
  readonly state: OsmoState;
  private readonly stream = new DumlStream();
  private seq = 1;
  private lastSendAt = 0;
  /** the move in flight, for estimating where the gimbal is when it does not report */
  private move = { from: { yaw: 0, pitch: 0, roll: 0 } as Attitude, to: { yaw: 0, pitch: 0, roll: 0 } as Attitude, t0: 0, t1: 0 };
  private pending?: { timer: ReturnType<typeof setTimeout>; wishMs?: number; waiters: ((r: { sentAt: number; durationMs: number; superseded: boolean }) => void)[] };
  private readonly log: (l: string) => void;
  /** every packet written (the CLI prints them) */
  readonly tx: { at: number; hex: string }[] = [];
  readonly rx: { at: number; set: number; id: number; hex: string }[] = [];

  constructor(readonly link: GimbalLink, o: { log?: (l: string) => void } = {}) {
    this.log = o.log ?? (() => {});
    this.state = { connected: false, link: link.kind, target: { yaw: 0, pitch: 0, roll: 0 }, sends: 0, pushes: {} };
    link.onData((chunk) => this.onChunk(chunk));
    link.onClose((why) => {
      this.state.connected = false;
      this.state.lastError = why;
      this.log(`[osmo] gimbal link closed: ${why}`);
      this.onChange?.();
    });
  }

  /** called when connection or identity changes (the bridge re-announces its port) */
  onChange?: () => void;

  async open(signal?: AbortSignal): Promise<void> {
    const info = await this.link.open(signal);
    this.state.connected = true;
    this.state.name = info.name;
    this.state.lastError = undefined;
    this.log(`[osmo] gimbal link up: ${info.name}${info.address ? ` (${info.address})` : ''} via ${info.kind}${info.mtu ? `, MTU ${info.mtu}` : ''}`);
    this.onChange?.();
  }

  private onChunk(chunk: Uint8Array): void {
    for (const p of this.stream.feed(chunk)) {
      const key = `${p.cmdSet.toString(16).padStart(2, '0')}/${p.cmdId.toString(16).padStart(2, '0')}`;
      this.state.pushes[key] = (this.state.pushes[key] ?? 0) + 1;
      if (this.rx.length < 400) this.rx.push({ at: Date.now(), set: p.cmdSet, id: p.cmdId, hex: toHex(p.payload) });
      const r = decodeReport(p);
      if (r?.kind === 'attitude') this.state.reported = { ...r.attitude, at: Date.now() };
      else if (r?.kind === 'battery') this.state.battery = { percent: r.percent, charging: r.charging, at: Date.now() };
    }
  }

  freshReport(now = Date.now()): (Attitude & { at: number }) | undefined {
    const r = this.state.reported;
    return r && now - r.at < REPORT_FRESH_MS ? r : undefined;
  }

  /** Where the gimbal probably is: its own report when fresh, else the interpolated commanded move. */
  estimate(now = Date.now()): Attitude {
    const rep = this.freshReport(now);
    if (rep) return { yaw: rep.yaw, pitch: rep.pitch, roll: rep.roll };
    const m = this.move;
    if (now >= m.t1) return { ...m.to };
    const k = Math.max(0, Math.min(1, (now - m.t0) / Math.max(1, m.t1 - m.t0)));
    return { yaw: m.from.yaw + (m.to.yaw - m.from.yaw) * k, pitch: m.from.pitch + (m.to.pitch - m.from.pitch) * k, roll: m.from.roll + (m.to.roll - m.from.roll) * k };
  }

  /** The new target for an op (clamped). Throws on a malformed op. */
  targetFor(op: Pick<BleOp, 'op' | 'arg'>): { target: Attitude; wishMs?: number } {
    const cur = this.state.target;
    const num = (v: unknown, what: string) => {
      if (v === VALUE_PLACEHOLDER) throw new Error(`"${VALUE_PLACEHOLDER}" was not substituted`);
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${what} needs a number of degrees`);
      return v;
    };
    const args = (op.arg && typeof op.arg === 'object' ? op.arg : {}) as BleArgs;
    switch (op.op) {
      case 'pan':
        return { target: clampAttitude({ ...cur, yaw: num(op.arg, 'pan') }) };
      case 'tilt':
        return { target: clampAttitude({ ...cur, pitch: num(op.arg, 'tilt') }) };
      case 'nudge':
        return { target: clampAttitude({ yaw: cur.yaw + (args.yaw ?? 0), pitch: cur.pitch + (args.pitch ?? 0), roll: cur.roll }), wishMs: args.durationMs };
      case 'recenter':
        return { target: { yaw: 0, pitch: 0, roll: 0 }, wishMs: args.durationMs };
      case 'stop':
        return { target: clampAttitude(this.estimate()) };
      default:
        throw new Error(`unknown gimbal op "${String(op.op)}"`);
    }
  }

  /**
   * Aim at `target`. Sends at most OSMO_LIMITS.maxRateHz; a newer aim inside the window replaces the queued one
   * (its waiters resolve as superseded). Resolves when the packet left.
   */
  aim(target: Attitude, wishMs?: number): Promise<{ sentAt: number; durationMs: number; superseded: boolean }> {
    if (!this.state.connected) return Promise.reject(new Error(this.state.lastError ? `gimbal not connected: ${this.state.lastError}` : 'gimbal not connected'));
    this.state.target = clampAttitude(target);
    const gap = 1000 / OSMO_LIMITS.maxRateHz;
    const wait = this.lastSendAt + gap - Date.now();
    return new Promise((resolve, reject) => {
      if (this.pending) {
        // latest wins: earlier waiters learn they were folded into this newer aim
        const old = this.pending.waiters;
        this.pending.waiters = [resolve];
        this.pending.wishMs = wishMs;
        for (const w of old) w({ sentAt: Date.now(), durationMs: 0, superseded: true });
        return;
      }
      const go = () => {
        const p = this.pending;
        this.pending = undefined;
        this.sendNow(p?.wishMs).then((r) => p?.waiters.forEach((w) => w({ ...r, superseded: false })), reject);
      };
      this.pending = { timer: setTimeout(go, Math.max(0, wait)), wishMs, waiters: [resolve] };
    });
  }

  private async sendNow(wishMs?: number): Promise<{ sentAt: number; durationMs: number }> {
    const now = Date.now();
    const from = this.estimate(now);
    const to = this.state.target;
    const durationMs = moveDurationMs(from, to, wishMs);
    const pkt = rotatePacket(to, 'absolute', durationMs, this.seq);
    this.seq = (this.seq + 1) & 0xffff || 1;
    await this.link.write(pkt);
    this.lastSendAt = Date.now();
    this.move = { from, to: { ...to }, t0: this.lastSendAt, t1: this.lastSendAt + durationMs };
    this.state.sends++;
    if (this.tx.length < 400) this.tx.push({ at: this.lastSendAt, hex: toHex(pkt) });
    return { sentAt: this.lastSendAt, durationMs };
  }

  /** Hold where it is now (Stop / panic). */
  async hold(): Promise<void> {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      for (const w of this.pending.waiters) w({ sentAt: Date.now(), durationMs: 0, superseded: true });
      this.pending = undefined;
    }
    if (!this.state.connected) return;
    this.state.target = clampAttitude(this.estimate());
    await this.sendNow(OSMO_LIMITS.minDurationMs).catch((e) => this.log(`[osmo] hold failed: ${(e as Error).message}`));
  }

  async close(): Promise<void> {
    if (this.pending) clearTimeout(this.pending.timer);
    await this.link.close();
  }
}

// --- the hub client -------------------------------------------------------------------------------------

export interface OsmoBridgeOptions {
  serverBase: string;
  register?: (name: string) => { device: { deviceId: string }; token: string };
  controller: OsmoController;
  name?: string;
  tokenFile?: string;
  log?: (line: string) => void;
}

export class OsmoBridge {
  deviceId = '';
  lastError?: string;
  private token?: string;
  private ws?: WebSocket;
  private stopped = true;
  private backoff = 500;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly log: (line: string) => void;

  constructor(private readonly o: OsmoBridgeOptions) {
    this.log = o.log ?? (() => {});
    o.controller.onChange = () => this.announce();
  }

  get name(): string {
    return this.o.name ?? 'DJI Osmo Mobile';
  }

  get controller(): OsmoController {
    return this.o.controller;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.pair();
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    void this.o.controller.hold().finally(() => void this.o.controller.close());
  }

  private pair(): void {
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
        // re-register below
      }
    }
    if (!this.o.register) throw new Error('the Osmo bridge registers through the hosting server');
    const { device, token } = this.o.register(this.name.slice(0, 120));
    this.deviceId = device.deviceId;
    this.token = token;
    if (f) {
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, `${JSON.stringify({ deviceId: device.deviceId, deviceToken: token, name: this.name }, null, 2)}\n`, { mode: 0o600 });
    }
  }

  private port(): Port {
    const s = this.o.controller.state;
    return { id: OSMO_PORT_ID, kind: 'ble', name: s.name ?? this.name, manufacturer: 'DJI', state: s.connected ? 'connected' : 'disconnected' };
  }

  private announce(): void {
    if (this.ws?.readyState !== WebSocket.OPEN || !this.token) return;
    this.send('hello', { deviceToken: this.token, role: 'device', capabilities: ['ble'], ports: [this.port()], app: 'osmo-bridge@0.1.0' });
  }

  private connect(): Promise<void> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`${this.o.serverBase.replace(/^http/, 'ws')}/ws`);
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
        this.announce();
      });
      ws.on('message', (d) => {
        let m: AnyMessage;
        try {
          m = JSON.parse(d.toString()) as AnyMessage;
        } catch {
          return;
        }
        if (m.type === 'welcome') done();
        else if (m.type === 'exec.command') void this.onExec(m.payload as ExecCommandPayload);
        else if (m.type === 'panic') void this.o.controller.hold();
      });
      ws.on('error', (e) => {
        this.lastError = e.message;
      });
      ws.on('close', (code) => {
        // the headset is gone: stop where we are rather than finish a hand-control sweep
        void this.o.controller.hold();
        if (code === 4401) {
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
      if (!this.token) this.pair();
    } catch (e) {
      this.lastError = (e as Error).message;
      return;
    }
    await this.connect();
  }

  private async onExec(p: ExecCommandPayload): Promise<void> {
    const ack = (a: Partial<ExecAckPayload>) => this.send('exec.ack', { execId: p.execId, ok: false, sentAt: Date.now(), ...a }, { to: 'server' });
    const op = p.op;
    if (op.kind !== 'ble' || op.profile !== 'dji-osmo') return ack({ error: 'unsupported', detail: `the Osmo bridge only moves the DJI gimbal (${op.kind} asked)` });
    const c = this.o.controller;
    let plan: { target: Attitude; wishMs?: number };
    try {
      plan = c.targetFor(op);
    } catch (e) {
      return ack({ error: 'bad_args', detail: (e as Error).message.slice(0, 200) });
    }
    const describe = (a: Attitude) => `pan ${r1(a.yaw)}° tilt ${r1(a.pitch)}°${a.roll ? ` roll ${r1(a.roll)}°` : ''}`;
    if (p.dryRun) return ack({ ok: true, detail: `dry run: would aim ${describe(plan.target)}, not sent` });
    if (!c.state.connected) return ack({ error: 'refused', detail: c.state.lastError ? `the gimbal is not connected (${c.state.lastError})` : 'the gimbal is not connected yet' });
    const t0 = Date.now();
    let sent: { sentAt: number; durationMs: number; superseded: boolean };
    try {
      sent = op.op === 'stop' ? await c.hold().then(() => ({ sentAt: Date.now(), durationMs: OSMO_LIMITS.minDurationMs, superseded: false })) : await c.aim(plan.target, plan.wishMs);
    } catch (e) {
      return ack({ error: 'device_error', detail: (e as Error).message.slice(0, 300) });
    }
    if (sent.superseded) return ack({ ok: true, sentAt: sent.sentAt, latencyMs: Date.now() - t0, detail: 'folded into a newer aim (latest wins)' });
    // wait for the move to finish, then read the gimbal's own report
    await sleep(Math.min(ACK_SETTLE_MAX_MS, sent.durationMs + 150));
    const rep = c.freshReport();
    const target = plan.target;
    const params: Record<string, number> = { targetYaw: r1(target.yaw), targetPitch: r1(target.pitch), moveMs: sent.durationMs };
    if (c.state.battery) params.battery = c.state.battery.percent;
    if (!rep) {
      return ack({ ok: true, sentAt: sent.sentAt, latencyMs: Date.now() - t0, detail: `aimed ${describe(target)} over ${(sent.durationMs / 1000).toFixed(1)} s · the gimbal sent no angle report (watch it move)`, applied: { source: 'port', params, at: Date.now() } });
    }
    Object.assign(params, { yaw: r1(rep.yaw), pitch: r1(rep.pitch), roll: r1(rep.roll), reported: 1 });
    const off = Math.max(Math.abs(rep.yaw - target.yaw), Math.abs(rep.pitch - target.pitch));
    const reached = off <= OSMO_REACHED_DEG;
    params.offDeg = r1(off);
    return ack({
      ok: reached, ...(reached ? {} : { error: 'device_error' as const }), sentAt: sent.sentAt, latencyMs: Date.now() - t0,
      detail: reached ? `gimbal reports ${describe(rep)} (asked ${describe(target)}) ✓` : `gimbal reports ${describe(rep)}, ${r1(off)}° from the target ${describe(target)}`,
      applied: { source: 'port', params, at: rep.at },
    });
  }

  private send<T extends MessageType>(type: T, payload: PayloadOf<T>, opts: { to?: string } = {}): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(makeMessage(type, payload, opts)));
  }
}

// --- start-up ---------------------------------------------------------------------------------------

export interface OsmoConfig {
  link?: LinkKind;
  address?: string;
  name?: string;
}

export function resolveOsmoConfig(env: NodeJS.ProcessEnv): OsmoConfig {
  const v = (env.CE_OSMO ?? '').trim().toLowerCase();
  const link = v === 'mock' || v === 'ble' || v === 'web' ? v : v === '1' ? 'mock' : undefined;
  return { link, address: env.OSMO_ADDRESS?.trim() || undefined, name: env.OSMO_NAME?.trim() || undefined };
}

/**
 * Start the bridge when CE_OSMO is set. The hub device appears at once; the gimbal link opens in the background
 * (ble: scans and connects, retrying every 10 s; web: waits for the Chrome tab; mock: immediately). Opening a link
 * never moves the gimbal: motion only follows an exec.command.
 */
export async function startOsmoBridge(o: { config: OsmoConfig; serverBase: string; dataDir: string; register?: OsmoBridgeOptions['register']; log?: (line: string) => void }): Promise<OsmoBridge | undefined> {
  const kind = o.config.link;
  if (!kind) return undefined;
  const log = o.log ?? (() => {});
  const link = createLink(kind, { log, address: o.config.address, name: o.config.name });
  const controller = new OsmoController(link, { log });
  const bridge = new OsmoBridge({ serverBase: o.serverBase, register: o.register, controller, name: kind === 'mock' ? 'DJI Osmo Mobile (twin)' : 'DJI Osmo Mobile', tokenFile: join(o.dataDir, `osmo-bridge-${kind}.json`), log });
  await bridge.start();
  const openLoop = async () => {
    for (let attempt = 1; !controller.state.connected; attempt++) {
      try {
        await controller.open();
        return;
      } catch (e) {
        controller.state.lastError = (e as Error).message;
        if (attempt === 1 || attempt % 6 === 0) log(`[osmo] gimbal not connected: ${controller.state.lastError}`);
        // macOS refusing Bluetooth will not change by retrying
        if (/blocked Bluetooth|could not start/.test(controller.state.lastError)) return;
        await sleep(10_000);
      }
    }
  };
  if (link instanceof WebBluetoothGimbalLink) log(`[osmo] open ${link.url} in Chrome and press "Connect gimbal"`);
  void openLoop();
  return bridge;
}
