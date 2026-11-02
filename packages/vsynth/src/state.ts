/** A visual instrument only: no audio output or audio APIs. */
export const VISUAL_SYNTH_PORT = 'ControlAnything Visual Synth';
export const VISUAL_SYNTH_PORT_ID = 'ce-visual-synth';
export const VISUAL_SYNTH_CHANNEL = 'ce-visual-synth';
export const VISUAL_SYNTH_IDENTITY_REPLY = Object.freeze([
  0xf0, 0x7e, 0x7f, 0x06, 0x02, 0x7d, 0x43, 0x45, 0, 1, 0, 0, 0, 1, 0xf7,
]);
export const VISUAL_SYNTH_PATTERNS = ['Flow', 'Rings', 'Prism'] as const;

export interface VisualSynthParameters {
  brightness: number;
  hue: number;
  saturation: number;
  speed: number;
  zoom: number;
  warp: number;
  symmetry: number;
  pattern: number;
}

export interface VisualSynthChange {
  parameters: VisualSynthParameters;
  label: string;
}

export const VISUAL_SYNTH_CONTROLS = [
  { cc: 7, parameter: 'brightness', label: 'Brightness', min: 0, max: 1, curve: 'linear' },
  { cc: 10, parameter: 'hue', label: 'Hue', min: 0, max: 1, curve: 'linear' },
  { cc: 11, parameter: 'saturation', label: 'Saturation', min: 0, max: 1, curve: 'linear' },
  { cc: 1, parameter: 'speed', label: 'Speed', min: 0, max: 1, curve: 'linear' },
  { cc: 74, parameter: 'zoom', label: 'Zoom', min: 0, max: 1, curve: 'linear' },
  { cc: 71, parameter: 'warp', label: 'Warp', min: 0, max: 1, curve: 'linear' },
  { cc: 20, parameter: 'symmetry', label: 'Symmetry', min: 1, max: 8, curve: 'stepped' },
] as const;

export function createVisualSynthState(): VisualSynthParameters {
  return { brightness: 0.75, hue: 0.54, saturation: 0.85, speed: 0.35, zoom: 0.45, warp: 0.4, symmetry: 1, pattern: 0 };
}

/** The same CC ranges are published in the device chart for later gesture bindings. */
export function applyVisualSynthMidi(current: VisualSynthParameters, bytes: readonly number[]): VisualSynthChange | null {
  if (!bytes.length || bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) return null;
  if (bytes[0] === 0xff) return { parameters: createVisualSynthState(), label: 'Reset · Ready' };
  const command = bytes[0] & 0xf0;
  if ((bytes[0] & 0x0f) !== 0) return null;
  if (command === 0xc0 && bytes.length === 2 && bytes[1] <= 127) {
    const pattern = bytes[1];
    if (pattern >= VISUAL_SYNTH_PATTERNS.length) return null;
    return { parameters: { ...current, pattern }, label: `Pattern · ${VISUAL_SYNTH_PATTERNS[pattern]}` };
  }
  if (command !== 0xb0 || bytes.length !== 3 || bytes[1] > 127 || bytes[2] > 127) return null;
  if (bytes[1] === 120 || bytes[1] === 121 || bytes[1] === 123) return { parameters: createVisualSynthState(), label: 'Reset · Ready' };
  const control = VISUAL_SYNTH_CONTROLS.find(({ cc }) => cc === bytes[1]);
  if (!control) return null;
  const unit = bytes[2] / 127;
  const value = control.parameter === 'symmetry' ? 1 + Math.round(unit * 7) : unit;
  return {
    parameters: { ...current, [control.parameter]: value },
    label: `${control.label} · ${control.parameter === 'symmetry' ? value : `${Math.round(value * 100)}%`}`,
  };
}

export function isVisualSynthState(value: unknown): value is VisualSynthParameters {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Record<string, unknown>;
  return VISUAL_SYNTH_CONTROLS.every(({ parameter, min, max }) => {
    const value = state[parameter];
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
      && (parameter !== 'symmetry' || Number.isInteger(value));
  }) && typeof state.pattern === 'number' && Number.isInteger(state.pattern) && state.pattern >= 0 && state.pattern < VISUAL_SYNTH_PATTERNS.length;
}
