/**
 * Companion ⇄ Cardputer USB-serial protocol, v1 (agreed with the cardputer lane, Nov 2).
 *
 * Transport: the ESP32-S3 USB-Serial/JTAG peripheral (HWCDC; VID 0x303A, PID 0x1001). Open at
 * 115200 (never 1200), then ONE setSignals({dataTerminalReady: true, requestToSend: true}):
 * (DTR 0, RTS 1) resets the chip and (DTR 1, RTS 0) arms download mode, so never set the lines in
 * two calls. Keep the port open; reconnect with navigator.serial.getPorts().
 *
 * Framing: one UTF-8 JSON object per line, '\n' terminated ('\r\n' accepted). Host lines ≤ 8192
 * bytes, device lines ≤ 4096. Lines that do not start with '{' are noise (ROM boot text). Every
 * host command carries "t" and "id" (≤ 24 chars) and gets exactly one ack:
 *   {"t":"ack","id":"…","ok":true[,"ms":n]} | {"t":"ack","id":"…","ok":false,"err":"bad_json|unknown_type|bad_args|busy|unsupported|timeout|tx_failed","msg":"…"}
 *
 * Host → device
 *   hello  {proto:1, host}                         ack carries {proto, fw, board, chip, name, caps[], rx, tx[]}
 *   ir     {khz, us[], repeats, gapMs, label, tx?:'led'|'grove'}   raw mark/space µs (2..1024, 1..65000 each,
 *          ≤ 500 ms per frame, repeats 0..5, gapMs 0..500); ack after the last frame. Sends start ≥ 250 ms
 *          apart on the device; a second ir while one is pending → err "busy".
 *   learn  {on:true, timeoutMs, label?, step?, of?, slot?} → ack, then {"t":"learned",…} per frame; {on:false} stops
 *   panic  stop IR and learning, clear the queue
 *   pair   {state:'pending'|'approved'|'denied'|'expired'|'linked', code?, display?, qr? (≤ 150), ttlMs?, name?, deviceId?}
 *   menu   {title, items:[{id, key, label, armed}] (≤ 12), bars:[{id, label, value 0..1, unit?, steps?, big?}] (≤ 3)}
 *   bar    {bar, value}
 *   show   {title?, text?, progress?, tone?:'ok'|'warn'|'bad'|'info', ms?, style?:'word'}
 *   beep   {hz 2000..4000, ms}
 * Device → host (no id): hello · ack · pick {item, key, fired?} · key {key} · log {lvl, msg} ·
 *   learned {us[], khz, protocol|proto, bytes "2C 52 …", bits, unitUs, checkOk, frames, frameGapUs, marks, label, slot} ·
 *   learnend {frames, reason: timeout|user} · pairreq {chip} (the user pressed P on the IR NODE screen)
 */

export const SERIAL_PROTO = 1;
export const HOST_MAX_LINE = 8192;
export const DEVICE_MAX_LINE = 4096;
export const ESPRESSIF_VID = 0x303a;
export const BAUD = 115200;

export interface MenuItem {
  id: string;
  key: string;
  label: string;
  armed: boolean;
}

export interface MenuBar {
  id: string;
  label: string;
  value: number;
  unit?: string;
  steps?: number;
  big?: boolean;
}

export type PairState = 'pending' | 'approved' | 'denied' | 'expired' | 'linked';

/** Host commands without the id (the link assigns it). */
export type HostCommand =
  | { t: 'hello'; proto: number; host: string }
  | { t: 'ir'; khz: number; us: number[]; repeats: number; gapMs: number; label?: string; tx?: 'led' | 'grove'; step?: number; of?: number; phase?: 'try' | 'replay' }
  | { t: 'learn'; on: boolean; timeoutMs?: number; label?: string; step?: number; of?: number; slot?: string }
  | { t: 'panic' }
  | { t: 'pair'; state: PairState; code?: string; display?: string; qr?: string; ttlMs?: number; name?: string; deviceId?: string }
  | { t: 'menu'; title: string; items: MenuItem[]; bars?: MenuBar[] }
  | { t: 'bar'; bar: string; value: number }
  | { t: 'show'; title?: string; text?: string; progress?: number; tone?: 'ok' | 'warn' | 'bad' | 'info'; ms?: number; style?: 'word' }
  | { t: 'beep'; hz: number; ms: number };

export interface DeviceInfo {
  proto?: number;
  fw?: string;
  board?: string;
  chip?: string;
  name?: string;
  caps: string[];
  rx?: string;
  tx?: string[];
}

export type DeviceMessage =
  | ({ t: 'hello' } & DeviceInfo)
  | { t: 'ack'; id: string; ok: boolean; err?: string; msg?: string; ms?: number; extra: Record<string, unknown> }
  | { t: 'pick'; item: string; key?: string; fired?: boolean }
  | { t: 'key'; key: string }
  | { t: 'learned'; us: number[]; khz: number; proto?: string; bytes?: string; marks?: number; slot?: string; unitUs?: number; frames?: number; frameGapUs?: number; checkOk?: boolean; label?: string }
  | { t: 'learnend'; frames: number; reason: string }
  | { t: 'pairreq'; chip?: string }
  | { t: 'log'; lvl: string; msg: string }
  | { t: 'other'; type: string; raw: Record<string, unknown> };

export type ParsedLine = { kind: 'message'; message: DeviceMessage } | { kind: 'noise'; line: string } | { kind: 'bad'; line: string; error: string };

/** Splits a text stream into lines; drops (and reports) lines longer than maxLine. */
export class LineSplitter {
  private buf = '';
  overlong = 0;

  constructor(private readonly maxLine = DEVICE_MAX_LINE) {}

  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      let line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length > this.maxLine) {
        this.overlong++;
        continue;
      }
      if (line.trim()) out.push(line);
    }
    if (this.buf.length > this.maxLine) {
      // a runaway line without '\n': drop what we have and resync at the next newline
      this.overlong++;
      this.buf = '';
    }
    return out;
  }

  reset(): void {
    this.buf = '';
  }
}

const str = (v: unknown, max = 200): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function deviceInfo(o: Record<string, unknown>): DeviceInfo {
  const info: DeviceInfo = { caps: Array.isArray(o.caps) ? o.caps.filter((c): c is string => typeof c === 'string').slice(0, 32) : [] };
  const p = num(o.proto);
  if (p !== undefined) info.proto = p;
  for (const k of ['fw', 'board', 'chip', 'name', 'rx'] as const) {
    const v = str(o[k], 120);
    if (v !== undefined) info[k] = v;
  }
  if (Array.isArray(o.tx)) info.tx = o.tx.filter((x): x is string => typeof x === 'string').slice(0, 8);
  return info;
}

export function parseDeviceLine(line: string): ParsedLine {
  const s = line.trim();
  if (!s.startsWith('{')) return { kind: 'noise', line: s };
  let o: unknown;
  try {
    o = JSON.parse(s);
  } catch {
    return { kind: 'bad', line: s, error: 'not JSON' };
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { kind: 'bad', line: s, error: 'not an object' };
  const r = o as Record<string, unknown>;
  const t = str(r.t, 32);
  switch (t) {
    case 'hello':
      return { kind: 'message', message: { t: 'hello', ...deviceInfo(r) } };
    case 'ack': {
      const id = str(r.id, 64);
      if (!id || typeof r.ok !== 'boolean') return { kind: 'bad', line: s, error: 'ack needs id and ok' };
      const { t: _t, id: _id, ok, err, msg, ms, ...extra } = r;
      const m: DeviceMessage = { t: 'ack', id, ok: ok as boolean, extra };
      if (typeof err === 'string') m.err = err.slice(0, 64);
      if (typeof msg === 'string') m.msg = msg.slice(0, 500);
      if (num(ms) !== undefined) m.ms = ms as number;
      return { kind: 'message', message: m };
    }
    case 'pick': {
      const item = str(r.item, 64);
      if (!item) return { kind: 'bad', line: s, error: 'pick needs item' };
      const m: DeviceMessage = { t: 'pick', item };
      const key = str(r.key, 16);
      if (key) m.key = key;
      if (r.fired === true) m.fired = true;
      return { kind: 'message', message: m };
    }
    case 'learnend':
      return { kind: 'message', message: { t: 'learnend', frames: num(r.frames) ?? 0, reason: str(r.reason, 32) ?? 'timeout' } };
    case 'pairreq':
      return { kind: 'message', message: { t: 'pairreq', ...(str(r.chip, 32) ? { chip: str(r.chip, 32) } : {}) } };
    case 'key': {
      const key = str(r.key, 16);
      if (!key) return { kind: 'bad', line: s, error: 'key needs key' };
      return { kind: 'message', message: { t: 'key', key } };
    }
    case 'learned': {
      if (!Array.isArray(r.us) || !r.us.every((x) => typeof x === 'number' && Number.isFinite(x))) return { kind: 'bad', line: s, error: 'learned needs us[]' };
      const m: DeviceMessage = { t: 'learned', us: (r.us as number[]).slice(0, 1024), khz: num(r.khz) ?? 38 };
      const proto = str(r.protocol, 16) ?? str(r.proto, 16);
      if (proto) m.proto = proto;
      for (const k of ['unitUs', 'frames', 'frameGapUs'] as const) {
        const v = num(r[k]);
        if (v !== undefined) m[k] = v;
      }
      if (typeof r.checkOk === 'boolean') m.checkOk = r.checkOk;
      const label = str(r.label, 64);
      if (label) m.label = label;
      const bytes = str(r.bytes, 200);
      if (bytes) m.bytes = bytes;
      const marks = num(r.marks);
      if (marks !== undefined) m.marks = marks;
      const slot = str(r.slot, 32);
      if (slot) m.slot = slot;
      return { kind: 'message', message: m };
    }
    case 'log':
      return { kind: 'message', message: { t: 'log', lvl: str(r.lvl, 16) ?? 'info', msg: str(r.msg, 1000) ?? '' } };
    default:
      return t ? { kind: 'message', message: { t: 'other', type: t, raw: r } } : { kind: 'bad', line: s, error: 'no "t"' };
  }
}

/** Serialise a host command with its id; throws when the line would exceed the device limit. */
export function encodeHostLine(cmd: HostCommand, id: string): string {
  const line = JSON.stringify({ ...cmd, id });
  if (new TextEncoder().encode(line).length + 1 > HOST_MAX_LINE) throw new Error(`serial line too long (${line.length} chars, max ${HOST_MAX_LINE})`);
  return `${line}\n`;
}
