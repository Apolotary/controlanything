/**
 * The visual synth's capability manifest: what the renderer accepts, built from the same tables the renderer
 * applies (state.ts). The server hands it to Muse Spark, which writes the driver from it; the server validates
 * the driver against it. Plain data, no DOM: importable by the server as `@ce/vsynth/manifest`.
 */
import { VISUAL_SYNTH_CONTROLS, VISUAL_SYNTH_PATTERNS, VISUAL_SYNTH_PORT, VISUAL_SYNTH_PORT_ID } from './state.js';

export interface VisualSynthManifestControl {
  /** MIDI CC number on channel 1; wire values 0-127 */
  cc: number;
  parameter: string;
  label: string;
  /** what the renderer does with it */
  effect: string;
  /** the parameter's own range after the CC is mapped (CC value / 127, or 1..8 for symmetry) */
  rendererRange: [number, number];
  curve: 'linear' | 'stepped';
}

export interface VisualSynthManifestProgram {
  /** MIDI program change number on channel 1 */
  program: number;
  name: string;
  effect: string;
}

export interface VisualSynthManifest {
  id: 'controlanything-visual-synth';
  name: string;
  port: { id: string; name: string };
  channel: 1;
  /** no audio output: verification is visual (headset camera) and the renderer's own receipt */
  silent: true;
  controls: VisualSynthManifestControl[];
  programs: VisualSynthManifestProgram[];
  /** messages that reset every parameter (the server uses them; a driver never needs them) */
  resets: string;
  /** messages the renderer rejects */
  rejects: string[];
  receipt: string;
}

const EFFECTS: Record<string, string> = {
  brightness: 'overall light level of the field',
  hue: 'colour of the field around the colour wheel',
  saturation: 'colour intensity, from grey to vivid',
  speed: 'animation speed of the flowing field',
  zoom: 'scale of the noise field (zoomed out to zoomed in)',
  warp: 'how strongly the field bends and folds',
  ripple: 'water ripple depth; any value switches the screen to the Water pattern and expanding ripple waves',
  symmetry: 'kaleidoscope symmetry, 1 to 8 mirrored segments',
};
const PROGRAM_EFFECTS = ['flowing domain-warped field', 'concentric rings', 'prismatic colour bands', 'water surface with ripples'];

export const VISUAL_SYNTH_MANIFEST: VisualSynthManifest = {
  id: 'controlanything-visual-synth',
  name: 'ControlAnything Visual Synth',
  port: { id: VISUAL_SYNTH_PORT_ID, name: VISUAL_SYNTH_PORT },
  channel: 1,
  silent: true,
  controls: VISUAL_SYNTH_CONTROLS.map((control) => ({
    cc: control.cc, parameter: control.parameter, label: control.label, effect: EFFECTS[control.parameter] ?? control.label,
    rendererRange: [control.min, control.max], curve: control.curve,
  })),
  programs: VISUAL_SYNTH_PATTERNS.map((name, program) => ({ program, name, effect: PROGRAM_EFFECTS[program] ?? name })),
  resets: 'CC120, CC121, CC123 or panic reset every parameter to its default',
  rejects: ['note on/off (it has no sound)', 'any channel other than 1', 'program changes above 3', 'SysEx other than the identity request'],
  receipt: 'Each accepted CC/PC is acknowledged with the renderer state after it (exec.ack.applied.params, 0..1 units).',
};
