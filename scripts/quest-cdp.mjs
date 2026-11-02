#!/usr/bin/env node
// Evaluate a JavaScript expression inside the ControlEverything page running in Quest Browser,
// over the Chrome DevTools Protocol forwarded by adb. Dev tool only.
//
//   adb forward tcp:9222 localabstract:chrome_devtools_remote
//   node scripts/quest-cdp.mjs "window.__ce.renderer.info.render.calls"
//   node scripts/quest-cdp.mjs --fps            # XR frame rate + draw calls over ~90 frames
//   node scripts/quest-cdp.mjs --hands 4500     # hand/joint/pinch sampling for N ms
//
// The app exposes `window.__ce` (session, input, renderer, hud, camera, ws, lastFrame, ...).
import { createRequire } from 'node:module';

const require = createRequire(new URL('../package.json', import.meta.url));
const WebSocket = require('ws');

const FPS = `new Promise((res) => { const c = window.__ce; const s = c.session; if (!s) return res('no XR session');
  const ts = []; const step = (t) => { ts.push(t); if (ts.length < 90) s.requestAnimationFrame(step); else {
  const d = ts.slice(1).map((x, i) => x - ts[i]).sort((a, b) => a - b); const r = c.renderer.info;
  res({ fps: +(1000 / (d.reduce((a, b) => a + b, 0) / d.length)).toFixed(1), p50ms: +d[d.length >> 1].toFixed(1),
        p95ms: +d[Math.floor(d.length * 0.95)].toFixed(1), drawCalls: r.render.calls, triangles: r.render.triangles,
        textures: r.memory.textures, geometries: r.memory.geometries, sessionRate: s.frameRate }); } };
  s.requestAnimationFrame(step); })`;

const HANDS = (ms) => `new Promise((res) => { const c = window.__ce; const s = c.session; if (!s) return res('no XR session');
  const st = { frames: 0, handSources: 0, jointHits: 0, jointNulls: 0, errors: 0, minPinchM: 9, select: 0 };
  const onSel = () => st.select++; s.addEventListener('selectstart', onSel); const t0 = performance.now();
  const step = (t, frame) => { st.frames++; for (const src of frame.session.inputSources) { if (!src.hand) continue; st.handSources++;
    let a = null, b = null; try { a = frame.getJointPose(src.hand.get('thumb-tip'), c.refSpace); b = frame.getJointPose(src.hand.get('index-finger-tip'), c.refSpace); } catch (e) { st.errors++; st.error = String(e); }
    if (a && b) { st.jointHits++; const p = a.transform.position, q = b.transform.position; st.minPinchM = Math.min(st.minPinchM, +Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z).toFixed(4)); } else st.jointNulls++; }
    if (performance.now() - t0 < ${ms}) s.requestAnimationFrame(step); else { s.removeEventListener('selectstart', onSel); res(st); } };
  s.requestAnimationFrame(step); })`;

const arg = process.argv[2];
const expr = arg === '--fps' ? FPS : arg === '--hands' ? HANDS(Number(process.argv[3] ?? 4500)) : arg;
if (!expr) {
  console.error('usage: quest-cdp.mjs "<js>" | --fps | --hands [ms]');
  process.exit(2);
}
const list = await (await fetch('http://localhost:9222/json')).json();
const page = list.find((t) => t.type === 'page' && t.url.includes('/quest/'));
if (!page) {
  console.error('no /quest/ page open in Quest Browser (is adb forward tcp:9222 set?)');
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })));
ws.on('message', (m) => {
  const r = JSON.parse(String(m));
  if (r.id !== 1) return;
  console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails ?? r.result, null, 1));
  ws.close();
  process.exit(0);
});
setTimeout(() => {
  console.error('timeout');
  process.exit(1);
}, Number(process.argv[3] ?? 4500) + 8000);
