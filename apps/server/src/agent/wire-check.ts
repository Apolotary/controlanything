/**
 * WIRE checks: what the server does to a wiring program Muse wrote before the headset may run it.
 *
 *   validateWiring: size, forbidden tokens, syntax (new vm.Script), literal action ids that belong to the driver.
 *   dryRun:         the program is executed in an empty node:vm context with a timeout, over synthetic signal traces
 *                   (a screen touch-drag, a two-hand height sweep, pinch taps, idle with no hands): it must not throw,
 *                   must average under 2 ms per frame, and must emit at least one valid action on a trace that matches
 *                   the signals it says it needs.
 *
 * Generated code never runs on the server except here (no globals, timeout, results read back as plain JSON) and never
 * on the Mac. The headset runs it in its own Web Worker sandbox (research/36-muse-wiring-contract.md).
 */
import vm from 'node:vm';
import type { Driver, DriverAction } from '@ce/protocol';

export const WIRE_MAX_BYTES = 4096;
/** Average CPU time one frame of a wiring program may take. */
export const WIRE_MAX_FRAME_MS = 2;
export const WIRE_TRACE_FRAMES = 120;
/** One trace may run this long in the vm before it is stopped (an endless loop). */
export const WIRE_TRACE_TIMEOUT_MS = 250;
const MAX_CALLS_PER_TRACE = 6000;

export type WireNeed = 'right' | 'left' | 'screen';
export const WIRE_NEEDS: readonly WireNeed[] = ['right', 'left', 'screen'];

/** The wearer-facing reason is the message; the pattern is what the validator looks for (comments are ignored). */
const FORBIDDEN: { token: string; re: RegExp }[] = [
  ...['import', 'require', 'fetch', 'XMLHttpRequest', 'WebSocket', 'eval', 'Function', 'globalThis', 'self', 'postMessage',
    'setTimeout', 'setInterval', 'document', 'window', 'navigator', 'location', 'this', 'constructor', '__proto__', 'prototype',
    // not on the contract's list, but meaningless or dangerous in a per-frame wiring program
    'setImmediate', 'requestAnimationFrame', 'queueMicrotask', 'importScripts', 'indexedDB', 'Worker', 'Reflect', 'Proxy',
    'Promise', 'async', 'await', 'console', 'process', 'global', 'Atomics', 'SharedArrayBuffer', 'WebAssembly', 'with', 'debugger',
  ].map((token) => ({ token, re: new RegExp(`(?<![\\w$.])${token}(?![\\w$])|\\.\\s*${token}(?![\\w$])`) })),
  { token: 'while(true)', re: /\bwhile\s*\(\s*(?:true|1|!0|!!1)\s*\)/ },
  { token: 'for(;;)', re: /\bfor\s*\(\s*;\s*;?\s*\)/ },
  { token: 'do…while(true)', re: /\bdo\s*\{[\s\S]*\}\s*while\s*\(\s*(?:true|1)\s*\)/ },
];

export interface WireIssue {
  /** machine-readable kind */
  code: string;
  /** one line the model (repair prompt) and the wearer can read */
  message: string;
}

export interface WireCheck {
  ok: boolean;
  issues: WireIssue[];
  /** literal action ids the program passes to out.set / out.trigger */
  used: string[];
  /** signals the program reads (s.right, s.left, s.screen) */
  reads: WireNeed[];
}

/** Comments out, strings kept; regular expression literals are reported (nothing in a wiring program needs one). */
export function stripComments(code: string): { text: string; regex: boolean } {
  let out = '';
  let regex = false;
  let prev = ''; // last significant (non-space) character kept
  for (let i = 0; i < code.length; i++) {
    const c = code[i]!;
    const n = code[i + 1];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < code.length && code[j] !== c) j += code[j] === '\\' ? 2 : 1;
      out += code.slice(i, j + 1);
      prev = c;
      i = j;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < code.length && code[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && n === '*') {
      const end = code.indexOf('*/', i + 2);
      out += ' ';
      i = end < 0 ? code.length : end + 1;
      continue;
    }
    if (c === '/' && (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev))) regex = true;
    out += c;
    if (!/\s/.test(c)) prev = c;
  }
  return { text: out, regex };
}

const ACTION_CALL = /\bout\s*\.\s*(set|trigger)\s*\(\s*([^,)]*)/g;
const LITERAL_ID = /^(['"`])([A-Za-z0-9_:-]{1,64})\1$/;

/** Signals a program reads: s.right, s.left, s.screen (dot, bracket or destructured). */
export function signalReads(code: string): WireNeed[] {
  const text = stripComments(code).text;
  const found = new Set<WireNeed>();
  for (const need of WIRE_NEEDS) {
    if (new RegExp(`\\bs\\s*\\.\\s*${need}\\b|\\bs\\s*\\[\\s*['"]${need}['"]\\s*\\]|\\{[^}]*\\b${need}\\b[^}]*\\}\\s*=\\s*s\\b`).test(text)) found.add(need);
  }
  return WIRE_NEEDS.filter((n) => found.has(n));
}

const kindOk = (call: 'set' | 'trigger', a: DriverAction): boolean => (call === 'set' ? a.kind === 'set' || a.kind === 'toggle' : a.kind === 'trigger' || a.kind === 'toggle');

/** Static checks. `driver` may be a bare action list (tests, prompts). */
export function validateWiring(code: string, driver: Pick<Driver, 'actions'>): WireCheck {
  const issues: WireIssue[] = [];
  const add = (c: string, message: string) => { if (!issues.some((i) => i.code === c && i.message === message)) issues.push({ code: c, message: message.slice(0, 200) }); };
  const bytes = Buffer.byteLength(code, 'utf8');
  if (!code.trim()) add('empty', 'the program is empty');
  if (bytes > WIRE_MAX_BYTES) add('too_long', `the program is ${bytes} bytes; the limit is ${WIRE_MAX_BYTES}: make it shorter`);

  const { text, regex } = stripComments(code);
  if (regex) add('regex', 'regular expression literals are not allowed; compare numbers and booleans instead');
  for (const f of FORBIDDEN) {
    if (f.re.test(text)) add('forbidden', `"${f.token}" is not allowed in a wiring program (no imports, network, timers, DOM, this, eval or loops that never end)`);
  }
  if (/\[\s*(?:'[^']*'|"[^"]*"|`[^`]*`)\s*\+|\+\s*(?:'[^']*'|"[^"]*"|`[^`]*`)\s*\]/.test(text)) {
    add('computed_key', 'property names built from strings (obj["a"+"b"]) are not allowed; use plain names');
  }

  // syntax: the body of function wire(s, out, mem), compiled alone so a stray "}" cannot close the wrapper early
  try {
    new vm.Script(`(function wire(s, out, mem) {\n${code}\n})`, { filename: 'wire.js' });
    vm.runInNewContext('new Function("s", "out", "mem", __code)', { __code: code }, { timeout: 100 });
  } catch (e) {
    const m = (e as Error).message ?? String(e);
    add('syntax', `syntax error: ${m.split('\n')[0]!.slice(0, 140)}`);
  }

  const byId = new Map(driver.actions.map((a) => [a.actionId, a]));
  const used = new Set<string>();
  let calls = 0;
  for (const m of text.matchAll(ACTION_CALL)) {
    calls++;
    const call = m[1] as 'set' | 'trigger';
    const arg = (m[2] ?? '').trim();
    const lit = LITERAL_ID.exec(arg);
    if (!lit) {
      add('id_not_literal', `out.${call}() needs the action id as a plain string, like out.${call}('${[...byId.keys()][0] ?? 'cc1'}'${call === 'set' ? ', value' : ''})`);
      continue;
    }
    const id = lit[2]!;
    const action = byId.get(id);
    if (!action) add('unknown_action', `"${id}" is not an action of this device; use only: ${[...byId.keys()].join(', ')}`);
    else if (!kindOk(call, action)) add('wrong_call', `${id} is a ${action.kind} action: use out.${action.kind === 'trigger' ? 'trigger' : 'set'}('${id}'${action.kind === 'trigger' ? '' : ', value'})`);
    else used.add(id);
  }
  if (!calls && code.trim()) add('no_output', 'the program never calls out.set(...) or out.trigger(...)');
  return { ok: issues.length === 0, issues, used: [...used], reads: signalReads(code) };
}

// --- synthetic signal traces ----------------------------------------------------------------------

export interface HandFrame {
  height: number; push: number; side: number; pinch: number; pinchTap: boolean;
  fist: boolean; open: boolean; palmOut: boolean; speed: number;
}
export interface ScreenFrame {
  u: number; v: number; inside: boolean; distance: number; touching: boolean; hover: number; vu: number; vv: number; hand: 'left' | 'right';
}
export interface SignalFrame { t: number; dt: number; right: HandFrame | null; left: HandFrame | null; screen: ScreenFrame | null }
export interface WireTrace { name: string; needs: WireNeed[]; frames: SignalFrame[] }

const DT = 1 / 60;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const hand = (o: Partial<HandFrame> = {}): HandFrame => ({ height: 0.5, push: 0.5, side: 0.5, pinch: 0, pinchTap: false, fist: false, open: true, palmOut: false, speed: 0, ...o });

/** Four deterministic traces of 120 frames: touch-drag (screen + right hand), height sweep (both hands), pinch taps, idle. */
export function buildTraces(frames = WIRE_TRACE_FRAMES): WireTrace[] {
  const n = frames;
  const range = (f: (i: number, k: number) => Partial<SignalFrame>): SignalFrame[] =>
    Array.from({ length: n }, (_, i) => ({ t: i * DT, dt: DT, right: null, left: null, screen: null, ...f(i, i / (n - 1)) }));
  const touchDrag = range((i, k) => {
    // approach (hover rises), touch and drag along an arc, lift
    const phase = k < 0.15 ? 'approach' : k < 0.85 ? 'drag' : 'lift';
    const g = clamp01((k - 0.15) / 0.7);
    const u = phase === 'approach' ? 0.2 : phase === 'drag' ? 0.2 + 0.6 * g : 0.8;
    const v = phase === 'approach' ? 0.3 : phase === 'drag' ? 0.3 + 0.4 * Math.sin(g * Math.PI * 0.5) : 0.7;
    const distance = phase === 'approach' ? 0.15 * (1 - k / 0.15) + 0.005 : phase === 'drag' ? 0.004 : 0.004 + ((k - 0.85) / 0.15) * 0.14;
    const touching = distance < 0.02;
    const hover = clamp01(1 - distance / 0.15);
    return {
      right: hand({ height: 0.55 + 0.1 * v, push: 0.85, side: u, speed: phase === 'drag' ? 0.3 : 0.05 }),
      screen: { u, v, inside: true, distance, touching, hover, vu: phase === 'drag' ? 0.6 / 1.2 : 0, vv: phase === 'drag' ? 0.3 : 0, hand: 'right' },
    };
  });
  const heightSweep = range((i, k) => {
    const h = k < 0.5 ? k * 2 : 2 - k * 2;
    return {
      right: hand({ height: h, push: 0.3 + 0.4 * h, side: 0.6, speed: 0.4 }),
      left: hand({ height: 1 - h, push: 0.5, side: 0.35, speed: 0.4, open: false, fist: i % 40 > 20 }),
    };
  });
  const taps = new Set([20, 80]);
  const leftTaps = new Set([50, 110]);
  const pinchTap = range((i, k) => {
    const near = (set: Set<number>) => [...set].some((t) => Math.abs(i - t) <= 3);
    return {
      right: hand({ height: 0.4 + 0.2 * k, push: 0.6, side: 0.55, pinch: near(taps) ? 1 : 0.05, pinchTap: taps.has(i), speed: 0.1 }),
      left: hand({ height: 0.45, push: 0.5, side: 0.3, pinch: near(leftTaps) ? 1 : 0.05, pinchTap: leftTaps.has(i), speed: 0.1 }),
    };
  });
  const idle = range(() => ({}));
  return [
    { name: 'touch-drag', needs: ['screen', 'right'], frames: touchDrag },
    { name: 'height-sweep', needs: ['right', 'left'], frames: heightSweep },
    { name: 'pinch-tap', needs: ['right', 'left'], frames: pinchTap },
    { name: 'idle', needs: [], frames: idle },
  ];
}

// --- dry run --------------------------------------------------------------------------------------

export interface DryRunEmit { actionId: string; call: 'set' | 'trigger'; value: number | boolean; frame: number; trace: string }
export interface DryRunResult {
  ok: boolean;
  issues: WireIssue[];
  frames: number;
  /** distinct valid actions emitted over all traces */
  actions: string[];
  /** emitted value spread per set action */
  spread: Record<string, { min: number; max: number; count: number }>;
  perFrameMs: number;
  traces: { name: string; emits: number; errors: string[] }[];
  /** "dry-run ✓ 480 frames · 3 actions" or the failure summary */
  note: string;
}

const HARNESS = `
var __wire = new Function('s', 'out', 'mem', __code);
var __run = function (traceJson) {
  var frames = JSON.parse(traceJson);
  var mem = {}, calls = [], errors = [], cur = 0;
  var out = {
    set: function (id, v) { if (calls.length >= ${MAX_CALLS_PER_TRACE}) throw new Error('too many out calls in one trace'); calls.push([cur, 0, String(id), typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'number' ? (isFinite(v) ? v : String(v)) : typeof v, typeof v]); },
    trigger: function (id) { if (calls.length >= ${MAX_CALLS_PER_TRACE}) throw new Error('too many out calls in one trace'); calls.push([cur, 1, String(id), 1, 'number']); }
  };
  for (var i = 0; i < frames.length; i++) {
    cur = i;
    try { __wire(frames[i], out, mem); }
    catch (e) { errors.push('frame ' + i + ': ' + String(e && e.message ? e.message : e).slice(0, 120)); if (errors.length >= 3) break; }
  }
  return JSON.stringify({ calls: calls, errors: errors });
};
`;

function relevant(trace: WireTrace, needs: WireNeed[]): boolean {
  if (!needs.length) return trace.name !== 'idle';
  return needs.some((n) => trace.needs.includes(n));
}

/**
 * Run `code` over the traces in an empty vm context. `needs` picks the traces whose emits count for "emits at least one
 * valid action"; every trace still has to run without errors. Pure and synchronous (about 1 ms of CPU per trace).
 */
export function dryRun(code: string, driver: Pick<Driver, 'actions'>, needs: WireNeed[], traces: WireTrace[] = buildTraces(), opts: { maxFrameMs?: number } = {}): DryRunResult {
  const maxFrameMs = opts.maxFrameMs ?? WIRE_MAX_FRAME_MS;
  const issues: WireIssue[] = [];
  const add = (c: string, message: string) => { if (!issues.some((i) => i.message === message)) issues.push({ code: c, message: message.slice(0, 200) }); };
  const byId = new Map(driver.actions.map((a) => [a.actionId, a]));
  const spread: DryRunResult['spread'] = {};
  const valid = new Set<string>();
  const traceRows: DryRunResult['traces'] = [];
  let relevantEmits = 0;
  let frames = 0;
  let cpuMs = 0;
  let context: vm.Context | undefined;
  try {
    context = vm.createContext(Object.create(null), { codeGeneration: { strings: true, wasm: false } });
    (context as Record<string, unknown>).__code = code;
    vm.runInContext(HARNESS, context, { filename: 'wire-harness.js', timeout: 100 });
  } catch (e) {
    add('syntax', `could not load the program: ${((e as Error).message ?? String(e)).split('\n')[0]!.slice(0, 140)}`);
    return { ok: false, issues, frames: 0, actions: [], spread, perFrameMs: 0, traces: [], note: `dry-run ✗ ${issues[0]!.message}` };
  }
  for (const trace of traces) {
    const json = JSON.stringify(trace.frames);
    (context as Record<string, unknown>).__trace = json;
    let raw: string;
    const cpu0 = process.cpuUsage();
    try {
      raw = vm.runInContext('__run(__trace)', context, { filename: 'wire-run.js', timeout: WIRE_TRACE_TIMEOUT_MS }) as string;
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      add('timeout', /timed out/i.test(msg) ? `the program ran longer than ${WIRE_TRACE_TIMEOUT_MS} ms on the "${trace.name}" trace (an endless or very heavy loop)` : `the program failed on the "${trace.name}" trace: ${msg.split('\n')[0]!.slice(0, 120)}`);
      traceRows.push({ name: trace.name, emits: 0, errors: [msg.slice(0, 120)] });
      break;
    }
    const used = process.cpuUsage(cpu0);
    cpuMs += (used.user + used.system) / 1000;
    frames += trace.frames.length;
    const parsed = JSON.parse(raw) as { calls: [number, 0 | 1, string, number, string][]; errors: string[] };
    let emits = 0;
    for (const [frame, kind, id, value, typ] of parsed.calls) {
      const action = byId.get(id);
      const call = kind === 0 ? 'set' : 'trigger';
      if (!action) { add('unknown_action', `the program used "${id}", which is not an action of this device (${[...byId.keys()].join(', ')})`); continue; }
      if (!kindOk(call, action)) { add('wrong_call', `${id} is a ${action.kind} action; the program called out.${call}()`); continue; }
      if (call === 'set' && (typeof value !== 'number' || !Number.isFinite(value) || (typ !== 'number' && typ !== 'boolean'))) {
        add('bad_value', `out.set('${id}', …) got ${String(value)} on frame ${frame}; give a finite number inside ${action.range ? `${action.range.min}–${action.range.max}` : 'its range'}`);
        continue;
      }
      emits++;
      valid.add(id);
      if (call === 'set') {
        const s = (spread[id] ??= { min: Infinity, max: -Infinity, count: 0 });
        s.min = Math.min(s.min, value); s.max = Math.max(s.max, value); s.count++;
      }
    }
    if (relevant(trace, needs)) relevantEmits += emits;
    traceRows.push({ name: trace.name, emits, errors: parsed.errors });
    for (const err of parsed.errors) add('threw', `the program threw on the "${trace.name}" trace (${err}). Guard null hands: s.right, s.left and s.screen can be null`);
  }
  const perFrameMs = frames ? cpuMs / frames : 0;
  if (perFrameMs >= maxFrameMs) add('slow', `the program took ${perFrameMs.toFixed(2)} ms per frame; the limit is ${maxFrameMs} ms: remove loops and heavy maths`);
  if (!issues.length && !relevantEmits) {
    add('silent', `the program emitted no action on the traces for ${needs.length ? needs.join(' + ') : 'the signals'}; check that it reads those signals and calls out.set(...)`);
  }
  // a 0..1 value into a 0..127 range is the classic slip: the Mac would hardly move
  for (const [id, s] of Object.entries(spread)) {
    const r = byId.get(id)?.range;
    if (r && r.max - r.min >= 10 && s.count >= 5 && s.max <= r.min + 0.02 * (r.max - r.min) && s.max > s.min) {
      add('scale', `${id} only reached ${s.max.toFixed(2)} but its range is ${r.min}–${r.max}: scale the value into the range`);
    }
  }
  const ok = issues.length === 0;
  const actions = [...valid];
  return {
    ok, issues, frames, actions, spread, perFrameMs, traces: traceRows,
    note: ok ? `dry-run ✓ ${frames} frames · ${actions.length} action${actions.length === 1 ? '' : 's'}` : `dry-run ✗ ${issues[0]!.message}`.slice(0, 160),
  };
}

/** needs = what the program actually reads, plus what it declared if that is a real signal. */
export function resolveNeeds(declared: readonly string[] | undefined, reads: WireNeed[]): WireNeed[] {
  const set = new Set<WireNeed>(reads);
  for (const d of declared ?? []) if ((WIRE_NEEDS as readonly string[]).includes(d)) set.add(d as WireNeed);
  return WIRE_NEEDS.filter((n) => set.has(n));
}

export const issueLines = (issues: WireIssue[]): string[] => issues.map((i) => i.message);
