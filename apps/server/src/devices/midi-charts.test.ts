import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeviceCardPayload, DriverDraft } from '@ce/protocol';
import { MidiChartInput, MidiChartRequest, MidiChartStore } from './midi-charts';
import { loadProfiles, matchMidiProfile } from './profiles';
import { validateDriver } from './validate';
import { research } from '../agent/research';
import { templateMidiDraft } from '../agent/drive';
import { restoreResearch, saveResearch } from '../agent/library-schema';
import { verifyOnce, type VerifyDeps } from '../agent/verify';
import { TargetStore } from '../agent/targets';
import { resolveOp } from './encode';

const card: DeviceCardPayload = { cardId: 'orion', name: 'Orion 6', maker: 'Example', model: 'Orion 6', category: 'synthesizer', confidence: .9, protocols: ['midi'], requires: ['midi'], evidence: ['Model label'] };
const input: MidiChartInput = { maker: 'Example', model: 'Orion 6', channel: 3,
  source: { title: 'Orion 6 manual', url: 'https://example.com/orion-6/manual', section: 'MIDI implementation, page 42' },
  parameters: [{ cc: 74, name: 'Cutoff', min: 20, max: 100 }] };
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe('explicit reviewed MIDI permissions', () => {
  it('persists cited, revisioned permissions only for the exact identified object', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ce-midi-chart-')); roots.push(dir);
    const file = join(dir, 'charts.json'), store = new MidiChartStore(file);
    expect(store.profile(card)).toBeUndefined();
    expect(store.review(card, input, 0, 'Mac owner')).toMatchObject({ cardId: 'orion', revision: 1, chart: input });
    const reloaded = new MidiChartStore(file);
    const originalProfile = reloaded.profile(card)!;
    expect(reloaded.isCurrent(card.cardId, card, originalProfile)).toBe(true);
    expect(reloaded.isCurrent(card.cardId, { ...card, model: 'Orion 8' }, originalProfile)).toBe(false);
    expect(new MidiChartStore().isCurrent(card.cardId, card, originalProfile)).toBe(false);
    expect(reloaded.profile(card)).toMatchObject({ reviewedChart: { cardId: 'orion', revision: 1, channel: 3 } });
    expect(reloaded.profile({ ...card, cardId: 'other-object' })).toBeUndefined();
    expect(reloaded.profile({ ...card, model: 'Orion 8' })).toBeUndefined();
    expect(() => reloaded.review(card, input, 0, 'Stale editor')).toThrow('changed');
    expect(reloaded.review(card, { ...input, parameters: [{ ...input.parameters[0], max: 90 }] }, 1, 'Owner').revision).toBe(2);
    expect(reloaded.isCurrent(card.cardId, card, originalProfile)).toBe(false);
    expect(reloaded.isCurrent(card.cardId, card, undefined)).toBe(false);
    const data = JSON.parse(readFileSync(file, 'utf8')); expect(data.charts).toHaveLength(1); expect(data.charts[0].revision).toBe(2);
  });
  it('does not accept missing explicit review, wrong identity, uncited or unsupported MIDI operations', () => {
    expect(MidiChartRequest.safeParse({ cardId: card.cardId, expectedRevision: 0, reviewed: false, chart: input }).success).toBe(false);
    expect(() => new MidiChartStore().review(card, { ...input, model: 'Orion 8' }, 0, 'Owner')).toThrow('exact maker');
    for (const cc of [0, 32, 120, 127, 128]) expect(MidiChartInput.safeParse({ ...input, parameters: [{ ...input.parameters[0], cc }] }).success).toBe(false);
    expect(MidiChartInput.safeParse({ ...input, channel: 17 }).success).toBe(false);
    expect(MidiChartInput.safeParse({ ...input, parameters: [input.parameters[0], input.parameters[0]] }).success).toBe(false);
    expect(MidiChartInput.safeParse({ ...input, parameters: [{ ...input.parameters[0], max: 10 }] }).success).toBe(false);
    expect(MidiChartInput.safeParse({ ...input, source: { ...input.source, url: 'javascript:alert(1)' } }).success).toBe(false);
    expect(MidiChartInput.safeParse({ ...input, source: { ...input.source, section: '' } }).success).toBe(false);
    const url = 'https://example.com/' + 'a'.repeat(480);
    expect(url.length).toBe(500);
    expect(MidiChartInput.safeParse({ ...input, source: { ...input.source, url } }).success).toBe(true);
    expect(MidiChartInput.safeParse({ ...input, source: { ...input.source, url: url + 'a' } }).success).toBe(false);
  });
  it('fails closed when a persisted chart is corrupt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ce-midi-chart-')); roots.push(dir);
    const file = join(dir, 'charts.json'); writeFileSync(file, '{"version":1,"charts":[{"cardId":"orion"}]}');
    const store = new MidiChartStore(file); expect(store.warnings).toHaveLength(1); expect(store.profile(card)).toBeUndefined();
  });
  it('retrieves explicit manual permissions before web prose, with independently enforced channel and value bounds', async () => {
    const store = new MidiChartStore(); store.review(card, input, 0, 'Owner');
    const web = { mode: 'fixture' as const, research: vi.fn() };
    const found = await research({ profiles: loadProfiles(), midiCharts: store, web }, card, 'midi');
    expect(web.research).not.toHaveBeenCalled();
    expect(found.allowedCcs).toEqual(new Set([74]));
    expect(found.provenance).toContainEqual(expect.objectContaining({ source: 'manual', ref: input.source.url }));
    expect(found.brief).toContain('channel 3');
    const draft = templateMidiDraft(card, found.profile!, found);
    expect(draft.actions).toHaveLength(1);
    expect(draft.actions[0]).toMatchObject({ range: { min: 20, max: 100 }, encode: { channel: 3, msg: 'cc', number: 74 } });
    const context = { expectedTransport: 'midi' as const, allowedCcs: found.allowedCcs, allowedChannels: new Set([3]), ccRanges: new Map([[74, { min: 20, max: 100 }]]), midiCcOnly: true };
    const ids = { driverId: 'driver', executor: { deviceId: 'mac', port: 'orion-out' } };
    const validated = validateDriver(draft, ids, context);
    expect(validated.ok).toBe(true);
    for (const [value, expected] of [[0, 20], [20, 20], [60, 60], [100, 100], [127, 100]]) {
      expect(resolveOp(validated.driver.actions[0], value)).toMatchObject({ kind: 'midi', msg: 'cc', number: 74, value: expected });
    }
    const alter = (encode: DriverDraft['actions'][number]['encode']) => ({ ...draft, actions: [{ ...draft.actions[0], encode }] });
    expect(validateDriver(alter({ kind: 'midi', msg: 'cc', channel: 3, number: 75, value: '$value' }), ids, context).issues.map((i) => i.code)).toContain('cc_not_in_chart');
    expect(validateDriver(alter({ kind: 'midi', msg: 'cc', channel: 1, number: 74, value: '$value' }), ids, context).issues.map((i) => i.code)).toContain('channel_not_allowed');
    expect(validateDriver({ ...draft, actions: [{ ...draft.actions[0], range: { min: 0, max: 127 } }] }, ids, context).issues.map((i) => i.code)).toContain('cc_range_not_reviewed');
    expect(validateDriver(alter({ kind: 'midi', msg: 'pc', channel: 3, number: 1 }), ids, context).issues.map((i) => i.code)).toContain('midi_message_not_reviewed');
    expect(validateDriver({ ...draft, actions: [{ ...draft.actions[0], expect: { sense: 'ack', effect: 'any' } }] }, ids, context).issues.map((i) => i.code)).toContain('physical_oracle_required');
    const local = { ...draft, transport: 'local' as const, actions: [{ actionId: 'say', label: 'Say', kind: 'trigger' as const, encode: { kind: 'local' as const, op: 'say' as const, arg: 'Hello' } }] };
    expect(validateDriver(local, ids, context).issues.map((i) => i.code)).toContain('selected_transport_mismatch');
    expect(restoreResearch(saveResearch(found))?.profile?.reviewedChart).toEqual(found.profile?.reviewedChart);
  });
  it('does not infer OP-1 Field permissions from the ambiguous OP-1 model or port label', () => {
    const profiles = loadProfiles();
    expect(matchMidiProfile(profiles, { maker: 'Teenage Engineering', model: 'OP-1', name: 'OP-1 synthesizer' })).toBeUndefined();
    expect(matchMidiProfile(profiles, { maker: 'Teenage Engineering', model: 'OP-1', name: 'OP-1 Field' })).toBeUndefined();
    expect(matchMidiProfile(profiles, { maker: 'Teenage Engineering', model: 'OP-1 Field', name: 'Synthesizer' })?.id).toBe('op-1-field');
  });
  it('verifies a reviewed CC subset without silently authorizing extra MIDI notes', async () => {
    const store = new MidiChartStore(); store.review(card, input, 0, 'Owner');
    const profile = store.profile(card)!;
    const found = { brief: 'Reviewed chart', provenance: [], profile, allowedCcs: new Set([74]) };
    const driver = validateDriver(templateMidiDraft(card, profile, found), { driverId: 'driver', executor: { deviceId: 'mac', port: 'out' } }, { allowedCcs: found.allowedCcs }).driver;
    const target = new TargetStore({ broadcast: () => 0 }).create({ cardId: card.cardId, card, driver, research: found });
    const exec = vi.fn().mockResolvedValue({ execId: 'cc', sentAt: 1, ok: true });
    const audio = { rms: .2, rmsDb: -14, centroidHz: 400, windowMs: 600 };
    const sense = vi.fn().mockResolvedValueOnce([{ audio }]).mockResolvedValueOnce([{ audio: { ...audio, centroidHz: 1200 } }]);
    const deps = { dispatcher: { exec, sense }, sam: {}, settleMs: () => 0 } as unknown as VerifyDeps;
    const result = await verifyOnce(deps, target, driver, driver.actions[0], 0, { micDeviceId: 'quest' });
    expect(result.evidence.pass).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][1]).toMatchObject({ kind: 'midi', msg: 'cc', channel: 3, number: 74, value: 100 });
  });
});
