import { describe, expect, it, vi } from 'vitest';
import type { DeviceCardPayload } from '@ce/protocol';
import type { MidiProfile, Profiles } from '../devices/profiles';
import { CachedWebSearcher } from '../research/cache';
import type { WebResearch, WebResearchOptions } from '../research/websearch';
import { research } from './research';

const unknown: DeviceCardPayload = { cardId: 'new-synth', name: 'Example Unknown Synth', maker: 'Example', model: 'Unknown Synth',
  category: 'synthesizer', confidence: 0.9, protocols: ['midi'], requires: ['midi'], evidence: ['Device label'] };
const profile: MidiProfile = { id: 'op-1-field', device: 'OP-1 Field', manufacturer: 'Teenage Engineering',
  sources: [{ title: 'Official MIDI reference', url: 'https://manual.example/op-1-field' }],
  parameters: [{ name: 'Cutoff', cc: 74, range: [0, 127] }] };
const profiles = (): Profiles => ({ midi: new Map([[profile.id, profile]]), ir: undefined, koizumi: undefined, files: [] });
const findings = (): WebResearch => ({ text: 'The documented cutoff control is CC74, range 0–127.',
  citations: [{ url: 'https://manual.example/unknown-synth', title: 'Original device manual' }],
  model: 'original-research-model', source: 'live', effort: 'low', latencyMs: 42 });
function setup() {
  let now = Date.UTC(2026, 10, 1);
  const underlying = { mode: 'live' as const, research: vi.fn(async (_question: string, _options?: WebResearchOptions) => findings()) };
  const web = new CachedWebSearcher(underlying, { runtimeKey: 'research-integration-model', now: () => now });
  return { deps: { profiles: profiles(), web }, underlying, advance: () => { now += 60_000; } };
}

describe('device research retrieval order and provenance', () => {
  it('uses a curated MIDI profile before web search, even for explicit setup rerun', async () => {
    const h = setup();
    const result = await research(h.deps, { ...unknown, name: 'OP-1 Field', maker: 'Teenage Engineering', model: 'OP-1 Field' }, 'midi', { refresh: true });
    expect(h.underlying.research).not.toHaveBeenCalled(); expect(result.profile).toBe(profile);
    expect(result.allowedCcs).toEqual(new Set([74])); expect(result.brief).toContain('74: Cutoff [0-127]');
    expect(result.provenance).toContainEqual({ source: 'manual', ref: profile.sources[0].url, note: profile.sources[0].title });
  });

  it('researches an unknown MIDI device and reuses the original cited evidence with its date and model', async () => {
    const h = setup(); const first = await research(h.deps, unknown, 'midi');
    expect(h.underlying.research).toHaveBeenCalledExactlyOnceWith(
      'Example Unknown Synth MIDI implementation chart: incoming CC numbers, parameter names, channel rules, USB MIDI port name',
      { signal: undefined, refresh: undefined },
    );
    expect(first.brief).toBe(findings().text); expect(first.modelId).toBe('original-research-model');
    expect(first.provenance).toEqual([{ source: 'web_search', ref: findings().citations[0].url, note: 'Original device manual' }]);
    h.advance(); const repeated = await research(h.deps, unknown, 'midi');
    expect(h.underlying.research).toHaveBeenCalledTimes(1);
    expect(repeated.brief).toBe(first.brief); expect(repeated.modelId).toBe(first.modelId);
    expect(repeated.provenance).toEqual([{ source: 'web_search', ref: findings().citations[0].url,
      note: 'Reused research from 2026-11-01T00:00:00.000Z · Original device manual' }]);
    expect(repeated.profile).toBeUndefined(); expect(repeated.allowedCcs).toBeUndefined();
  });

  it('forwards explicit refresh and caller cancellation signal to a new search', async () => {
    const h = setup(); await research(h.deps, unknown, 'midi');
    const signal = new AbortController().signal;
    const refreshed = await research(h.deps, unknown, 'midi', { refresh: true, signal });
    expect(h.underlying.research).toHaveBeenCalledTimes(2);
    expect(h.underlying.research.mock.lastCall?.[1]).toEqual({ signal, refresh: true });
    expect(refreshed.provenance[0].note).toBe('Original device manual');
  });

  it('honors disabled web lookup without retrieving cached evidence', async () => {
    const h = setup(); await research(h.deps, unknown, 'midi');
    const result = await research(h.deps, unknown, 'midi', { allowWeb: false });
    expect(h.underlying.research).toHaveBeenCalledTimes(1);
    expect(result.brief).toBe('No stored MIDI chart for Example Unknown Synth.'); expect(result.provenance).toEqual([]);
  });
});
