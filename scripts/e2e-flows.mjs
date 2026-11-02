/**
 * Usage: npm run build && npm run e2e:flows (requires system Chrome; no browser download).
 * Runs a muted fixture demo on its own ports 8797/8447. Screenshots and failure diagnostics
 * go to research/screens/v2-flows/. Never reuses an existing server; removes its temporary data.
 * Optional YOLO preview is disabled; detections still use the server's fixture scan path.
 * Scan prompts are limited to ceiling light + synthesizer to avoid generic duplicate boxes.
 * The sim advertises connected sim-midi and sim-ir ports even with audio muted. We only
 * assert synth setup eligibility, never run its audio pipeline. Companion coverage uses a
 * separate browser context, its real rendered QR, and silent Web MIDI metadata to exercise
 * hot-plug and second-tab presence. Recovery reuses the same fixture data across a restart.
 * Helpers are copied from e2e-judge.mjs so its passing path remains unchanged.
 * This script needs sockets and Chrome and cannot run in the coding sandbox.
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
const SCREENS = join(ROOT, 'research/screens/v2-flows');
const BASE = 'http://127.0.0.1:8797';
const UI_TIMEOUT = 30_000;
const PIPELINE_TIMEOUT = 180_000;
let server, browser, quest, sim, companion, companionContext, dataDir, cardId;
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
    await access(join(ROOT, `apps/${app}/dist/index.html`)).catch(() => {
      throw new Error(`${app} is not built. Run npm run build before npm run e2e:flows.`);
    });
  }
  await portMustBeFree(8797);
  await portMustBeFree(8447);
  const fresh = !dataDir;
  if (fresh) {
    dataDir = await mkdtemp(join(tmpdir(), 'ce-e2e-flows-'));
    abort.signal.throwIfAborted();
  }
  serverReady = false;
  serverError = undefined;
  const logOffset = serverLog.length;
  server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: join(ROOT, 'apps/server'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HTTP_PORT: '8797', HTTPS_PORT: '8447',
      HTTP_HOST: '127.0.0.1', HTTPS_HOST: '127.0.0.1', PUBLIC_HOST: '127.0.0.1',
      CE_DATA_DIR: dataDir, MODEL_MODE: 'fixture', MODEL_API_KEY: '', CE_SCAN_PROMPTS: 'ceiling light,synthesizer',
      CE_MAC_SILENT: '1', CE_MAC_LOCAL: '0',
      CE_REMO: '0', REMO_HOST: '', REMO_SEND: '0',
      CE_TRUST_FIRST_DEVICE: '1', CE_TRUST_LOOPBACK: '1', CE_CONSOLE_APPROVE: '0',
      MUSE_REPLAY: '1', MUSE_RECORD: '0', MUSE_RECORD_DIR: '',
      FIXTURE_DELAY_MS: '300', GEN3D_REPLAY_SPEED: '0', VITEST: '',
    },
  });
  server.on('error', (error) => { serverError = error; });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', (chunk) => {
    serverLog += chunk.toString();
    // HTTP starts before HTTPS: wait until the entry point has finished starting both.
    serverReady ||= serverLog.slice(logOffset).includes('ControlEverything server ');
  });
  await until('own HTTP/HTTPS fixture server startup', () => serverReady);
  const health = await json('/api/health');
  assert.equal(health.mode, 'fixture');
  if (fresh) assert.equal(health.space.pairedDevices, 0, 'Server must start with an empty registry');
  assert.equal(new URL(health.urls.https).port, '8447');
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

async function companionScreenshot(name) {
  await companion.bringToFront();
  await companion.screenshot({ path: join(SCREENS, `${name}.png`), fullPage: true });
  await quest.bringToFront();
}

async function openCompanion() {
  // The physical Mac and headset have separate storage, even though both visit this server.
  companionContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  companionContext.setDefaultTimeout(UI_TIMEOUT);
  companionContext.setDefaultNavigationTimeout(UI_TIMEOUT);
  await companionContext.addInitScript(() => {
    window.__ceMute = true;
    // Only metadata is simulated: an unexpected command fails rather than reaching hardware.
    const access = { inputs: new Map(), outputs: new Map(), onstatechange: null };
    const output = { id: 'flows-op1', name: 'OP-1 Field', manufacturer: 'Teenage Engineering', state: 'connected',
      send() { throw new Error('The pairing flow must never send MIDI'); } };
    const connect = (connected) => {
      sessionStorage.setItem('ce.flows.midi.connected', String(connected));
      if (connected) access.outputs.set(output.id, output);
      else access.outputs.clear();
      access.onstatechange?.({ port: output });
    };
    connect(sessionStorage.getItem('ce.flows.midi.connected') === 'true');
    window.__flowsMidi = { connect };
    Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: async () => {
      sessionStorage.setItem('ce.flows.midi.allowed', 'true');
      return access;
    } });
    const query = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (descriptor) => descriptor.name === 'midi'
      ? Promise.resolve({ state: sessionStorage.getItem('ce.flows.midi.allowed') === 'true' ? 'granted' : 'prompt' })
      : query(descriptor);
  });
  companion = await companionContext.newPage();
  watchPage(companion, 'companion');
  // requireApproval overrides trusted-loopback convenience, so the owner must still approve.
  await companion.goto(`${BASE}/companion/?pair=1`, { waitUntil: 'domcontentloaded' });
  await companion.locator('#self-qr svg').waitFor({ state: 'visible' });
}

async function scanCompanionQr() {
  // The emulator's camera sees the sim. Feed the Mac's rendered QR through the real image
  // decoder and owner approval path instead of issuing a direct pair.approve request.
  const png = await companion.locator('#self-qr').screenshot();
  const frameId = `flows-pair-${Date.now()}`;
  await quest.evaluate(async ({ png, frameId }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${png}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 480;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 640, 480);
    ctx.drawImage(image, 140, 60, 360, 360);
    const jpeg = canvas.toDataURL('image/jpeg', 0.95).split(',')[1];
    window.__ce.ws.send('scan.frame', { frameId, jpeg, width: 640, height: 480, capturedAt: Date.now(), purpose: 'pair' }, { to: 'server' });
  }, { png: png.toString('base64'), frameId });
  await waitQuest((id) => window.__flowsEvents.some((e) => e.type === 'scan.result'
    && e.payload.frameId === id && e.payload.qr?.some((q) => q.approved)), frameId);
}

async function assertSynthConnection(id, connection, action) {
  const started = Date.now();
  await action();
  await waitQuest(({ id, connection }) => window.__ce.modes.byCard(id)?.connection === connection, { id, connection });
  const elapsed = Date.now() - started;
  // Allow one extra second for a software-rendered browser, but report the actual latency.
  assert(elapsed < 2000, `Synth presence took ${elapsed} ms to reach ${connection}`);
  console.log(`  synth presence: ${connection} in ${elapsed} ms`);
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

async function pinch({ targetId, nodeName, turn = false }) {
  await renderedFrames();
  if (targetId && !turn) await waitQuest((id) => {
    const app = window.__ce;
    return app.visibleTargets.has(id) && (app.modes.tags.has(id) || Date.now() - (app.observed.get(id)?.at ?? 0) < 200);
  }, targetId);
  const point = await quest.evaluate(({ targetId, nodeName, turn }) => {
    const app = window.__ce;
    const object = nodeName ? app.hud.root.getObjectByName(nodeName) : null;
    if (nodeName && !object) throw new Error(`HUD node not found: ${nodeName}`);
    for (let node = object; node; node = node.parent) {
      if (!node.visible) throw new Error(`HUD node is hidden: ${nodeName}`);
    }
    const world = object
      ? object.getWorldPosition(app.desktopCam.position.clone())
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
  }, { targetId, nodeName, turn });
  if (turn) return pinch({ targetId, nodeName });
  await quest.mouse.move(point.x, point.y);
  await quest.mouse.down();
  try {
    await renderedFrames();
  } finally {
    await quest.mouse.up();
  }
  await renderedFrames();
}

async function target() {
  const result = await json(`/api/agent/targets/${encodeURIComponent(cardId)}`);
  assert.notEqual(result.state, 'failed', `Agent failed: ${JSON.stringify(result)}`);
  return result;
}

async function assertDockIcons(mode, canStop = false) {
  const state = await quest.evaluate(() => {
    const { hud } = window.__ce;
    const dock = hud.root.getObjectByName('hand-dock');
    if (!dock) throw new Error('Hand dock is missing');
    const icons = [];
    dock.traverse((node) => {
      if (!/^(mode-(annotate|control)|filter:(everything|lights|electronics)|deck:panic)$/.test(node.name)) return;
      for (let current = node; current; current = current.parent) if (!current.visible) return;
      icons.push(node.name);
    });
    return { icons: icons.sort(), anchor: dock.userData.anchor,
      oldBar: !!hud.root.getObjectByName('home-bar'), oldHint: !!hud.root.getObjectByName('home-hint'),
      close: !!hud.root.getObjectByName('deck-close') };
  });
  const expected = ['mode-annotate', 'mode-control'];
  if (mode === 'annotate') expected.push('filter:everything', 'filter:lights', 'filter:electronics');
  if (canStop) expected.push('deck:panic');
  assert.deepEqual(state.icons, expected.sort(), `${mode} dock must expose only its available actions`);
  assert.equal(state.anchor, 'fallback', 'Controller and mouse input must use the fallback dock');
  assert.equal(state.oldBar || state.oldHint || state.close, false, 'The old bar, permanent hint, and Close button must be removed');
}

async function findTarget(pattern) {
  await waitQuest((pattern) => {
    const app = window.__ce;
    return app.targets.list().some((t) => new RegExp(pattern, 'i').test(t.label) && app.visibleTargets.has(t.id)
      && Date.now() - (app.observed.get(t.id)?.at ?? 0) < 200);
  }, pattern);
  return quest.evaluate((pattern) => {
    const app = window.__ce;
    return app.targets.list().find((t) => new RegExp(pattern, 'i').test(t.label) && app.visibleTargets.has(t.id)).id;
  }, pattern);
}

async function elapsedFrames(ms) {
  const start = await quest.evaluate(() => window.__ce.lastFrame.time);
  await waitQuest(({ start, ms }) => window.__ce.lastFrame.time >= start + ms, { start, ms });
}

async function yaw(degrees) {
  await quest.evaluate((degrees) => {
    const app = window.__ce, head = app.emulator.head();
    const up = head.position.clone().set(0, 1, 0);
    app.emulator.setHead(head.position, head.quaternion.setFromAxisAngle(up, degrees * Math.PI / 180));
  }, degrees);
  await renderedFrames();
}

async function panelState() {
  return quest.evaluate(() => {
    const app = window.__ce, head = app.lastFrame.head;
    const camera = app.renderer.xr.getCamera().cameras[0];
    app.hud.root.updateMatrixWorld(true);
    const describe = (panel, width, height) => {
      const position = panel.getWorldPosition(head.position.clone());
      const rotation = panel.getWorldQuaternion(head.quaternion.clone());
      const center = position.clone().applyMatrix4(camera.matrixWorldInverse);
      const points = [-1, 1].flatMap((x) => [-1, 1].map((y) => {
        const world = head.position.clone().set(x * width / 2, y * height / 2, 0).applyMatrix4(panel.matrixWorld);
        const view = world.clone().applyMatrix4(camera.matrixWorldInverse);
        const ndc = world.project(camera);
        return { x: ndc.x, y: ndc.y, front: view.z < -0.01 };
      }));
      const bounds = { left: Math.min(...points.map((p) => p.x)), right: Math.max(...points.map((p) => p.x)),
        bottom: Math.min(...points.map((p) => p.y)), top: Math.max(...points.map((p) => p.y)) };
      return { position: position.toArray(), rotation: rotation.toArray(), distance: position.distanceTo(head.position),
        upright: head.position.clone().set(0, 1, 0).applyQuaternion(rotation).y, depth: -center.z, bounds,
        inView: points.every((p) => p.front && Math.abs(p.x) < 1 && Math.abs(p.y) < 1) };
    };
    const nodes = {};
    app.hud.root.traverse((node) => {
      for (let p = node; p; p = p.parent) if (!p.visible) return;
      nodes[node.uuid] = { name: node.name || node.type, position: node.getWorldPosition(head.position.clone()).toArray() };
    });
    const dock = app.hud.deck;
    const { width, height, anchor } = dock.userData;
    if (!(width > 0) || height !== 0.032) throw new Error(`Invalid dock dimensions: ${width} x ${height}`);
    return { card: describe(app.hud.card, 0.4, 0.32), dock: { ...describe(dock, width, height), anchor }, nodes };
  });
}

function assertLocked(before, after, description, allNodes = false) {
  for (const key of ['card', 'dock']) {
    assert(Math.hypot(...before[key].position.map((v, i) => v - after[key].position[i])) < 1e-5,
      `${description}: ${key} world position moved`);
    const dot = Math.abs(before[key].rotation.reduce((s, v, i) => s + v * after[key].rotation[i], 0));
    assert(1 - dot < 1e-6, `${description}: ${key} rotated with the head`);
  }
  if (allNodes) for (const [id, node] of Object.entries(before.nodes)) {
    assert(after.nodes[id], `${description}: visible HUD node disappeared: ${node.name}`);
    assert(Math.hypot(...node.position.map((v, i) => v - after.nodes[id].position[i])) < 1e-5,
      `${description}: HUD node follows the head: ${node.name}`);
  }
}

function assertSeparated(state, comfortable = false) {
  const { card, dock } = state;
  assert.equal(dock.anchor, 'fallback', 'Positioning checks must exercise the fallback dock');
  if (comfortable) for (const [name, panel] of Object.entries({ card, dock })) {
    assert(panel.inView, `${name} did not return fully into view`);
    assert(panel.distance >= 0.5 && panel.distance <= 1, `${name} distance ${panel.distance} m`);
    assert(panel.upright > 0.999, `${name} is not upright`);
  }
  // Projection becomes singular as a panel crosses behind the eye. Compare visible panels.
  if (!card.inView || !dock.inView) return;
  const a = card.bounds, b = dock.bounds;
  assert(a.right <= b.left || b.right <= a.left || a.top <= b.bottom || b.top <= a.bottom,
    `Card overlaps fallback dock in screen space: ${JSON.stringify({ a, b })}`);
  assert(Math.abs(card.depth - dock.depth) >= 0.01, `Panel depth gap is under 1 cm: ${card.depth} / ${dock.depth}`);
}

async function run() {
  await mkdir(SCREENS, { recursive: true });
  await phase('00-server', startServer, false);
  await phase('01-emulator-ready', async () => {
    const launched = await chromium.launch({
      channel: 'chrome', headless: true,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
    });
    if (abort.signal.aborted) {
      await launched.close();
      abort.signal.throwIfAborted();
    }
    browser = launched;
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    context.setDefaultTimeout(UI_TIMEOUT);
    context.setDefaultNavigationTimeout(UI_TIMEOUT);
    await context.addInitScript(() => { window.__ceMute = true; });
    sim = await context.newPage();
    watchPage(sim, 'sim');
    await sim.goto(`${BASE}/sim/?mute=1&autopress=1`, { waitUntil: 'domcontentloaded' });
    await sim.waitForFunction(() => window.ceSim?.leader()
      && window.ceSimDebug?.device.conn?.open
      && document.querySelector('#b-conn')?.textContent.includes('ONLINE'));
    assert.equal(await sim.evaluate(() => window.ceSim.lamp().power), 'off');

    quest = await context.newPage();
    watchPage(quest, 'quest');
    await quest.goto(`${BASE}/quest/?emulate=1&camera=sim&mute=1&mic=0&hud=v2&yolo=0`, { waitUntil: 'domcontentloaded' });
    await waitQuest(() => window.__ce?.welcome && window.__ce.ws.open && window.__ce.room?.sim?.canvas);
    assert.equal(await quest.evaluate(() => window.__ce.hudKind), 'v2', 'HUD v2 must load without fallback');
    assert.equal(await quest.evaluate(() => window.__ce.welcome.mode), 'fixture');
    await quest.evaluate(() => {
      window.__flowsEvents = [];
      window.__flowsControls = [];
      window.__flowsRequests = [];
      const types = new Set(['mode.state', 'tags.state', 'target.status', 'device.card', 'agent.step', 'verify.result', 'ui.spec', 'arm.request', 'arm.result', 'panic', 'presence', 'log', 'scan.result', 'pair.approved']);
      window.__ce.ws.tap('in', ({ type, payload }) => {
        if (!types.has(type)) return;
        window.__flowsEvents.push({ type, payload });
      });
      window.__ce.ws.tap('out', ({ type, payload }) => {
        if (type === 'control.event') window.__flowsControls.push(payload);
        // Keep stable indexes for phase barriers without retaining every camera JPEG.
        window.__flowsRequests.push({ type, payload: type === 'scan.frame'
          ? { frameId: payload.frameId, purpose: payload.purpose, capturedAt: payload.capturedAt } : payload });
      });
    });
    await quest.locator('#btn-enter').click();
    await waitQuest(() => window.__ce.renderer.xr.isPresenting && window.__ce.cameraState === 'on');
  });

  let targetId, synthId, synthCardId, tagGaze, staleControl;
  await phase('02-annotate', async () => {
    await waitQuest(() => window.__ce.modes.mode === 'annotate' && window.__ce.scanner.active
      && window.__ce.targets.list().some((t) => /ceiling (light|lamp)/i.test(t.label)));
    assert(await quest.evaluate(() => window.__flowsRequests.some((e) => e.type === 'mode.set' && e.payload.mode === 'annotate')),
      'Entering AR explicitly starts in Annotate');
    await assertDockIcons('annotate');
    targetId = await quest.evaluate(() => window.__ce.targets.list().find((t) => /ceiling (light|lamp)/i.test(t.label)).id);
    // Where the head looks while tagging: the FIXTURE verify outline is the tag frame's box, so verify must see the same view.
    tagGaze = await quest.evaluate(() => {
      const head = window.__ce.lastFrame.head;
      const p = head.position.clone();
      const dir = p.clone().set(0, 0, -1).applyQuaternion(head.quaternion);
      return p.addScaledVector(dir, 3).toArray();
    });
  });
  await phase('03-tag-light', async () => {
    await pinch({ targetId });
    await waitQuest((id) => window.__ce.modes.tags.has(id) && window.__ce.modes.tags.get(id).cardId, targetId);
    cardId = await quest.evaluate((id) => window.__ce.modes.tags.get(id).cardId, targetId);
    assert(await quest.evaluate((id) => window.__flowsRequests.some((e) => e.type === 'tag.add' && e.payload.targetId === id), targetId),
      'Pinching an annotation must tag the device');
  });
  await phase('04-tag-synth-and-untag', async () => {
    await waitQuest((id) => window.__flowsEvents.some((e) => e.type === 'tags.state'
      && e.payload.tags.some((tag) => tag.cardId === id && /light|lamp/i.test(tag.name ?? tag.label))), cardId);
    synthId = await findTarget('synth|keyboard|OP-1');
    await pinch({ targetId: synthId });
    await waitQuest((id) => !!window.__ce.modes.tags.get(id)?.cardId, synthId);
    synthCardId = await quest.evaluate((id) => window.__ce.modes.tags.get(id).cardId, synthId);
    await waitQuest((id) => window.__ce.modes.byCard(id)?.category === 'synthesizer', synthCardId);
    assert.equal(await quest.evaluate(() => window.__ce.modes.tags.size), 2);
    // A second pinch selects the tagged outline; only its chip can remove it.
    await pinch({ targetId: synthId });
    await waitQuest((id) => !!window.__ce.hud.root.getObjectByName(`tag-remove:${id}`), synthId);
    assert(await quest.evaluate((id) => {
      let found = false;
      window.__ce.hud.root.getObjectByName(`tag-remove:${id}`).traverse((n) => { found ||= n.text === 'Pinch to untag'; });
      return found;
    }, synthId), 'Tagged outline must offer an Untag chip');
    const since = await quest.evaluate(() => window.__flowsEvents.length);
    await pinch({ nodeName: `tag-remove:${synthId}` });
    await waitQuest(({ id, since }) => window.__flowsRequests.some((e) => e.type === 'tag.remove' && e.payload.cardId === id)
      && window.__flowsEvents.slice(since).some((e) => e.type === 'tags.state' && !e.payload.tags.some((t) => t.cardId === id))
      && !window.__ce.modes.byCard(id), { id: synthCardId, since });
    assert.equal(await quest.evaluate((id) => !!window.__ce.hud.root.getObjectByName(`tag-remove:${id}`), synthId), false);
    assert.equal(await quest.evaluate((id) => window.__ce.hud.targets.get(id)?.tagged === true, synthId), false,
      'Removing a tag must remove its persistent tagged outline');
    assert.equal(await quest.evaluate(() => window.__ce.hud.card.visible), false);
    await screenshot('04a-untagged');
    synthId = await findTarget('synth|keyboard|OP-1');
    await pinch({ targetId: synthId });
    await waitQuest((id) => !!window.__ce.modes.tags.get(id)?.cardId, synthId);
    synthCardId = await quest.evaluate((id) => window.__ce.modes.tags.get(id).cardId, synthId);
    await waitQuest((id) => window.__ce.modes.byCard(id)?.category === 'synthesizer', synthCardId);
    assert.equal(await quest.evaluate(() => window.__ce.modes.tags.size), 2);
    assert.equal(await quest.evaluate(() => window.__ce.modes.mode), 'annotate');
    assert.equal(await quest.evaluate(() => window.__flowsRequests.some((e) => ['target.select', 'control.setup', 'control.event', 'arm.confirm'].includes(e.type))), false,
      'Annotation must not request setup, arming, or physical control');
    assert.equal(await quest.evaluate(() => window.__flowsEvents.some((e) => ['agent.step', 'verify.result', 'ui.spec', 'arm.request'].includes(e.type))), false,
      'Tagging must not start the control pipeline');
    assert.equal(await sim.evaluate(() => window.ceSim.lamp().power), 'off');
  });
  await phase('05-control-mode', async () => {
    await pinch({ nodeName: 'mode-control', turn: true });
    await waitQuest(() => window.__ce.modes.mode === 'control' && !window.__ce.scanner.active);
    await waitQuest((id) => window.__ce.modes.byCard(id)?.connection === 'setup', cardId);
    await assertDockIcons('control');
    assert.equal(await quest.evaluate(() => window.__flowsRequests.some((e) => e.type === 'control.setup')), false,
      'Switching mode alone must not start setup');
  });
  await phase('06-offline-bridge', async () => {
    await assertSynthConnection(synthCardId, 'offline', () => sim.evaluate(() => window.ceSimDebug.device.conn.stop()));
    const hint = await quest.evaluate((id) => window.__ce.modes.byCard(id).hint, synthCardId);
    assert.equal(hint, 'Open ControlEverything on your Mac and plug in the synth');
    await pinch({ targetId: synthId, turn: true });
    await waitQuest((hint) => window.__ce.hud.card.visible && window.__ce.hud.status.text === hint, hint);
    assert.equal(await quest.evaluate(() => !!window.__ce.hud.root.getObjectByName('control-setup')), false,
      'Offline card must have no Set up control button');
    assert.equal(await quest.evaluate((id) => window.__ce.modes.canSetup(id), synthId), false);
    // Exercise the same action handler as the button, including its stale-UI guard.
    await quest.evaluate((id) => window.__ce.setupControl(id), synthId);
    assert.equal(await quest.evaluate(() => window.__flowsRequests.some((e) => e.type === 'control.setup')), false);
    assert.equal(await quest.evaluate(() => window.__flowsEvents.some((e) => e.type === 'agent.step')), false);
  });
  await phase('06a-connect-mac', async () => {
    await pinch({ nodeName: 'control-pair' });
    await waitQuest(() => window.__ce.pairingUntil > performance.now()
      && !!window.__ce.hud.root.getObjectByName('control-pair-cancel')
      && !!window.__ce.hud.root.getObjectByName('control-pair-code'));
    const remaining = await quest.evaluate(() => window.__ce.pairingUntil - performance.now());
    assert(remaining > 0 && remaining <= 30_000, 'QR scan must have a bounded countdown');
    await screenshot('06a-pairing-countdown');
    await pinch({ nodeName: 'control-pair-cancel' });
    await waitQuest(() => window.__ce.pairingUntil === 0 && !!window.__ce.hud.root.getObjectByName('control-pair'));
    await pinch({ nodeName: 'control-pair-code' });
    for (const key of 'K7Q4M2') await pinch({ nodeName: `pair-key:${key}` });
    await waitQuest(() => window.__ce.hud.root.getObjectByName('pair-code-value')?.text === 'K7Q-4M2'
      && !!window.__ce.hud.root.getObjectByName('pair-code-submit'));
    await screenshot('06a-pairing-type-code');
    await pinch({ nodeName: 'pair-code-close' });
    await waitQuest(() => !window.__ce.hud.modal.visible && window.__ce.hud.card.visible);
    await pinch({ nodeName: 'control-pair' });
    await openCompanion();
    assert.match(await companion.locator('#self-code').innerText(), /^[A-Z0-9]{3}-[A-Z0-9]{3}$/);
    const expires = await companion.locator('#self-expiry').innerText();
    assert(expires, 'The Mac must show when its pairing code expires');
    await companion.waitForFunction((previous) => document.querySelector('#self-expiry')?.textContent !== previous, expires);
    await companionScreenshot('06b-companion-pair-code');
    await scanCompanionQr();
    await companion.waitForFunction(() => document.querySelector('#headset-status')?.textContent.includes('Connected to Quest'));
    await waitQuest(() => window.__ce.pairingUntil === 0);
    await waitQuest((id) => window.__ce.modes.byCard(id)?.connection === 'offline'
      && window.__ce.modes.byCard(id)?.hint === 'Plug the synth into your Mac', synthCardId);
    assert.equal(await quest.evaluate(() => !!window.__ce.hud.root.getObjectByName('control-pair')), false,
      'A paired Mac without a synth must offer cable guidance, without another Connect Mac button');
    await companionScreenshot('06c-companion-connected-no-usb');
  });
  await phase('06d-companion-usb-hotplug', async () => {
    await companion.locator('#enable-midi').click();
    await assertSynthConnection(synthCardId, 'setup', () => companion.evaluate(() => window.__flowsMidi.connect(true)));
    await companion.waitForFunction(() => document.querySelector('#synth-status')?.textContent.includes('OP-1 Field on USB'));
    await waitQuest(() => !!window.__ce.hud.root.getObjectByName('control-setup'));
    assert.equal(await companion.locator('#onboarding-title').innerText(), 'Set it up from the headset');
    assert.equal(await quest.evaluate(() => window.__flowsRequests.some((e) => e.type === 'control.setup')), false,
      'Plugging in USB must not start setup');
    await companionScreenshot('06d-companion-usb-ready');
    const before = await quest.evaluate((id) => ({ lockedId: window.__ce.lockedId, targetId: window.__ce.modes.byCard(id).targetId }), synthCardId);
    await assertSynthConnection(synthCardId, 'offline', () => companion.evaluate(() => window.__flowsMidi.connect(false)));
    await waitQuest(() => !window.__ce.hud.root.getObjectByName('control-setup'));
    assert.equal(await quest.evaluate(() => window.__ce.lockedId), before.lockedId, 'USB removal must update the open card in place');
    await companionScreenshot('06e-companion-usb-removed');
    await assertSynthConnection(synthCardId, 'setup', () => companion.evaluate(() => window.__flowsMidi.connect(true)));
  });
  await phase('06f-companion-second-tab', async () => {
    const second = await companionContext.newPage();
    watchPage(second, 'companion-standby');
    try {
      await second.goto(`${BASE}/companion/`, { waitUntil: 'domcontentloaded' });
      await second.waitForFunction(() => document.querySelector('#exec-role')?.textContent === 'standby'
        && document.querySelector('#conn-dot')?.classList.contains('on'));
      await waitQuest(() => window.__flowsEvents.findLast((e) => e.type === 'presence')?.payload.devices
        .some((d) => d.kind === 'mac' && d.online && d.connections === 2 && d.ports?.some((p) => p.id === 'flows-op1')));
      assert.equal(await quest.evaluate((id) => window.__ce.modes.byCard(id)?.connection, synthCardId), 'setup',
        'An empty second tab must not hide the first tab MIDI output');
      await companionScreenshot('06f-companion-first-tab-still-ready');
    } finally { await second.close(); }
    await companion.evaluate(() => window.__flowsMidi.connect(false));
    await waitQuest((id) => window.__ce.modes.byCard(id)?.connection === 'offline', synthCardId);
  });
  await phase('07-synth-bridge-restored', async () => {
    await sim.evaluate(() => window.ceSimDebug.device.conn.start());
    await sim.waitForFunction(() => window.ceSimDebug.device.conn.open);
    await waitQuest((id) => window.__ce.modes.byCard(id)?.connection === 'setup', synthCardId);
    await waitQuest(() => !!window.__ce.hud.root.getObjectByName('control-setup'));
    assert.equal(await quest.evaluate(() => window.__ce.hud.status.text), 'Set up control for this device');
    const ports = await quest.evaluate(() => window.__flowsEvents.findLast((e) => e.type === 'presence')?.payload.devices
      .filter((d) => d.online && d.kind === 'sim').flatMap((d) => d.ports ?? []));
    assert(ports?.some((p) => p.id === 'sim-midi' && p.kind === 'midi-out' && p.state === 'connected'),
      'Synth Set up requires the connected sim MIDI port');
    assert.equal(await quest.evaluate(() => window.__flowsRequests.some((e) => e.type === 'control.setup')), false,
      'Connecting a bridge must never start learning without user intent');
  });
  await phase('07a-sim-midi-hotplug', async () => {
    await assertSynthConnection(synthCardId, 'offline', () => sim.evaluate(() => {
      const c = window.ceSimDebug.device.conn;
      const hello = c.hello();
      c.send('hello', { ...hello, ports: hello.ports.filter((p) => p.kind !== 'midi-out') });
    }));
    await waitQuest(() => !window.__ce.hud.root.getObjectByName('control-setup'));
    await assertSynthConnection(synthCardId, 'setup', () => sim.evaluate(() => window.ceSimDebug.device.conn.resendHello()));
    await waitQuest(() => !!window.__ce.hud.root.getObjectByName('control-setup'));
  });
  await phase('08-set-up-light', async () => {
    await pinch({ targetId, turn: true });
    await pinch({ nodeName: 'control-setup' });
    await waitQuest((id) => window.__flowsRequests.some((e) => e.type === 'control.setup' && e.payload.cardId === id), cardId);
    // A user keeps the light in view while it is tested; FIXTURE SAM re-finds it at the tag-time image position.
    await quest.evaluate((gaze) => { const app = window.__ce; app.emulator.lookAt(app.desktopCam.position.clone().fromArray(gaze)); }, tagGaze);
  });
  await phase('09-learn-remote', async () => {
    await until('all seven remote buttons captured', async () => {
      const t = await target();
      return t.research?.learned?.length === 7;
    }, PIPELINE_TIMEOUT);
    assert(await sim.evaluate(() => window.ceSimDebug.device.logLines.some((l) => l.kind === 'learn' && l.text.includes('captured press'))), 'Sim must capture the virtual remote');
  });
  await phase('10-verify', async () => {
    await until('physical verification completed', async () => {
      const t = await target();
      return ['verified', 'forging', 'forged', 'arming'].includes(t.state)
        && Object.values(t.verification).includes('pass') && t;
    }, PIPELINE_TIMEOUT);
    await waitQuest((id) => window.__flowsEvents.some((e) => e.type === 'verify.result'
      && e.payload.cardId === id && e.payload.pass && e.payload.observed?.sense === 'camera'), cardId);
  });
  await phase('11-controls-ready', async () => {
    await waitQuest((id) => {
      const app = window.__ce;
      return app.pendingArm && app.hud.confirm
        && [...app.hud.specs.values()].some((m) => m.targetId === id && m.spec.controls.length > 0);
    }, targetId, PIPELINE_TIMEOUT);
    assert.equal((await target()).armed, false, 'Server must gate controls until ARM');
  });
  await phase('12-arm', async () => {
    assert.equal(await quest.evaluate(() => !!window.__ce.hud.confirm.hold), false, 'Light should use one-tap confirmation');
    await pinch({ nodeName: 'confirm-yes' });
    await waitQuest((id) => window.__flowsEvents.some((e) => e.type === 'arm.result' && e.payload.cardId === id && e.payload.armed)
      && [...window.__ce.hud.specs.values()].some((m) => m.targetId === window.__ce.lockedId && m.armed), cardId);
    assert.equal((await target()).armed, true);
  });
  await phase('13-control-changes-light', async () => {
    await sim.waitForFunction(() => window.ceSim.lamp().power === 'on' && window.ceSimDebug.device.animator.settled);
    const before = await sim.evaluate(() => window.ceSim.lamp());
    const control = await quest.evaluate((cardId) => {
      const app = window.__ce;
      const ui = window.__flowsEvents.findLast((e) => e.type === 'ui.spec' && e.payload.cardId === cardId)?.payload;
      const mounted = app.hud.specs.get(ui?.gen3d?.specId);
      if (!mounted?.armed || mounted.targetId !== app.lockedId) return null;
      const hack = ui.hackset?.hacks.find((h) => h.kind === 'action' && h.commands.some((c) => c.action === 'off'));
      const off = mounted.spec.controls.find((c) => c.armed !== false && (c.kind === 'trigger' || c.kind === 'toggle')
        && (hack ? c.id === hack.id || c.binding?.args?.hack === hack.id : c.binding?.action === 'off'));
      if (!off) return null;
      const node = app.hud.root.getObjectByName(`control:${off.id}`)
        ?? app.hud.root.getObjectByName(`action:${hack?.id ?? off.id}`);
      if (!node) return null;
      for (let current = node; current; current = current.parent) if (!current.visible) return null;
      const id = node.name.startsWith('action:') ? hack?.id ?? off.id : off.id;
      return { id, nodeName: node.name, specId: ui.specId, sent: window.__flowsControls.length };
    }, cardId);
    assert(control, 'Armed device HUD must expose its off action by hack id or command role');
    // Looking at the controls after verification is complete leaves its camera evidence undisturbed.
    await pinch({ nodeName: control.nodeName, turn: true });
    await waitQuest(({ id, specId, sent }) => window.__flowsControls.slice(sent)
      .some((event) => event.specId === specId && event.widgetId === id && event.value === true), control);
    await sim.waitForFunction(() => window.ceSim.lamp().power === 'off' && window.ceSimDebug.device.animator.settled);
    staleControl = await quest.evaluate(() => window.__flowsControls.findLast((e) => e.phase === 'end'));
    assert(staleControl, 'Save a real accepted control.event for the Stop regression');
    const after = await sim.evaluate(() => window.ceSim.lamp());
    assert.notDeepEqual(after, before);
    assert.equal(await sim.evaluate(() => window.ceSimDebug.device.lastIr?.source), 'exec', 'Lamp must change through the server executor');
    console.log(`  lamp: ${before.power} -> ${after.power} (HUD ${control.id})`);
  });

  await phase('14-armed-mode-round-trip', async () => {
    const setupCount = await quest.evaluate(() => window.__flowsRequests.filter((e) => e.type === 'control.setup').length);
    await pinch({ nodeName: 'mode-annotate', turn: true });
    await waitQuest(() => window.__ce.modes.mode === 'annotate' && window.__ce.scanner.active
      && !window.__ce.hud.card.visible && !window.__ce.hud.modal.visible && !window.__ce.lockedId);
    await assertDockIcons('annotate');
    assert.equal((await target()).armed, true, 'Leaving Control must preserve server arming');
    assert(await quest.evaluate((id) => window.__ce.armedCards.has(id), cardId));
    // Look back into the room and observe a NEW scan request, not only the scanner flag.
    const scans = await quest.evaluate(() => ({ sent: window.__flowsRequests.filter((e) => e.type === 'scan.frame').length,
      results: window.__ce.scanner.stats.results }));
    await yaw(0);
    await waitQuest((before) => window.__flowsRequests.filter((e) => e.type === 'scan.frame').length > before.sent
      && window.__ce.scanner.stats.results > before.results, scans);
    assert.equal(await quest.evaluate(() => window.__ce.hud.card.visible), false);
    await screenshot('14a-annotate-card-closed');
    await pinch({ nodeName: 'mode-control', turn: true });
    await waitQuest((id) => window.__ce.modes.mode === 'control' && !window.__ce.scanner.active
      && window.__ce.modes.byCard(id)?.connection === 'ready', cardId);
    await assertDockIcons('control', true);
    assert(await quest.evaluate(() => [...window.__ce.visibleTargets].every((id) => window.__ce.modes.tags.has(id))),
      'Control must hide all untagged outlines');
    await pinch({ targetId, turn: true });
    await waitQuest((id) => window.__ce.lockedId === id && window.__ce.hud.card.visible
      && [...window.__ce.hud.specs.values()].some((m) => m.targetId === id && m.armed), targetId);
    assert.equal(await quest.evaluate(() => !!window.__ce.hud.root.getObjectByName('control-setup')), false);
    assert.equal(await quest.evaluate(() => window.__flowsRequests.filter((e) => e.type === 'control.setup').length), setupCount,
      'Ready opens the existing controls directly, without another setup');
  });

  await phase('15-world-locked-positioning', async () => {
    // Input cursors deliberately track input rays; hide them to sample every visible HUD node.
    await quest.evaluate(() => {
      const app = window.__ce;
      app.input.mouseAsHand = false;
      for (const hand of Object.values(app.emulator.device.hands)) hand.connected = false;
    });
    try {
      // Establish a common forward anchor through normal lazy follow, not by moving HUD nodes.
      await yaw(100); await elapsedFrames(2200);
      await yaw(0); await elapsedFrames(2200);
      const initial = await panelState();
      assertSeparated(initial, true);
      assert(initial.dock.bounds.left + initial.dock.bounds.right < 0
        && initial.dock.bounds.bottom + initial.dock.bounds.top < 0, 'Fallback dock must sit in the lower-left view');
      for (let frame = 0; frame < 30; frame++) {
        await yaw(2 * Math.sin(frame / 29 * Math.PI));
        const state = await panelState();
        assertLocked(initial, state, `small motion frame ${frame}`, true);
        assertSeparated(state);
      }
      await yaw(20);
      await elapsedFrames(2200); // Longer than the 1.5 s lazy-follow delay: still no movement.
      const smallTurn = await panelState();
      assertLocked(initial, smallTurn, '20 degree turn');
      assertSeparated(smallTurn);
      await screenshot('15a-world-locked-20-degrees');
      await yaw(100);
      const start = await quest.evaluate(() => window.__ce.lastFrame.time);
      let last;
      do {
        last = await panelState();
        const now = await quest.evaluate(() => window.__ce.lastFrame.time);
        if (now - start < 1000) assertLocked(smallTurn, last, 'lazy-follow delay');
        assertSeparated(last);
        if (now - start >= 2300) break;
        await renderedFrames();
      } while (true);
      assertSeparated(last, true);
      for (const key of ['card', 'dock']) assert(Math.hypot(...initial[key].position.map((v, i) => v - last[key].position[i])) > 0.2,
        `${key} must recenter after a sustained 100 degree turn`);
      await writeFile(join(SCREENS, 'positioning.json'), JSON.stringify({ initial, smallTurn, followed: last }, null, 2));
    } finally {
      await quest.evaluate(() => { window.__ce.input.mouseAsHand = true; });
    }
  });

  await phase('16-stop-disarms-and-blocks-ir', async () => {
    assert.equal((await target()).armed, true);
    await pinch({ nodeName: 'deck:panic', turn: true });
    await waitQuest(() => window.__flowsEvents.some((e) => e.type === 'panic')
      && !window.__ce.hud.card.visible && !window.__ce.hud.modal.visible && !window.__ce.lockedId
      && window.__ce.armedCards.size === 0);
    await until('server reports light disarmed', async () => {
      const t = await json(`/api/agent/targets/${encodeURIComponent(cardId)}`);
      return !t.armed && ['forged', 'verified', 'failed'].includes(t.state);
    });
    await waitQuest((id) => window.__ce.modes.byCard(id)?.connection === 'setup', cardId);
    await assertDockIcons('control');
    await sim.waitForFunction(() => window.ceSimDebug.device.logLines.some((l) => l.text.includes('panic from the server'))
      && window.ceSimDebug.device.animator.settled);
    const before = await sim.evaluate(() => ({ lamp: window.ceSim.lamp(), lastIr: window.ceSimDebug.device.lastIr,
      ir: window.ceSimDebug.device.logLines.filter((l) => l.kind === 'ir') }));
    const logOffset = serverLog.length;
    await quest.evaluate((event) => {
      const app = window.__ce;
      // A stale client bypasses the now-closed HUD; server authorization must still reject it.
      app.ws.send('control.event', { ...event, ts: Date.now(), phase: 'end' }, { to: 'server' });
    }, staleControl);
    // The rejection log is the processing barrier; repeating mode.set does not emit mode.state.
    await until('stale event rejected by the server', () => /not armed|control is not authorized/.test(serverLog.slice(logOffset)));
    await elapsedFrames(800); // Covers the sim IR queue's 120 ms gap as well.
    const after = await sim.evaluate(() => ({ lamp: window.ceSim.lamp(), lastIr: window.ceSimDebug.device.lastIr,
      ir: window.ceSimDebug.device.logLines.filter((l) => l.kind === 'ir') }));
    assert.deepEqual(after, before, 'Stop must block IR transmission, even a redundant command that would leave lamp state unchanged');
  });

  const handMethods = await quest.evaluate(() => window.__ce.emulator?.device.remote?.listMethods?.().map((m) => m.method) ?? []);
  const needed = ['set_input_mode', 'set_connected', 'set_hand_pose', 'set_transform', 'look_at', 'set_select_value', 'get_hand_state'];
  if (!needed.every((method) => handMethods.includes(method))) {
    console.log(`SKIP 17-emulated-hand-pinch: IWER lacks hand input methods (${needed.filter((m) => !handMethods.includes(m)).join(', ')})`);
  } else await phase('17-emulated-hand-pinch', async () => {
    // Bring the fallback dock into view, then hand tracking must take over without a mouse click.
    await quest.evaluate(() => {
      const app = window.__ce;
      const head = app.emulator.head();
      const direction = app.hud.deck.getWorldPosition(head.position.clone()).sub(head.position);
      const up = head.position.clone().set(0, 1, 0);
      app.emulator.setHead(head.position, head.quaternion.setFromAxisAngle(up, Math.atan2(-direction.x, -direction.z)));
      app.input.mouseAsHand = false;
      window.__flowsHandEvents = [];
      app.hud.on('consumed', (e) => window.__flowsHandEvents.push(e));
    });
    await elapsedFrames(2200);
    try {
      await quest.evaluate(async () => {
        const app = window.__ce, remote = app.emulator.device.remote;
        await remote.dispatch('set_input_mode', { mode: 'hand' });
        for (const device of ['hand-left', 'hand-right']) {
          await remote.dispatch('set_connected', { device, connected: true });
          await remote.dispatch('set_hand_pose', { device, poseId: 'default' });
          await remote.dispatch('set_select_value', { device, value: 0 });
        }
        const head = app.emulator.head();
        const wrist = head.position.clone().add(head.position.clone().set(-0.18, -0.25, -0.4).applyQuaternion(head.quaternion));
        const palm = head.position.clone().sub(wrist).normalize();
        const fingers = head.position.clone().set(0, 1, 0).applyQuaternion(head.quaternion);
        fingers.addScaledVector(palm, -fingers.dot(palm)).normalize();
        const xyz = (vector) => ({ x: vector.x, y: vector.y, z: vector.z });
        await remote.dispatch('set_transform', { device: 'hand-left', anchor: 'wrist', position: xyz(wrist),
          orientation: { fingers: xyz(fingers), palm: xyz(palm) } });
      });
      await waitQuest(() => window.__ce.lastFrame.hands.left?.palmUpMs >= 300
        && window.__ce.hud.deck.userData.anchor === 'left' && window.__ce.hud.deck.userData.open);
      await elapsedFrames(250); // Let the 180 ms opening fade complete before targeting an icon.
      await quest.evaluate(async () => {
        const app = window.__ce, remote = app.emulator.device.remote, device = 'hand-right';
        const head = app.emulator.head();
        const position = head.position.clone().add(head.position.clone().set(0.15, -0.2, -0.2).applyQuaternion(head.quaternion));
        const button = app.hud.root.getObjectByName('mode-annotate').getWorldPosition(position.clone());
        await remote.dispatch('set_transform', { device, position: { x: position.x, y: position.y, z: position.z } });
        await remote.dispatch('look_at', { device, target: { x: button.x, y: button.y, z: button.z } });
      });
      await waitQuest(() => window.__ce.lastFrame.hands.right?.joints['index-finger-tip']
        && !window.__ce.lastFrame.hands.right.controller && !window.__ce.lastFrame.hands.right.pinching);
      const sent = await quest.evaluate(() => window.__flowsRequests.length);
      await quest.evaluate(() => window.__ce.emulator.device.remote.dispatch('set_select_value', { device: 'hand-right', value: 1, duration: 0.15 }));
      await waitQuest(() => window.__ce.lastFrame.hands.right?.pinching);
      await waitQuest((sent) => window.__ce.modes.mode === 'annotate' && window.__ce.scanner.active
        && window.__flowsHandEvents.some((e) => e.hand === 'right' && e.widget === 'deck')
        && window.__flowsRequests.slice(sent).some((e) => e.type === 'mode.set' && e.payload.mode === 'annotate'), sent);
      const hand = await quest.evaluate(() => window.__ce.emulator.device.remote.dispatch('get_hand_state', { device: 'hand-right', joints: 'all' }));
      assert(hand.connected && hand.pressed && Object.keys(hand.joints ?? {}).length >= 25, 'Pinch must come from a tracked XR hand');
      await writeFile(join(SCREENS, 'hand-input.json'), JSON.stringify(hand, null, 2));
      // Disconnect the interacting hand so it cannot hold the dock open while the left palm turns away.
      await quest.evaluate(async () => {
        const app = window.__ce, remote = app.emulator.device.remote;
        await remote.dispatch('set_select_value', { device: 'hand-right', value: 0 });
        await remote.dispatch('set_connected', { device: 'hand-right', connected: false });
        const hand = await remote.dispatch('get_hand_state', { device: 'hand-left' });
        await remote.dispatch('set_transform', { device: 'hand-left', anchor: 'wrist', position: hand.anchors.wrist,
          orientation: { fingers: hand.axes.fingers,
            palm: { x: -hand.axes.palm.x, y: -hand.axes.palm.y, z: -hand.axes.palm.z } } });
      });
      await waitQuest(() => !window.__ce.lastFrame.hands.left?.palmUp
        && window.__ce.hud.deck.userData.anchor === 'left' && !window.__ce.hud.deck.userData.open);
      await elapsedFrames(250);
      assert.equal(await quest.evaluate(() => window.__ce.hud.deck.visible), false, 'Palm-away dock must finish hiding');
    } finally {
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

  // Recovery is last: reload intentionally ends XR, and restarting discards transient setup work.
  const storedIdentity = (page) => page.evaluate(() => localStorage.getItem('ce.device'));
  let macIdentity, questIdentity, spaceId, pairedDevices;
  let newPairRequests = 0;
  const watchPairing = (request) => {
    if (new URL(request.url()).pathname === '/api/pair/start') newPairRequests++;
  };
  await phase('18-companion-reload', async () => {
    companion.on('request', watchPairing);
    quest.on('request', watchPairing);
    macIdentity = await storedIdentity(companion);
    questIdentity = await storedIdentity(quest);
    assert(macIdentity && questIdentity && macIdentity !== questIdentity, 'Mac and Quest must have separate saved identities');
    ({ space: { spaceId, pairedDevices } } = await json('/api/health'));
    await companion.evaluate(() => window.__flowsMidi.connect(true));
    await companion.reload({ waitUntil: 'domcontentloaded' });
    await companion.waitForFunction(() => document.querySelector('#conn-dot')?.classList.contains('on')
      && document.querySelector('#synth-status')?.textContent === 'OP-1 Field on USB');
    assert(await storedIdentity(companion) === macIdentity, 'Companion reload must keep its saved identity');
    assert.equal(newPairRequests, 0, 'Companion reload must not begin another pairing');
    await companionScreenshot('18-companion-reloaded');
  }, false);
  await phase('19-quest-reload', async () => {
    await quest.reload({ waitUntil: 'domcontentloaded' });
    await waitQuest(() => window.__ce?.welcome && window.__ce.ws.open);
    assert(await storedIdentity(quest) === questIdentity, 'Quest reload must keep its saved identity');
    assert.equal(newPairRequests, 0, 'Quest reload must not begin another pairing');
    await companion.waitForFunction(() => document.querySelector('#headset-status')?.textContent.includes('Connected to Quest'));
    await companionScreenshot('19-companion-quest-reloaded');
  }, false);
  await phase('20-server-restart', async () => {
    await stopServer();
    await startServer();
    await waitQuest(() => window.__ce?.ws.open && window.__ce.welcome);
    await companion.waitForFunction(() => document.querySelector('#conn-dot')?.classList.contains('on')
      && document.querySelector('#headset-status')?.textContent.includes('Connected to Quest')
      && document.querySelector('#synth-status')?.textContent === 'OP-1 Field on USB');
    const health = await json('/api/health');
    assert.equal(health.space.spaceId, spaceId, 'Restart must reopen the existing fixture space');
    assert.equal(health.space.pairedDevices, pairedDevices, 'Restart must not add duplicate paired devices');
    assert(await storedIdentity(companion) === macIdentity && await storedIdentity(quest) === questIdentity,
      'Server restart must retain the saved Mac and Quest identities');
    assert.equal(newPairRequests, 0, 'Recovering after a server restart must not begin another pairing');
    await companionScreenshot('20-companion-server-restarted');
  }, false);
}

async function diagnostics() {
  await mkdir(SCREENS, { recursive: true });
  await writeFile(join(SCREENS, 'server.log'), serverLog);
  await writeFile(join(SCREENS, 'browser.log'), browserLog.join('\n'));
  const state = { phase: currentPhase };
  if (quest && !quest.isClosed()) {
    state.quest = await quest.evaluate(() => ({
      camera: window.__ce?.cameraState, hud: window.__ce?.hudKind,
      mode: window.__ce?.modes.mode, tags: window.__ce?.modes.tags && [...window.__ce.modes.tags.values()],
      lockedId: window.__ce?.lockedId, pendingArm: window.__ce?.pendingArm,
      hands: window.__flowsHandEvents, input: window.__ce?.input.diagnostics,
      targets: window.__ce?.targets.list(), events: window.__flowsEvents, requests: window.__flowsRequests, controls: window.__flowsControls,
      specs: window.__ce?.hud.specs && [...window.__ce.hud.specs.values()].map((m) => ({
        specId: m.spec.specId, targetId: m.targetId, armed: m.armed,
        controls: m.spec.controls.map((c) => ({ id: c.id, action: c.binding?.action, armed: c.armed })),
      })),
      log: document.querySelector('#log')?.textContent,
    })).catch((e) => ({ error: e.message }));
    state.positioning = await panelState().catch((e) => ({ error: e.message }));
    await quest.screenshot({ path: join(SCREENS, `${currentPhase}-FAIL.png`), timeout: 5000 }).catch(() => {});
  }
  if (sim && !sim.isClosed()) state.sim = await sim.evaluate(() => ({
    lamp: window.ceSim?.lamp(), learn: window.ceSim?.learn(), logs: window.ceSimDebug?.device.logLines,
  })).catch((e) => ({ error: e.message }));
  if (companion && !companion.isClosed()) {
    state.companion = await companion.evaluate(() => ({
      stage: document.querySelector('#onboarding')?.getAttribute('data-state'),
      title: document.querySelector('#onboarding-title')?.textContent,
      headset: document.querySelector('#headset-status')?.textContent,
      synth: document.querySelector('#synth-status')?.textContent,
      activity: document.querySelector('#setup-activity')?.textContent,
      log: document.querySelector('#log')?.textContent,
    })).catch((e) => ({ error: e.message }));
    await companion.screenshot({ path: join(SCREENS, `${currentPhase}-companion-FAIL.png`), timeout: 5000 }).catch(() => {});
  }
  await writeFile(join(SCREENS, 'failure.json'), JSON.stringify(state, null, 2));
}

async function stopServer() {
  if (server?.pid && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise((resolveExit) => server.once('exit', resolveExit));
    server.kill('SIGTERM');
    const force = setTimeout(() => server.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(force); }
  }
  server = undefined;
}

async function cleanup() {
  await stopServer();
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
const deadline = setTimeout(() => abort.abort(new Error('Two-mode flows exceeded 10 minutes')), 10 * 60_000);
try {
  await Promise.race([run(), interrupted]);
  console.log(`PASS two-mode flows; screenshots: ${SCREENS}`);
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
