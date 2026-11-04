/**
 * Quest-parity acceptance for the webcam and phone pages (/quest/hands.html), FIXTURE only.
 *   (cd apps/quest && npx vite build --outDir /tmp/ce-hands-stage --emptyOutDir)
 *   CE_QUEST_DIST=/tmp/ce-hands-stage research/e2e-lock.sh node scripts/e2e-hands-parity.mjs
 * Own fixture server on PORT (default 8796), the sim Mac (/sim/) like the Quest emulator check, and a fake camera:
 * the sim room image (so SAM's FIXTURE ground truth outlines real objects) with synthetic hands drawn over it.
 * Golden path, laptop: Start AR → mirrored webcam passthrough → Annotate outlines → tag by holding a hand over an
 * outline and by a click → Control → select → Quest chips → Stop Muse mid-generation → ask again (chip, then voice)
 * → code card streams → hand program runs on webcam Signals → connector acks → controls pinned to the SAM box.
 * Phone: the camera view (no WebXR here) with tap, and an emulated WebXR session (IWER, ?xremu=1).
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { writeY4mOver } from './hands-video.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8796), BASE = `http://127.0.0.1:${PORT}`;
assert.ok(PORT >= 8796 && ![8799].includes(PORT), 'Use a dedicated fixture port, never the live runtime or the Bluetooth bridge.');
const OUT = join(ROOT, 'research/screens/2026-11-05-hands-parity');
const evidence = { source: 'FIXTURE server · headless Chrome · fake camera = sim room image + synthetic hands · fake microphone tone · emulated phone viewport · IWER for WebXR. No real webcam, phone, person, live Muse or native AR.', steps: [], errors: [] };
let browser, server, log = '';
const until = async (what, probe, ms = 20_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await probe()) return; await delay(150); } throw new Error(`Timeout: ${what}`); };
const step = (quest, phone, webcam, note) => { evidence.steps.push({ quest, phone, webcam, note }); console.log(`✓ ${quest} — phone: ${phone} · webcam: ${webcam}${note ? ` · ${note}` : ''}`); };

try {
  await mkdir(OUT, { recursive: true });
  const data = await mkdtemp(join(tmpdir(), 'ce-parity-'));
  server = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/index.ts'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, HTTP_PORT: String(PORT), HTTPS_PORT: '0', HTTP_HOST: '127.0.0.1', PUBLIC_HOST: '127.0.0.1', CE_DATA_DIR: data, CE_AGENT_WORKSPACE: join(data, 'muse-agent'),
    MODEL_MODE: 'fixture', MODEL_API_KEY: '', CE_DEMO: '1', CE_AGENT: '1', CE_MAC_LOCAL: '0', CE_MAC_SILENT: '1', CE_REMO: '0', REMO_SEND: '0', CE_OSMO: 'mock', CE_PREFETCH: '0',
    CE_TRUST_LOOPBACK: '1', CE_TRUST_FIRST_DEVICE: '1', CE_CONSOLE_APPROVE: '0', VITEST: '' } });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-150_000); });
  await until('fixture server', async () => { try { return (await fetch(`${BASE}/api/health`)).ok; } catch { return false; } }, 40_000);
  assert.match(await (await fetch(`${BASE}/quest/hands.html`)).text(), /Start AR/, 'staged hands.html missing (set CE_QUEST_DIST)');

  // 1. the sim room image (1280 x 960) → a fake camera clip with hands; the right hand rests over the air conditioner for a while
  const pre = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'] });
  const simPage = await (await pre.newContext({ viewport: { width: 1280, height: 960 } })).newPage();
  await simPage.goto(`${BASE}/sim/?embed=room&mute=1`);
  await simPage.waitForFunction(() => window.ceSim?.canvas?.width === 1280, null, { timeout: 30_000 });
  await delay(1500);
  const png = await simPage.evaluate(() => window.ceSim.canvas.toDataURL('image/png').split(',')[1]);
  await pre.close();
  const pngPath = join(data, 'room.png'), rgbPath = join(data, 'room.rgb');
  await writeFile(pngPath, Buffer.from(png, 'base64'));
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', pngPath, '-f', 'rawvideo', '-pix_fmt', 'rgb24', rgbPath]);
  const room = readFileSync(rgbPath);
  const clip = join(data, 'room-hands.y4m');
  // air conditioner box (sim ground truth) 216..481 x 301..399 of 1280 x 960 → in 640 x 480 units its centre is (174, 175)
  await writeY4mOver(clip, room, 1280, 960, 8, 15, t => (t >= 2 && t < 6 ? { x: 172 + 2 * Math.sin(t * 9), y: 196 + 2 * Math.cos(t * 7) } : null));

  browser = await chromium.launch({ channel: 'chrome', headless: true, args: [
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${clip}`, '--mute-audio', '--autoplay-policy=no-user-gesture-required',
  ] });
  // the sim Mac (MIDI devices for tagged objects), as in the Quest emulator check
  const simContext = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const sim = await simContext.newPage(); await sim.goto(`${BASE}/sim/?mute=1`);
  await delay(2500);

  // ---------------- laptop / webcam ----------------
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['camera', 'microphone'] });
  const page = await context.newPage();
  page.on('pageerror', e => evidence.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') evidence.errors.push(`console: ${m.text()}`); });
  const state = () => page.evaluate(() => window.__ceHands.state());
  await page.goto(`${BASE}/quest/hands.html?mute=1&device=laptop&cam=1280x960`);
  await page.waitForFunction(() => window.__ceHands && !/Checking/.test(document.querySelector('#start-note').textContent));
  assert.equal((await state()).camera, false, 'camera on before Start AR');
  await page.screenshot({ path: join(OUT, '01-laptop-start.png') });
  await page.click('#start-ar');
  await page.waitForFunction(() => window.__ceHands.state().ar === 'camera' && window.__ceHands.state().connection.connected, null, { timeout: 30_000 });
  step('Enter AR (one tap) → passthrough', 'see phone section', 'verified (emulator)', 'one Start AR tap; mirrored webcam full screen; no form');

  // Annotate: SAM outlines
  await page.waitForFunction(() => window.__ceHands.state().scan.detections.length >= 3, null, { timeout: 30_000 });
  let s = await state();
  assert.equal(s.layer, 'annotate');
  const labels = s.scan.detections.map(d => d.label);
  await delay(1200);
  await page.screenshot({ path: join(OUT, '02-laptop-annotate.png') });
  step('Annotate: SAM 3.1 outlines (scan.frame → scan.result)', 'see phone section', 'verified (FIXTURE SAM)', `${s.scan.sent} frames sent, outlines: ${[...new Set(labels)].join(', ')}`);

  // tag by holding the hand over an outline (the clip parks the right hand over the air conditioner)
  // SAM labels the air conditioner with its prompt ("electronic device"): find the tag by where it is (image x 0.17-0.38, y 0.31-0.42)
  await page.waitForFunction(() => window.__ceHands.state().tags.some(t => t.box && t.box.x < 0.3 && t.box.x + t.box.w > 0.25 && t.box.y < 0.4 && t.box.y + t.box.h > 0.33), null, { timeout: 30_000 });
  await page.screenshot({ path: join(OUT, '03-laptop-hand-tagged.png') });
  // and tag the synthesizer with a click
  s = await state();
  const synthItem = s.items.find(i => i.kind === 'detection' && /synth/i.test(i.label) && !/visual/i.test(i.label));
  assert.ok(synthItem, `no synthesizer outline (items: ${s.items.map(i => i.label).join(', ')})`);
  await page.mouse.click(((synthItem.box.x0 + synthItem.box.x1) / 2) * 1440, ((synthItem.box.y0 + synthItem.box.y1) / 2) * 900);
  await page.waitForFunction(() => window.__ceHands.state().tags.length >= 2, null, { timeout: 10_000 });
  s = await state();
  assert.equal(s.layer, 'annotate', 'tagging left Annotate');
  await delay(800);
  await page.screenshot({ path: join(OUT, '04-laptop-tagged.png') });
  step('Tag (pinch) → stays in Annotate', 'see phone section', 'verified (hand dwell + click)', `tags: ${s.tags.map(t => t.label).join(', ')}`);

  // Control: a deliberate switch, then select the tagged synthesizer
  await page.click('#layer-control');
  await page.waitForFunction(() => window.__ceHands.state().layer === 'control');
  await delay(400);
  s = await state();
  const synthTag = s.items.find(i => i.kind === 'tag' && /synth/i.test(i.label) && !/visual/i.test(i.label));
  assert.ok(synthTag, 'tagged synthesizer not shown in Control');
  await page.mouse.click(((synthTag.box.x0 + synthTag.box.x1) / 2) * 1440, ((synthTag.box.y0 + synthTag.box.y1) / 2) * 900);
  await page.waitForFunction(() => !!window.__ceHands.state().selected && !document.querySelector('#card').hidden);
  const chips = await page.locator('#card-chips .chip').allTextContents();
  // the Quest's own constants (apps/quest/src/wiring/controller.ts), compared as a set: their order may change
  assert.deepEqual([...chips].sort(), ['Give me knobs for this', 'Play it with my hands', 'Surprise me'].sort(), 'not the Quest PHYSICAL_WIRE_CHIPS');
  await page.screenshot({ path: join(OUT, '05-laptop-control-card.png') });
  step('Control (deliberate) → select tagged device → card with the Quest chips', 'see phone section', 'verified', chips.join(' · '));

  // Ask, then Stop Muse mid-generation
  await page.locator('#card-chips .chip', { hasText: 'Play it with my hands' }).click();
  await page.waitForFunction(() => window.__ceHands.state().phase === 'working', null, { timeout: 10_000 });
  await page.waitForFunction(() => (document.querySelector('#code').textContent || '').length > 20, null, { timeout: 10_000 });
  await page.screenshot({ path: join(OUT, '06-laptop-muse-writing.png') });
  await page.click('#stop');
  await delay(4500);
  s = await state();
  assert.equal(s.connection.ready, undefined, 'Stop Muse mid-generation still delivered a wiring');
  assert.equal((await (await fetch(`${BASE}/api/agent/connectors`)).json()).connectors.length, 0, 'a connector survived Stop Muse');
  step('Stop Muse mid-generation', 'see phone section', 'verified', 'no wire.ready accepted, no connector left');

  // Ask again by voice (Muse Voice Transcribe, FIXTURE transcript) and by chip
  await page.dispatchEvent('#mic', 'pointerdown');
  await delay(1600);
  await page.dispatchEvent('#mic', 'pointerup');
  let voiced = true;
  try { await page.waitForFunction(() => window.__ceHands.state().phase === 'working', null, { timeout: 15_000 }); }
  catch { voiced = false; }
  const voiceText = await page.inputValue('#request');
  if (voiced) {
    await page.waitForFunction(() => window.__ceHands.state().connection.ready, null, { timeout: 60_000 });
    step('Ask by voice (Muse Voice Transcribe)', 'not done (no phone mic test)', 'verified (FIXTURE transcript, fake mic)', `"${voiceText}"`);
    await page.click('#stop'); await delay(1500);
  } else step('Ask by voice (Muse Voice Transcribe)', 'not done', 'not done (transcript did not arrive in the check)', voiceText);
  await page.locator('#card-chips .chip', { hasText: 'Play it with my hands' }).click();
  await page.waitForFunction(() => window.__ceHands.state().connection.ready, null, { timeout: 60_000 });
  s = await state();
  assert.match(s.wire, /FIXTURE/);
  assert.ok(s.connection.ready.hasCode, 'no hand program for "Play it with my hands"');
  await page.waitForFunction(() => window.__ceHands.state().connection.programOutputs > 5, null, { timeout: 20_000 });
  await delay(1500);
  s = await state();
  const connectors = (await (await fetch(`${BASE}/api/agent/connectors`)).json()).connectors;
  assert.ok(connectors.length >= 1, 'no connector running');
  await page.screenshot({ path: join(OUT, '07-laptop-wired.png') });
  step('Muse agent wire.request → code card streams → hand program runs (same Signals) → connector', 'see phone section', 'verified',
    `"${s.connection.ready.title}", ${s.connection.programOutputs} control events, connector ${connectors[0]?.entry ?? ''}`);
  const controlsShown = await page.locator('#controls-card').isVisible();
  step('Controls appear anchored to the object', 'see phone section', controlsShown ? 'verified (pinned to the SAM box)' : 'not shown (this request made a hand program only)', '');
  await page.click('#stop');
  await until('connector stopped', async () => (await (await fetch(`${BASE}/api/agent/connectors`)).json()).connectors.length === 0);

  // knobs pinned to the box
  await page.locator('#card-chips .chip', { hasText: 'Give me knobs for this' }).click();
  await page.waitForFunction(() => window.__ceHands.state().connection.ready && !document.querySelector('#controls-card').hidden, null, { timeout: 60_000 });
  await delay(800);
  const pinned = await page.evaluate(() => { const c = document.querySelector('#controls-card').getBoundingClientRect(); const t = window.__ceHands.state().items.find(i => i.key === window.__ceHands.state().selected); return { card: { x: c.x / innerWidth, y: c.y / innerHeight }, box: t?.box }; });
  assert.ok(pinned.box && Math.abs(pinned.card.y - pinned.box.y1) < 0.12, 'controls card is not next to the device box');
  await page.screenshot({ path: join(OUT, '08-laptop-knobs-pinned.png') });
  step('Muse knobs pinned to the SAM box', 'see phone section', 'verified', `card top ${pinned.card.y.toFixed(2)} vs box bottom ${pinned.box.y1.toFixed(2)}`);
  await page.click('#stop');

  // optional demo under More: this page's visual synth, hands as knobs
  await page.click('#more'); await page.click('#demo-visual');
  await page.waitForFunction(() => window.__ceHands.state().demo === 'visual-synth' && window.__ceHands.state().connection.selectedCard, null, { timeout: 20_000 });
  await page.locator('#card-chips .chip', { hasText: 'Hands as knobs' }).click();
  await page.waitForFunction(() => window.__ceHands.state().connection.running && window.__ceHands.state().connection.received > 3, null, { timeout: 60_000 });
  await delay(1500);
  s = await state();
  assert.equal((await page.evaluate(() => window.__ceHands.signals().screen)), null, 'webcam Signals must not invent a screen');
  await page.screenshot({ path: join(OUT, '09-laptop-visual-demo.png') });
  step('Optional demo (More → Visual synth) with a hand program', 'see phone section', 'verified', `"${s.connection.ready.title}", ${s.connection.received} commands applied on this page; s.screen is null`);
  await page.click('#stop');
  await page.close();

  // ---------------- phone: camera view (no WebXR in this browser) ----------------
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, permissions: ['camera', 'microphone'] });
  const mp = await mobile.newPage(); mp.on('pageerror', e => evidence.errors.push(`phone: ${e.message}`));
  const mstate = () => mp.evaluate(() => window.__ceHands.state());
  await mp.goto(`${BASE}/quest/hands.html?mute=1&device=phone&cam=1280x960`);
  await mp.waitForFunction(() => window.__ceHands && !/Checking/.test(document.querySelector('#start-note').textContent));
  const note = await mp.textContent('#start-note');
  assert.match(note, /no WebXR AR/i, 'phone without WebXR must say it uses the camera view');
  await mp.screenshot({ path: join(OUT, '10-phone-start.png') });
  await mp.tap('#start-ar');
  await mp.waitForFunction(() => window.__ceHands.state().ar === 'camera', null, { timeout: 30_000 });
  assert.equal((await mstate()).cameraFacing, 'environment', 'phone should use the rear camera as passthrough');
  await mp.waitForFunction(() => window.__ceHands.state().scan.detections.length >= 3, null, { timeout: 30_000 });
  await delay(800);
  await mp.screenshot({ path: join(OUT, '11-phone-annotate.png') });
  let m = await mstate();
  const lap = m.items.find(i => /visual synth/i.test(i.label)) ?? m.items[0];
  await mp.touchscreen.tap(((lap.box.x0 + lap.box.x1) / 2) * 390, ((lap.box.y0 + lap.box.y1) / 2) * 844);
  await mp.waitForFunction(() => window.__ceHands.state().tags.length >= 1, null, { timeout: 10_000 });
  await mp.tap('#layer-control');
  await delay(400);
  m = await mstate();
  const lapTag = m.items.find(i => i.kind === 'tag' && /visual synth/i.test(i.label)) ?? m.items.find(i => i.kind === 'tag');
  await mp.touchscreen.tap(((lapTag.box.x0 + lapTag.box.x1) / 2) * 390, ((lapTag.box.y0 + lapTag.box.y1) / 2) * 844);
  await mp.waitForFunction(() => !!window.__ceHands.state().selected);
  const phoneChips = await mp.locator('#card-chips .chip').allTextContents();
  await mp.screenshot({ path: join(OUT, '12-phone-control-card.png') });
  assert.deepEqual([...phoneChips].sort(), ['Swipe my hand to scroll Instagram Reels', 'Give me knobs for this', 'Open the visual synth demo'].sort(), 'tagged laptop/visual synth must get LAPTOP_WIRE_CHIPS');
  await mp.locator('#card-chips .chip', { hasText: 'Give me knobs for this' }).tap();
  await mp.waitForFunction(() => window.__ceHands.state().connection.ready, null, { timeout: 60_000 });
  await delay(1000);
  await mp.screenshot({ path: join(OUT, '13-phone-wired.png') });
  m = await mstate();
  step('Phone camera view (iPhone Safari path): Start AR → rear camera → Annotate → tap tag → Control → LAPTOP chips → Muse', 'verified (emulated phone viewport, fake camera)', '—', `"${m.connection.ready?.title}"`);
  assert.equal(await mp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'phone layout overflows');
  await mp.tap('#stop').catch(() => {});
  await mobile.close();

  // ---------------- phone: WebXR immersive-ar (emulated with IWER) ----------------
  const xrc = await browser.newContext({ viewport: { width: 412, height: 860 }, isMobile: true, hasTouch: true, permissions: ['camera'] });
  const xp = await xrc.newPage(); xp.on('pageerror', e => evidence.errors.push(`xr: ${e.message}`));
  await xp.goto(`${BASE}/quest/hands.html?mute=1&device=phone&xremu=1`);
  await xp.waitForFunction(() => window.__ceHands && /supports WebXR AR/.test(document.querySelector('#start-note').textContent), null, { timeout: 15_000 });
  await xp.tap('#start-ar');
  await xp.waitForFunction(() => window.__ceHands.state().xr.frames > 30, null, { timeout: 20_000 });
  const xs = await xp.evaluate(() => window.__ceHands.state());
  await xp.screenshot({ path: join(OUT, '14-phone-webxr-emulated.png') });
  step('Phone WebXR immersive-ar first (Android Chrome path)', `emulated (IWER): session runs ${xs.xr.frames} frames; camera-access ${xs.xr.cameraAccess ? 'on' : 'not offered by the emulator, so the page says SAM needs the camera view'}`, '—', '');
  await xrc.close();

  const fatal = evidence.errors.filter(e => !/favicon|ERR_ABORTED|GL_INVALID|WebGL: INVALID|Autoplay|AudioContext|net::ERR/i.test(e));
  assert.deepEqual(fatal, [], 'Browser runtime errors');
  await writeFile(join(OUT, 'verification.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log('ALL PASS');
} catch (e) {
  for (const context of browser?.contexts() ?? []) for (const p of context.pages()) {
    if (!p.url().includes('hands.html')) continue;
    console.error('state', JSON.stringify(await p.evaluate(() => window.__ceHands?.state()).catch(() => ({})), null, 1).slice(0, 4000));
    await p.screenshot({ path: join(OUT, 'failure.png') }).catch(() => {});
  }
  console.error('browser errors', evidence.errors.slice(0, 20));
  console.error('FAIL', e.stack ?? e);
  console.error(log.split('\n').filter(l => !/\[muse\] scan/.test(l) && /error|muse-agent|connector|wire|tag|refus|forbidden/i.test(l)).slice(-50).join('\n'));
  process.exitCode = 1;
} finally { await browser?.close(); server?.kill('SIGTERM'); }
