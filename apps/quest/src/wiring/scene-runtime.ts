/**
 * Muse's XR scenes, headset half: runs the visualization Muse wrote ("scene(s, draw, mem)") in a sandboxed Worker and
 * hands the HUD a compact display list every frame.
 *
 *  - Same sandbox as hand programs (wiring/runtime.ts): a blob Worker that removes every way out before compiling the
 *    code. The program can only compute and call `draw.*`; it never touches the DOM, the network or three.js.
 *  - `draw.*` writes into one transferable Float32Array (layout SCENE_LAYOUT) with hard per-frame caps. Two buffers
 *    ping-pong between the threads, so nothing is copied or allocated per frame on the main thread beyond the message.
 *  - Each frame the main thread posts the latest SceneSignals (hands, head, device, the wiring's values) when the worker
 *    is free. > BUDGET_MS is a strike, a throw is a strike, three strikes stop the scene; a call that does not return
 *    within WATCHDOG_MS terminates the worker.
 *  - Coordinates: metres around an anchor fixed in the room at start (about 0.55 m in front of the wearer at chest
 *    height, toward the selected device): +x the wearer's right, +y up, +z toward the wearer.
 */
import { Vector3 } from 'three';
import type { SceneFrameView } from '../hud/contract';
import type { ShellFrame, ShellHand } from '../app/hud-contract';
import type { HandSignals } from '../gestures/signals';
import { checkWiringCode, type StopKind } from './runtime';

/** Per-frame caps (the server's scene-check.ts SCENE_LIMITS are the same). */
export const SCENE_LIMITS = { points: 4000, spheres: 300, boxes: 300, rings: 200, lines: 800, trails: 16, trailPoints: 64, texts: 6, textChars: 24 } as const;
export const SCENE_RUNTIME = {
  budgetMs: 8, graceCalls: 4, graceBudgetMs: 60, watchdogMs: 150, strikesToStop: 3, forgiveAfter: 120, startMs: 4000,
  /** a trail point fades out over this long */
  trailLife: 1.2,
} as const;

// Display list layout: one Float32Array, regions in this order. Strides in floats.
/** trail samples plus the points filled in between far-apart samples (a fast hand moves ~3 cm a frame) */
const TRAIL_DOTS = SCENE_LIMITS.trails * SCENE_LIMITS.trailPoints * 3;
const PT_CAP = SCENE_LIMITS.points + TRAIL_DOTS + SCENE_LIMITS.spheres; // user + trails + sphere halos
const LN_CAP = SCENE_LIMITS.lines + SCENE_LIMITS.trails * (SCENE_LIMITS.trailPoints - 1);
export const SCENE_LAYOUT = (() => {
  const pt = { stride: 8, cap: PT_CAP, off: 0 };                              // x y z size  r g b a
  const sp = { stride: 8, cap: SCENE_LIMITS.spheres, off: pt.off + pt.stride * pt.cap };   // x y z r  r g b a
  const bx = { stride: 11, cap: SCENE_LIMITS.boxes, off: sp.off + sp.stride * sp.cap };    // x y z sx sy sz rotY  r g b a
  const rg = { stride: 9, cap: SCENE_LIMITS.rings, off: bx.off + bx.stride * bx.cap };     // x y z r flat  r g b a
  const ln = { stride: 14, cap: LN_CAP, off: rg.off + rg.stride * rg.cap };                // x y z r g b a  ×2 vertices
  return { pt, sp, bx, rg, ln, floats: ln.off + ln.stride * ln.cap };
})();

export interface ScenePoint { x: number; y: number; z: number }
export interface SceneHand extends ScenePoint {
  tip: ScenePoint; thumb: ScenePoint; tips: number[];
  vx: number; vy: number; vz: number; speed: number; nx: number; ny: number; nz: number;
  pinch: number; pinchTap: boolean; fist: boolean; open: boolean; palmOut: boolean;
}
export interface SceneSignals {
  t: number; dt: number; head: ScenePoint; device: ScenePoint | null;
  right: SceneHand | null; left: SceneHand | null; values: Record<string, number>;
}
export interface SceneProgram { wiringId: string; cardId: string; title: string; code: string }

// --- the worker ------------------------------------------------------------------------------------------------------

const L = SCENE_LAYOUT;
/** Source of the scene worker (text: it becomes a blob). Exported so a test can run it in a stub scope. */
export const SCENE_WORKER_SOURCE = String.raw`(function () {
  var post = self.postMessage.bind(self);
  var now = performance.now.bind(performance);
  var BLOCK = ['fetch', 'importScripts', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'WebTransport', 'EventSource', 'indexedDB', 'IDBFactory', 'caches', 'CacheStorage', 'Cache', 'Worker', 'SharedWorker', 'BroadcastChannel', 'openDatabase', 'FileReaderSync', 'Notification', 'navigator', 'location', 'setTimeout', 'setInterval', 'queueMicrotask', 'requestAnimationFrame'];
  function lock(o, n, v) { try { Object.defineProperty(o, n, { value: v, writable: false, configurable: false }); } catch (e) { try { o[n] = v; } catch (e2) {} } }
  for (var i = 0; i < BLOCK.length; i++) lock(self, BLOCK[i], undefined);
  for (var o = Object.getPrototypeOf(self); o; o = Object.getPrototypeOf(o)) for (var j = 0; j < BLOCK.length; j++) if (Object.prototype.hasOwnProperty.call(o, BLOCK[j])) lock(o, BLOCK[j], undefined);
  lock(self, 'postMessage', function postMessage() {});

  var PT = ${L.pt.off}, SP = ${L.sp.off}, BX = ${L.bx.off}, RG = ${L.rg.off}, LN = ${L.ln.off};
  var CAP = { pt: ${SCENE_LIMITS.points}, ptAll: ${L.pt.cap}, sp: ${SCENE_LIMITS.spheres}, bx: ${SCENE_LIMITS.boxes}, rg: ${SCENE_LIMITS.rings}, ln: ${SCENE_LIMITS.lines}, lnAll: ${L.ln.cap}, trails: ${SCENE_LIMITS.trails}, trailPts: ${SCENE_LIMITS.trailPoints}, texts: ${SCENE_LIMITS.texts} };
  var LIFE = ${SCENE_RUNTIME.trailLife};
  var F = null, np = 0, ns = 0, nb = 0, nr = 0, nl = 0, texts = [], dropped = 0, T = 0;
  var cr = 1, cg = 1, cb = 1, colors = Object.create(null), colorCount = 0;
  function fin(v) { return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity; }
  function num(v, d) { return fin(v) ? v : d; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  // colour: 0xRRGGBB or '#rgb' / '#rrggbb' -> cr, cg, cb in 0..1
  function col(c) {
    var n = 0xffffff;
    if (typeof c === 'number' && fin(c)) n = c & 0xffffff;
    else if (typeof c === 'string') {
      var hit = colors[c];
      if (hit === undefined) {
        var h = c.charAt(0) === '#' ? c.slice(1) : c;
        if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
        hit = parseInt(h, 16); if (!(hit >= 0 && hit <= 0xffffff)) hit = 0xffffff;
        if (colorCount < 256) { colors[c] = hit; colorCount++; }
      }
      n = hit;
    }
    cr = ((n >> 16) & 255) / 255; cg = ((n >> 8) & 255) / 255; cb = (n & 255) / 255;
  }
  function alpha(a) { return a === undefined ? 1 : clamp(num(a, 1), 0, 1); }
  function vtx(o, x, y, z, a) { F[o] = x; F[o + 1] = y; F[o + 2] = z; F[o + 3] = cr; F[o + 4] = cg; F[o + 5] = cb; F[o + 6] = a; }
  var trails = Object.create(null), trailKeys = [];
  function hue(p, q, t) { if (t < 0) t += 1; if (t > 1) t -= 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; }
  // cheap smooth value noise, -1..1
  function hash(x, y, z) { var h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return (h - Math.floor(h)) * 2 - 1; }
  function smooth(t) { return t * t * (3 - 2 * t); }
  var draw = Object.freeze({
    point: function (x, y, z, size, color, a) {
      if (np >= CAP.pt) { dropped++; return; }
      if (!fin(x) || !fin(y) || !fin(z)) return;
      col(color); var o = PT + np++ * 8;
      F[o] = x; F[o + 1] = y; F[o + 2] = z; F[o + 3] = clamp(num(size, 0.01), 0.001, 0.3); F[o + 4] = cr; F[o + 5] = cg; F[o + 6] = cb; F[o + 7] = alpha(a);
    },
    sphere: function (x, y, z, r, color, a) {
      if (ns >= CAP.sp) { dropped++; return; }
      if (!fin(x) || !fin(y) || !fin(z)) return;
      col(color); var o = SP + ns++ * 8;
      F[o] = x; F[o + 1] = y; F[o + 2] = z; F[o + 3] = clamp(num(r, 0.02), 0.001, 1.5); F[o + 4] = cr; F[o + 5] = cg; F[o + 6] = cb; F[o + 7] = alpha(a);
    },
    box: function (x, y, z, sx, sy, sz, color, a, rot) {
      if (nb >= CAP.bx) { dropped++; return; }
      if (!fin(x) || !fin(y) || !fin(z)) return;
      col(color); var o = BX + nb++ * 11;
      F[o] = x; F[o + 1] = y; F[o + 2] = z; F[o + 3] = clamp(num(sx, 0.03), 0.001, 3); F[o + 4] = clamp(num(sy, 0.03), 0.001, 3); F[o + 5] = clamp(num(sz, 0.03), 0.001, 3);
      F[o + 6] = num(rot, 0); F[o + 7] = cr; F[o + 8] = cg; F[o + 9] = cb; F[o + 10] = alpha(a);
    },
    ring: function (x, y, z, r, color, a, flat) {
      if (nr >= CAP.rg) { dropped++; return; }
      if (!fin(x) || !fin(y) || !fin(z)) return;
      col(color); var o = RG + nr++ * 9;
      F[o] = x; F[o + 1] = y; F[o + 2] = z; F[o + 3] = clamp(num(r, 0.05), 0.002, 2); F[o + 4] = flat ? 1 : 0; F[o + 5] = cr; F[o + 6] = cg; F[o + 7] = cb; F[o + 8] = alpha(a);
    },
    line: function (x1, y1, z1, x2, y2, z2, color, a) {
      if (nl >= CAP.ln) { dropped++; return; }
      if (!fin(x1) || !fin(y1) || !fin(z1) || !fin(x2) || !fin(y2) || !fin(z2)) return;
      col(color); var o = LN + nl++ * 14, al = alpha(a);
      vtx(o, x1, y1, z1, al); vtx(o + 7, x2, y2, z2, al);
    },
    trail: function (key, x, y, z, color, size) {
      if (!fin(x) || !fin(y) || !fin(z)) return;
      key = String(key).slice(0, 32);
      var tr = trails[key];
      if (!tr) {
        if (trailKeys.length >= CAP.trails) { dropped++; return; }
        tr = trails[key] = { p: new Float32Array(CAP.trailPts * 3), t: new Float64Array(CAP.trailPts).fill(-1e9), head: -1, r: 1, g: 1, b: 1, size: 0.012 };
        trailKeys.push(key);
      }
      col(color); tr.r = cr; tr.g = cg; tr.b = cb; tr.size = clamp(num(size, 0.012), 0.002, 0.06);
      var last = tr.head >= 0 ? tr.head : -1;
      if (last >= 0) {
        var dx = x - tr.p[last * 3], dy = y - tr.p[last * 3 + 1], dz = z - tr.p[last * 3 + 2];
        if (dx * dx + dy * dy + dz * dz < 0.0000025 && T - tr.t[last] < 0.05) return;    // < 1.6 mm and recent
      }
      var i = (tr.head + 1) % CAP.trailPts;
      tr.p[i * 3] = x; tr.p[i * 3 + 1] = y; tr.p[i * 3 + 2] = z; tr.t[i] = T; tr.head = i;
    },
    text: function (x, y, z, str, color, size) {
      if (texts.length >= CAP.texts) { dropped++; return; }
      if (!fin(x) || !fin(y) || !fin(z)) return;
      col(color);
      texts.push({ x: x, y: y, z: z, text: String(str).slice(0, ${SCENE_LIMITS.textChars}), color: (Math.round(cr * 255) << 16) | (Math.round(cg * 255) << 8) | Math.round(cb * 255), size: clamp(num(size, 0.02), 0.008, 0.08) });
    },
    hsl: function (h, s, l) {
      h = num(h, 0); h = h - Math.floor(h); s = clamp(num(s, 1), 0, 1); l = clamp(num(l, 0.5), 0, 1);
      var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
      return (Math.round(hue(p, q, h + 1 / 3) * 255) << 16) | (Math.round(hue(p, q, h) * 255) << 8) | Math.round(hue(p, q, h - 1 / 3) * 255);
    },
    noise: function (x, y, z) {
      x = num(x, 0); y = num(y, 0); z = num(z, 0);
      var ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z), fx = smooth(x - ix), fy = smooth(y - iy), fz = smooth(z - iz);
      function l(a, b, t) { return a + (b - a) * t; }
      return l(l(l(hash(ix, iy, iz), hash(ix + 1, iy, iz), fx), l(hash(ix, iy + 1, iz), hash(ix + 1, iy + 1, iz), fx), fy),
        l(l(hash(ix, iy, iz + 1), hash(ix + 1, iy, iz + 1), fx), l(hash(ix, iy + 1, iz + 1), hash(ix + 1, iy + 1, iz + 1), fx), fy), fz);
    },
  });
  // the same object under its common aliases
  var api = Object.freeze(Object.assign({}, draw, { particle: draw.point, dot: draw.point, orb: draw.sphere }));

  // After the program: fading trails (points + connecting lines) and a soft halo point per sphere.
  function finishFrame() {
    for (var k = trailKeys.length - 1; k >= 0; k--) {
      var tr = trails[trailKeys[k]], n = CAP.trailPts, newest = tr.head, alive = 0, prev = -1, prevFade = 0;
      for (var m = 1; m <= n; m++) {
        var i = (newest + m) % n, age = T - tr.t[i];
        if (age < 0 || age > LIFE) { prev = -1; continue; }
        alive++;
        var fade = 1 - age / LIFE, x = tr.p[i * 3], y = tr.p[i * 3 + 1], z = tr.p[i * 3 + 2];
        cr = tr.r; cg = tr.g; cb = tr.b;
        // fill long gaps with in-between dots so a fast stroke stays one glowing ribbon
        var steps = 1;
        if (prev >= 0) { var gx = x - tr.p[prev * 3], gy = y - tr.p[prev * 3 + 1], gz = z - tr.p[prev * 3 + 2]; steps = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(gx * gx + gy * gy + gz * gz) / (tr.size * 0.6)))); }
        for (var st = steps - 1; st >= 0 && np < CAP.ptAll; st--) {
          var u = st / steps, f2 = fade + (prevFade - fade) * u, o = PT + np++ * 8;   // u = 0 at this sample, toward the previous one
          F[o] = x - (prev >= 0 ? (x - tr.p[prev * 3]) * u : 0); F[o + 1] = y - (prev >= 0 ? (y - tr.p[prev * 3 + 1]) * u : 0); F[o + 2] = z - (prev >= 0 ? (z - tr.p[prev * 3 + 2]) * u : 0);
          F[o + 3] = tr.size * (0.35 + 0.65 * f2); F[o + 4] = cr; F[o + 5] = cg; F[o + 6] = cb; F[o + 7] = Math.pow(f2, 1.4);
        }
        prevFade = fade;
        if (prev >= 0 && nl < CAP.lnAll) { var q = LN + nl++ * 14; vtx(q, tr.p[prev * 3], tr.p[prev * 3 + 1], tr.p[prev * 3 + 2], fade * 0.7); vtx(q + 7, x, y, z, fade * 0.9); }
        prev = i;
      }
      if (!alive) { delete trails[trailKeys[k]]; trailKeys.splice(k, 1); }
    }
    for (var si = 0; si < ns && np < CAP.ptAll; si++) {
      var so = SP + si * 8, po = PT + np++ * 8;
      F[po] = F[so]; F[po + 1] = F[so + 1]; F[po + 2] = F[so + 2]; F[po + 3] = Math.min(0.3, F[so + 3] * 5);
      F[po + 4] = F[so + 4]; F[po + 5] = F[so + 5]; F[po + 6] = F[so + 6]; F[po + 7] = F[so + 7] * 0.3;
    }
  }

  var scene = null, mem = {};
  self.onmessage = function (e) {
    var m = e.data;
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'init') {
      try { scene = new Function('s', 'draw', 'mem', m.code); post({ type: 'ready' }); }
      catch (err) { post({ type: 'error', reason: 'did not compile: ' + String(err && err.message ? err.message : err).slice(0, 140) }); }
    } else if (m.type === 'tick' && scene && m.buf) {
      F = new Float32Array(m.buf); np = ns = nb = nr = nl = 0; texts = []; dropped = 0;
      T = m.s && fin(m.s.t) ? m.s.t : T;
      var err = null, t0 = now();
      try { scene(m.s, api, mem); } catch (x) { err = String(x && x.message ? x.message : x).slice(0, 140); }
      var ms = now() - t0;
      try { finishFrame(); } catch (x) { err = err || 'trails: ' + String(x && x.message); }
      var buf = F.buffer; F = null;
      post({ type: 'out', seq: m.seq, ms: ms, err: err, np: np, ns: ns, nb: nb, nr: nr, nl: nl, texts: texts, dropped: dropped, buf: buf }, [buf]);
    }
  };
})();`;

// --- signals: hands and head in the scene's frame -----------------------------------------------------------------------

const TIPS = ['thumb-tip', 'index-finger-tip', 'middle-finger-tip', 'ring-finger-tip', 'pinky-finger-tip'] as const;
const emptyHand = (): SceneHand => ({ x: 0, y: 0, z: 0, tip: { x: 0, y: 0, z: 0 }, thumb: { x: 0, y: 0, z: 0 }, tips: Array(15).fill(0), vx: 0, vy: 0, vz: 0, speed: 0, nx: 0, ny: 0, nz: 1, pinch: 0, pinchTap: false, fist: false, open: false, palmOut: false });

/** Builds SceneSignals in place (no per-frame allocation) relative to a fixed anchor. */
export class SceneSignalBuilder {
  readonly anchor = new Vector3();
  yaw = 0;
  placed = false;
  private cos = 1; private sin = 0;
  private readonly hands = { right: emptyHand(), left: emptyHand() };
  private readonly prev = { right: new Vector3(), left: new Vector3() };
  private readonly had = { right: false, left: false };
  private readonly palm = new Vector3();
  private readonly tmp = new Vector3();
  private startMs = 0;
  readonly signals: SceneSignals = { t: 0, dt: 1 / 72, head: { x: 0, y: 0, z: 0 }, device: null, right: null, left: null, values: {} };
  private readonly device: ScenePoint = { x: 0, y: 0, z: 0 };

  reset(): void { this.placed = false; this.had.right = this.had.left = false; }

  /**
   * Fix the scene in the room: in front of the wearer at chest height, toward the selected device (closer than the device
   * when it is out of reach), +z facing the wearer. With AR controls in play (`behindControls`) it floats a little further
   * and higher, above and behind the knobs, so the two never overlap.
   */
  place(head: Vector3, headForward: Vector3, device: Vector3 | undefined, timeMs: number, behindControls = false): void {
    const f = this.tmp.set(0, 0, 0);
    if (device) f.set(device.x - head.x, 0, device.z - head.z);
    const dist = f.length();
    if (dist < 0.25) f.set(headForward.x, 0, headForward.z);
    if (f.lengthSq() < 1e-6) f.set(0, 0, -1);
    f.normalize();
    const reach = behindControls ? 0.8 : dist >= 0.25 ? Math.min(0.62, Math.max(0.45, dist * 0.6)) : 0.55;
    this.anchor.set(head.x + f.x * reach, head.y - (behindControls ? 0.1 : 0.26), head.z + f.z * reach);
    this.yaw = Math.atan2(-f.x, -f.z);
    this.cos = Math.cos(this.yaw); this.sin = Math.sin(this.yaw);
    this.placed = true; this.startMs = timeMs;
    this.had.right = this.had.left = false;
  }

  /** world point -> scene point (into `out`) */
  local(p: { x: number; y: number; z: number }, out: ScenePoint): ScenePoint {
    const dx = p.x - this.anchor.x, dz = p.z - this.anchor.z;
    out.x = dx * this.cos - dz * this.sin; out.y = p.y - this.anchor.y; out.z = dx * this.sin + dz * this.cos;
    return out;
  }

  build(frame: ShellFrame, hs: { right: HandSignals | null; left: HandSignals | null }, values: Record<string, number>, device: Vector3 | undefined, timeMs: number): SceneSignals {
    const s = this.signals;
    const t = (timeMs - this.startMs) / 1000;
    s.dt = Math.min(0.1, Math.max(0, t - s.t)) || 1 / 72; s.t = t;
    this.local(frame.head.position, s.head);
    s.device = device ? this.local(device, this.device) : null;
    s.values = values;
    s.right = this.hand('right', frame.hands.right, hs.right, s.dt);
    s.left = this.hand('left', frame.hands.left, hs.left, s.dt);
    return s;
  }

  private hand(side: 'right' | 'left', hand: ShellHand | undefined, sig: HandSignals | null, dt: number): SceneHand | null {
    const j = hand?.joints, wrist = j?.wrist?.position;
    const anchorP = wrist ?? (hand?.controller ? hand.grip?.position ?? hand.ray.origin : undefined);
    if (!hand || !anchorP || !Number.isFinite(anchorP.x + anchorP.y + anchorP.z)) { this.had[side] = false; return null; }
    const h = this.hands[side];
    const knuckle = j?.['middle-finger-phalanx-proximal']?.position;
    if (wrist && knuckle) this.palm.copy(wrist).add(knuckle).multiplyScalar(0.5); else this.palm.copy(anchorP);
    this.local(this.palm, h);
    const tipIndex = j?.['index-finger-tip']?.position, tipThumb = j?.['thumb-tip']?.position;
    this.local(tipIndex ?? this.palm, h.tip); this.local(tipThumb ?? this.palm, h.thumb);
    for (let i = 0; i < 5; i++) {
      const p = j?.[TIPS[i]!]?.position ?? this.palm;
      const dx = p.x - this.anchor.x, dz = p.z - this.anchor.z;
      h.tips[i * 3] = dx * this.cos - dz * this.sin; h.tips[i * 3 + 1] = p.y - this.anchor.y; h.tips[i * 3 + 2] = dx * this.sin + dz * this.cos;
    }
    // palm velocity (smoothed), in scene axes
    const prev = this.prev[side];
    if (this.had[side] && dt > 0) {
      const k = 1 - Math.exp(-dt / 0.05);
      h.vx += ((h.x - prev.x) / dt - h.vx) * k; h.vy += ((h.y - prev.y) / dt - h.vy) * k; h.vz += ((h.z - prev.z) / dt - h.vz) * k;
    } else { h.vx = h.vy = h.vz = 0; }
    prev.set(h.x, h.y, h.z); this.had[side] = true;
    h.speed = Math.hypot(h.vx, h.vy, h.vz);
    // palm normal: the palm faces -Y of the wrist joint
    const q = j?.wrist?.quaternion;
    if (q) {
      this.tmp.set(0, -1, 0).applyQuaternion(q);
      h.nx = this.tmp.x * this.cos - this.tmp.z * this.sin; h.ny = this.tmp.y; h.nz = this.tmp.x * this.sin + this.tmp.z * this.cos;
    } else { h.nx = 0; h.ny = 0; h.nz = -1; }
    h.pinch = sig?.pinch ?? (hand.pinching ? 1 : 0); h.pinchTap = !!sig?.pinchTap; h.fist = !!sig?.fist; h.open = !!sig?.open; h.palmOut = !!sig?.palmOut;
    return h;
  }
}

// --- the runtime ---------------------------------------------------------------------------------------------------------

export interface SceneRuntimeDeps {
  onStop(reason: string, kind: StopKind): void;
  createWorker?(source: string): Worker;
  now?(): number;
}

type State = 'idle' | 'starting' | 'running';

export class SceneRuntime {
  private state: State = 'idle';
  private worker?: Worker;
  private free: ArrayBuffer[] = [];
  private inFlight = false;
  private sentAt = 0;
  private seq = 0;
  private strikes = 0;
  private clean = 0;
  private watchdog?: ReturnType<typeof setInterval>;
  private startTimer?: ReturnType<typeof setTimeout>;
  program?: SceneProgram;
  readonly stats = { ticks: 0, avgMs: 0, maxMs: 0, strikes: 0, dropped: 0 };
  readonly view: SceneFrameView = { active: false, seq: 0, anchor: [0, 0, 0], yaw: 0, placed: false, data: null, counts: { points: 0, spheres: 0, boxes: 0, rings: 0, lines: 0 }, texts: [] };

  constructor(private readonly d: SceneRuntimeDeps) {}

  get running(): boolean { return this.state !== 'idle'; }
  private clock(): number { return this.d.now ? this.d.now() : performance.now(); }

  /** Start a scene. Returns the reason when it cannot start. */
  start(program: SceneProgram): string | null {
    this.stop('replaced', 'external');
    const refusal = checkWiringCode(program.code);
    if (refusal) { this.d.onStop(`refused: ${refusal}`, 'refused'); return `refused: ${refusal}`; }
    try {
      if (this.d.createWorker) this.worker = this.d.createWorker(SCENE_WORKER_SOURCE);
      else {
        const url = URL.createObjectURL(new Blob([SCENE_WORKER_SOURCE], { type: 'text/javascript' }));
        try { this.worker = new Worker(url); } finally { setTimeout(() => URL.revokeObjectURL(url), 5000); }
      }
    } catch (e) {
      const reason = `this browser cannot run the scene sandbox (${(e as Error).message})`;
      this.d.onStop(reason, 'unavailable');
      return reason;
    }
    this.program = program;
    this.free = [new ArrayBuffer(SCENE_LAYOUT.floats * 4), new ArrayBuffer(SCENE_LAYOUT.floats * 4)];
    this.state = 'starting'; this.inFlight = false; this.strikes = this.clean = 0;
    Object.assign(this.stats, { ticks: 0, avgMs: 0, maxMs: 0, strikes: 0, dropped: 0 });
    const v = this.view;
    v.active = true; v.data = null; v.placed = false; v.texts = [];
    v.counts.points = v.counts.spheres = v.counts.boxes = v.counts.rings = v.counts.lines = 0;
    const worker = this.worker;
    worker.onmessage = (e: MessageEvent) => { if (this.worker === worker) this.onMessage(e.data as Record<string, unknown>); };
    worker.onerror = (e: ErrorEvent) => { if (this.worker !== worker) return; e.preventDefault?.(); this.fail(`worker error: ${e.message || 'unknown'}`, 'error'); };
    worker.postMessage({ type: 'init', code: program.code });
    this.startTimer = setTimeout(() => { if (this.state === 'starting') this.fail('the scene sandbox did not start', 'unavailable'); }, SCENE_RUNTIME.startMs);
    return null;
  }

  /** Where the scene sits in the room (from the signal builder, once placed). */
  setAnchor(anchor: Vector3, yaw: number): void {
    this.view.anchor[0] = anchor.x; this.view.anchor[1] = anchor.y; this.view.anchor[2] = anchor.z;
    this.view.yaw = yaw; this.view.placed = true;
  }

  /** Once per frame: post the latest signals when the worker is free. Never throws. */
  tick(signals: SceneSignals): void {
    if (this.state !== 'running' || !this.worker || this.inFlight) return;
    const buf = this.free.pop();
    if (!buf) return;
    this.inFlight = true; this.sentAt = this.clock();
    try { this.worker.postMessage({ type: 'tick', seq: ++this.seq, s: signals, buf }, [buf]); }
    catch (e) { this.fail(`could not reach the scene sandbox (${(e as Error).message})`, 'error'); }
  }

  /** Stop the scene and clear what it drew. Safe at any time; tells onStop once when it was running. */
  stop(reason: string, kind: StopKind = 'user'): void {
    if (this.state === 'idle') return;
    this.finish();
    this.d.onStop(reason, kind);
  }

  private finish(): void {
    this.state = 'idle';
    clearInterval(this.watchdog); this.watchdog = undefined; clearTimeout(this.startTimer);
    const worker = this.worker;
    this.worker = undefined; this.inFlight = false; this.free = [];
    if (worker) { worker.onmessage = null; worker.onerror = null; try { worker.terminate(); } catch { /* gone */ } }
    const v = this.view;
    v.active = false; v.data = null; v.texts = []; v.seq++;
    v.counts.points = v.counts.spheres = v.counts.boxes = v.counts.rings = v.counts.lines = 0;
  }

  private fail(reason: string, kind: StopKind): void {
    if (this.state === 'idle') return;
    this.stop(reason, kind);
  }

  private onMessage(m: Record<string, unknown>): void {
    switch (m.type) {
      case 'ready':
        if (this.state !== 'starting') return;
        clearTimeout(this.startTimer);
        this.state = 'running';
        this.watchdog = setInterval(() => this.checkWatchdog(), 25);
        return;
      case 'error':
        this.fail(String(m.reason ?? 'the scene failed'), 'error');
        return;
      case 'out': {
        if (this.state !== 'running') return;
        this.inFlight = false;
        const buf = m.buf instanceof ArrayBuffer ? m.buf : undefined;
        if (!buf || buf.byteLength !== SCENE_LAYOUT.floats * 4) { this.fail('the scene sandbox returned a bad display list', 'error'); return; }
        const v = this.view;
        if (v.data) this.free.push(v.data.buffer as ArrayBuffer);
        const cap = (n: unknown, max: number) => Math.max(0, Math.min(max, Math.floor(Number(n) || 0)));
        v.data = new Float32Array(buf);
        v.counts.points = cap(m.np, SCENE_LAYOUT.pt.cap); v.counts.spheres = cap(m.ns, SCENE_LAYOUT.sp.cap); v.counts.boxes = cap(m.nb, SCENE_LAYOUT.bx.cap);
        v.counts.rings = cap(m.nr, SCENE_LAYOUT.rg.cap); v.counts.lines = cap(m.nl, SCENE_LAYOUT.ln.cap);
        v.texts = Array.isArray(m.texts) ? (m.texts as SceneFrameView['texts']).slice(0, SCENE_LIMITS.texts) : [];
        v.seq++;
        const ms = Number(m.ms) || 0, s = this.stats;
        s.ticks++; s.avgMs += (ms - s.avgMs) * 0.05; s.maxMs = Math.max(s.maxMs, ms); s.dropped = Number(m.dropped) || 0;
        const budget = s.ticks <= SCENE_RUNTIME.graceCalls ? SCENE_RUNTIME.graceBudgetMs : SCENE_RUNTIME.budgetMs;
        if (typeof m.err === 'string' && m.err) this.strike(`it threw: ${m.err}`, 'error');
        else if (ms > budget) this.strike(`it took ${ms.toFixed(1)} ms (limit ${SCENE_RUNTIME.budgetMs} ms)`, 'overrun');
        else if (++this.clean >= SCENE_RUNTIME.forgiveAfter) { this.clean = 0; if (this.strikes > 0) s.strikes = --this.strikes; }
        return;
      }
    }
  }

  private strike(why: string, kind: StopKind): void {
    this.clean = 0;
    this.stats.strikes = ++this.strikes;
    if (this.strikes >= SCENE_RUNTIME.strikesToStop) this.fail(why, kind);
  }

  private checkWatchdog(): void {
    if (this.state !== 'running' || !this.inFlight) return;
    if (this.clock() - this.sentAt <= SCENE_RUNTIME.watchdogMs) return;
    const seq = this.seq;
    setTimeout(() => { if (this.state === 'running' && this.inFlight && this.seq === seq) this.fail(`it did not return within ${SCENE_RUNTIME.watchdogMs} ms`, 'watchdog'); }, 0);
  }
}
