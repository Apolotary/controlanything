import { describe, expect, it } from 'vitest';
import { applyVisualSynthMidi, createVisualSynthState, isVisualSynthState, VISUAL_SYNTH_CONTROLS } from './state.js';

describe('silent visual instrument MIDI state', () => {
  it('routes depth CC21 to Water mode without changing the previous Warp value', () => {
    const before = createVisualSynthState();
    const water = applyVisualSynthMidi(before, [0xb0, 21, 100])!;
    expect(water.parameters).toMatchObject({ pattern: 3, ripple: 100 / 127, warp: before.warp });
    expect(water.label).toContain('Water ripples');
    expect(applyVisualSynthMidi(water.parameters, [0xb0, 71, 127])?.parameters).toMatchObject({ pattern: 3, ripple: 100 / 127, warp: 1 });
    expect(isVisualSynthState({ ...water.parameters, ripple: NaN })).toBe(false);
    expect(isVisualSynthState({ ...water.parameters, ripple: 1.1 })).toBe(false);
  });

  it('maps every documented CC over its full range on MIDI channel one', () => {
    for (const control of VISUAL_SYNTH_CONTROLS) {
      expect(applyVisualSynthMidi(createVisualSynthState(), [0xb0, control.cc, 0])?.parameters[control.parameter]).toBe(control.min);
      expect(applyVisualSynthMidi(createVisualSynthState(), [0xb0, control.cc, 127])?.parameters[control.parameter]).toBe(control.max);
    }
  });
  it('selects each pattern and rejects unsupported commands and malformed MIDI', () => {
    for (const pattern of [0, 1, 2, 3]) expect(applyVisualSynthMidi(createVisualSynthState(), [0xc0, pattern])?.parameters.pattern).toBe(pattern);
    for (const bytes of [[0xc0, 4], [0xc0], [0xb0, 71, 128], [0xb0, 71, -1], [0xb0, 71, 1.5], [0xb0, 99, 64], [0x90, 60, 100], [0xb1, 71, 127], [0xc1, 1]]) {
      expect(applyVisualSynthMidi(createVisualSynthState(), bytes)).toBeNull();
    }
  });
  it('resets all parameters on Stop and does not mutate the previous snapshot', () => {
    const before = createVisualSynthState();
    const changed = applyVisualSynthMidi(before, [0xb0, 71, 127])!.parameters;
    expect(before.warp).toBe(0.4);
    expect(changed.warp).toBe(1);
    for (const bytes of [[0xb0, 120, 0], [0xb0, 121, 0], [0xb0, 123, 0], [0xff]]) expect(applyVisualSynthMidi(changed, bytes)?.parameters).toEqual(before);
  });
  it('accepts only bounded finite state snapshots from other tabs', () => {
    expect(isVisualSynthState(createVisualSynthState())).toBe(true);
    for (const invalid of [null, {}, { ...createVisualSynthState(), warp: NaN }, { ...createVisualSynthState(), symmetry: 2.5 }, { ...createVisualSynthState(), pattern: 4 }]) {
      expect(isVisualSynthState(invalid)).toBe(false);
    }
  });
});
