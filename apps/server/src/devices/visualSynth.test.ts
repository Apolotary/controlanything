import { describe, expect, it } from 'vitest';
import { DriverDraft } from '@ce/protocol';
import { fixtureDeviceCard } from '../agent/identify';
import { fixtureDriverDraft, templateMidiDraft } from '../agent/drive';
import { allowedCcs, loadProfiles, matchMidiProfile, midiBrief } from './profiles';
import { validateDriver } from './validate';
import { visualSynthDraft, VISUAL_SYNTH_ID } from './visualSynth';
import { research } from '../agent/research';

describe('visual synth discovery', () => {
  it('identifies the labelled screen as a MIDI instrument and researches only this repo', async () => {
    const card = { ...fixtureDeviceCard([{ role: 'user', content: 'label "ControlAnything Visual Synth"' }]), cardId: 'screen' };
    expect(card.requires).toEqual(['midi']);
    const profiles = loadProfiles();
    const profile = matchMidiProfile(profiles, card)!;
    expect(profile.id).toBe(VISUAL_SYNTH_ID);
    expect([...allowedCcs(profile)].sort((a, b) => a - b)).toEqual([1, 7, 10, 11, 20, 71, 74]);
    const found = await research({ profiles, web: { mode: 'fixture', research: async () => { throw new Error('must not search'); } } }, card, 'midi');
    expect(found.brief).toContain('Verification sensor: camera');
    expect(found.provenance[0].ref).toContain(VISUAL_SYNTH_ID);
    const draft = templateMidiDraft(card, profile, found);
    expect(DriverDraft.parse(draft).actions).toHaveLength(4);
    expect(fixtureDriverDraft([{ role: 'user', content: `cardId "screen". Transport: midi\n${midiBrief(profile)}` }]).actions).toEqual(draft.actions);
    const validated = validateDriver(draft, { driverId: 'driver', executor: { deviceId: 'companion', port: 'ce-visual-synth' } }, { allowedCcs: found.allowedCcs });
    expect(validated.ok, JSON.stringify(validated.issues)).toBe(true);
    expect(validated.driver.actions.every((action) => action.expect?.sense === 'camera')).toBe(true);
    expect(validated.driver.actions[0]).toMatchObject({ range: { min: 0, max: 127 }, curve: 'linear' });
  });

  it('refuses audio expectations and note commands on the visual output', () => {
    const draft = visualSynthDraft('screen', []);
    draft.actions[0].expect = { sense: 'audio', effect: 'any' };
    draft.actions[1].encode = { kind: 'midi', msg: 'note', channel: 1, number: 60 };
    const validated = validateDriver(draft, { driverId: 'driver', executor: { deviceId: 'companion', port: 'ce-visual-synth' } }, { allowedCcs: new Set([71]) });
    expect(validated.ok).toBe(false);
    expect(validated.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['physical_oracle_required', 'visual_action']));
  });

  it.each([
    ['wrong program', (draft: DriverDraft) => { draft.actions[1].encode = { kind: 'midi', msg: 'pc', channel: 1, number: 2 }; }, 'visual_action'],
    ['small range', (draft: DriverDraft) => { draft.actions[0].range = { min: 0, max: 1, step: 1 }; }, 'visual_range'],
    ['fractional steps', (draft: DriverDraft) => { draft.actions[0].range!.step = 0.5; }, 'visual_range'],
    ['no-change expectation', (draft: DriverDraft) => { draft.actions[0].expect = { sense: 'camera', effect: 'none' }; }, 'visual_effect'],
    ['step composite', (draft: DriverDraft) => { draft.actions[0].encode = { kind: 'step', upActionId: 'pattern1', downActionId: 'pattern0', steps: 3 }; }, 'visual_action'],
    ['incorrect Warp action', (draft: DriverDraft) => { draft.actions[0].kind = 'trigger'; draft.actions[0].encode = { kind: 'midi', msg: 'pc', channel: 1, number: 0 }; }, 'visual_action'],
  ] as const)('rejects a live draft with %s', (_name, mutate, code) => {
    const draft = visualSynthDraft('screen', []);
    mutate(draft);
    const result = validateDriver(draft, { driverId: 'driver', executor: { deviceId: 'companion', port: 'ce-visual-synth' } }, { allowedCcs: new Set([71]) });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === code)).toBe(true);
  });
});
