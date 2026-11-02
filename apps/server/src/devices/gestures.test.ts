import { describe, expect, it } from 'vitest';
import type { GestureMap } from '@ce/protocol';
import { ForgeDriver, verificationOf } from '../gen3d/forgeTypes';
import { allPass, LOOP_LIGHT_DRIVER, LOOP_MAC_DRIVER } from '../gen3d/sampleDevices';
import { proposeGestureMap, validateGestureMap } from './gestures';

const synth: ForgeDriver = {
  driverId: 'visual', cardId: 'synth', transport: 'midi',
  actions: ['warp', 'zoom', 'hue'].map((name, i) => ({
    actionId: `param_${name}`, label: name, kind: 'set', range: { min: 0, max: 127, step: 1 },
    encode: { kind: 'midi', msg: 'cc', number: i + 20 }, verified: 'pass',
  })),
};
const base = (): GestureMap => proposeGestureMap(synth)!;

describe('verified gesture maps', () => {
  it('maps visual parameters by name, independently of CC numbers', () => {
    const map = base();
    expect(map.axes.map((binding) => [binding.axis, binding.actionId])).toEqual([
      ['right_height', 'param_warp'], ['right_roll', 'param_zoom'], ['right_pinch_aperture', 'param_hue'],
    ]);
    expect(proposeGestureMap({ ...synth, actions: synth.actions.map((action) => ({ ...action, encode: { ...action.encode!, number: 99 } })) })).toEqual(map);
  });

  it('recognizes the short engine parameter names used by the recorded synth driver', () => {
    const driver = { ...synth, actions: synth.actions.map((action, i) => ({ ...action, actionId: `eng${i + 1}`, label: `Engine Param ${i + 1}` })) };
    expect(proposeGestureMap(driver)?.axes.map((binding) => [binding.axis, binding.actionId])).toEqual([
      ['right_height', 'eng1'], ['right_roll', 'eng2'], ['right_pinch_aperture', 'eng3'],
    ]);
  });

  it('rejects unknown, unverified, stale and hold-confirmation actions', () => {
    expect(() => validateGestureMap(base(), synth, {})).toThrow(/verified/);
    expect(() => validateGestureMap(base(), synth, { ...allPass(synth), param_warp: 'fail' })).toThrow(/verified/);
    expect(() => validateGestureMap(base(), { ...synth, actions: synth.actions.slice(1) })).toThrow(/verified/);
    expect(() => validateGestureMap(base(), { ...synth, actions: synth.actions.map((action) => ({ ...action, confirm: 'hold' })) })).toThrow(/verified/);
    expect(proposeGestureMap(synth, {})).toBeUndefined();
    expect(verificationOf(synth, {})).toEqual({ param_warp: 'untested', param_zoom: 'untested', param_hue: 'untested' });
  });

  it('checks action ranges, step alignment, numeric kinds and supported MIDI operations', () => {
    const map = base();
    expect(() => validateGestureMap({ ...map, axes: [{ ...map.axes[0], outMax: 128 }] }, synth)).toThrow(/range/);
    expect(() => validateGestureMap({ ...map, axes: [{ ...map.axes[0], quantizeStep: 0.5 }] }, synth)).toThrow(/step/);
    expect(() => validateGestureMap(map, { ...synth, actions: synth.actions.map((action) => ({ ...action, kind: 'trigger' })) })).toThrow(/numeric/);
    const pitch = { ...synth, actions: synth.actions.map((action) => ({ ...action, label: 'Pitch bend', encode: { kind: 'midi', msg: 'pitchbend' } })) };
    expect(proposeGestureMap(pitch)).toBeUndefined();
    expect(() => validateGestureMap(map, pitch)).toThrow(/supported/);
  });

  it('caps IR and driver rates, and uses declared brightness steps plus on/off', () => {
    const map = proposeGestureMap(LOOP_LIGHT_DRIVER, allPass(LOOP_LIGHT_DRIVER))!;
    expect(map.axes[0]).toMatchObject({ axis: 'right_height', actionId: 'level', quantizeStep: 10, maxRateHz: 2 });
    expect(map.postures).toEqual(expect.arrayContaining([
      expect.objectContaining({ posture: 'R_PINCH', actionId: 'full' }),
      expect.objectContaining({ posture: 'R_FIST', actionId: 'off' }),
    ]));
    expect(() => validateGestureMap({ ...map, axes: [{ ...map.axes[0], maxRateHz: 3 }] }, LOOP_LIGHT_DRIVER, allPass(LOOP_LIGHT_DRIVER))).toThrow(/rate/);
    expect(proposeGestureMap({ ...synth, maxRateHz: 8 })?.axes.every((binding) => binding.maxRateHz === 8)).toBe(true);
  });

  it('requires verified constituent actions for stepped brightness', () => {
    const driver: ForgeDriver = { ...LOOP_LIGHT_DRIVER, actions: LOOP_LIGHT_DRIVER.actions.map((action) => action.actionId === 'level'
      ? { ...action, encode: { kind: 'step', upActionId: 'brighter', downActionId: 'dimmer', steps: 11 } } : action) };
    const verification = allPass(driver);
    const map = proposeGestureMap(driver, verification)!;
    expect(map.axes).toHaveLength(1);
    expect(ForgeDriver.parse(driver).actions.at(-1)?.encode?.upActionId).toBe('brighter');
    verification.dimmer = 'pending';
    expect(() => validateGestureMap(map, driver, verification)).toThrow(/verified/);
    expect(proposeGestureMap(driver, verification)?.axes).toHaveLength(0);
  });

  it('maps Mac volume and media without binding unrelated local actions', () => {
    const map = proposeGestureMap(LOOP_MAC_DRIVER, allPass(LOOP_MAC_DRIVER))!;
    expect(map.axes).toEqual([expect.objectContaining({ axis: 'right_height', actionId: 'volume', quantizeStep: 5, maxRateHz: 10 })]);
    expect(map.postures).toEqual([expect.objectContaining({ posture: 'R_PINCH', actionId: 'playpause' })]);
    expect(() => validateGestureMap({ ...map, axes: [{ ...map.axes[0], maxRateHz: 20 }] }, LOOP_MAC_DRIVER, allPass(LOOP_MAC_DRIVER))).toThrow(/rate/);
  });

  it('requires fixed posture values to respect set and toggle actions', () => {
    const map = { ...base(), axes: [], postures: [{ posture: 'R_PINCH', actionId: 'param_warp', label: 'Warp', mode: 'press' }] };
    expect(() => validateGestureMap(map, synth)).toThrow(/value/);
    expect(validateGestureMap({ ...map, postures: [{ ...map.postures[0], value: 64 }] }, synth).postures[0].value).toBe(64);
    const mac = proposeGestureMap(LOOP_MAC_DRIVER, allPass(LOOP_MAC_DRIVER))!;
    expect(() => validateGestureMap({ ...mac, postures: [{ ...mac.postures[0], value: 10 }] }, LOOP_MAC_DRIVER, allPass(LOOP_MAC_DRIVER))).toThrow(/toggle/);
  });
});
