/**
 * The virtual IR receiver's codec. Timings alternate mark/space in microseconds and start with a mark,
 * exactly what a 38 kHz demodulating receiver reports and what the server puts in IrOp.rawUs.
 * Bytes are in send order, LSB-first within each byte (native NEC and AEHA notation).
 *
 * Decoding is by leader ratio, not absolute time, because real receivers stretch marks and shrink
 * spaces by 50-150 µs: NEC leader ≈ 16T/8T (9.0/4.5 ms), AEHA (家製協) leader ≈ 8T/4T (T ≈ 350-500 µs).
 */

export type IrProto = 'NEC' | 'AEHA';

export interface IrFrame {
  proto: IrProto;
  bytes: number[];
  /** unit time T in µs (NEC 562.5; AEHA typically 420-432) */
  unitUs: number;
}

export const NEC_T = 562.5;
export const AEHA_T = 425;

/** One frame as raw timings (leader, LSB-first bits, trailer mark). */
export function encodeFrame(f: { proto: IrProto; bytes: readonly number[]; unitUs?: number }): number[] {
  const T = f.proto === 'NEC' ? (f.unitUs ?? NEC_T) : (f.unitUs ?? AEHA_T);
  const out = f.proto === 'NEC' ? [16 * T, 8 * T] : [8 * T, 4 * T];
  for (const b of f.bytes) for (let i = 0; i < 8; i++) out.push(T, (b >> i) & 1 ? 3 * T : T);
  out.push(T);
  return out.map((x) => Math.round(x));
}

/**
 * A full press as one timing array: the frame plus `repeats` EXTRA copies (protocol IrOp convention:
 * 0 = sent once), each preceded by `frameGapUs` = the space after the previous frame's trailer mark.
 * rawUs entries are capped at 65 000 µs by the protocol, so the gap is clamped to that.
 */
export function encodePress(f: { proto: IrProto; bytes: readonly number[]; unitUs?: number }, repeats = 0, frameGapUs = 40_000): number[] {
  const one = encodeFrame(f);
  const out = [...one];
  for (let r = 0; r < repeats; r++) out.push(Math.min(65_000, frameGapUs), ...one);
  return out;
}

const near = (x: number, y: number, tol: number) => Math.abs(x - y) <= y * tol;

/** Decode the first frame in a timing array (repeats and trailing gaps are ignored). */
export function decodeFrame(us: readonly number[]): IrFrame | undefined {
  return decodeAll(us)[0];
}

/** Decode every frame in a timing array (a press often carries 2 identical frames ~75 ms apart). */
export function decodeAll(us: readonly number[]): IrFrame[] {
  const frames: IrFrame[] = [];
  let i = 0;
  while (i + 1 < us.length) {
    const m0 = us[i]!;
    const s0 = us[i + 1]!;
    let proto: IrProto | undefined;
    let T = 0;
    if (m0 > 7000 && m0 < 11_000 && near(s0, m0 / 2, 0.3)) {
      proto = 'NEC';
      T = m0 / 16;
    } else if (m0 > 2400 && m0 < 4500 && near(s0, m0 / 2, 0.3)) {
      proto = 'AEHA';
      T = m0 / 8;
    }
    if (!proto) {
      i += 1;
      continue;
    }
    const bytes: number[] = [];
    let cur = 0;
    let n = 0;
    let j = i + 2;
    for (; j + 1 < us.length; j += 2) {
      const mark = us[j]!;
      const space = us[j + 1]!;
      if (!near(mark, T, 0.6) || space > 6 * T) break; // trailer mark + inter-frame gap
      cur |= (space > 2 * T ? 1 : 0) << n;
      if (++n === 8) {
        bytes.push(cur);
        cur = 0;
        n = 0;
      }
    }
    if (bytes.length) frames.push({ proto, bytes, unitUs: Math.round(T) });
    i = j + 1;
  }
  return frames;
}

/** AEHA: the low nibble of byte 2 is the XOR of the four customer-code nibbles. */
export function aehaParityOk(b: readonly number[]): boolean {
  if (b.length < 3) return false;
  const p = (b[0]! >> 4) ^ (b[0]! & 15) ^ (b[1]! >> 4) ^ (b[1]! & 15);
  return (b[2]! & 15) === p;
}

/** NEC: byte 3 must be the complement of byte 2 (lighting uses extended 16-bit addresses). */
export function necCommandOk(b: readonly number[]): boolean {
  return b.length === 4 && ((b[2]! ^ b[3]!) & 0xff) === 0xff;
}

/** NEC address (byte0 | byte1 << 8) + command -> bytes in send order. */
export function necBytes(address: number, command: number): number[] {
  return [address & 0xff, (address >> 8) & 0xff, command & 0xff, ~command & 0xff];
}

export function hex(bytes: readonly number[]): string {
  return bytes.map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

export function parseHex(s: string): number[] {
  return s
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((x) => parseInt(x, 16));
}

/**
 * What a real demodulating receiver reports for a clean transmission: marks stretched and spaces
 * shrunk by ~50-150 µs, with jitter. Deterministic for a given seed so learned captures are reproducible.
 */
export function receiverDistort(us: readonly number[], seed = 1): number[] {
  let s = seed >>> 0 || 1;
  const rnd = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10_000) / 10_000;
  };
  return us.map((x, i) => {
    const skew = 60 + rnd() * 70; // µs
    const v = i % 2 === 0 ? x + skew : x - skew;
    return Math.max(50, Math.round(v));
  });
}
