import { describe, expect, it } from 'vitest';
import { GestureMap, type GestureAxisBinding } from './gestures';
import { PayloadSchemas } from './messages';

const axis: GestureAxisBinding = {
  axis: 'right_height', actionId: 'warp', label: 'Warp', outMin: 0, outMax: 127,
  curve: 's-curve', deadzone: 0.02, smoothingMinCutoff: 1.2, smoothingBeta: 0.4, quantizeStep: 1, maxRateHz: 30,
};
const map = { version: 1, clutchPosture: 'L_FIST', panicPosture: 'BOTH_PALMS_OUT', axes: [axis], postures: [] };

describe('gesture map schema', () => {
  it('round trips on ui.spec and defaults posture rate to two per second', () => {
    expect(PayloadSchemas['ui.spec'].parse({ specId: 'surface', gestureMap: map }).gestureMap).toEqual(map);
    expect(GestureMap.parse({ ...map, postures: [{ posture: 'R_PINCH', actionId: 'on', label: 'On', mode: 'press' }] }).postures[0].maxRateHz).toBe(2);
  });

  it.each([
    { maxRateHz: 31 }, { quantizeStep: 0 }, { outMin: 128 }, { outMax: Infinity }, { deadzone: 0.8 },
  ])('rejects invalid axis settings %j', (change) => {
    expect(GestureMap.safeParse({ ...map, axes: [{ ...axis, ...change }] }).success).toBe(false);
  });

  it('rejects duplicate inputs and unsupported posture modes', () => {
    expect(GestureMap.safeParse({ ...map, axes: [axis, axis] }).success).toBe(false);
    expect(GestureMap.safeParse({ ...map, postures: [{ posture: 'R_PINCH', actionId: 'on', label: 'On', mode: 'hold' }] }).success).toBe(false);
    expect(GestureMap.safeParse({ ...map, clutchPosture: 'R_PINCH' }).success).toBe(false);
  });
});
