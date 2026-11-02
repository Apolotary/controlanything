import { describe, expect, it } from 'vitest';
import { controlPower, isBrightness } from './control-state';

describe('control readout power', () => {
  it.each(['off', 'ir.off', 'ir.powerOff'])('recognizes %s and ignores trigger release', (action) => {
    const control = { kind: 'trigger' as const, label: 'Lights out', binding: { action } };
    expect(controlPower(control, true)).toBe(false);
    expect(controlPower(control, false)).toBeUndefined();
  });
  it.each(['fullOn', 'ir.full-on', 'on'])('restores the readout for %s', (action) => {
    expect(controlPower({ kind: 'trigger', label: 'Full light', binding: { action } }, true)).toBe(true);
  });
  it('supports generated labels and power toggles without mistaking other controls for power', () => {
    expect(controlPower({ kind: 'trigger', label: 'Turn off', binding: { action: 'dispatch' } }, true)).toBe(false);
    expect(controlPower({ kind: 'toggle', label: 'Power', binding: { action: 'power' } }, false)).toBe(false);
    expect(controlPower({ kind: 'trigger', label: 'Night', binding: { action: 'nightLight' } }, true)).toBeUndefined();
    expect(isBrightness({ kind: 'stepped', label: 'Brightness', binding: { action: 'ir.brighter' } })).toBe(true);
    expect(isBrightness({ kind: 'continuous', label: 'Warmth', binding: { action: 'ir.warmer' } })).toBe(false);
  });
});
