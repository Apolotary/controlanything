/**
 * DJI DUML v1 framing, written for ControlAnything from the public protocol description (alkersan/om-research,
 * MIT, and o-gs/dji-firmware-tools' dissectors). No code is copied: the CRC tables are generated here from
 * their polynomials, and the framing is implemented from the field layout.
 *
 *   0  0x55 SOF
 *   1  uint16 LE: bits 0-9 total length, bits 10-15 version (1)
 *   3  CRC-8 of bytes 0..2 (reflected poly 0x31 -> 0x8C, init 0x77)
 *   4  sender     (OM gimbals: raw device id, app = 0x02)
 *   5  receiver   (gimbal = 0x04)
 *   6  uint16 LE sequence
 *   8  cmd type   (0x00 = request, no ack)
 *   9  cmd set    (0x04 = gimbal)
 *  10  cmd id
 *  11  payload
 *  -2  CRC-16 LE of everything before it (reflected poly 0x1021 -> 0x8408, init 0x3692)
 *
 * Pure Uint8Array code: no Node Buffer, so the same module works in a browser (Web Bluetooth) too.
 */

export const DUML_SOF = 0x55;
export const DUML_MIN_LENGTH = 13;
export const DUML_MAX_LENGTH = 0x3ff;
export const CRC8_INIT = 0x77;
export const CRC16_INIT = 0x3692;

function reflectedTable(poly: number, bits: 8 | 16): Uint16Array {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ poly : c >>> 1;
    table[i] = bits === 8 ? c & 0xff : c & 0xffff;
  }
  return table;
}

const CRC8_TABLE = reflectedTable(0x8c, 8);
const CRC16_TABLE = reflectedTable(0x8408, 16);

export function crc8(data: ArrayLike<number>, init = CRC8_INIT): number {
  let crc = init & 0xff;
  for (let i = 0; i < data.length; i++) crc = CRC8_TABLE[(crc ^ data[i]) & 0xff];
  return crc;
}

export function crc16(data: ArrayLike<number>, init = CRC16_INIT): number {
  let crc = init & 0xffff;
  for (let i = 0; i < data.length; i++) crc = (CRC16_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)) & 0xffff;
  return crc;
}

export interface DumlFrame {
  sender: number;
  receiver: number;
  seq: number;
  cmdType: number;
  cmdSet: number;
  cmdId: number;
  payload: Uint8Array;
}

export interface DumlPacket extends DumlFrame {
  length: number;
  version: number;
  raw: Uint8Array;
}

/** Build one complete packet (header CRC-8 and trailing CRC-16 included). */
export function buildDuml(f: DumlFrame): Uint8Array {
  const length = DUML_MIN_LENGTH + f.payload.length;
  if (length > DUML_MAX_LENGTH) throw new Error(`DUML packet too long (${length} bytes)`);
  const out = new Uint8Array(length);
  const verLen = (1 << 10) | length;
  out[0] = DUML_SOF;
  out[1] = verLen & 0xff;
  out[2] = (verLen >>> 8) & 0xff;
  out[3] = crc8(out.subarray(0, 3));
  out[4] = f.sender & 0xff;
  out[5] = f.receiver & 0xff;
  out[6] = f.seq & 0xff;
  out[7] = (f.seq >>> 8) & 0xff;
  out[8] = f.cmdType & 0xff;
  out[9] = f.cmdSet & 0xff;
  out[10] = f.cmdId & 0xff;
  out.set(f.payload, 11);
  const crc = crc16(out.subarray(0, length - 2));
  out[length - 2] = crc & 0xff;
  out[length - 1] = (crc >>> 8) & 0xff;
  return out;
}

/** Parse one packet that starts at byte 0; undefined when a CRC or the length does not hold. */
export function parseDuml(data: Uint8Array): DumlPacket | undefined {
  if (data.length < DUML_MIN_LENGTH || data[0] !== DUML_SOF) return undefined;
  const verLen = data[1] | (data[2] << 8);
  const length = verLen & DUML_MAX_LENGTH;
  if (length < DUML_MIN_LENGTH || data.length < length) return undefined;
  if (crc8(data.subarray(0, 3)) !== data[3]) return undefined;
  const crc = data[length - 2] | (data[length - 1] << 8);
  if (crc16(data.subarray(0, length - 2)) !== crc) return undefined;
  return {
    length,
    version: verLen >>> 10,
    sender: data[4],
    receiver: data[5],
    seq: data[6] | (data[7] << 8),
    cmdType: data[8],
    cmdSet: data[9],
    cmdId: data[10],
    payload: data.slice(11, length - 2),
    raw: data.slice(0, length),
  };
}

/**
 * Reassembles packets from BLE notification chunks: resynchronises on 0x55, waits for the declared length,
 * drops a candidate whose CRCs fail and continues one byte later.
 */
export class DumlStream {
  private buf = new Uint8Array(0);
  /** bytes discarded while resynchronising (diagnostics) */
  dropped = 0;

  feed(chunk: ArrayLike<number>): DumlPacket[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(Array.from(chunk), this.buf.length);
    const out: DumlPacket[] = [];
    let i = 0;
    while (i < merged.length) {
      if (merged[i] !== DUML_SOF) {
        i++;
        this.dropped++;
        continue;
      }
      if (merged.length - i < 4) break;
      const length = (merged[i + 1] | (merged[i + 2] << 8)) & DUML_MAX_LENGTH;
      if (length < DUML_MIN_LENGTH || crc8(merged.subarray(i, i + 3)) !== merged[i + 3]) {
        i++;
        this.dropped++;
        continue;
      }
      if (merged.length - i < length) break;
      const p = parseDuml(merged.subarray(i, i + length));
      if (!p) {
        i++;
        this.dropped++;
        continue;
      }
      out.push(p);
      i += length;
    }
    this.buf = merged.slice(i);
    // a corrupt length field must not make the buffer grow without bound
    if (this.buf.length > DUML_MAX_LENGTH * 2) {
      this.dropped += this.buf.length;
      this.buf = new Uint8Array(0);
    }
    return out;
  }

  reset(): void {
    this.buf = new Uint8Array(0);
  }
}

export const toHex = (b: ArrayLike<number>): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');

export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-f]/gi, '');
  if (clean.length % 2) throw new Error('odd hex length');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
