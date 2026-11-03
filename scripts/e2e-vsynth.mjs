/**
 * npm run build && npm run e2e:vsynth (system Chrome required; no browser download).
 * Own silent fixture server on PORT (default 8798; HTTPS on PORT-350); never reuses an existing server or hardware.
 * The explicit (non-CE_DEMO) visual-synth path: pinch the laptop screen, Set up, verification, Enable controls,
 * an arc dial on the screen changes pixels inside the sim laptop screen, and the wrist palette's Stop resets it. Fixed shader time removes animation
 * as a confound in camera evidence and pixel assertions; the /vsynth/ tab runs live.
 * Diagnostics: research/screens/vsynth/. Requires sockets; do not run in the coding sandbox.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCREENS = join(ROOT, 'research/screens/vsynth');
const PORT = Number(process.env.PORT || 8798), HTTPS_PORT = PORT - 350;
const BASE = `http://127.0.0.1:${PORT}`;
const UI_TIMEOUT = 30_000;
const PIPELINE_TIMEOUT = 180_000;
let server, browser, quest, sim, visuals, dataDir, cardId;
let serverReady = false;
let serverError;
let serverLog = '';
let currentPhase = '00-server';
const browserLog = [];
const abort = new AbortController();

async function json(path) {
  const response = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(3000) });
  assert(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
}

async function until(description, probe, timeout = UI_TIMEOUT) {
  const deadline = Date.now() + timeout;
  do {
    abort.signal.throwIfAborted();
    if (serverError) throw serverError;
    if (server && (server.exitCode !== null || server.signalCode !== null)) {
      throw new Error(`Fixture server exited (${server.exitCode ?? server.signalCode})`);
    }
    const result = await probe();
    if (result) return result;
    await delay(200, undefined, { signal: abort.signal });
  } while (Date.now() < deadline);
  throw new Error(`Timed out after ${timeout / 1000}s: ${description}`);
}

async function portMustBeFree(port) {
  await new Promise((resolvePort, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error(`Port ${port} is occupied; stop its owner or run this check later.`));
    });
    socket.once('error', (error) => error.code === 'ECONNREFUSED' ? resolvePort() : reject(error));
    socket.setTimeout(1500, () => {
      socket.destroy();
      reject(new Error(`Could not check port ${port}`));
    });
  });
}

async function startServer() {
  for (const app of ['sim', 'quest', 'companion']) {
    const dist = process.env[`CE_${app.toUpperCase()}_DIST`]?.trim() || join(ROOT, `apps/${app}/dist`);
    await access(join(dist, 'index.html')).catch(() => {
      throw new Error(`${app} is not built (${dist}). Run npm run build before npm run e2e:vsynth.`);
    });
  }
  await portMustBeFree(PORT);
  await portMustBeFree(HTTPS_PORT);
  const freshDir = await mkdtemp(join(tmpdir(), 'ce-e2e-vsynth-'));
  if (abort.signal.aborted) {
    await rm(freshDir, { recursive: true, force: true });
    abort.signal.throwIfAborted();
  }
  dataDir = freshDir;
  server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: join(ROOT, 'apps/server'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HTTP_PORT: String(PORT), HTTPS_PORT: String(HTTPS_PORT), CE_DEMO: '',
      HTTP_HOST: '127.0.0.1', HTTPS_HOST: '127.0.0.1', PUBLIC_HOST: '127.0.0.1',
      CE_DATA_DIR: dataDir, MODEL_MODE: 'fixture', MODEL_API_KEY: '', CE_SCAN_PROMPTS: 'ControlAnything Visual Synth',
      CE_MAC_SILENT: '1', CE_MAC_LOCAL: '0',
      CE_REMO: '0', REMO_HOST: '', REMO_SEND: '0',
      CE_TRUST_FIRST_DEVICE: '1', CE_TRUST_LOOPBACK: '1', CE_CONSOLE_APPROVE: '0',
      MUSE_REPLAY: '1', MUSE_RECORD: '0', MUSE_RECORD_DIR: '',
      FIXTURE_DELAY_MS: '300', GEN3D_REPLAY_SPEED: '0', GEN3D_SKIN: '0', VITEST: '',
    },
  });
  server.on('error', (error) => { serverError = error; });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', (chunk) => {
    serverLog = (serverLog + chunk.toString()).slice(-250_000);
    // HTTP starts before HTTPS: wait until the entry point has finished starting both.
    serverReady ||= serverLog.includes('ControlAnything server ');
  });
  await until('own HTTP/HTTPS fixture server startup', () => serverReady);
  const health = await json('/api/health');
  assert.equal(health.mode, 'fixture');
  assert.equal(health.space.pairedDevices, 0, 'Server must start with an empty registry');
  assert.equal(new URL(health.urls.https).port, String(HTTPS_PORT));
}

function watchPage(page, name) {
  const log = (text) => {
    browserLog.push(`${name}: ${text}`);
    if (browserLog.length > 300) browserLog.shift();
  };
  page.on('pageerror', (error) => log(error.stack ?? error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') log(message.text());
  });
  page.on('requestfailed', (request) => log(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`));
}

async function waitQuest(predicate, arg, timeout = UI_TIMEOUT) {
  abort.signal.throwIfAborted();
  await quest.waitForFunction(predicate, arg, { timeout, polling: 100 });
  abort.signal.throwIfAborted();
}

async function renderedFrames(count = 2) {
  // Observe the app loop, including emulated XR frames, instead of sleeping for GPU timing.
  for (let i = 0; i < count; i++) {
    const time = await quest.evaluate(() => window.__ce.lastFrame?.time ?? 0);
    await waitQuest((previous) => window.__ce.lastFrame?.time > previous, time);
  }
}

async function screenshot(name) {
  await quest.bringToFront();
  await waitQuest(() => {
    let ready = true;
    window.__ce.hud.root.traverse((node) => {
      if (typeof node.sync !== 'function') return;
      // Troika does not invoke sync callbacks for text that is already clean.
      node.sync();
      if (node._needsSync || node._isSyncing || (node.text && !node.textRenderInfo)) ready = false;
    });
    const { card, controls } = window.__ce.hud;
    return ready && (!card.visible || card.scale.x > 0.99) && (!controls.visible || controls.scale.y > 0.99);
  });
  await renderedFrames();
  // IWER moves the renderer canvas out of #stage when XR starts.
  const canvas = await quest.evaluateHandle(() => window.__ce.renderer.domElement);
  try {
    await canvas.asElement().screenshot({ path: join(SCREENS, `${name}.png`), timeout: UI_TIMEOUT });
  } finally {
    await canvas.dispose();
  }
}

async function phase(name, action, capture = true) {
  abort.signal.throwIfAborted();
  currentPhase = name;
  const started = Date.now();
  await action();
  abort.signal.throwIfAborted();
  if (capture) await screenshot(name);
  console.log(`PASS ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

async function pinch({ targetId, nodeName, turn = false, fraction }) {
  await renderedFrames();
  if (targetId && !turn) await waitQuest((id) => {
    const app = window.__ce;
    return app.visibleTargets.has(id) && (app.modes.tags.has(id) || Date.now() - (app.observed.get(id)?.at ?? 0) < 200);
  }, targetId);
  const point = await quest.evaluate(({ targetId, nodeName, turn, fraction }) => {
    const app = window.__ce;
    const object = nodeName ? app.hud.root.getObjectByName(nodeName)
      : app.modes.tags.has(targetId) ? app.hud.root.getObjectByName(`target-label:${targetId}`) : null;
    if (nodeName && !object) throw new Error(`HUD node not found: ${nodeName}`);
    for (let node = turn ? null : object; node; node = node.parent) {
      if (!node.visible) throw new Error(`HUD node is hidden: ${nodeName}`);
    }
    let world = object ? object.getWorldPosition(app.desktopCam.position.clone()) : app.targets.get(targetId)?.position.clone();
    if (object && fraction !== undefined) {
      const plate = object.getObjectByName('button-plate');
      if (!plate) throw new Error(`HUD control plate not found: ${nodeName}`);
      const value = Math.max(0, Math.min(1, fraction));
      const local = app.desktopCam.position.clone().set(0, 0, 0);
      if (object.userData.archetype === 'knob') {
        // Match control-shape.ts: clockwise from lower-left to upper-center to lower-right.
        // Aim at the visible tick radius, outside the center acquisition dead zone.
        const angle = (value * 1.5 - 0.75) * Math.PI;
        const radius = plate.scale.x / 2 - 0.009;
        local.set(Math.sin(angle) * radius, Math.cos(angle) * radius, 0);
      } else if (object.userData.archetype === 'lever') {
        local.y = (value - 0.5) * 0.048;
      } else local.x = (value - 0.5) * plate.scale.x;
      world = object.localToWorld(local);
    }
    if (!world) throw new Error(`Target not found: ${targetId}`);
    if (turn) {
      app.emulator.lookAt(world);
      return null;
    }
    const camera = app.renderer.xr.isPresenting ? app.renderer.xr.getCamera().cameras[0] : app.desktopCam;
    const ndc = world.project(camera);
    const rect = app.renderer.domElement.getBoundingClientRect();
    if (Math.abs(ndc.x) > 0.98 || Math.abs(ndc.y) > 0.98 || Math.abs(ndc.z) > 1) {
      throw new Error(`Outside emulator view: ${nodeName ?? targetId} (${ndc.x}, ${ndc.y})`);
    }
    return { x: rect.left + (ndc.x + 1) * rect.width / 2, y: rect.top + (1 - ndc.y) * rect.height / 2 };
  }, { targetId, nodeName, turn, fraction });
  if (turn) {
    const time = await quest.evaluate(() => window.__ce.lastFrame.time);
    await waitQuest((time) => window.__ce.lastFrame.time >= time + 300, time);
    return pinch({ targetId, nodeName, fraction });
  }
  await quest.mouse.move(point.x, point.y);
  await quest.mouse.down();
  try {
    await renderedFrames();
  } finally {
    await quest.mouse.up();
  }
  await renderedFrames();
}

/** Drag along an arc dial (named dial-left / dial-right) from `from` to `to` of its sweep. */
async function dragArc(side, from, to) {
  const point = (frac) => quest.evaluate(({ side, frac }) => {
    const app = window.__ce; let dial;
    app.scene.traverse((o) => { if (o.name === `dial-${side}`) dial = o; });
    const sweep = Math.atan2(Math.sin(dial.to - dial.from), Math.cos(dial.to - dial.from));
    const a = dial.from + sweep * frac;
    const world = dial.localToWorld(app.desktopCam.position.clone().set(dial.center.x + dial.radius * Math.cos(a), dial.radius * Math.sin(a), 0.002));
    const p = world.project(app.renderer.xr.getCamera().cameras[0]);
    const r = app.renderer.domElement.getBoundingClientRect();
    return { x: r.left + (p.x + 1) * r.width / 2, y: r.top + (1 - p.y) * r.height / 2 };
  }, { side, frac });
  const start = await point(from);
  await quest.mouse.move(start.x, start.y); await renderedFrames(4); await quest.mouse.down(); await renderedFrames(4);
  for (let i = 1; i <= 15; i++) { const p = await point(from + (to - from) * i / 15); await quest.mouse.move(p.x, p.y); await renderedFrames(2); }
  await quest.mouse.up(); await renderedFrames(8);
}

async function target() {
  const result = await json(`/api/agent/targets/${encodeURIComponent(cardId)}`);
  assert.notEqual(result.state, 'failed', `Agent failed: ${JSON.stringify(result)}`);
  return result;
}


async function screenSample() {
  return sim.evaluate(() => {
    const { room, renderVisualAt } = window.ceSimDebug;
    renderVisualAt(1000);
    const [bl, br, tr, tl] = room.viewMeta.screens['laptop-screen'];
    const ctx = room.canvas.getContext('2d');
    const image = ctx.getImageData(0, 0, room.canvas.width, room.canvas.height);
    const rgb = [];
    // Sample the interior of the projected screen, avoiding its frame and corner label.
    for (let y = 0; y < 24; y++) for (let x = 0; x < 40; x++) {
      const u = 0.15 + x / 39 * 0.7, v = 0.15 + y / 23 * 0.7;
      const px = (tl[0] * (1 - u) + tr[0] * u) * (1 - v) + (bl[0] * (1 - u) + br[0] * u) * v;
      const py = (tl[1] * (1 - u) + tr[1] * u) * (1 - v) + (bl[1] * (1 - u) + br[1] * u) * v;
      const i = (Math.round(py) * image.width + Math.round(px)) * 4;
      rgb.push(image.data[i], image.data[i + 1], image.data[i + 2]);
    }
    return { state: window.ceSimDebug.visualSynth.getState(), rgb };
  });
}

function pixelDifference(before, after) {
  assert.equal(before.length, after.length);
  return before.reduce((sum, value, i) => sum + Math.abs(value - after[i]), 0) / before.length;
}

async function run() {
  await mkdir(SCREENS, { recursive: true });
  await phase('00-server', startServer, false);
  let initial;
  await phase('01-silent-instrument', async () => {
    browser = await chromium.launch({ channel: 'chrome', headless: true,
      args: ['--mute-audio'] });
    abort.signal.throwIfAborted();
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    context.setDefaultTimeout(UI_TIMEOUT);
    context.setDefaultNavigationTimeout(UI_TIMEOUT);
    await context.addInitScript(() => {
      window.__ceMute = true;
      window.__vsynthAudioAttempts = 0;
      // Fail before creating an audio graph, even if a future regression ignores mute=1.
      for (const name of ['AudioContext', 'webkitAudioContext']) if (window[name]) {
        window[name] = new Proxy(window[name], { construct() {
          window.__vsynthAudioAttempts++;
          throw new Error('The visual synth E2E must not create an audio graph');
        } });
      }
    });
    sim = await context.newPage();
    watchPage(sim, 'sim');
    await sim.goto(`${BASE}/sim/?mute=1`, { waitUntil: 'domcontentloaded' });
    await sim.waitForFunction(() => window.ceSim?.leader() && window.ceSimDebug?.device.conn?.open);
    const port = await sim.evaluate(() => window.ceSimDebug.device.conn.hello().ports
      .find((port) => port.id === 'ce-visual-synth'));
    assert.equal(port?.name, 'ControlAnything Visual Synth');
    assert.equal(port?.state, 'connected');
    initial = await screenSample();
    assert(initial.rgb.some((value) => value > 30), 'Laptop screen must contain rendered pixels');

    visuals = await context.newPage();
    watchPage(visuals, 'visuals');
    await visuals.goto(`${BASE}/vsynth/`, { waitUntil: 'domcontentloaded' });
    await visuals.locator('#visuals').waitFor({ state: 'visible' });
    assert.equal(await visuals.locator('body.unavailable').count(), 0, 'Standalone WebGL2 shader must compile');
    assert.equal(await visuals.locator('audio,video').count(), 0);

    quest = await context.newPage();
    watchPage(quest, 'quest');
    await quest.goto(`${BASE}/quest/?emulate=1&camera=sim&mute=1&mic=0&hud=v2&yolo=0`, { waitUntil: 'domcontentloaded' });
    await waitQuest(() => window.__ce?.welcome && window.__ce.ws.open && window.__ce.room?.sim?.canvas);
    assert.equal(await quest.evaluate(() => window.__ce.welcome.mode), 'fixture');
    assert.equal(await quest.evaluate(() => window.__ce.hudKind), 'v2');
    await quest.evaluate(() => {
      window.__vsynthEvents = []; window.__vsynthRequests = []; window.__vsynthControls = [];
      const wanted = new Set(['tags.state', 'target.status', 'device.card', 'agent.step', 'verify.result', 'ui.spec', 'arm.request', 'arm.result', 'panic']);
      window.__ce.ws.tap('in', ({ type, payload }) => {
        if (wanted.has(type)) window.__vsynthEvents.push({ type, payload });
      });
      window.__ce.ws.tap('out', ({ type, payload }) => {
        if (type === 'control.event') window.__vsynthControls.push(payload);
        window.__vsynthRequests.push({ type, payload: type === 'scan.frame'
          ? { frameId: payload.frameId, purpose: payload.purpose } : payload });
      });
      const frame = [...document.querySelectorAll('iframe')].find((frame) => frame.contentWindow?.ceSim);
      frame.contentWindow.ceSimDebug.renderVisualAt(1000);
    });
    await quest.locator('#btn-enter').click();
    await waitQuest(() => window.__ce.renderer.xr.isPresenting && window.__ce.cameraState === 'on');
  });

  let targetId, tagGaze;
  await phase('02-annotate-laptop', async () => {
    await waitQuest(() => {
      const app = window.__ce;
      return app.modes.mode === 'annotate' && app.scanner.active
        && app.targets.list().some((target) => /visual synth/i.test(target.label) && app.visibleTargets.has(target.id));
    });
    targetId = await quest.evaluate(() => window.__ce.targets.list().find((target) => /visual synth/i.test(target.label)).id);
    tagGaze = await quest.evaluate(() => {
      const head = window.__ce.lastFrame.head;
      return head.position.clone().addScaledVector(head.position.clone().set(0, 0, -1).applyQuaternion(head.quaternion), 3).toArray();
    });
  });
  await phase('03-pinch-screen', async () => {
    // A pinch on the laptop's screen selects the Mac's visual synth (no tag-then-switch-mode step any more).
    // Stand ~1 m from the screen, as a seated wearer would, then hover and pinch its box.
    tagGaze = await quest.evaluate((id) => {
      const app = window.__ce, target = app.targets.get(id).position.clone(), head = app.emulator.head();
      const dir = target.clone().sub(head.position).setY(0).normalize();
      const pos = target.clone().addScaledVector(dir, -0.95); pos.y = target.y + 0.4;
      app.emulator.setHead(pos, head.quaternion); app.emulator.lookAt(target);
      return target.toArray();
    }, targetId);
    await renderedFrames(20);
    const point = await quest.evaluate((c) => {
      const app = window.__ce, p = app.desktopCam.position.clone().fromArray(c).project(app.renderer.xr.getCamera().cameras[0]);
      const r = app.renderer.domElement.getBoundingClientRect();
      return { x: r.left + (p.x + 1) * r.width / 2, y: r.top + (1 - p.y) * r.height / 2 };
    }, tagGaze);
    await quest.mouse.move(point.x, point.y); await renderedFrames(3);
    await quest.mouse.down(); await renderedFrames(3); await quest.mouse.up(); await renderedFrames(6);
    await waitQuest(() => [...window.__ce.modes.tags.values()].some((t) => t.cardId?.startsWith('visual-synth')));
    cardId = await quest.evaluate(() => [...window.__ce.modes.tags.values()].find((t) => t.cardId?.startsWith('visual-synth')).cardId);
    assert.equal(await quest.evaluate(() => window.__vsynthRequests.some((event) =>
      ['control.setup', 'control.event', 'arm.confirm'].includes(event.type))), false, 'Selecting must not start setup or control without CE_DEMO');
    assert.deepEqual((await screenSample()).state, initial.state, 'Selecting must leave the instrument untouched');
  });
  await phase('04-selected', async () => {
    await waitQuest((id) => window.__ce.modes.mode === 'control' && window.__ce.modes.byCard(id)?.connection === 'setup', cardId);
  });
  await phase('05-set-up', async () => {
    await pinch({ nodeName: 'control-setup', turn: true });
    await waitQuest((id) => window.__vsynthRequests.some((event) => event.type === 'control.setup' && event.payload.cardId === id), cardId);
    // Keep the tag-time screen position in camera view while the camera checks it.
    await quest.evaluate((gaze) => {
      const app = window.__ce;
      app.emulator.lookAt(app.desktopCam.position.clone().fromArray(gaze));
    }, tagGaze);
  });
  let verifiedBy;
  await phase('06-verifies', async () => {
    await until('visual synth verification and forge', async () => {
      const state = await target();
      return ['forged', 'arming'].includes(state.state) && state;
    }, PIPELINE_TIMEOUT);
    const state = await target();
    const actions = Object.entries(state.verification);
    assert(actions.length >= 2 && actions.every(([, result]) => result === 'pass'), `Every generated action must pass: ${JSON.stringify(state.verification)}`);
    const results = await quest.evaluate((id) => window.__vsynthEvents.filter((event) =>
      event.type === 'verify.result' && event.payload.cardId === id).map((event) => event.payload), cardId);
    assert(results.filter((result) => result.pass).length >= actions.length, 'Each generated action reports a verification result');
    assert(results.every((result) => result.expected?.sense === 'camera'), 'The visual instrument asks the camera first');
    // Honest label: camera only when it saw the change; else the renderer's own report; else the executor's ack.
    verifiedBy = results.every((r) => r.observed?.sense === 'camera') ? 'camera'
      : results.some((r) => /verified by renderer/i.test(r.observed?.note ?? '')) ? 'renderer report' : 'acknowledgement';
    assert.equal(state.driver.transport, 'midi');
    assert.match(state.driver.executor.port, /ce-visual-synth|ControlAnything Visual Synth/);
    await waitQuest(() => window.__ce.pendingArm && window.__ce.hud.confirm, undefined, PIPELINE_TIMEOUT);
    assert.equal(state.armed, false, 'Verified controls remain gated before Enable controls');
    console.log(`  ${actions.length} actions verified by: ${verifiedBy}`);
  });
  await phase('07-enable-controls', async () => {
    await pinch({ nodeName: 'confirm-yes', turn: true });
    await waitQuest((id) => window.__vsynthEvents.some((event) => event.type === 'arm.result'
      && event.payload.cardId === id && event.payload.armed), cardId);
    assert.equal((await target()).armed, true);
    await waitQuest(() => { let n = 0; window.__ce.scene.traverse((o) => { if (/^dial-(left|right)$/.test(o.name)) { let v = true; for (let p = o; p; p = p.parent) if (!p.visible) v = false; if (v) n++; } }); return n === 2; });
  });
  await phase('08-dial-changes-screen-pixels', async () => {
    const before = await screenSample();
    const sent = await quest.evaluate(() => window.__vsynthControls.length);
    await dragArc('left', 0.05, 0.95);
    await waitQuest((sent) => window.__vsynthControls.slice(sent).some((event) => Number(event.value) > 100), sent);
    await sim.waitForFunction((state) => JSON.stringify(window.ceSimDebug.visualSynth.getState()) !== JSON.stringify(state), before.state);
    const after = await screenSample();
    const delta = pixelDifference(before.rgb, after.rgb);
    assert(delta > 2, `The dial must visibly change the laptop screen: mean RGB delta ${delta.toFixed(2)}/255`);
    assert(await sim.evaluate(() => window.ceSimDebug.device.logLines.some((line) => /visual synth CC\d+=/.test(line.text))),
      'The sim must receive the dial through its virtual MIDI executor');
    await writeFile(join(SCREENS, 'pixels.json'), JSON.stringify({ before: before.state, after: after.state, meanAbsoluteRgbDelta: delta, verifiedBy }, null, 2));
    await sim.locator('#room').screenshot({ path: join(SCREENS, '08-laptop-room.png') });
    console.log(`  laptop screen: mean RGB change ${delta.toFixed(2)}/255 from a real HUD dial drag`);
  });
  await phase('09-stop-resets', async () => {
    // Stop: the emulator's X key runs the same handler as the wrist palette's Stop.
    await quest.keyboard.press('x');
    await waitQuest(() => window.__vsynthEvents.some((event) => event.type === 'panic') || window.__vsynthRequests.some((event) => event.type === 'panic'));
    await until('server disarms the visual synth', async () => !(await target()).armed);
    await sim.waitForFunction((state) => JSON.stringify(window.ceSimDebug.visualSynth.getState()) === JSON.stringify(state), initial.state);
    const reset = await screenSample();
    assert.deepEqual(reset.state, initial.state);
    const delta = pixelDifference(initial.rgb, reset.rgb);
    assert(delta < 0.5, `Stop must restore the default screen at fixed time: RGB delta ${delta.toFixed(2)}/255`);
    await visuals.waitForFunction(() => document.querySelector('#last-change')?.textContent.includes('Reset'));
    for (const page of [sim, quest, visuals]) for (const frame of page.frames()) {
      assert.equal(await frame.evaluate(() => window.__vsynthAudioAttempts ?? 0), 0, 'No frame may construct an audio graph');
    }
    assert.equal(await sim.evaluate(() => !!window.ceSimDebug.synth.ctx), false);
  });
}

async function diagnostics() {
  await mkdir(SCREENS, { recursive: true });
  await writeFile(join(SCREENS, 'server.log'), serverLog);
  await writeFile(join(SCREENS, 'browser.log'), browserLog.join('\n'));
  const state = {};
  if (quest && !quest.isClosed()) {
    state.quest = await quest.evaluate(() => ({
      camera: window.__ce?.cameraState, hud: window.__ce?.hudKind,
      mode: window.__ce?.modes.mode, tags: window.__ce?.modes.tags && [...window.__ce.modes.tags.values()],
      lockedId: window.__ce?.lockedId, pendingArm: window.__ce?.pendingArm,
      targets: window.__ce?.targets.list(), events: window.__vsynthEvents, requests: window.__vsynthRequests, controls: window.__vsynthControls,
      specs: window.__ce?.hud.specs && [...window.__ce.hud.specs.values()].map((m) => ({
        specId: m.spec.specId, targetId: m.targetId, armed: m.armed,
        controls: m.spec.controls.map((c) => ({ id: c.id, action: c.binding?.action, armed: c.armed })),
      })),
      log: document.querySelector('#log')?.textContent,
    })).catch((e) => ({ error: e.message }));
    await quest.screenshot({ path: join(SCREENS, `${currentPhase}-FAIL.png`), timeout: 5000 }).catch(() => {});
  }
  if (sim && !sim.isClosed()) state.sim = await sim.evaluate(() => ({
    visual: window.ceSimDebug?.visualSynth.getState(), lamp: window.ceSim?.lamp(), logs: window.ceSimDebug?.device.logLines,
  })).catch((e) => ({ error: e.message }));
  await writeFile(join(SCREENS, 'failure.json'), JSON.stringify(state, null, 2));
}

async function cleanup() {
  if (server?.pid && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise((resolveExit) => server.once('exit', resolveExit));
    server.kill('SIGTERM');
    const force = setTimeout(() => server.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(force); }
  }
  try {
    await browser?.close();
  } finally {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  }
}

const interrupted = new Promise((_, reject) => abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true }));
const stop = (signal) => {
  process.exitCode = signal === 'SIGINT' ? 130 : 143;
  abort.abort(new Error(`Interrupted by ${signal}`));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
const deadline = setTimeout(() => abort.abort(new Error('Visual synth path exceeded 8 minutes')), 8 * 60_000);
try {
  await Promise.race([run(), interrupted]);
  console.log(`PASS silent visual synth path; screenshots: ${SCREENS}`);
} catch (error) {
  process.exitCode ||= 1;
  console.error(`FAIL ${currentPhase}: ${error.stack ?? error}`);
  await diagnostics().catch((e) => console.error(`Diagnostics: ${e.message}`));
} finally {
  clearTimeout(deadline);
  await cleanup();
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
}
