import { describe, expect, it } from 'vitest';
import { WaterAudioGesture } from './water-audio.js';

describe('water feedback follows the live fingertip', () => {
  it('splashes only on contact edges, follows movement, and quiets on lift', () => {
    const gesture = new WaterAudioGesture();
    expect(gesture.sample({ x: .2, y: .5, pressure: 10 / 127 }, 0)).toMatchObject({ phase: 'hover', splash: 0, wake: 0, hover: .5 });
    expect(gesture.sample({ x: .2, y: .5, pressure: .8 }, .05).splash).toBeGreaterThan(0);
    expect(gesture.sample({ x: .2, y: .5, pressure: .8 }, .1)).toMatchObject({ splash: 0, wake: 0 });
    const moved = gesture.sample({ x: .8, y: .2, pressure: .8 }, .15);
    expect(moved).toMatchObject({ splash: 0, pitch: .8 }); expect(moved.pan).toBeCloseTo(.6); expect(moved.wake).toBeGreaterThan(0);
    expect(gesture.sample({ x: .8, y: .2, pressure: 0 }, .2)).toMatchObject({ phase: 'lifted', splash: 0, wake: 0, hover: 0 });
  });
  it('never turns a restored snapshot into a splash or movement sound', () => {
    const gesture = new WaterAudioGesture();
    expect(gesture.sample({ x: .5, y: .5, pressure: .9 }, 10, false)).toMatchObject({ splash: 0, wake: 0, hover: 0 });
    expect(gesture.sample({ x: .5, y: .5, pressure: .9 }, 10.1)).toMatchObject({ splash: 0, wake: 0 });
    gesture.reset();
    expect(gesture.sample({ x: .5, y: .5, pressure: .9 }, 20).splash).toBeGreaterThan(0);
  });
});
