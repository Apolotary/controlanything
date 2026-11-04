import type { DriverAction } from '@ce/protocol';
import { describe, expect, it } from 'vitest';
import { buildTraces, dryRun, resolveNeeds, signalReads, stripComments, validateWiring, WIRE_MAX_BYTES } from './wire-check';

const set = (actionId: string, min = 0, max = 127): DriverAction => ({
  actionId, label: actionId, kind: 'set', range: { min, max, step: 1 }, encode: { kind: 'midi', msg: 'cc', channel: 1, number: Number(actionId.replace(/\D/g, '')) || 1, value: '$value' }, expect: { sense: 'camera', effect: 'any' },
});
const trigger = (actionId: string): DriverAction => ({ actionId, label: actionId, kind: 'trigger', encode: { kind: 'midi', msg: 'pc', channel: 1, number: 0 }, expect: { sense: 'camera', effect: 'any' } });
const driver = { actions: [set('cc22'), set('cc23'), set('cc24'), set('cc71'), trigger('pattern0')] };

const TOUCH = `// Touch the water: the fingertip is the ripple.
const t = s.screen;
if (t && t.inside) {
  out.set('cc22', t.u * 127);
  out.set('cc23', t.v * 127);
  out.set('cc24', t.touching ? 100 : t.hover * 30);
  mem.on = true;
} else if (mem.on) {
  out.set('cc24', 0);
  mem.on = false;
}`;

describe('stripComments', () => {
  it('drops comments but keeps strings, and flags regular expression literals', () => {
    expect(stripComments("a = 1; // this is fine\nb = 'this // stays'; /* eval */ c = 2").text).not.toMatch(/fine|eval/);
    expect(stripComments("b = 'this // stays'").text).toContain("'this // stays'");
    expect(stripComments('x = 4 / 2; y = a / b').regex).toBe(false);
    expect(stripComments('x = /\\//.test(a)').regex).toBe(true);
  });
});

describe('validateWiring', () => {
  it('accepts a touch program and reports the actions and signals it uses', () => {
    const r = validateWiring(TOUCH, driver);
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.used.sort()).toEqual(['cc22', 'cc23', 'cc24']);
    expect(r.reads).toEqual(['screen']);
  });

  it('rejects a program over 4 KB', () => {
    const r = validateWiring(`out.set('cc22', 1);\n// ${'x'.repeat(WIRE_MAX_BYTES)}`, driver);
    expect(r.issues.map((i) => i.code)).toContain('too_long');
  });

  it.each([
    'import', 'require', 'fetch', 'XMLHttpRequest', 'WebSocket', 'eval', 'Function', 'globalThis', 'self', 'postMessage', 'setTimeout', 'setInterval', 'document', 'window', 'this', 'constructor', '__proto__', 'prototype',
  ])('rejects the forbidden token %s', (token) => {
    const bodies: Record<string, string> = {
      import: "import('x');", require: "require('fs');", fetch: "fetch('/x');", XMLHttpRequest: 'new XMLHttpRequest();', WebSocket: "new WebSocket('ws://x');", eval: "eval('1');",
      Function: "Function('return 1')();", globalThis: 'globalThis.x = 1;', self: 'self.x = 1;', postMessage: 'postMessage(1);', setTimeout: 'setTimeout(() => 1, 1);',
      setInterval: 'setInterval(() => 1, 1);', document: 'document.title = 1;', window: 'window.x = 1;', this: 'const t = this;', constructor: 's.constructor;', ['__proto__']: 'mem.__proto__ = {};', prototype: 'Object.prototype.x = 1;',
    };
    const r = validateWiring(`${bodies[token]}\nout.set('cc22', 1);`, driver);
    expect(r.ok, token).toBe(false);
    expect(r.issues.some((i) => i.code === 'forbidden' && i.message.includes(token)), token).toBe(true);
  });

  it('rejects endless loops, computed names built from strings and regex literals', () => {
    expect(validateWiring("while (true) { }\nout.set('cc22', 1);", driver).issues.some((i) => i.message.includes('while(true)'))).toBe(true);
    expect(validateWiring("for (;;) { }\nout.set('cc22', 1);", driver).issues.some((i) => i.message.includes('for(;;)'))).toBe(true);
    expect(validateWiring("const k = s['con' + 'structor'];\nout.set('cc22', 1);", driver).issues.map((i) => i.code)).toContain('computed_key');
    expect(validateWiring("if (/a\\//.test('x')) out.set('cc22', 1);", driver).issues.map((i) => i.code)).toContain('regex');
  });

  it('ignores forbidden words inside comments', () => {
    const r = validateWiring("// this follows the finger; no fetch, no window\nout.set('cc22', 1);", driver);
    expect(r.issues).toEqual([]);
  });

  it('rejects syntax errors, including a stray brace that would close the wrapper', () => {
    expect(validateWiring("out.set('cc22', ;", driver).issues.map((i) => i.code)).toContain('syntax');
    const escape = validateWiring("out.set('cc22', 1); } function evil() { ", driver);
    expect(escape.issues.map((i) => i.code)).toContain('syntax');
  });

  it('only accepts action ids of the driver, as plain strings, with the right call', () => {
    expect(validateWiring("out.set('cc99', 1);", driver).issues.map((i) => i.code)).toContain('unknown_action');
    expect(validateWiring("const id = 'cc22'; out.set(id, 1);", driver).issues.map((i) => i.code)).toContain('id_not_literal');
    expect(validateWiring("out.trigger('cc22');", driver).issues.map((i) => i.code)).toContain('wrong_call');
    expect(validateWiring("out.set('pattern0', 1);", driver).issues.map((i) => i.code)).toContain('wrong_call');
    expect(validateWiring('const x = 1;', driver).issues.map((i) => i.code)).toContain('no_output');
  });
});

describe('signalReads / resolveNeeds', () => {
  it('finds the signals a program reads and merges them with the declared needs', () => {
    expect(signalReads('const r = s.right; if (s.screen) {}')).toEqual(['right', 'screen']);
    expect(signalReads("const { left } = s; s['screen']")).toEqual(['left', 'screen']);
    expect(resolveNeeds(['right', 'bogus'], ['screen'])).toEqual(['right', 'screen']);
  });
});

describe('dryRun', () => {
  it('has four traces of 120 frames', () => {
    const traces = buildTraces();
    expect(traces.map((t) => t.name)).toEqual(['touch-drag', 'height-sweep', 'pinch-tap', 'idle']);
    expect(traces.every((t) => t.frames.length === 120)).toBe(true);
    expect(traces[3]!.frames.every((f) => f.right === null && f.left === null && f.screen === null)).toBe(true);
    const touching = traces[0]!.frames.filter((f) => f.screen?.touching).length;
    expect(touching).toBeGreaterThan(60);
    expect(traces[2]!.frames.filter((f) => f.right?.pinchTap).length).toBe(2);
  });

  it('runs a touch program over all traces and reports the actions it emitted', () => {
    const r = dryRun(TOUCH, driver, ['screen']);
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.frames).toBe(480);
    expect(r.actions.sort()).toEqual(['cc22', 'cc23', 'cc24']);
    expect(r.note).toBe('dry-run ✓ 480 frames · 3 actions');
    expect(r.perFrameMs).toBeLessThan(2);
    expect(r.spread.cc22!.max).toBeGreaterThan(100);
  });

  it('is silent on idle: a hands-only program emits nothing without hands', () => {
    const code = "const r = s.right; if (r) out.set('cc71', r.height * 127);";
    const r = dryRun(code, driver, ['right']);
    expect(r.ok).toBe(true);
    expect(r.traces.find((t) => t.name === 'idle')!.emits).toBe(0);
  });

  it('flags a program that throws when a hand is missing', () => {
    const r = dryRun("out.set('cc71', s.right.height * 127);", driver, ['right']);
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toContain('threw');
    expect(r.issues[0]!.message).toMatch(/null/);
  });

  it('stops an endless loop with the vm timeout', () => {
    const t0 = Date.now();
    const r = dryRun("for (let i = 0; i < 1e12; i++) {}\nout.set('cc71', 1);", driver, ['right']);
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toContain('timeout');
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('rejects a program slower than the per-frame budget (2 ms by default)', () => {
    // a heavy program: either it averages over 2 ms, or it runs out the 250 ms trace timeout; both are rejections
    const heavy = dryRun("let x = 0; for (let i = 0; i < 6e6; i++) x += i; out.set('cc71', x % 127);", driver, ['right']);
    expect(heavy.ok).toBe(false);
    expect(heavy.issues.map((i) => i.code).some((c) => c === 'slow' || c === 'timeout')).toBe(true);
    // the budget itself: a trivial program passes at 2 ms and fails at an impossible 0.00001 ms
    const light = "if (s.right) out.set('cc71', s.right.height * 127);";
    expect(dryRun(light, driver, ['right']).ok).toBe(true);
    const tight = dryRun(light, driver, ['right'], buildTraces(), { maxFrameMs: 0.00001 });
    expect(tight.ok).toBe(false);
    expect(tight.issues.map((i) => i.code)).toContain('slow');
  });

  it('requires an action on a trace that matches the needs', () => {
    const r = dryRun("if (s.screen) out.set('cc22', s.screen.u * 127);", driver, ['screen']);
    expect(r.ok).toBe(true);
    const silent = dryRun("if (s.left && s.left.fist && s.left.palmOut) out.set('cc22', 1);", driver, ['left']);
    expect(silent.issues.map((i) => i.code)).toContain('silent');
  });

  it('flags non-finite values, unknown ids and a 0..1 value for a 0..127 range', () => {
    expect(dryRun("out.set('cc71', s.right ? s.right.nothing * 2 : 0);", driver, ['right']).issues.map((i) => i.code)).toContain('bad_value');
    expect(dryRun("out.set('nope', 1);", driver, ['right']).issues.map((i) => i.code)).toContain('unknown_action');
    const scaled = dryRun("if (s.right) out.set('cc71', s.right.height);", driver, ['right']);
    expect(scaled.issues.map((i) => i.code)).toContain('scale');
  });

  it('records triggers from pinch taps', () => {
    const r = dryRun("if (s.right && s.right.pinchTap) out.trigger('pattern0');", driver, ['right']);
    expect(r.ok).toBe(true);
    expect(r.actions).toEqual(['pattern0']);
  });

  it('keeps host objects out of the program: the context has no globals', () => {
    const r = dryRun("out.set('cc71', typeof process === 'undefined' && typeof require === 'undefined' ? 100 : 0);", driver, ['right']);
    expect(r.spread.cc71!.max).toBe(100);
    // the classic vm escape through a host-created argument reaches nothing: s and out are built inside the context
    const esc = dryRun("let p; try { p = typeof out.set.constructor('return process')(); } catch (e) { p = 'blocked'; }\nout.set('cc71', p === 'undefined' || p === 'blocked' ? 100 : 0);", driver, ['right']);
    expect(esc.spread.cc71!.max).toBe(100);
  });
});
