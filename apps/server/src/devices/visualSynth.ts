import type { Driver, DriverDraft, Provenance } from '@ce/protocol';
import { VISUAL_SYNTH_MANIFEST } from '@ce/vsynth/manifest';

export const VISUAL_SYNTH_NAME = 'ControlAnything Visual Synth';
export const VISUAL_SYNTH_ID = 'controlanything-visual-synth';
export const isVisualSynthPort = (port?: string): boolean => port === 'ce-visual-synth' || port === VISUAL_SYNTH_NAME;

/** Honest fixture/template of the chart; live mode still asks Meta to write the driver. */
export function visualSynthDraft(cardId: string, provenance: Provenance[]): DriverDraft {
  return {
    cardId, name: VISUAL_SYNTH_NAME, transport: 'midi', provenance,
    notes: 'Template from this repo; no model wrote this driver. Silent visuals verified by camera.',
    actions: [
      { actionId: 'cc71', label: 'Warp', kind: 'set', range: { min: 0, max: 127, step: 1 }, curve: 'linear', encode: { kind: 'midi', msg: 'cc', channel: 1, number: 71, value: '$value' }, expect: { sense: 'camera', effect: 'any' } },
      { actionId: 'cc21', label: 'Water ripples', kind: 'set', range: { min: 0, max: 127, step: 1 }, curve: 'linear', encode: { kind: 'midi', msg: 'cc', channel: 1, number: 21, value: '$value' }, expect: { sense: 'camera', effect: 'any' } },
      ...['Flow', 'Rings', 'Prism'].map((label, number) => ({ actionId: `pattern${number}`, label, kind: 'trigger' as const, encode: { kind: 'midi' as const, msg: 'pc' as const, channel: 1, number }, expect: { sense: 'camera' as const, effect: 'any' as const }, inverseActionId: `pattern${(number + 1) % 3}` })),
    ],
  };
}

/**
 * Only the legacy four-action driver (Warp + three patterns, from before Water ripples existed) needs an upgrade.
 * A driver Muse wrote from the manifest is its own choice, with or without ripples.
 */
export function visualSynthNeedsUpgrade(driver?: Pick<Driver, 'executor' | 'actions'>): boolean {
  if (!driver || !isVisualSynthPort(driver.executor.port)) return false;
  const ids = driver.actions.map((a) => a.actionId).sort().join(',');
  return ids === 'cc71,pattern0,pattern1,pattern2';
}

/** Words that name each visual synth parameter or pattern: a label may not claim a different one. */
const VISUAL_WORDS: Record<string, RegExp> = {
  brightness: /\bbright/i, hue: /\b(hue|colou?r)\b/i, saturation: /\bsatur/i, speed: /\b(speed|tempo)\b/i, zoom: /\bzoom/i,
  warp: /\bwarp/i, ripple: /\b(ripple|water)/i, symmetry: /\b(symmetr|kaleido|mirror)/i,
  flow: /\bflow/i, rings: /\brings?\b/i, prism: /\bprism/i,
  // the fingertip inputs (CC22 X, CC23 Y, CC24 pressure) share one vocabulary
  touchX: /\b(touch|finger)/i, touchY: /\b(touch|finger)/i, touchPressure: /\b(touch|finger)/i,
};
const CC_PARAMETER: Record<number, string> = { 7: 'brightness', 10: 'hue', 11: 'saturation', 1: 'speed', 74: 'zoom', 71: 'warp', 21: 'ripple', 20: 'symmetry', 22: 'touchX', 23: 'touchY', 24: 'touchPressure' };
const PROGRAM_KEY = ['flow', 'rings', 'prism', 'ripple'];

/** The manifest key a visual synth action drives, from its wire message (or its canonical id cc<n>/pattern<n>). */
export function visualKey(action: { actionId: string; encode?: { kind?: string; msg?: string; number?: number } }): string | undefined {
  const e = action.encode;
  if (e?.kind === 'midi' && e.number !== undefined) return e.msg === 'cc' ? CC_PARAMETER[e.number] : e.msg === 'pc' ? PROGRAM_KEY[e.number] : undefined;
  const m = /^(cc|pattern)(\d+)$/.exec(action.actionId);
  return m ? (m[1] === 'cc' ? CC_PARAMETER[Number(m[2])] : PROGRAM_KEY[Number(m[2])]) : undefined;
}

/** True when a label names a different visual parameter or pattern than its own (Warp must not pose as Water ripples). */
export function misnamedVisual(label: string, own: string | undefined): boolean {
  if (!own) return false;
  if (VISUAL_WORDS[own]?.test(label)) return false;
  return Object.entries(VISUAL_WORDS).some(([key, words]) => key !== own && words.test(label));
}

// --- touch inputs (WIRE) --------------------------------------------------------------------------------------------
// The renderer's manifest lists a CC for where a fingertip touches the water and how hard (Touch X / Touch Y / Touch
// pressure). The setup driver Muse writes stays as it is; when the wearer asks for a wiring, these manifest controls are
// offered to the wiring writer as ordinary driver actions and verified on first use. Read from the manifest, never hardcoded.

type ManifestControlLike = { cc: number; parameter: string; label: string; effect: string };

/** Manifest controls that take a touch input. */
export function touchControls(controls: readonly ManifestControlLike[] = VISUAL_SYNTH_MANIFEST.controls): ManifestControlLike[] {
  return controls.filter((c) => /touch/i.test(`${c.parameter} ${c.label}`));
}

export type TouchRole = 'x' | 'y' | 'pressure';

/** Which fingertip input a manifest control is (by its parameter name or label), if any. */
export function touchRoleOf(control: Pick<ManifestControlLike, 'parameter' | 'label'>): TouchRole | undefined {
  if (!/touch/i.test(`${control.parameter} ${control.label}`)) return undefined;
  const p = control.parameter;
  if (/press|force|contact/i.test(`${p} ${control.label}`)) return 'pressure';
  if (/x$/i.test(p) || /\bx\b/i.test(control.label)) return 'x';
  if (/y$/i.test(p) || /\by\b/i.test(control.label)) return 'y';
  return undefined;
}

/** The fingertip input a CC is, from the renderer's manifest (undefined for every other control). */
export function touchRoleOfCc(cc: number | undefined, controls: readonly ManifestControlLike[] = VISUAL_SYNTH_MANIFEST.controls): TouchRole | undefined {
  const c = cc === undefined ? undefined : controls.find((k) => k.cc === cc);
  return c ? touchRoleOf(c) : undefined;
}

/**
 * Touch X and Y draw nothing while the finger is lifted, so their evidence is the renderer's receipt (`ack`, checked
 * against the applied parameter); touch pressure and every other visual synth control are camera/renderer checked.
 */
export function visualExpect(cc: number | undefined, controls?: readonly ManifestControlLike[]): { sense: 'ack' | 'camera'; effect: 'any' } {
  const role = touchRoleOfCc(cc, controls);
  return { sense: role === 'x' || role === 'y' ? 'ack' : 'camera', effect: 'any' };
}

/** Pressure 1..20 is a hovering finger (a soft glow), above 20 a touch-down splash: verification only ever hovers. */
export const TOUCH_VERIFY_HOVER = 10;
/** Where verification puts a lifted finger: the middle of the canvas. */
export const TOUCH_VERIFY_CENTER = 64;

/** The driver actions for those controls (same shape and ids as every other visual synth CC action: cc<number>). */
export function touchActions(controls: readonly ManifestControlLike[] = touchControls()): DriverDraft['actions'] {
  return controls.map((c) => ({
    actionId: `cc${c.cc}`, label: c.label.slice(0, 40), kind: 'set' as const, description: c.effect.slice(0, 300),
    range: { min: 0, max: 127, step: 1 }, curve: 'linear' as const,
    encode: { kind: 'midi' as const, msg: 'cc' as const, channel: 1, number: c.cc, value: '$value' },
    expect: visualExpect(c.cc, controls),
  }));
}

/** A visual synth driver plus any manifest touch action it does not have yet (`added` lists their ids). */
export function extendWithTouch<D extends Pick<Driver, 'executor' | 'actions'>>(driver: D, controls?: readonly ManifestControlLike[]): { driver: D; added: string[] } {
  if (!isVisualSynthPort(driver.executor.port)) return { driver, added: [] };
  const have = new Set(driver.actions.flatMap((a) => (a.encode.kind === 'midi' && a.encode.msg === 'cc' && a.encode.number !== undefined ? [a.encode.number] : [])));
  const ids = new Set(driver.actions.map((a) => a.actionId));
  const missing = touchActions(touchControls(controls)).filter((a) => a.encode.kind === 'midi' && !have.has(a.encode.number!) && !ids.has(a.actionId));
  if (!missing.length) return { driver, added: [] };
  return { driver: { ...driver, actions: [...driver.actions, ...(missing as Driver['actions'])] }, added: missing.map((a) => a.actionId) };
}
