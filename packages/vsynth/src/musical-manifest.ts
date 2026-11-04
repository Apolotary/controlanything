/** Authored instrument capabilities, plain data for Muse; no hand mapping lives here. */
export const MUSICAL_SYNTH_PORT_ID = 'ce-musical-synth';
export const MUSICAL_SYNTH_NAME = 'ControlAnything Synth';
export const MUSICAL_SCALE = [48, 50, 51, 53, 55, 56, 58, 60, 62, 63, 65, 67, 68, 70, 72] as const;
export const MUSICAL_CONTROLS = [
  { cc: 16, parameter: 'noteIndex', label: 'Scale note', min: 0, max: 14, default: 7, effect: 'Select a note on a two-octave C minor scale. Values are rounded to scale degrees; changing while the note gate is on changes pitch legato.' },
  { cc: 17, parameter: 'gate', label: 'Note gate', min: 0, max: 127, default: 0, effect: '0 releases the note; values 64-127 start/hold the scale note. Send 0 when the controlling hand disappears. A held note is capped at 8 seconds; release and gate on again to retrigger. Use with Scale note for playing, not a continuously sounding oscillator.' },
  { cc: 74, parameter: 'cutoff', label: 'Filter cutoff', min: 0, max: 127, default: 80, effect: 'Low-pass cutoff, logarithmic from 80 Hz to 8000 Hz. Has an audible effect while a note is sounding.' },
  { cc: 71, parameter: 'resonance', label: 'Filter resonance', min: 0, max: 127, default: 20, effect: 'Low-pass resonance Q, from 0.2 to 12. Has an audible effect while a note is sounding.' },
  { cc: 73, parameter: 'attack', label: 'Attack', min: 0, max: 127, default: 10, effect: 'Note attack time, 5 milliseconds to 1.5 seconds; applies at the next gate-on.' },
  { cc: 72, parameter: 'release', label: 'Release', min: 0, max: 127, default: 30, effect: 'Note release time, 30 milliseconds to 2 seconds; applies when the gate releases.' },
  { cc: 91, parameter: 'delay', label: 'Delay mix', min: 0, max: 127, default: 24, effect: 'Delay wet mix, 0 to 50 percent, with a fixed short echo and bounded feedback.' },
] as const;
export type MusicalParameter = typeof MUSICAL_CONTROLS[number]['parameter'];
export type MusicalParameters = Record<MusicalParameter, number> & { preset: number };
export const musicalDefaults = (): MusicalParameters => Object.fromEntries([...MUSICAL_CONTROLS.map(c => [c.parameter, c.default]), ['preset', 0]]) as MusicalParameters;
export const MUSICAL_SYNTH_MANIFEST = {
  id: 'controlanything-musical-synth', name: MUSICAL_SYNTH_NAME,
  port: { id: MUSICAL_SYNTH_PORT_ID, name: MUSICAL_SYNTH_NAME }, channel: 1, silent: false,
  controls: MUSICAL_CONTROLS, scale: MUSICAL_SCALE,
  programs: [
    { program: 0, name: 'Warm', effect: 'Triangle oscillator, soft envelope, gentle filter and short echo. Does not start a note.' },
    { program: 1, name: 'Glass', effect: 'Sine oscillator, bright filter and longer echo. Does not start a note.' },
    { program: 2, name: 'Pluck', effect: 'Sawtooth oscillator, quick attack and short release. Does not start a note.' },
  ],
  playing: 'Use cc16 Scale note and cc17 Note gate together. No gesture is pre-wired: Muse writes the requested use of hand signals. The Mac wearer must explicitly choose Sound on; a Quest request can open the panel but cannot unlock sound.',
  resets: 'CC120/121/123 or panic immediately silence and lock sound; Sound on must be chosen again.',
  rejects: ['Any channel other than 1', 'Unknown CC or program', 'Physical MIDI output: this port is a browser software instrument only', 'SysEx other than an identity request'],
  receipt: 'exec.ack.applied.source musical-synth includes raw parameter values and an actual Web Audio analyser RMS/peak/frequency snapshot. A muted test output still samples the graph before the muted master gain. This is software graph evidence, not physical microphone evidence.',
} as const;
