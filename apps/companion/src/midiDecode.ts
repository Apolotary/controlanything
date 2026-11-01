/** Pure MIDI helpers (no Web MIDI dependency) so they can be unit tested. */

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** 60 -> "C4" (middle C = C4). */
export function noteName(n: number): string {
  return `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
}

export function toHex(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
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
      case 0xf0:
        return `SysEx (${bytes.length} bytes)`;
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
