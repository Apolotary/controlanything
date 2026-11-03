#!/usr/bin/env node
// Measure and inspect the ControlAnything page running in Quest Browser over the Chrome DevTools
// Protocol, forwarded by adb. Dev tool only: it reads state and samples frames, it never reloads.
//
//   node scripts/quest-cdp.mjs "window.__ce.renderer.info.render.calls"   evaluate an expression
//   node scripts/quest-cdp.mjs --fps [frames=450]    XR frame time p50/p95/p99, fps, draws, triangles, renders/frame
//   node scripts/quest-cdp.mjs --state               mode, HUD, socket, targets, setup, armed cards, render cost
//   node scripts/quest-cdp.mjs --sweep [ms=6000]     HUD visibility flips per frame (blink hunt during a head sweep)
//   node scripts/quest-cdp.mjs --hands [ms=4500]     hand joints and pinch distance sampling
//   node scripts/quest-cdp.mjs --screenshot [out.png] compositor screenshot (with passthrough) via metacam, then adb pull
// Video: record in the headset (Meta button → Camera → Record video); this Quest's metacam service only takes screenshots over adb.
//   node scripts/quest-cdp.mjs --awake on|off        keep the headset awake on the desk (proximity sensor override)
//
// Options: --serial <adb serial> (default: $ANDROID_SERIAL or the only device), --json (machine output only).
// The adb forward (tcp:9222 -> localabstract:chrome_devtools_remote) is created when missing.
// The app exposes `window.__ce` (session, renderer, hud, ws, modes, ...).
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(new URL('../package.json', import.meta.url));
const WebSocket = require('ws');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const serial = option('--serial') ?? process.env.ANDROID_SERIAL;
const jsonOnly = flag('--json');
const adb = (...args) => execFileSync('adb', [...(serial ? ['-s', serial] : []), ...args], { encoding: 'utf8', timeout: 20_000 }).trim();
const say = (...line) => { if (!jsonOnly) console.error(...line); };

// --- in-page probes (strings evaluated in Quest Browser) ------------------------------------

const PCT = `const pct = (a, q) => a.length ? a[Math.min(a.length - 1, Math.floor(a.length * q))] : null;`;

const FPS = (frames) => `new Promise((res) => { const c = window.__ce; const s = c?.session; if (!s) return res({ error: 'no XR session (Enter AR first)' });
  ${PCT}
  const r = c.renderer, info = r.info; const t = [], calls = [], tris = [], renders = []; let lastFrame = info.render.frame;
  const giveUp = setTimeout(() => res({ error: 'no XR frames within 10 s (headset asleep or session paused?)', frames: t.length }), 10000);
  const step = (time) => { t.push(time); calls.push(info.render.calls); tris.push(info.render.triangles);
    renders.push(info.render.frame - lastFrame); lastFrame = info.render.frame;
    if (t.length < ${frames} + 1) return void s.requestAnimationFrame(step);
    clearTimeout(giveUp);
    const dt = t.slice(1).map((x, i) => x - t[i]); const sorted = [...dt].sort((a, b) => a - b);
    const rate = s.frameRate || 72; const budget = 1000 / rate;
    const nums = (a) => [...a].sort((x, y) => x - y);
    const mem = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
    res({ frames: dt.length, seconds: +((t.at(-1) - t[0]) / 1000).toFixed(1), sessionRate: rate, supportedRates: s.supportedFrameRates ? [...s.supportedFrameRates] : null,
      fps: +(1000 / (dt.reduce((a, b) => a + b, 0) / dt.length)).toFixed(1),
      p50ms: +pct(sorted, 0.5).toFixed(2), p95ms: +pct(sorted, 0.95).toFixed(2), p99ms: +pct(sorted, 0.99).toFixed(2), maxms: +sorted.at(-1).toFixed(2),
      fpsAtP95: +(1000 / pct(sorted, 0.95)).toFixed(1), budgetMs: +budget.toFixed(2),
      missed: dt.filter((x) => x > budget * 1.5).length, missedPct: +(100 * dt.filter((x) => x > budget * 1.5).length / dt.length).toFixed(1),
      drawCalls: { p50: pct(nums(calls), 0.5), max: Math.max(...calls) }, triangles: { p50: pct(nums(tris), 0.5), max: Math.max(...tris) },
      rendersPerFrame: { p50: pct(nums(renders), 0.5), max: Math.max(...renders) }, autoReset: info.autoReset,
      programs: info.programs?.length ?? null, textures: info.memory.textures, geometries: info.memory.geometries, heapMB: mem,
      visibility: s.visibilityState, mode: c.modes?.mode ?? c.modes?.current ?? null, hud: c.hudKind ?? null }); };
  s.requestAnimationFrame(step); })`;

const STATE = `(() => { const c = window.__ce; if (!c) return { error: 'window.__ce missing (not the ControlAnything page?)' };
  const safe = (f) => { try { return f(); } catch (e) { return 'err: ' + e.message; } };
  const s = c.session; const info = c.renderer?.info;
  const size = (v) => v == null ? null : typeof v.size === 'number' ? v.size : Array.isArray(v) ? v.length : typeof v === 'object' ? Object.keys(v).length : v;
  let objects = 0, visibleMeshes = 0, transparent = 0;
  safe(() => c.scene.traverseVisible((o) => { objects++; if (o.isMesh || o.isLine || o.isPoints) { visibleMeshes++; const m = Array.isArray(o.material) ? o.material[0] : o.material; if (m?.transparent) transparent++; } }));
  return { url: location.pathname + location.search, page: document.visibilityState, focus: document.hasFocus(),
    xr: s ? { rate: s.frameRate, visibility: s.visibilityState, presenting: c.renderer?.xr?.isPresenting, blend: s.environmentBlendMode, features: s.enabledFeatures ? [...s.enabledFeatures] : null } : null,
    socket: safe(() => ({ open: c.ws?.open ?? null, ready: c.ws?.readyState ?? c.ws?.socket?.readyState ?? null })),
    identity: safe(() => c.identity ? { deviceId: c.identity.deviceId, kind: c.identity.kind, name: c.identity.name } : null),
    server: safe(() => c.welcome ? { mode: c.welcome.mode, server: c.welcome.server } : c.serverMode ?? null),
    mode: safe(() => c.modes?.mode ?? c.modes?.current ?? null), hud: c.hudKind ?? null,
    targets: safe(() => size(c.targets)), tags: safe(() => size(c.modes?.tags)), lockedId: c.lockedId ?? null,
    visualSynthIntent: safe(() => c.visualSynthIntent ? { phase: c.visualSynthIntent.phase, cardId: c.visualSynthIntent.cardId } : null),
    activeSetup: safe(() => c.activeSetup ? { cardId: c.activeSetup.cardId, phase: c.activeSetup.phase ?? c.activeSetup.stage ?? null } : null),
    armedCards: safe(() => c.armedCards ? [...(c.armedCards.keys?.() ?? c.armedCards)] : null),
    handMapping: safe(() => c.handMapping ? { active: c.handMapping.active ?? null, engaged: c.handMapping.engaged ?? null } : null),
    mac: safe(() => { const m = c.onboarding?.online; return m ? { name: m.name, online: m.online, visualPort: m.ports?.find((p) => p.id === 'ce-visual-synth')?.state ?? null } : null; }),
    camera: safe(() => ({ state: c.cameraState ?? null, note: c.cameraNote ?? null })), yolo: safe(() => c.yoloStats ?? null),
    render: info ? { calls: info.render.calls, triangles: info.render.triangles, textures: info.memory.textures, geometries: info.memory.geometries, programs: info.programs?.length ?? null } : null,
    scene: { visibleObjects: objects, visibleDrawables: visibleMeshes, transparent },
    frameErrors: size(c.frameErrors), heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null }; })()`;

const SWEEP = (ms) => `new Promise((res) => { const c = window.__ce; const s = c?.session; if (!s) return res({ error: 'no XR session' });
  const root = c.hud?.root ?? c.scene; const flips = new Map(); let last = new Map(); let frames = 0, changedFrames = 0; const t0 = performance.now();
  const label = (o) => { const names = []; for (let p = o; p && p !== root && names.length < 3; p = p.parent) if (p.name) names.push(p.name); return names.join('<') || o.type; };
  const giveUp = setTimeout(() => res({ error: 'no XR frames within 10 s', frames }), Math.max(10000, ${ms} + 4000));
  const step = () => { frames++; const now = new Map();
    root.traverseVisible((o) => { if (!(o.isMesh || o.isLine || o.isPoints)) return; const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (m && m.opacity > 0.02 && m.visible !== false) now.set(o.id, o); });
    if (frames > 1) { let changed = false;
      for (const [id, o] of now) if (!last.has(id)) { changed = true; const k = label(o); flips.set(k, (flips.get(k) ?? 0) + 1); }
      for (const [id, o] of last) if (!now.has(id)) { changed = true; const k = label(o); flips.set(k, (flips.get(k) ?? 0) + 1); }
      if (changed) changedFrames++; }
    last = now;
    if (performance.now() - t0 < ${ms}) s.requestAnimationFrame(step);
    else { clearTimeout(giveUp); res({ frames, changedFrames, drawablesNow: now.size,
      topFlippers: [...flips].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, n]) => ({ name, flips: n })) }); } };
  s.requestAnimationFrame(step); })`;

const HANDS = (ms) => `new Promise((res) => { const c = window.__ce; const s = c?.session; if (!s) return res({ error: 'no XR session' });
  const st = { frames: 0, handSources: 0, jointHits: 0, jointNulls: 0, errors: 0, minPinchM: 9, select: 0 };
  const onSel = () => st.select++; s.addEventListener('selectstart', onSel); const t0 = performance.now();
  const step = (t, frame) => { st.frames++; for (const src of frame.session.inputSources) { if (!src.hand) continue; st.handSources++;
    let a = null, b = null; try { a = frame.getJointPose(src.hand.get('thumb-tip'), c.refSpace); b = frame.getJointPose(src.hand.get('index-finger-tip'), c.refSpace); } catch (e) { st.errors++; st.error = String(e); }
    if (a && b) { st.jointHits++; const p = a.transform.position, q = b.transform.position; st.minPinchM = Math.min(st.minPinchM, +Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z).toFixed(4)); } else st.jointNulls++; }
    if (performance.now() - t0 < ${ms}) s.requestAnimationFrame(step); else { s.removeEventListener('selectstart', onSel); res(st); } };
  s.requestAnimationFrame(step); })`;

// --- CDP plumbing ----------------------------------------------------------------------------

async function targets() {
  const list = async () => (await fetch('http://localhost:9222/json', { signal: AbortSignal.timeout(3000) })).json();
  try { return await list(); } catch {
    say('setting up adb forward tcp:9222 -> chrome_devtools_remote');
    adb('forward', 'tcp:9222', 'localabstract:chrome_devtools_remote');
    return list();
  }
}

async function evaluate(expression, timeoutMs) {
  const page = (await targets()).find((t) => t.type === 'page' && t.url.includes('/quest/'));
  if (!page) throw new Error('no /quest/ page open in Quest Browser');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  return new Promise((resolveValue, reject) => {
    const timer = setTimeout(() => { ws.terminate(); reject(new Error(`no answer within ${timeoutMs} ms`)); }, timeoutMs);
    ws.on('error', (error) => { clearTimeout(timer); reject(error); });
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })));
    ws.on('message', (raw) => {
      const r = JSON.parse(String(raw));
      if (r.id !== 1) return;
      clearTimeout(timer); ws.close();
      if (r.result?.exceptionDetails) reject(new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text));
      else resolveValue(r.result?.result?.value ?? r.result);
    });
  });
}

// --- headset-side actions (adb) --------------------------------------------------------------

async function screenshot(out) {
  mkdirSync(dirname(out), { recursive: true });
  const dir = '/sdcard/Oculus/Screenshots';
  const list = () => { try { return new Set(adb('shell', `ls -1 ${dir} 2>/dev/null`).split('\n').filter(Boolean)); } catch { return new Set(); } };
  const before = list();
  // The system capture service (what the headset's own screenshot uses): composited view, passthrough included.
  adb('shell', 'am', 'startservice', '-n', 'com.oculus.metacam/.capture.CaptureService', '-a', 'TAKE_SCREENSHOT');
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const fresh = [...list()].filter((name) => !before.has(name));
    if (fresh.length) {
      await new Promise((r) => setTimeout(r, 600)); // let the encoder finish writing
      adb('pull', `${dir}/${fresh.sort().at(-1)}`, out);
      return { out, bytes: statSync(out).size, method: 'metacam service + adb pull' };
    }
  }
  return { error: 'no new file in /sdcard/Oculus/Screenshots after 10 s (headset asleep?). Alternative: npx -y metavr@1.8.1 capture screenshot --method metacam -o ' + out };
}

function awake(on) {
  // Simulates the proximity sensor so the display stays on while the headset rests on the desk.
  adb('shell', 'am', 'broadcast', '-a', on ? 'com.oculus.vrpowermanager.prox_close' : 'com.oculus.vrpowermanager.automation_disable');
  if (on) adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
  return { awake: on, wakefulness: adb('shell', 'dumpsys power | grep mWakefulness=').trim() };
}

// --- main ------------------------------------------------------------------------------------

const numberAfter = (name, fallback) => { const v = Number(option(name)); return Number.isFinite(v) && v > 0 ? v : fallback; };
let result;
try {
  if (flag('--fps')) result = await evaluate(FPS(numberAfter('--fps', 450)), 30_000);
  else if (flag('--state')) result = await evaluate(STATE, 8000);
  else if (flag('--sweep')) { const ms = numberAfter('--sweep', 6000); say(`sweep your head left-right for ${ms / 1000} s…`); result = await evaluate(SWEEP(ms), ms + 15_000); }
  else if (flag('--hands')) { const ms = numberAfter('--hands', 4500); result = await evaluate(HANDS(ms), ms + 8000); }
  else if (flag('--screenshot')) result = await screenshot(resolve(option('--screenshot')?.startsWith('--') || !option('--screenshot') ? `quest-${Date.now()}.png` : option('--screenshot')));
  else if (flag('--awake')) result = awake(option('--awake') !== 'off');

  else {
    const expr = argv.find((a) => !a.startsWith('--') && a !== serial);
    if (!expr) { console.error('usage: quest-cdp.mjs "<js>" | --fps [n] | --state | --sweep [ms] | --hands [ms] | --screenshot [out.png] | --awake on|off'); process.exit(2); }
    result = await evaluate(expr, 15_000);
  }
} catch (error) {
  console.error(`quest-cdp: ${error.message}`);
  process.exit(1);
}
console.log(JSON.stringify(result, null, jsonOnly ? 0 : 1));
process.exit(result && typeof result === 'object' && 'error' in result ? 1 : 0);
