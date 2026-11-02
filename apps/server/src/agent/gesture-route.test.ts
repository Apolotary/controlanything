import { describe, expect, it, vi } from 'vitest';
import type { Driver, UiSpecPayload } from '@ce/protocol';
import { proposeGestureMap } from '../devices/gestures';
import { ControlRouter } from './control';
import type { Dispatcher } from './dispatch';
import { StepLog } from './steps';
import { TargetStore } from './targets';

function setup() {
  const hub = { broadcast: vi.fn(() => 1) };
  const fire = vi.fn(() => true);
  const dispatcher = { fire, flushQueued: vi.fn() } as unknown as Dispatcher;
  const targets = new TargetStore(hub);
  const driver: Driver = { driverId: 'driver', cardId: 'synth', transport: 'midi', executor: { deviceId: 'mac' }, provenance: [], actions: [
    { actionId: 'visual-warp', label: 'Warp', kind: 'set', range: { min: 0, max: 127, step: 1 }, encode: { kind: 'midi', msg: 'cc', channel: 3, number: 23, value: '$value' } },
    { actionId: 'visual-zoom', label: 'Zoom', kind: 'set', range: { min: 0, max: 127, step: 1 }, encode: { kind: 'midi', msg: 'cc', channel: 3, number: 24, value: '$value' } },
  ] };
  const verification = { 'visual-warp': 'pass', 'visual-zoom': 'pass' } as const;
  const spec: UiSpecPayload = { specId: 'spec', driverId: driver.driverId, cardId: 'synth', gestureMap: proposeGestureMap(driver, verification) };
  const target = targets.create({ cardId: 'synth', specId: 'spec', driver, armed: true, verification: { ...verification } });
  let now = 0, allowed = true;
  const router = new ControlRouter({ targets, dispatcher, specs: { get: () => spec, list: () => [spec] }, hub,
    steps: new StepLog(hub), now: () => now, canControl: () => allowed });
  const send = (widgetId = 'gesture:right_height', value = 91) => router.onControlEvent({ specId: 'spec', widgetId, value, phase: 'move', ts: now });
  return { fire, target, spec, router, send, tick: (ms: number) => { now += ms; }, disconnect: () => { allowed = false; } };
}

describe('verified gesture control routing', () => {
  it('routes the map to the driver CC even without a generated slider or hack', () => {
    const c = setup();
    expect(c.send()).toMatchObject({ ok: true, fired: 1 });
    expect(c.fire).toHaveBeenCalledWith('mac', { kind: 'midi', msg: 'cc', channel: 3, number: 23, value: 91 }, expect.objectContaining({ actionId: 'visual-warp' }));
    expect(c.send('gesture:right_roll', 42)).toMatchObject({ ok: true, fired: 1 });
    expect(c.fire.mock.calls[1]).toEqual(['mac', { kind: 'midi', msg: 'cc', channel: 3, number: 24, value: 42 }, expect.objectContaining({ actionId: 'visual-zoom' })]);
    c.router.close();
  });

  it('rechecks live verification, arming and connection before dispatch', () => {
    const c = setup();
    c.target.verification['visual-warp'] = 'fail';
    expect(c.send().ok).toBe(false);
    c.target.verification['visual-warp'] = 'pass';
    c.target.armed = false;
    expect(c.send().reason).toBe('not armed');
    c.target.armed = true;
    c.disconnect();
    expect(c.send().reason).toBe('control is not authorized for this device');
    expect(c.fire).not.toHaveBeenCalled();
    c.router.close();
  });

  it('rejects unknown gestures and stale driver maps, clamps numeric values', () => {
    const c = setup();
    expect(c.router.onControlEvent({ widgetId: 'gesture:right_height', value: 80, ts: 0, phase: 'move' }).ok).toBe(false);
    expect(c.send('gesture:visual-warp').ok).toBe(false);
    c.spec.driverId = 'old-driver';
    expect(c.send().ok).toBe(false);
    c.spec.driverId = 'driver';
    expect(c.send('gesture:right_height', 500).ok).toBe(true);
    expect(c.fire).toHaveBeenCalledWith('mac', expect.objectContaining({ value: 127 }), expect.anything());
    c.router.close();
  });

  it('limits axes independently to 30 Hz and never queues trailing gesture moves', () => {
    vi.useFakeTimers();
    try {
      const c = setup();
      c.send();
      c.tick(10);
      expect(c.send().reason).toBe('rate limited');
      expect(c.send('gesture:right_roll', 32).fired).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      c.tick(24);
      expect(c.send().fired).toBe(1);
      vi.advanceTimersByTime(1000);
      expect(c.fire).toHaveBeenCalledTimes(3);
      c.router.close();
    } finally { vi.useRealTimers(); }
  });

  it('respects a lower map rate immediately after a revision', () => {
    const c = setup();
    c.send();
    c.spec.gestureMap!.axes[0]!.maxRateHz = 2;
    c.tick(34);
    expect(c.send().reason).toBe('rate limited');
    c.tick(466);
    expect(c.send().fired).toBe(1);
    expect(c.fire).toHaveBeenCalledTimes(2);
    c.router.close();
  });

  it('moves a step-only lamp once without leaving a sequence running after release', () => {
    vi.useFakeTimers();
    try {
      const c = setup(), driver = c.target.driver!;
      driver.transport = 'ir';
      driver.actions = [
        { actionId: 'level', label: 'Brightness', kind: 'set', range: { min: 0, max: 100, step: 10 }, encode: { kind: 'step', upActionId: 'up', downActionId: 'down', steps: 10, settleMs: 500 } },
        { actionId: 'up', label: 'Brighter', kind: 'trigger', encode: { kind: 'ir', protocol: 'NEC', bytes: [1, 2] } },
        { actionId: 'down', label: 'Dimmer', kind: 'trigger', encode: { kind: 'ir', protocol: 'NEC', bytes: [3, 4] } },
      ];
      c.target.verification = { level: 'pass', up: 'pass', down: 'pass' };
      c.target.stepIndex.level = 2;
      c.spec.gestureMap = proposeGestureMap(driver, c.target.verification);
      expect(c.send('gesture:right_height', 100).fired).toBe(1);
      expect(c.fire).toHaveBeenCalledWith('mac', expect.objectContaining({ kind: 'ir', bytes: [1, 2] }), expect.objectContaining({ dropIfLimited: true }));
      // The step position advances when the bridge acknowledges the command (master's acknowledged-state rule).
      ((c.fire.mock.calls[0] as unknown[])[2] as { onResult?: (ok: boolean, detail?: string) => void }).onResult?.(true);
      expect(c.target.stepIndex.level).toBe(3);
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(5000);
      expect(c.fire).toHaveBeenCalledTimes(1);
      c.router.close();
    } finally { vi.useRealTimers(); }
  });
});
