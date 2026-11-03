import type { Driver, DriverDraft, Provenance } from '@ce/protocol';

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
};
const CC_PARAMETER: Record<number, string> = { 7: 'brightness', 10: 'hue', 11: 'saturation', 1: 'speed', 74: 'zoom', 71: 'warp', 21: 'ripple', 20: 'symmetry' };
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
