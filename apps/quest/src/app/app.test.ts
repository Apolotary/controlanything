import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlSender, type ControlEventPayload } from './controls';
import { PinchDetector } from './input';

describe('PinchDetector (hysteresis 2.0 / 3.5 cm, two frames)', () => {
  it('needs two frames under 2 cm to start and two over 3.5 cm to end', () => {
    const p = new PinchDetector();
    expect(p.update(0.015).pinching).toBe(false);
    const on = p.update(0.015);
    expect(on).toMatchObject({ pinching: true, justStarted: true });
    expect(p.update(0.03).pinching).toBe(true); // inside the band: stays on
    expect(p.update(0.04).pinching).toBe(true);
    const off = p.update(0.04);
    expect(off).toMatchObject({ pinching: false, justEnded: true });
  });

  it('a select button forces the state at once', () => {
    const p = new PinchDetector();
    expect(p.update(null, true)).toMatchObject({ pinching: true, justStarted: true });
    expect(p.update(null, false)).toMatchObject({ pinching: false, justEnded: true });
  });
});

describe('ControlSender (≤ 30 Hz per control, latest wins)', () => {
  afterEach(() => vi.useRealTimers());

  it('drops queued moves when controls are closed or cancelled', () => {
    vi.useFakeTimers();
    const sent: ControlEventPayload[] = [];
    const sender = new ControlSender((event) => sent.push(event), 30, () => 0);
    sender.push({ specId: 'light', controlId: 'level', value: 10, phase: 'start', ts: 0 });
    sender.push({ specId: 'light', controlId: 'level', value: 80, phase: 'move', ts: 0 });
    sender.clear();
    vi.runAllTimers();
    expect(sent.map((event) => event.value)).toEqual([10]);
  });

  it('throttles moves, sends start/end at once, keeps the last value', () => {
    vi.useFakeTimers();
    let now = 0;
    const sent: ControlEventPayload[] = [];
    const s = new ControlSender((p) => sent.push(p), 30, () => now);
    const ev = (value: number, phase: 'start' | 'move' | 'end') => ({ controlId: 'cutoff', value, phase, ts: now, specId: 'spec1' });
    s.push(ev(0, 'start'));
    s.push(ev(1, 'move'));
    now = 5;
    s.push(ev(2, 'move'));
    now = 10;
    s.push(ev(3, 'move'));
    // the start just went out, so the moves wait for the 33 ms slot and only the latest survives
    expect(sent.map((p) => p.value)).toEqual([0]);
    now = 40;
    vi.advanceTimersByTime(40);
    expect(sent.map((p) => p.value)).toEqual([0, 3]);
    now = 100;
    s.push(ev(4, 'move'));
    expect(sent.map((p) => p.value)).toEqual([0, 3, 4]);
    s.push(ev(9, 'end'));
    expect(sent.at(-1)).toMatchObject({ widgetId: 'cutoff', value: 9, phase: 'end', specId: 'spec1' });
  });
});
