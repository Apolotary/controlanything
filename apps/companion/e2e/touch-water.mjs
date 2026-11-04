/**
 * Touch the water, in a real Chrome. Own silent fixture server on PORT (default 8798; HTTPS off), the real
 * companion at /companion/?visuals=1 (paired Mac identity), then CC22/23/24 sequences (tap, drag, hover, lift)
 * posted on the same BroadcastChannel the companion's virtual MIDI port uses, so the renderer takes the exact
 * path a headset's wiring takes after the server and the executor. Checks the pixels, not just the state.
 *
 *   npm run build -w @ce/companion    (or `npx vite build` in apps/companion)
 *   node apps/companion/e2e/touch-water.mjs            checks + screenshots in research/screens/touch-water/
 *   SHEETS=1 node ...                                  also contact sheets of every pattern/moment
 *
 * Silent: the page's audio constructors throw; nothing here makes sound. Requires sockets and Chrome (system, no download).
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openMacBrowser, pairMac, ROOT, startFixtureServer } from './harness.mjs';

const OUT = join(ROOT, 'research/screens/touch-water');
const PORT = Number(process.env.PORT || 8798);
const VIEWPORT = { width: Number(process.env.W || 1440), height: Number(process.env.H || 900) };
const PATTERNS = ['flow', 'rings', 'prism', 'water'];
let fixture, mac;

/** The in-page driver: CC22/23/24 on the visual synth's channel, timed with the page's own clock. */
function installDriver() {
  const channel = new BroadcastChannel('ce-visual-synth');
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const cc = (number, value) => channel.postMessage({ type: 'midi', bytes: [0xb0, number, Math.max(0, Math.min(127, Math.round(value)))] });
  const canvas = document.querySelector('#visual-launcher canvas');
  const shots = [];
  const grab = (label) => shots.push({ label, url: canvas.toDataURL('image/png') });
  const place = (x, y) => { cc(22, x); cc(23, y); };
  window.__touch = {
    cc, sleep, grab, shots, place,
    current: 0,
    pattern(index) { this.current = index; channel.postMessage({ type: 'midi', bytes: [0xc0, index] }); },
    /** Reset every parameter (CC120), then come back to the selected pattern. */
    reset() { channel.postMessage({ type: 'midi', bytes: [0xb0, 120, 0] }); channel.postMessage({ type: 'midi', bytes: [0xc0, this.current] }); },
    async tap(x, y, pressure = 100, hold = 140) { place(x, y); cc(24, pressure); await sleep(hold); cc(24, 0); },
    /** Drag through [x, y] points at `hz` updates a second for `ms`; the finger is down the whole way. */
    async drag(points, ms, hz = 40, pressure = 100, onStep) {
      const start = performance.now(); place(...points[0]); cc(24, pressure);
      for (;;) {
        const t = Math.min(1, (performance.now() - start) / ms), scaled = t * (points.length - 1), i = Math.min(points.length - 2, Math.floor(scaled)), f = scaled - i;
        place(points[i][0] + (points[i + 1][0] - points[i][0]) * f, points[i][1] + (points[i + 1][1] - points[i][1]) * f);
        onStep?.(t);
        if (t >= 1) break;
        await sleep(1000 / hz);
      }
    },
    /** Frame timing while `fn` runs: milliseconds between animation frames. */
    async frames(fn) {
      const deltas = []; let last = performance.now(), running = true;
      const tick = (now) => { deltas.push(now - last); last = now; if (running) requestAnimationFrame(tick); };
      requestAnimationFrame(tick); await fn(); running = false;
      deltas.sort((a, b) => a - b);
      return { frames: deltas.length, median: deltas[deltas.length >> 1], p95: deltas[Math.floor(deltas.length * .95)], max: deltas.at(-1) };
    },
    /** Milliseconds from posting the touch-down to the first animation frame whose pixels near (x, y) changed. */
    async latency(x, y) {
      const gl = canvas.getContext('webgl2');
      const px = Math.round(x / 127 * canvas.width), py = Math.round((1 - y / 127) * canvas.height);
      const read = () => { const data = new Uint8Array(40 * 40 * 4); gl.readPixels(Math.max(0, px - 20), Math.max(0, py - 20), 40, 40, gl.RGBA, gl.UNSIGNED_BYTE, data); return data; };
      await sleep(300); const before = read();
      return new Promise((done) => {
        const t0 = performance.now(); let frames = 0;
        place(x, y); cc(24, 110);
        const poll = () => {
          frames++;
          const now = read(); let diff = 0; for (let i = 0; i < now.length; i++) diff += Math.abs(now[i] - before[i]);
          if (diff / now.length > 6 || performance.now() - t0 > 1000) done({ ms: performance.now() - t0, frames, diff: diff / now.length });
          else requestAnimationFrame(poll);
        };
        requestAnimationFrame(poll);
      });
    },
  };
}

/** Compose captured canvas frames into one labelled contact sheet inside the page (no image library needed). */
async function sheet(page, name, columns = 4, cell = 480) {
  const url = await page.evaluate(async ({ columns, cell }) => {
    const shots = window.__touch.shots; if (!shots.length) return '';
    const h = Math.round(cell * (window.innerHeight / window.innerWidth)), rows = Math.ceil(shots.length / columns);
    const sheet = document.createElement('canvas'); sheet.width = columns * cell; sheet.height = rows * h;
    const g = sheet.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, sheet.width, sheet.height);
    for (const [i, shot] of shots.entries()) {
      const image = new Image(); image.src = shot.url; await image.decode();
      const x = (i % columns) * cell, y = Math.floor(i / columns) * h;
      g.drawImage(image, x, y, cell, h); g.font = '600 15px system-ui'; g.fillStyle = 'rgba(0,0,0,.65)'; g.fillRect(x, y, cell, 22);
      g.fillStyle = '#fff'; g.fillText(shot.label, x + 8, y + 16);
    }
    window.__touch.shots.length = 0;
    return sheet.toDataURL('image/png');
  }, { columns, cell });
  if (url) await writeFile(join(OUT, name), Buffer.from(url.split(',')[1], 'base64'));
}

async function saveShots(page, prefix) {
  const shots = await page.evaluate(() => { const all = window.__touch.shots.map((s) => ({ ...s })); return all; });
  for (const shot of shots) await writeFile(join(OUT, `${prefix}-${shot.label.replace(/[^a-z0-9.+-]+/gi, '_')}.png`), Buffer.from(shot.url.split(',')[1], 'base64'));
}

const run = {
  /** a tap: splash at the contact, echo, lift ring, rings keep expanding and fade */
  tap: (page, label, x = 64, y = 56) => page.evaluate(async ({ label, x, y }) => {
    const t = window.__touch; t.reset(); await t.sleep(250);
    t.place(x, y); t.cc(24, 100); await t.sleep(70); t.grab(`${label} tap +70ms`);
    await t.sleep(120); t.cc(24, 0); await t.sleep(130); t.grab(`${label} tap +320ms`);
    await t.sleep(330); t.grab(`${label} tap +650ms`); await t.sleep(650); t.grab(`${label} tap +1.3s`);
    await t.sleep(1500); t.grab(`${label} tap +2.8s`);
  }, { label, x, y }),
  /** a drag: down on the left, sweep an S-curve to the right, lift */
  drag: (page, label) => page.evaluate(async ({ label }) => {
    const t = window.__touch; t.reset(); await t.sleep(250);
    const path = [[18, 92], [42, 40], [66, 88], [92, 36], [112, 70]];
    let shots = 0;
    await t.drag(path, 1400, 40, 100, (u) => { if (u > .3 && shots === 0) { shots = 1; t.grab(`${label} drag 30%`); } if (u > .65 && shots === 1) { shots = 2; t.grab(`${label} drag 65%`); } });
    t.grab(`${label} drag end (down)`); await t.sleep(80); t.cc(24, 0); await t.sleep(500); t.grab(`${label} lift +0.5s`); await t.sleep(1300); t.grab(`${label} lift +1.8s`);
  }, { label }),
  /** a hover: the finger arrives at pressure 3, 10, 18 above the middle of the screen, then touches */
  hover: (page, label) => page.evaluate(async ({ label }) => {
    const t = window.__touch; t.reset(); await t.sleep(250);
    t.place(70, 60);
    for (const level of [3, 10, 18]) { t.cc(24, level); await t.sleep(600); t.grab(`${label} hover ${level}`); }
    t.cc(24, 90); await t.sleep(220); t.grab(`${label} contact +0.2s`); t.cc(24, 0);
  }, { label }),
};

try {
  await mkdir(OUT, { recursive: true });
  fixture = await startFixtureServer(PORT, 'touch-water');
  mac = await openMacBrowser(await pairMac(fixture, 'Touch-water fixture Mac'), VIEWPORT);
  const page = await mac.newPage();
  await page.goto(`${fixture.base}/companion/?visuals=1`);
  await page.locator('#visual-launcher canvas').waitFor({ state: 'visible' });
  await page.evaluate(installDriver);
  const gpu = await page.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl2'); const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); });
  console.log(`renderer: ${gpu} · canvas ${await page.evaluate(() => { const c = document.querySelector('#visual-launcher canvas'); return `${c.width}x${c.height}`; })}`);

  // Latency + frame cost first, on Water, before the screenshots add load.
  const report = { gpu, viewport: VIEWPORT };
  await page.evaluate(() => { window.__touch.pattern(3); });
  await delay(400);
  const latencies = [];
  for (const [x, y] of [[64, 60], [30, 40], [100, 90]]) {
    latencies.push(await page.evaluate(([x, y]) => { window.__touch.reset(); return window.__touch.latency(x, y); }, [x, y]));
    await page.evaluate(() => window.__touch.cc(24, 0));
  }
  report.touchToFirstPixelMs = latencies.map((l) => Math.round(l.ms));
  console.log('touch -> first changed pixels (ms, frames):', latencies.map((l) => `${Math.round(l.ms)} (${l.frames}f)`).join(' · '));
  report.dragFrames = await page.evaluate(() => { window.__touch.reset(); return window.__touch.frames(() => window.__touch.drag([[10, 100], [60, 20], [117, 100], [60, 60]], 2500, 40)); });
  await page.evaluate(() => window.__touch.cc(24, 0));
  console.log('frames while dragging with a full wake:', JSON.stringify(report.dragFrames));

  for (const [index, pattern] of PATTERNS.entries()) {
    await page.evaluate((i) => { window.__touch.reset(); window.__touch.pattern(i); }, index);
    await delay(500);
    await run.tap(page, pattern); await run.drag(page, pattern); await run.hover(page, pattern);
    if (process.env.SHEETS) await sheet(page, `sheet-${pattern}.png`, 4, 480);
    else await saveShots(page, `canvas-${pattern}`), await page.evaluate(() => { window.__touch.shots.length = 0; });
  }

  // Full-page evidence: drag + hover in each pattern, as the user sees the Mac (overlay chrome included).
  for (const [index, pattern] of PATTERNS.entries()) {
    await page.evaluate((i) => { window.__touch.reset(); window.__touch.pattern(i); }, index);
    await delay(500);
    const path = page.evaluate(() => window.__touch.drag([[16, 96], [46, 36], [78, 92], [106, 40]], 1500, 40));
    await delay(1150);
    await page.screenshot({ path: join(OUT, `${pattern}-drag.png`) });
    await path; await page.evaluate(() => window.__touch.cc(24, 0));
    await delay(300);
    await page.evaluate(() => { const t = window.__touch; t.reset(); t.place(70, 60); t.cc(24, 14); });
    await delay(900);
    await page.screenshot({ path: join(OUT, `${pattern}-hover.png`) });
    await page.evaluate(() => window.__touch.cc(24, 0));
  }
  // The spec: touch -> first visible ripple within ~80 ms, and no frame-time cliff with a full wake.
  for (const ms of report.touchToFirstPixelMs) assert(ms <= 80, `touch -> first changed pixels took ${ms} ms (limit 80)`);
  assert(report.dragFrames.p95 < 25, `frame p95 ${report.dragFrames.p95} ms while dragging`);
  report.audioAttempts = await page.evaluate(() => window.__audioAttempts);
  assert.equal(report.audioAttempts, 0);
  assert.deepEqual(mac.errors, []);
  await writeFile(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log('PASS touch-water pixels captured:', OUT);
} catch (error) {
  console.error('FAIL', error); process.exitCode = 1;
} finally {
  await mac?.browser.close();
  await fixture?.stop();
  if (mac?.errors.length) console.error('browser errors:', mac.errors.slice(0, 5));
}
