import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import type { GestureAxis, GestureMap } from '@ce/protocol';
import { OneEuroScalar } from '../app/precision';
import { GestureEngine } from './engine';
import { makeGestureFrame, makeGestureHand, moveHand, setPosture } from './fixtures.test-support';
import { applyCurve, applyDeadzone, inverseCurve, mapAxisValue } from './mapping';
import { PostureDetector } from './posture';
import type { HandPosture } from './posture';

function makeMap(axis: GestureAxis = 'right_height'): GestureMap {
  return {
    version: 1, clutchPosture: 'L_FIST', panicPosture: 'BOTH_PALMS_OUT', postures: [],
    axes: [{ axis, actionId: 'warp', label: 'Warp', outMin: 0, outMax: 100, curve: 'linear', deadzone: 0,
      smoothingMinCutoff: 20, smoothingBeta: 10, quantizeStep: 1, maxRateHz: 30 }],
  };
}

it('distinguishes lost tracking from a released clutch and accepts a tracked controller without a left hand', () => {
  const engine = new GestureEngine(makeMap(), () => {}), frame = makeGestureFrame();
  engine.update(frame, 0); expect(engine.update(frame, 80)).toMatchObject({ engaged: true, trackingLost: false });
  setPosture(frame.hands.left!, 'point'); expect(engine.update(frame, 100)).toMatchObject({ engaged: false, trackingLost: false });
  const right = frame.hands.right!; delete frame.hands.right;
  expect(engine.update(frame, 120)).toMatchObject({ engaged: false, trackingLost: true });
  frame.hands.right = right; expect(engine.update(frame, 140)).toMatchObject({ engaged: false, trackingLost: false });
  delete frame.hands.left; expect(engine.update(frame, 160)).toMatchObject({ engaged: false, trackingLost: true });
  right.controller = true;
  expect(engine.update(frame, 180, true)).toMatchObject({ engaged: true, trackingLost: false });
});

it('reports missing joints needed by the active map even when the wrist remains tracked', () => {
  const frame = makeGestureFrame(), engine = new GestureEngine(makeMap('right_pinch_aperture'), () => {});
  engine.update(frame, 0); expect(engine.update(frame, 80).trackingLost).toBe(false);
  const thumb = frame.hands.right!.joints['thumb-tip']; delete frame.hands.right!.joints['thumb-tip'];
  expect(engine.update(frame, 100).trackingLost).toBe(true);
  frame.hands.right!.joints['thumb-tip'] = thumb;
  expect(engine.update(frame, 120).trackingLost).toBe(false);
  const span = new GestureEngine(makeMap('two_hand_distance'), () => {});
  frame.hands.right!.controller = true; delete frame.hands.left;
  expect(span.update(frame, 140, true).trackingLost).toBe(true);
  frame.hands.left = makeGestureHand();
  expect(span.update(frame, 160, true).trackingLost).toBe(false);
});

describe('joint posture vocabulary', () => {
  it.each<HandPosture>(['fist', 'open_palm', 'point', 'pinch'])('detects %s at different hand scales after dwell', (posture) => {
    for (const scale of [0.7, 1, 1.3]) {
      const detector = new PostureDetector(), hand = makeGestureHand(posture, scale);
      expect(detector.update(hand, 0)).toBe('unknown');
      expect(detector.update(hand, 100)).toBe(posture);
    }
  });

  it('requires continuous dwell and uses hysteresis to hold a fist near its boundary', () => {
    const detector = new PostureDetector(), hand = makeGestureHand('fist');
    detector.update(hand, 0);
    expect(detector.update(hand, 44)).toBe('unknown');
    expect(detector.update(hand, 45)).toBe('fist');
    hand.joints['index-finger-tip']!.position.z = -0.07 * 1.3;
    expect(detector.update(hand, 56)).toBe('fist');
    hand.joints['index-finger-tip']!.position.z = -0.07 * 1.39;
    expect(detector.update(hand, 67)).toBe('unknown');
    setPosture(hand, 'fist');
    expect(detector.update(hand, 78)).toBe('unknown');
    expect(detector.update(hand, 122)).toBe('unknown');
    expect(detector.update(hand, 123)).toBe('fist');
  });

  it('does not mistake a curled thumb and index for a pinch', () => {
    const detector = new PostureDetector(), hand = makeGestureHand('fist');
    hand.joints['thumb-tip']!.position.copy(hand.joints['index-finger-tip']!.position);
    detector.update(hand, 0);
    expect(detector.update(hand, 100)).toBe('fist');
  });

  it('holds a pinch in its release band and requires a new dwell after missing joints', () => {
    const detector = new PostureDetector(), hand = makeGestureHand('pinch');
    detector.update(hand, 0);
    expect(detector.update(hand, 22)).toBe('pinch');
    hand.joints['thumb-tip']!.position.x = 0.03;
    expect(detector.update(hand, 33)).toBe('pinch');
    delete hand.joints['pinky-finger-tip'];
    expect(detector.update(hand, 44)).toBe('unknown');
    setPosture(hand, 'pinch');
    expect(detector.update(hand, 55)).toBe('unknown');
    expect(detector.update(hand, 77)).toBe('pinch');
  });

  it('rejects controllers, invalid joint samples, and stale dwell', () => {
    const detector = new PostureDetector(), hand = makeGestureHand('fist');
    detector.update(hand, 0);
    expect(detector.update(hand, 200)).toBe('unknown');
    hand.joints['index-finger-tip']!.position.x = NaN;
    expect(detector.update(hand, 250)).toBe('unknown');
    expect(detector.tracked).toBe(false);
    setPosture(hand, 'fist');
    hand.controller = true;
    expect(detector.update(hand, 300)).toBe('unknown');
  });
});

describe('mapping and adaptive smoothing', () => {
  it.each(['linear', 'exp', 'log', 's-curve'] as const)('%s preserves endpoints and inverts for relative pickup', (curve) => {
    expect(applyCurve(-1, curve)).toBe(0);
    expect(applyCurve(2, curve)).toBe(1);
    for (const value of [0, 0.1, 0.25, 0.5, 0.9, 1]) expect(inverseCurve(applyCurve(value, curve), curve)).toBeCloseTo(value, 10);
  });

  it('quantizes relative to the minimum, clamps, and leaves a center dead zone', () => {
    const binding = { ...makeMap().axes[0]!, outMin: 10, outMax: 90, quantizeStep: 10 };
    expect(mapAxisValue(0.14, binding)).toBe(20);
    expect(mapAxisValue(-1, binding)).toBe(10);
    expect(mapAxisValue(2, binding)).toBe(90);
    expect(applyDeadzone(0.04, 0.05)).toBe(0);
    expect(applyDeadzone(-0.04, 0.05)).toBe(-0);
    expect(applyDeadzone(0.525, 0.05)).toBeCloseTo(0.5);
    expect(applyDeadzone(-0.525, 0.05)).toBeCloseTo(-0.5);
  });

  it('suppresses stationary jitter but follows a deliberate sweep and resets on gaps', () => {
    const filter = new OneEuroScalar();
    expect(filter.update(0, 0)).toBe(0);
    let largest = 0;
    for (let index = 1; index <= 90; index++) largest = Math.max(largest, Math.abs(filter.update(index % 2 ? 0.01 : -0.01, index * 1000 / 90)));
    expect(largest).toBeLessThan(0.002);
    for (let index = 1; index <= 90; index++) filter.update(1, 1000 + index * 1000 / 90);
    expect(filter.update(1, 2010)).toBeCloseTo(1, 3);
    expect(filter.update(0.25, 2500)).toBe(0.25);
    filter.reset();
    expect(filter.update(0.8, 2510)).toBe(0.8);
  });
});

describe('gesture clutch and device events', () => {
  it('engages after dwell, maps motion, and freezes immediately on opening the left hand', () => {
    const events: number[] = [], frame = makeGestureFrame();
    const engine = new GestureEngine(makeMap(), (_action, value) => events.push(value as number));
    const state = engine.update(frame, 0);
    expect(state.engaged).toBe(false);
    expect(engine.update(frame, 44).engaged).toBe(false);
    expect(engine.update(frame, 45)).toBe(state);
    expect(state.engaged).toBe(true);
    expect(events).toEqual([]);
    moveHand(frame.hands.right!, 0.2, 1.45, -0.4);
    engine.update(frame, 80);
    expect(events.at(-1)).toBeGreaterThan(70);
    const frozen = events.at(-1)!;
    setPosture(frame.hands.left!, 'open_palm');
    moveHand(frame.hands.right!, 0.2, 1.6, -0.4);
    expect(engine.update(frame, 81).engaged).toBe(false);
    for (let time = 100; time <= 500; time += 20) engine.update(frame, time);
    expect(events).toHaveLength(1);
    expect(state.axes[0]!.value).toBe(frozen);
  });

  it('holds values across a ratchet and never jumps when an exponential mapping reengages', () => {
    const map = makeMap(), frame = makeGestureFrame(), values: number[] = [];
    map.axes[0]!.curve = 'exp';
    const engine = new GestureEngine(map, (_action, value) => values.push(value as number), new Map([['warp', 70]]));
    engine.update(frame, 0); engine.update(frame, 50);
    expect(values).toEqual([]);
    moveHand(frame.hands.right!, 0.2, 1.35, -0.4);
    engine.update(frame, 90);
    const before = values.at(-1)!;
    setPosture(frame.hands.left!, 'open_palm');
    engine.update(frame, 100);
    moveHand(frame.hands.right!, 0.2, 1.1, -0.4);
    setPosture(frame.hands.left!, 'fist');
    engine.update(frame, 110); engine.update(frame, 160);
    expect(values).toHaveLength(1);
    expect(engine.state.axes[0]!.value).toBe(before);
    moveHand(frame.hands.right!, 0.2, 1.12, -0.4);
    engine.update(frame, 200);
    expect(values.at(-1)).toBeGreaterThan(before);
  });

  it('stops sending immediately when either clutch joints or the right wrist disappear', () => {
    const values: number[] = [], frame = makeGestureFrame();
    const engine = new GestureEngine(makeMap(), (_action, value) => values.push(value as number));
    engine.update(frame, 0); engine.update(frame, 50);
    delete frame.hands.left!.joints['thumb-tip'];
    moveHand(frame.hands.right!, 0.2, 1.5, -0.4);
    expect(engine.update(frame, 60).engaged).toBe(false);
    expect(values).toEqual([]);
    setPosture(frame.hands.left!, 'fist');
    engine.update(frame, 70); engine.update(frame, 120);
    expect(engine.state.engaged).toBe(true);
    delete frame.hands.right!.joints.wrist;
    expect(engine.update(frame, 130).engaged).toBe(false);
    expect(values).toEqual([]);
  });

  it('enforces at most 30 Hz per axis and emits only changed quantized values', () => {
    const times: number[] = [], frame = makeGestureFrame();
    let now = 0;
    const engine = new GestureEngine(makeMap(), () => times.push(now));
    engine.update(frame, 0); engine.update(frame, 50);
    for (now = 60; now < 1060; now += 10) {
      moveHand(frame.hands.right!, 0.2, 1.3 + (now - 50) / 3000, -0.4);
      engine.update(frame, now);
    }
    expect(times.length).toBeGreaterThan(10);
    expect(times.length).toBeLessThanOrEqual(30);
    for (let index = 1; index < times.length; index++) expect(times[index]! - times[index - 1]!).toBeGreaterThanOrEqual(1000 / 30);
    for (now = 1060; now < 2060; now += 10) engine.update(frame, now);
    const count = times.length;
    for (now = 2060; now < 3060; now += 10) engine.update(frame, now);
    expect(times).toHaveLength(count);
  });

  it('respects slower device rates and keeps a quantization boundary from chattering', () => {
    const map = makeMap(), values: number[] = [], frame = makeGestureFrame();
    map.axes[0]!.maxRateHz = 2;
    map.axes[0]!.quantizeStep = 10;
    const engine = new GestureEngine(map, (_action, value) => values.push(value as number));
    engine.update(frame, 0); engine.update(frame, 50);
    for (let time = 60; time < 400; time += 10) {
      moveHand(frame.hands.right!, 0.2, 1.3 + 0.45 * (time % 20 ? 0.049 : 0.051), -0.4);
      engine.update(frame, time);
    }
    expect(values).toEqual([]);
    moveHand(frame.hands.right!, 0.2, 1.4, -0.4);
    engine.update(frame, 410);
    expect(values).toHaveLength(1);
    moveHand(frame.hands.right!, 0.2, 1.5, -0.4);
    for (let time = 420; time < 910; time += 10) engine.update(frame, time);
    expect(values).toHaveLength(1);
    engine.update(frame, 910);
    expect(values).toHaveLength(2);
  });

  it('maps wrist roll, aperture, and two-hand span without fixed device command numbers', () => {
    for (const axis of ['right_roll', 'right_pinch_aperture', 'two_hand_distance'] as const) {
      const values: number[] = [], frame = makeGestureFrame();
      const engine = new GestureEngine(makeMap(axis), (action, value, phase, source) => {
        expect(action).toBe('warp'); expect(phase).toBe('move'); expect(source).toBe(axis); values.push(value as number);
      });
      engine.update(frame, 0); engine.update(frame, 50);
      if (axis === 'right_roll') frame.hands.right!.joints.wrist!.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 4);
      if (axis === 'right_pinch_aperture') frame.hands.right!.joints['thumb-tip']!.position.x -= 0.03;
      if (axis === 'two_hand_distance') moveHand(frame.hands.right!, 0.35, 1.3, -0.4);
      engine.update(frame, 90);
      expect(values.at(-1)).toBeGreaterThan(60);
    }
  });

  it('unwraps wrist roll through quaternion angle wrap', () => {
    const frame = makeGestureFrame(), map = makeMap('right_roll');
    const engine = new GestureEngine(map, () => {});
    frame.hands.right!.joints.wrist!.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), Math.PI * 0.98);
    engine.update(frame, 0); engine.update(frame, 50);
    frame.hands.right!.joints.wrist!.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), -Math.PI * 0.98);
    engine.update(frame, 90);
    expect(engine.state.axes[0]!.value).toBeGreaterThan(50);
    expect(engine.state.axes[0]!.value).toBeLessThan(65);
  });

  it('takes a fresh aperture reference after finger occlusion without changing height pickup', () => {
    const frame = makeGestureFrame(), map = makeMap('right_pinch_aperture'), values: number[] = [];
    const engine = new GestureEngine(map, (_action, value) => values.push(value as number));
    engine.update(frame, 0); engine.update(frame, 50);
    delete frame.hands.right!.joints['thumb-tip'];
    engine.update(frame, 80);
    setPosture(frame.hands.right!, 'pinch');
    engine.update(frame, 110);
    expect(values).toEqual([]);
    expect(engine.state.engaged).toBe(true);
  });

  it('requires a new right posture after engage and emits a discrete command once', () => {
    const frame = makeGestureFrame(), map = makeMap(), events: (number | boolean)[] = [];
    map.axes = [];
    map.postures = [
      { posture: 'R_OPEN_PALM', actionId: 'off', label: 'Off', mode: 'press', maxRateHz: 2 },
      { posture: 'R_PINCH', actionId: 'on', label: 'On', mode: 'press', value: true, maxRateHz: 2 },
    ];
    const engine = new GestureEngine(map, (_action, value) => events.push(value));
    engine.update(frame, 0); engine.update(frame, 50); engine.update(frame, 80);
    expect(events).toEqual([]);
    setPosture(frame.hands.right!, 'pinch');
    engine.update(frame, 90); engine.update(frame, 112); engine.update(frame, 150);
    expect(events).toEqual([true]);
    setPosture(frame.hands.left!, 'open_palm');
    setPosture(frame.hands.right!, 'open_palm');
    engine.update(frame, 160); engine.update(frame, 220);
    expect(events).toEqual([true]);
  });

  it('requires outward palms for Stop, dwells once, and stays inhibited until reset', () => {
    const frame = makeGestureFrame('open_palm', 'open_palm'), engine = new GestureEngine(makeMap(), () => {});
    engine.update(frame, 0); engine.update(frame, 120);
    expect(engine.state.stopped).toBe(false);
    for (const hand of [frame.hands.left!, frame.hands.right!]) hand.joints.wrist!.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
    engine.update(frame, 130);
    expect(engine.update(frame, 249).stopped).toBe(false);
    expect(engine.update(frame, 250).stopped).toBe(true);
    expect(engine.update(frame, 260).stopped).toBe(false);
    setPosture(frame.hands.left!, 'fist');
    engine.update(frame, 270); engine.update(frame, 320);
    expect(engine.state.engaged).toBe(false);
    engine.reset();
    engine.update(frame, 330); engine.update(frame, 380);
    expect(engine.state.engaged).toBe(true);
  });

  it('does not count missing animation frames toward the Stop dwell', () => {
    const frame = makeGestureFrame('open_palm', 'open_palm'), engine = new GestureEngine(makeMap(), () => {});
    for (const hand of [frame.hands.left!, frame.hands.right!]) hand.joints.wrist!.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
    engine.update(frame, 0);
    expect(engine.update(frame, 200).stopped).toBe(false);
    expect(engine.update(frame, 310).stopped).toBe(false);
    expect(engine.update(frame, 320).stopped).toBe(true);
  });

  it('uses the Perform toggle for controllers, with grip and ray fallback and immediate release', () => {
    for (const withGrip of [true, false]) {
      const frame = makeGestureFrame(), values: number[] = [];
      const right = frame.hands.right!;
      right.controller = true; right.joints = {};
      right.ray.origin.set(0.2, 1.3, -0.4);
      if (withGrip) right.grip = { position: right.ray.origin.clone(), quaternion: new Quaternion() };
      delete frame.hands.left;
      const engine = new GestureEngine(makeMap(), (_action, value) => values.push(value as number));
      expect(engine.update(frame, 0, false).engaged).toBe(false);
      expect(engine.update(frame, 10, true).engaged).toBe(true);
      moveHand(right, 0.2, 1.5, -0.4);
      engine.update(frame, 50, true);
      expect(values.at(-1)).toBeGreaterThan(80);
      expect(engine.update(frame, 60, false).engaged).toBe(false);
      expect(values).toHaveLength(1);
    }
  });

  it('the controller toggle never bypasses the clutch for a bare hand', () => {
    const engine = new GestureEngine(makeMap(), () => {}), frame = makeGestureFrame('open_palm');
    expect(engine.update(frame, 0, true).engaged).toBe(false);
    expect(engine.update(frame, 100, true).engaged).toBe(false);
  });

  it('reuses state and axis objects on every animation frame', () => {
    const engine = new GestureEngine(makeMap(), () => {}), frame = makeGestureFrame();
    const first = engine.update(frame, 0), axes = first.axes, axis = axes[0];
    for (let time = 10; time < 500; time += 10) {
      expect(engine.update(frame, time)).toBe(first);
      expect(engine.state.axes).toBe(axes);
      expect(engine.state.axes[0]).toBe(axis);
    }
  });
});


describe('calibrated forward/back hand input', () => {
  it('responds to push/pull, not hand height or a head turn', () => {
    const events: number[] = [], frame = makeGestureFrame();
    const engine = new GestureEngine(makeMap('right_depth'), (_action, value) => events.push(value as number));
    engine.update(frame, 0); engine.update(frame, 80); expect(events).toEqual([]);
    moveHand(frame.hands.right!, .2, 1.6, -.4); engine.update(frame, 120); expect(events).toEqual([]);
    frame.head.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    engine.update(frame, 160); expect(events).toEqual([]);
    moveHand(frame.hands.right!, .2, 1.6, -.56); engine.update(frame, 200);
    expect(events.at(-1)).toBeGreaterThan(75);
    moveHand(frame.hands.right!, .2, 1.6, -.30); engine.update(frame, 240);
    expect(events.at(-1)).toBeLessThan(45);
    setPosture(frame.hands.left!, 'point'); const count = events.length;
    moveHand(frame.hands.right!, .2, 1.6, -.7); engine.update(frame, 280); expect(events).toHaveLength(count);
  });
  it('calibrates heading at clutch pickup and cancels shared head/hand translation', () => {
    const events: number[] = [], frame = makeGestureFrame();
    frame.head.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    const engine = new GestureEngine(makeMap('right_depth'), (_action, value) => events.push(value as number));
    engine.update(frame, 0); engine.update(frame, 80);
    frame.head.position.x += .25; moveHand(frame.hands.right!, .45, 1.3, -.4); engine.update(frame, 120);
    expect(events).toEqual([]);
    moveHand(frame.hands.right!, .30, 1.3, -.4); engine.update(frame, 160);
    expect(events.at(-1)).toBeGreaterThan(70);
  });
  it('freezes lost samples and reacquires without jumping, then clamps travel to the action range', () => {
    const events: number[] = [], frame = makeGestureFrame();
    const engine = new GestureEngine(makeMap('right_depth'), (_action, value) => events.push(value as number));
    engine.update(frame, 0); engine.update(frame, 80);
    frame.head.position.x = NaN; moveHand(frame.hands.right!, .2, 1.3, -.9);
    expect(engine.update(frame, 120).trackingLost).toBe(true); expect(events).toEqual([]);
    frame.head.position.x = 0; engine.update(frame, 160); expect(events).toEqual([]);
    moveHand(frame.hands.right!, .2, 1.3, -4);
    for (const time of [200, 240, 280, 320]) engine.update(frame, time);
    expect(events.at(-1)).toBe(100); expect(events.every(value => value >= 0 && value <= 100)).toBe(true);
    const count = events.length; delete frame.hands.right; engine.update(frame, 360); expect(events).toHaveLength(count);
  });
});
