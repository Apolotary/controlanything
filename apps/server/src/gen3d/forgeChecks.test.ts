import { validateSpec } from '@ce/gen3d';
import { describe, expect, it } from 'vitest';
import { compileHackset, rearmSpec } from './compile';
import { applyEdit, type EditSet, syncHackset } from './editPatch';
import { EXAMPLE_DRIVER, EXAMPLE_OUTPUT } from './forgePrompt';
import { type ForgeDriver, verificationOf } from './forgeTypes';
import { bannedWord, draftIssues } from './forgeVerify';
import { draftToHack, ForgeDraft, HACKSET_VERSION, type HackSet } from './hackset';
import { FORGE_LIGHT_DEVICE, FORGE_LIGHT_DRIVER, FORGE_LIGHT_VERIFIED, FORGE_OP1_DRIVER } from './sampleDevices';
import { LIGHT_DRAFT } from './testkit';

const codes = (draft: ForgeDraft, driver = FORGE_LIGHT_DRIVER) => draftIssues(draft, driver).filter((i) => i.severity === 'error').map((i) => i.code);
const clone = <T>(x: T): T => structuredClone(x);

function lightHackset(): HackSet {
  return { spec: HACKSET_VERSION, device: { id: 'card_light', name: 'Ceiling light', kind: 'lighting', channel: { type: 'ir' } }, hacks: LIGHT_DRAFT.hacks.map(draftToHack), daemons: [] };
}

function compileLight(verification = FORGE_LIGHT_VERIFIED) {
  return compileHackset({ specId: 'spec_card_light', rev: 1, title: 'Ceiling light', hackset: lightHackset(), device: FORGE_LIGHT_DEVICE, driver: FORGE_LIGHT_DRIVER, verification: verificationOf(FORGE_LIGHT_DRIVER, verification), modelIds: ['muse-spark-1.3'], source: 'live' });
}

describe('forge checks', () => {
  it('the few-shot example in the system prompt passes every check', () => {
    expect(ForgeDraft.safeParse(EXAMPLE_OUTPUT).success).toBe(true);
    expect(draftIssues(EXAMPLE_OUTPUT, EXAMPLE_DRIVER).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('accepts a valid light hack set built on learned IR triggers (stepper controls)', () => {
    expect(codes(LIGHT_DRAFT)).toEqual([]);
  });

  it('rejects actions that are not in the driver, with the available list', () => {
    const d = clone(LIGHT_DRAFT);
    d.hacks[2].commands[0].action = 'ir.strobe';
    const i = draftIssues(d, FORGE_LIGHT_DRIVER).find((x) => x.code === 'unknown_action');
    expect(i?.message).toContain('ir.night');
  });

  it('checks values and live params against the action range and kind', () => {
    const d = clone(EXAMPLE_OUTPUT);
    d.hacks[0].params[0].max = 150; // mac.volume is 0..100
    d.hacks[2].commands[0].value = 2; // mac.mute is a toggle: 0 or 1
    d.hacks[3].commands[0].param = 'p_vol'; // a trigger takes no value, and actions send fixed values
    expect(codes(d, EXAMPLE_DRIVER)).toEqual(expect.arrayContaining(['param_range', 'value_range', 'param_in_action', 'trigger_param']));
  });

  it('enforces the 3 Hz light rule on sequences, the oracle, undo and confirm', () => {
    const d = clone(LIGHT_DRAFT);
    d.hacks.push({ ...clone(d.hacks[3]), id: 'h_flick', name: 'Flicker', commands: [{ action: 'ir.off', delayMs: 0, param: '', value: 0 }, { action: 'ir.full', delayMs: 100, param: '', value: 0 }] });
    d.hacks[2].oracle = { expect: 'louder', reason: '', type: 'mic' };
    d.hacks[3].inverse = { commands: [], restore: '' };
    d.hacks[4].reversible = false;
    expect(codes(d)).toEqual(expect.arrayContaining(['photosensitive', 'oracle_mismatch', 'no_inverse', 'irreversible_confirm']));
  });

  it('bans game vocabulary in names and blurbs, but not the device’s own words', () => {
    expect(bannedWord('Breach light')).toBe('breach');
    expect(bannedWord('Quickhack synth')).toBe('quickhack');
    expect(bannedWord('Shape attack')).toBe('attack');
    expect(bannedWord('Shape attack', new Set(['attack']))).toBeUndefined();
    expect(bannedWord('Dim room')).toBeUndefined();
    // the OP-1 sample driver labels an encoder "Envelope attack", so "attack" is allowed there
    const d = clone(EXAMPLE_OUTPUT);
    d.hacks[0].name = 'Shape attack';
    expect(draftIssues(d, { ...EXAMPLE_DRIVER, actions: [...EXAMPLE_DRIVER.actions, ...FORGE_OP1_DRIVER.actions] }).some((i) => i.code === 'banned_name')).toBe(false);
  });

  it('asks for 4-8 hacks with at least two controls and two actions when the driver allows it', () => {
    const d = { ...clone(EXAMPLE_OUTPUT), hacks: clone(EXAMPLE_OUTPUT.hacks).filter((h) => h.kind === 'control') };
    expect(codes(d, EXAMPLE_DRIVER)).toEqual(expect.arrayContaining(['action_count']));
  });
});

describe('compile hack set -> ce.gen3d/1', () => {
  it('produces a spec that passes packages/gen3d validateSpec', () => {
    const r = compileLight();
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(validateSpec(r.spec).ok).toBe(true);
  });

  it('binds every control to its driver action and hack, arms only verified actions', () => {
    const { spec } = compileLight();
    const dim = spec.controls.find((c) => c.id === 'h_dim')!;
    expect(dim).toMatchObject({ kind: 'stepped', range: { min: 0, max: 100, step: 10 }, binding: { action: 'ir.brighter', driverId: 'drv_light', args: { hack: 'h_dim', drive: 'stepper' } }, armed: true });
    // ir.warmer is untested, ir.cooler pending: the warmth control renders disarmed
    expect(spec.controls.find((c) => c.id === 'h_warm')?.armed).toBe(false);
    expect(spec.controls.find((c) => c.id === 'h_off')).toMatchObject({ kind: 'trigger', binding: { action: 'ir.off' }, armed: true });
    const list = spec.parts.find((p) => p.archetype === 'hack-list')!;
    expect(list.params?.items?.map((i) => [i.label, i.controlId, i.status])).toEqual([
      ['Night light', 'h_night', 'verified'],
      ['Lights off', 'h_off', 'verified'],
      ['Full light', 'h_full', 'verified'],
    ]);
    expect(spec.parts.find((p) => p.archetype === 'dimmer-ring')?.controlId).toBe('h_dim');
    expect(spec.parts.find((p) => p.controlId === 'h_warm')?.archetype).toBe('fader');
    expect(spec.parts.find((p) => p.archetype === 'model-chips')?.params?.models).toEqual([{ id: 'muse-spark-1.3', state: 'done' }]);
    expect(spec.modelId).toBe('muse-spark-1.3');
    expect(spec.anchor.mode).toBe('floating');
  });

  it('keeps neighbouring controls >= 0.10 m apart and the row centred', () => {
    const { spec } = compileLight();
    const xs = spec.parts.filter((p) => p.controlId && p.archetype !== 'hack-list').map((p) => p.transform!.position![0]);
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(0.1 - 1e-9);
    const op1 = compileHackset({ specId: 's', rev: 1, title: 'OP-1', hackset: { ...lightHackset(), hacks: [0, 1, 2, 3].map((i) => ({ ...draftToHack(LIGHT_DRAFT.hacks[0]), id: `h_k${i}`, control: { archetype: 'knob' as const, size: 'm' as const, param: 'p_lvl' } })) }, device: FORGE_LIGHT_DEVICE, driver: FORGE_LIGHT_DRIVER, verification: verificationOf(FORGE_LIGHT_DRIVER, FORGE_LIGHT_VERIFIED), modelIds: ['muse-spark-1.3'], source: 'live' });
    expect(op1.ok).toBe(true);
    expect(op1.spec.parts.filter((p) => p.archetype === 'knob').map((p) => p.transform!.position![0])).toEqual([-0.15, -0.05, 0.05, 0.15]);
  });

  it('compiles a BLE gimbal: pan/tilt as one xy control plus a Recenter one-shot', () => {
    const driver: ForgeDriver = {
      driverId: 'drv_osmo',
      cardId: 'card_osmo',
      transport: 'ble',
      actions: [
        { actionId: 'pan', label: 'Pan', kind: 'set', range: { min: -120, max: 120, step: 1 }, expect: { sense: 'ack', effect: 'any' } },
        { actionId: 'tilt', label: 'Tilt', kind: 'set', range: { min: -45, max: 45, step: 1 }, expect: { sense: 'ack', effect: 'any' } },
        { actionId: 'recenter', label: 'Recenter', kind: 'trigger', expect: { sense: 'ack', effect: 'any' } },
      ],
    };
    const cmd = (action: string, param = '') => ({ action, delayMs: 0, param, value: 0 });
    const draft: ForgeDraft = {
      title: 'Gimbal',
      hacks: [
        { blurb: 'pan and tilt the phone', commands: [cmd('pan', 'p_pan'), cmd('tilt', 'p_tilt')], confirm: 'none', control: { accent: '', archetype: 'xy', param: 'p_pan', size: 'm' }, id: 'h_aim', inverse: { commands: [], restore: 'p_pan' }, kind: 'control', max_rate_hz: 3, name: 'Aim camera', oracle: { expect: 'serial_ack', reason: '', type: 'serial' }, params: [{ default: 0, id: 'p_pan', max: 120, min: -120, name: 'Pan', step: 1, unit: '°' }, { default: 0, id: 'p_tilt', max: 45, min: -45, name: 'Tilt', step: 1, unit: '°' }], reversible: true },
        { blurb: 'pan 90° to the left', commands: [{ action: 'pan', delayMs: 0, param: '', value: -90 }], confirm: 'none', control: { accent: '', archetype: 'none', param: '', size: 'm' }, id: 'h_left', inverse: { commands: [cmd('recenter')], restore: '' }, kind: 'action', max_rate_hz: 1, name: 'Look left', oracle: { expect: 'serial_ack', reason: '', type: 'serial' }, params: [], reversible: true },
        { blurb: 'point straight ahead', commands: [cmd('recenter')], confirm: 'none', control: { accent: '', archetype: 'none', param: '', size: 'm' }, id: 'h_center', inverse: { commands: [cmd('recenter')], restore: '' }, kind: 'action', max_rate_hz: 1, name: 'Recenter', oracle: { expect: 'serial_ack', reason: '', type: 'serial' }, params: [], reversible: true },
      ],
    };
    expect(draftIssues(draft, driver).filter((i) => i.severity === 'error')).toEqual([]);
    const hs: HackSet = { spec: HACKSET_VERSION, device: { id: 'card_osmo', name: 'Gimbal', channel: { type: 'ble' } }, hacks: draft.hacks.map(draftToHack) };
    const r = compileHackset({ specId: 'spec_osmo', rev: 1, title: 'Gimbal', hackset: hs, device: { cardId: 'card_osmo', name: 'Gimbal', category: 'other' }, driver, verification: verificationOf(driver, { pan: 'pass', tilt: 'pass', recenter: 'pass' }), modelIds: ['muse-spark-1.3'], source: 'live' });
    expect(r.errors).toEqual([]);
    expect(r.spec.controls.find((c) => c.id === 'h_aim')).toMatchObject({ kind: 'xy', binding: { action: 'pan' }, yBinding: { action: 'tilt' }, armed: true });
    expect(r.spec.parts.find((p) => p.controlId === 'h_aim')?.archetype).toBe('xy-orb');
    expect(r.spec.device?.transport).toBe('other');
  });

  it('rearms from new evidence without touching anything else', () => {
    const { spec } = compileLight();
    const r = rearmSpec(spec, lightHackset(), verificationOf(FORGE_LIGHT_DRIVER, { ...FORGE_LIGHT_VERIFIED, 'ir.warmer': 'pass', 'ir.cooler': 'pass' }));
    expect(r.spec.controls.find((c) => c.id === 'h_warm')?.armed).toBe(true);
    expect(r.hackset.hacks.find((h) => h.id === 'h_warm')?.status).toBe('verified');
    expect(JSON.stringify(r.spec.parts.filter((p) => p.archetype !== 'tag' && p.archetype !== 'hack-list'))).toBe(JSON.stringify(spec.parts.filter((p) => p.archetype !== 'tag' && p.archetype !== 'hack-list')));
  });
});

describe('edits', () => {
  const lever: EditSet = {
    behaviors: [],
    controls: [],
    feedback: [],
    parts: [{ id: 'p_h_dim', kind: 'archetype', archetype: 'lever', controlId: 'h_dim', params: { length: 0.22, accent: '#FF2020', showLabel: true, showValue: true }, transform: { position: [-0.1, 0, 0] } }],
    remove: [],
    summary: 'the dimmer is a big red lever',
    title: '',
  };

  it('applies by id: only the named part changes, everything else is byte-identical, rev+1', () => {
    const { spec } = compileLight();
    const r = applyEdit(spec, lever, FORGE_LIGHT_DRIVER);
    expect(r.ok).toBe(true);
    expect(r.spec!.rev).toBe(spec.rev + 1);
    expect(r.touched).toEqual(['parts:p_h_dim']);
    expect(r.untouchedIdentical).toBe(true);
    for (const p of spec.parts.filter((x) => x.id !== 'p_h_dim')) expect(JSON.stringify(r.spec!.parts.find((x) => x.id === p.id))).toBe(JSON.stringify(p));
    // the hack set follows the presentation change
    const hs = syncHackset(lightHackset(), r.spec!, FORGE_LIGHT_DRIVER);
    expect(hs.hacks.find((h) => h.id === 'h_dim')?.control).toMatchObject({ archetype: 'lever' });
  });

  it('rejects bindings to actions the driver does not have, and empty edits', () => {
    const { spec } = compileLight();
    const bad: EditSet = { ...lever, parts: [], controls: [{ ...spec.controls[0], binding: { action: 'ir.disco', driverId: 'drv_light' } }] };
    expect(applyEdit(spec, bad, FORGE_LIGHT_DRIVER).issues.map((i) => i.code)).toContain('unknown_action');
    expect(applyEdit(spec, { ...lever, parts: [] }, FORGE_LIGHT_DRIVER).issues.map((i) => i.code)).toContain('empty_edit');
  });

  it('adds a hack for a new control bound to a driver action', () => {
    const { spec } = compileLight();
    const add: EditSet = { ...lever, parts: [], controls: [{ id: 'h_cool', kind: 'trigger', label: 'COOL LIGHT', binding: { action: 'ir.cooler', driverId: 'drv_light', args: { hack: 'h_cool' } } }] };
    const r = applyEdit(spec, add, FORGE_LIGHT_DRIVER);
    expect(r.ok).toBe(true);
    const hs = syncHackset(lightHackset(), r.spec!, FORGE_LIGHT_DRIVER);
    expect(hs.hacks.find((h) => h.id === 'h_cool')).toMatchObject({ kind: 'action', commands: [{ action: 'ir.cooler' }], oracle: { type: 'camera', expect: 'cooler' } });
  });
});
