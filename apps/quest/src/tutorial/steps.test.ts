import { describe, expect, it } from 'vitest';
import { TutorialSteps, type TutorialProbe } from './steps';
import { Group, Quaternion, Vector3 } from 'three';
import { TutorialController } from './index';
import type { ShellFrame } from '../app/hud-contract';

const probe = (): TutorialProbe => ({ inXr: true, busy: false, boxes: 0, selected: false, controllable: false,
  wire: {}, menuOpen: false, buddyOpen: false });
describe('first-run wiring tutorial', () => {
  it('waits for a real request and keeps a failed write out of the touch step', () => {
    const steps = new TutorialSteps(), s = probe(); steps.update(s, 0);
    expect(steps.step).toBe('look');
    s.boxes = 1; steps.update(s, 100); expect(steps.step).toBe('pinch');
    s.selected = true; s.cardId = 'mac'; s.controllable = true; steps.update(s, 200);
    expect(steps.step).toBe('ask');
    for (let t = 300; t < 10000; t += 500) steps.update(s, t);
    expect(steps.step).toBe('ask');
    s.wire = { request: 'Touch the water', phase: 'writing' }; steps.update(s, 10000);
    expect(steps.step).toBe('wiring');
    s.wire.phase = 'failed'; steps.update(s, 11000);
    expect(steps.step).toBe('wiring'); expect(steps.view(s, 11000)?.title).toMatch(/again/);
  });

  it('uses actual calibration and contact, then actual menu and Buddy; baseline output is not a touch', () => {
    const steps = new TutorialSteps(), s = probe();
    Object.assign(s, { selected: true, cardId: 'mac', controllable: true,
      wire: { phase: 'calibrating', request: 'Touch the water', needsScreen: true, stats: { sent: 20 } } });
    steps.update(s, 100); expect(steps.step).toBe('calibrate');
    s.wire.phase = 'running'; s.wire.touching = false; steps.update(s, 200);
    expect(steps.step).toBe('touch');
    s.wire.touching = true; steps.update(s, 300); expect(steps.step).toBe('menu');
    expect(steps.view(s, 1000)).toBeUndefined();
    expect(steps.view(s, 5500)?.title).toMatch(/menu/);
    s.menuOpen = true; steps.update(s, 5500); expect(steps.step).toBe('buddy');
    steps.update(s, 100000); expect(steps.finished).toBe(false);
    s.buddyOpen = true; steps.update(s, 100100); expect(steps.finished).toBe(true);
  });

  it('remembers explicit Skip, replays on request and tolerates unavailable storage', () => {
    const values = new Map<string, string>(), s = probe();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const frame = { head: { position: new Vector3(0, 1.6, 0), quaternion: new Quaternion() } } as ShellFrame;
    const first = new TutorialController({ parent: new Group(), probe: () => s, anchor: () => undefined, storage });
    first.frame(frame, .016, 0); expect(first.snapshot().visible).toBe(true);
    first.skip(); expect(first.snapshot().finished).toBe(true);
    const next = new TutorialController({ parent: new Group(), probe: () => s, anchor: () => undefined, storage });
    expect(next.snapshot().finished).toBe(true);
    next.replay(); next.frame(frame, .016, 100); expect(next.snapshot().step).toBe('look');
    first.dispose(); next.dispose();
    const privateMode = new TutorialController({ parent: new Group(), probe: () => s, anchor: () => undefined,
      storage: { getItem: () => { throw Error('private'); }, setItem: () => { throw Error('private'); } } });
    expect(() => privateMode.skip()).not.toThrow(); privateMode.dispose();
  });
});
