/**
 * Curated device data (RESEARCH step, no model): MIDI charts and IR code libraries copied from the team's
 * research into apps/server/data/devices/*.json, every fact with its source and confidence label.
 * The loader turns them into the two things the loop needs: an allowlist (which CCs / IR codes a
 * generated driver may use) and a compact brief for the model prompts.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IrOp } from '@ce/protocol';
import { hexToBytes } from './ir';

export const DATA_DIR = fileURLToPath(new URL('../../data/devices/', import.meta.url));

export interface MidiParameter {
  name: string;
  group?: string;
  cc: number | null;
  curve?: 'linear' | 'exponential' | 'step';
  nrpn?: number | null;
  range?: [number, number];
  channel?: string;
  confidence?: string;
  notes?: string;
}

export interface MidiProfile {
  id: string;
  device: string;
  manufacturer: string;
  firmwareNotes?: string;
  sense?: 'camera' | 'audio';
  sources: { title: string; url: string; confidence?: string }[];
  usb?: { classCompliantMidi?: boolean; classCompliantAudio?: boolean; portNameHint?: string; notes?: string };
  identity?: { respondsToUniversalInquiry: boolean | null; manufacturerId?: number[]; replyExample?: string | null; notes?: string };
  channels?: { receive?: string; send?: string; notes?: string };
  parameters: MidiParameter[];
  unsafeMessages?: string[];
  demo?: { bestParameters?: string[]; visualFeedback?: string; audibleFeedback?: string; risks?: string[]; setup?: string[] };
}

export interface IrCandidate {
  /** "lib:<brand>/<ch>/<key>" */
  ref: string;
  brand: string;
  channel: number;
  /** canonical key: fullOn | off | brighter | dimmer | nightLight | on | warmer | cooler | toggle */
  key: string;
  op: IrOp;
  confidence: string;
  /** library search order (lower first), from the research's blind-search plan */
  order: number;
}

export interface IrLibrary {
  id: string;
  device: string;
  status?: string;
  candidates: IrCandidate[];
  /** byte strings that must never be sent (channel programming, memory keys) */
  doNotSend: { brand: string; what: string; bytes: number[][] }[];
  sources: { title: string; url: string; confidence?: string }[];
}

export interface Profiles {
  midi: Map<string, MidiProfile>;
  ir: IrLibrary | undefined;
  /** the Koizumi file: protocol unknown, codes must be learned */
  koizumi: Record<string, unknown> | undefined;
  /** ids of every file loaded */
  files: string[];
}

function readJson(file: string): any {
  return JSON.parse(readFileSync(file, 'utf8'));
}

const CANONICAL_KEYS = new Set(['fullOn', 'off', 'brighter', 'dimmer', 'nightLight', 'on', 'warmer', 'cooler', 'toggleOnOff']);

/** Order of brands in the blind search (research: send OFF candidates first, well-documented brands first). */
const BRAND_ORDER = ['Panasonic', 'NEC Lighting', 'Toshiba', 'Hitachi', 'Takizumi', 'Odelic'];

function brandOrder(brand: string): number {
  const i = BRAND_ORDER.findIndex((b) => brand.startsWith(b));
  return i < 0 ? 50 : i;
}

function protocolOf(text: string): 'NEC' | 'AEHA' | undefined {
  if (/^NEC/i.test(text)) return 'NEC';
  if (/^AEHA/i.test(text)) return 'AEHA';
  return undefined;
}

/** Turn the research's brand entries (channel tables of hex byte strings) into executable candidates. */
export function buildIrLibrary(json: any): IrLibrary {
  const candidates: IrCandidate[] = [];
  const doNotSend: IrLibrary['doNotSend'] = [];
  for (const b of json.brands ?? []) {
    const protocol = protocolOf(String(b.protocol ?? ''));
    if (!protocol) continue;
    const unitUs = typeof b.unitUs === 'number' ? b.unitUs : protocol === 'NEC' ? 562.5 : 425;
    const twoFrames = /2 identical frames|twice/i.test(String(b.repeat ?? ''));
    const tables: Record<string, Record<string, string>> = {};
    if (b.channelTable && typeof b.channelTable === 'object') for (const [ch, t] of Object.entries(b.channelTable)) tables[ch] = t as Record<string, string>;
    if (b.commands && typeof b.commands === 'object' && !tables.CH1) tables.CH1 = b.commands;
    const brandName = String(b.brand).split(/[\s(（/]/)[0];
    for (const [ch, table] of Object.entries(tables)) {
      const channel = Number(ch.replace(/\D/g, '')) || 1;
      for (const [key, hex] of Object.entries(table)) {
        if (!CANONICAL_KEYS.has(key) || typeof hex !== 'string' || !/^[0-9A-Fa-f]{2}( [0-9A-Fa-f]{2})+$/.test(hex)) continue;
        const bytes = hexToBytes(hex);
        const ref = `lib:${brandName.toLowerCase()}/ch${channel}/${key}`;
        const op: IrOp = { kind: 'ir', protocol, bytes, unitUs, khz: 38, ref };
        if (twoFrames) {
          op.repeats = 1;
          op.frameGapUs = 75_000;
        }
        candidates.push({ ref, brand: brandName, channel, key, op, confidence: String(b.confidence ?? 'unknown'), order: brandOrder(String(b.brand)) * 10 + channel });
      }
    }
    const dns = b.doNotSend;
    if (dns && typeof dns === 'object') {
      for (const [what, list] of Object.entries(dns)) {
        if (Array.isArray(list)) doNotSend.push({ brand: brandName, what, bytes: list.filter((s) => typeof s === 'string').map((s) => hexToBytes(s as string)) });
      }
    }
  }
  for (const d of json.doNotSend ?? []) {
    if (Array.isArray(d.bytes) && d.bytes.length) doNotSend.push({ brand: String(d.brand), what: String(d.what), bytes: d.bytes.map((s: string) => hexToBytes(s)) });
  }
  // search order: OFF first per brand (ON->OFF is the most visible change), then the confirming key, then the rest
  const keyRank = (k: string) => (k === 'off' ? 0 : k === 'fullOn' || k === 'on' || k === 'toggleOnOff' ? 1 : 2);
  candidates.sort((a, b) => a.order - b.order || keyRank(a.key) - keyRank(b.key));
  return { id: String(json.id), device: String(json.device), status: json.status, candidates, doNotSend, sources: json.sources ?? [] };
}

/** Load every profile once. Missing files are tolerated (the loop then has no allowlist for that device). */
export function loadProfiles(dir: string = DATA_DIR): Profiles {
  const out: Profiles = { midi: new Map(), ir: undefined, koizumi: undefined, files: [] };
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    let json: any;
    try {
      json = readJson(join(dir, f));
    } catch {
      continue;
    }
    out.files.push(f);
    if (Array.isArray(json.parameters)) out.midi.set(String(json.id), json as MidiProfile);
    else if (json.id === 'jp-ceiling-light-ir') out.ir = buildIrLibrary(json);
    else if (json.id === 'koizumi-krh-tg-9a') out.koizumi = json;
  }
  return out;
}

/** CC numbers a driver for this device may use (chart entries with a CC), minus the ones the research calls unsafe. */
export function allowedCcs(profile: MidiProfile): Set<number> {
  const set = new Set<number>();
  for (const p of profile.parameters) if (typeof p.cc === 'number') set.add(p.cc);
  for (const u of profile.unsafeMessages ?? []) {
    // "CC 62 >= 64 (randomize active patch)": drop CCs the notes mark as irreversible or state-changing
    const m = /^CC (\d+)/.exec(u);
    if (m && /irreversible|randomi|tempo|record|octave/i.test(u)) set.delete(Number(m[1]));
  }
  return set;
}

/** The parameter a CC drives, for labels. */
export function parameterForCc(profile: MidiProfile, cc: number): MidiParameter | undefined {
  return profile.parameters.find((p) => p.cc === cc);
}

/** Find the MIDI profile for an identified device by maker/model/name words. */
export function matchMidiProfile(profiles: Profiles, card: { maker: string; model: string; name: string }): MidiProfile | undefined {
  const text = `${card.maker} ${card.model} ${card.name}`.toLowerCase();
  const rules: [RegExp, string][] = [
    [/controlanything visual synth|visual synth/, 'controlanything-visual-synth'],
    [/op-?1/, 'op-1-field'],
    [/ep-?133|k\.?o\.? ?ii|k\.o\. 2/, 'ep-133'],
    [/\bmove\b/, 'ableton-move'],
    [/kastle/, 'kastle-2-wave-bard'],
  ];
  for (const [re, id] of rules) if (re.test(text) && profiles.midi.has(id)) return profiles.midi.get(id);
  return undefined;
}

/** A compact, model-facing brief of a MIDI chart (what the DRIVE prompt gets instead of the whole JSON). */
export function midiBrief(profile: MidiProfile, maxParams = 40): string {
  const lines = [
    `${profile.device} (${profile.manufacturer}). ${profile.firmwareNotes ?? ''}`.trim(),
    profile.channels?.receive ? `Channels: ${profile.channels.receive}` : '',
    profile.usb?.portNameHint ? `USB MIDI port name contains "${profile.usb.portNameHint}".` : '',
    profile.sense ? `Verification sensor: ${profile.sense}.` : '',
    'Incoming CC chart (cc: parameter [range]):',
    ...profile.parameters
      .filter((p) => typeof p.cc === 'number')
      .slice(0, maxParams)
      .map((p) => `  ${p.cc}: ${p.name}${p.range ? ` [${p.range[0]}-${p.range[1]}]` : ''}${p.group ? ` (${p.group})` : ''}`),
    profile.demo?.bestParameters?.length ? `Best for a demo: ${profile.demo.bestParameters.join('; ')}` : '',
    profile.unsafeMessages?.length ? `Never send: ${profile.unsafeMessages.slice(0, 4).join(' | ')}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

/** Short brief of the IR library for the model (brands, keys, how the search runs). */
export function irBrief(lib: IrLibrary): string {
  const byBrand = new Map<string, string[]>();
  for (const c of lib.candidates) {
    if (!byBrand.has(c.brand)) byBrand.set(c.brand, []);
    byBrand.get(c.brand)!.push(c.ref);
  }
  return [
    `IR candidate library for Japanese ceiling lights (${lib.candidates.length} codes, NEC and AEHA at 38 kHz). Name a code by its ref only, e.g. {"kind":"ir","protocol":"AEHA","ref":"lib:panasonic/ch1/off"}; the server fills the bytes and timings.`,
    ...[...byBrand.entries()].map(([b, refs]) => `  ${b}: ${refs.join(' ')}`),
    'Start with the first brand listed (CH1); the server tries the other brands when the camera sees no reaction. Unknown command bytes are never swept.',
  ].join('\n');
}
