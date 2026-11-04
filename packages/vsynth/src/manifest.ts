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
  /** Browser water feedback is audible after unlock; verification remains visual/state-based. */
  silent: false;
  controls: VisualSynthManifestControl[];
  programs: VisualSynthManifestProgram[];
  /** messages that reset every parameter (the server uses them; a driver never needs them) */
  resets: string;
  /** messages the renderer rejects */
  rejects: string[];
  receipt: string;
  /** how the three touch controls (CC22 X, CC23 Y, CC24 pressure) work together: for drivers and wiring programs */
  touch: string;
}

const EFFECTS: Record<string, string> = {
  brightness: 'overall light level of the field',
  hue: 'colour of the field around the colour wheel',
  saturation: 'colour intensity, from grey to vivid',
  speed: 'animation speed of the flowing field',
  zoom: 'scale of the noise field (zoomed out to zoomed in)',
  warp: 'how strongly the field bends and folds',
  ripple: 'ripple depth on every pattern: concentric rings across the screen get deeper and brighter, and each change sends an expanding wave; it never changes the pattern (program changes do)',
  symmetry: 'kaleidoscope symmetry, 1 to 8 mirrored segments',
  touchX: 'touch X: where the wearer\'s fingertip touches the screen, left to right (0 = left edge, 127 = right edge of the visible canvas); send it with Touch Y, and before pressure, so the splash lands under the finger',
  touchY: 'touch Y: where the wearer\'s fingertip touches the screen, top to bottom (0 = top edge, 127 = bottom edge; top-left is 0,0)',
  touchPressure: 'touch pressure: 0 lifted; 1-20 hovering (a soft caustic lens and glow under the fingertip that grows as it comes closer); 21-127 touching: a splash where it lands (stronger with higher values), then a wake of ripples that follows the finger while X and Y move; lifting lets the waves keep expanding and fade. Works on every pattern, most beautiful on Water',
};
const PROGRAM_EFFECTS = ['flowing domain-warped field', 'concentric rings', 'prismatic colour bands', 'lit water surface (Ripples make its waves; fingertip splashes and wakes look best here)'];

export const VISUAL_SYNTH_MANIFEST: VisualSynthManifest = {
  id: 'controlanything-visual-synth',
  name: 'ControlAnything Visual Synth',
  port: { id: VISUAL_SYNTH_PORT_ID, name: VISUAL_SYNTH_PORT },
  channel: 1,
  silent: false,
  controls: VISUAL_SYNTH_CONTROLS.map((control) => ({
    cc: control.cc, parameter: control.parameter, label: control.label, effect: EFFECTS[control.parameter] ?? control.label,
    rendererRange: [control.min, control.max], curve: control.curve,
  })),
  programs: VISUAL_SYNTH_PATTERNS.map((name, program) => ({ program, name, effect: PROGRAM_EFFECTS[program] ?? name })),
  resets: 'CC120, CC121, CC123 or panic reset every parameter to its default',
  rejects: ['note on/off (water feedback is gesture-driven, not a musical note instrument)', 'any channel other than 1', 'program changes above 3', 'SysEx other than the identity request'],
  receipt: 'Each accepted CC/PC is acknowledged with the renderer state after it (exec.ack.applied.params, 0..1 units).',
  touch: 'Touch the water: CC22 X and CC23 Y place the fingertip on the visible canvas (0..127 across, top-left 0,0) and CC24 is its pressure '
    + '(0 lifted, 1-20 hover, 21-127 touching). Pressure crossing 20 is a touch-down: one splash at the current X/Y (stronger with higher pressure, applied within one frame, never smoothed). '
    + 'While touching, moving X/Y leaves a wake (ripples spawned along the path at about 20 per second). Hover shows a soft glow that grows as pressure rises toward 20. '
    + 'The browser adds a splash on contact, a soft moving water sound during the wake, and a gentle shimmer while hovering; these follow the same pressure and position data and respect the shared master volume. '
    + 'Lifting (pressure back to 0..20) sends one soft ring and the existing waves fade by themselves. Send X and Y first or together with pressure; keep sending X/Y at 20-60 Hz while touching; send pressure 0 when the finger leaves or is lost.',
};
