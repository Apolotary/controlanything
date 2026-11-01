/**
 * The incoming-CC map the virtual synth honours: the same CC numbers as the Teenage Engineering OP-1 Field
 * MIDI chart (firmware >= 1.7.0, "midi reference" in TE's field guide), so the agent's driver, the server's
 * allowlist and the AR knobs are identical in sim and on hardware. What each CC *sounds like* is the sim's own
 * Web Audio voice (the real engine parameters depend on the loaded patch).
 *
 * Group pages mirror the synth's screen pages; encoder colours are the four coloured encoders (blue, ochre,
 * grey, orange). CCs in the chart that the sim voice does not model are accepted and shown, but change nothing
 * audible (`audible: false`); CCs outside the chart (e.g. CC 20, the audio check's negative control) are ignored.
 */
export type CcGroup = 'engine' | 'envelope' | 'fx' | 'lfo' | 'mixer' | 'master' | 'global' | 'tape' | 'midi-lfo';
export type Encoder = 'blue' | 'ochre' | 'grey' | 'orange';

export interface CcDef {
  cc: number;
  /** the OP-1 Field chart's name for it */
  chart: string;
  /** what the sim's voice does with it */
  sim: string;
  group: CcGroup;
  encoder?: Encoder;
  audible: boolean;
  /** trigger CCs act on values >= 64 */
  trigger?: boolean;
  /** never sent by the agent (destructive on hardware); the sim just logs it */
  unsafe?: boolean;
}

export const ENCODER_COLORS: Record<Encoder, string> = {
  blue: '#2f6bff',
  ochre: '#e0a21a',
  grey: '#9aa0a6',
  orange: '#ff5a1f',
};

const E: Encoder[] = ['blue', 'ochre', 'grey', 'orange'];

export const CC_MAP: CcDef[] = [
  { cc: 46, chart: 'Synth engine parameter 1', sim: 'Filter cutoff', group: 'engine', encoder: 'blue', audible: true },
  { cc: 47, chart: 'Synth engine parameter 2', sim: 'Resonance', group: 'engine', encoder: 'ochre', audible: true },
  { cc: 48, chart: 'Synth engine parameter 3', sim: 'Detune / spread', group: 'engine', encoder: 'grey', audible: true },
  { cc: 49, chart: 'Synth engine parameter 4', sim: 'Drive', group: 'engine', encoder: 'orange', audible: true },
  { cc: 50, chart: 'Envelope attack', sim: 'Attack', group: 'envelope', encoder: 'blue', audible: true },
  { cc: 51, chart: 'Envelope decay', sim: 'Decay', group: 'envelope', encoder: 'ochre', audible: true },
  { cc: 52, chart: 'Envelope sustain', sim: 'Sustain', group: 'envelope', encoder: 'grey', audible: true },
  { cc: 53, chart: 'Envelope release', sim: 'Release', group: 'envelope', encoder: 'orange', audible: true },
  { cc: 54, chart: 'Patch FX parameter 1', sim: 'Delay time', group: 'fx', encoder: 'blue', audible: true },
  { cc: 55, chart: 'Patch FX parameter 2', sim: 'Delay feedback', group: 'fx', encoder: 'ochre', audible: true },
  { cc: 56, chart: 'Patch FX parameter 3', sim: 'Chorus depth', group: 'fx', encoder: 'grey', audible: true },
  { cc: 57, chart: 'Patch FX parameter 4', sim: 'FX mix', group: 'fx', encoder: 'orange', audible: true },
  { cc: 58, chart: 'Patch LFO parameter 1', sim: 'LFO rate', group: 'lfo', encoder: 'blue', audible: true },
  { cc: 59, chart: 'Patch LFO parameter 2', sim: 'LFO > cutoff', group: 'lfo', encoder: 'ochre', audible: true },
  { cc: 60, chart: 'Patch LFO parameter 3', sim: 'LFO > pitch', group: 'lfo', encoder: 'grey', audible: true },
  { cc: 61, chart: 'Patch LFO parameter 4', sim: 'LFO > level', group: 'lfo', encoder: 'orange', audible: true },
  { cc: 7, chart: 'Track volume (mixer)', sim: 'Volume', group: 'mixer', encoder: 'blue', audible: true },
  { cc: 9, chart: 'Track mute (mixer)', sim: 'Mute', group: 'mixer', encoder: 'ochre', audible: true },
  { cc: 10, chart: 'Track pan (mixer)', sim: 'Pan', group: 'mixer', encoder: 'grey', audible: true },
  { cc: 90, chart: 'Master EQ low', sim: 'EQ low', group: 'master', encoder: 'blue', audible: true },
  { cc: 91, chart: 'Master EQ mid', sim: 'EQ mid', group: 'master', encoder: 'ochre', audible: true },
  { cc: 92, chart: 'Master EQ high', sim: 'EQ high', group: 'master', encoder: 'grey', audible: true },
  { cc: 64, chart: 'Sustain pedal', sim: 'Sustain pedal', group: 'global', audible: true },
  { cc: 80, chart: 'Tempo', sim: 'Loop tempo', group: 'global', audible: true },
  { cc: 123, chart: 'All notes off', sim: 'All notes off', group: 'global', audible: true },
  { cc: 1, chart: 'MIDI LFO input 1', sim: '(not modelled)', group: 'midi-lfo', audible: false },
  { cc: 2, chart: 'MIDI LFO input 2', sim: '(not modelled)', group: 'midi-lfo', audible: false },
  { cc: 3, chart: 'MIDI LFO input 3', sim: '(not modelled)', group: 'midi-lfo', audible: false },
  { cc: 4, chart: 'MIDI LFO input 4', sim: '(not modelled)', group: 'midi-lfo', audible: false },
  { cc: 62, chart: 'Randomize active patch', sim: '(blocked: destructive on hardware)', group: 'global', audible: false, trigger: true, unsafe: true },
  { cc: 63, chart: 'Reset active patch', sim: '(not modelled)', group: 'global', audible: false, trigger: true },
  ...[70, 71, 72, 73].map((cc, i): CcDef => ({ cc, chart: `Master FX parameter ${i + 1}`, sim: '(not modelled)', group: 'master', encoder: E[i], audible: false })),
  ...[74, 75, 76, 77].map((cc, i): CcDef => ({ cc, chart: `Master out parameter ${i + 1}`, sim: '(not modelled)', group: 'master', encoder: E[i], audible: false })),
  { cc: 78, chart: 'Tape record level', sim: '(not modelled)', group: 'global', audible: false },
  { cc: 79, chart: 'Octave shift (incremental)', sim: '(not modelled)', group: 'global', audible: false },
  { cc: 81, chart: 'Metronome level', sim: '(not modelled)', group: 'global', audible: false },
  ...[82, 83, 84, 85, 86, 87, 88].map((cc): CcDef => ({ cc, chart: 'Tape transport', sim: '(not modelled)', group: 'tape', audible: false, trigger: true })),
  { cc: 93, chart: 'Mode select (synth / drum)', sim: '(synth mode only)', group: 'global', audible: false },
  { cc: 102, chart: 'Sound slot select', sim: '(not modelled)', group: 'global', audible: false, trigger: true },
  { cc: 104, chart: 'Tape: stop', sim: 'Loop stop', group: 'tape', audible: true, trigger: true },
  { cc: 105, chart: 'Tape: play', sim: 'Loop play', group: 'tape', audible: true, trigger: true },
];

export const CC_BY_NUMBER = new Map(CC_MAP.map((d) => [d.cc, d]));

/** The four encoders of each screen page, in encoder order. */
export const PAGES: { group: CcGroup; title: string; ccs: number[] }[] = [
  { group: 'engine', title: 'ENGINE', ccs: [46, 47, 48, 49] },
  { group: 'envelope', title: 'ENVELOPE', ccs: [50, 51, 52, 53] },
  { group: 'fx', title: 'FX', ccs: [54, 55, 56, 57] },
  { group: 'lfo', title: 'LFO', ccs: [58, 59, 60, 61] },
  { group: 'mixer', title: 'MIXER', ccs: [7, 9, 10] },
  { group: 'master', title: 'MASTER EQ', ccs: [90, 91, 92] },
];

/** Initial CC values of the sim patch (a warm saw lead with a little delay). */
export const INITIAL_CC: Record<number, number> = {
  46: 70,
  47: 30,
  48: 24,
  49: 20,
  50: 4,
  51: 50,
  52: 90,
  53: 40,
  54: 52,
  55: 40,
  56: 30,
  57: 28,
  58: 30,
  59: 0,
  60: 0,
  61: 0,
  7: 100,
  9: 0,
  10: 64,
  90: 64,
  91: 64,
  92: 64,
  64: 0,
  80: 74, // 120 BPM
};

/** CC 80 value -> BPM, per the chart's derived formula. */
export function tempoFromCc(v: number): number {
  if (v <= 5) return 40 + 2 * v;
  if (v <= 120) return v + 46;
  return 168 + 2 * (v - 121);
}

/** The identity reply the sim sends to F0 7E 7F 06 01 F7: the MMA non-commercial ID 7D, never TE's. */
export const SIM_IDENTITY_REPLY = [0xf0, 0x7e, 0x7f, 0x06, 0x02, 0x7d, 0x01, 0x00, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0xf7];
