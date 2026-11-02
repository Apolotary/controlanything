import { describe, expect, it, vi } from 'vitest';
import { GestureMap, parseMessage, type ControlEventPayload, type UiSpecPayload } from '@ce/protocol';
import { emptySpec } from '@ce/gen3d';
import { GestureSession } from './session';
import { makeGestureFrame, moveHand, setPosture } from './fixtures.test-support';

const map = GestureMap.parse({ version: 1, clutchPosture: 'L_FIST', panicPosture: 'BOTH_PALMS_OUT', axes: [{
  axis: 'right_height', actionId: 'visual-warp', label: 'Warp', outMin: 0, outMax: 127, curve: 'linear',
  deadzone: 0.02, smoothingMinCutoff: 1.2, smoothingBeta: 0.4, quantizeStep: 1, maxRateHz: 30,
}], postures: [] });

describe('performance session to control.event', () => {
  it('preserves an unmapped widget value across Perform off and on', () => {
    const session = new GestureSession({ specId: 'ui', gestureMap: map }, new Map([['ui:gesture:right_height', 97]]), vi.fn(), vi.fn());
    const frame = makeGestureFrame();
    session.engine.update(frame, 0); session.engine.update(frame, 50);
    expect(session.engine.state.axes[0]!.value).toBe(97);
  });

  it('engages, sends mapped values, freezes on release, and requires a fresh dwell after tracking loss', () => {
    const events: ControlEventPayload[] = [], mirror = vi.fn();
    const spec = { specId: 'ui', cardId: 'synth', driverId: 'driver', gestureMap: map };
    const session = new GestureSession(spec, new Map(), (event) => events.push(event), mirror);
    const frame = makeGestureFrame();
    for (let time = 0; time <= 100; time += 10) session.engine.update(frame, time);
    expect(session.engine.state.engaged).toBe(true);
    expect(events).toHaveLength(0);
    moveHand(frame.hands.right!, 0.2, 1.5, -0.4);
    for (let time = 110; time <= 500; time += 10) session.engine.update(frame, time);
    expect(events.length).toBeGreaterThan(0);
    expect(events.at(-1)).toMatchObject({ specId: 'ui', widgetId: 'gesture:right_height', phase: 'move' });
    expect(Number(events.at(-1)!.value)).toBeGreaterThan(100);
    expect(parseMessage(JSON.stringify({ v: 1, id: 'test-event', type: 'control.event', from: 'quest', ts: Date.now(), payload: events.at(-1) })).ok).toBe(true);
    const count = events.length, frozen = session.engine.state.axes[0]!.value;
    setPosture(frame.hands.left!, 'open_palm');
    moveHand(frame.hands.right!, 0.2, 0.9, -0.4);
    for (let time = 510; time <= 700; time += 10) session.engine.update(frame, time);
    expect(session.engine.state.engaged).toBe(false);
    expect(events).toHaveLength(count);
    expect(session.engine.state.axes[0]!.value).toBe(frozen);
    setPosture(frame.hands.left!, 'fist');
    session.engine.update(frame, 710); session.engine.update(frame, 760);
    expect(session.engine.state.engaged).toBe(true);
    expect(events).toHaveLength(count);
    const left = frame.hands.left;
    delete frame.hands.left;
    session.engine.update(frame, 770);
    frame.hands.left = left;
    session.engine.update(frame, 780);
    expect(session.engine.state.engaged).toBe(false);
    session.engine.update(frame, 830);
    expect(session.engine.state.engaged).toBe(true);
    expect(events).toHaveLength(count);
    expect(mirror).not.toHaveBeenCalled();
  });

  it('picks up the existing single-action widget value and mirrors matching action names', () => {
    const spec: UiSpecPayload & { gestureMap: GestureMap } = {
      specId: 'ui', gestureMap: map,
      gen3d: { ...emptySpec('generated'), controls: [{ id: 'warp-slider', kind: 'continuous', label: 'Warp', default: 12, binding: { action: 'midi.cc', args: { hack: 'warp-hack' } } }] },
      hackset: { spec: 'ce.hackset/1', device: { id: 'synth', name: 'Visual synth', channel: { type: 'midi' } }, hacks: [{
        id: 'warp-hack', name: 'Warp', kind: 'control', commands: [{ action: 'visual-warp', param: 'warp' }],
        max_rate_hz: 3, oracle: { type: 'wire', expect: 'serial_ack' },
      }] },
    };
    const send = vi.fn(), mirror = vi.fn();
    const session = new GestureSession(spec, new Map([['generated:warp-slider', 45]]), send, mirror);
    const frame = makeGestureFrame();
    session.engine.update(frame, 0); session.engine.update(frame, 50);
    expect(session.engine.state.axes[0]!.value).toBe(45);
    moveHand(frame.hands.right!, 0.2, 1.5, -0.4);
    session.engine.update(frame, 100);
    expect(mirror).toHaveBeenCalledWith('generated', 'warp-slider', expect.any(Number));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ widgetId: 'gesture:right_height' }));
  });
});
