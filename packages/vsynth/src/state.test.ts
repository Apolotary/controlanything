import { describe, expect, it } from 'vitest';
import { applyVisualSynthMidi, createVisualSynthState, isVisualSynthState, VISUAL_SYNTH_CONTROLS } from './state.js';

describe('silent visual instrument MIDI state', () => {
  it('maps every documented CC over its full range on MIDI channel one', () => {
    for (const control of VISUAL_SYNTH_CONTROLS) {
      expect(applyVisualSynthMidi(createVisualSynthState(), [0xb0, control.cc, 0])?.parameters[control.parameter]).toBe(control.min);
      expect(applyVisualSynthMidi(createVisualSynthState(), [0xb0, control.cc, 127])?.parameters[control.parameter]).toBe(control.max);
    }
  });
  it('selects each pattern and rejects unsupported commands and malformed MIDI', () => {
    for (const pattern of [0, 1, 2]) expect(applyVisualSynthMidi(createVisualSynthState(), [0xc0, pattern])?.parameters.pattern).toBe(pattern);
    for (const bytes of [[0xc0, 3], [0xc0], [0xb0, 71, 128], [0xb0, 71, -1], [0xb0, 71, 1.5], [0xb0, 99, 64], [0x90, 60, 100], [0xb1, 71, 127], [0xc1, 1]]) {
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
    for (const invalid of [null, {}, { ...createVisualSynthState(), warp: NaN }, { ...createVisualSynthState(), symmetry: 2.5 }, { ...createVisualSynthState(), pattern: 3 }]) {
      expect(isVisualSynthState(invalid)).toBe(false);
    }
  });
});
