/** Actual companion + actual emulated HUD. No manual Open visuals click on the happy path.
 * Own silent fixture server 8807/8457; no physical camera, MIDI or audio. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import WebSocket from 'ws';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'research/screens/synth-launch');
const BASE = 'http://127.0.0.1:8807';
let server, browser, dataDir, observer, companion, quest;
let log = '', phase = 'startup';
const messages = [], browserErrors = [];
const until = async (label, probe, timeout = 30_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (server && (server.exitCode !== null || server.signalCode !== null)) throw Error(`Fixture server exited: ${log.slice(-2000)}`);
    const result = await probe(); if (result) return result;
    await delay(100);
  }
  throw Error(`Timed out: ${label}`);
};
async function freePort(port) {
  await new Promise((yes, no) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); no(Error(`Port ${port} occupied`)); });
    socket.once('error', error => error.code === 'ECONNREFUSED' ? yes() : no(error));
    socket.setTimeout(1500, () => { socket.destroy(); no(Error(`Port ${port} probe timeout`)); });
  });
}
async function json(path, body) {
  const response = await fetch(`${BASE}${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) } : { signal: AbortSignal.timeout(3000) });
  assert(response.ok, `${path}: ${response.status}`); return response.json();
}
async function identity() {
  const start = await json('/api/pair/start', { kind: 'mac', name: 'Visual-launch fixture Mac' });
  const status = start.deviceToken ? start : await json(`/api/pair/status?pairingId=${encodeURIComponent(start.pairingId)}&pollSecret=${encodeURIComponent(start.pollSecret)}`);
  assert.equal(status.status, 'approved');
  return { deviceId: status.deviceId, deviceToken: status.deviceToken, kind: 'mac', name: 'Visual-launch fixture Mac' };
}
const send = (type, payload, to = 'server') => observer.send(JSON.stringify({ v: 1, type, id: `test-${crypto.randomUUID()}`, ts: Date.now(), from: '', to, payload }));
const devices = () => messages.findLast(message => message.type === 'presence')?.payload.devices ?? [];
const visualPort = id => devices().find(device => device.deviceId === id)?.ports?.find(port => port.id === 'ce-visual-synth');
async function frames(count = 3) {
  for (let i = 0; i < count; i++) {
    const time = await quest.evaluate(() => window.__ce.lastFrame?.time ?? 0);
    await quest.waitForFunction(previous => window.__ce.lastFrame?.time > previous, time);
  }
}
async function pinch(name) {
  await quest.evaluate(name => {
    const app = window.__ce, node = app.hud.root.getObjectByName(name);
    if (!node) throw Error(`Missing HUD target ${name}`);
    app.emulator.lookAt(node.getWorldPosition(app.desktopCam.position.clone()));
  }, name);
  await frames(5);
  const point = await quest.evaluate(name => {
    const app = window.__ce, node = app.hud.root.getObjectByName(name);
    for (let parent = node; parent; parent = parent.parent) if (!parent.visible) throw Error(`Hidden ${name}`);
    const camera = app.renderer.xr.getCamera().cameras[0];
    const p = node.getWorldPosition(app.desktopCam.position.clone()).project(camera);
    if (Math.abs(p.x) > .96 || Math.abs(p.y) > .96) throw Error(`Target outside emulator view: ${name}`);
    const rect = app.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + (p.x + 1) * rect.width / 2, y: rect.top + (1 - p.y) * rect.height / 2 };
  }, name);
  await quest.mouse.move(point.x, point.y); await quest.mouse.down(); await frames(); await quest.mouse.up(); await frames(6);
}
async function trySynth() {
  if (!await quest.evaluate(() => window.__ce.hud.root.getObjectByName('main-menu')?.visible)) await pinch('menu-toggle');
  await pinch('visual-synth');
}
async function shot(name, page) { await page.screenshot({ path: join(OUT, `${name}.png`) }); }
// A controlled browser lifecycle fault: headless Chrome does not consistently
// mark background pages hidden, so exercise the real listener explicitly.
async function visibility(hidden) {
  await companion.evaluate(hidden => {
    window.__launchHidden = hidden;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__launchHidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__launchHidden ? 'hidden' : 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}
try {
  await mkdir(OUT, { recursive: true });
  for (const app of ['quest', 'companion']) await access(join(ROOT, `apps/${app}/dist/index.html`));
  await freePort(8807); await freePort(8457);
  dataDir = await mkdtemp(join(tmpdir(), 'ce-synth-launch-'));
  server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: join(ROOT, 'apps/server'), stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, HTTP_PORT: '8807', HTTPS_PORT: '8457', HTTP_HOST: '127.0.0.1', HTTPS_HOST: '127.0.0.1', PUBLIC_HOST: '127.0.0.1',
    CE_DATA_DIR: dataDir, MODEL_MODE: 'fixture', MODEL_API_KEY: '', CE_MAC_SILENT: '1', CE_MAC_LOCAL: '0', CE_REMO: '0', REMO_HOST: '', REMO_SEND: '0',
    CE_TRUST_FIRST_DEVICE: '1', CE_TRUST_LOOPBACK: '1', CE_CONSOLE_APPROVE: '0', MUSE_REPLAY: '1', MUSE_RECORD: '0', MUSE_RECORD_DIR: '', FIXTURE_DELAY_MS: '100', GEN3D_SKIN: '0', VITEST: '',
  } });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', data => { log = (log + data).slice(-200_000); });
  await until('server', () => log.includes('ControlAnything server '));
  assert.equal((await json('/api/health')).mode, 'fixture');
  const mac = await identity();
  observer = new WebSocket(`${BASE.replace('http', 'ws')}/ws`);
  observer.on('message', data => messages.push(JSON.parse(String(data))));
  await new Promise((yes, no) => { observer.once('open', yes); observer.once('error', no); });
  send('hello', { deviceToken: mac.deviceToken, app: 'visual-launch-observer', executor: false });
  await until('observer authenticated', () => messages.some(message => message.type === 'welcome'));
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'] });
  const macContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  macContext.setDefaultTimeout(30_000);
  await macContext.addInitScript(id => {
    localStorage.setItem('ce.device', JSON.stringify(id));
    window.__popupAttempts = 0; window.__audioAttempts = 0;
    window.open = () => { window.__popupAttempts++; return null; };
    for (const key of ['AudioContext', 'webkitAudioContext']) if (window[key]) window[key] = class { constructor() { window.__audioAttempts++; throw Error('Audio is forbidden in this fixture'); } };
  }, mac);
  companion = await macContext.newPage(); companion.on('pageerror', error => browserErrors.push(`companion: ${error.message}`));
  await companion.goto(`${BASE}/companion/`);
  await until('real companion advertises closed virtual port', () => visualPort(mac.deviceId)?.state === 'disconnected');
  assert.equal(await companion.locator('#visual-launcher').count(), 0);
  const questContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  questContext.setDefaultTimeout(30_000);
  quest = await questContext.newPage(); quest.on('pageerror', error => browserErrors.push(`quest: ${error.message}`));
  // A photo supplies camera pixels without creating a second simulated executor.
  await quest.goto(`${BASE}/quest/?emulate=1&camera=photo&mute=1&mic=0&hud=v2&yolo=0`);
  await quest.waitForFunction(() => window.__ce?.welcome && window.__ce.ws.open);
  await quest.evaluate(() => {
    window.__launchEvents = [];
    window.__ce.ws.tap('out', message => { if (['target.select', 'control.setup', 'arm.confirm', 'control.event'].includes(message.type)) window.__launchEvents.push(message); });
    window.__ce.ws.tap('in', message => { if (['target.select.result', 'ui.spec', 'arm.request'].includes(message.type)) window.__launchEvents.push(message); });
  });
  await quest.locator('#btn-enter').click(); await quest.waitForFunction(() => window.__ce.renderer.xr.isPresenting);
  await until('paired Mac visible to Quest', () => quest.evaluate(() => !!window.__ce.onboarding.online));
  await frames(8);
  phase = 'real-hud-auto-launch';
  await trySynth();
  await companion.locator('#visual-launcher canvas').waitFor({ state: 'visible' });
  await until('actual renderer presence', () => visualPort(mac.deviceId)?.state === 'connected');
  await quest.waitForFunction(() => window.__launchEvents.some(message => message.type === 'target.select.result' && message.payload.ok));
  const cardId = await quest.evaluate(() => window.__launchEvents.findLast(message => message.type === 'target.select.result' && message.payload.ok).payload.cardId);
  assert(messages.some(message => message.type === 'visual.open' && message.to === mac.deviceId));
  assert(messages.some(message => message.type === 'device.card' && message.payload.cardId === cardId && message.payload.notes === `virtual:visual-synth:${mac.deviceId}`));
  const pixels = await companion.evaluate(() => {
    const canvas = document.querySelector('#visual-launcher canvas'), gl = canvas.getContext('webgl2');
    const data = new Uint8Array(64 * 64 * 4);
    gl.readPixels(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, data);
    const rgb = [...data].filter((_, index) => index % 4 !== 3);
    return { min: Math.min(...rgb), max: Math.max(...rgb), error: gl.getError(), width: canvas.width, height: canvas.height };
  });
  assert.equal(pixels.error, 0); assert(pixels.max > 20 && pixels.max - pixels.min > 10, 'Actual WebGL canvas must contain visual pixels');
  assert.equal(await companion.evaluate(() => window.__popupAttempts), 0);
  await shot('01-auto-open-companion', companion); await shot('02-selected-quest', quest);
  const selected = () => quest.evaluate(id => window.__ce.modes.byCard(id)?.connection, cardId);
  assert.equal(await selected(), 'setup');
  assert.equal(await quest.evaluate(() => window.__launchEvents.some(message => ['control.setup', 'arm.confirm', 'control.event'].includes(message.type))), false);
  assert.equal(messages.filter(message => ['exec.command', 'arm.request', 'ui.spec'].includes(message.type)).length, 0);

  phase = 'hidden-recovery';
  await visibility(true);
  await until('hidden renderer withdrawn', () => visualPort(mac.deviceId)?.state === 'disconnected');
  await trySynth();
  await quest.waitForFunction(() => window.__ce.visualSynthIntent?.phase === 'unavailable');
  assert.match(await companion.locator('.visual-launcher-status').textContent(), /Paused/);
  assert.equal(await companion.locator('#visual-launcher').count(), 1);
  await visibility(false);
  await until('visible renderer restored', () => visualPort(mac.deviceId)?.state === 'connected');
  await quest.waitForFunction(id => window.__ce.lockedId === window.__ce.modes.byCard(id)?.targetId && window.__ce.visualSynthIntent?.phase !== 'unavailable', cardId);
  assert.equal(await selected(), 'setup');
  await shot('03-visible-recovery', companion);

  phase = 'close-reopen';
  await companion.getByRole('button', { name: 'Back to companion', exact: true }).click();
  await until('closed renderer withdrawn', () => visualPort(mac.deviceId)?.state === 'disconnected');
  await trySynth();
  await companion.locator('#visual-launcher canvas').waitFor({ state: 'visible' });
  await until('reopened renderer ready', () => visualPort(mac.deviceId)?.state === 'connected');
  await quest.waitForFunction(id => window.__ce.lockedId === window.__ce.modes.byCard(id)?.targetId, cardId);
  assert.equal(await companion.locator('#visual-launcher').count(), 1);
  await trySynth();
  assert.equal(await companion.locator('#visual-launcher').count(), 1, 'Reselecting cannot create another renderer');
  assert.equal((await quest.evaluate(() => [...window.__ce.modes.tags.values()].filter(tag => tag.cardId?.startsWith('visual-synth-')).length)), 1);
  assert.equal(await companion.evaluate(() => window.__audioAttempts + window.__popupAttempts), 0);
  assert.equal(messages.filter(message => ['exec.command', 'arm.request'].includes(message.type)).length, 0);
  assert.deepEqual(browserErrors, []);
  await shot('04-reopened-companion', companion);
  await writeFile(join(OUT, 'validation.json'), JSON.stringify({ fixture: true, physicalHeadset: false, visibilityFault: 'synthetic document visibility event', cardId,
    checks: ['actual-companion', 'actual-hud-pinch', 'closed-to-auto-open', 'real-webgl-pixels', 'renderer-heartbeat', 'same-owner-selection', 'hidden-withdrawal', 'visible-auto-recovery', 'close-reopen', 'single-renderer', 'no-popup', 'no-audio', 'no-auto-arming'], pixels }, null, 2));
  console.log('PASS actual Quest HUD selection automatically opens paired Mac visuals; real pixels/presence, visibility recovery, close/reopen, no popup/audio/arming');
} catch (error) {
  console.error(`FAIL ${phase}:`, error); process.exitCode = 1;
  if (companion) await shot('failure-companion', companion).catch(() => {});
  if (quest) await shot('failure-quest', quest).catch(() => {});
} finally {
  observer?.close(); await browser?.close();
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await Promise.race([new Promise(done => server.once('exit', done)), delay(3000)]); if (server.exitCode === null) server.kill('SIGKILL'); }
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true }); await writeFile(join(OUT, 'server.log'), log); await writeFile(join(OUT, 'browser-errors.json'), JSON.stringify(browserErrors, null, 2));
}
