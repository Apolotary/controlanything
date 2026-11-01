/**
 * Web Serial link to the Cardputer firmware (protocol in ./protocol.ts). Chrome/Edge only.
 * - The first connection needs a click (port chooser); afterwards getPorts() reopens it silently,
 *   including when the cable is replugged.
 * - One IR command in flight at a time, starts ≥ 250 ms apart (≤ 4 Hz), queue ≤ 8.
 */
import type { RawIr } from '../irCodec';
import {
  BAUD,
  type DeviceInfo,
  type DeviceMessage,
  encodeHostLine,
  ESPRESSIF_VID,
  type HostCommand,
  LineSplitter,
  parseDeviceLine,
  SERIAL_PROTO,
} from './protocol';

export type LinkState = 'unsupported' | 'idle' | 'connecting' | 'ready' | 'no-reply' | 'disconnected' | 'error';

export interface SerialAck {
  id: string;
  ok: boolean;
  err?: string;
  msg?: string;
  ms?: number;
  extra?: Record<string, unknown>;
  /** host clock (performance.now) when the line was written */
  writtenAt?: number;
  /** epoch ms when the line was written */
  writtenEpoch?: number;
}

export const IR_MIN_GAP_MS = 250;
const IR_QUEUE_MAX = 8;

export class CardputerLink {
  state: LinkState = CardputerLink.supported ? 'idle' : 'unsupported';
  info?: DeviceInfo;
  lastError?: string;
  private port?: SerialPort;
  private reader?: ReadableStreamDefaultReader<string>;
  private readClosed?: Promise<void>;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private readonly splitter = new LineSplitter();
  private readonly pending = new Map<string, { resolve: (a: SerialAck) => void; timer: ReturnType<typeof setTimeout>; writtenAt: number; writtenEpoch: number }>();
  private seq = 0;
  private irChain: Promise<unknown> = Promise.resolve();
  private irWaiting = 0;
  private lastIrStart = -Infinity;
  private listening = false;

  onState: (s: LinkState) => void = () => {};
  onMessage: (m: DeviceMessage) => void = () => {};
  /** every line in either direction, for the serial monitor */
  onLine: (dir: 'in' | 'out', text: string) => void = () => {};

  constructor(private readonly hostName: string) {}

  static get supported(): boolean {
    return typeof navigator !== 'undefined' && Boolean(navigator.serial);
  }

  get ready(): boolean {
    return this.state === 'ready';
  }

  get hasPort(): boolean {
    return Boolean(this.port);
  }

  private setState(s: LinkState, err?: string): void {
    this.state = s;
    if (err) this.lastError = err;
    this.onState(s);
  }

  /** Watch for the cable being plugged back in (no prompt needed for a granted port). */
  listenForPlug(): void {
    if (!CardputerLink.supported || this.listening) return;
    this.listening = true;
    navigator.serial!.addEventListener('connect', () => {
      if (!this.port) void this.reconnect();
    });
    navigator.serial!.addEventListener('disconnect', (e) => {
      if ((e.target as SerialPort | null) === this.port || !this.port) void this.dropPort('unplugged');
    });
  }

  /** Reopen a port granted earlier. Returns false when there is none (then call choose()). */
  async reconnect(): Promise<boolean> {
    if (!CardputerLink.supported || this.port) return Boolean(this.port);
    const ports = await navigator.serial!.getPorts();
    const port = ports.find((p) => p.getInfo().usbVendorId === ESPRESSIF_VID) ?? ports[0];
    if (!port) return false;
    return this.open(port);
  }

  /** Show Chrome's port chooser (must run inside a click handler). */
  async choose(anyDevice = false): Promise<boolean> {
    if (!CardputerLink.supported) return false;
    try {
      const port = await navigator.serial!.requestPort(anyDevice ? {} : { filters: [{ usbVendorId: ESPRESSIF_VID }] });
      if (this.port) await this.close();
      return await this.open(port);
    } catch (e) {
      // NotFoundError = the user closed the chooser
      if ((e as Error).name !== 'NotFoundError') this.setState('error', (e as Error).message);
      return false;
    }
  }

  private async open(port: SerialPort): Promise<boolean> {
    this.setState('connecting');
    try {
      await port.open({ baudRate: BAUD });
      // ONE call with both lines high: (DTR 0, RTS 1) would reset the S3, (1, 0) arms download mode
      await port.setSignals({ dataTerminalReady: true, requestToSend: true });
    } catch (e) {
      this.setState('error', `could not open the serial port: ${(e as Error).message}`);
      return false;
    }
    this.port = port;
    this.splitter.reset();
    this.writer = port.writable!.getWriter();
    const decoder = new TextDecoderStream();
    this.readClosed = port.readable!.pipeTo(decoder.writable as unknown as WritableStream<Uint8Array>).catch(() => {});
    this.reader = decoder.readable.getReader();
    void this.readLoop(this.reader);
    const ack = await this.request({ t: 'hello', proto: SERIAL_PROTO, host: this.hostName }, 1500);
    if (ack.ok) {
      this.info = this.infoFrom(ack.extra ?? {});
      this.setState('ready');
    } else {
      // old firmware, a different device, or still booting: an unsolicited hello can still arrive
      this.setState('no-reply', ack.err === 'timeout' ? 'no hello reply within 1.5 s' : (ack.msg ?? ack.err));
    }
    return true;
  }

  private infoFrom(o: Record<string, unknown>): DeviceInfo {
    const caps = Array.isArray(o.caps) ? o.caps.filter((c): c is string => typeof c === 'string') : [];
    const info: DeviceInfo = { caps };
    for (const k of ['fw', 'board', 'chip', 'name', 'rx'] as const) if (typeof o[k] === 'string') info[k] = (o[k] as string).slice(0, 120);
    if (typeof o.proto === 'number') info.proto = o.proto;
    if (Array.isArray(o.tx)) info.tx = o.tx.filter((x): x is string => typeof x === 'string');
    return info;
  }

  private async readLoop(reader: ReadableStreamDefaultReader<string>): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const line of this.splitter.push(value)) this.onIncoming(line);
      }
    } catch (e) {
      if (this.reader === reader) await this.dropPort(`serial read failed: ${(e as Error).message}`);
      return;
    }
    if (this.reader === reader) await this.dropPort('serial stream ended');
  }

  private onIncoming(line: string): void {
    this.onLine('in', line);
    const p = parseDeviceLine(line);
    if (p.kind !== 'message') return;
    const m = p.message;
    if (m.t === 'ack') {
      const w = this.pending.get(m.id);
      if (!w) return;
      clearTimeout(w.timer);
      this.pending.delete(m.id);
      w.resolve({ id: m.id, ok: m.ok, err: m.err, msg: m.msg, ms: m.ms, extra: m.extra, writtenAt: w.writtenAt, writtenEpoch: w.writtenEpoch });
      return;
    }
    if (m.t === 'hello') {
      const { t: _t, ...info } = m;
      this.info = info;
      if (this.state !== 'ready') this.setState('ready');
    }
    this.onMessage(m);
  }

  /** Send one command and wait for its ack. Never throws. */
  async request(cmd: HostCommand, timeoutMs = 2000): Promise<SerialAck> {
    const id = `c${++this.seq}`;
    if (!this.writer) return { id, ok: false, err: 'offline', msg: 'no Cardputer connected' };
    let line: string;
    try {
      line = encodeHostLine(cmd, id);
    } catch (e) {
      return { id, ok: false, err: 'bad_args', msg: (e as Error).message };
    }
    return new Promise<SerialAck>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ id, ok: false, err: 'timeout', msg: `no ack within ${timeoutMs} ms` });
      }, timeoutMs);
      const writtenAt = performance.now();
      const writtenEpoch = Date.now();
      this.pending.set(id, { resolve, timer, writtenAt, writtenEpoch });
      this.onLine('out', line.trimEnd());
      this.writer!.write(new TextEncoder().encode(line)).catch((e: Error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ id, ok: false, err: 'offline', msg: `write failed: ${e.message}` });
      });
    });
  }

  /** Play a raw IR frame: one at a time, ≥ 250 ms between starts, at most 8 waiting. */
  sendIr(raw: RawIr, extra: Partial<Extract<HostCommand, { t: 'ir' }>> = {}): Promise<SerialAck> {
    if (this.irWaiting >= IR_QUEUE_MAX) return Promise.resolve({ id: '-', ok: false, err: 'rate_limited', msg: `IR queue full (≤ ${IR_QUEUE_MAX} waiting, ≤ 4 Hz)` });
    this.irWaiting++;
    const run = async (): Promise<SerialAck> => {
      const wait = this.lastIrStart + IR_MIN_GAP_MS - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastIrStart = performance.now();
      const frameMs = raw.us.reduce((s, x) => s + x, 0) / 1000;
      const budget = 1500 + (frameMs + raw.gapMs) * (raw.repeats + 1);
      return this.request({ t: 'ir', khz: raw.khz, us: raw.us, repeats: raw.repeats, gapMs: raw.gapMs, label: raw.label, ...extra }, budget);
    };
    const p = this.irChain.then(run, run);
    this.irChain = p.catch(() => {});
    return p.finally(() => {
      this.irWaiting--;
    });
  }

  learn(on: boolean, opts: { timeoutMs?: number; label?: string; step?: number; of?: number; slot?: string } = {}): Promise<SerialAck> {
    return this.request({ t: 'learn', on, ...opts });
  }

  async close(): Promise<void> {
    await this.dropPort('closed', true);
  }

  private async dropPort(reason: string, deliberate = false): Promise<void> {
    const port = this.port;
    const reader = this.reader;
    const writer = this.writer;
    this.port = undefined;
    this.reader = undefined;
    this.writer = undefined;
    for (const [id, w] of this.pending) {
      clearTimeout(w.timer);
      w.resolve({ id, ok: false, err: 'offline', msg: reason });
    }
    this.pending.clear();
    try {
      await reader?.cancel();
    } catch {
      // already errored
    }
    await this.readClosed;
    try {
      writer?.releaseLock();
    } catch {
      // ignore
    }
    try {
      await port?.close();
    } catch {
      // unplugged ports can't be closed cleanly
    }
    if (port || deliberate) this.setState(deliberate ? 'idle' : 'disconnected', deliberate ? undefined : reason);
  }
}
