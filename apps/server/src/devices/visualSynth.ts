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

/** Legacy saved visual drivers cannot claim the new ripple capability. */
export function visualSynthNeedsUpgrade(driver?: Pick<Driver, 'executor' | 'actions'>): boolean {
  if (!driver || !isVisualSynthPort(driver.executor.port)) return false;
  return !driver.actions.some(a => a.actionId === 'cc21' && a.kind === 'set' && a.encode.kind === 'midi'
    && a.encode.msg === 'cc' && a.encode.channel === 1 && a.encode.number === 21 && a.encode.value === '$value'
    && a.range?.min === 0 && a.range.max === 127 && a.range.step === 1);
}
