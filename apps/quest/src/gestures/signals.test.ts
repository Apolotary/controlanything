import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { makeGestureFrame, makeGestureHand, moveHand, setPosture } from './fixtures.test-support';
import { planeFromCorners, type ScreenPlane } from './screen-plane';
import { ScreenCalibrator } from './screen-calibration';
import { SIGNAL_RANGE, SignalTracker } from './signals';

const headY = 1.6;
const plane = (): ScreenPlane => {
  // a monitor 0.6 m in front of the head at z = -0.6: 0.5 m wide, 0.3 m tall, top edge at eye level
  const r = planeFromCorners(new Vector3(-0.25, 1.6, -0.6), new Vector3(0.25, 1.3, -0.6), new Vector3(0, headY, 0), new Vector3(0, 1.45, -0.6));
  if ('error' in r) throw new Error(r.error);
  return r.plane;
};
/** A frame with the right index fingertip at `tip` and no left hand. */
function fingerFrame(tip: Vector3, time = 0) {
  const frame = makeGestureFrame('open_palm', 'point');
  delete frame.hands.left;
  const hand = frame.hands.right!;
  moveHand(hand, tip.x, tip.y, tip.z + 0.14); // the fixture's fingertip is 0.14 m ahead of the wrist along -z
  frame.time = time;
  return frame;
}

describe('hand signals', () => {
  it('are null for a hand that is not tracked, and range 0..1 with the arm', () => {
    const tracker = new SignalTracker(); tracker.reset(0);
    const frame = makeGestureFrame('open_palm', 'open_palm');
    delete frame.hands.left;
    let s = tracker.update(frame, 0).signals;
    expect(s.left).toBeNull(); expect(s.right).not.toBeNull(); expect(s.screen).toBeNull();
    // low and close vs high and extended
    moveHand(frame.hands.right!, 0, headY - 0.6, -0.1);
    for (let i = 1; i <= 40; i++) s = tracker.update(frame, i * 16).signals;
    expect(s.right!.height).toBeLessThan(0.05); expect(s.right!.push).toBeLessThan(0.1);
    moveHand(frame.hands.right!, 0.3, headY + 0.3, -0.7);
    for (let i = 41; i <= 120; i++) s = tracker.update(frame, i * 16).signals;
    expect(s.right!.height).toBeGreaterThan(0.95); expect(s.right!.push).toBeGreaterThan(0.95); expect(s.right!.side).toBeGreaterThan(0.85);
    expect(s.t).toBeCloseTo(120 * 0.016, 2);
  });

  it('reads postures, pinch closeness and the pinch-tap pulse', () => {
    const tracker = new SignalTracker(); tracker.reset(0);
    const frame = makeGestureFrame('fist', 'open_palm');
    let s = tracker.update(frame, 0).signals;
    for (let t = 16; t <= 160; t += 16) s = tracker.update(frame, t).signals;
    expect(s.left!.fist).toBe(true); expect(s.right!.open).toBe(true); expect(s.right!.fist).toBe(false); expect(s.right!.pinch).toBeLessThan(0.3);
    // a quick pinch and release without moving: exactly one frame of pinchTap
    const right = frame.hands.right!;
    setPosture(right, 'pinch'); right.pinching = true;
    let taps = 0, maxPinch = 0, t = 176;
    for (; t <= 176 + 112; t += 16) { s = tracker.update(frame, t).signals; maxPinch = Math.max(maxPinch, s.right!.pinch); taps += s.right!.pinchTap ? 1 : 0; }
    setPosture(right, 'open_palm'); right.pinching = false;
    for (let k = 0; k < 6; k++, t += 16) { s = tracker.update(frame, t).signals; taps += s.right!.pinchTap ? 1 : 0; }
    expect(maxPinch).toBeGreaterThan(0.8); expect(taps).toBe(1);
    // a held pinch (longer than 350 ms) is not a tap
    setPosture(right, 'pinch'); right.pinching = true;
    for (let k = 0; k < 40; k++, t += 16) taps += tracker.update(frame, t).signals.right!.pinchTap ? 1 : 0;
    setPosture(right, 'open_palm'); right.pinching = false;
    for (let k = 0; k < 6; k++, t += 16) taps += tracker.update(frame, t).signals.right!.pinchTap ? 1 : 0;
    expect(taps).toBe(1);
    // and a pinch that starts on UI is a press, not a tap
    setPosture(right, 'pinch'); right.pinching = true;
    for (let k = 0; k < 4; k++, t += 16) tracker.update(frame, t, { tapBlocked: () => true });
    setPosture(right, 'open_palm'); right.pinching = false;
    for (let k = 0; k < 6; k++, t += 16) taps += tracker.update(frame, t, { tapBlocked: () => true }).signals.right!.pinchTap ? 1 : 0;
    expect(taps).toBe(1);
  });

  it('both palms out for 120 ms is one stop pulse', () => {
    const tracker = new SignalTracker(); tracker.reset(0);
    const frame = makeGestureFrame('open_palm', 'open_palm');
    const out = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2); // palm faces away from the head
    for (const hand of [frame.hands.left!, frame.hands.right!]) {
      moveHand(hand, hand === frame.hands.left ? -0.2 : 0.2, headY - 0.1, -0.45);
      for (const joint of Object.values(hand.joints)) joint!.quaternion.copy(out);
    }
    const pulses: number[] = [];
    for (let t = 0; t <= 400; t += 16) { const f = tracker.update(frame, t); if (f.stop) pulses.push(t); expect(f.signals.right?.palmOut ?? false).toBe(t >= 0 && f.signals.right!.palmOut); }
    expect(pulses).toHaveLength(1);
    expect(pulses[0]).toBeGreaterThanOrEqual(SIGNAL_RANGE.stopMs);
    expect(tracker.update(frame, 420).stop).toBe(false);
  });
});

describe('screen touch', () => {
  it('reports u, v, distance, hover and touching for the fingertip nearest the plane', () => {
    const tracker = new SignalTracker(); tracker.reset(0);
    const p = plane();
    let clock = 0;
    const run = (tip: Vector3, frames = 30) => { let s = null; for (let i = 0; i < frames; i++, clock += 16) s = tracker.update(fingerFrame(tip, clock), clock, { plane: p }).signals.screen; return s!; };
    // 10 cm in front of the middle of the screen
    let s = run(new Vector3(0, 1.45, -0.5));
    expect(s.hand).toBe('right'); expect(s.inside).toBe(true); expect(s.touching).toBe(false);
    expect(s.u).toBeCloseTo(0.5, 1); expect(s.v).toBeCloseTo(0.5, 1); expect(s.distance).toBeCloseTo(0.1, 1);
    expect(s.hover).toBeGreaterThan(0.2); expect(s.hover).toBeLessThan(0.7);
    // on the glass near the top-left corner
    s = run(new Vector3(-0.2, 1.55, -0.595), 40);
    expect(s.touching).toBe(true); expect(s.hover).toBe(1); expect(s.u).toBeCloseTo(0.1, 1); expect(s.v).toBeCloseTo(0.17, 1);
    // 2.5 cm away keeps touching (hysteresis), 4 cm releases it
    s = run(new Vector3(-0.2, 1.55, -0.575), 20); expect(s.touching).toBe(true);
    s = run(new Vector3(-0.2, 1.55, -0.55), 30); expect(s.touching).toBe(false); expect(s.hover).toBeGreaterThan(0);
    // moving right: positive vu
    let last = s;
    for (let i = 0; i < 12; i++, clock += 16) last = tracker.update(fingerFrame(new Vector3(-0.2 + i * 0.02, 1.55, -0.595), clock), clock, { plane: p }).signals.screen!;
    expect(last.vu).toBeGreaterThan(0.2); expect(Math.abs(last.vv)).toBeLessThan(0.2);
  });

  it('is null without a plane or without a tracked finger, and outside the plane it is not touching', () => {
    const tracker = new SignalTracker(); tracker.reset(0);
    const p = plane();
    expect(tracker.update(fingerFrame(new Vector3(0, 1.45, -0.59)), 0).signals.screen).toBeNull();
    const none = makeGestureFrame(); delete none.hands.left; delete none.hands.right;
    expect(tracker.update(none, 16, { plane: p }).signals.screen).toBeNull();
    const s = tracker.update(fingerFrame(new Vector3(0.9, 1.45, -0.595), 32), 32, { plane: p }).signals.screen!;
    expect(s.inside).toBe(false); expect(s.touching).toBe(false); expect(s.hover).toBe(0);
    // a fingertip well behind the glass is ignored
    expect(tracker.update(fingerFrame(new Vector3(0, 1.45, -0.8), 48), 48, { plane: p }).signals.screen).toBeNull();
  });

  it('ignores the hand when it is the controller and picks the nearer of two fingers', () => {
    const tracker = new SignalTracker(); tracker.reset(0);
    const p = plane();
    const frame = fingerFrame(new Vector3(0, 1.45, -0.4));
    frame.hands.left = makeGestureHand('point'); moveHand(frame.hands.left, -0.1, 1.45, -0.45 + 0.14);
    let s = tracker.update(frame, 0, { plane: p }).signals.screen;
    for (let i = 1; i < 20; i++) s = tracker.update(frame, i * 16, { plane: p }).signals.screen;
    expect(s!.hand).toBe('left');
    frame.hands.right!.controller = true; frame.hands.left.controller = true;
    expect(tracker.update(frame, 400, { plane: p }).signals.screen).toBeNull();
  });
});

describe('two-corner calibration', () => {
  const anchor = new Vector3(0, 1.45, -0.6);
  it('captures a corner after the fingertip is held still ~0.4 s and finishes with a plane', () => {
    const cal = new ScreenCalibrator();
    let t = 0; const events: string[] = [];
    const hold = (tip: Vector3, ms: number) => {
      for (const end = t + ms; t < end; t += 16) {
        const e = cal.update(fingerFrame(tip, t), t, anchor);
        if (e.kind !== 'progress') events.push(e.kind === 'corner' ? `corner:${e.step}` : e.kind === 'done' ? 'done' : `rejected:${e.message}`);
      }
    };
    // a fingertip waving about never completes
    for (let i = 0; i < 30; i++) { t += 16; cal.update(fingerFrame(new Vector3(-0.25 + (i % 2) * 0.1, 1.62, -0.6), t), t, anchor); }
    expect(cal.progress).toBeLessThan(0.3);
    hold(new Vector3(-0.25, 1.62, -0.6), 600);
    expect(events).toEqual(['corner:top-left']);
    expect(cal.step).toBe('bottom-right');
    // still at the first corner: nothing yet
    hold(new Vector3(-0.25, 1.62, -0.6), 600);
    expect(events).toEqual(['corner:top-left']);
    hold(new Vector3(0.25, 1.3, -0.6), 600);
    expect(events).toEqual(['corner:top-left', 'done']);
  });

  it('ignores a hand that was already resting there when the prompt came up until it moves', () => {
    const cal = new ScreenCalibrator();
    let t = 0;
    for (; t < 1500; t += 16) cal.update(fingerFrame(new Vector3(-0.25, 1.62, -0.6), t), t, anchor);
    expect(cal.step).toBe('top-left');
    for (let i = 0; i < 6; i++) { t += 16; cal.update(fingerFrame(new Vector3(-0.25 + i * 0.015, 1.62, -0.6), t), t, anchor); }
    const events: string[] = [];
    for (const end = t + 600; t < end; t += 16) { const e = cal.update(fingerFrame(new Vector3(-0.25, 1.62, -0.6), t), t, anchor); if (e.kind === 'corner') events.push(e.step); }
    expect(events).toEqual(['top-left']);
  });

  it('refuses a fingertip far from the device or low on it for the top-left corner', () => {
    const cal = new ScreenCalibrator();
    let t = 0;
    for (; t < 1200; t += 16) cal.update(fingerFrame(new Vector3(-0.25, 0.9, -0.4), t), t, anchor); // at the keyboard
    expect(cal.step).toBe('top-left'); expect(cal.progress).toBe(0);
    for (; t < 2400; t += 16) cal.update(fingerFrame(new Vector3(-2, 1.62, -0.6), t), t, anchor);
    expect(cal.step).toBe('top-left');
  });
});
