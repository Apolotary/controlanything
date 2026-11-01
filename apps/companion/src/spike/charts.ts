/**
 * Compact device charts for the standalone MIDI spike (no server needed): which port to pick, which CCs
 * are safe to sweep, which to never send, and what each device's identity reply looks like.
 * Numbers come from the manufacturers' MIDI references (TE OP-1 field guide 1.7, EP-133 guide 2.5,
 * Ableton's "Using MIDI with Move"); names are short paraphrases.
 */
import { type IdentityReply, toHex } from '../midiDecode';

export interface SweepCc {
  cc: number;
  name: string;
  /** channel this CC must go to (mixer CCs address a tape track by channel) */
  channel?: number;
  /** where to look on the device while it sweeps */
  look?: string;
}

export interface Chart {
  id: string;
  name: string;
  maker: string;
  portHint: RegExp;
  /** manufacturer id and (when known) family/model of the identity reply */
  identity: { manufacturer: number[]; family?: number; member?: number; sendRequest: boolean; note: string };
  /** notes are only heard on this channel (set on the device) */
  noteChannel: number;
  /** note to hold while sweeping, so CCs have a sound to change */
  holdNote: number;
  sweep: SweepCc[];
  /** never sent by the spike, with the reason shown in the log */
  skipped: { cc: number; why: string }[];
  /** an unassigned CC for the negative control */
  negativeCc: number;
  setup: string[];
}

const TE = [0x00, 0x20, 0x76];
const ABLETON = [0x00, 0x21, 0x1d];

export const CHARTS: Chart[] = [
  {
    id: 'op-1-field',
    name: 'OP-1 Field',
    maker: 'Teenage Engineering',
    portHint: /op-1/i,
    identity: { manufacturer: TE, sendRequest: true, note: 'No published identity reply; port name "OP-1" is the fallback evidence. Firmware ≥ 1.7.0 is needed for most CCs.' },
    noteChannel: 1,
    holdNote: 60,
    sweep: [
      { cc: 46, name: 'Engine param 1 (blue)', look: 'T1 engine screen' },
      { cc: 47, name: 'Engine param 2 (ochre)', look: 'T1 engine screen' },
      { cc: 48, name: 'Engine param 3 (gray)', look: 'T1 engine screen' },
      { cc: 49, name: 'Engine param 4 (orange)', look: 'T1 engine screen' },
      { cc: 54, name: 'Patch FX 1', look: 'T3 FX screen' },
      { cc: 55, name: 'Patch FX 2', look: 'T3 FX screen' },
      { cc: 56, name: 'Patch FX 3', look: 'T3 FX screen' },
      { cc: 57, name: 'Patch FX 4 (often mix)', look: 'T3 FX screen' },
      { cc: 50, name: 'Envelope attack', look: 'T2 envelope screen' },
      { cc: 51, name: 'Envelope decay', look: 'T2 envelope screen' },
      { cc: 52, name: 'Envelope sustain', look: 'T2 envelope screen' },
      { cc: 53, name: 'Envelope release', look: 'T2 envelope screen' },
      { cc: 58, name: 'Patch LFO 1', look: 'T4 LFO screen' },
      { cc: 59, name: 'Patch LFO 2', look: 'T4 LFO screen' },
      { cc: 60, name: 'Patch LFO 3', look: 'T4 LFO screen' },
      { cc: 61, name: 'Patch LFO 4', look: 'T4 LFO screen' },
      { cc: 90, name: 'Master EQ low', look: 'mixer T2 EQ' },
      { cc: 91, name: 'Master EQ mid', look: 'mixer T2 EQ' },
      { cc: 92, name: 'Master EQ high', look: 'mixer T2 EQ' },
      { cc: 70, name: 'Master FX 1', look: 'mixer T3' },
      { cc: 71, name: 'Master FX 2', look: 'mixer T3' },
      { cc: 72, name: 'Master FX 3', look: 'mixer T3' },
      { cc: 73, name: 'Master FX 4', look: 'mixer T3' },
      { cc: 10, name: 'Track 1 pan', channel: 1, look: 'mixer T1' },
      { cc: 7, name: 'Track 1 volume', channel: 1, look: 'mixer T1' },
      { cc: 1, name: 'MIDI LFO in 1 (if the patch LFO is "midi")' },
    ],
    skipped: [
      { cc: 62, why: 'randomizes the patch; cannot be undone over MIDI' },
      { cc: 63, why: 'reset patch: did nothing in community tests' },
      { cc: 9, why: 'track mute: a sweep can leave the track muted' },
      { cc: 64, why: 'sustain: would hold notes' },
      { cc: 74, why: 'master out level L: a sweep can leave it silent' },
      { cc: 75, why: 'master out level R: a sweep can leave it silent' },
      { cc: 76, why: 'master drive: loud distortion' },
      { cc: 78, why: 'tape record level / main level' },
      { cc: 79, why: 'octave shift is incremental (every message shifts again)' },
      { cc: 80, why: 'tempo: global state' },
      { cc: 93, why: 'synth/drum mode switch' },
      { cc: 102, why: 'sound slot select' },
      { cc: 82, why: 'tape transport (82-88, 104, 105) moves or stops the tape' },
    ],
    negativeCc: 20,
    setup: [
      'Firmware ≥ 1.7.0 (boot screen).',
      'SHIFT+COM › T1 SYS › MIDI: channel 1, NOTES in, OTHER in.',
      'USB MODE 2CH so the Mac hears the main mix as an audio input named "OP-1".',
      'Load a scratch synth patch: sweeps change it and the OP-1 cannot report its values back.',
    ],
  },
  {
    id: 'ep-133',
    name: 'EP-133 K.O. II',
    maker: 'Teenage Engineering',
    portHint: /ep-133/i,
    identity: { manufacturer: TE, family: 0x20, member: 0x02, sendRequest: true, note: 'Replies F0 7E 33 06 02 00 20 76 20 00 02 00 … F7 (family 0x0020) on OS 2.5.' },
    noteChannel: 1,
    holdNote: 36,
    sweep: [
      { cc: 12, name: 'FX knob X (OS ≥ 2.5)', look: 'needs an FX selected and the group FX send up' },
      { cc: 13, name: 'FX knob Y (OS ≥ 2.5)', look: 'needs an FX selected and the group FX send up' },
      { cc: 1, name: 'Vibrato (sustained pads only)' },
    ],
    skipped: [{ cc: 64, why: 'sustain: would hold pads' }],
    negativeCc: 20,
    setup: ['OS ≥ 2.5.', 'Select an FX (e.g. FILTER) and raise the FX send for group A.', 'Close TE’s EP Sample Tool tab first.'],
  },
  {
    id: 'ableton-move',
    name: 'Ableton Move',
    maker: 'Ableton',
    portHint: /move.*standalone|standalone.*move/i,
    identity: { manufacturer: ABLETON, family: 0x1958, sendRequest: false, note: 'Gets no SysEx at all (its SysEx set includes power-off). Identify it by the port name "Ableton Move Standalone Port".' },
    noteChannel: 1,
    holdNote: 36,
    sweep: [],
    skipped: [{ cc: 0, why: 'Move ignores every incoming CC: only notes, aftertouch and clock' }],
    negativeCc: 20,
    setup: ['Standalone mode, firmware ≥ 1.7.', 'Set Track 1 MIDI In to channel 1.', 'Use only the Standalone Port.'],
  },
];

/** The spike's built-in Web Audio synth (spike/simSynth.ts): OP-1 CC numbers, honest identity (7D). */
export const SIM_CHART: Chart = {
  id: 'sim',
  name: 'CE Sim Synth',
  maker: 'simulator (non-commercial id 7D)',
  portHint: /sim synth/i,
  identity: { manufacturer: [0x7d], family: 1, member: 1, sendRequest: true, note: 'The built-in simulator answers with the non-commercial manufacturer id 7D; it never pretends to be a real device.' },
  noteChannel: 1,
  holdNote: 48,
  sweep: [
    { cc: 46, name: 'Cutoff (engine param 1)' },
    { cc: 47, name: 'Resonance (engine param 2)' },
    { cc: 48, name: 'Detune (engine param 3)' },
    { cc: 49, name: 'Drive (engine param 4)' },
    { cc: 57, name: 'Delay mix (patch FX 4)' },
    { cc: 92, name: 'EQ high' },
    { cc: 50, name: 'Envelope attack (not modelled: expect no change)' },
  ],
  skipped: [],
  negativeCc: 20,
  setup: ['No hardware needed: a Web Audio synth with the OP-1 Field CC numbers, wired straight into the audio oracle.'],
};
CHARTS.push(SIM_CHART);

export function chartForPort(portName: string): Chart | undefined {
  return CHARTS.find((c) => c.portHint.test(portName)) ?? (/op-1/i.test(portName) ? CHARTS[0] : /move/i.test(portName) ? CHARTS[2] : undefined);
}

export type IdentityVerdict = 'confirmed' | 'consistent' | 'mismatch' | 'unknown';

export interface IdentityCheck {
  verdict: IdentityVerdict;
  /** one sentence for the log and the HUD */
  text: string;
  /** the chart the reply actually matches, when it's a different device */
  actual?: Chart;
}

const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * research/05 §5.1: confirmed = the reply matches the expected device; consistent = the port name matches
 * and nothing contradicts it (no reply, or a family we have not seen before from the same maker);
 * mismatch = the reply names another device or maker ("wrong device, refused"); unknown = no evidence.
 */
export function checkIdentity(expected: Chart, portName: string, reply: IdentityReply | undefined): IdentityCheck {
  const portOk = expected.portHint.test(portName);
  if (!reply) {
    return portOk
      ? { verdict: 'consistent', text: `port name "${portName}" matches ${expected.name}; no identity reply (expected for ${expected.name === 'OP-1 Field' ? 'the OP-1' : 'this device'})` }
      : { verdict: 'unknown', text: `no identity reply and port "${portName}" does not look like ${expected.name}` };
  }
  const other = CHARTS.find((c) => c !== expected && same(c.identity.manufacturer, reply.manufacturer) && c.identity.family !== undefined && c.identity.family === reply.family);
  if (other) {
    return { verdict: 'mismatch', actual: other, text: `wrong device · refused: the reply is a ${other.maker} ${other.name} (family 0x${reply.family.toString(16).padStart(4, '0')}), not the ${expected.name}` };
  }
  if (!same(reply.manufacturer, expected.identity.manufacturer)) {
    return { verdict: 'mismatch', text: `wrong device · refused: the reply is from ${reply.manufacturerName} (${toHex(reply.manufacturer)}), not ${expected.maker}` };
  }
  if (expected.identity.family !== undefined) {
    return reply.family === expected.identity.family
      ? { verdict: 'confirmed', text: `identity confirmed: ${expected.maker} ${expected.name} (family 0x${reply.family.toString(16).padStart(4, '0')})` }
      : { verdict: 'mismatch', text: `wrong device · refused: ${expected.maker} family 0x${reply.family.toString(16).padStart(4, '0')} is not the ${expected.name}` };
  }
  return {
    verdict: portOk ? 'confirmed' : 'consistent',
    text: `${expected.maker} answered (family 0x${reply.family.toString(16).padStart(4, '0')}, model 0x${reply.member.toString(16).padStart(4, '0')})${portOk ? ` on the "${portName}" port: ${expected.name} confirmed. Record this family for the chart.` : ''}`,
  };
}
