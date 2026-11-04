import { describe, expect, it, vi } from 'vitest';
import type { WireAction } from '@ce/protocol';
import type { Signals } from '../gestures/signals';
import { fakeWorkerFactory } from './fake-worker.test-support';
import { checkWiringCode, OutputGate, WiringRuntime, WORKER_SOURCE, WIRING_LIMITS, type StopKind, type WireEmit, type WiringProgram } from './runtime';

const action = (actionId: string, extra: Partial<WireAction> = {}): WireAction => ({ actionId, label: actionId, kind: 'set', min: 0, max: 127, ...extra });
const program = (code: string, actions: WireAction[] = [action('a')]): WiringProgram => ({
  wiringId: 'w1', cardId: 'c1', code, title: 't', explanation: 'e', model: 'muse-spark-1.3', source: 'fixture', actions,
});
const signals = (over: Partial<Signals> = {}): Signals => ({ t: 0, dt: 1 / 60, right: null, left: null, screen: null, ...over });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('checkWiringCode', () => {
  it('accepts a normal program and ignores forbidden words inside comments and strings', () => {
    expect(checkWiringCode("const h = s.right ? s.right.height : 0;\nout.set('a', h * 127);")).toBeNull();
    expect(checkWiringCode("// we never use fetch or this here\nout.set('a', 1); const label = 'import this';")).toBeNull();
  });
  it('refuses the contract list', () => {
    for (const bad of ['fetch("x")', 'import("x")', 'require("fs")', 'new WebSocket("ws://x")', 'XMLHttpRequest', 'eval("1")', 'new Function("return 1")', 'globalThis.x', 'self.x', 'postMessage(1)',
      'setTimeout(() => {}, 1)', 'document.title', 'window.x', 'navigator.storage', 'location.href', 'this.x', 'while (true) {}', 'for (;;) {}', 'importScripts("x")']) {
      expect(checkWiringCode(bad), bad).toMatch(/^uses /);
    }
    expect(checkWiringCode('')).toBe('empty program');
    expect(checkWiringCode('x'.repeat(9000))).toMatch(/characters/);
  });
});

describe('OutputGate', () => {
  it('drops unknown actions, clamps to the range, rounds, and keeps only the latest value per rate window', () => {
    const gate = new OutputGate([action('a', { maxRateHz: 10 }), action('p', { min: 0, max: 1, maxRateHz: 120 })]);
    gate.set('nope', 1);
    expect(gate.dropped).toBe(1);
    gate.set('a', 500); gate.set('a', 200);
    expect(gate.flush(0)).toEqual([{ widgetId: 'wire:a', value: 127, phase: 'move' }]);
    gate.set('a', 64);
    expect(gate.flush(50)).toEqual([]);          // 10 Hz: 100 ms between sends
    gate.set('a', 65); gate.set('a', 70);
    expect(gate.flush(101)).toEqual([{ widgetId: 'wire:a', value: 70, phase: 'move' }]);
    gate.set('p', -3);
    expect(gate.flush(101)[0]).toMatchObject({ widgetId: 'wire:p', value: 0 });
    gate.set('a', NaN); gate.set('a', 'x');
    expect(gate.flush(1000)).toEqual([]);
  });
  it('does not resend an unchanged value and rate-limits triggers', () => {
    const gate = new OutputGate([action('a'), { actionId: 't', label: 't', kind: 'trigger', maxRateHz: 4 }, { actionId: 'on', label: 'on', kind: 'toggle' }]);
    gate.set('a', 10); expect(gate.flush(0)).toHaveLength(1);
    gate.set('a', 10); expect(gate.flush(100)).toEqual([]);
    expect(gate.trigger('t', 0)).toMatchObject({ widgetId: 'wire:t', value: true, phase: 'end' });
    expect(gate.trigger('t', 100)).toBeNull();
    expect(gate.trigger('t', 260)).not.toBeNull();
    expect(gate.trigger('a', 500)).toBeNull();           // a continuous action is not a trigger
    gate.set('t', 1); expect(gate.flush(900)).toEqual([]); // and a trigger is not a value
    gate.set('on', 1); expect(gate.flush(900)).toEqual([{ widgetId: 'wire:on', value: true, phase: 'end' }]);
  });
  it('force-flushes the lift-off values ignoring the rate limit', () => {
    const gate = new OutputGate([action('a', { maxRateHz: 1 })]);
    gate.set('a', 100); gate.flush(0);
    gate.set('a', 0);
    expect(gate.flush(10)).toEqual([]);
    expect(gate.flush(10, true)).toEqual([{ widgetId: 'wire:a', value: 0, phase: 'end' }]);
  });
});

describe('worker script', () => {
  function boot() {
    const log: { posted: unknown[]; scope?: Record<string, unknown> } = { posted: [] };
    fakeWorkerFactory(log)(WORKER_SOURCE);
    const scope = log.scope!;
    const send = (data: unknown) => (scope.onmessage as (e: unknown) => void)({ data });
    return { log, scope, send };
  }
  it('removes every way out before the program is compiled, and wraps postMessage', () => {
    const { log, send } = boot();
    send({ type: 'init', actions: ['a'], code: `
      const probe = {};
      for (const n of ['fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts', 'indexedDB', 'caches', 'Worker']) probe[n] = typeof globalThis[n];
      mem.probe = probe;
      out.set('a', 1);` });
    expect(log.posted.at(-1)).toEqual({ type: 'ready' });
  });
  it('runs the program once per tick, passes mem between calls, and reports outputs and the time taken', () => {
    const { log, send } = boot();
    send({ type: 'init', actions: ['a', 'b'], code: "mem.n = (mem.n || 0) + 1; out.set('a', mem.n); out.set('zzz', 5); out.trigger('b'); out.trigger('nope');" });
    send({ type: 'tick', seq: 1, s: signals() }); send({ type: 'tick', seq: 2, s: signals() });
    const outs = log.posted.filter((m) => (m as { type: string }).type === 'out') as { seq: number; sets: Record<string, number>; trigs: string[]; ms: number; err: string | null }[];
    expect(outs).toHaveLength(2);
    expect(outs[0]).toMatchObject({ seq: 1, sets: { a: 1 }, trigs: ['b'], err: null });
    expect(outs[1]!.sets).toEqual({ a: 2 });
    expect(outs[1]!.ms).toBeGreaterThanOrEqual(0);
  });
  it('the program cannot reach the network or post messages', () => {
    const { log, send, scope } = boot();
    send({ type: 'init', actions: ['a'], code: "const t = typeof fetch + typeof WebSocket + typeof XMLHttpRequest + typeof indexedDB; out.set('a', t === 'undefinedundefinedundefinedundefined' ? 1 : 0); postMessage({ type: 'out', sets: { a: 99 } });" });
    log.posted.length = 0;
    send({ type: 'tick', seq: 1, s: signals() });
    expect(log.posted).toHaveLength(1);
    expect((log.posted[0] as { sets: Record<string, number> }).sets).toEqual({ a: 1 });
    expect(scope.fetch).toBeUndefined();
    for (const key of ['navigator', 'location', 'setTimeout', 'setInterval', 'queueMicrotask']) expect(scope[key]).toBeUndefined();
  });
  it('reports a throw and a syntax error without dying', () => {
    const { log, send } = boot();
    send({ type: 'init', actions: ['a'], code: 'out.set(' });
    expect(log.posted.at(-1)).toMatchObject({ type: 'error' });
    send({ type: 'init', actions: ['a'], code: 'null.x' });
    send({ type: 'tick', seq: 3, s: signals() });
    expect(log.posted.at(-1)).toMatchObject({ type: 'out', seq: 3 });
    expect((log.posted.at(-1) as { err: string }).err).toMatch(/null|Cannot read/);
  });
});

describe('WiringRuntime', () => {
  function make(code: string, actions?: WireAction[], opts: { reply?: boolean } = {}) {
    const sent: WireEmit[] = [], stops: { reason: string; kind: StopKind }[] = [];
    const rt = new WiringRuntime({ send: (e) => { sent.push(e); return true; }, onStop: (reason, kind) => stops.push({ reason, kind }), createWorker: fakeWorkerFactory({ posted: [] }, opts) });
    const err = rt.start(program(code, actions));
    return { rt, sent, stops, err };
  }
  /** one frame: tick and let the worker answer */
  const frame = async (rt: WiringRuntime, s: Signals = signals()) => { rt.tick(s); await wait(2); };

  it('starts, ticks the program every frame and sends clamped outputs as wire:<id>', async () => {
    const { rt, sent, err } = make("out.set('a', s.right ? s.right.height * 200 : 0);");
    expect(err).toBeNull();
    await wait(5);
    expect(rt.ready).toBe(true);
    await frame(rt, signals({ right: { height: 0.5, push: 0, side: 0, pinch: 0, pinchTap: false, fist: false, open: false, palmOut: false, speed: 0 } }));
    await frame(rt);
    expect(sent[0]).toEqual({ widgetId: 'wire:a', value: 100, phase: 'move' });
    expect(rt.stats.ticks).toBeGreaterThanOrEqual(1);
    rt.stop('test', 'user', false);
  });

  it('refuses a program with a forbidden word without starting a worker', () => {
    const { err, stops, rt } = make("fetch('http://x')");
    expect(err).toMatch(/refused: uses fetch/);
    expect(stops[0]).toMatchObject({ kind: 'refused' });
    expect(rt.running).toBe(false);
  });

  it('three throws stop it with a reason', async () => {
    const { rt, stops } = make("throw new Error('boom');");
    await wait(5);
    for (let i = 0; i < 6 && rt.running; i++) await frame(rt);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ kind: 'error' });
    expect(stops[0]!.reason).toMatch(/boom/);
    expect(rt.running).toBe(false);
  });

  it('three overruns stop it', async () => {
    const { rt, stops } = make('const t = Date.now(); while (Date.now() - t < 30) {}');
    await wait(5);
    for (let i = 0; i < 8 && rt.running; i++) await frame(rt);
    expect(stops[0]).toMatchObject({ kind: 'overrun' });
    expect(stops[0]!.reason).toMatch(/ms/);
  });

  it('a call that never returns is terminated by the watchdog', async () => {
    const stopped: { reason: string; kind: StopKind }[] = [];
    const log = { posted: [] as unknown[] };
    const rt = new WiringRuntime({ send: () => true, onStop: (reason, kind) => stopped.push({ reason, kind }), createWorker: fakeWorkerFactory(log, { reply: false }) });
    rt.start(program('out.set("a", 1);'));
    await wait(5);
    expect(rt.ready).toBe(true);
    rt.tick(signals());
    await wait(WIRING_LIMITS.watchdogMs + 120);
    expect(stopped).toEqual([{ reason: expect.stringContaining('did not return'), kind: 'watchdog' }]);
    expect(rt.running).toBe(false);
  });

  it('stop runs the program one last time with no hands so it can lift', async () => {
    const { rt, sent, stops } = make("if (!s.screen) out.set('a', 0); else out.set('a', 127);");
    await wait(5);
    await frame(rt, signals({ screen: { u: 0.5, v: 0.5, inside: true, distance: 0, touching: true, hover: 1, vu: 0, vv: 0, hand: 'right' } }));
    await frame(rt);
    expect(sent.at(-1)).toMatchObject({ value: 127 });
    rt.stop('both palms out', 'user', true);
    await wait(20);
    expect(sent.at(-1)).toEqual({ widgetId: 'wire:a', value: 0, phase: 'end' });
    expect(stops).toEqual([{ reason: 'both palms out', kind: 'user' }]);
    expect(rt.running).toBe(false);
  });

  it('a new start replaces a running program', async () => {
    const { rt } = make("out.set('a', 1);");
    await wait(5);
    expect(rt.start(program("out.set('a', 2);"))).toBeNull();
    await wait(5);
    expect(rt.ready).toBe(true);
    rt.stop('done', 'user', false);
  });
});

vi.setConfig({ testTimeout: 10_000 });
