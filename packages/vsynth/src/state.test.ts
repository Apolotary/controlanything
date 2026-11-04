import { describe, expect, it } from 'vitest';
import { applyVisualSynthMidi, createVisualSynthState, isVisualSynthState, TOUCH_HOVER_MAX_CC, touchPhase, VISUAL_SYNTH_CONTROLS } from './state.js';

describe('silent visual instrument MIDI state', () => {
  it('sets Ripples depth with CC21 without changing the pattern or Warp (Perform sends CC21 constantly)', () => {
    const before = createVisualSynthState();
    const water = applyVisualSynthMidi(before, [0xb0, 21, 100])!;
    expect(water.parameters).toMatchObject({ pattern: 0, ripple: 100 / 127, warp: before.warp });
    expect(water.label).toContain('Water ripples');
    expect(applyVisualSynthMidi(water.parameters, [0xb0, 71, 127])?.parameters).toMatchObject({ pattern: 0, ripple: 100 / 127, warp: 1 });
    const prism = applyVisualSynthMidi(water.parameters, [0xc0, 2])!.parameters;
    expect(applyVisualSynthMidi(prism, [0xb0, 21, 10])?.parameters).toMatchObject({ pattern: 2, ripple: 10 / 127 });
    expect(isVisualSynthState({ ...water.parameters, ripple: NaN })).toBe(false);
    expect(isVisualSynthState({ ...water.parameters, ripple: 1.1 })).toBe(false);
  });

  it('maps every documented CC over its full range on MIDI channel one', () => {
    for (const control of VISUAL_SYNTH_CONTROLS) {
      expect(applyVisualSynthMidi(createVisualSynthState(), [0xb0, control.cc, 0])?.parameters[control.parameter]).toBe(control.min);
      expect(applyVisualSynthMidi(createVisualSynthState(), [0xb0, control.cc, 127])?.parameters[control.parameter]).toBe(control.max);
    }
  });
  it('maps the fingertip: CC22 X, CC23 Y (top-left is 0,0) and CC24 pressure with lifted / hover / touching phases', () => {
    const before = createVisualSynthState();
    expect(before).toMatchObject({ touchX: .5, touchY: .5, touchPressure: 0 });
    const moved = applyVisualSynthMidi(applyVisualSynthMidi(before, [0xb0, 22, 0])!.parameters, [0xb0, 23, 127])!;
    expect(moved.parameters).toMatchObject({ touchX: 0, touchY: 1, pattern: 0, ripple: before.ripple });
    expect(moved.label).toBe('Touch Y · 100%');
    expect(applyVisualSynthMidi(before, [0xb0, 24, 64])?.parameters.touchPressure).toBeCloseTo(64 / 127, 10);
    const phases = [0, 1, 20, 21, 127].map((cc) => touchPhase(cc / 127));
    expect(phases).toEqual(['lifted', 'hover', 'hover', 'touching', 'touching']);
    expect(TOUCH_HOVER_MAX_CC).toBe(20);
    // Stop lifts the finger and recentres it
    const touching = applyVisualSynthMidi(before, [0xb0, 24, 100])!.parameters;
    expect(applyVisualSynthMidi(touching, [0xb0, 123, 0])?.parameters).toEqual(before);
    expect(isVisualSynthState({ ...before, touchPressure: 1.2 })).toBe(false);
    expect(isVisualSynthState({ ...before, touchX: undefined })).toBe(false);
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
