/**
 * IR frames as raw timings: the Cardputer firmware only ever receives mark/space µs arrays, so
 * encoding NEC and AEHA (家製協) happens here. Convention (research/05 §3.2): bytes in send order,
 * LSB-first within each byte; timings alternate mark/space and start with a mark.
 */
import type { IrOp, Result } from './contracts';
import { toHex } from './midiDecode';

export type IrProto = 'NEC' | 'AEHA';

export interface IrFrame {
  proto: IrProto;
  bytes: number[];
  /** AEHA unit T in µs (350-500, typically 425-432) */
  unitUs?: number;
}

/** What goes to the Cardputer: {"t":"ir", khz, us, repeats, gapMs, label}. */
export interface RawIr {
  khz: number;
  us: number[];
  /** extra full frames after the first */
  repeats: number;
  gapMs: number;
  label: string;
}

const NEC_T = 562.5;

export function encodeFrame(f: IrFrame): number[] {
  const T = f.proto === 'NEC' ? NEC_T : (f.unitUs ?? 425);
  const out = f.proto === 'NEC' ? [16 * T, 8 * T] : [8 * T, 4 * T];
  for (const b of f.bytes) for (let i = 0; i < 8; i++) out.push(T, (b >> i) & 1 ? 3 * T : T);
  out.push(T);
  return out.map(Math.round);
}

/** Classify a capture by its leader; undefined for anything that is neither NEC nor AEHA. */
export function decodeFrame(us: readonly number[]): IrFrame | undefined {
  if (us.length < 4) return undefined;
  const [m0, s0] = us;
  const near = (x: number, y: number, tol: number) => Math.abs(x - y) <= y * tol;
  let proto: IrProto;
  let T: number;
  if (m0 > 7000 && m0 < 11000 && near(s0, m0 / 2, 0.3)) {
    proto = 'NEC';
    T = m0 / 16;
  } else if (m0 > 2400 && m0 < 4500 && near(s0, m0 / 2, 0.3)) {
    proto = 'AEHA';
    T = m0 / 8;
  } else return undefined;
  const bytes: number[] = [];
  let cur = 0;
  let n = 0;
  for (let i = 2; i + 1 < us.length; i += 2) {
    const mark = us[i];
    const space = us[i + 1];
    if (!near(mark, T, 0.5) || space > 6 * T) break;
    cur |= (space > 2 * T ? 1 : 0) << n;
    if (++n === 8) {
      bytes.push(cur);
      cur = 0;
      n = 0;
    }
  }
  return bytes.length ? { proto, bytes, unitUs: Math.round(T) } : undefined;
}

/** AEHA: the low nibble of byte 2 is the XOR of the four customer-code nibbles. */
export function aehaParityOk(b: readonly number[]): boolean {
  if (b.length < 3) return false;
  const p = (b[0] >> 4) ^ (b[0] & 15) ^ (b[1] >> 4) ^ (b[1] & 15);
  return (b[2] & 15) === p;
}

/** NEC: byte 3 must be the complement of byte 2. */
export function necCommandOk(b: readonly number[]): boolean {
  return b.length === 4 && ((b[2] ^ b[3]) & 0xff) === 0xff;
}

/** NEC bytes in send order: 8-bit address (with its complement) or extended 16-bit address. */
export function necBytes(address: number, command: number): number[] {
  const a = address & 0xffff;
  const c = command & 0xff;
  const addr = a > 0xff ? [a & 0xff, a >> 8] : [a, ~a & 0xff];
  return [...addr, c, ~c & 0xff];
}

const reverse8 = (b: number) => {
  let r = 0;
  for (let i = 0; i < 8; i++) r |= ((b >> i) & 1) << (7 - i);
  return r;
};

/** IRremoteESP8266 prints NEC MSB-first ("0x41B67D82"); send order LSB-first is 82 6D BE 41. */
export function msbValueToBytes(value: string, bits = 32): number[] | undefined {
  const hex = value.replace(/^0x/i, '');
  if (!/^[0-9a-f]+$/i.test(hex) || bits % 8) return undefined;
  const n = BigInt(`0x${hex}`);
  const out: number[] = [];
  for (let i = bits / 8 - 1; i >= 0; i--) out.push(reverse8(Number((n >> BigInt(i * 8)) & 0xffn)));
  return out;
}

/** One-line description for logs, the HUD and the Cardputer screen. */
export function describeTimings(us: readonly number[]): string {
  const f = decodeFrame(us);
  if (f) return `${f.proto} ${toHex(f.bytes)}`;
  const lead = us.length >= 2 ? ` · leader ${(us[0] / 1000).toFixed(1)}/${(us[1] / 1000).toFixed(1)} ms` : '';
  return `RAW ${us.length} edges${lead}`;
}

/** Device limits (cardputer lane): 2..1024 entries, 1..65000 µs each, ≤ 500 ms per frame. */
export function checkTimings(us: readonly number[]): string | undefined {
  if (us.length < 2 || us.length > 1024) return `timings must have 2-1024 entries (got ${us.length})`;
  let total = 0;
  for (const x of us) {
    if (!Number.isInteger(x) || x < 1 || x > 65_000) return `each timing must be an integer 1-65000 µs (got ${x})`;
    total += x;
  }
  if (total > 500_000) return `a frame must last ≤ 500 ms (got ${Math.round(total / 1000)} ms)`;
  return undefined;
}

/**
 * IrOp (protocol v1, from a driver) → the raw form the Cardputer plays. The server always fills `rawUs`;
 * NEC/AEHA bytes (or a NEC address + command) are encoded here only when it doesn't.
 */
export function irOpToRaw(op: IrOp): Result<RawIr> {
  const khz = Math.round(op.khz ?? 38);
  if (khz < 30 || khz > 60) return { ok: false, error: 'khz must be 30-60' };
  const repeats = op.repeats ?? 0;
  if (!Number.isInteger(repeats) || repeats < 0 || repeats > 5) return { ok: false, error: 'repeats (extra frames) must be 0-5' };
  const named = op.bytes?.length ? `${op.protocol} ${toHex(op.bytes)}` : op.protocol;
  const label = (op.ref ? op.ref.replace(/^(lib|learned):/, '') : named).slice(0, 64);
  let us: number[];
  let gapMs = 75;
  if (op.rawUs?.length) {
    us = op.rawUs.map(Math.round);
  } else if (op.protocol === 'NEC') {
    const bytes = op.bytes?.length ? op.bytes : op.address !== undefined && op.command !== undefined ? necBytes(op.address, op.command) : undefined;
    if (!bytes) return { ok: false, error: 'NEC needs rawUs, bytes, or address + command' };
    us = encodeFrame({ proto: 'NEC', bytes });
    gapMs = 40;
  } else if (op.protocol === 'AEHA') {
    if (!op.bytes?.length) return { ok: false, error: 'AEHA needs rawUs or bytes (send order, LSB-first)' };
    us = encodeFrame({ proto: 'AEHA', bytes: op.bytes, unitUs: op.unitUs });
  } else {
    return { ok: false, error: `${op.protocol} needs rawUs (the companion only encodes NEC and AEHA)` };
  }
  if (op.frameGapUs !== undefined) gapMs = Math.round(op.frameGapUs / 1000);
  const bad = checkTimings(us);
  if (bad) return { ok: false, error: bad };
  if (gapMs < 0 || gapMs > 500) return { ok: false, error: 'frame gap must be 0-500 ms' };
  return { ok: true, value: { khz, us, repeats, gapMs, label: op.rawUs?.length && !op.ref && !op.bytes?.length ? describeTimings(us) : label } };
}
