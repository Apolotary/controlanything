import { describe, expect, it } from 'vitest';
import { WaterRipples, WATER_RIPPLE_CAPACITY } from './ripples.js';

describe('water ripple motion impulses', () => {
  it('has no startup splash or stationary impulses, and retains push/pull polarity', () => {
    const waves = new WaterRipples(); expect([...waves.data].every(value => value === 0)).toBe(true);
    waves.push(.5, .5, 0); expect([...waves.data].every(value => value === 0)).toBe(true);
    waves.push(.5, .7, .2); expect(waves.data[3]).toBeGreaterThan(0);
    waves.push(.7, .3, .4); expect(waves.data[7]).toBeLessThan(0);
    waves.reset(); expect([...waves.data].every(value => value === 0)).toBe(true);
  });
  it('coalesces high-rate input and bounds wave count/strength while rejecting invalid input', () => {
    const waves = new WaterRipples();
    for (let index = 0; index < 30; index++) waves.push(index / 30, (index + 1) / 30, index / 60);
    expect(waves.data).toHaveLength(WATER_RIPPLE_CAPACITY * 4);
    for (let index = 3; index < waves.data.length; index += 4) expect(Math.abs(waves.data[index]!)).toBeLessThanOrEqual(.221);
    const snapshot = [...waves.data]; waves.push(NaN, .5, 1); waves.push(.5, Infinity, 1); waves.push(.5, .7, NaN);
    expect([...waves.data]).toEqual(snapshot);
  });
});
