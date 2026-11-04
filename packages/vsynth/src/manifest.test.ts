import { describe, expect, it } from 'vitest';
import { VISUAL_SYNTH_MANIFEST } from './manifest.js';
import { VISUAL_SYNTH_CONTROLS } from './state.js';

describe('visual synth capability manifest', () => {
  it('lists every renderer control with a written effect (Muse writes drivers and wiring from this)', () => {
    expect(VISUAL_SYNTH_MANIFEST.controls.map((control) => control.cc).sort((a, b) => a - b))
      .toEqual(VISUAL_SYNTH_CONTROLS.map((control) => control.cc).sort((a, b) => a - b));
    for (const control of VISUAL_SYNTH_MANIFEST.controls) expect(control.effect.length, control.parameter).toBeGreaterThan(control.label.length);
  });

  it('documents the three touch controls so a wiring program can use them', () => {
    const touch = Object.fromEntries(VISUAL_SYNTH_MANIFEST.controls.filter((control) => [22, 23, 24].includes(control.cc)).map((control) => [control.cc, control]));
    expect(touch[22]).toMatchObject({ parameter: 'touchX', label: 'Touch X', rendererRange: [0, 1], curve: 'linear' });
    expect(touch[23]).toMatchObject({ parameter: 'touchY', label: 'Touch Y' });
    expect(touch[24]).toMatchObject({ parameter: 'touchPressure', label: 'Touch pressure' });
    expect(touch[22]!.effect).toMatch(/left to right.*0 = left edge, 127 = right edge/);
    expect(touch[23]!.effect).toMatch(/top to bottom.*0,0/);
    expect(touch[24]!.effect).toMatch(/0 lifted; 1-20 hovering.*21-127 touching.*splash.*wake/);
    expect(VISUAL_SYNTH_MANIFEST.touch).toMatch(/CC22.*CC23.*CC24/);
    expect(VISUAL_SYNTH_MANIFEST.touch).toMatch(/Send X and Y first/);
  });

  it('keeps the existing controls and still never accepts notes', () => {
    for (const cc of [1, 7, 10, 11, 20, 21, 71, 74]) expect(VISUAL_SYNTH_MANIFEST.controls.some((control) => control.cc === cc), `CC${cc}`).toBe(true);
    expect(VISUAL_SYNTH_MANIFEST.silent).toBe(true);
    expect(VISUAL_SYNTH_MANIFEST.rejects.join(' ')).toMatch(/note on\/off/);
    expect(VISUAL_SYNTH_MANIFEST.programs).toHaveLength(4);
  });
});
