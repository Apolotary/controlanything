/**
 * Which IR frames the virtual ceiling light obeys.
 *
 * The real lamp's remote (KOIZUMI KRH-TG-9A) has no public codes; the real flow LEARNS them with an IR
 * receiver. So the virtual lamp ships with its own clearly labelled SYNTHETIC code set ("SIM-KZ"): an
 * AEHA (家製協) frame family with a made-up customer code CE 51 that no catalogue contains. The agent cannot
 * know these codes in advance; it has to learn them from the virtual remote (or fail a blind search over
 * other brands' codes, which the lamp ignores = the honest miss). Once the real remote has been captured,
 * `fromLearned()` turns those captures into a code set so the sim obeys exactly the real lamp's codes.
 */
import { decodeAll, encodePress, hex, type IrFrame, type IrProto } from './codec';

export type LampCmd = 'fullOn' | 'on' | 'off' | 'brighter' | 'dimmer' | 'night' | 'warmer' | 'cooler';
export type Channel = 1 | 2;

export const LAMP_CMDS: readonly LampCmd[] = ['fullOn', 'on', 'off', 'brighter', 'dimmer', 'night', 'warmer', 'cooler'];

/** Button labels as printed on a Japanese dimming + colour remote (and English for the HUD). */
export const BUTTONS: Record<LampCmd, { ja: string; en: string }> = {
  fullOn: { ja: '全灯', en: 'Full' },
  on: { ja: '点灯', en: 'On' },
  off: { ja: '消灯', en: 'Off' },
  brighter: { ja: '明るく', en: 'Brighter' },
  dimmer: { ja: '暗く', en: 'Dimmer' },
  night: { ja: '常夜灯', en: 'Night light' },
  warmer: { ja: '暖かい光', en: 'Warmer' },
  cooler: { ja: '白い光', en: 'Cooler' },
};

export interface IrCode {
  id: string;
  cmd: LampCmd;
  channel: Channel;
  proto: IrProto;
  bytes: number[];
  unitUs: number;
  /** extra frames after the first (protocol convention: 0 = once) */
  repeats: number;
  frameGapUs: number;
}

export interface CodeSet {
  id: string;
  name: string;
  /** true = invented for the sim, NOT the real lamp's codes */
  synthetic: boolean;
  note: string;
  codes: IrCode[];
}

const SIM_CUSTOMER = [0xce, 0x51] as const; // "CE S1": made up for the sim; AEHA parity nibble = 6
const SIM_CMD_INDEX: Record<LampCmd, number> = { fullOn: 1, on: 2, off: 3, brighter: 4, dimmer: 5, night: 6, warmer: 7, cooler: 8 };

/** SIM-KZ frame for one button: CE 51 06 <ch<<4 | k> <byte2 ^ byte3>. */
export function simBytes(cmd: LampCmd, channel: Channel): number[] {
  const b2 = 0x06;
  const b3 = (channel << 4) | SIM_CMD_INDEX[cmd];
  return [SIM_CUSTOMER[0], SIM_CUSTOMER[1], b2, b3, b2 ^ b3];
}

export const SIM_KZ: CodeSet = {
  id: 'sim-kz',
  name: 'SIM-KZ (synthetic)',
  synthetic: true,
  note: 'Synthetic codes for the virtual lamp: AEHA, customer code CE 51 (made up), T = 420 µs, 2 frames per press. Not the real KOIZUMI codes, which have to be learned from the remote.',
  codes: ([1, 2] as const).flatMap((channel) =>
    LAMP_CMDS.map((cmd) => ({
      id: `sim-kz/ch${channel}/${cmd}`,
      cmd,
      channel,
      proto: 'AEHA' as const,
      bytes: simBytes(cmd, channel),
      unitUs: 420,
      repeats: 1,
      frameGapUs: 40_000,
    })),
  ),
};

export function codeFor(set: CodeSet, cmd: LampCmd, channel: Channel): IrCode | undefined {
  return set.codes.find((c) => c.cmd === cmd && c.channel === channel);
}

/** Raw timings the virtual remote emits for one press. */
export function pressTimings(code: IrCode): number[] {
  return encodePress({ proto: code.proto, bytes: code.bytes, unitUs: code.unitUs }, code.repeats, code.frameGapUs);
}

export interface MatchResult {
  frames: IrFrame[];
  /** the code the lamp obeys, if any */
  code?: IrCode;
  /** human-readable, for the receiver log */
  summary: string;
  /** a known code for the other channel (the lamp ignores it, like the real one) */
  otherChannel?: IrCode;
}

/** Decode a timing array and look it up for a lamp listening on `channel`. */
export function matchTimings(set: CodeSet, us: readonly number[], channel: Channel): MatchResult {
  const frames = decodeAll(us);
  if (!frames.length) return { frames, summary: `undecodable burst (${us.length} edges)` };
  const f = frames[0]!;
  const same = (c: IrCode) => c.proto === f.proto && c.bytes.length === f.bytes.length && c.bytes.every((b, i) => b === f.bytes[i]);
  const hit = set.codes.find((c) => same(c));
  const desc = `${f.proto} ${hex(f.bytes)} (T≈${f.unitUs} µs${frames.length > 1 ? `, ${frames.length} frames` : ''})`;
  if (!hit) return { frames, summary: `${desc}: not a code this lamp knows` };
  if (hit.channel !== channel) return { frames, otherChannel: hit, summary: `${desc}: ${set.name} CH${hit.channel} ${BUTTONS[hit.cmd].ja}, but the lamp is on CH${channel}` };
  return { frames, code: hit, summary: `${desc}: ${set.name} CH${hit.channel} ${BUTTONS[hit.cmd].ja} (${hit.cmd})` };
}

// --- learned real codes ------------------------------------------------------------------------

const FN_ALIASES: Record<string, LampCmd> = {
  fullon: 'fullOn',
  full: 'fullOn',
  '全灯': 'fullOn',
  on: 'on',
  '点灯': 'on',
  off: 'off',
  '消灯': 'off',
  brighter: 'brighter',
  up: 'brighter',
  '明るく': 'brighter',
  dimmer: 'dimmer',
  down: 'dimmer',
  '暗く': 'dimmer',
  night: 'night',
  nightlight: 'night',
  '常夜灯': 'night',
  warmer: 'warmer',
  warm: 'warmer',
  cooler: 'cooler',
  cool: 'cooler',
};

function cmdOf(v: unknown): LampCmd | undefined {
  if (typeof v !== 'string') return undefined;
  const k = v.replace(/[\s_\-()（）]/g, '').toLowerCase();
  return FN_ALIASES[k] ?? FN_ALIASES[v.trim()];
}

/**
 * Build a code set from captured real codes (e.g. apps/server/data/devices/koizumi-krh-tg-9a.learned.json).
 * Tolerant of field names: each entry needs a function (`function` | `cmd` | `button` | `fn`) and either
 * timings (`rawUs` | `us` | `raw`) or `bytes` + `protocol`. Entries it cannot decode are skipped.
 */
export function fromLearned(json: unknown, id = 'learned'): CodeSet | undefined {
  const root = json as { codes?: unknown[]; name?: string; remote?: string };
  const list = Array.isArray(root?.codes) ? root.codes : Array.isArray(json) ? (json as unknown[]) : [];
  const codes: IrCode[] = [];
  for (const raw of list) {
    const e = raw as Record<string, unknown>;
    const cmd = cmdOf(e.function ?? e.cmd ?? e.fn ?? e.button ?? e.label);
    if (!cmd) continue;
    const channel: Channel = Number(e.channel) === 2 ? 2 : 1;
    let frame: IrFrame | undefined;
    const us = (e.rawUs ?? e.us ?? e.raw) as number[] | undefined;
    if (Array.isArray(us) && us.length > 4) frame = decodeAll(us)[0];
    const bytes = e.bytes as number[] | string | undefined;
    const proto = String(e.protocol ?? e.proto ?? '').toUpperCase();
    if (!frame && bytes && (proto === 'NEC' || proto === 'AEHA')) {
      const b = typeof bytes === 'string' ? bytes.trim().split(/\s+/).map((x) => parseInt(x, 16)) : bytes;
      frame = { proto, bytes: b, unitUs: Number(e.unitUs) || (proto === 'NEC' ? 562.5 : 425) };
    }
    if (!frame) continue;
    codes.push({
      id: `${id}/ch${channel}/${cmd}`,
      cmd,
      channel,
      proto: frame.proto,
      bytes: frame.bytes,
      unitUs: frame.unitUs,
      repeats: Number(e.repeats) || 0,
      frameGapUs: Number(e.frameGapUs) || 40_000,
    });
  }
  if (!codes.length) return undefined;
  return {
    id,
    name: `${root?.remote ?? root?.name ?? 'Learned'} (learned)`,
    synthetic: false,
    note: 'Codes captured from the real remote; the virtual lamp obeys exactly these.',
    codes,
  };
}
