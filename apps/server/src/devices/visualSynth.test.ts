import { describe, expect, it } from 'vitest';
import { DriverDraft } from '@ce/protocol';
import { fixtureDeviceCard } from '../agent/identify';
import { driveMessages, fixtureDriverDraft, templateMidiDraft } from '../agent/drive';
import { allowedCcs, loadProfiles, matchMidiProfile, midiBrief } from './profiles';
import { validateDriver } from './validate';
import { visualSynthDraft, visualSynthNeedsUpgrade, VISUAL_SYNTH_ID } from './visualSynth';
import { research } from '../agent/research';

describe('visual synth discovery', () => {
  it('gives initial and repair prompts the exact validated visual action contract without applying it to physical synths', () => {
    const card = { ...fixtureDeviceCard([{ role: 'user', content: 'label "ControlAnything Visual Synth"' }]), cardId: 'screen' };
    const profile = loadProfiles().midi.get(VISUAL_SYNTH_ID)!;
    const found = { brief: midiBrief(profile), provenance: [], profile, allowedCcs: allowedCcs(profile) };
    const rejected = visualSynthDraft(card.cardId, []); rejected.actions[1].actionId = 'flow';
    for (const repair of [undefined, { draft: rejected, issues: 'Missing exact pattern0 action' }]) {
      const messages = driveMessages(card, found, 'midi', 'mac', repair);
      const prompt = messages[1].content as string;
      const prefix = 'Required visual synth actions: ';
      const line = prompt.split('\n').find((entry) => entry.startsWith(prefix));
      expect(line).toBeDefined();
      const actions = JSON.parse(line!.slice(prefix.length));
      expect(actions.map((action: { actionId: string }) => action.actionId)).toEqual(['cc71', 'cc21', 'pattern0', 'pattern1', 'pattern2']);
      const draft = DriverDraft.parse({ cardId: card.cardId, transport: 'midi', provenance: [], actions });
      const result = validateDriver(draft, { driverId: 'driver', executor: { deviceId: 'mac', port: 'ce-visual-synth' } }, { allowedCcs: found.allowedCcs });
      expect(result.ok, JSON.stringify(result.issues)).toBe(true);
      expect(prompt).toContain('Return exactly these five actions');
    }
    const physical = { ...found, profile: { ...profile, id: 'op-1-field' } };
    expect(driveMessages(card, physical, 'midi', 'mac')[1].content).not.toContain('Required visual synth actions:');
  });

  it('identifies the labelled screen as a MIDI instrument and researches only this repo', async () => {
    const card = { ...fixtureDeviceCard([{ role: 'user', content: 'label "ControlAnything Visual Synth"' }]), cardId: 'screen' };
    expect(card.requires).toEqual(['midi']);
    const profiles = loadProfiles();
    const profile = matchMidiProfile(profiles, card)!;
    expect(profile.id).toBe(VISUAL_SYNTH_ID);
    expect([...allowedCcs(profile)].sort((a, b) => a - b)).toEqual([1, 7, 10, 11, 20, 21, 71, 74]);
    const found = await research({ profiles, web: { mode: 'fixture', research: async () => { throw new Error('must not search'); } } }, card, 'midi');
    expect(found.brief).toContain('Verification sensor: camera');
    expect(found.provenance[0].ref).toContain(VISUAL_SYNTH_ID);
    const draft = templateMidiDraft(card, profile, found);
    expect(DriverDraft.parse(draft).actions).toHaveLength(5);
    expect(fixtureDriverDraft([{ role: 'user', content: `cardId "screen". Transport: midi\n${midiBrief(profile)}` }]).actions).toEqual(draft.actions);
    const validated = validateDriver(draft, { driverId: 'driver', executor: { deviceId: 'companion', port: 'ce-visual-synth' } }, { allowedCcs: found.allowedCcs });
    expect(validated.ok, JSON.stringify(validated.issues)).toBe(true);
    expect(validated.driver.actions.every((action) => action.expect?.sense === 'camera')).toBe(true);
    expect(validated.driver.actions[0]).toMatchObject({ range: { min: 0, max: 127 }, curve: 'linear' });
  });


  it('marks saved legacy visuals for upgrade without affecting physical MIDI drivers', () => {
    const current = { executor: { deviceId: 'mac', port: 'ce-visual-synth' }, actions: visualSynthDraft('screen', []).actions };
    expect(visualSynthNeedsUpgrade(current)).toBe(false);
    const old = { ...current, actions: current.actions.filter(a => a.actionId !== 'cc21') };
    expect(visualSynthNeedsUpgrade(old)).toBe(true);
    expect(visualSynthNeedsUpgrade({ ...old, executor: { deviceId: 'mac', port: 'OP-1' } })).toBe(false);
  });

  it('requires a distinct Water ripple action rather than relabelled Warp', () => {
    const draft = visualSynthDraft('screen', []);
    const ripple = draft.actions.find(action => action.actionId === 'cc21')!;
    expect(ripple).toMatchObject({ kind: 'set', label: 'Water ripples', encode: { number: 21, value: '$value' } });
    ripple.encode = { kind: 'midi', msg: 'cc', channel: 1, number: 71, value: '$value' };
    const wrong = validateDriver(draft, { driverId: 'driver', executor: { deviceId: 'companion', port: 'ce-visual-synth' } }, { allowedCcs: new Set([21,71]) });
    expect(wrong.ok).toBe(false);
    expect(wrong.issues.some(issue => issue.code === 'visual_action')).toBe(true);
    draft.actions = draft.actions.filter(action => action.actionId !== 'cc21');
    const missing = validateDriver(draft, { driverId: 'driver', executor: { deviceId: 'companion', port: 'ce-visual-synth' } }, { allowedCcs: new Set([21,71]) });
    expect(missing.issues.some(issue => issue.code === 'visual_controls')).toBe(true);
  });

  it('canonicalizes generated Warp/Water labels only on the known visual output', () => {
    const draft = visualSynthDraft('screen', []);
    draft.actions[0].label = 'Water ripples';
    draft.actions[1].label = 'Warp';
    const ids = { driverId: 'driver', executor: { deviceId: 'companion', port: 'ce-visual-synth' } };
    const result = validateDriver(draft, ids, { allowedCcs: new Set([21, 71]) });
    expect(result.ok, JSON.stringify(result.issues)).toBe(true);
    expect(result.driver.actions.slice(0, 2).map(action => [action.actionId, action.label])).toEqual([
      ['cc71', 'Warp'], ['cc21', 'Water ripples'],
    ]);
    const physical = validateDriver(draft, { ...ids, executor: { ...ids.executor, port: 'physical-synth' } }, { allowedCcs: new Set([21, 71]) });
    expect(physical.ok, JSON.stringify(physical.issues)).toBe(true);
    expect(physical.driver.actions.slice(0, 2).map(action => action.label)).toEqual(['Water ripples', 'Warp']);
    expect(draft.actions[0].label).toBe('Water ripples');
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
