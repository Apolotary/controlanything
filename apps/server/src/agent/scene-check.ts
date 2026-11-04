/**
 * XR scene checks: what the server does to an interactive visualization Muse wrote before the headset may run it.
 *
 * A scene program is the BODY of `scene(s, draw, mem)`. The headset runs it every frame in a sandboxed Web Worker with
 * the wearer's hands, head and the wiring's latest values, and draws what it emits (glowing points, spheres, boxes,
 * rings, lines, trails, a few labels) in the real room. Nothing it writes can reach the DOM, the network or the Mac.
 *
 *   validateScene: size, forbidden tokens (same list as hand programs), syntax, must call draw.*.
 *   dryRunScene:   runs it in an empty node:vm context over synthetic traces (no hands, a right-hand sweep, two palms
 *                  pushing and pinching, a value sweep): it must not throw, must draw something, must keep coordinates
 *                  finite and must stay under the per-frame time budget. Hand and value reactivity are reported.
 */
import vm from 'node:vm';
import { FORBIDDEN, stripComments, type WireIssue } from './wire-check';

export const SCENE_MAX_BYTES = 8192;
/** Per-frame caps on the headset; calls past a cap are dropped there. */
export const SCENE_LIMITS = { points: 4000, spheres: 300, boxes: 300, rings: 200, lines: 800, trails: 16, trailPoints: 64, texts: 6, textChars: 24 } as const;
/** Average CPU per frame in the dry run (the headset strikes at 8 ms in its own worker). */
export const SCENE_MAX_FRAME_MS = 4;
const TRACE_FRAMES = 60;
const TRACE_TIMEOUT_MS = 1500;

/** The API Muse writes against (also in the agent prompt). Keep in step with apps/quest/src/wiring/scene-runtime.ts. */
export const SCENE_API = `scene(s, draw, mem) runs every frame (~72 Hz) on the headset; mem persists between frames.
Coordinates: metres around the scene anchor (about 0.55 m in front of the wearer at chest height): +x = wearer's right, +y = up, +z = toward the wearer. Everything glows additively over the real room (passthrough): black is invisible, bright saturated colours read best.
interface S {
  t: number; dt: number;                       // seconds since start, frame time
  head: {x,y,z};                               // the wearer's eyes (usually about (0, 0.3, 0.55))
  device: {x,y,z} | null;                      // the selected real object's centre
  right: Hand | null; left: Hand | null;       // null while not tracked: guard it
  values: { [actionId]: number };              // latest values the wearer's AR controls / hand program sent (may be empty)
}
interface Hand {
  x,y,z;                                       // palm centre
  tip: {x,y,z}; thumb: {x,y,z};                // index fingertip, thumb tip
  tips: number[];                              // 15 numbers: thumb, index, middle, ring, pinky tip x,y,z
  vx,vy,vz, speed;                             // palm velocity (m/s)
  nx,ny,nz;                                    // palm normal (where the palm faces)
  pinch: number /*0..1*/; pinchTap: boolean; fist: boolean; open: boolean; palmOut: boolean;
}
draw.point(x,y,z, size, color, alpha)          // soft glowing dot, size = diameter in m (0.004..0.05). Up to ${SCENE_LIMITS.points}/frame
draw.sphere(x,y,z, r, color, alpha)            // glowing orb, up to ${SCENE_LIMITS.spheres}
draw.box(x,y,z, sx,sy,sz, color, alpha, rotY)  // up to ${SCENE_LIMITS.boxes}
draw.ring(x,y,z, r, color, alpha, flat)        // flat=true lies horizontal, else faces the wearer; up to ${SCENE_LIMITS.rings}
draw.line(x1,y1,z1, x2,y2,z2, color, alpha)    // up to ${SCENE_LIMITS.lines}
draw.trail(key, x,y,z, color, size)            // call every frame: a fading glowing trail (up to ${SCENE_LIMITS.trails} keys, ${SCENE_LIMITS.trailPoints} points each)
draw.text(x,y,z, text, color, size)            // at most ${SCENE_LIMITS.texts} short labels (<= ${SCENE_LIMITS.textChars} chars), size = letter height in m (0.02)
draw.hsl(h, s, l) -> color (h 0..1);  draw.noise(x,y,z) -> -1..1 smooth noise
color = 0xRRGGBB or '#rrggbb'; alpha 0..1 (default 1).`;

export interface SceneDryRun {
  ok: boolean;
  issues: WireIssue[];
  /** soft findings (cap overruns, not reacting to hands) */
  notes: string[];
  frames: number;
  perFrameMs: number;
  /** most primitives drawn in one frame, per kind */
  peak: Record<string, number>;
  reactsToHands: boolean;
  reactsToValues: boolean;
  note: string;
}

const DRAW_CALL = /\bdraw\s*\.\s*(point|particle|sphere|box|ring|line|trail|text)\s*\(/;

/** Static checks: size, forbidden tokens, wrapper, syntax, at least one draw call. */
export function validateScene(code: string): { ok: boolean; issues: WireIssue[] } {
  const issues: WireIssue[] = [];
  const add = (c: string, message: string) => { if (!issues.some((i) => i.message === message)) issues.push({ code: c, message: message.slice(0, 200) }); };
  const bytes = Buffer.byteLength(code, 'utf8');
  if (!code.trim()) add('empty', 'the scene program is empty');
  if (bytes > SCENE_MAX_BYTES) add('too_long', `the scene program is ${bytes} bytes; the limit is ${SCENE_MAX_BYTES}: make it shorter`);
  const { text, regex } = stripComments(code);
  if (/^\s*(?:function\s+scene\s*\(|\(?\s*s\s*,\s*draw\s*,\s*mem\s*\)?\s*=>)/.test(text)) add('program_wrapper', 'Send only the body: remove the outer function scene(s, draw, mem) wrapper.');
  if (regex) add('regex', 'regular expression literals are not allowed in a scene program');
  for (const f of FORBIDDEN) if (f.re.test(text)) add('forbidden', `"${f.token}" is not allowed in a scene program (no imports, network, timers, DOM, this, eval or endless loops)`);
  if (/\[\s*(?:'[^']*'|"[^"]*"|`[^`]*`)\s*\+|\+\s*(?:'[^']*'|"[^"]*"|`[^`]*`)\s*\]/.test(text)) add('computed_key', 'property names built from strings (obj["a"+"b"]) are not allowed; use plain names');
  try {
    new vm.Script(`(function scene(s, draw, mem) {\n${code}\n})`, { filename: 'scene.js' });
    vm.runInNewContext('new Function("s", "draw", "mem", __code)', { __code: code }, { timeout: 100 });
  } catch (e) {
    add('syntax', `syntax error: ${((e as Error).message ?? String(e)).split('\n')[0]!.slice(0, 140)}`);
  }
  if (code.trim() && !DRAW_CALL.test(text)) add('no_draw', 'the scene never calls draw.point/sphere/box/ring/line/trail/text');
  return { ok: issues.length === 0, issues };
}

// --- synthetic traces ------------------------------------------------------------------------------------------------

interface P { x: number; y: number; z: number }
interface SceneHandFrame extends P {
  tip: P; thumb: P; tips: number[]; vx: number; vy: number; vz: number; speed: number; nx: number; ny: number; nz: number;
  pinch: number; pinchTap: boolean; fist: boolean; open: boolean; palmOut: boolean;
}
export interface SceneFrame { t: number; dt: number; head: P; device: P | null; right: SceneHandFrame | null; left: SceneHandFrame | null; values: Record<string, number> }

const DT = 1 / 72;
function hand(x: number, y: number, z: number, o: { pinch?: number; tap?: boolean; vx?: number; vy?: number; vz?: number; side?: 1 | -1 } = {}): SceneHandFrame {
  const side = o.side ?? 1, pinch = o.pinch ?? 0.05;
  const tips: number[] = [];
  for (let f = 0; f < 5; f++) tips.push(x + side * (f - 2) * 0.02, y + 0.07 + (f === 0 ? -0.03 : 0.01), z - 0.06 - (f === 2 ? 0.01 : 0));
  const vx = o.vx ?? 0, vy = o.vy ?? 0, vz = o.vz ?? 0;
  return { x, y, z, tip: { x: tips[3]!, y: tips[4]!, z: tips[5]! }, thumb: { x: tips[0]!, y: tips[1]!, z: tips[2]! }, tips, vx, vy, vz, speed: Math.hypot(vx, vy, vz),
    nx: 0, ny: 0, nz: -1, pinch, pinchTap: !!o.tap, fist: false, open: pinch < 0.5, palmOut: false };
}

/** Deterministic traces. `valueIds` are the wiring's actions (a value sweep exercises s.values). */
export function buildSceneTraces(valueIds: string[] = [], frames = TRACE_FRAMES): { name: string; frames: SceneFrame[] }[] {
  const base = (i: number): SceneFrame => ({ t: i * DT, dt: DT, head: { x: 0, y: 0.3, z: 0.55 }, device: { x: 0, y: 0.1, z: -0.6 }, right: null, left: null, values: {} });
  const range = (f: (i: number, k: number, fr: SceneFrame) => void) => Array.from({ length: frames }, (_, i) => { const fr = base(i); f(i, i / (frames - 1), fr); return fr; });
  const sweep = (dx: number) => range((i, k, fr) => {
    const a = k * Math.PI * 1.5;
    fr.right = hand(0.18 + dx + 0.15 * Math.cos(a), 0.02 + 0.12 * Math.sin(a), 0.2, { vx: -0.3 * Math.sin(a), vy: 0.25 * Math.cos(a), vz: 0 });
  });
  return [
    { name: 'no-hands', frames: range(() => {}) },
    { name: 'right-sweep', frames: sweep(0) },
    { name: 'right-sweep-shifted', frames: sweep(0.2) },
    { name: 'two-palms-push', frames: range((i, k, fr) => {
      const z = 0.3 - 0.35 * k, pinch = Math.abs(i - 30) < 4 ? 1 : 0.05;
      fr.right = hand(0.16, 0.0, z, { vz: -0.6, pinch, tap: i === 34 });
      fr.left = hand(-0.16, 0.0, z, { vz: -0.6, side: -1, pinch });
    }) },
    { name: 'values', frames: range((i, k, fr) => { for (const [j, id] of valueIds.entries()) fr.values[id] = Math.round(127 * ((k + j * 0.3) % 1)); }) },
  ];
}

// --- dry run ---------------------------------------------------------------------------------------------------------

// Globals reach code in a vm context through a slow interceptor; the common builtins are passed in as parameters
// (and captured by the stubs) so the timing measures the program, not the sandbox.
const BUILTINS = ['Math', 'Float32Array', 'Float64Array', 'Int32Array', 'Uint8Array', 'Uint16Array', 'Array', 'Number', 'String', 'Boolean', 'JSON', 'Object', 'isFinite', 'isNaN', 'parseInt', 'parseFloat', 'Infinity', 'NaN', 'undefined'];
const HARNESS = `
var __run = (function () {
var __B = [${BUILTINS.join(', ')}];
var __scene = Function.apply(null, ['s', 'draw', 'mem'].concat(${JSON.stringify(BUILTINS)}, [__code]));
var M = Math, INF = 1 / 0, Str = String, JS = JSON;
return function (traceJson) {
  var frames = JS.parse(traceJson);
  var mem = {}, errors = [], sig = [], bad = 0, firstBad = '', acc = 0, calls = 0;
  var KINDS = ['point', 'sphere', 'box', 'ring', 'line', 'trail', 'text'];
  var cur = {}, peak = {};
  for (var q = 0; q < KINDS.length; q++) peak[KINDS[q]] = 0;
  function n(v, what) { if (typeof v !== 'number' || v !== v || v === INF || v === -INF) { bad++; if (!firstBad) firstBad = what + ' got ' + Str(v); return 0; } return v; }
  function hit(kind) { cur[kind]++; if (++calls > 400000) throw new Error('too many draw calls'); }
  var draw = {
    point: function (x, y, z, size) { hit('point'); acc += n(x, 'draw.point x') * 1.3 + n(y, 'draw.point y') * 1.7 + n(z, 'draw.point z') * 1.1; },
    sphere: function (x, y, z, r) { hit('sphere'); acc += n(x, 'draw.sphere x') * 2.3 + n(y, 'draw.sphere y') * 1.9 + n(z, 'draw.sphere z') + n(r === undefined ? 0.02 : r, 'draw.sphere r'); },
    box: function (x, y, z) { hit('box'); acc += n(x, 'draw.box x') * 1.1 + n(y, 'draw.box y') * 2.9 + n(z, 'draw.box z') * 0.7; },
    ring: function (x, y, z, r) { hit('ring'); acc += n(x, 'draw.ring x') + n(y, 'draw.ring y') * 3.1 + n(z, 'draw.ring z') + n(r === undefined ? 0.05 : r, 'draw.ring r'); },
    line: function (x1, y1, z1, x2, y2, z2) { hit('line'); acc += n(x1, 'draw.line') + n(y1, 'draw.line') * 1.5 + n(z1, 'draw.line') + n(x2, 'draw.line') * 0.5 + n(y2, 'draw.line') + n(z2, 'draw.line') * 0.3; },
    trail: function (key, x, y, z) { hit('trail'); acc += n(x, 'draw.trail x') * 0.9 + n(y, 'draw.trail y') * 1.2 + n(z, 'draw.trail z') * 1.4; },
    text: function (x, y, z, t) { hit('text'); acc += n(x, 'draw.text x') + n(y, 'draw.text y') + Str(t).length * 0.001; },
    hsl: function (h, s, l) { h = ((+h % 1) + 1) % 1; return (M.round(255 * h) << 16) | (M.round(255 * M.min(1, +s || 0)) << 8) | M.round(255 * M.min(1, +l || 0)); },
    noise: function (x, y, z) { return M.sin(x * 1.7 + M.cos(y * 2.3) + z * 1.1) * M.cos(y * 1.3 - z * 0.7); }
  };
  draw.particle = draw.point;
  for (var i = 0; i < frames.length; i++) {
    for (var k = 0; k < KINDS.length; k++) cur[KINDS[k]] = 0;
    acc = 0;
    try { __scene.apply(null, [frames[i], draw, mem].concat(__B)); }
    catch (e) { errors.push('frame ' + i + ': ' + Str(e && e.message ? e.message : e).slice(0, 120)); if (errors.length >= 3) break; }
    sig.push(M.round(acc * 1e6) / 1e6);
    for (var m = 0; m < KINDS.length; m++) if (cur[KINDS[m]] > peak[KINDS[m]]) peak[KINDS[m]] = cur[KINDS[m]];
  }
  return JS.stringify({ errors: errors, sig: sig, peak: peak, bad: bad, firstBad: firstBad });
};
})();
`;

const CAPS: Record<string, number> = { point: SCENE_LIMITS.points, sphere: SCENE_LIMITS.spheres, box: SCENE_LIMITS.boxes, ring: SCENE_LIMITS.rings, line: SCENE_LIMITS.lines, text: SCENE_LIMITS.texts };

/** Run the scene over the traces in an empty vm context. Pure and synchronous (a few ms of CPU). */
export function dryRunScene(code: string, valueIds: string[] = [], opts: { maxFrameMs?: number } = {}): SceneDryRun {
  const maxFrameMs = opts.maxFrameMs ?? SCENE_MAX_FRAME_MS;
  const issues: WireIssue[] = [], notes: string[] = [];
  const add = (c: string, message: string) => { if (!issues.some((i) => i.message === message)) issues.push({ code: c, message: message.slice(0, 200) }); };
  const peak: Record<string, number> = {};
  const sigs = new Map<string, number[]>();
  let frames = 0, cpuMs = 0, drawn = 0;
  let context: vm.Context;
  try {
    context = vm.createContext(Object.create(null), { codeGeneration: { strings: true, wasm: false } });
    (context as Record<string, unknown>).__code = code;
    vm.runInContext(HARNESS, context, { filename: 'scene-harness.js', timeout: 100 });
  } catch (e) {
    add('syntax', `could not load the scene: ${((e as Error).message ?? String(e)).split('\n')[0]!.slice(0, 140)}`);
    return { ok: false, issues, notes, frames: 0, perFrameMs: 0, peak, reactsToHands: false, reactsToValues: false, note: `scene dry-run ✗ ${issues[0]!.message}` };
  }
  for (const trace of buildSceneTraces(valueIds)) {
    (context as Record<string, unknown>).__trace = JSON.stringify(trace.frames);
    const cpu0 = process.cpuUsage();
    let raw: string;
    try {
      raw = vm.runInContext('__run(__trace)', context, { filename: 'scene-run.js', timeout: TRACE_TIMEOUT_MS }) as string;
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      add('timeout', /timed out/i.test(msg) ? `the scene ran longer than ${TRACE_TIMEOUT_MS} ms on the "${trace.name}" trace (an endless or very heavy loop)` : `the scene failed on the "${trace.name}" trace: ${msg.split('\n')[0]!.slice(0, 120)}`);
      break;
    }
    const used = process.cpuUsage(cpu0);
    cpuMs += (used.user + used.system) / 1000;
    frames += trace.frames.length;
    const r = JSON.parse(raw) as { errors: string[]; sig: number[]; peak: Record<string, number>; bad: number; firstBad: string };
    for (const err of r.errors) add('threw', `the scene threw on the "${trace.name}" trace (${err}). Guard null hands: s.right and s.left can be null`);
    if (r.bad) add('bad_value', `the scene passed a non-finite number (${r.firstBad}) on the "${trace.name}" trace; keep coordinates finite`);
    for (const [k, v] of Object.entries(r.peak)) { peak[k] = Math.max(peak[k] ?? 0, v); drawn += v; }
    sigs.set(trace.name, r.sig);
  }
  const perFrameMs = frames ? cpuMs / frames : 0;
  if (perFrameMs >= maxFrameMs) add('slow', `the scene took ${perFrameMs.toFixed(2)} ms per frame; the limit is ${maxFrameMs} ms: draw fewer things or simplify the maths`);
  if (!issues.length && !drawn) add('silent', 'the scene drew nothing on any trace; make sure draw.* runs even when no hand is tracked');
  for (const [k, cap] of Object.entries(CAPS)) if ((peak[k] ?? 0) > cap) notes.push(`drew ${peak[k]} ${k}s in one frame; the headset shows the first ${cap}`);
  if ((peak.trail ?? 0) > SCENE_LIMITS.trails * 4) notes.push('draw.trail is meant to be called once per trail per frame');
  const same = (a?: number[], b?: number[]) => !!a && !!b && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]!) < 1e-6);
  const reactsToHands = !same(sigs.get('right-sweep'), sigs.get('right-sweep-shifted')) || !same(sigs.get('no-hands'), sigs.get('two-palms-push'));
  const reactsToValues = valueIds.length > 0 && !same(sigs.get('no-hands'), sigs.get('values'));
  if (!reactsToHands) notes.push('the scene does not react to the hands');
  const ok = issues.length === 0;
  const total = Object.entries(peak).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k}${v === 1 ? '' : 's'}`).join(' · ');
  return { ok, issues, notes, frames, perFrameMs, peak, reactsToHands, reactsToValues,
    note: ok ? `scene dry-run ✓ ${frames} frames · peak ${total || 'nothing'}${reactsToHands ? ' · follows hands' : ''}${reactsToValues ? ' · follows values' : ''}`.slice(0, 160) : `scene dry-run ✗ ${issues[0]!.message}`.slice(0, 160) };
}

/** Both checks, as finish uses them. */
export function checkScene(code: string, valueIds: string[] = []): { ok: boolean; issues: string[]; notes: string[]; note: string; dry?: SceneDryRun } {
  const v = validateScene(code);
  if (!v.ok) return { ok: false, issues: v.issues.map((i) => i.message), notes: [], note: `scene ✗ ${v.issues[0]!.message}`.slice(0, 160) };
  const dry = dryRunScene(code, valueIds);
  return { ok: dry.ok, issues: dry.issues.map((i) => i.message), notes: dry.notes, note: dry.note, dry };
}
