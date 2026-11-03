/**
 * npm run build && npm run e2e:voice (system Chrome required; no browser download).
 * Own silent fixture server on 8799/8449; never reuses an existing server or hardware.
 * Chooses Menu → Try visual synth without camera identification, exercises Ask Muse's
 * real HUD wiring with a mocked microphone, then a typed combined
 * setup + gesture request through the real assistant/server fixture path. Camera verification,
 * explicit enabling and mapping acceptance precede exact local-memory reuse (without a model call)
 * and tracked-hand performance on the silent synth.
 * No real microphone, hardware, live server, or Meta API key is used.
 * Diagnostics: research/screens/voice/. Requires sockets; do not run in the coding sandbox.
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
import { checkMenuHands } from './lib/visual-synth-menu-check.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCREENS = join(ROOT, 'research/screens/voice');
const BASE = 'http://127.0.0.1:8799';
const UI_TIMEOUT = 30_000;
const PIPELINE_TIMEOUT = 180_000;
let server, browser, quest, sim, visuals, dataDir, cardId;
let serverReady = false;
let serverError;
let serverLog = '';
let currentPhase = '00-server';
const browserLog = [];
const completedPhases = [];
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
    await access(join(ROOT, `apps/${app}/dist/index.html`)).catch(() => {
      throw new Error(`${app} is not built. Run npm run build before npm run e2e:voice.`);
    });
  }
  await access(join(ROOT, 'apps/companion/dist/vsynth/index.html')).catch(() => {
    throw new Error('The visual synth is not built. Run npm run build before npm run e2e:voice.');
  });
  await portMustBeFree(8799);
  await portMustBeFree(8449);
  const freshDir = await mkdtemp(join(tmpdir(), 'ce-e2e-voice-'));
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
      HTTP_PORT: '8799', HTTPS_PORT: '8449',
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
  assert.equal(new URL(health.urls.https).port, '8449');
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
  completedPhases.push({ name, milliseconds: Date.now() - started });
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
    const world = object
      ? fraction === undefined ? object.getWorldPosition(app.desktopCam.position.clone())
        : object.localToWorld(app.desktopCam.position.clone().set((fraction - 0.5) * object.getObjectByName('button-plate').scale.x, 0, 0))
      : app.targets.get(targetId)?.position.clone();
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

async function openMenu() {
  if (await quest.evaluate(() => window.__ce.hud.root.getObjectByName('main-menu')?.visible)) return;
  await pinch({ nodeName: 'menu-toggle', turn: true });
  await waitQuest(() => window.__ce.hud.root.getObjectByName('main-menu')?.visible
    && window.__ce.hud.deck.userData.open);
}

async function menuAction(nodeName, options = {}) {
  await openMenu();
  const primary = ['visual-synth', 'ask-muse-general', 'menu-tools', 'deck:panic', 'exit-ar', 'menu-close'];
  const toolsOpen = await quest.evaluate(() => !!window.__ce.hud.root.getObjectByName('main-menu')?.userData.toolsOpen);
  if (!primary.includes(nodeName) && !toolsOpen) await pinch({ nodeName: 'menu-tools', turn: true });
  if (primary.includes(nodeName) && toolsOpen && !['deck:panic', 'exit-ar', 'menu-close'].includes(nodeName)) {
    await pinch({ nodeName: 'menu-tools-back', turn: true });
  }
  await pinch({ nodeName, turn: true, ...options });
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
      window.__voiceAudioAttempts = 0;
      // Fail before creating an audio graph, even if a future regression ignores mute=1.
      for (const name of ['AudioContext', 'webkitAudioContext']) if (window[name]) {
        window[name] = new Proxy(window[name], { construct() {
          window.__voiceAudioAttempts++;
          throw new Error('The voice E2E uses a mocked microphone and must not create an audio graph');
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
    const visualResponse = await visuals.goto(`${BASE}/vsynth/`, { waitUntil: 'domcontentloaded' });
    assert(visualResponse?.ok(), `Visual synth page: HTTP ${visualResponse?.status()}`);
    await visuals.locator('#visuals').waitFor({ state: 'visible' });
    assert.equal(await visuals.locator('body.unavailable').count(), 0, 'Standalone WebGL2 shader must compile');
    assert.equal(await visuals.locator('audio,video').count(), 0);

    const launcher = await context.newPage();
    watchPage(launcher, 'launcher');
    try {
      await launcher.goto(`${BASE}/quest/?emulate=0&yolo=0&mic=0`, { waitUntil: 'domcontentloaded' });
      await launcher.waitForFunction(() => !!window.__ce);
      await launcher.evaluate(() => document.fonts.ready);
      for (const viewport of [{ width: 1440, height: 1000 }, { width: 640, height: 900 }]) {
        await launcher.setViewportSize(viewport);
        assert.equal(await launcher.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
          `Launcher must fit ${viewport.width}px without horizontal scrolling`);
        await launcher.screenshot({ path: join(SCREENS, `01-launcher-${viewport.width}.png`), fullPage: true });
      }
      assert.equal(await launcher.evaluate(() => window.__voiceAudioAttempts), 0);
    } finally { await launcher.close(); }

    quest = await context.newPage();
    watchPage(quest, 'quest');
    await quest.goto(`${BASE}/quest/?emulate=1&camera=sim&mute=1&mic=0&hud=v2&yolo=0`, { waitUntil: 'domcontentloaded' });
    await waitQuest(() => window.__ce?.welcome && window.__ce.ws.open && window.__ce.room?.sim?.canvas);
    assert.equal(await quest.evaluate(() => window.__ce.welcome.mode), 'fixture');
    assert.equal(await quest.evaluate(() => window.__ce.hudKind), 'v2');
    await quest.evaluate(() => {
      window.__voiceEvents = []; window.__voiceRequests = []; window.__voiceControls = []; window.__buildViews = [];
      const wanted = new Set(['voice.text', 'tags.state', 'target.select.result', 'target.status', 'device.card', 'agent.step', 'driver.spec', 'driver.status', 'link.result', 'verify.result', 'ui.partial', 'ui.spec', 'arm.request', 'arm.result', 'panic']);
      window.__ce.ws.tap('in', ({ type, payload }) => {
        if (wanted.has(type)) window.__voiceEvents.push({ type, payload });
      });
      window.__ce.ws.tap('out', ({ type, payload }) => {
        if (type === 'control.event') window.__voiceControls.push(payload);
        window.__voiceRequests.push({ type, payload: type === 'scan.frame'
          ? { frameId: payload.frameId, purpose: payload.purpose } : payload });
      });
      window.__ce.ws.onAny(({ type, payload }) => {
        if (!wanted.has(type) || !payload.cardId) return;
        const view = window.__ce.setupProgress?.get(payload.cardId);
        if (view) window.__buildViews.push({ type, view });
        if (window.__buildViews.length > 200) window.__buildViews.shift();
      });
      const frame = [...document.querySelectorAll('iframe')].find((frame) => frame.contentWindow?.ceSim);
      frame.contentWindow.ceSimDebug.renderVisualAt(1000);
    });
    await quest.locator('#btn-enter').click();
    await waitQuest(() => window.__ce.renderer.xr.isPresenting && window.__ce.cameraState === 'on');
  });

  let targetId, tagGaze, utteranceId, proposalId, proposedUiCount;
  const combinedRequest = 'Connect this device and make raising my right hand control warp';
  await phase('02-aim-visual-screen', async () => {
    // This is the user's camera aiming step, using fixed scene geometry. No detector or
    // identity response is needed to choose the known virtual instrument from Menu.
    tagGaze = await quest.evaluate(() => {
      const app = window.__ce, room = app.room;
      const frame = [...document.querySelectorAll('iframe')].find(frame => frame.contentWindow?.ceSimDebug);
      const corners = frame.contentWindow.ceSimDebug.room.viewMeta.screens['laptop-screen'];
      const center = corners.reduce((sum, point) => [sum[0] + point[0] / 4, sum[1] + point[1] / 4], [0, 0]);
      const world = room.imageToWorld(...center);
      const width = room.imageToWorld(...corners[0]).distanceTo(room.imageToWorld(...corners[1]));
      const normal = world.clone().set(0, 0, 1).applyQuaternion(room.quaternion);
      app.emulator.setHead(world.clone().addScaledVector(normal, width * 1.4), room.quaternion);
      app.emulator.lookAt(world);
      return world.toArray();
    });
    await renderedFrames();
  });
  await phase('02b-menu-with-articulated-hands', async () => {
    try {
      const evidence = await checkMenuHands({ quest, waitQuest, renderedFrames,
        screenshot: name => quest.screenshot({ path: join(SCREENS, `${name}.png`) }) });
      await writeFile(join(SCREENS, 'menu-hands.json'), JSON.stringify(evidence, null, 2));
    } catch (error) {
      const evidence = await quest.evaluate(() => window.__menuHandEvidence).catch(() => undefined);
      await writeFile(join(SCREENS, 'menu-hands.json'), JSON.stringify(evidence ?? {}, null, 2));
      throw error;
    }
  });
  await phase('03-choose-virtual-instrument', async () => {
    assert.equal(await quest.evaluate(() => window.__ce.assistant.sendText('Connect this device')), false,
      'Ask Muse must reject a device request before a tag is selected in Control');
    await menuAction('visual-synth');
    await waitQuest(() => window.__voiceEvents.some(event => event.type === 'target.select.result' && event.payload.ok));
    const selected = await quest.evaluate(() => window.__voiceEvents.findLast(event => event.type === 'target.select.result').payload);
    cardId = selected.cardId;
    const request = await quest.evaluate(() => window.__voiceRequests.findLast(event => event.type === 'target.select').payload);
    assert.equal(request.virtual, 'visual-synth'); assert.equal(request.requestId, selected.requestId);
    await waitQuest(id => window.__ce.lockedId === window.__ce.modes.byCard(id)?.targetId, cardId);
    targetId = await quest.evaluate(id => window.__ce.modes.byCard(id).targetId, cardId);
    const selectedTarget = await target();
    assert.match(selectedTarget.card.notes, /^virtual:visual-synth:/);
    assert.equal(selectedTarget.detection, undefined, 'Known software selection must not invent a camera detection');
    assert.equal(await quest.evaluate(() => window.__voiceRequests.some((event) =>
      ['control.setup', 'control.event', 'arm.confirm'].includes(event.type))), false, 'Choosing the instrument must not start setup or control');
    assert.equal(await quest.evaluate(() => window.__voiceEvents.some((event) => event.type === 'agent.step')), false);
    assert.deepEqual((await screenSample()).state, initial.state, 'Choosing the instrument must leave it untouched');
  });
  await phase('04-control-mode', async () => {
    await waitQuest((id) => window.__ce.modes.mode === 'control' && !window.__ce.scanner.active
      && window.__ce.modes.byCard(id)?.connection === 'setup', cardId);
    await waitQuest(() => window.__ce.hud.root.getObjectByName('visual-synth-screen-guide')?.visible);
    assert.equal(await quest.evaluate(() => window.__voiceRequests.some((event) => event.type === 'control.setup')), false);
  });
  await phase('05-ask-muse-button', async () => {
    await waitQuest(id => window.__ce.lockedId === id, targetId);
    await waitQuest(() => !!window.__ce.hud.root.getObjectByName('assistant-talk'));
    await quest.evaluate(() => {
      const app = window.__ce;
      window.__voiceOriginalMic = { prepare: app.mic.prepare, start: app.mic.start, stop: app.mic.stop, ready: app.mic.ready, micParam: app.params.get('mic') };
      window.__voiceMicCalls = { prepare: 0, start: 0, stop: 0 };
      app.params.delete('mic'); app.mic.ready = true;
      app.mic.prepare = async () => { window.__voiceMicCalls.prepare++; };
      app.mic.start = () => { window.__voiceMicCalls.start++; };
      app.mic.stop = () => { window.__voiceMicCalls.stop++; };
    });
    try {
      await pinch({ nodeName: 'assistant-talk', turn: true });
      await waitQuest(() => window.__ce.ptt.listening && window.__ce.assistant.view?.state === 'listening');
      assert.equal(await quest.evaluate(() => window.__voiceMicCalls.prepare), 1);
      assert.equal(await quest.evaluate(() => window.__voiceMicCalls.start), 1);
      await screenshot('05a-microphone-listening');
      await pinch({ nodeName: 'assistant-send', turn: true });
      await waitQuest(() => window.__voiceMicCalls.stop === 1);
    } finally {
      await quest.evaluate(() => {
        const app = window.__ce, saved = window.__voiceOriginalMic;
        app.assistant.cancel();
        app.mic.prepare = saved.prepare; app.mic.start = saved.start; app.mic.stop = saved.stop; app.mic.ready = saved.ready;
        if (saved.micParam === null) app.params.delete('mic'); else app.params.set('mic', saved.micParam);
        delete window.__voiceOriginalMic;
      });
    }
    assert.equal(await quest.evaluate(() => window.__voiceRequests.some(event => event.type === 'voice.audio')), false,
      'The mocked microphone must never send audio or touch a real input');
  });
  await phase('05b-combined-voice-request', async () => {
    const text = combinedRequest;
    assert.equal(await quest.evaluate(text => window.__ce.assistant.sendText(text), text), true);
    await waitQuest(id => window.__voiceRequests.some(event => event.type === 'voice.text'
      && event.payload.cardId === id && event.payload.final && event.payload.utteranceId), cardId);
    utteranceId = await quest.evaluate(() => window.__voiceRequests.findLast(event => event.type === 'voice.text').payload.utteranceId);
    await waitQuest(({ id, utterance }) => window.__voiceEvents.some(event => event.type === 'voice.text'
      && event.payload.cardId === id && event.payload.utteranceId === utterance && event.payload.assistant?.state === 'setup'),
      { id: cardId, utterance: utteranceId });
    await waitQuest(id => window.__voiceRequests.some(event => event.type === 'control.setup' && event.payload.cardId === id), cardId);
    assert.equal(await quest.evaluate(id => window.__voiceRequests.filter(event => event.type === 'control.setup' && event.payload.cardId === id).length, cardId), 1,
      'The combined utterance must start exactly one explicit setup');
    await quest.evaluate(gaze => {
      const app = window.__ce;
      app.emulator.lookAt(app.desktopCam.position.clone().fromArray(gaze));
    }, tagGaze);
  });
  await phase('05c-muse-builds-controls', async () => {
    await waitQuest(id => {
      const view = window.__ce.setupProgress?.get(id);
      const panel = window.__ce.hud.root.getObjectByName('setup-progress');
      let visible = !!panel;
      for (let node = panel; node; node = node.parent) visible &&= node.visible;
      return visible && view?.working && view.artifact && view.stages.find(stage => stage.id === 'check')?.status === 'active';
    }, cardId, PIPELINE_TIMEOUT);
    const view = await quest.evaluate(id => window.__ce.setupProgress.get(id), cardId);
    assert.match(view.artifact.label, /driver/i);
    assert.match(view.source, /fixture|template/i, 'Recorded commands retain their provenance during verification');
    assert.doesNotThrow(() => JSON.parse(view.artifact.code), 'Preview contains actual structured command definitions');
    assert.notEqual(view.stages.find(stage => stage.id === 'enable').status, 'done');
    await writeFile(join(SCREENS, '05c-setup-progress.json'), JSON.stringify(view, null, 2));
  });
  await phase('06-camera-verifies', async () => {
    await until('visual synth verification and forge', async () => {
      const state = await target();
      return ['forged', 'arming'].includes(state.state) && state;
    }, PIPELINE_TIMEOUT);
    const state = await target();
    for (const action of ['cc71', 'cc21', 'pattern0', 'pattern1', 'pattern2']) {
      assert.equal(state.verification[action], 'pass', `${action} must pass actual camera verification`);
    }
    const results = await quest.evaluate((id) => window.__voiceEvents.filter((event) =>
      event.type === 'verify.result' && event.payload.cardId === id).map((event) => event.payload), cardId);
    assert(results.filter((result) => result.pass).length >= 5, 'Require a camera result for all five generated actions');
    assert(results.every((result) => result.expected?.sense === 'camera'
      && (!result.pass || result.observed?.sense === 'camera')), 'Visual instrument must use camera evidence only');
    assert.equal(state.driver.transport, 'midi');
    assert.match(state.driver.executor.port, /ce-visual-synth|ControlAnything Visual Synth/);
    await waitQuest(() => window.__ce.pendingArm && window.__ce.hud.confirm, undefined, PIPELINE_TIMEOUT);
    assert.equal(state.armed, false, 'Verified controls remain gated before Enable controls');
    const progress = await quest.evaluate(id => window.__ce.setupProgress.get(id), cardId);
    assert.equal(progress.stages.find(stage => stage.id === 'check').status, 'done');
    assert.equal(progress.stages.find(stage => stage.id === 'interface').status, 'done');
    assert.notEqual(progress.stages.find(stage => stage.id === 'enable').status, 'done');
    assert.match(progress.artifact.label, /interface/i);
    await writeFile(join(SCREENS, '06-setup-progress-events.json'), JSON.stringify(await quest.evaluate(() => window.__buildViews), null, 2));
  });
  await phase('07-enable-controls', async () => {
    await pinch({ nodeName: 'confirm-yes', turn: true });
    await waitQuest((id) => window.__voiceEvents.some((event) => event.type === 'arm.result'
      && event.payload.cardId === id && event.payload.armed), cardId);
    assert.equal((await target()).armed, true);
    assert.equal(await quest.evaluate(id => window.__ce.setupProgress.get(id).stages.find(stage => stage.id === 'enable').status, cardId), 'done');
    const controls = await quest.evaluate((id) => {
      const ui = window.__voiceEvents.findLast((event) => event.type === 'ui.spec' && event.payload.cardId === id).payload;
      return window.__ce.hud.specs.get(ui.gen3d.specId).spec.controls;
    }, cardId);
    assert.equal(controls.filter((control) => !['trigger', 'toggle'].includes(control.kind)).length, 2);
    assert.equal(controls.filter((control) => control.kind === 'trigger').length, 3);
    assert(controls.every((control) => control.armed !== false));
  });
  await phase('08-review-gesture-proposal', async () => {
    await waitQuest(({ id, utterance }) => window.__voiceEvents.some(event => event.type === 'voice.text'
      && event.payload.cardId === id && event.payload.utteranceId === utterance && event.payload.assistant?.state === 'proposal'),
      { id: cardId, utterance: utteranceId }, PIPELINE_TIMEOUT);
    await waitQuest(() => window.__ce.assistant.view?.state === 'proposal'
      && window.__ce.hud.root.getObjectByName('assistant-panel')?.visible
      && window.__ce.hud.root.getObjectByName('assistant-apply')?.visible);
    const proposal = await quest.evaluate(() => window.__voiceEvents.findLast(event => event.type === 'voice.text'
      && event.payload.assistant?.state === 'proposal').payload);
    proposalId = proposal.assistant.proposalId;
    assert(proposalId, 'A gesture edit must have a distinct proposal to confirm');
    assert(proposal.recipientId, 'The proposal must be scoped to the requesting headset');
    assert.match(proposal.assistant.mapping.join(' '), /hand height|right.*height|rais|right hand/i);
    assert.match(proposal.assistant.mapping.join(' '), /warp/i);
    assert.equal(await quest.evaluate(() => window.__voiceRequests.some(event => event.type === 'voice.confirm')), false,
      'Receiving a suggestion must not accept it');
    proposedUiCount = await quest.evaluate(() => window.__voiceEvents.filter(event => event.type === 'ui.spec').length);
    const sent = (await json('/api/agent/exec')).sent.length;
    await renderedFrames(4);
    assert.equal(await quest.evaluate(() => window.__voiceEvents.filter(event => event.type === 'ui.spec').length), proposedUiCount,
      'The proposal must not replace device controls before Apply mapping');
    assert.equal((await json('/api/agent/exec')).sent.length, sent, 'Reviewing the mapping must not drive the device');
    await quest.evaluate(() => {
      const app = window.__ce;
      app.emulator.lookAt(app.hud.root.getObjectByName('assistant-panel').getWorldPosition(app.desktopCam.position.clone()));
    });
  });
  await phase('08a-apply-verified-mapping', async () => {
    await pinch({ nodeName: 'assistant-apply', turn: true });
    await waitQuest(({ id, proposal }) => window.__voiceRequests.some(event => event.type === 'voice.confirm'
      && event.payload.cardId === id && event.payload.proposalId === proposal && event.payload.accept === true),
      { id: cardId, proposal: proposalId });
    await waitQuest(() => window.__ce.assistant.view?.state === 'applied');
    await waitQuest(count => window.__voiceEvents.filter(event => event.type === 'ui.spec').length > count, proposedUiCount);
    const state = await target();
    const map = await quest.evaluate(id => window.__voiceEvents.findLast(event => event.type === 'ui.spec'
      && event.payload.cardId === id)?.payload.gestureMap, cardId);
    assert(map, 'Applying the proposal must publish a gesture map');
    assert.equal(map.axes.find(axis => axis.axis === 'right_height')?.actionId, 'cc71');
    for (const binding of [...map.axes, ...map.postures]) assert.equal(state.verification[binding.actionId], 'pass',
      `Mapping action ${binding.actionId} must be physically verified`);
    assert.equal(await quest.evaluate(() => !!window.__ce.handMapping), false, 'Apply mapping must not start Perform automatically');
  });
  await phase('08b-reuse-saved-mapping', async () => {
    const voiceCalls = (calls) => calls.filter(call => ['voice.plan', 'voice.mapping', 'device_assistant_plan', 'device_assistant_mapping'].includes(call.label));
    const beforeCalls = voiceCalls((await json('/api/muse/calls')).calls);
    assert(beforeCalls.length >= 2, 'Initial setup/mapping must have used the real fixture planner path before memory reuse');
    const before = await quest.evaluate(id => ({
      ui: window.__voiceEvents.findLast(event => event.type === 'ui.spec' && event.payload.cardId === id).payload,
      uiCount: window.__voiceEvents.filter(event => event.type === 'ui.spec').length,
      setupCount: window.__voiceRequests.filter(event => event.type === 'control.setup').length,
    }), cardId);
    const sent = (await json('/api/agent/exec')).sent.length;
    assert.equal(await quest.evaluate(text => window.__ce.assistant.sendText(text), combinedRequest), true);
    const repeatUtteranceId = await quest.evaluate(() => window.__voiceRequests.findLast(event => event.type === 'voice.text').payload.utteranceId);
    assert.notEqual(repeatUtteranceId, utteranceId, 'A repeated request must have its own utterance identity');
    const taskContext = await quest.evaluate(() => window.__voiceRequests.findLast(event => event.type === 'voice.text').payload.workspace);
    assert.equal(taskContext?.scope, 'device', 'Muse receives the explicitly selected workspace');
    assert.equal(taskContext?.selected?.cardId, cardId);
    assert.equal(taskContext?.selected?.specId, before.ui.specId);
    assert.equal(taskContext?.selected?.specRevision, before.ui.rev ?? 1);
    assert.equal(taskContext?.performance, 'off');
    await writeFile(join(SCREENS, '08b-workspace-context.json'), JSON.stringify(taskContext, null, 2));
    await waitQuest(({ id, utterance }) => window.__voiceEvents.some(event => event.type === 'voice.text'
      && event.payload.cardId === id && event.payload.utteranceId === utterance && event.payload.assistant?.state === 'proposal'),
      { id: cardId, utterance: repeatUtteranceId });
    const repeated = await quest.evaluate(utterance => window.__voiceEvents.findLast(event => event.type === 'voice.text'
      && event.payload.utteranceId === utterance && event.payload.assistant?.state === 'proposal').payload, repeatUtteranceId);
    assert.match(repeated.assistant.text, /Reusing your saved mapping/);
    assert.notEqual(repeated.assistant.proposalId, proposalId, 'Reusing a map must create a fresh confirmation');
    assert.deepEqual(voiceCalls((await json('/api/muse/calls')).calls), beforeCalls,
      'Exact accepted memory reuse must skip new planning and mapping model calls');
    assert.equal(await quest.evaluate(id => window.__voiceRequests.some(event => event.type === 'voice.confirm'
      && event.payload.proposalId === id), repeated.assistant.proposalId), false, 'Reused memory still requires explicit Apply');
    const unchanged = await quest.evaluate(id => ({
      ui: window.__voiceEvents.findLast(event => event.type === 'ui.spec' && event.payload.cardId === id).payload,
      uiCount: window.__voiceEvents.filter(event => event.type === 'ui.spec').length,
      setupCount: window.__voiceRequests.filter(event => event.type === 'control.setup').length,
    }), cardId);
    assert.deepEqual(unchanged, before, 'A reused proposal must not restart setup or revise current controls before Apply');
    assert.equal((await json('/api/agent/exec')).sent.length, sent, 'Memory retrieval must not drive hardware');
    await waitQuest(() => window.__ce.assistant.view?.state === 'proposal'
      && window.__ce.hud.root.getObjectByName('assistant-apply')?.visible);
    await quest.evaluate(() => {
      const app = window.__ce;
      app.emulator.lookAt(app.hud.root.getObjectByName('assistant-panel').getWorldPosition(app.desktopCam.position.clone()));
    });
    await screenshot('08b-reuse-saved-mapping');
    const workspacePosition = await quest.evaluate(() => {
      const app = window.__ce;
      return app.hud.root.getObjectByName('assistant-panel').getWorldPosition(app.desktopCam.position.clone()).toArray();
    });
    await pinch({ nodeName: 'assistant-read', turn: true });
    await waitQuest(() => {
      const layout = window.__ce.hud.root.getObjectByName('object-info-detail')?.userData.layout;
      return layout?.renderer === 'uikit' && layout.ready;
    });
    const readingLayout = await quest.evaluate(() => window.__ce.hud.root.getObjectByName('object-info-detail').userData.layout);
    assert.equal(readingLayout.overflow, false, 'Full text fits the measured UIKit viewport');
    assert(Math.abs(readingLayout.width - .38) < .001 && Math.abs(readingLayout.height - .28) < .001);
    await screenshot('08b-uikit-full-request');
    const originalReading = await quest.evaluate(() => window.__ce.hud.root.getObjectByName('object-info-detail').text);
    for (const sample of [('W'.repeat(32)+'\n').repeat(6).trim(), '日本語の本 / Синтезатор / 👩‍🚀']) {
      await quest.evaluate(text => window.__ce.hud.root.getObjectByName('object-info-detail').setText(text), sample);
      await renderedFrames(6);
      await waitQuest(() => {
        const layout = window.__ce.hud.root.getObjectByName('object-info-detail').userData.layout;
        return layout.ready && !layout.overflow;
      });
    }
    assert.equal(await quest.evaluate(() => window.__ce.hud.root.getObjectByName('object-info-detail').userData.layout.font), 'system-fallback');
    await screenshot('08b-unicode-reader-fixture');
    await quest.evaluate(text => window.__ce.hud.root.getObjectByName('object-info-detail').setText(text), originalReading);
    await pinch({ nodeName: 'object-info-close', turn: true });
    assert.deepEqual(await quest.evaluate(() => {
      const app = window.__ce;
      return app.hud.root.getObjectByName('assistant-panel').getWorldPosition(app.desktopCam.position.clone()).toArray();
    }), workspacePosition, 'Opening and returning from full text does not reposition the workspace');
    await pinch({ nodeName: 'assistant-dismiss', turn: true });
    await waitQuest(id => window.__voiceRequests.some(event => event.type === 'voice.confirm'
      && event.payload.proposalId === id && event.payload.accept === false), repeated.assistant.proposalId);
    await waitQuest(utterance => window.__voiceEvents.some(event => event.type === 'voice.text'
      && event.payload.utteranceId === utterance && event.payload.assistant?.state === 'reply'
      && /dismissed/i.test(event.payload.assistant.text)), repeatUtteranceId);
    await renderedFrames(4);
    const after = await quest.evaluate(id => ({
      ui: window.__voiceEvents.findLast(event => event.type === 'ui.spec' && event.payload.cardId === id).payload,
      uiCount: window.__voiceEvents.filter(event => event.type === 'ui.spec').length,
      setupCount: window.__voiceRequests.filter(event => event.type === 'control.setup').length,
    }), cardId);
    assert.deepEqual(after, before, 'Dismissing the repeated proposal must preserve the accepted map and its revision');
    assert.deepEqual(voiceCalls((await json('/api/muse/calls')).calls), beforeCalls);
    assert.equal((await json('/api/agent/exec')).sent.length, sent);
    await writeFile(join(SCREENS, 'reuse-check.json'), JSON.stringify({
      originalUtteranceId: utteranceId, repeatUtteranceId,
      originalProposalId: proposalId, repeatProposalId: repeated.assistant.proposalId,
      assistantText: repeated.assistant.text, planningAndMappingCallsBefore: beforeCalls.length,
      planningAndMappingCallsAfter: beforeCalls.length, unchangedRevision: after.ui.rev,
      unchangedGestureMap: after.ui.gestureMap, dismissed: true,
    }, null, 2));
  }, false);
  await phase('08b2-unsupported-edit-retains-outcome', async () => {
    // The selected conversation owns the foreground until explicitly dismissed.
    await pinch({ nodeName: 'assistant-dismiss', turn: true });
    await waitQuest(() => !window.__ce.hud.root.getObjectByName('assistant-panel')?.visible);
    const before = await quest.evaluate(id => window.__voiceEvents.filter(event => event.type === 'ui.spec' && event.payload.cardId === id).length, cardId);
    assert.equal(await quest.evaluate(() => window.__ce.assistant.sendText('Create a fluid physics simulator with new code in the visual synth.')), true);
    await waitQuest(() => window.__ce.assistant.view?.state === 'reply' && /cannot|not support|not.*creat|existing.*effect|bounded/i.test(window.__ce.assistant.view.text));
    await pinch({ nodeName: 'assistant-dismiss', turn: true });
    await waitQuest(() => !window.__ce.hud.root.getObjectByName('assistant-panel')?.visible);
    await waitQuest(() => /Latest request not applied/.test(window.__ce.hud.root.getObjectByName('device-status')?.text ?? ''));
    const status = await quest.evaluate(() => window.__ce.hud.root.getObjectByName('device-status').text);
    assert.match(status, /Map r\d+.*Height to Warp/);
    assert.equal(await quest.evaluate(id => window.__voiceEvents.filter(event => event.type === 'ui.spec' && event.payload.cardId === id).length, cardId), before, 'Unsupported edit must not replace the working map');
    await quest.evaluate(() => { const a = window.__ce; a.emulator.lookAt(a.hud.root.getObjectByName('device-status').getWorldPosition(a.desktopCam.position.clone())); });
    await renderedFrames(3);
    await waitQuest(() => ['device-status', 'control-label'].every(name => {
      const node = window.__ce.hud.root.getObjectByName(name);
      return node?.textRenderInfo?.blockBounds && !node._needsSync && !node._isSyncing;
    }));
    const separation = await quest.evaluate(() => {
      const a = window.__ce, card = a.hud.root.getObjectByName('device-card');
      const edge = (name, index) => {
        const node = a.hud.root.getObjectByName(name), bounds = node.textRenderInfo.blockBounds;
        const point = a.desktopCam.position.clone().set(0, bounds[index], 0);
        return card.worldToLocal(node.localToWorld(point)).y;
      };
      return edge('device-status', 1) - edge('control-label', 3);
    });
    assert(separation >= .004, `Rendered mapping status must clear the first control label, gap=${separation}`);
  });
  await phase('08b3-change-height-warp-to-depth-ripples', async () => {
    const before = await quest.evaluate(id => window.__voiceEvents.findLast(e => e.type === 'ui.spec' && e.payload.cardId === id).payload, cardId);
    const request = 'Can you update the visual synth so I can push my hand backwards and forwards to create water ripples that react to my hand movement towards and back from it?';
    assert.equal(await quest.evaluate(text => window.__ce.assistant.sendText(text), request), true);
    await waitQuest(() => window.__ce.assistant.view?.state === 'proposal');
    const proposed = await quest.evaluate(() => window.__ce.assistant.view);
    assert.match(JSON.stringify(proposed), /ripple/i);
    assert.match(JSON.stringify(proposed), /forward|back|depth/i);
    assert.equal(await quest.evaluate(id => window.__voiceEvents.findLast(e => e.type === 'ui.spec' && e.payload.cardId === id).payload.rev, cardId), before.rev, 'Proposal cannot silently replace the old map');
    await pinch({ nodeName: 'assistant-apply', turn: true });
    await waitQuest(() => window.__ce.assistant.view?.state === 'applied');
    const applied = await quest.evaluate(id => window.__voiceEvents.findLast(e => e.type === 'ui.spec' && e.payload.cardId === id).payload, cardId);
    assert(applied.rev > before.rev, 'New request must publish a newer mapping');
    assert.equal(applied.gestureMap.axes.length, 1);
    assert.equal(applied.gestureMap.axes[0].axis, 'right_depth');
    assert.equal(applied.gestureMap.axes[0].actionId, 'cc21');
    assert.equal(applied.gestureMap.postures.length, 0);
    assert.equal(await quest.evaluate(() => !!window.__ce.handMapping), false);
    await writeFile(join(SCREENS, '08b3-ripple-mapping.json'), JSON.stringify({ request, before: before.gestureMap, after: applied.gestureMap, revision: applied.rev }, null, 2));
    await pinch({ nodeName: 'assistant-dismiss', turn: true });
    await waitQuest(() => !window.__ce.hud.root.getObjectByName('assistant-panel')?.visible);
    const status = await quest.evaluate(() => window.__ce.hud.root.getObjectByName('device-status')?.text);
    assert.match(status, /Forward|Depth|Push/i); assert.match(status, /ripple/i);
    await waitQuest(() => /Water ripples/i.test(window.__ce.hud.root.getObjectByName('control-label')?.text ?? ''));
    const visibleControl = await quest.evaluate(() => {
      const root = window.__ce.hud.root, label = root.getObjectByName('control-label');
      const button = root.getObjectByName('hand-control');
      return { name: label?.parent?.name, label: label?.text,
        button: button?.children.filter(child => typeof child.text === 'string').map(child => child.text).join(' ') };
    });
    assert.match(visibleControl.label, /Water ripples/i, 'The primary control must agree with the newly applied effect');
    assert.match(visibleControl.button, /Perform/, 'Readiness instruction must name the actual action button');
    assert.equal(await quest.evaluate(id => window.__ce.lockedId === id, targetId), true);
  });
  await phase('08c-perform-forward-back-ripples', async () => {
    await waitQuest(() => !!window.__ce.hud.root.getObjectByName('hand-control'));
    await pinch({ nodeName: 'hand-control', turn: true });
    await waitQuest(() => !!window.__ce.handMapping);
    await quest.evaluate(async () => {
      const app = window.__ce, remote = app.emulator.device.remote;
      app.input.mouseAsHand = false;
      app.input.pointer.inside = app.input.pointer.down = app.input.pointer.latched = false;
      await remote.dispatch('set_input_mode', { mode: 'hand' });
      const head = app.emulator.head();
      window.__voiceRightWrist = head.position.clone().add(head.position.clone().set(0.2, -0.25, -0.4).applyQuaternion(head.quaternion)).toArray();
      window.__voiceHandStart = {};
      const depthForward = head.position.clone().set(0, 0, -1).applyQuaternion(head.quaternion); depthForward.y = 0; depthForward.normalize();
      window.__voiceDepthForward = depthForward.toArray();
      for (const side of ['left', 'right']) {
        const device = `hand-${side}`;
        const position = head.position.clone().add(head.position.clone().set(side === 'left' ? -0.2 : 0.2, -0.25, -0.4).applyQuaternion(head.quaternion));
        window.__voiceHandStart[side] = position.toArray();
        const palm = head.position.clone().sub(position).normalize();
        const fingers = head.position.clone().set(0, 1, 0).applyQuaternion(head.quaternion);
        fingers.addScaledVector(palm, -fingers.dot(palm)).normalize();
        const xyz = vector => ({ x: vector.x, y: vector.y, z: vector.z });
        await remote.dispatch('set_connected', { device, connected: true });
        await remote.dispatch('set_select_value', { device, value: 0 });
        await remote.dispatch('set_hand_pose', { device, poseId: 'open' });
        await remote.dispatch('set_transform', { device, anchor: 'wrist', position: xyz(position), orientation: { fingers: xyz(fingers), palm: xyz(palm) } });
      }
    });
    try {
      // Establish both tracked wrists before closing the clutch. IWER starts at a
      // default height unrelated to this test's low screen-facing camera position;
      // engaging there would correctly retain that old relative pickup reference.
      await waitQuest(() => {
        const app = window.__ce;
        return app.handMapping && !app.handMapping.live
          && app.handMapping.session.engine.state.leftPosture === 'open_palm'
          && ['left', 'right'].every(side => {
            const wrist = app.lastFrame.hands[side]?.joints.wrist?.position;
            const expected = window.__voiceHandStart[side];
            return wrist && Math.hypot(wrist.x - expected[0], wrist.y - expected[1], wrist.z - expected[2]) < 0.02;
          });
      });
      await quest.evaluate(() => window.__ce.emulator.device.remote.dispatch('set_hand_pose', { device: 'hand-left', poseId: 'fist' }));
      await waitQuest(() => window.__ce.handMapping?.live && window.__ce.handMapping.session.engine.state.leftPosture === 'fist');
      const moveRightSmooth = async (from, to, stage, axis = 'depth') => quest.evaluate(async ({ from, to, stage, axis }) => {
        const app = window.__ce, remote = app.emulator.device.remote;
        const [x, y, z] = window.__voiceRightWrist;
        const [dx, , dz] = window.__voiceDepthForward;
        const at = value => axis === 'height' ? { x, y: y + value, z } : { x: x + dx * value, y, z: z + dz * value };
        const trace = window.__voiceGestureTrace ??= [];
        const deadline = performance.now() + 8000;
        let frameTime = app.lastFrame.time;
        const nextFrame = () => new Promise((resolve, reject) => {
          let pending;
          const timeout = setTimeout(() => {
            cancelAnimationFrame(pending); reject(new Error(`Timed out during continuous ${stage} motion`));
          }, Math.max(1, deadline - performance.now()));
          const observe = () => {
            if (app.lastFrame.time === frameTime) { pending = requestAnimationFrame(observe); return; }
            const previous = frameTime; frameTime = app.lastFrame.time;
            const engine = app.handMapping?.session.engine;
            trace.push({ stage, time: frameTime, frameGap: frameTime - previous,
              wrist: app.lastFrame.hands.right?.joints.wrist?.position.toArray(),
              live: app.handMapping?.live, engaged: engine?.state.engaged,
              leftPosture: engine?.state.leftPosture, rightPosture: engine?.state.rightPosture,
              axes: engine?.state.axes.map(axis => ({ ...axis })),
              pickup: engine?.axes.map(axis => ({ origin: axis.origin, pickup: axis.pickup, value: axis.lastValue })),
              outgoing: window.__voiceControls.length, menu: app.hud.root.getObjectByName('main-menu')?.visible });
            if (trace.length > 192) trace.shift();
            clearTimeout(timeout); resolve();
          };
          pending = requestAnimationFrame(observe);
        });
        // Hold the starting pose through several actual app frames. Pixel reads on the
        // simulator may have paused tracking; this gives relative pickup a stable origin.
        await remote.dispatch('set_transform', { device: 'hand-right', anchor: 'wrist', position: at(from) });
        for (let frame = 0; frame < 6; frame++) await nextFrame();
        // Roughly 2cm per observed frame models continuous hand travel, without a
        // CDP round-trip or an instantaneous 80cm teleport between tracking samples.
        const steps = Math.max(1, Math.ceil(Math.abs(to - from) / 0.02));
        for (let step = 1; step <= steps; step++) {
          await remote.dispatch('set_transform', { device: 'hand-right', anchor: 'wrist', position: at(from + (to - from) * step / steps) });
          await nextFrame();
        }
        for (let frame = 0; frame < 6; frame++) await nextFrame();
      }, { from, to, stage, axis });
      const moveRight = async offset => quest.evaluate(async offset => {
        const app = window.__ce, [x, y, z] = window.__voiceRightWrist;
        const [dx, , dz] = window.__voiceDepthForward;
        await app.emulator.device.remote.dispatch('set_transform', { device: 'hand-right', anchor: 'wrist', position: { x: x + dx * offset, y, z: z + dz * offset } });
      }, offset);
      const heightStart = await quest.evaluate(() => window.__voiceControls.length);
      await moveRightSmooth(0, .22, 'height-negative', 'height');
      await moveRightSmooth(.22, 0, 'height-return', 'height');
      const heightEvents = await quest.evaluate(n => window.__voiceControls.slice(n), heightStart);
      assert(heightEvents.every(e => e.widgetId !== 'gesture:right_height'), 'Old height mapping must not survive');
      assert(heightEvents.filter(e => e.widgetId === 'gesture:right_depth').length <= 1, 'Height-only movement must not create depth commands');
      await renderedFrames(8);
      const turnStart = await quest.evaluate(() => window.__voiceControls.length);
      await quest.evaluate(() => {
        const app = window.__ce, head = app.emulator.head(); window.__voiceOriginalHead = head;
        const turn = head.quaternion.clone().setFromAxisAngle(head.position.clone().set(0, 1, 0), .35);
        app.emulator.setHead(head.position, turn.multiply(head.quaternion));
      });
      await renderedFrames(8);
      await quest.evaluate(() => { const app = window.__ce, head = window.__voiceOriginalHead; app.emulator.setHead(head.position, head.quaternion); });
      await renderedFrames(8);
      const turnEvents = await quest.evaluate(n => window.__voiceControls.slice(n), turnStart);
      assert.equal(turnEvents.length, 0, 'Turning the head with stationary hands must not generate ripples');
      await moveRightSmooth(0, -.16, 'pull');
      await sim.waitForFunction(() => window.ceSimDebug.visualSynth.getState().pattern === 3);
      const before = await screenSample();
      const count = await quest.evaluate(() => window.__voiceControls.length);
      await moveRightSmooth(-.16, .18, 'push');
      const raised = Math.min(1, before.state.ripple + .2);
      await waitQuest(({ count, raised }) => window.__voiceControls.slice(count).some(event =>
        event.widgetId === 'gesture:right_depth' && Number(event.value) / 127 >= raised), { count, raised });
      await sim.waitForFunction(raised => window.ceSimDebug.visualSynth.getState().ripple >= raised, raised);
      const after = await screenSample();
      const water = await sim.evaluate(() => window.ceSimDebug.visualSynth.getWaterDiagnostics());
      assert(water.waves.length > 0 && water.waves.length <= 6, 'Real renderer must receive bounded ripple impulses');
      assert(water.waves.some(wave => wave.strength > 0), 'Forward travel must launch a positive water wave');
      assert.equal(after.state.pattern, 3, 'Depth must activate Water rather than old Rings or Warp');
      assert.equal(after.state.warp, before.state.warp, 'Ripple gesture must not alter Warp');
      const delta = pixelDifference(before.rgb, after.rgb);
      assert(delta > 2, `Forward/back travel must visibly change Water surface at fixed time: ${delta.toFixed(2)}/255`);
      assert(await sim.evaluate(() => window.ceSimDebug.device.logLines.some(line => /visual synth CC21=/.test(line.text))),
        'Depth control must reach the existing visual-synth executor');
      await visuals.waitForFunction(() => /Water ripples/i.test(document.querySelector('#last-change')?.textContent ?? ''));
      await visuals.screenshot({ path: join(SCREENS, '08c-mac-water-ripples.png') });
      await writeFile(join(SCREENS, 'gesture-pixels.json'), JSON.stringify({ before: before.state, after: after.state, meanAbsoluteRgbDelta: delta, input: 'right_depth', effect: 'Water ripples', heightOnlyEvents: heightEvents, headRotationEvents: turnEvents, water }, null, 2));
      await moveRightSmooth(.18, -.10, 'pull-back');
      await sim.waitForFunction(high => window.ceSimDebug.visualSynth.getState().ripple < high - .15, after.state.ripple);
      assert.equal(await quest.evaluate(id => window.__ce.lockedId === id && !window.__ce.hud.root.getObjectByName('main-menu').visible, targetId), true, 'Performance must retain selected synth and not navigate');
      await quest.evaluate(() => window.__ce.emulator.device.remote.dispatch('set_hand_pose', { device: 'hand-left', poseId: 'open' }));
      await waitQuest(() => window.__ce.handMapping && !window.__ce.handMapping.live);
      const released = await quest.evaluate(() => window.__voiceControls.length);
      await moveRight(-0.4);
      await renderedFrames(5);
      assert.equal(await quest.evaluate(() => window.__voiceControls.length), released,
        'Opening the left hand must stop outgoing gesture commands immediately');
      await quest.evaluate(() => window.__ce.emulator.device.remote.dispatch('set_hand_pose', { device: 'hand-left', poseId: 'fist' }));
      await waitQuest(() => window.__ce.handMapping?.live);
      await quest.evaluate(() => window.__ce.emulator.device.remote.dispatch('set_connected', { device: 'hand-right', connected: false }));
      await waitQuest(() => window.__ce.handMapping && !window.__ce.handMapping.live);
      const lost = await quest.evaluate(() => window.__voiceControls.length);
      // A disconnected hand has no XR samples; IWER correctly forbids moving it.
      // Keep the left clutch closed while observing subsequent real app frames.
      await renderedFrames(8);
      assert.equal(await quest.evaluate(() => window.__voiceControls.length), lost,
        'Tracking loss must stop commands even while the clutch remains closed');
    } finally {
      // Capture the live state before disconnecting the emulated hands, which otherwise
      // erases the posture/pickup evidence needed to explain a failed performance check.
      const motion = await quest.evaluate(() => {
        const app = window.__ce;
        return { initialWrists: window.__voiceHandStart, trace: window.__voiceGestureTrace ?? [], final: { live: app.handMapping?.live,
          gesture: app.handMapping?.session.engine.state, input: app.input.diagnostics,
          menu: app.hud.root.getObjectByName('main-menu')?.visible, lockedId: app.lockedId,
          controls: window.__voiceControls.slice(-24), requests: window.__voiceRequests.slice(-12) } };
      }).catch(error => ({ error: error.message }));
      await writeFile(join(SCREENS, 'gesture-motion.json'), JSON.stringify(motion, null, 2));
      await quest.evaluate(async () => {
        const app = window.__ce;
        for (const device of ['hand-left', 'hand-right']) {
          await app.emulator.device.remote.dispatch('set_select_value', { device, value: 0 });
          await app.emulator.device.remote.dispatch('set_connected', { device, connected: false });
        }
        await app.emulator.device.remote.dispatch('set_input_mode', { mode: 'controller' });
        app.input.mouseAsHand = true;
      });
    }
  });
  await phase('09-stop-resets', async () => {
    await pinch({ nodeName: 'hand-control', turn: true });
    await waitQuest(() => !window.__ce.handMapping);
    await menuAction('deck:panic');
    await waitQuest(() => window.__voiceEvents.some((event) => event.type === 'panic') && !window.__ce.pendingArm);
    await until('server disarms the visual synth', async () => !(await target()).armed);
    await sim.waitForFunction((state) => JSON.stringify(window.ceSimDebug.visualSynth.getState()) === JSON.stringify(state), initial.state);
    const reset = await screenSample();
    assert.deepEqual(reset.state, initial.state);
    const delta = pixelDifference(initial.rgb, reset.rgb);
    assert(delta < 0.5, `Stop must restore the default screen at fixed time: RGB delta ${delta.toFixed(2)}/255`);
    await visuals.waitForFunction(() => document.querySelector('#last-change')?.textContent.includes('Reset'));
    for (const page of [sim, quest, visuals]) for (const frame of page.frames()) {
      assert.equal(await frame.evaluate(() => window.__voiceAudioAttempts ?? 0), 0, 'No frame may construct an audio graph');
    }
    assert.equal(await sim.evaluate(() => !!window.ceSimDebug.synth.ctx), false);
  });
  await phase('10-companion-build-workspace', async () => {
    // Finish the rendering-heavy headset test before the display-only companion review.
    await quest.close(); await sim.close(); await visuals.close();
    const companion = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    watchPage(companion, 'companion-replay');
    const sockets = [];
    companion.on('websocket', socket => sockets.push(socket.url()));
    try {
      await companion.goto(`${BASE}/companion/?replay=1`, { waitUntil: 'domcontentloaded' });
      await companion.locator('#setup-workspace').waitFor({ state: 'visible' });
      assert.equal(await companion.locator('#onboarding').getByRole('heading', { name: 'Recorded setup demo' }).count(), 1);
      await companion.waitForFunction(() => /driver/i.test(document.querySelector('#setup-workspace-artifact-label')?.textContent)
        && document.querySelector('#setup-workspace-code')?.textContent.trim().startsWith('{'), undefined, { timeout: UI_TIMEOUT });
      const code = await companion.locator('#setup-workspace-code').textContent();
      assert.doesNotThrow(() => JSON.parse(code));
      assert.match(await companion.locator('#setup-workspace-source').textContent(), /recorded demo/i);
      assert.doesNotMatch(await companion.locator('#setup-workspace-facts').textContent(), /:\s*Live\b/);
      await companion.screenshot({ path: join(SCREENS, '10-companion-generated-driver.png'), fullPage: true });
      await companion.waitForFunction(() => /interface/i.test(document.querySelector('#setup-workspace-artifact-label')?.textContent), undefined, { timeout: UI_TIMEOUT });
      assert.match(await companion.locator('#setup-workspace-title').textContent(), /interface ready|waiting for enable/i);
      assert.equal(sockets.length, 0, 'Display-only replay cannot connect to a server or send commands');
      assert.equal(await companion.locator('#setup-workspace-stages li[data-status="done"]').count() < 6, true,
        'Generating an interface does not automatically enable control');
      await companion.screenshot({ path: join(SCREENS, '10b-companion-generated-interface.png'), fullPage: true });
      await companion.setViewportSize({ width: 640, height: 900 });
      assert.equal(await companion.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await companion.locator('#setup-workspace').scrollIntoViewIfNeeded();
      await companion.screenshot({ path: join(SCREENS, '10c-companion-build-640.png') });
    } finally { await companion.close(); }
  }, false);
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
      lockedId: window.__ce?.lockedId, pendingArm: window.__ce?.pendingArm, assistant: window.__ce?.assistant?.view,
      gesture: window.__ce?.handMapping?.session?.engine?.state,
      targets: window.__ce?.targets.list(), events: window.__voiceEvents, requests: window.__voiceRequests, controls: window.__voiceControls,
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
const deadline = setTimeout(() => abort.abort(new Error('Voice assistant path exceeded 8 minutes')), 8 * 60_000);
try {
  await Promise.race([run(), interrupted]);
  await writeFile(join(SCREENS, 'validation.json'), JSON.stringify({ status: 'passed', at: new Date().toISOString(),
    fixture: true, physicalHeadset: false, liveModel: false, realMicrophone: false,
    renderer: 'existing Visual Synth; actual WebGL with simulated camera/executor and IWER articulated hands',
    phases: completedPhases, evidence: ['menu-hands.json', '08b3-ripple-mapping.json', 'gesture-pixels.json', 'gesture-motion.json'],
    checks: ['natural-hand-menu-recall', 'far-ray-drag', 'near-poke', 'head-stable-menu', 'camera-verification-five-actions',
      'explicit-enable', 'old-height-map-replaced-only-after-apply', 'right-depth-water', 'actual-webgl-pixels',
      'height-and-headturn-negative-controls', 'clutch-release', 'tracking-loss', 'retained-synth-selection', 'stop-reset', 'no-audio'] }, null, 2));
  console.log(`PASS Ask Muse setup and gesture path; screenshots: ${SCREENS}`);
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
