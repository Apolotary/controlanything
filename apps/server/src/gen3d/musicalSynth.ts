/** Fixture presentation only: catalog controls from the actual driver, never a hand mapping or recorded model claim. */
import { MUSICAL_SYNTH_MANIFEST } from '@ce/vsynth/musical-manifest';
import { isMusicalSynthPort } from '../devices/musicalSynth';
import { throwIfCancelled } from '../muse/cancellation';
import type { ForgeDriver } from './forgeTypes';
import type { ForgeDraft, HackDraft } from './hackset';
import type { TransportSession } from './transport';
export const MUSICAL_SYNTH_FIXTURE = 'fixture:musical-synth';
export const isMusicalSynth = (driver: ForgeDriver): boolean => driver.transport === 'midi' && isMusicalSynthPort(driver.executor?.port);
export function musicalSynthForgeDraft(driver: ForgeDriver): ForgeDraft {
  const common = { confirm: 'none' as const, max_rate_hz: 3, reversible: true,
    // Software graph evidence, not a claim that a physical microphone heard this sound.
    oracle: { type: 'wire' as const, expect: 'none' as const, reason: 'Software analyser and exact parameter receipt; not physical microphone evidence.' } };
  const short = (s: string, n: number) => s.trim().slice(0, n) || 'Control';
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 20);
  const sets = driver.actions.filter(a => a.kind === 'set' && a.range).slice(0, 4);
  const triggers = driver.actions.filter(a => a.kind === 'trigger').slice(0, 3);
  const hacks: HackDraft[] = [
    ...sets.map((a): HackDraft => {
      const range = a.range!, param = `p_${slug(a.actionId)}`;
      const cc = a.encode?.msg === 'cc' ? a.encode.number : undefined;
      const value = MUSICAL_SYNTH_MANIFEST.controls.find(c => c.cc === cc)?.default ?? range.min;
      return { ...common, id: `h_${slug(a.actionId)}`, name: short(a.label, 14), kind: 'control', blurb: short(a.label, 40),
        commands: [{ action: a.actionId, param, value: 0, delayMs: 0 }], control: { accent: '', archetype: 'slider', param, size: 'm' },
        params: [{ id: param, name: short(a.label, 16), ...range, step: range.step ?? 1, default: Math.max(range.min, Math.min(range.max, value)), unit: '' }],
        inverse: { commands: [], restore: param } };
    }),
    ...triggers.map((a): HackDraft => ({ ...common, id: `h_${slug(a.actionId)}`, name: short(a.label, 14), kind: 'action', blurb: short(a.label, 40),
      commands: [{ action: a.actionId, param: '', value: 0, delayMs: 0 }], control: { accent: '', archetype: 'none', param: '', size: 'm' }, params: [],
      inverse: { commands: [{ action: a.inverseActionId ?? triggers.find(t => t.encode?.msg === 'pc' && t.encode.number === 0)?.actionId ?? a.actionId, param: '', value: 0, delayMs: 0 }], restore: '' } })),
  ];
  return { title: 'ControlAnything Synth', hacks };
}
export function musicalSynthFixtureSession(driver: ForgeDriver): TransportSession {
  return { call: async (_request, handlers, options) => {
    throwIfCancelled(options?.signal);
    const content = JSON.stringify(musicalSynthForgeDraft(driver)); handlers.onContent?.(content, content);
    return { content, toolCalls: [], finishReason: 'stop', model: MUSICAL_SYNTH_FIXTURE, source: 'fixture', latencyMs: 0, chunks: 1,
      usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0 } };
  }, finish: () => {} };
}
