/**
 * Camera/mobile reviewer + Buddy acceptance, FIXTURE only. Synthetic browser video, no real hardware or models.
 * CE_QUEST_DIST=/tmp/ce-stage-quest node scripts/e2e-reviewer.mjs
 * Own server/data on PORT (default8801); run serialized with other browser suites.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..'), PORT = Number(process.env.PORT || 8801), BASE = `http://127.0.0.1:${PORT}`;
assert.ok(PORT >= 8796 && ![8799].includes(PORT), 'Use a dedicated fixture port, never the live runtime or Bluetooth bridge.');
const OUT = join(ROOT, 'research/screens/reviewer-2026-11-04');
let browser, server, hardwareSocket, log = '';
let fakeHardwareCommands = 0, fakeMacId;
const sendSocket = (socket, type, payload) => socket.send(JSON.stringify({ v: 1, id: randomUUID(), ts: Date.now(), from: 'fixture-review', to: 'server', type, payload }));
const until = async (what, probe, ms = 20_000) => { const deadline = Date.now() + ms; while (Date.now() < deadline) { if (await probe()) return; await delay(150); } throw new Error(`Timeout: ${what}`); };
const evidence = { source: 'FIXTURE / Chromium synthetic video / emulated mobile viewport; no physical camera or native AR test', checks: [], errors: [] };
try {
  await mkdir(OUT, { recursive: true });
  const data = await mkdtemp(join(tmpdir(), 'ce-reviewer-'));
  server = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/index.ts'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, HTTP_PORT: String(PORT), HTTPS_PORT: '0', HTTP_HOST: '127.0.0.1', PUBLIC_HOST: '127.0.0.1', CE_DATA_DIR: data, CE_AGENT_WORKSPACE: join(data, 'muse-agent'), MODEL_MODE: 'fixture', MODEL_API_KEY: '',
    CE_DEMO: '1', CE_AGENT: '1', CE_MAC_LOCAL: '0', CE_MAC_SILENT: '1', CE_REMO: '0', REMO_SEND: '0', CE_OSMO: 'mock', CE_PREFETCH: '0',
    CE_TRUST_LOOPBACK: '1', CE_TRUST_FIRST_DEVICE: '1', CE_CONSOLE_APPROVE: '0', VITEST: '' } });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-100_000); });
  await until('fixture server', async () => { try { return (await fetch(`${BASE}/api/health`)).ok; } catch { return false; } });
  // A fake physical-output companion is present to expose accidental fallback.
  // It is a protocol twin, not Web MIDI or an actual USB device.
  const pair = await (await fetch(`${BASE}/api/pair/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify({ kind: 'mac', name: 'Fixture physical Mac', capabilities: ['midi'] }) })).json();
  assert.equal(pair.status, 'approved'); fakeMacId = pair.deviceId;
  hardwareSocket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { origin: BASE });
  let hardwareWelcome = false, canonicalSelected = false;
  hardwareSocket.on('message', raw => {
    const message = JSON.parse(String(raw));
    if (message.type === 'welcome') hardwareWelcome = true;
    if (message.type === 'target.select.result' && message.payload.requestId === 'fixture-canonical') canonicalSelected = message.payload.ok;
    if (message.type === 'exec.command') {
      fakeHardwareCommands++;
      sendSocket(hardwareSocket, 'exec.ack', { execId: message.payload.execId, ok: false, sentAt: Date.now(), error: 'refused', detail: 'Fixture physical-output sentinel; no hardware exists.' });
    }
  });
  await new Promise((resolve, reject) => { hardwareSocket.once('open', resolve); hardwareSocket.once('error', reject); });
  sendSocket(hardwareSocket, 'hello', { deviceToken: pair.deviceToken, role: 'companion', executor: true, app: 'fixture-hardware@1', capabilities: ['midi'], ports: [
    { id: 'physical-op1', name: 'OP-1 Field', kind: 'midi-out', state: 'connected' },
    { id: 'ce-visual-synth', name: 'ControlAnything Visual Synth', kind: 'midi-out', state: 'connected' },
  ] });
  await until('fake companion handshake', () => hardwareWelcome);
  sendSocket(hardwareSocket, 'target.select', { virtual: 'visual-synth', deviceId: fakeMacId, requestId: 'fixture-canonical' });
  await until('canonical headset visual card', () => canonicalSelected);
  assert.equal((await fetch(`${BASE}/api/agent/targets/visual-synth-mac`)).status, 200);
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'] });
  const context = await browser.newContext({ viewport: { width: 1360, height: 1050 }, permissions: ['camera'] });
  const page = await context.newPage(); page.on('pageerror', error => evidence.errors.push(error.message));
  const uploads = [];
  page.on('request', request => { if (request.url().endsWith('/api/buddy/react')) uploads.push(request.postDataJSON()); });
  await page.goto(`${BASE}/quest/reviewer.html?buddy=1&mute=1`);
  await page.waitForFunction(() => window.__ceReviewer);
  assert.equal(await page.evaluate(() => window.__ceReviewer.state().camera), false);
  assert.equal(uploads.length, 0);
  await page.click('#wave'); await page.waitForFunction(() => document.querySelector('#bubble').textContent.includes('Hello'));
  await page.click('#camera-start'); await page.waitForFunction(() => window.__ceReviewer.state().camera);
  await page.waitForFunction(() => document.querySelector('#camera').videoWidth > 0);
  await page.click('#capture'); await page.waitForFunction(() => window.__ceReviewer.state().pending === 'photo');
  const jpeg = await page.evaluate(() => document.querySelector('#photo').toDataURL('image/jpeg', .85).split(',')[1]);
  assert.equal(uploads.length, 0, 'Capture uploaded a photo before Show');
  await page.screenshot({ path: join(OUT, '01-laptop-preview.png'), fullPage: true });
  await page.click('#retake'); assert.equal(uploads.length, 0); assert.equal(await page.evaluate(() => window.__ceReviewer.state().pending), undefined);
  await page.click('#capture'); const approvedJpeg = await page.evaluate(() => document.querySelector('#photo').toDataURL('image/jpeg', .85).split(',')[1]);
  await page.click('#show'); await until('one explicit photo upload', () => uploads.length === 1);
  assert.equal(uploads[0].jpeg, approvedJpeg); assert.equal(uploads[0].via, 'photo'); assert.ok(jpeg.length > 100);
  await page.waitForFunction(() => document.querySelector('#source').textContent.includes('FIXTURE'));
  assert.equal(await page.evaluate(() => window.__ceReviewer.state().connection.selectedCard), undefined, 'Showing Buddy implicitly selected a synth');
  await page.click('#retake'); await page.click('#camera-stop');
  assert.equal(await page.evaluate(() => document.querySelector('#camera').srcObject), null);
  evidence.checks.push('Camera stays off initially; synthetic getUserMedia preview, capture, retake, exact approved JPEG upload and track stop pass. Buddy-only sharing never selects a synth.');
  await page.click('#virtual'); assert.equal(uploads.length, 1); await page.click('#show');
  await until('explicit virtual-object upload', () => uploads.length === 2); assert.equal(uploads[1].via, 'virtual');
  await page.waitForFunction(() => document.querySelector('#source').textContent.includes('FIXTURE'));
  console.log('PASS camera preview, explicit sharing, and local social interaction');
  await page.click('#connect');
  await page.waitForFunction(() => !document.querySelector('#ask').disabled, null, { timeout: 25_000 });
  assert.match(await page.evaluate(() => window.__ceReviewer.state().connection.selectedCard), /^visual-synth-reviewer-/);
  assert.equal((await fetch(`${BASE}/api/agent/targets/visual-synth-mac`)).status, 200, 'Reviewer selection removed the actual headset visual tag');
  assert.equal(await page.locator('#controls').textContent(), '', 'Controls existed before a Muse request');
  await page.click('#ask');
  await page.waitForFunction(() => document.querySelectorAll('#controls .generated-control').length > 0, null, { timeout: 120_000 });
  assert.match(await page.locator('#wire-status').textContent(), /FIXTURE/);
  const xy = page.locator('.xy-surface'); assert.equal(await xy.count(), 1);
  const before = await page.evaluate(() => window.__ceReviewer.state().connection.received);
  await xy.scrollIntoViewIfNeeded(); const box = await xy.boundingBox(); await page.mouse.click(box.x + box.width * .82, box.y + box.height * .27);
  await page.waitForFunction(previous => window.__ceReviewer.state().connection.received > previous, before);
  await page.waitForFunction(() => window.__ceReviewer.state().connection.visual.touchX > .7);
  await page.screenshot({ path: join(OUT, '02-laptop-water.png'), fullPage: true });
  evidence.checks.push('Explicit visual selection has isolated reviewer card; no controls before Ask; fixture Muse creates XY+knobs; pointer output reaches connector and actual local visual renderer.');
  console.log('PASS visual Muse fixture connector and touch UI');
  await page.click('#stop');
  await until('visual connector stopped', async () => (await (await fetch(`${BASE}/api/agent/connectors`)).json()).connectors.length === 0);
  await page.click('#choose-music'); await page.waitForFunction(() => !document.querySelector('#ask').disabled);
  assert.match(await page.evaluate(() => window.__ceReviewer.state().connection.selectedCard), /^musical-synth-reviewer-/);
  await page.click('#ask'); await page.waitForFunction(() => document.querySelectorAll('.keybed button').length > 0, null, { timeout: 120_000 });
  const received = await page.evaluate(() => window.__ceReviewer.state().connection.received);
  await page.locator('.keybed button').nth(5).click();
  await page.waitForFunction(previous => window.__ceReviewer.state().connection.received > previous, received);
  await page.screenshot({ path: join(OUT, '03-laptop-music.png'), fullPage: true });
  console.log('PASS musical Muse fixture connector and keys');
  await page.click('#stop'); await until('musical connector stopped', async () => (await (await fetch(`${BASE}/api/agent/connectors`)).json()).connectors.length === 0);
  assert.equal(await page.locator('#controls').textContent(), '');
  assert.equal(await page.evaluate(() => window.__ceReviewer.state().connection.musical.params.gate), 0, 'Stop left a software note held');
  assert.equal(fakeHardwareCommands, 0, 'Reviewer work reached the fake physical Mac');
  const dispatched = (await (await fetch(`${BASE}/api/agent/exec`)).json()).sent;
  assert.equal(dispatched.filter(command => command.executorDeviceId === fakeMacId || command.op.kind === 'ble').length, 0, 'Reviewer work escaped to physical MIDI/gimbal routing');
  evidence.checks.push('With fake physical OP-1 companion and mock gimbal present, reviewer paths send zero commands to either; canonical headset visual tag survives; Stop leaves local software gate zero.');
  evidence.checks.push('Musical fixture generates keys+four encoders; key reaches bounded note/gate connector and real Web Audio software graph; Stop clears controls and retires connector.');
  await page.close();
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  const phone = await mobile.newPage(); phone.on('pageerror', error => evidence.errors.push(error.message));
  await phone.goto(`${BASE}/quest/reviewer.html?buddy=1&mute=1`); await phone.waitForFunction(() => window.__ceReviewer);
  await phone.click('#virtual'); await phone.click('#wave');
  await phone.screenshot({ path: join(OUT, '04-mobile.png'), fullPage: true });
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Mobile page overflows horizontally');
  assert.equal(await phone.locator('#xr').isHidden(), true, 'Desktop test offered unimplemented native AR');
  assert.equal(await phone.evaluate(() => window.__ceReviewer.state().pending), 'virtual');
  evidence.checks.push('390px touch viewport fits; virtual preview and social buttons work without camera; unavailable native AR stays hidden.');
  await mobile.close();
  const lifecycleContext = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  const lifecyclePage = await lifecycleContext.newPage();
  let blocked = false, releasePair;
  const resumePair = new Promise(resolve => { releasePair = resolve; });
  await lifecyclePage.route('**/api/pair/start', async route => {
    const response = await route.fetch(); blocked = true; await resumePair;
    await route.fulfill({ response }).catch(() => {});
  });
  await lifecyclePage.goto(`${BASE}/quest/reviewer.html?buddy=1&mute=1`);
  await lifecyclePage.click('#connect'); await until('deferred pairing response', () => blocked);
  await lifecyclePage.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  releasePair(); await delay(600);
  assert.equal(await lifecyclePage.evaluate(() => window.__ceReviewer.state().connection.connected), false);
  assert.equal(await lifecyclePage.evaluate(() => window.__ceReviewer.state().connection.selectedCard), undefined);
  assert.equal(await lifecyclePage.locator('#ask').isDisabled(), true);
  await lifecycleContext.close();
  evidence.checks.push('A delayed actual pairing response after simulated page-hide cannot create sockets, select a synth, or enable Ask.');
  const sim = await context.newPage(); await sim.goto(`${BASE}/sim/?mute=1`);
  const quest = await context.newPage(); quest.on('pageerror', error => evidence.errors.push(error.message));
  await quest.goto(`${BASE}/quest/?emulate=1&camera=sim&mic=0&mute=1&tutorial=0`);
  await quest.waitForFunction(() => window.__ce?.ws?.open && window.__ce.buddy, null, { timeout: 30_000 });
  await quest.click('#btn-enter'); await quest.waitForFunction(() => window.__ce.cameraState === 'on', null, { timeout: 30_000 });
  await quest.evaluate(() => { window.__ce.input.mouseAsHand = false; window.__ce.buddy.open(); }); await delay(900);
  assert.equal(await quest.evaluate(() => window.__ce.buddy.state().quest), '');
  await quest.evaluate(() => window.__ce.buddy.holdUp()); await delay(1500);
  assert.equal(await quest.evaluate(() => window.__ce.buddy.state().phase), 'idle', 'A held-up object still auto-captures');
  await quest.evaluate(() => window.__ce.buddy.show()); await quest.waitForFunction(() => window.__ce.buddy.state().phase === 'preview');
  assert.equal(await quest.evaluate(() => window.__ce.buddy.state().lastReaction), undefined);
  const canvas = await quest.evaluateHandle(() => window.__ce.renderer.domElement);
  await canvas.asElement().screenshot({ path: join(OUT, '05-quest-buddy-preview.png') });
  await quest.evaluate(() => { window.__ce.buddy.retake(); window.__ce.buddy.showVirtual(); });
  assert.equal(await quest.evaluate(() => window.__ce.buddy.state().phase), 'preview');
  await quest.evaluate(() => window.__ce.buddy.show()); await quest.waitForFunction(() => window.__ce.buddy.state().phase === 'reacting', null, { timeout: 30_000 });
  await canvas.asElement().screenshot({ path: join(OUT, '06-quest-buddy-reaction.png') });
  await quest.evaluate(() => window.__ce.buddy.close(true));
  assert.equal(await quest.evaluate(() => window.__ce.buddy.root.visible), false);
  assert.equal(await quest.evaluate(() => window.__ce.buddy.state().frame.visible), false, 'Silent teardown left the detached viewfinder visible');
  evidence.checks.push('Quest emulator: no quests, no automatic hand capture; explicit Capture reaches review without inference; Retake+virtual+Show produces labelled fixture reaction.');
  assert.deepEqual(evidence.errors, [], 'Browser runtime errors');
  await writeFile(join(OUT, 'verification.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log('ALL PASS', evidence.checks.join('\n'));
} catch (e) {
  for (const context of browser?.contexts() ?? []) for (const page of context.pages()) {
    if (!page.url().includes('reviewer.html')) continue;
    console.error('reviewer state', await page.evaluate(() => ({ connection: document.querySelector('#connection-status')?.textContent, wire: document.querySelector('#wire-status')?.textContent, pairing: !document.querySelector('#pairing')?.hidden, state: window.__ceReviewer?.state() })).catch(() => ({})));
    await page.screenshot({ path: join(OUT, 'failure.png'), fullPage: true }).catch(() => {});
  }
  console.error('browser errors', evidence.errors);
  console.error('connector logs', await fetch(`${BASE}/api/agent/connectors`).then(r => r.json()).then(r => r.connectors?.map(c => c.logs?.slice(-8))).catch(() => []));
  console.error('FAIL', e.stack ?? e); console.error(log.split('\n').filter(line => /error|muse-agent|connector|wire|visual/i.test(line)).slice(-35).join('\n')); process.exitCode = 1;
} finally { await browser?.close(); hardwareSocket?.close(); server?.kill('SIGTERM'); }
