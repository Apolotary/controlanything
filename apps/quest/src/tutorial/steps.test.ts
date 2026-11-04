import { describe, expect, it } from 'vitest';
import { TutorialSteps, type TutorialProbe } from './steps';
import { Group, Quaternion, Vector3 } from 'three';
import { TutorialController } from './index';
import type { ShellFrame } from '../app/hud-contract';

const probe = (): TutorialProbe => ({ inXr: true, busy: false, boxes: 0, selected: false, controllable: false,
  wire: {}, menuOpen: false, buddyOpen: false });
describe('first-run wiring tutorial', () => {
  it('teaches explicit Control and Set up after tagging without advancing on time or mode alone', () => {
    const steps = new TutorialSteps(), s = probe();
    Object.assign(s, { mode: 'annotate', selected: true, cardId: 'real-laptop' });
    steps.update(s, 0);
    expect(steps.step).toBe('ask');
    expect(steps.view(s, 0)).toMatchObject({ title: 'Switch to Control', detail: expect.stringContaining('wrist menu') });
    steps.update(s, 60_000); expect(steps.step).toBe('ask');
    s.mode = 'control'; s.needsBridge = true;
    steps.update(s, 60_050);
    expect(steps.view(s, 60_050)).toMatchObject({ title: 'Connect a companion', detail: expect.stringContaining('Mac companion') });
    expect(steps.step).toBe('ask');
    s.needsBridge = false; s.needsSetup = true;
    steps.update(s, 60_100);
    expect(steps.view(s, 60_100)).toMatchObject({ title: 'Set up this device', detail: expect.stringContaining('Press Set up') });
    s.needsSetup = false; s.needsEnable = true;
    expect(steps.view(s, 60_200)?.title).toBe('Enable this device');
    s.needsEnable = false; s.controllable = true;
    steps.update(s, 60_300);
    expect(steps.step).toBe('ask'); expect(steps.view(s, 60_300)?.title).toBe('What should your hands do?');
    s.wire = { phase: 'writing', request: 'Touch the water', requestId: 'explicit-ask' };
    steps.update(s, 60_400); expect(steps.step).toBe('wiring');
  });

  it('suggests water only for the visual demo and leaves physical controls to the wearer’s request', () => {
    const steps = new TutorialSteps(), s = probe();
    Object.assign(s, { mode: 'control', selected: true, cardId: 'op1', controllable: true });
    steps.update(s, 0);
    expect(steps.view(s, 0)?.detail).toBe('Hold the mic and describe the controls you want.');
    s.instrument = 'visual-synth';
    expect(steps.view(s, 0)?.detail).toContain('Touch the water');
    s.instrument = 'musical-synth';
    expect(steps.view(s, 0)?.detail).toContain('Play like a theremin');
  });

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
    expect(steps.step).toBe('ask'); expect(steps.view(s, 11000)?.title).toMatch(/again/);
  });

  it('uses actual calibration, contact and scoped Stop before menu and Buddy; time or an open menu alone cannot pass', () => {
    const steps = new TutorialSteps(), s = probe();
    Object.assign(s, { selected: true, cardId: 'mac', controllable: true,
      wire: { phase: 'calibrating', request: 'Touch the water', requestId: 'water-1', needsScreen: true, stats: { sent: 20 } } });
    steps.update(s, 100); expect(steps.step).toBe('calibrate');
    s.wire.phase = 'running'; s.wire.touching = false; steps.update(s, 200);
    expect(steps.step).toBe('touch');
    s.wire.touching = true; steps.update(s, 300); expect(steps.step).toBe('menu');
    expect(steps.view(s, 1000)).toBeUndefined();
    expect(steps.view(s, 5500)?.title).toMatch(/Stop just the wiring/);
    s.menuOpen = true; steps.update(s, 5500); expect(steps.step).toBe('menu');
    s.wire.phase = 'stopped'; s.wire.requestId = 'unrelated'; steps.update(s, 5600);
    expect(steps.step).toBe('menu'); // A different request's stop is not this lesson's stop.
    s.menuOpen = false; s.wire.requestId = 'water-1'; steps.update(s, 5700);
    expect(steps.view(s, 5700)?.title).toMatch(/Ask again/);
    s.menuOpen = true; steps.update(s, 5800); expect(steps.step).toBe('buddy');
    steps.update(s, 100000); expect(steps.finished).toBe(false);
    s.buddyOpen = true; steps.update(s, 100100); expect(steps.finished).toBe(true);
  });

  it('names the Enable action and recovers stopped calibration without treating its old request as a new ask', () => {
    const steps = new TutorialSteps(), s = probe();
    Object.assign(s, { selected: true, cardId: 'mac', needsEnable: true });
    steps.update(s, 0); expect(steps.step).toBe('ask');
    expect(steps.view(s, 0)).toMatchObject({ title: 'Enable this device', detail: expect.stringContaining('Enable controls') });
    s.needsEnable = false; s.controllable = true;
    s.wire = { phase: 'calibrating', request: 'Touch the water', requestId: 'first', needsScreen: true };
    steps.update(s, 100); expect(steps.step).toBe('calibrate');
    s.wire.phase = 'stopped'; steps.update(s, 200); expect(steps.step).toBe('ask');
    expect(steps.view(s, 200)?.title).toMatch(/again/);
    steps.update(s, 100000); expect(steps.step).toBe('ask');
    s.wire = { phase: 'writing', request: 'Touch the water', requestId: 'second' };
    steps.update(s, 100100); expect(steps.step).toBe('wiring');
  });

  it('recognizes a real full Stop for the current request after play, without pretending a retired Stop applies', () => {
    const steps = new TutorialSteps(), s = probe();
    Object.assign(s, { selected: true, cardId: 'mac', controllable: true,
      wire: { phase: 'running', request: 'Touch the water', requestId: 'current', needsScreen: true, touching: true, stats: { sent: 3 } } });
    steps.update(s, 0); expect(steps.step).toBe('menu');
    s.selected = s.controllable = false; s.cardId = undefined; s.wire = {}; s.fullStopRequestId = 'retired';
    steps.update(s, 5000); expect(steps.view(s, 5000)?.title).toBe('Stop just the wiring');
    s.fullStopRequestId = 'current'; steps.update(s, 5100);
    expect(steps.view(s, 5100)?.title).toBe('Everything is stopped');
    s.menuOpen = true; steps.update(s, 5200); expect(steps.step).toBe('buddy');
  });

  it('offers Ask again after the current played wiring fails instead of asking to stop an inactive Worker', () => {
    const steps = new TutorialSteps(), s = probe();
    Object.assign(s, { selected: true, cardId: 'mac', controllable: true,
      wire: { phase: 'running', request: 'Touch the water', requestId: 'current', needsScreen: true, touching: true, stats: { sent: 3 } } });
    steps.update(s, 0); s.wire.phase = 'failed'; steps.update(s, 5000);
    expect(steps.view(s, 5000)?.title).toBe('Ask again, or open the menu');
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
