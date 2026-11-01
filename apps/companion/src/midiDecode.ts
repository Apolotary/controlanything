/** Pure MIDI helpers (no Web MIDI dependency) so they can be unit tested. */

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** 60 -> "C4" (middle C = C4). */
export function noteName(n: number): string {
  return `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
}

export function toHex(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

/** "f0 7e 7f" / "F07E7F" -> [0xF0, 0x7E, 0x7F]; undefined when it is not whole hex bytes. */
export function fromHex(text: string): number[] | undefined {
  const s = text.replace(/0x/gi, '').replace(/[\s,:-]/g, '');
  if (!s || s.length % 2 || /[^0-9a-f]/i.test(s)) return undefined;
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16));
  return out;
}

/** Clock (F8) and active sensing (FE) flood a monitor; hide them by default. */
export function isRealtimeNoise(bytes: ArrayLike<number>): boolean {
  return bytes.length === 1 && (bytes[0] === 0xf8 || bytes[0] === 0xfe);
}

/** Human-readable description of one MIDI message. */
export function describeMidi(bytes: ArrayLike<number>): string {
  if (!bytes.length) return 'empty';
  const status = bytes[0];
  const d1 = bytes[1] ?? 0;
  const d2 = bytes[2] ?? 0;
  if (status >= 0xf0) {
    switch (status) {
      case 0xf0: {
        const id = parseIdentityReply(bytes);
        if (id) return `Identity reply: ${id.manufacturerName} · family 0x${hex4(id.family)} · model 0x${hex4(id.member)}`;
        if (isIdentityRequest(bytes)) return 'Identity request';
        return `SysEx (${bytes.length} bytes)`;
      }
      case 0xf2:
        return `Song position ${d1 | (d2 << 7)}`;
      case 0xf8:
        return 'Clock';
      case 0xfa:
        return 'Start';
      case 0xfb:
        return 'Continue';
      case 0xfc:
        return 'Stop';
      case 0xfe:
        return 'Active sensing';
      case 0xff:
        return 'Reset';
      default:
        return `System 0x${status.toString(16).toUpperCase()}`;
    }
  }
  const ch = (status & 0x0f) + 1;
  switch (status & 0xf0) {
    case 0x80:
      return `Note off ch${ch} ${noteName(d1)} v${d2}`;
    case 0x90:
      return d2 === 0 ? `Note off ch${ch} ${noteName(d1)}` : `Note on ch${ch} ${noteName(d1)} v${d2}`;
    case 0xa0:
      return `Aftertouch ch${ch} ${noteName(d1)} ${d2}`;
    case 0xb0:
      return `CC ch${ch} #${d1} = ${d2}`;
    case 0xc0:
      return `Program ch${ch} ${d1 + 1}`;
    case 0xd0:
      return `Channel pressure ch${ch} ${d1}`;
    case 0xe0:
      return `Pitch bend ch${ch} ${(d1 | (d2 << 7)) - 8192}`;
    default:
      return `Data ${toHex(bytes)}`;
  }
}

/** Note-on / note-off byte triples for a channel 1-16. */
export function noteOn(channel: number, note: number, velocity: number): [number, number, number] {
  return [0x90 | ((channel - 1) & 0x0f), note & 0x7f, velocity & 0x7f];
}

export function noteOff(channel: number, note: number): [number, number, number] {
  return [0x80 | ((channel - 1) & 0x0f), note & 0x7f, 0];
}

export function controlChange(channel: number, cc: number, value: number): [number, number, number] {
  return [0xb0 | ((channel - 1) & 0x0f), cc & 0x7f, value & 0x7f];
}

export function programChange(channel: number, program: number): [number, number] {
  return [0xc0 | ((channel - 1) & 0x0f), program & 0x7f];
}

// --- identity (Universal Non-Real-Time SysEx, sub-ID 06) ------------------------------------

/** "Who are you?" to every device on the port. Read-only and safe (except on Ableton Move: send it no SysEx). */
export const IDENTITY_REQUEST: readonly number[] = [0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7];

export function isIdentityRequest(bytes: ArrayLike<number>): boolean {
  return bytes.length === 6 && bytes[0] === 0xf0 && bytes[1] === 0x7e && bytes[3] === 0x06 && bytes[4] === 0x01 && bytes[5] === 0xf7;
}

/** MMA manufacturer ids we expect to meet (hex, as written in the MMA table). */
const MANUFACTURERS: Record<string, string> = {
  '00 20 76': 'Teenage Engineering',
  '00 21 1D': 'Ableton',
  '00 20 6B': 'Arturia',
  '00 20 3C': 'Elektron',
  '00 20 32': 'Behringer',
  '00 01 72': 'Kilpatrick Audio',
  '7D': 'non-commercial (simulator)',
  '41': 'Roland',
  '42': 'Korg',
  '43': 'Yamaha',
  '47': 'Akai',
  '01': 'Sequential',
};

export function manufacturerName(id: readonly number[]): string {
  return MANUFACTURERS[toHex(id)] ?? `unknown manufacturer ${toHex(id)}`;
}

export interface IdentityReply {
  /** device-ID byte (0x7F = all; the EP-133 answers with its product byte 0x33) */
  deviceId: number;
  manufacturer: number[];
  manufacturerName: string;
  /** 14-bit values, LSB-first on the wire */
  family: number;
  member: number;
  /** software revision bytes as sent (often zero) */
  version: number[];
  hex: string;
}

function hex4(n: number): string {
  return n.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Parse F0 7E <dev> 06 02 <mfr 1 or 3 bytes> <family lo hi> <member lo hi> <version 4> F7.
 * Accepts any device-ID byte (research/05 §5.1). Returns undefined for anything else.
 */
export function parseIdentityReply(bytes: ArrayLike<number>): IdentityReply | undefined {
  const b = Array.from(bytes);
  if (b.length < 11 || b[0] !== 0xf0 || b[1] !== 0x7e || b[3] !== 0x06 || b[4] !== 0x02 || b[b.length - 1] !== 0xf7) return undefined;
  let i = 5;
  const manufacturer = b[i] === 0x00 ? b.slice(i, i + 3) : b.slice(i, i + 1);
  i += manufacturer.length;
  if (i + 4 > b.length - 1) return undefined;
  const family = b[i] | (b[i + 1] << 7);
  const member = b[i + 2] | (b[i + 3] << 7);
  const version = b.slice(i + 4, Math.min(i + 8, b.length - 1));
  return { deviceId: b[2], manufacturer, manufacturerName: manufacturerName(manufacturer), family, member, version, hex: toHex(b) };
}

export function describeIdentity(id: IdentityReply): string {
  return `${id.manufacturerName} (${toHex(id.manufacturer)}) · family 0x${hex4(id.family)} · model 0x${hex4(id.member)} · version ${id.version.join('.') || '—'} · device byte 0x${id.deviceId.toString(16).toUpperCase().padStart(2, '0')}`;
}
