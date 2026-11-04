import { describe, expect, it, vi } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import type { WireProgressPayload, WireReadyPayload } from '@ce/protocol';
import type { WireView } from '../hud/contract';
import { makeGestureFrame, moveHand } from '../gestures/fixtures.test-support';
import { fakeWorkerFactory } from './fake-worker.test-support';
import { WiringController, WIRE_CHIPS, type WiringHost } from './controller';
import { WiringRuntime, type WireEmit } from './runtime';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const anchor = new Vector3(0, 1.45, -0.6);

function setup(options: { micError?: string } = {}) {
  const sent: { type: string; payload: unknown }[] = [], controls: WireEmit[] = [], toasts: string[] = [], views: (WireView | null)[] = [];
  let busy = false, canControl = true, selected: { cardId: string; targetId: string; anchor: Vector3; label: string } | undefined = { cardId: 'visual-synth-mac', targetId: 't1', anchor, label: 'Visual synth' };
  const voice = { error: vi.fn(() => options.micError), available: () => true, press: vi.fn(async () => {}), release: vi.fn(), cancel: vi.fn() };
  const holder: { controller?: WiringController } = {};
  const runtime = new WiringRuntime({
    send: (event) => { controls.push(event); return true; },
    onStop: (reason, kind) => (holder.controller as unknown as { onRuntimeStop(r: string, k: string): void }).onRuntimeStop(reason, kind),
    createWorker: fakeWorkerFactory({ posted: [] }),
  });
  const host: WiringHost = {
    selected: () => selected, canControl: () => canControl,
    send: (type, payload) => { sent.push({ type, payload }); return true; },
    sendControl: (_card, event) => { controls.push(event); return true; },
    render: (view) => { views.push(view); }, setHandsBusy: (b) => { busy = b; },
    toast: (text) => { toasts.push(text); }, log: () => {}, voice, tapBlocked: () => false, runtime,
  };
  const controller = holder.controller = new WiringController(host);
  const view = () => views.at(-1);
  return { controller, sent, controls, toasts, views, view, voice, runtime, busy: () => busy, setControl: (v: boolean) => { canControl = v; }, deselect: () => { selected = undefined; } };
}

const base = { cardId: 'visual-synth-mac', wiringId: 'w1', model: 'muse-spark-1.3', source: 'fixture' as const };
const CODE = "const t = s.screen;\nif (t && t.inside) { out.set('x', t.u * 127); out.set('p', t.touching ? 127 : 0); } else out.set('p', 0);\n";
const ready = (needs: WireReadyPayload['needs'] = ['right', 'screen']): WireReadyPayload => ({ ...base, code: CODE, title: 'FIXTURE: Touch the water', explanation: 'Your fingertip is a ripple.',
  actions: [{ actionId: 'x', label: 'X', kind: 'set', min: 0, max: 127, maxRateHz: 60 }, { actionId: 'p', label: 'Pressure', kind: 'set', min: 0, max: 127, maxRateHz: 60 }], needs });
const progress = (p: Partial<WireProgressPayload> & { phase: WireProgressPayload['phase'] }): WireProgressPayload => ({ ...base, ...p });
let clock = 1000;
/** One fingertip frame (no left hand) at a world point. */
const finger = (tip: Vector3) => { const f = makeGestureFrame('open_palm', 'point'); delete f.hands.left; moveHand(f.hands.right!, tip.x, tip.y, tip.z + 0.14); f.head.position.set(0, 1.6, 0); f.head.quaternion.copy(new Quaternion()); return f; };
async function hold(controller: WiringController, tip: Vector3, ms: number) {
  for (const end = clock + ms; clock < end; clock += 16) { controller.frame(finger(tip), clock); await wait(1); }
}

describe('the wiring flow', () => {
  it('shows the ask prompt and chips, and the hands do nothing until a wiring runs', async () => {
    const t = setup();
    t.controller.frame(finger(new Vector3(0, 1.4, -0.4)), clock += 16);
    expect(t.view()).toMatchObject({ phase: 'idle', prompt: 'What should your hands do?', chips: [...WIRE_CHIPS], mic: 'idle' });
    expect(t.view()!.code).toBeUndefined();
    for (let i = 0; i < 30; i++) { t.controller.frame(finger(new Vector3(0, 1.4 + i * 0.005, -0.4)), clock += 16); await wait(1); }
    expect(t.controls).toEqual([]);
    expect(t.sent).toEqual([]);
  });

  it('asks Muse, streams the code, calibrates the screen, runs, and stops on both palms out', async () => {
    const t = setup();
    expect(t.controller.ask('Touch the water', 'chip')).toBe(true);
    expect(t.sent).toEqual([{ type: 'wire.request', payload: { cardId: 'visual-synth-mac', text: 'Touch the water', source: 'chip' } }]);
    t.controller.frame(finger(new Vector3(0, 1.4, -0.4)), clock += 16);
    expect(t.view()).toMatchObject({ phase: 'asked', chips: [] });
    t.controller.onProgress(progress({ phase: 'writing', codeDelta: CODE.slice(0, 30), note: 'muse-spark-1.3 is writing…' }));
    t.controller.onProgress(progress({ phase: 'writing', codeDelta: CODE.slice(30) }));
    clock += 100; t.controller.frame(finger(new Vector3(0, 1.4, -0.4)), clock);
    expect(t.view()!.code).toMatchObject({ phase: 'writing', code: CODE, source: 'fixture', model: 'muse-spark-1.3', request: 'Touch the water', mode: 'full' });
    t.controller.onProgress(progress({ phase: 'validating', code: CODE, title: 'FIXTURE: Touch the water' }));
    t.controller.onProgress(progress({ phase: 'dry-run', note: 'dry-run ✓ 120 frames · 2 actions' }));
    clock += 100; t.controller.frame(finger(new Vector3(0, 1.4, -0.4)), clock);
    expect(t.view()!.code!.phaseLine).toContain('dry-run');
    t.controller.onProgress(progress({ phase: 'ready' }));
    t.controller.onReady(ready());
    expect(t.controller.phase).toBe('calibrating');
    expect(t.runtime.running).toBe(false);
    // touch the two corners of a screen at z = -0.6
    await hold(t.controller, new Vector3(-0.25, 1.62, -0.6), 600);
    expect(t.controller.calibrator.step).toBe('bottom-right');
    expect(t.view()!.calibration).toMatchObject({ step: 'bottom-right' });
    await hold(t.controller, new Vector3(0.25, 1.32, -0.6), 600);
    expect(t.controller.phase).toBe('running');
    await wait(10);
    // fingertip on the glass in the middle: pressure goes out, within the action's range
    await hold(t.controller, new Vector3(0, 1.47, -0.597), 400);
    const p = t.controls.filter((e) => e.widgetId === 'wire:p').map((e) => e.value);
    expect(p[p.length - 1]).toBe(127);
    const x = t.controls.filter((e) => e.widgetId === 'wire:x').map((e) => e.value as number);
    expect(x[x.length - 1]).toBeGreaterThan(55); expect(x[x.length - 1]).toBeLessThan(72);
    expect(t.controls.every((e) => /^wire:(x|p)$/.test(e.widgetId))).toBe(true);
    // hand away: lifts
    await hold(t.controller, new Vector3(0, 1.47, -0.1), 200);
    expect(t.controls.filter((e) => e.widgetId === 'wire:p').at(-1)!.value).toBe(0);
    // stop
    t.controller.stop('both palms out', 'user');
    await wait(100);
    expect(t.controller.phase).toBe('stopped');
    expect(t.toasts.some((m) => /Wiring stopped/.test(m))).toBe(true);
    const n = t.controls.length;
    await hold(t.controller, new Vector3(0, 1.47, -0.597), 200);
    expect(t.controls.length).toBe(n);
    expect(t.view()!.code).toMatchObject({ mode: 'pill', stopped: true });
    expect(t.view()!.prompt).toBe('Stopped · ask again');
  });

  it('a wiring that does not need the screen starts at once; a new request silences the old one', async () => {
    const t = setup();
    t.controller.ask('Hands as knobs', 'chip');
    t.controller.onProgress(progress({ phase: 'writing', code: CODE }));
    t.controller.onReady(ready(['right']));
    expect(t.controller.phase).toBe('running');
    await wait(10);
    t.controller.ask('Surprise me', 'chip');
    expect(t.controller.phase).toBe('asked');
    await wait(100);
    expect(t.runtime.running).toBe(false);
  });

  it('shows a template or fixture source honestly and failures with their reason', () => {
    const t = setup();
    t.controller.ask('Surprise me', 'chip');
    t.controller.onProgress(progress({ phase: 'writing', code: '// x', model: 'template', source: 'template', note: 'template wiring: no Meta model wrote this' }));
    t.controller.frame(finger(new Vector3(0, 1.4, -0.4)), clock += 200);
    expect(t.view()!.code).toMatchObject({ source: 'template', model: 'template' });
    t.controller.onProgress(progress({ phase: 'failed', issues: ['uses fetch'] }));
    t.controller.frame(finger(new Vector3(0, 1.4, -0.4)), clock += 200);
    expect(t.view()).toMatchObject({ phase: 'failed', prompt: 'Could not wire that · try again' });
    expect(t.view()!.chips).toHaveLength(3);
    expect(t.toasts.some((m) => /uses fetch/.test(m))).toBe(true);
  });

  it('a program that is refused by the sandbox never runs and says why', () => {
    const t = setup();
    t.controller.ask('Touch the water', 'chip');
    t.controller.onReady({ ...ready(['right']), code: "fetch('http://evil')" });
    expect(t.controller.phase).toBe('failed');
    expect(t.toasts.some((m) => /Muse's wiring stopped: refused: uses fetch/.test(m))).toBe(true);
  });

  it('forgets the wiring when the device is deselected, not controllable or the server drops', async () => {
    const t = setup();
    t.controller.ask('Hands as knobs', 'chip');
    t.controller.onReady(ready(['right']));
    expect(t.controller.phase).toBe('running');
    await wait(5);
    t.setControl(false);
    t.controller.frame(finger(new Vector3(0, 1.4, -0.4)), clock += 16);
    expect(t.controller.phase).toBe('idle');
    expect(t.runtime.running).toBe(false);
    expect(t.view()).toBeNull();
  });

  it('hold-to-talk: a hold sends on release, a tap keeps listening, the transcript becomes a voice request', () => {
    const t = setup();
    t.controller.micPress();
    expect(t.voice.press).toHaveBeenCalledWith('visual-synth-mac');
    t.controller.frame(finger(new Vector3(0, 1.4, -0.4)), clock += 16);
    expect(t.view()!.mic).toBe('listening');
    t.controller.micLetGo();           // released at once: a tap, still listening
    expect(t.voice.release).not.toHaveBeenCalled();
    t.controller.micPress();           // second press sends
    expect(t.voice.release).toHaveBeenCalledTimes(1);
    t.controller.onVoiceListening(true, 'u-1');
    t.controller.onVoiceText('make the water follow my finger', 'u-1', true);
    expect(t.sent[0]).toEqual({ type: 'wire.request', payload: { cardId: 'visual-synth-mac', text: 'make the water follow my finger', source: 'voice' } });
    t.controller.onVoiceText('stale', 'u-0', true);
    expect(t.sent).toHaveLength(1);
  });

  it('a microphone problem is said out loud, not swallowed', () => {
    const t = setup({ micError: 'Microphone is disabled for this session.' });
    t.controller.micPress();
    expect(t.toasts).toContain('Microphone is disabled for this session.');
    expect(t.voice.press).not.toHaveBeenCalled();
  });
});
