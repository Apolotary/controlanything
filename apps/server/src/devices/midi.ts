/**
 * MIDI identity: the universal identity request/reply and the manufacturer ids we care about,
 * plus port-name matching. Used by LINK to cross-check the camera's guess against the cable
 * (SPEC §3.1 link.request "port-name and MIDI-identity cross-check evidence").
 */
import type { Port } from '@ce/protocol';

/** F0 7E <device> 06 01 F7 */
export const IDENTITY_REQUEST = [0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7];

/** MMA manufacturer ids (3-byte extended ids start with 00). */
export const MANUFACTURERS: Record<string, string> = {
  '00 20 76': 'Teenage Engineering',
  '00 21 1D': 'Ableton',
  '00 20 3C': 'Elektron',
  '00 21 69': 'Bastl Instruments',
  '41': 'Roland',
  '42': 'Korg',
  '43': 'Yamaha',
  '47': 'Akai',
  '7D': 'non-commercial / educational',
};

export interface IdentityReply {
  deviceId: number;
  manufacturerId: number[];
  manufacturer: string;
  family: number;
  model: number;
  version: number[];
}

const hex = (b: number[]) => b.map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ');

/**
 * Parse F0 7E <dev> 06 02 <mfr 1|3 bytes> <family 2 LSB-first> <model 2> <version 4> F7.
 * Accepts any device-id byte (the EP-133 answers with 0x33, not 7F). Returns null when it is not an identity reply.
 */
export function parseIdentityReply(bytes: number[]): IdentityReply | null {
  if (bytes.length < 11 || bytes[0] !== 0xf0 || bytes[1] !== 0x7e || bytes[3] !== 0x06 || bytes[4] !== 0x02) return null;
  let i = 5;
  const manufacturerId = bytes[i] === 0x00 ? bytes.slice(i, i + 3) : [bytes[i]];
  i += manufacturerId.length;
  if (bytes.length < i + 8) return null;
  const family = bytes[i] | (bytes[i + 1] << 7);
  const model = bytes[i + 2] | (bytes[i + 3] << 7);
  const version = bytes.slice(i + 4, i + 8);
  return {
    deviceId: bytes[2],
    manufacturerId,
    manufacturer: MANUFACTURERS[hex(manufacturerId)] ?? `unknown (${hex(manufacturerId)})`,
    family,
    model,
    version,
  };
}

/** Case-insensitive substring match of a profile's port-name hint against a port's name or id. */
export function portMatches(port: Pick<Port, 'id' | 'name'>, hint: string): boolean {
  const h = hint.toLowerCase();
  return port.name.toLowerCase().includes(h) || port.id.toLowerCase().includes(h);
}

/** The first MIDI output whose name matches the hint; else the only MIDI output; else undefined. */
export function pickMidiOutput(ports: Port[] | undefined, hint: string | undefined): Port | undefined {
  const outs = (ports ?? []).filter((p) => p.kind === 'midi-out' && p.state !== 'disconnected');
  if (hint) {
    const hit = outs.find((p) => portMatches(p, hint));
    if (hit) return hit;
  }
  return outs.length === 1 ? outs[0] : undefined;
}

/** True when a manufacturer name from the identity reply agrees with the maker the camera read. */
export function makerMatches(replyManufacturer: string, cameraMaker: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const a = norm(replyManufacturer);
  const b = norm(cameraMaker);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a) || (a.startsWith('teenage') && b === 'te');
}
