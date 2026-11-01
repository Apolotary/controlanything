/**
 * Infrared codec for the two formats every Japanese ceiling-light remote found so far uses:
 * NEC (9/4.5 ms leader, T = 562.5 us, 32 bits) and AEHA (8T/4T leader, T ~ 425 us, 40-88+ bits).
 * Bytes are in send order, LSB-first per byte (the native notation of both formats). Timings are
 * alternating mark/space microseconds starting with a mark, which is what the Cardputer firmware,
 * the sim lamp and the companion all speak.
 *
 * Facts behind the numbers: apps/server/data/devices/jp-ceiling-light-ir.json (protocols section, with sources).
 */
import type { IrCapture, IrOp, IrProtocol } from '@ce/protocol';

export const NEC_UNIT_US = 562.5;
export const AEHA_UNIT_US = 425;
/** a space longer than this separates two frames inside one capture */
export const FRAME_GAP_MIN_US = 6000;

export interface IrFrame {
  protocol: 'NEC' | 'AEHA';
  bytes: number[];
  unitUs: number;
}

export function hexToBytes(hex: string): number[] {
  const parts = hex.trim().split(/[\s,]+/).filter(Boolean);
  const out = parts.map((p) => parseInt(p, 16));
  if (out.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) throw new Error(`bad IR byte string "${hex}"`);
  return out;
}

export function bytesToHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

/** AEHA: the low nibble of byte 2 is the XOR of the four customer-code nibbles. */
export function aehaParityOk(b: number[]): boolean {
  if (b.length < 3) return false;
  const p = (b[0] >> 4) ^ (b[0] & 15) ^ (b[1] >> 4) ^ (b[1] & 15);
  return (b[2] & 15) === p;
}

/** NEC: byte 3 is the complement of byte 2 (extended 16-bit custom codes leave bytes 0/1 free). */
export function necCommandOk(b: number[]): boolean {
  return b.length === 4 && ((b[2] ^ b[3]) & 0xff) === 0xff;
}

/** NEC convenience: 16-bit extended address (LSB-first bytes) + command -> 4 bytes. */
export function necBytes(address: number, command: number): number[] {
  return [address & 0xff, (address >> 8) & 0xff, command & 0xff, ~command & 0xff];
}

/** One frame's mark/space timings. */
export function encodeFrame(f: IrFrame): number[] {
  const T = f.protocol === 'NEC' ? NEC_UNIT_US : f.unitUs;
  const out: number[] = f.protocol === 'NEC' ? [16 * T, 8 * T] : [8 * T, 4 * T];
  for (const b of f.bytes) for (let i = 0; i < 8; i++) out.push(T, (b >> i) & 1 ? 3 * T : T);
  out.push(T); // trailer mark
  return out.map((v) => Math.round(v));
}

/**
 * Decode one frame from timings (mark first). Returns null when the leader is neither NEC nor AEHA
 * (proprietary formats are replayed raw instead). Tolerant to the 7-12 % stretch real receivers add.
 */
export function decodeFrame(us: number[]): IrFrame | null {
  if (us.length < 4) return null;
  const [m0, s0] = us;
  const near = (x: number, y: number, tol: number) => Math.abs(x - y) <= y * tol;
  let protocol: 'NEC' | 'AEHA';
  let T: number;
  if (m0 > 7000 && m0 < 11500 && near(s0, m0 / 2, 0.35)) {
    protocol = 'NEC';
    T = m0 / 16;
  } else if (m0 > 2400 && m0 < 4800 && near(s0, m0 / 2, 0.35)) {
    protocol = 'AEHA';
    T = m0 / 8;
  } else return null;
  const bytes: number[] = [];
  let cur = 0;
  let n = 0;
  for (let i = 2; i + 1 < us.length; i += 2) {
    const mark = us[i];
    const space = us[i + 1];
    if (!near(mark, T, 0.6) || space > 6 * T) break; // trailer or inter-frame gap
    cur |= (space > 2 * T ? 1 : 0) << n;
    if (++n === 8) {
      bytes.push(cur);
      cur = 0;
      n = 0;
    }
  }
  if (!bytes.length) return null;
  return { protocol, bytes, unitUs: Math.round(protocol === 'NEC' ? NEC_UNIT_US : T) };
}

/** Split a capture of a whole press into frames at long spaces. Returns the frames and the gaps between them. */
export function splitFrames(us: number[]): { frames: number[][]; gapsUs: number[] } {
  const frames: number[][] = [];
  const gapsUs: number[] = [];
  let cur: number[] = [];
  for (let i = 0; i < us.length; i++) {
    const isSpace = i % 2 === 1;
    if (isSpace && us[i] >= FRAME_GAP_MIN_US && cur.length >= 3) {
      frames.push(cur);
      gapsUs.push(us[i]);
      cur = [];
      continue;
    }
    cur.push(us[i]);
  }
  if (cur.length >= 3) frames.push(cur);
  return { frames, gapsUs };
}

/** Everything the server learns from one capture: protocol, bytes, frame count and gap. */
export function analyseCapture(c: Pick<IrCapture, 'rawUs' | 'khz'>): IrCapture {
  const { frames, gapsUs } = splitFrames(c.rawUs);
  const decoded = frames.map(decodeFrame);
  const first = decoded.find(Boolean) ?? null;
  const out: IrCapture = { rawUs: c.rawUs, khz: c.khz ?? 38, frames: Math.max(1, frames.length), repeats: 0 };
  if (first) {
    out.protocol = first.protocol;
    out.bytes = first.bytes;
    out.unitUs = first.unitUs;
  } else out.protocol = 'UNKNOWN';
  if (gapsUs.length) out.frameGapUs = Math.round(gapsUs.reduce((a, b) => a + b, 0) / gapsUs.length);
  return out;
}

/** Two captures carry the same code when their decoded bytes agree (or their raw timings do, within 20 %). */
export function sameCode(a: IrCapture, b: IrCapture): boolean {
  if (a.bytes?.length && b.bytes?.length) return a.protocol === b.protocol && a.bytes.length === b.bytes.length && a.bytes.every((x, i) => x === b.bytes![i]);
  const fa = splitFrames(a.rawUs).frames[0] ?? a.rawUs;
  const fb = splitFrames(b.rawUs).frames[0] ?? b.rawUs;
  if (Math.abs(fa.length - fb.length) > 2) return false;
  const n = Math.min(fa.length, fb.length);
  let bad = 0;
  for (let i = 0; i < n; i++) if (Math.abs(fa[i] - fb[i]) > Math.max(150, fa[i] * 0.2)) bad++;
  return bad <= Math.ceil(n * 0.05);
}

/** Default unit time for an op that gives none. */
export function unitFor(protocol: IrProtocol, unitUs?: number): number {
  if (protocol === 'NEC') return NEC_UNIT_US;
  return unitUs ?? AEHA_UNIT_US;
}

/**
 * Make an op executor-ready: fill `rawUs` from protocol + bytes (or NEC address/command) when it is missing,
 * default the carrier to 38 kHz. RAW ops must already carry rawUs. Throws when nothing can be encoded.
 */
export function fillRaw(op: IrOp): IrOp {
  const out: IrOp = { ...op, khz: op.khz ?? 38 };
  if (out.rawUs?.length) return out;
  let bytes = op.bytes;
  if ((!bytes || !bytes.length) && op.protocol === 'NEC' && op.address !== undefined && op.command !== undefined) bytes = necBytes(op.address, op.command);
  if (!bytes?.length) throw new Error(`IR op has neither rawUs nor bytes (${op.protocol})`);
  if (op.protocol !== 'NEC' && op.protocol !== 'AEHA') throw new Error(`IR protocol ${op.protocol} needs rawUs (only NEC and AEHA are synthesised)`);
  out.bytes = bytes;
  out.unitUs = unitFor(op.protocol, op.unitUs);
  out.rawUs = encodeFrame({ protocol: op.protocol, bytes, unitUs: out.unitUs });
  return out;
}

/** Microseconds one send of an op occupies (frames + gaps), for rate limiting. */
export function opDurationUs(op: IrOp): number {
  const frame = (op.rawUs ?? []).reduce((a, b) => a + b, 0);
  const repeats = op.repeats ?? 0;
  return frame * (repeats + 1) + (op.frameGapUs ?? 40_000) * repeats;
}
