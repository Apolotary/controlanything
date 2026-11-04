import { describe, expect, it } from 'vitest';
import { TOUCH_STALE_SECONDS, TOUCH_WAVE_CAPACITY, TouchWater, WaterRipples, WATER_RIPPLE_CAPACITY } from './ripples.js';

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

describe('touch the water (fingertip splash, wake, lens)', () => {
  const FRAME = 1 / 60;
  const frames = (touch: TouchWater, from: number, to: number, aspect = 1.6) => { for (let t = from; t <= to + 1e-9; t += FRAME) touch.frame(t, FRAME, aspect); };
  const live = (touch: TouchWater) => touch.diagnostics().waves;
  /** A segment's length in the shader's screen space (2 across the canvas height). */
  const length = (wave: { x: number; y: number; x2: number; y2: number }, aspect = 1.6) => Math.hypot((wave.x2 - wave.x) * 2 * aspect, (wave.y2 - wave.y) * 2);

  it('splashes at the contact on the very next frame, stronger with more pressure, and echoes once', () => {
    const soft = new TouchWater(), hard = new TouchWater();
    soft.receive({ x: .25, y: .75, pressure: 21 / 127 }, 1); hard.receive({ x: .25, y: .75, pressure: 1 }, 1);
    expect(live(soft)).toEqual([]); // nothing is placed until a frame draws it: never smoothed, never a frame late
    soft.frame(1.016, FRAME, 1.6); hard.frame(1.016, FRAME, 1.6);
    const [splash] = live(soft), [slap] = live(hard);
    expect(splash).toMatchObject({ x: .25, y: .75, x2: .25, y2: .75, big: 1 });
    expect(slap!.strength).toBeGreaterThan(splash!.strength);
    expect(splash!.strength).toBeGreaterThan(.5); expect(slap!.strength).toBeLessThan(1.3);
    expect(hard.diagnostics().phase).toBe('touching');
    frames(hard, 1.032, 1.4); // the echo starts .16 s later at the same place
    expect(live(hard).filter((wave) => Math.round(wave.big * 100) === 80)).toHaveLength(1);
    expect([...hard.segments.slice(4, 8)]).toEqual([.25, .75, .25, .75]);
  });

  it('puts a splash under the finger when X/Y arrive a few ms after the pressure', () => {
    const touch = new TouchWater();
    touch.receive({ x: .5, y: .5, pressure: .8 }, 2);
    touch.frame(2.016, FRAME, 1);
    touch.receive({ x: .9, y: .2, pressure: .8 }, 2.03);
    expect(live(touch)[0]).toMatchObject({ x: expect.closeTo(.9, 5), y: expect.closeTo(.2, 5), x2: expect.closeTo(.9, 5) });
    touch.receive({ x: .1, y: .1, pressure: .8 }, 2.5); // too late to be the landing spot: that is a drag
    expect(live(touch)[0]).toMatchObject({ x: expect.closeTo(.9, 5) });
  });

  it('leaves a wake of segments about every 50 ms along a drag, bounded by the ring buffer', () => {
    const touch = new TouchWater();
    touch.receive({ x: .2, y: .5, pressure: .8 }, 0); touch.frame(0.016, FRAME, 1.6);
    expect(live(touch)).toHaveLength(1); // the splash; its echo is still in the future
    for (let i = 1; i <= 60; i++) { // one second at 60 fps, the finger crossing slowly (0.6 of the width)
      touch.receive({ x: .2 + .6 * i / 60, y: .5, pressure: .8 }, i / 60);
      touch.frame(i / 60 + .016, FRAME, 1.6);
    }
    const wake = live(touch).filter((wave) => wave.big === 0);
    expect(wake.length).toBeGreaterThanOrEqual(12); expect(wake.length).toBeLessThanOrEqual(TOUCH_WAVE_CAPACITY - 6);
    for (const wave of wake) { expect(wave.x2).toBeGreaterThanOrEqual(wave.x - 1e-6); expect(length(wave)).toBeLessThan(.13); }
  });

  it('turns a flick across the screen into a chain of short segments inside the budget', () => {
    const fast = new TouchWater();
    fast.receive({ x: 0, y: .5, pressure: .8 }, 0); fast.frame(.016, FRAME, 1.6);
    for (let i = 1; i <= 12; i++) { fast.receive({ x: i / 12, y: .5, pressure: .8 }, i / 60); fast.frame(i / 60 + .016, FRAME, 1.6); }
    frames(fast, .22, .3); // the finger has arrived; the eased fingertip catches up
    expect(live(fast).length).toBeLessThanOrEqual(TOUCH_WAVE_CAPACITY);
    const wake = live(fast).filter((wave) => wave.big === 0);
    expect(wake.length).toBeGreaterThanOrEqual(3); expect(wake.length).toBeLessThanOrEqual(TOUCH_WAVE_CAPACITY - 6);
    expect(wake.every((wave) => length(wave) <= .4501)).toBe(true); // no segment longer than ~a quarter of the screen width
    // the segments chain end to start: the finger's whole path is covered, left to right
    const ordered = [...wake].sort((a, b) => a.x - b.x);
    for (let i = 1; i < ordered.length; i++) expect(ordered[i]!.x).toBeCloseTo(ordered[i - 1]!.x2, 4);
    expect(ordered[0]!.x).toBeLessThan(.25); // the first two updates can still be the landing spot expect(ordered.at(-1)!.x2).toBeGreaterThan(.9);
  });

  it('does not spawn a wake while the finger hovers, holds still or is lifted', () => {
    const touch = new TouchWater();
    touch.receive({ x: .3, y: .3, pressure: 10 / 127 }, 0);
    for (let i = 1; i <= 30; i++) { touch.receive({ x: .3 + i / 100, y: .3, pressure: 10 / 127 }, i / 60); touch.frame(i / 60, FRAME, 1.6); }
    expect(live(touch)).toEqual([]);
    touch.receive({ x: .6, y: .3, pressure: .8 }, 1); touch.frame(1.016, FRAME, 1.6);
    frames(touch, 1.05, 1.5); // holding still: only the splash and its echo
    expect(live(touch).filter((wave) => wave.big === 0)).toEqual([]);
    expect(live(touch)).toHaveLength(2);
  });

  it('shows a lens that grows toward contact, then one soft ring on lift while the waves fade by themselves', () => {
    const touch = new TouchWater();
    const glows: number[] = [];
    for (const level of [2, 10, 20]) { touch.receive({ x: .5, y: .5, pressure: level / 127 }, 0); frames(touch, 0, .5); glows.push(touch.diagnostics().glow); }
    expect(glows[0]!).toBeLessThan(glows[1]!); expect(glows[1]!).toBeLessThan(glows[2]!);
    expect(touch.diagnostics().phase).toBe('hover'); expect(live(touch)).toEqual([]);
    touch.receive({ x: .5, y: .5, pressure: .8 }, 1); frames(touch, 1, 1.4);
    expect(touch.diagnostics().contact).toBeGreaterThan(.9);
    touch.receive({ x: .5, y: .5, pressure: 0 }, 1.5); frames(touch, 1.5, 1.6);
    expect(live(touch).some((wave) => wave.strength < 0 && Math.round(wave.big * 100) === 35)).toBe(true);
    frames(touch, 1.6, 3.2);
    expect(touch.diagnostics().phase).toBe('lifted');
    expect(touch.diagnostics().glow).toBeLessThan(.02); expect(touch.diagnostics().contact).toBeLessThan(.02);
    frames(touch, 3.2, 8); // everything is older than six seconds: the surface is calm again
    expect(live(touch)).toEqual([]);
  });

  it('adopts a snapshot without a splash, resets cleanly, ignores bad input and fades a hover whose updates stopped', () => {
    const touch = new TouchWater();
    touch.adopt({ x: .7, y: .2, pressure: .9 }, 5); frames(touch, 5, 5.5);
    expect(live(touch)).toEqual([]); expect(touch.diagnostics()).toMatchObject({ phase: 'touching', x: .7, y: .2 });
    frames(touch, 5.5, 5 + TOUCH_STALE_SECONDS + 2); // no CC for longer than the lease: the glow lets go
    expect(touch.diagnostics().glow).toBeLessThan(.02);
    touch.receive({ x: .4, y: .4, pressure: 0 }, 19.9); touch.receive({ x: .4, y: .4, pressure: .9 }, 20); touch.frame(20.02, FRAME, 1.6);
    expect(live(touch).length).toBe(2); // the lift ring of the adopted finger, and the new splash
    touch.reset(); expect([...touch.waves].every((value) => value === 0)).toBe(true);
    expect(touch.diagnostics()).toMatchObject({ phase: 'lifted', glow: 0 });
    touch.receive({ x: NaN, y: .4, pressure: .9 }, 1); expect(touch.diagnostics().phase).toBe('lifted');
  });
});
