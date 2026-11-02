import { throwIfCancelled } from '../muse/cancellation';
import type { ForgeDriver } from './forgeTypes';
import type { ForgeDraft, HackDraft } from './hackset';
import type { TransportSession } from './transport';

export const VISUAL_SYNTH_FIXTURE = 'fixture:visual-synth';

export function isVisualSynth(driver: ForgeDriver): boolean {
  return driver.name === 'ControlAnything Visual Synth' && driver.transport === 'midi'
    && driver.actions.some((action) => action.actionId === 'cc71' && action.expect?.sense === 'camera');
}

/** Authored here for the hardware-free demo; this is a template, not a recorded model answer. */
export function visualSynthDraft(driver: ForgeDriver): ForgeDraft {
  const range = driver.actions.find((action) => action.actionId === 'cc71')?.range ?? { min: 0, max: 127, step: 1 };
  const common = {
    confirm: 'none' as const,
    max_rate_hz: 3,
    oracle: { expect: 'screen_changed' as const, reason: '', type: 'camera' as const },
    reversible: true,
  };
  const warp: HackDraft = {
    ...common, id: 'h_warp', name: 'Warp', kind: 'control', blurb: 'Bend the flowing visual field',
    commands: [{ action: 'cc71', param: 'p_warp', value: 0, delayMs: 0 }],
    control: { accent: '', archetype: 'slider', param: 'p_warp', size: 'm' },
    params: [{ id: 'p_warp', name: 'Warp', ...range, step: range.step ?? 1,
      default: Math.max(range.min, Math.min(range.max, 51)), unit: '' }],
    inverse: { commands: [], restore: 'p_warp' },
  };
  const patterns = ['Flow', 'Rings', 'Prism'].map((name, index): HackDraft => ({
    ...common, id: `h_pattern${index}`, name, kind: 'action', blurb: `Show the ${name.toLowerCase()} pattern`,
    commands: [{ action: `pattern${index}`, param: '', value: 0, delayMs: 0 }],
    control: { accent: '', archetype: 'none', param: '', size: 'm' }, params: [],
    // Undo returns to the default visual preset.
    inverse: { commands: [{ action: 'pattern0', param: '', value: 0, delayMs: 0 }], restore: '' },
  }));
  return { title: 'Visual Synth', hacks: [warp, ...patterns] };
}

export function visualSynthFixtureSession(driver: ForgeDriver): TransportSession {
  return {
    call: async (_request, handlers, options) => {
      throwIfCancelled(options?.signal);
      const content = JSON.stringify(visualSynthDraft(driver));
      handlers.onContent?.(content, content);
      return { content, toolCalls: [], finishReason: 'stop', model: VISUAL_SYNTH_FIXTURE,
        source: 'fixture', latencyMs: 0, chunks: 1,
        usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0 } };
    },
    finish: () => {},
  };
}
