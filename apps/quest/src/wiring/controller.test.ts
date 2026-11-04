import { describe, expect, it, vi } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import type { WireProgressPayload, WireReadyPayload } from '@ce/protocol';
import type { WireView } from '../hud/contract';
import { makeGestureFrame, moveHand } from '../gestures/fixtures.test-support';
import { fakeWorkerFactory } from './fake-worker.test-support';
import { WiringController, WIRE_CHIPS, MUSICAL_WIRE_CHIPS, PHYSICAL_WIRE_CHIPS, type WiringHost } from './controller';
import { WiringRuntime, type WireEmit } from './runtime';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const anchor = new Vector3(0, 1.45, -0.6);

function setup(options: { micError?: string; instrument?: 'visual-synth' | 'musical-synth' | null } = {}) {
  const sent: { type: string; payload: unknown }[] = [], controls: WireEmit[] = [], toasts: string[] = [], views: (WireView | null)[] = [];
  const instrument = options.instrument === null ? undefined : options.instrument ?? 'visual-synth';
  let busy = false, canControl = true, selected: ReturnType<WiringHost['selected']> = {
    cardId: instrument === 'musical-synth' ? 'musical-synth-mac' : instrument === 'visual-synth' ? 'visual-synth-mac' : 'physical-device',
    targetId: 't1', anchor, label: instrument === 'musical-synth' ? 'ControlAnything Synth' : instrument === 'visual-synth' ? 'Visual synth' : 'Physical device', instrument,
  };
  const voice = { error: vi.fn(() => options.micError), available: () => true, press: vi.fn(async () => {}), release: vi.fn(), cancel: vi.fn() };
  const holder: { controller?: WiringController } = {};
  const runtime = new WiringRuntime({
    send: (event) => { controls.push(event); return true; },
    onStop: (reason, kind) => (holder.controller as unknown as { onRuntimeStop(r: string, k: string): void }).onRuntimeStop(reason, kind),
    createWorker: fakeWorkerFactory({ posted: [] }),
  });
  const userStopped = vi.fn();
  const feedback = vi.fn();
  const host: WiringHost = {
    selected: () => selected, canControl: () => canControl,
    send: (type, payload) => { sent.push({ type, payload }); return true; },
    sendControl: (_card, event) => { controls.push(event); return true; },
    render: (view) => { views.push(view); }, setHandsBusy: (b) => { busy = b; }, userStopped, feedback,
    toast: (text) => { toasts.push(text); }, log: () => {}, voice, tapBlocked: () => false, runtime,
  };
  const controller = holder.controller = new WiringController(host);
  const view = () => views.at(-1);
  const requestId = () => (sent.findLast(e => e.type === 'wire.request')?.payload as { requestId?: string } | undefined)?.requestId;
  const receiveReady = (p: WireReadyPayload) => controller.onReady({ ...p, requestId: p.requestId ?? requestId() });
  const receiveProgress = (p: WireProgressPayload) => controller.onProgress({ ...p, requestId: p.requestId ?? requestId() });
  return { controller, requestId, receiveReady, receiveProgress, sent, controls, toasts, views, view, voice, runtime, userStopped, feedback, busy: () => busy, setControl: (v: boolean) => { canControl = v; }, deselect: () => { selected = undefined; } };
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
  it('makes lifecycle feedback only for accepted replies, and stops a pending request on executor disconnect', () => {
    const t = setup();
    t.receiveReady(ready(['right'])); expect(t.feedback).not.toHaveBeenCalled();
    t.controller.ask('Hands as knobs', 'chip');
    expect(t.feedback).toHaveBeenLastCalledWith('asking');
    t.receiveProgress(progress({ phase: 'writing', code: CODE }));
    const requestId = t.requestId()!;
    t.controller.onStopped({ cardId: 'visual-synth-mac', requestId, wiringId: 'w1', ok: true, releaseConfirmed: false, reason: 'Mac disconnected' });
    expect(t.controller.phase).toBe('stopped'); expect(t.feedback).toHaveBeenLastCalledWith('idle');
    t.receiveReady(ready(['right'])); expect(t.runtime.running).toBe(false);
    expect(t.feedback.mock.calls.filter(([cue]) => cue === 'ready')).toHaveLength(0);
    t.controller.ask('Hands as knobs', 'chip'); t.receiveReady({ ...ready(['right']), wiringId: 'w2' }); t.receiveReady({ ...ready(['right']), wiringId: 'w2' });
    expect(t.feedback.mock.calls.filter(([cue]) => cue === 'ready')).toHaveLength(1);
    t.controller.stop('both palms out');
    expect(t.feedback.mock.calls.filter(([cue]) => cue === 'stop')).toHaveLength(1);
    t.controller.reset();
  });

  it('offers generic physical-device requests without water or music assumptions or an automatic request', () => {
    const t = setup({ instrument: null });
    t.controller.frame(finger(new Vector3(0, 1.4, -.4)), clock += 16);
    expect(t.view()).toMatchObject({ phase: 'idle', chips: [...PHYSICAL_WIRE_CHIPS] });
    expect(t.view()?.chips).not.toContain('Touch the water');
    expect(t.view()?.chips).not.toContain('Play like a theremin');
    expect(t.controller.chipText(0)).toBe('Hands as knobs');
    expect(t.controller.chipText(1)).toBe('Surprise me');
    expect(t.sent).toEqual([]); expect(t.controls).toEqual([]); expect(t.runtime.running).toBe(false);
    expect(t.controller.ask(t.controller.chipText(0)!, 'chip')).toBe(true);
    expect(t.sent).toEqual([{ type: 'wire.request', payload: { cardId: 'physical-device', text: 'Hands as knobs', source: 'chip', requestId: expect.any(String) } }]);
    expect(t.runtime.running).toBe(false); expect(t.controls).toEqual([]);
    t.controller.reset();
  });

  it('offers musical requests only when its verified device is controllable, without installing a hand map', () => {
    const t = setup({ instrument: 'musical-synth' }); t.setControl(false);
    expect(t.controller.view('musical-synth-mac')).toBeNull();
    expect(t.controller.ask('Play like a theremin', 'chip')).toBe(false);
    expect(t.sent).toEqual([]); expect(t.controls).toEqual([]);
    t.setControl(true); t.controller.frame(finger(new Vector3(0, 1.4, -.4)), clock += 16);
    expect(t.view()?.chips).toEqual([...MUSICAL_WIRE_CHIPS]);
    expect(t.view()?.chips).not.toContain('Touch the water');
    expect(t.controller.ask('Play like a theremin', 'chip')).toBe(true);
    expect(t.sent).toEqual([{ type: 'wire.request', payload: { cardId: 'musical-synth-mac', text: 'Play like a theremin', source: 'chip', requestId: expect.any(String) } }]);
    expect(t.runtime.running).toBe(false); expect(t.controls).toEqual([]);
  });
  it('shows the ask prompt and chips, and the hands do nothing until a wiring runs', async () => {
    const t = setup();
    t.controller.frame(finger(new Vector3(0, 1.4, -0.4)), clock += 16);
    expect(t.view()).toMatchObject({ phase: 'idle', prompt: 'What should your hands do?', chips: [...WIRE_CHIPS], mic: 'idle' });
    expect(t.view()!.code).toBeUndefined();
    for (let i = 0; i < 30; i++) { t.controller.frame(finger(new Vector3(0, 1.4 + i * 0.005, -0.4)), clock += 16); await wait(1); }
    expect(t.controls).toEqual([]);
    expect(t.sent).toEqual([]);
    t.receiveProgress(progress({ phase: 'writing', code: CODE }));
    t.receiveReady(ready(['right']));
    expect(t.runtime.running).toBe(false); // A broadcast from an older session is not a new ask.
    expect(t.controller.phase).toBe('idle');
  });

  it('rejects overlong requests without replacing a running program, and accepts all 500 characters at the boundary', async () => {
    const t = setup(); t.controller.ask('Hands as knobs', 'chip'); t.receiveReady(ready(['right']));
    await wait(5);
    const current = t.controller.snapshot(), sent = t.sent.length;
    expect(t.controller.ask('x'.repeat(501), 'voice')).toBe(false);
    expect(t.sent).toHaveLength(sent); expect(t.controller.snapshot()).toEqual(current);
    expect(t.controller.running).toBe(true);
    expect(t.toasts).toContain('That request is too long. Ask in one or two sentences.');
    const complete = 'x'.repeat(500);
    expect(t.controller.ask(complete, 'text')).toBe(true);
    expect(t.sent.at(-1)).toMatchObject({ type: 'wire.request', payload: { text: complete } });
    t.controller.reset();
  });

  it('asks Muse, streams the code, calibrates the screen, runs, and stops on both palms out', async () => {
    const t = setup();
    expect(t.controller.ask('Touch the water', 'chip')).toBe(true);
    expect(t.sent).toEqual([{ type: 'wire.request', payload: { cardId: 'visual-synth-mac', text: 'Touch the water', source: 'chip', requestId: expect.any(String) } }]);
    t.controller.frame(finger(new Vector3(0, 1.4, -0.4)), clock += 16);
    expect(t.view()).toMatchObject({ phase: 'asked', chips: [] });
    t.receiveProgress(progress({ phase: 'writing', codeDelta: CODE.slice(0, 30), note: 'muse-spark-1.3 is writing…' }));
    t.receiveProgress(progress({ phase: 'writing', codeDelta: CODE.slice(30) }));
    clock += 100; t.controller.frame(finger(new Vector3(0, 1.4, -0.4)), clock);
    expect(t.view()!.code).toMatchObject({ phase: 'writing', code: CODE, source: 'fixture', model: 'muse-spark-1.3', request: 'Touch the water', mode: 'full' });
    t.receiveProgress(progress({ phase: 'validating', code: CODE, title: 'FIXTURE: Touch the water' }));
    t.receiveProgress(progress({ phase: 'dry-run', note: 'dry-run ✓ 120 frames · 2 actions' }));
    clock += 100; t.controller.frame(finger(new Vector3(0, 1.4, -0.4)), clock);
    expect(t.view()!.code!.phaseLine).toContain('dry-run');
    t.receiveProgress(progress({ phase: 'ready' }));
    t.receiveReady(ready());
    expect(t.controller.phase).toBe('calibrating');
    expect(t.runtime.running).toBe(false);
    // touch the two corners of a screen at z = -0.6 (the hand comes in from the side, it is not resting there)
    await hold(t.controller, new Vector3(-0.6, 1.5, -0.35), 100);
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
    expect(t.userStopped).toHaveBeenCalledExactlyOnceWith('both palms out', { cardId: 'visual-synth-mac', requestId: t.requestId(), wiringId: 'w1' });
    t.controller.stop('Stop', 'external');
    expect(t.userStopped).toHaveBeenCalledTimes(1);
    await wait(100);
    expect(t.controller.phase).toBe('stopped');
    expect(t.toasts.some((m) => /Wiring stopped/.test(m))).toBe(true);
    const n = t.controls.length;
    await hold(t.controller, new Vector3(0, 1.47, -0.597), 200);
    expect(t.controls.length).toBe(n);
    expect(t.view()!.code).toMatchObject({ mode: 'pill', stopped: true });
    expect(t.view()!.prompt).toBe('Stopped · ask again');
    expect(t.controller.snapshot().calibrated).toBe(true);
    t.controller.reset('XR reference space changed', true);
    expect(t.controller.snapshot().calibrated).toBe(false);
  });

  it('a wiring that does not need the screen starts at once; a new request silences the old one', async () => {
    const t = setup();
    t.controller.ask('Hands as knobs', 'chip');
    t.receiveProgress(progress({ phase: 'writing', code: CODE }));
    t.receiveReady(ready(['right']));
    expect(t.controller.phase).toBe('running');
    await wait(10);
    t.controller.ask('Surprise me', 'chip');
    expect(t.controller.phase).toBe('asked');
    await wait(100);
    expect(t.runtime.running).toBe(false);
  });

  it('blocks wrist recall during calibration fingertip work and allows recovery after the hand withdraws', () => {
    const t = setup(); t.controller.ask('Touch the water', 'chip'); t.receiveReady(ready());
    const start = finger(new Vector3(-.6, 1.5, -.35)); t.controller.frame(start, clock += 16);
    const corner = finger(new Vector3(-.25, 1.62, -.6)); t.controller.frame(corner, clock += 16);
    expect(t.controller.calibrator.hasTip).toBe(true); expect(t.busy()).toBe(true);
    const withdrawn = finger(new Vector3(0, .8, -.2)); t.controller.frame(withdrawn, clock += 16);
    expect(t.busy()).toBe(false);
    // A deliberate menu palm is a recovery route, not another working fingertip.
    const menu = makeGestureFrame('open_palm', 'point');
    menu.head.position.set(0, 1.6, 0); menu.head.quaternion.copy(new Quaternion()); delete menu.hands.right;
    moveHand(menu.hands.left!, -.2, 1.6, -.35); menu.hands.left!.palmUp = true;
    t.controller.frame(menu, clock += 16); expect(t.busy()).toBe(false);
    t.controller.reset();
  });

  it('keeps recall blocked while a fingertip stays at the captured top-left corner during the bottom-right prompt', async () => {
    const t = setup(); t.controller.ask('Touch the water', 'chip'); t.receiveReady(ready());
    await hold(t.controller, new Vector3(-.6, 1.5, -.35), 100);
    const topLeft = new Vector3(-.25, 1.62, -.6);
    await hold(t.controller, topLeft, 600);
    expect(t.controller.calibrator.step).toBe('bottom-right');
    const menuHand = makeGestureFrame('open_palm', 'point').hands.left!;
    moveHand(menuHand, -.2, 1.6, -.2); menuHand.palmUp = true;
    const touching = finger(topLeft); touching.hands.left = menuHand;
    t.controller.frame(touching, clock += 16);
    expect(t.controller.calibrator.hasTip).toBe(false); // Not a bottom-right candidate.
    expect(t.busy()).toBe(true); // Still touching the known screen corner.
    const withdrawn = finger(new Vector3(0, 1.57, -.1)); withdrawn.hands.left = menuHand;
    t.controller.frame(withdrawn, clock += 16);
    expect(t.controller.calibrator.hasTip).toBe(false); expect(t.busy()).toBe(false);
    t.controller.reset();
  });

  it('does not restart on duplicate readiness or on delayed readiness after Stop/reset', async () => {
    const t = setup();
    const start = vi.spyOn(t.runtime, 'start');
    t.controller.ask('Hands as knobs', 'chip');
    t.receiveReady(ready(['right']));
    t.receiveReady(ready(['right']));
    expect(start).toHaveBeenCalledTimes(1);
    t.controller.stop('Stop');
    t.receiveProgress(progress({ phase: 'writing', code: CODE }));
    t.receiveReady(ready(['right']));
    expect(start).toHaveBeenCalledTimes(1);
    expect(t.controller.phase).toBe('stopped');
    t.controller.reset('XR hidden');
    t.receiveReady({ ...ready(['right']), wiringId: 'late-unknown-id' });
    expect(t.controller.phase).toBe('idle');
    expect(start).toHaveBeenCalledTimes(1);
    t.controller.ask('Hands as knobs', 'chip');
    t.receiveReady({ ...ready(['right']), wiringId: 'fresh-id' });
    expect(start).toHaveBeenCalledTimes(2);
    t.controller.reset();
    await wait(10);
  });

  it('Stop during generation keeps a late program from starting', () => {
    const t = setup();
    t.controller.ask('Hands as knobs', 'chip');
    t.controller.stop('Stop');
    t.receiveProgress(progress({ phase: 'writing', code: CODE }));
    t.receiveReady(ready(['right']));
    expect(t.controller.phase).toBe('stopped');
    expect(t.runtime.running).toBe(false);
  });

  it('retires a stopped ask epoch even before progress, then accepts another identical ask without setup', async () => {
    const t = setup();
    t.controller.ask('Hands as knobs', 'chip');
    const retiredRequest = t.requestId()!;
    t.controller.stop('both palms out', 'user');
    expect(t.userStopped).toHaveBeenLastCalledWith('both palms out', { cardId: 'visual-synth-mac', requestId: retiredRequest });
    expect(t.controller.view('visual-synth-mac')).toMatchObject({ phase: 'stopped', prompt: 'Stopped · ask again', chips: [...WIRE_CHIPS] });
    expect(t.controller.ask('Hands as knobs', 'chip')).toBe(true);
    const nextRequest = t.requestId()!;
    expect(nextRequest).not.toBe(retiredRequest);
    // A formerly unknown wiring ID and the same natural-language text are still stale.
    t.controller.onProgress({ ...progress({ phase: 'writing', request: 'Hands as knobs', code: CODE }), requestId: retiredRequest });
    t.controller.onReady({ ...ready(['right']), requestId: retiredRequest });
    t.controller.onStopped({ cardId: 'visual-synth-mac', requestId: retiredRequest, wiringId: 'w1', ok: false, reason: 'old receipt' });
    expect(t.controller.phase).toBe('asked'); expect(t.runtime.running).toBe(false);
    expect(t.toasts).not.toContain('old receipt');
    // Missing correlation also cannot revive a historical broadcast.
    t.controller.onReady({ ...ready(['right']), wiringId: 'uncorrelated' });
    expect(t.runtime.running).toBe(false);
    t.receiveReady({ ...ready(['right']), wiringId: 'new-request-wiring' });
    await wait(5);
    expect(t.controller.running).toBe(true);
    t.controller.reset();
  });

  it('shows a template or fixture source honestly and failures with their reason', () => {
    const t = setup();
    t.controller.ask('Surprise me', 'chip');
    t.receiveProgress(progress({ phase: 'writing', code: '// x', model: 'template', source: 'template', note: 'template wiring: no Meta model wrote this' }));
    t.controller.frame(finger(new Vector3(0, 1.4, -0.4)), clock += 200);
    expect(t.view()!.code).toMatchObject({ source: 'template', model: 'template' });
    t.receiveProgress(progress({ phase: 'failed', issues: ['uses fetch'] }));
    t.controller.frame(finger(new Vector3(0, 1.4, -0.4)), clock += 200);
    expect(t.view()).toMatchObject({ phase: 'failed', prompt: 'Could not wire that · try again' });
    expect(t.view()!.chips).toHaveLength(3);
    expect(t.toasts.some((m) => /uses fetch/.test(m))).toBe(true);
  });

  it('a program that is refused by the sandbox never runs and says why', () => {
    const t = setup();
    t.controller.ask('Touch the water', 'chip');
    t.receiveReady({ ...ready(['right']), code: "fetch('http://evil')" });
    expect(t.controller.phase).toBe('failed');
    expect(t.toasts.some((m) => /Muse's wiring stopped: refused: uses fetch/.test(m))).toBe(true);
  });

  it('withdraws a failed Worker once, preserves the failure, and ignores old readiness or release receipts after another ask', async () => {
    const t = setup(); t.controller.ask('Hands as knobs', 'chip'); const failedRequest = t.requestId()!;
    t.receiveReady({ ...ready(['right']), code: "mem.n = (mem.n || 0) + 1; out.set('p', 127); if (mem.n > 1) throw new Error('held-output failure');" });
    await wait(5);
    for (let i = 0; i < 8 && t.controller.running; i++) {
      t.controller.frame(finger(new Vector3(0, 1.4, -.4)), clock += 40); await wait(5);
    }
    expect(t.controls).toContainEqual(expect.objectContaining({ widgetId: 'wire:p', value: 127 }));
    expect(t.controller.phase).toBe('failed');
    expect(t.controller.running).toBe(false);
    expect(t.userStopped).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('held-output failure'), {
      cardId: 'visual-synth-mac', requestId: failedRequest, wiringId: 'w1',
    });
    t.controller.onReady({ ...ready(['right']), requestId: failedRequest, wiringId: 'late-after-failure' });
    expect(t.controller.running).toBe(false);
    t.controller.onStopped({ cardId: 'visual-synth-mac', requestId: failedRequest, wiringId: 'w1', ok: true, releaseConfirmed: false, reason: 'Release not confirmed' });
    expect(t.toasts).toContain('Release not confirmed');
    expect(t.controller.view('visual-synth-mac')?.code).toMatchObject({ phase: 'failed', phaseLine: expect.stringContaining('held-output failure') });
    expect(t.controller.ask('Surprise me', 'chip')).toBe(true);
    t.controller.onStopped({ cardId: 'visual-synth-mac', requestId: failedRequest, wiringId: 'w1', ok: false, reason: 'Retired receipt' });
    expect(t.toasts).not.toContain('Retired receipt'); expect(t.controller.phase).toBe('asked');
    t.controller.reset();
  });

  it('forgets the wiring when the device is deselected, not controllable or the server drops', async () => {
    const t = setup();
    t.controller.ask('Hands as knobs', 'chip');
    t.receiveReady(ready(['right']));
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
    expect(t.sent[0]).toEqual({ type: 'wire.request', payload: { cardId: 'visual-synth-mac', text: 'make the water follow my finger', source: 'voice', requestId: expect.any(String) } });
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
