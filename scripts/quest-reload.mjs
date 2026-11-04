// Reload the ControlAnything tab in Quest Browser over CDP (adb), instead of `am start`, which opens a SECOND tab
// (two tabs fight over the camera and the session). Refuses while the wearer is in AR unless --force.
//   adb forward tcp:9222 localabstract:chrome_devtools_remote
//   node scripts/quest-reload.mjs [--force]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const force = process.argv.includes('--force');
const list = await (await fetch('http://localhost:9222/json')).json();
const pages = list.filter((t) => t.type === 'page' && t.url.includes('/quest/'));
if (!pages.length) { console.log('no /quest/ tab open: open http://localhost:8787/quest/ once in Quest Browser'); process.exit(1); }
if (pages.length > 1) console.log(`WARNING: ${pages.length} /quest/ tabs (${pages.map((p) => p.id).join(', ')}); close the extras (curl localhost:9222/json/close/<id>)`);
const page = pages[0];
const call = (ws, method, params = {}) => new Promise((resolve) => {
  const id = Math.floor(Math.random() * 1e9);
  ws.on('message', function onMsg(m) { const r = JSON.parse(m); if (r.id === id) { ws.off('message', onMsg); resolve(r.result); } });
  ws.send(JSON.stringify({ id, method, params }));
});
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.on('open', r));
const state = await call(ws, 'Runtime.evaluate', { expression: '!!window.__ce?.renderer?.xr?.isPresenting', returnByValue: true });
if (state?.result?.value && !force) { console.log('the wearer is in AR: not reloading (pass --force, or ask them to exit AR first)'); ws.close(); process.exit(2); }
await call(ws, 'Page.reload', { ignoreCache: true });
console.log(`reloaded tab ${page.id} (${page.url}); the wearer presses Enter AR`);
ws.close();
