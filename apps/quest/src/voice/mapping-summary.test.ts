import { describe, expect, it } from 'vitest';
import { GestureMap, type UiSpecPayload } from '@ce/protocol';
import { mappingSummary } from './mapping-summary';

describe('published mapping summary', () => {
  it('uses the actual revision and mapped input instead of the latest request text', () => {
    const gestureMap = GestureMap.parse({ version: 1, clutchPosture: 'L_FIST', panicPosture: 'BOTH_PALMS_OUT',
      axes: [{ axis: 'right_height', actionId: 'warp', label: 'Warp', outMin: 0, outMax: 127, curve: 'linear', deadzone: 0.02,
        smoothingMinCutoff: 1.2, smoothingBeta: 0.4, quantizeStep: 1, maxRateHz: 30 }], postures: [] });
    const spec: UiSpecPayload = { specId: 'visual', cardId: 'synth', rev: 2, gestureMap };
    expect(mappingSummary(spec)).toBe('Map r2 · Height to Warp');
    expect(mappingSummary({ ...spec, rev: 3, gestureMap: { ...gestureMap, axes: [{ ...gestureMap.axes[0]!, axis: 'right_roll' }] } })).toBe('Map r3 · Wrist roll to Warp');
    expect(mappingSummary({ ...spec, gestureMap: { ...gestureMap, axes: [], postures: [{ posture: 'R_FIST', actionId: 'rings', label: 'Rings', mode: 'press', maxRateHz: 2 }] } })).toBe('Map r2 · Right fist to Rings');
    expect(mappingSummary(undefined)).toBeUndefined();
    expect(mappingSummary({ ...spec, gestureMap: undefined })).toBeUndefined();
  });
});
