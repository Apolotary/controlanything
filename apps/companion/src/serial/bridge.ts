/**
 * Speaks for a USB-attached Cardputer on the server:
 *   1. pairs it on its behalf (requireApproval: the Quest looks at the QR on the Cardputer's screen, or
 *      the owner types the code), and stores its token per chip id;
 *   2. opens a second WebSocket *as the Cardputer*, so presence shows it and IR work is addressed to it;
 *   3. relays exec.command IrOps → serial "ir", sense.request ir-capture → serial "learn" → one
 *      sense.result per captured frame, menu picks → control.event, panic → serial "panic".
 */
import { type ExecAckPayload, type ExecCommandPayload, formatCode, type IrCapture, IrProtocol, normalizeCode, type PairStartResponse, type SenseRequestPayload, type UiSpecPayload } from '@ce/protocol';
import { api, ApiError } from '../api';
import { CLOSE_UNAUTHORIZED, Connection } from '../connection';
import { decodeFrame, describeTimings, irOpToRaw } from '../irCodec';
import { fromHex } from '../midiDecode';
import type { CardputerLink, SerialAck } from './cardputer';
import type { DeviceMessage, HostCommand, MenuItem } from './protocol';

interface StoredCardputer {
  deviceId: string;
  deviceToken: string;
  name: string;
}

export type BridgeState = 'no-device' | 'pairing' | 'denied' | 'connecting' | 'online' | 'offline';

export interface LearnedRow {
  n: number;
  at: number;
  capture: IrCapture;
  label: string;
  /** what the user was asked to press, e.g. "全灯" */
  prompt?: string;
  senseId?: string;
}

const KEY = (chip: string) => `ce.proxy.cardputer.${chip}`;
const MENU_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'enter', 'space'];

function load(chip: string): StoredCardputer | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(KEY(chip)) ?? 'null') as StoredCardputer | null;
    return v?.deviceToken && v.deviceId ? v : undefined;
  } catch {
    return undefined;
  }
}

function save(chip: string, s: StoredCardputer | undefined): void {
  try {
    if (s) localStorage.setItem(KEY(chip), JSON.stringify(s));
    else localStorage.removeItem(KEY(chip));
  } catch {
    // private mode: re-pair after a reload
  }
}

/**
 * The Cardputer's pairing screen. Its QR carries the short "CE1:<CODE>" text (uppercase, no dash: a
 * version-1 QR with 5 px modules on the 240×135 screen, instead of version 4 / 3 px for the URL); the
 * server's scan decoder resolves it exactly like the passcode. Phone-facing QRs keep the full URL.
 */
export function pairScreenCommand(r: Pick<PairStartResponse, 'code' | 'display' | 'expiresAt'>, now = Date.now()): Extract<HostCommand, { t: 'pair' }> {
  const code = normalizeCode(r.code);
  return { t: 'pair', state: 'pending', code, display: r.display || formatCode(code), qr: `CE1:${code}`, ttlMs: Math.max(0, r.expiresAt - now) };
}

/** Frames in a capture: one more than the number of long (> 15 ms) spaces. */
export function countFrames(us: readonly number[]): number {
  let n = 1;
  for (let i = 1; i < us.length - 1; i += 2) if (us[i] > 15_000) n++;
  return Math.min(8, n);
}

/** Serial `learned` event → protocol IrCapture. */
export function toCapture(m: Extract<DeviceMessage, { t: 'learned' }>): IrCapture {
  const rawUs = m.us.slice(0, 1024).map((x) => Math.min(200_000, Math.max(1, Math.round(x))));
  const decoded = decodeFrame(rawUs);
  const known = (IrProtocol.options as readonly string[]).includes(m.proto ?? '') ? (m.proto as IrCapture['protocol']) : undefined;
  const frames = m.frames && m.frames >= 1 ? Math.min(8, Math.round(m.frames)) : countFrames(rawUs);
  const cap: IrCapture = { rawUs: rawUs.length >= 2 ? rawUs : [rawUs[0] ?? 1, 1], khz: Math.min(60, Math.max(30, m.khz || 38)), frames };
  cap.protocol = known ?? decoded?.proto ?? 'UNKNOWN';
  const bytes = (m.bytes ? fromHex(m.bytes) : undefined) ?? decoded?.bytes;
  if (bytes?.length && bytes.length <= 16) cap.bytes = bytes;
  const unit = m.unitUs ?? decoded?.unitUs;
  if (unit && unit >= 200 && unit <= 1000) cap.unitUs = Math.round(unit);
  if (m.frameGapUs && m.frameGapUs >= 1000 && m.frameGapUs <= 500_000) cap.frameGapUs = Math.round(m.frameGapUs);
  return cap;
}

export class CardputerBridge {
  state: BridgeState = 'no-device';
  stored?: StoredCardputer;
  pairing?: { pairingId: string; pollSecret: string; display: string; qr: string; expiresAt: number };
  conn?: Connection;
  readonly learned: LearnedRow[] = [];
  learning?: { senseId?: string; prompt?: string; until: number; timer: ReturnType<typeof setTimeout> };
  menuTitle?: string;
  /** which emitter fires IR: the built-in LED (G44) or the IR Unit on Grove (G2); remembered per browser */
  tx: 'led' | 'grove' = (() => {
    try {
      return localStorage.getItem('ce.cardputer.tx') === 'grove' ? 'grove' : 'led';
    } catch {
      return 'led';
    }
  })();
  private menuSpecId?: string;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private chip = 'unknown';

  onChange: () => void = () => {};
  log: (level: 'debug' | 'info' | 'warn' | 'error', text: string) => void = () => {};

  constructor(
    readonly link: CardputerLink,
    private readonly appName: string,
  ) {}

  get online(): boolean {
    return this.state === 'online';
  }

  setTx(tx: 'led' | 'grove'): void {
    this.tx = tx;
    try {
      localStorage.setItem('ce.cardputer.tx', tx);
    } catch {
      // private mode
    }
    this.onChange();
  }

  get deviceId(): string | undefined {
    return this.stored?.deviceId;
  }

  private set(state: BridgeState): void {
    this.state = state;
    this.onChange();
  }

  /** Call when the serial link reports a hello (device ready). */
  async deviceReady(): Promise<void> {
    const info = this.link.info;
    this.chip = info?.chip ?? 'unknown';
    const stored = load(this.chip);
    if (stored) {
      this.stored = stored;
      this.connectAs(stored);
      return;
    }
    await this.startPairing();
  }

  /** Serial link closed or unplugged. */
  deviceGone(): void {
    clearTimeout(this.pollTimer);
    this.stopLearning();
    this.conn?.stop();
    this.conn = undefined;
    this.pairing = undefined;
    this.set('no-device');
  }

  /** Forget this Cardputer's pairing on the companion and pair again. */
  async repair(): Promise<void> {
    save(this.chip, undefined);
    this.stored = undefined;
    this.conn?.stop();
    this.conn = undefined;
    await this.startPairing();
  }

  async startPairing(): Promise<void> {
    clearTimeout(this.pollTimer);
    if (!this.link.ready) return;
    const name = this.link.info?.board === 'cardputer-adv' ? 'Cardputer-Adv' : (this.link.info?.name ?? 'Cardputer');
    this.set('pairing');
    try {
      const r = await api.pairStart({ name, kind: 'cardputer', capabilities: ['ir', 'display', 'speaker'], requireApproval: true });
      if (r.status === 'approved' && r.deviceId && r.deviceToken) {
        // an older server ignores requireApproval: accept it, but say so
        this.log('warn', 'the server approved the Cardputer instantly (requireApproval not honoured)');
        await this.adopt({ deviceId: r.deviceId, deviceToken: r.deviceToken, name });
        return;
      }
      this.pairing = { pairingId: r.pairingId, pollSecret: r.pollSecret, display: r.display, qr: r.qr, expiresAt: r.expiresAt };
      const ack = await this.link.request(pairScreenCommand(r));
      this.log(ack.ok ? 'info' : 'warn', ack.ok ? `Cardputer shows pairing code ${r.display}; approve it from the Quest (look at its QR) or type the code here` : `Cardputer did not take the pairing screen: ${ack.msg ?? ack.err}`);
      this.onChange();
      this.poll();
    } catch (e) {
      this.log('error', `could not start pairing for the Cardputer: ${(e as Error).message}`);
      this.set('offline');
    }
  }

  private poll(): void {
    const p = this.pairing;
    if (!p) return;
    this.pollTimer = setTimeout(async () => {
      if (this.pairing !== p) return;
      try {
        const s = await api.pairStatus(p.pairingId, p.pollSecret);
        if (s.status === 'approved' && s.deviceId && s.deviceToken) {
          this.pairing = undefined;
          const name = this.link.info?.board === 'cardputer-adv' ? 'Cardputer-Adv' : (this.link.info?.name ?? 'Cardputer');
          await this.link.request({ t: 'pair', state: 'approved', name, deviceId: s.deviceId });
          await this.adopt({ deviceId: s.deviceId, deviceToken: s.deviceToken, name });
          return;
        }
        if (s.status === 'denied' || s.status === 'expired') {
          this.pairing = undefined;
          await this.link.request({ t: 'pair', state: s.status });
          this.log('warn', `Cardputer pairing ${s.status}`);
          this.set('denied');
          return;
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          this.pairing = undefined;
          this.log('warn', 'the server forgot the Cardputer pairing request; start again');
          this.set('denied');
          return;
        }
      }
      this.poll();
    }, 1500);
  }

  private async adopt(s: StoredCardputer): Promise<void> {
    this.stored = s;
    save(this.chip, s);
    this.log('info', `Cardputer paired as ${s.name} (${s.deviceId})`);
    this.connectAs(s);
  }

  private connectAs(s: StoredCardputer): void {
    this.conn?.stop();
    this.set('connecting');
    const info = this.link.info;
    const c = new Connection(Connection.sameOrigin(), () => ({
      deviceToken: s.deviceToken,
      role: 'device',
      capabilities: ['ir', 'display', 'speaker'],
      app: `${info?.fw ?? 'cardputer'} via ${this.appName}`.slice(0, 120),
      ports: [{ id: `serial:${this.chip}`, kind: 'serial', name: `${s.name} USB serial`, state: 'connected' }],
    }));
    this.conn = c;
    c.onState = (st, closeInfo) => {
      if (st === 'open') this.set('online');
      if (st === 'closed') {
        if (closeInfo?.code === CLOSE_UNAUTHORIZED) {
          this.log('warn', 'the server no longer knows this Cardputer (revoked); pairing again');
          save(this.chip, undefined);
          this.stored = undefined;
          void this.startPairing();
          return;
        }
        if (this.conn === c) this.set('offline');
      }
    };
    c.on('welcome', () => {
      void this.link.request({ t: 'pair', state: 'linked', name: s.name, deviceId: s.deviceId });
    });
    c.on('exec.command', (m) => {
      if (m.to && m.to !== s.deviceId) return;
      void this.exec(m.payload).then((ack) => c.send('exec.ack', ack, { to: 'server' }));
    });
    c.on('sense.request', (m) => {
      if (m.to && m.to !== s.deviceId) return;
      void this.sense(m.payload);
    });
    c.on('panic', (m) => {
      if (m.to && m.to !== s.deviceId) return;
      void this.panic();
    });
    c.on('ui.spec', (m) => this.mirrorSpec(m.payload));
    c.start();
  }

  /** Run one exec.command on the Cardputer. Never throws. */
  async exec(cmd: ExecCommandPayload): Promise<ExecAckPayload> {
    const t0 = performance.now();
    const ack = (ok: boolean, extra: Partial<ExecAckPayload> = {}): ExecAckPayload => ({
      execId: cmd.execId,
      ok,
      sentAt: Date.now(),
      latencyMs: Math.round(performance.now() - t0),
      ...extra,
      ...(extra.detail ? { detail: extra.detail.slice(0, 1000) } : {}),
    });
    if (!this.link.ready) return ack(false, { error: 'serial_offline', detail: 'the Cardputer is not connected over USB' });
    const op = cmd.op;
    if (op.kind === 'ir') {
      const raw = irOpToRaw(op);
      if (!raw.ok) return ack(false, { error: 'bad_args', detail: raw.error });
      if (cmd.dryRun) return ack(true, { detail: `dry run: ${raw.value.label} (${raw.value.us.length} timings)` });
      const r = await this.link.sendIr(raw.value, { tx: this.tx });
      return this.serialAck(cmd, r, `${raw.value.label} (${this.tx === 'grove' ? 'IR Unit' : 'built-in LED'})`, t0);
    }
    if (op.kind === 'local' && op.op === 'beep') {
      const a = op.arg;
      const hz = typeof a === 'number' ? a : typeof a === 'object' && a && typeof (a as Record<string, unknown>).freq === 'number' ? ((a as Record<string, unknown>).freq as number) : 2600;
      const ms = typeof a === 'object' && a && typeof (a as Record<string, unknown>).ms === 'number' ? ((a as Record<string, unknown>).ms as number) : 80;
      const r = await this.link.request({ t: 'beep', hz: Math.round(hz), ms: Math.round(ms) });
      return this.serialAck(cmd, r, `beep ${Math.round(hz)} Hz`, t0);
    }
    if (op.kind === 'local' && op.op === 'screen' && typeof op.arg === 'string' && !op.arg.startsWith('#') && op.arg !== 'off') {
      const r = await this.link.request({ t: 'show', text: op.arg.slice(0, 8), style: 'word', ms: 4000 });
      return this.serialAck(cmd, r, `show "${op.arg.slice(0, 8)}"`, t0);
    }
    return ack(false, { error: 'unsupported', detail: `the Cardputer does not run ${op.kind === 'local' ? `local ${op.op}` : op.kind} ops` });
  }

  private serialAck(cmd: ExecCommandPayload, r: SerialAck, label: string, t0: number): ExecAckPayload {
    const base = { execId: cmd.execId, sentAt: r.writtenEpoch ?? Date.now(), latencyMs: Math.round((r.writtenAt ?? performance.now()) - t0) };
    const line = JSON.stringify({ t: 'ack', id: r.id, ok: r.ok, ...(r.err ? { err: r.err } : {}), ...(r.ms !== undefined ? { ms: r.ms } : {}) });
    if (r.ok) return { ...base, ok: true, detail: `${label} → Cardputer${r.ms !== undefined ? ` (${r.ms} ms on device)` : ''} · ${line}`.slice(0, 1000) };
    const error: ExecAckPayload['error'] = r.err === 'rate_limited' || r.err === 'busy' ? 'rate_limited' : r.err === 'timeout' ? 'timeout' : r.err === 'offline' ? 'serial_offline' : r.err === 'bad_args' || r.err === 'bad_json' ? 'bad_args' : r.err === 'unsupported' || r.err === 'unknown_type' ? 'unsupported' : 'device_error';
    return { ...base, ok: false, error, detail: `${label}: ${r.msg ?? r.err ?? 'failed'} · ${line}`.slice(0, 1000) };
  }

  private async sense(req: SenseRequestPayload): Promise<void> {
    const reply = (extra: Record<string, unknown>) =>
      this.conn?.send('sense.result', { senseId: req.senseId, kind: req.kind, at: Date.now(), ...extra }, { to: 'server' });
    if (req.kind !== 'ir-capture') {
      reply({ ok: false, error: `the Cardputer cannot sense ${req.kind}` });
      return;
    }
    if (!this.link.ready) {
      reply({ ok: false, error: 'the Cardputer is not connected over USB' });
      return;
    }
    await this.startLearning(req.durationMs ?? 10_000, req.prompt, req.senseId);
  }

  /** Listen for remote presses; each frame becomes a LEARN row (and a sense.result when the server asked). */
  async startLearning(durationMs = 15_000, prompt?: string, senseId?: string): Promise<boolean> {
    this.stopLearning(false);
    const ms = Math.min(60_000, Math.max(1000, durationMs));
    const r = await this.link.learn(true, { timeoutMs: ms, ...(prompt ? { label: prompt.slice(0, 40) } : {}) });
    if (!r.ok) {
      this.log('warn', `Cardputer could not start learning: ${r.msg ?? r.err}`);
      if (senseId) this.conn?.send('sense.result', { senseId, kind: 'ir-capture', at: Date.now(), ok: false, error: r.msg ?? r.err ?? 'learn failed' }, { to: 'server' });
      return false;
    }
    const timer = setTimeout(() => this.stopLearning(), ms + 250);
    this.learning = { senseId, prompt, until: Date.now() + ms, timer };
    this.log('info', `LEARN: ${prompt ? `press "${prompt}" on the remote` : 'press buttons on the remote'} (${Math.round(ms / 1000)} s)`);
    this.onChange();
    return true;
  }

  stopLearning(tellDevice = true): void {
    const l = this.learning;
    if (!l) return;
    clearTimeout(l.timer);
    this.learning = undefined;
    if (tellDevice && this.link.ready) void this.link.learn(false);
    if (l.senseId && !this.learned.some((row) => row.senseId === l.senseId)) {
      this.conn?.send('sense.result', { senseId: l.senseId, kind: 'ir-capture', at: Date.now(), ok: false, error: 'no IR frame captured (is the IR receiver plugged into Grove?)' }, { to: 'server' });
    }
    this.onChange();
  }

  /** Serial events from the Cardputer (wired by the app). */
  onDeviceMessage(m: DeviceMessage): void {
    if (m.t === 'learned') {
      const capture = toCapture(m);
      const row: LearnedRow = { n: (this.learned.at(-1)?.n ?? 0) + 1, at: Date.now(), capture, label: describeTimings(capture.rawUs), prompt: this.learning?.prompt ?? m.label, senseId: this.learning?.senseId };
      this.learned.push(row);
      if (this.learned.length > 40) this.learned.shift();
      if (row.senseId) this.conn?.send('sense.result', { senseId: row.senseId, kind: 'ir-capture', ir: capture, at: row.at, ok: true }, { to: 'server' });
      this.log('info', `LEARN #${row.n}: ${row.label} (${capture.rawUs.length} timings, ${capture.frames} frame${capture.frames === 1 ? '' : 's'})`);
      this.onChange();
    }
    if (m.t === 'learnend') {
      if (this.learning) this.stopLearning(false);
      return;
    }
    if (m.t === 'pairreq') {
      if (!this.online) void this.startPairing();
      return;
    }
    if (m.t === 'pick') {
      if (m.fired) {
        this.log('info', `Cardputer fired ${m.item} itself (local slot)`);
        return;
      }
      if (this.conn?.send('control.event', { widgetId: m.item.slice(0, 64), value: true, ts: Date.now(), phase: 'end', ...(this.menuSpecId ? { specId: this.menuSpecId } : {}) })) {
        this.log('info', `Cardputer key ${m.key ?? ''} → hack ${m.item}`);
      } else this.log('warn', `Cardputer picked ${m.item} but it is not online on the server`);
    }
  }

  /** Mirror a hack set for an IR device onto the Cardputer's screen (the physical-keys fallback). */
  mirrorSpec(spec: UiSpecPayload): void {
    const hs = spec.hackset;
    if (!hs || !this.link.ready) return;
    const viaMe = hs.device.channel.via && hs.device.channel.via === this.stored?.deviceId;
    if (hs.device.channel.type !== 'ir' && !viaMe) return;
    const items: MenuItem[] = hs.hacks
      .filter((h) => h.kind !== 'daemon')
      .slice(0, MENU_KEYS.length)
      .map((h, i) => ({ id: h.id, key: MENU_KEYS[i], label: h.name.slice(0, 16), armed: h.status === 'verified' }));
    this.menuSpecId = spec.specId;
    this.menuTitle = hs.device.name;
    void this.link.request({ t: 'menu', title: hs.device.name.slice(0, 24).toUpperCase(), items }).then((r) => {
      if (!r.ok) this.log('warn', `Cardputer menu refused: ${r.msg ?? r.err}`);
    });
    this.onChange();
  }

  async panic(): Promise<void> {
    this.stopLearning(false);
    if (this.link.ready) await this.link.request({ t: 'panic' });
  }
}
