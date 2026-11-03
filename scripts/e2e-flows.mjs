/**
 * Usage: npm run build && npm run e2e:flows (requires system Chrome; no browser download).
 * Runs a muted fixture demo on its own ports 8797/8447. Screenshots and failure diagnostics
 * go to research/screens/v2-flows/. Never reuses an existing server; removes its temporary data.
 * Optional YOLO preview is disabled; detections still use the server's fixture scan path.
 * Scan prompts are limited to ceiling light + synthesizer to avoid generic duplicate boxes.
 * The sim advertises connected sim-midi and sim-ir ports even with audio muted. We only
 * assert synth setup eligibility, never run its audio pipeline. Companion coverage uses a
 * separate browser context, typed code plus its real rendered QR, and silent Web MIDI metadata to exercise
 * hot-plug and second-tab presence. Recovery reuses the same fixture data across a restart.
 * Helpers are copied from e2e-judge.mjs so its passing path remains unchanged.
 * This script needs sockets and Chrome and cannot run in the coding sandbox.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

async function json(path, token) {
  const response = await fetch(`${BASE}${path}`, { ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}), signal: AbortSignal.timeout(3000) });
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
    serverReady ||= serverLog.slice(logOffset).includes('ControlAnything server ');
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
  await companion.goto(`${BASE}/pair`, { waitUntil: 'domcontentloaded' });
  assert.equal(new URL(companion.url()).pathname, '/companion/');
  assert.equal(new URL(companion.url()).searchParams.get('pair'), '1');
  await companion.locator('#self-qr svg').waitFor({ state: 'visible' });
}

async function helperPaired() {
  // Assert the visible success before its 1.5 s dismissal; companion polling can arrive later.
  await waitQuest(() => {
    const app = window.__ce;
    return app.onboarding.state === 'paired' && app.onboarding.visible && !app.onboarding.scanning
      && app.hud.root.getObjectByName('helper-pairing-title')?.text === `Paired with ${app.onboarding.pairedName}`;
  });
  const pairedName = await quest.evaluate(() => window.__ce.onboarding.pairedName);
  assert(pairedName, 'The success card must identify the paired laptop');
  await waitQuest(() => !window.__ce.onboarding.visible && !window.__ce.onboarding.scanning, undefined, 5000);
  await companion.waitForFunction(() => document.querySelector('#paired-summary')?.textContent.includes('Paired with Quest 3')
    && document.querySelector('#paired-summary')?.textContent.includes('Start with Open visuals below, then choose Menu → Try visual synth in Quest.'));
  await companion.locator('#paired-summary').waitFor({ state: 'visible' });
  assert.equal(await companion.locator('#onboarding-title').textContent(), 'Paired with Quest 3');
  assert.equal(await companion.locator('#onboarding-next').textContent(), 'Start with Open visuals below, then choose Menu → Try visual synth in Quest. Set up and enable controls there.');
  assert.equal(await companion.locator('#enable-midi').isVisible(), false, 'Pairing must not request USB MIDI permission');
  assert.equal(await companion.locator('#connection-steps').isVisible(), false, 'Pairing must not expose synth connection steps');
  assert.equal(await companion.evaluate(() => sessionStorage.getItem('ce.flows.midi.allowed')), null,
    'Pairing must not call requestMIDIAccess');
  return pairedName;
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

// UI panels now remain at the shared anchor when the wearer looks at an object.
// Model a deliberate look at named controls; target-visibility tests keep their prior behavior.
async function pinch({ targetId, nodeName, turn = !!nodeName, holdMs = 0 }) {
  await renderedFrames();
  if (targetId && !turn) await waitQuest((id) => {
    const app = window.__ce;
    return app.visibleTargets.has(id) && (app.modes.tags.has(id) || Date.now() - (app.observed.get(id)?.at ?? 0) < 200);
  }, targetId);
  const point = await quest.evaluate(({ targetId, nodeName, turn }) => {
    const app = window.__ce;
    const object = nodeName ? app.hud.root.getObjectByName(nodeName)
      : app.modes.tags.has(targetId) ? app.hud.root.getObjectByName(`target-label:${targetId}`) : null;
    if (nodeName && !object) throw new Error(`HUD node not found: ${nodeName}`);
    for (let node = turn ? null : object; node; node = node.parent) {
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
  if (turn) {
    await elapsedFrames(300); // Ready rings expand after looking at them for 250 ms.
    return pinch({ targetId, nodeName, holdMs, turn: false });
  }
  await quest.mouse.move(point.x, point.y);
  await quest.mouse.down();
  try {
    await renderedFrames();
    if (holdMs) await elapsedFrames(holdMs);
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
  const route = await quest.evaluate(nodeName => {
    const menu = window.__ce.hud.root.getObjectByName('main-menu'), node = menu.getObjectByName(nodeName);
    if (!node?.userData.menuButton) throw new Error(`Unknown menu action: ${nodeName}`);
    let visible = true;
    for (let owner = node; owner; owner = owner.parent) if (!owner.visible) visible = false;
    return visible ? null : menu.userData.toolsOpen ? 'menu-tools-back' : 'menu-tools';
  }, nodeName);
  if (route) await pinch({ nodeName: route, turn: true });
  await waitQuest(nodeName => {
    let node = window.__ce.hud.root.getObjectByName(nodeName);
    if (!node) return false;
    for (; node; node = node.parent) if (!node.visible) return false;
    return true;
  }, nodeName);
  await pinch({ nodeName, turn: true, ...options });
}

async function target() {
  const result = await json(`/api/agent/targets/${encodeURIComponent(cardId)}`);
  assert.notEqual(result.state, 'failed', `Agent failed: ${JSON.stringify(result)}`);
  return result;
}

async function assertDockIcons(mode, canStop = false) {
  const pose = await quest.evaluate(() => {
    const head = window.__ce.emulator.head();
    return { position: head.position.toArray(), quaternion: head.quaternion.toArray() };
  });
  assert.equal(await quest.evaluate(() => window.__ce.hud.root.getObjectByName('main-menu')?.visible), false,
    'Menu choices must stay closed until the user opens Menu');
  await openMenu();
  const menuState = () => quest.evaluate(() => {
    const { hud } = window.__ce, menu = hud.root.getObjectByName('main-menu'), choices = [];
    menu.traverse(node => {
      if (!node.userData.menuButton) return;
      for (let owner = node; owner; owner = owner.parent) if (!owner.visible) return;
      choices.push(node.name);
    });
    return { choices: choices.sort(), hasLights: !!hud.root.getObjectByName('filter:lights'), anchor: hud.deck.userData.anchor,
      mode: window.__ce.modes.mode, menuOpen: hud.deck.userData.open };
  });
  const primary = await menuState();
  const expectedPrimary = ['visual-synth', 'ask-muse-general', 'menu-tools', 'exit-ar', 'menu-close'];
  if (canStop) expectedPrimary.push('deck:panic');
  assert.deepEqual(primary.choices, expectedPrimary.sort(), 'Primary menu must emphasize the synth and retain immediate Stop');
  await pinch({ nodeName: 'menu-tools', turn: true });
  const state = await menuState();
  const expected = ['menu-tools-back', 'muse-canvas', 'mode-annotate', mode === 'annotate' ? 'mode-control' : 'change-device',
    'identify-area', 'helper-pair', 'menu-recenter', 'exit-ar', 'menu-close'];
  if (mode === 'annotate' && !canStop) expected.push('filter:everything', 'filter:electronics');
  if (canStop) expected.push('deck:panic');
  assert.deepEqual(state.choices, expected.sort(), `${mode} secondary menu must expose only its available actions`);
  assert.equal(state.hasLights, false, 'Menu must omit the unsupported Lights-only detector filter');
  assert.equal(state.anchor, 'world', 'Mouse emulator input must use the world-locked Menu pill');
  assert.equal(state.mode, mode, 'Opening Menu must preserve the current mode');
  assert.equal(state.menuOpen, true);
  await quest.evaluate(() => {
    const app = window.__ce;
    app.emulator.lookAt(app.hud.root.getObjectByName('main-menu').getWorldPosition(app.desktopCam.position.clone()));
  });
  await renderedFrames();
  await screenshot(`${currentPhase}-menu-open`);
  if (mode === 'annotate') {
    await menuAction('filter:electronics');
    await waitQuest(() => window.__ce.filter === 'electronics' && !window.__ce.hud.root.getObjectByName('main-menu')?.visible);
    await openMenu();
    await menuAction('filter:everything');
    await waitQuest(() => window.__ce.filter === 'everything');
  } else await pinch({ nodeName: 'menu-close', turn: true });
  await waitQuest(() => !window.__ce.hud.root.getObjectByName('main-menu')?.visible);
  await quest.evaluate((pose) => {
    const app = window.__ce, head = app.emulator.head();
    app.emulator.setHead(head.position.fromArray(pose.position), head.quaternion.fromArray(pose.quaternion));
  }, pose);
  await renderedFrames();
}

async function findTarget(pattern) {
  await waitQuest(pattern => window.__ce.targets.list().some(t => new RegExp(pattern, 'i').test(t.label)), pattern);
  await quest.evaluate(pattern => {
    const app = window.__ce;
    const intended = app.targets.list().find(t => new RegExp(pattern, 'i').test(t.label));
    app.emulator.lookAt(intended.position);
  }, pattern);
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
    const dock = app.hud.deck;
    const { width, height, anchor } = dock.userData;
    if (!(width > 0) || !(height >= 0.045)) throw new Error(`Invalid dock dimensions: ${width} x ${height}`);
    return { card: describe(app.hud.card, 0.4, 0.32), dock: { ...describe(dock, width, height), anchor } };
  });
}

function assertLocked(before, after, description, panels = ['card', 'dock']) {
  for (const key of panels) {
    assert(Math.hypot(...before[key].position.map((v, i) => v - after[key].position[i])) < 1e-5,
      `${description}: ${key} world position moved`);
    const dot = Math.abs(before[key].rotation.reduce((s, v, i) => s + v * after[key].rotation[i], 0));
    assert(1 - dot < 1e-6, `${description}: ${key} rotated with the head`);
  }
}

function assertSeparated(state, comfortable = false) {
  const { card, dock } = state;
  assert.equal(dock.anchor, 'world', 'Positioning checks must exercise the world-locked Menu pill');
  if (comfortable) for (const [name, panel] of Object.entries({ card, dock })) {
    assert(panel.inView, `${name} did not return fully into view`);
    assert(panel.distance >= 0.5 && panel.distance <= 1, `${name} distance ${panel.distance} m`);
    assert(panel.upright > 0.999, `${name} is not upright`);
  }
  // Projection becomes singular as a panel crosses behind the eye. Compare visible panels.
  if (!card.inView || !dock.inView) return;
  const a = card.bounds, b = dock.bounds;
  assert(a.right <= b.left || b.right <= a.left || a.top <= b.bottom || b.top <= a.bottom,
    `Card overlaps Menu launcher in screen space: ${JSON.stringify({ a, b })}`);
  // The shared workspace deliberately uses one plane. Its vertical navigation slot,
  // screen-space separation and explicit render layers replace the old depth offset.
  const slotDistance = Math.hypot(...card.position.map((value, index) => value - dock.position[index]));
  assert(slotDistance >= .2 && slotDistance <= .45, `Menu must stay in its shared workspace slot: ${slotDistance}`);
  const aligned = Math.abs(card.rotation.reduce((sum, value, index) => sum + value * dock.rotation[index], 0));
  assert(1 - aligned < 1e-6, 'Card and Menu must share the workspace orientation');
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
    assert.equal(await quest.evaluate(() => window.__ce.onboarding.visible), false,
      'The simulated room already provides a helper for the judge path');
  });

  let targetId, synthId, synthCardId, tagGaze, staleControl;
  await phase('02-annotate', async () => {
    await waitQuest(() => window.__ce.modes.mode === 'annotate' && window.__ce.scanner.active
      && window.__ce.targets.list().some((t) => /ceiling (light|lamp)/i.test(t.label)));
    assert(await quest.evaluate(() => window.__flowsRequests.some((e) => e.type === 'mode.set' && e.payload.mode === 'annotate')),
      'Entering AR explicitly starts in Annotate');
    assert.equal(await quest.evaluate(() => window.__ce.onboarding.guide(window.__ce.modes.tags.size)?.step), 'tag',
      'With a helper connected, onboarding must explain tagging first');
    await quest.evaluate(() => window.__ce.ws.inject({ v: 1, id: 'flows-stale-mode', ts: Date.now(), from: 'server',
      type: 'mode.state', payload: { mode: 'control' } }));
    await renderedFrames();
    assert.equal(await quest.evaluate(() => window.__ce.modes.mode), 'annotate',
      'A stale server mode echo must not switch the user into Control');
    await assertDockIcons('annotate');
    targetId = await quest.evaluate(() => window.__ce.targets.list().find((t) => /ceiling (light|lamp)/i.test(t.label)).id);
    // Discovery displays only the three best nearby candidates. Face the intended light
    // instead of relying on a stale renderer label left over from before the menu/filter test.
    await quest.evaluate(id => window.__ce.emulator.lookAt(window.__ce.targets.get(id).position), targetId);
    await waitQuest(id => window.__ce.visibleTargets.has(id) && window.__ce.hud.targets.has(id)
      && Date.now() - (window.__ce.observed.get(id)?.at ?? 0) < 200, targetId);
    await renderedFrames();
    // Where the head looks while tagging: the FIXTURE verify outline is the tag frame's box, so verify must see the same view.
    tagGaze = await quest.evaluate(() => {
      const head = window.__ce.lastFrame.head;
      const p = head.position.clone();
      const dir = p.clone().set(0, 0, -1).applyQuaternion(head.quaternion);
      return p.addScaledVector(dir, 3).toArray();
    });
  });
  await phase('02a-detector-deadband', async () => {
    const stability = await quest.evaluate((id) => {
      const app = window.__ce, hud = app.hud, source = hud.targets.get(id);
      if (!source) throw new Error('A detector candidate is required');
      const probeId = 'flows-stability';
      const initial = { ...source, id: probeId, tagged: false, position: [...source.position], sizeM: [0.3, 0.2, 0.1] };
      hud.upsertTarget(initial);
      const box = hud.boxes.boxes.get(probeId), before = box.center.clone();
      let movement = 0, resize = 0;
      try {
        for (let sample = 0; sample < 90; sample++) {
          hud.upsertTarget({ ...initial, position: [initial.position[0] + Math.sin(sample) * 0.04,
            initial.position[1] + Math.cos(sample) * 0.03, initial.position[2]],
          sizeM: [0.3 + Math.sin(sample) * 0.01, 0.2 + Math.cos(sample) * 0.01, 0.1] });
          hud.boxes.update(1 / 90, app.lastFrame.head.position, app.lastFrame, 'annotate');
          movement = Math.max(movement, before.distanceTo(box.center));
          resize = Math.max(resize, Math.abs(box.w - 0.3), Math.abs(box.h - 0.2));
        }
        return { movement, resize };
      } finally { hud.removeTarget(probeId); }
    }, targetId);
    assert(stability.movement < 1e-6, `Small detector noise moved the box ${stability.movement} m`);
    assert(stability.resize < 1e-6, `Small size noise resized the box ${stability.resize} m`);
  });
  await phase('03-tag-light', async () => {
    await pinch({ targetId });
    await waitQuest((id) => window.__ce.modes.tags.has(id) && window.__ce.modes.tags.get(id).cardId, targetId);
    cardId = await quest.evaluate((id) => window.__ce.modes.tags.get(id).cardId, targetId);
    assert.equal(await quest.evaluate(() => window.__ce.onboarding.guide(window.__ce.modes.tags.size)?.step), 'use',
      'The first tag must explain how to choose Use devices from Menu');
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
    // Re-tagging restores the same saved library record (it may appear under the record's own target id).
    await waitQuest(() => [...window.__ce.modes.tags.values()].some((t) => /synth|keyboard|op-1/i.test(`${t.name ?? ''} ${t.label}`) && t.cardId));
    ({ synthId, synthCardId } = await quest.evaluate(() => {
      const tag = [...window.__ce.modes.tags.values()].find((t) => /synth|keyboard|op-1/i.test(`${t.name ?? ''} ${t.label}`) && t.cardId);
      return { synthId: tag.targetId, synthCardId: tag.cardId };
    }));
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
    await menuAction('mode-control');
    await waitQuest(() => window.__ce.modes.mode === 'control' && !window.__ce.scanner.active);
    assert.equal(await quest.evaluate(() => window.__ce.onboarding.guide(window.__ce.modes.tags.size)), null,
      'Choosing Use devices explicitly completes this session’s guide');
    assert.equal(await quest.evaluate(() => window.__ce.hud.card.visible || !!window.__ce.lockedId), false,
      'Changing mode alone must not open any device card');
    await waitQuest((id) => window.__ce.modes.byCard(id)?.connection === 'setup', cardId);
    await assertDockIcons('control');
    assert.equal(await quest.evaluate(() => window.__flowsRequests.some((e) => e.type === 'control.setup')), false,
      'Switching mode alone must not start setup');
  });
  await phase('06-helper-onboarding', async () => {
    await assertSynthConnection(synthCardId, 'offline', () => sim.evaluate(() => window.ceSimDebug.device.conn.stop()));
    const helper = await json('/api/helper');
    assert.equal(helper.helpers.some((device) => device.online), false, 'This phase needs no online helper');
    assert.equal(helper.urls[0], 'http://localhost:8797/pair');
    await waitQuest((urls) => {
      const app = window.__ce;
      return app.onboarding.visible && app.onboarding.scanning
        && app.hud.root.getObjectByName('helper-pairing-title')?.text === 'Pair a helper device'
        && app.hud.root.getObjectByName('helper-pairing-url')?.text === urls[0].replace(/^https?:\/\//, '')
        && app.hud.root.getObjectByName('helper-pairing-status')?.text === 'Looking for the QR code…';
    }, helper.urls);
    assert.deepEqual(await quest.evaluate(() => window.__ce.onboarding.urls), helper.urls,
      'The card must display addresses supplied by the server');
    const sent = await quest.evaluate(() => window.__flowsRequests.length);
    await waitQuest((sent) => window.__flowsRequests.slice(sent).filter((e) => e.type === 'scan.frame' && e.payload.purpose === 'pair').length >= 2, sent);
  });
  await phase('06a-helper-skip-and-offline-card', async () => {
    await pinch({ nodeName: 'helper-skip', turn: true });
    await waitQuest(() => window.__ce.onboarding.state === 'skipped' && !window.__ce.onboarding.visible && !window.__ce.onboarding.scanning);
    const sent = await quest.evaluate(() => window.__flowsRequests.length);
    await elapsedFrames(2400); // Includes the helper presence refresh interval.
    assert.equal(await quest.evaluate(() => window.__ce.onboarding.visible), false, 'Skip hides the card for this AR session');
    assert.equal(await quest.evaluate((sent) => window.__flowsRequests.slice(sent).some((e) => e.type === 'scan.frame' && e.payload.purpose === 'pair'), sent), false,
      'Skip must stop the pairing camera loop');
    const hint = await quest.evaluate((id) => window.__ce.modes.byCard(id).hint, synthCardId);
    assert.equal(hint, 'Open ControlAnything on your Mac and plug in the synth');
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
  await phase('06b-helper-pair-by-code', async () => {
    await menuAction('helper-pair');
    await waitQuest(() => window.__ce.onboarding.visible && window.__ce.onboarding.scanning);
    await openCompanion();
    const code = await companion.locator('#self-code').innerText();
    assert.match(code, /^[A-Z0-9]{3}-[A-Z0-9]{3}$/);
    assert.equal(await companion.locator('#app-header').isVisible(), false, '/pair should begin with the QR and code only');
    await companionScreenshot('06b-companion-pair-page');
    await pinch({ nodeName: 'helper-type-code', turn: true });
    for (const key of code.replace('-', '')) await pinch({ nodeName: `pair-key:${key}` });
    await waitQuest((code) => window.__ce.hud.root.getObjectByName('pair-code-value')?.text === code
      && !!window.__ce.hud.root.getObjectByName('pair-code-submit'), code);
    await screenshot('06b-pairing-type-code');
    assert.equal(await quest.evaluate(() => window.__ce.onboarding.scanning), true, 'Type code keeps QR scanning active');
    await pinch({ nodeName: 'pair-code-submit' });
    await helperPaired();
    await companionScreenshot('06b-companion-paired-by-code');
  }, false);
  await phase('06c-helper-pair-by-qr', async () => {
    // A fresh browser models a second laptop and keeps the real QR decoder covered.
    await companionContext.close();
    await waitQuest(() => window.__ce.onboarding.visible && window.__ce.onboarding.scanning);
    await openCompanion();
    assert.match(await companion.locator('#self-code').innerText(), /^[A-Z0-9]{3}-[A-Z0-9]{3}$/);
    const expires = await companion.locator('#self-expiry').innerText();
    assert(expires, 'The Mac must show when its pairing code expires');
    await companion.waitForFunction((previous) => document.querySelector('#self-expiry')?.textContent !== previous, expires);
    await companionScreenshot('06c-companion-pair-qr');
    await scanCompanionQr();
    await helperPaired();
    await waitQuest((id) => window.__ce.modes.byCard(id)?.connection === 'offline'
      && window.__ce.modes.byCard(id)?.hint === 'Plug the synth into your Mac', synthCardId);
    assert.equal(await quest.evaluate(() => !!window.__ce.hud.root.getObjectByName('control-pair')), false,
      'A paired Mac without a synth must offer cable guidance, without another Connect Mac button');
    await companionScreenshot('06c-companion-connected-no-usb');
  }, false);
  await phase('06d-companion-usb-hotplug', async () => {
    await companion.locator('#details-open').click();
    await companion.locator('#bridge-midi').click();
    await companion.locator('#details-close').click();
    await assertSynthConnection(synthCardId, 'setup', () => companion.evaluate(() => window.__flowsMidi.connect(true)));
    await companion.waitForFunction(() => document.querySelector('#synth-status')?.textContent.includes('OP-1 Field on USB'));
    await waitQuest(() => !!window.__ce.hud.root.getObjectByName('control-setup'));
    assert.equal(await companion.locator('#onboarding-title').textContent(), 'Paired with Quest 3');
    assert.equal(await companion.locator('#enable-midi').isVisible(), false, 'Connecting MIDI must not replace neutral onboarding with a synth setup prompt');
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
  await phase('06g-companion-visual-renderer-presence', async () => {
    const owner = await companion.evaluate(() => JSON.parse(localStorage.getItem('ce.device')).deviceId);
    const portState = async (state) => waitQuest(({ owner, state }) => window.__flowsEvents.findLast(event => event.type === 'presence')?.payload.devices
      .find(device => device.deviceId === owner)?.ports?.some(port => port.id === 'ce-visual-synth' && port.state === state), { owner, state });
    await portState('disconnected');
    const before = (await json('/api/agent/exec')).sent.length;
    const [visuals] = await Promise.all([
      companionContext.waitForEvent('page'),
      companion.getByRole('button', { name: 'Open visuals', exact: true }).first().click(),
    ]);
    watchPage(visuals, 'companion-visuals');
    try {
      await visuals.waitForURL('**/vsynth/**');
      await visuals.locator('#visuals').waitFor({ state: 'visible' });
      assert.equal(new URL(visuals.url()).searchParams.get('owner'), owner, 'Open visuals must carry its paired companion identity');
      assert.equal(await visuals.evaluate(() => document.visibilityState), 'visible');
      await portState('connected');
      assert.equal(await visuals.locator('body.unavailable').count(), 0);
      await visuals.screenshot({ path: join(SCREENS, '06g-companion-owned-visuals.png') });
    } finally { await visuals.close(); }
    await portState('disconnected');
    assert.equal((await json('/api/agent/exec')).sent.length, before, 'Opening and closing visuals must not send device commands or enable hand control');
    await quest.bringToFront();
  }, false);
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
    await menuAction('change-device');
    await waitQuest(() => !window.__ce.lockedId);
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
    await menuAction('mode-annotate');
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
    await menuAction('mode-control');
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
      app.input.mouseAsHand = true;
      app.input.pointer.inside = app.input.pointer.down = app.input.pointer.latched = false;
      for (const hand of Object.values(app.emulator.device.hands)) hand.connected = false;
    });
    try {
      // Explicit user recovery establishes the workspace. Open cards must then stay
      // in the world; recovery requires a deliberate raised-palm gesture.
      await yaw(0);
      await menuAction('menu-recenter');
      await waitQuest(() => !window.__ce.hud.root.getObjectByName('main-menu')?.visible);
      await yaw(0); await renderedFrames();
      const initial = await panelState();
      assertSeparated(initial, true);
      assert(initial.dock.position[1] > initial.card.position[1] + 0.2, 'Menu launcher must sit above the card in easy view');
      for (let frame = 0; frame < 30; frame++) {
        await yaw(2 * Math.sin(frame / 29 * Math.PI));
        const state = await panelState();
        assertLocked(initial, state, `small motion frame ${frame}`);
        assertSeparated(state);
      }
      await yaw(20);
      await elapsedFrames(2200);
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
        assertLocked(smallTurn, last, '100 degree turn preserves the open card', ['card']);
        if (now - start < 1000) assertLocked(smallTurn, last, 'launcher recovery delay', ['dock']);
        assertSeparated(last);
        if (now - start >= 2300) break;
        await renderedFrames();
      } while (true);
      assertLocked(smallTurn, last, 'Launcher must not jump automatically after looking away', ['dock']);
      // Recover through actual tracked hand posture, without turning back toward the old launcher.
      await quest.evaluate(async () => {
        const app = window.__ce, remote = app.emulator.device.remote, head = app.emulator.head();
        app.input.mouseAsHand = false;
        await remote.dispatch('set_input_mode', { mode: 'hand' });
        await remote.dispatch('set_connected', { device: 'hand-right', connected: false });
        await remote.dispatch('set_connected', { device: 'hand-left', connected: true });
        await remote.dispatch('set_hand_pose', { device: 'hand-left', poseId: 'open' });
        await remote.dispatch('set_select_value', { device: 'hand-left', value: 0 });
        const wrist = head.position.clone().add(head.position.clone().set(-0.18, -0.25, -0.4).applyQuaternion(head.quaternion));
        const palm = head.position.clone().sub(wrist).normalize();
        const fingers = head.position.clone().set(0, 1, 0).applyQuaternion(head.quaternion);
        fingers.addScaledVector(palm, -fingers.dot(palm)).normalize();
        const xyz = v => ({ x: v.x, y: v.y, z: v.z });
        await remote.dispatch('set_transform', { device: 'hand-left', anchor: 'wrist', position: xyz(wrist),
          orientation: { fingers: xyz(fingers), palm: xyz(palm) } });
      });
      await waitQuest(() => window.__ce.hud.root.getObjectByName('main-menu')?.visible);
      await quest.evaluate(async () => {
        const app = window.__ce, remote = app.emulator.device.remote;
        await remote.dispatch('set_connected', { device: 'hand-left', connected: false });
        await remote.dispatch('set_input_mode', { mode: 'controller' }); app.input.mouseAsHand = true;
      });
      await menuAction('menu-recenter');
      await waitQuest(() => !window.__ce.hud.root.getObjectByName('main-menu')?.visible);
      await renderedFrames();
      const recovered = await panelState();
      assertSeparated(recovered, true);
      assert(Math.hypot(...initial.card.position.map((value, i) => value - recovered.card.position[i])) > 0.2,
        'Recenter panels must move the card into the new workspace');
      // Looking at an actual visible control confirms the recovered workspace can be used.
      await pinch({ nodeName: 'device-lock', turn: true });
      await waitQuest(() => window.__ce.hud.card.userData.pinned === true);
      await pinch({ nodeName: 'device-lock' });
      await waitQuest(() => window.__ce.hud.card.userData.pinned === false);
      await writeFile(join(SCREENS, 'positioning.json'), JSON.stringify({ initial, smallTurn, turnedAway: last, recovered }, null, 2));
    } finally {
      await quest.evaluate(() => { window.__ce.input.mouseAsHand = true; });
    }
  });

  await phase('15b-device-lock-and-edge-arrow', async () => {
    await pinch({ nodeName: 'device-lock', turn: true });
    await waitQuest(() => window.__ce.hud.card.userData.pinned === true);
    const before = (await panelState()).card;
    await quest.evaluate((id) => {
      const app = window.__ce, head = app.emulator.head();
      const device = app.targets.get(id).position;
      app.emulator.lookAt(head.position.clone().multiplyScalar(2).sub(device));
    }, targetId);
    await elapsedFrames(2300);
    const state = await quest.evaluate(() => {
      const app = window.__ce, edge = app.hud.root.getObjectByName('device-edge-pill');
      const arrow = edge?.getObjectByName('edge-direction');
      const camera = app.renderer.xr.getCamera().cameras[0];
      const point = edge?.getWorldPosition(app.lastFrame.head.position.clone()).project(camera);
      let pills = 0;
      app.hud.root.traverse((node) => { if (node.name === 'device-edge-pill' && node.visible) pills++; });
      return { lockedId: app.lockedId, pinned: app.hud.card.userData.pinned,
        card: app.hud.card.position.toArray(), pills, edgeVisible: edge?.visible,
        ndc: point?.toArray(), vertices: arrow?.geometry?.getAttribute('position').count ?? 0 };
    });
    assert.equal(state.pinned, true);
    assert.equal(state.lockedId, targetId, 'Looking away must preserve the bound device');
    assert(Math.hypot(...before.position.map((v, i) => v - state.card[i])) < 1e-5, 'Locked card moved after looking away');
    assert.equal(state.pills, 1, 'Only the selected device may show an edge pill');
    assert(state.edgeVisible && state.vertices > 0, 'Off-screen device needs a geometry arrow');
    assert(state.ndc && Math.abs(state.ndc[0]) < 1 && Math.abs(state.ndc[1]) < 1
      && Math.abs(state.ndc[2]) < 1, `Edge pill left the view: ${state.ndc}`);
    await screenshot('15b-locked-device-edge-arrow');
    await pinch({ nodeName: 'device-lock', turn: true });
    await waitQuest(() => window.__ce.hud.card.userData.pinned === false);
    await pinch({ nodeName: 'device-lock' });
    await waitQuest(() => window.__ce.hud.card.userData.pinned === true);
    await menuAction('change-device');
    await waitQuest(() => !window.__ce.lockedId);
    await pinch({ targetId: synthId, turn: true });
    await waitQuest((id) => window.__ce.lockedId === id && window.__ce.hud.card.userData.pinned === false, synthId);
    await menuAction('change-device');
    await waitQuest(() => !window.__ce.lockedId);
    await pinch({ targetId, turn: true });
    await waitQuest((id) => window.__ce.lockedId === id && window.__ce.hud.card.userData.pinned === false, targetId);
  });

  await phase('16-stop-disarms-and-blocks-ir', async () => {
    assert.equal((await target()).armed, true);
    await menuAction('deck:panic');
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
    console.log(`SKIP 17-emulated-explicit-menu: IWER lacks hand input methods (${needed.filter((m) => !handMethods.includes(m)).join(', ')})`);
  } else await phase('17-emulated-explicit-menu', async () => {
    await quest.evaluate(() => {
      const app = window.__ce;
      app.emulator.lookAt(app.hud.deck.getWorldPosition(app.desktopCam.position.clone()));
      app.input.mouseAsHand = false;
      app.input.pointer.inside = app.input.pointer.down = app.input.pointer.latched = false;
      window.__flowsHandEvents = [];
      app.hud.on('consumed', (e) => window.__flowsHandEvents.push(e));
    });
    await elapsedFrames(2200);
    const hasFingerPose = await quest.evaluate(() => {
      const poses = window.__ce.emulator.device.hands.left.poseIds ?? [];
      return poses.includes('open') && poses.includes('pinch-middle');
    });
    const handPinch = async (nodeName, hand = 'right') => {
      await quest.evaluate(async ({ nodeName, hand }) => {
        const app = window.__ce, remote = app.emulator.device.remote, device = `hand-${hand}`;
        const other = `hand-${hand === 'right' ? 'left' : 'right'}`;
        const head = app.emulator.head();
        const position = head.position.clone().add(head.position.clone().set(hand === 'right' ? 0.15 : -0.15, -0.2, -0.2).applyQuaternion(head.quaternion));
        const button = app.hud.root.getObjectByName(nodeName);
        if (!button) throw new Error(`Menu button is missing: ${nodeName}`);
        for (let node = button; node; node = node.parent) if (!node.visible) throw new Error(`Menu button is hidden: ${nodeName}`);
        const target = button.getWorldPosition(position.clone());
        await remote.dispatch('set_select_value', { device, value: 0 });
        await remote.dispatch('set_connected', { device: other, connected: false });
        await remote.dispatch('set_connected', { device, connected: true });
        await remote.dispatch('set_hand_pose', { device, poseId: 'default' });
        await remote.dispatch('set_transform', { device, position: { x: position.x, y: position.y, z: position.z } });
        await remote.dispatch('look_at', { device, target: { x: target.x, y: target.y, z: target.z } });
      }, { nodeName, hand });
      await waitQuest((hand) => window.__ce.lastFrame.hands[hand]?.joints['index-finger-tip']
        && !window.__ce.lastFrame.hands[hand].controller && !window.__ce.lastFrame.hands[hand].pinching, hand);
      await elapsedFrames(200);
      await quest.evaluate((hand) => window.__ce.emulator.device.remote.dispatch('set_select_value', { device: `hand-${hand}`, value: 1, duration: 0.15 }), hand);
      await waitQuest((hand) => window.__ce.lastFrame.hands[hand]?.pinching, hand);
      await renderedFrames();
      const state = await quest.evaluate((hand) => window.__ce.emulator.device.remote.dispatch('get_hand_state', { device: `hand-${hand}`, joints: 'all' }), hand);
      assert(state.connected && state.pressed && Object.keys(state.joints ?? {}).length >= 25,
        'Menu interaction must come from tracked XR joints');
      await quest.evaluate((hand) => window.__ce.emulator.device.remote.dispatch('set_select_value', { device: `hand-${hand}`, value: 0 }), hand);
      await waitQuest((hand) => !window.__ce.lastFrame.hands[hand]?.pinching, hand);
    };
    try {
      await quest.evaluate(async (hasFingerPose) => {
        const app = window.__ce, remote = app.emulator.device.remote;
        await remote.dispatch('set_input_mode', { mode: 'hand' });
        for (const device of ['hand-left', 'hand-right']) {
          await remote.dispatch('set_connected', { device, connected: device === 'hand-left' });
          await remote.dispatch('set_hand_pose', { device, poseId: hasFingerPose ? 'open' : 'default' });
          await remote.dispatch('set_select_value', { device, value: 0 });
        }
        const head = app.emulator.head();
        // Finger-chord regression uses a lowered hand. A raised open palm held for 650 ms
        // deliberately recalls Menu; that gesture must not be mistaken for this test.
        const wrist = head.position.clone().add(head.position.clone().set(-0.18, -0.25, -0.4).applyQuaternion(head.quaternion));
        wrist.y = head.position.y - 0.55;
        const palm = head.position.clone().sub(wrist).normalize();
        const fingers = head.position.clone().set(0, 1, 0).applyQuaternion(head.quaternion);
        fingers.addScaledVector(palm, -fingers.dot(palm)).normalize();
        const xyz = (vector) => ({ x: vector.x, y: vector.y, z: vector.z });
        await remote.dispatch('set_transform', { device: 'hand-left', anchor: 'wrist', position: xyz(wrist),
          orientation: { fingers: xyz(fingers), palm: xyz(palm) } });
      }, hasFingerPose);
      await waitQuest(() => window.__ce.lastFrame.hands.left?.palmUpMs >= 300);
      const sent = await quest.evaluate(() => window.__flowsRequests.length);
      if (hasFingerPose) {
        await quest.evaluate(() => window.__ce.emulator.device.remote.dispatch('set_hand_pose', {
          device: 'hand-left', poseId: 'open', fingers: { thumb: 'pinch-middle', middle: 'pinch-middle' }, duration: 0.25,
        }));
        await waitQuest(() => {
          const joints = window.__ce.lastFrame.hands.left.joints;
          return joints['thumb-tip'].position.distanceTo(joints['middle-finger-tip'].position) < 0.015;
        });
        await elapsedFrames(800);
        assert.equal(await quest.evaluate(() => window.__ce.modes.mode), 'control',
          'A relaxed thumb-middle touch must never change mode');
        assert.equal(await quest.evaluate((sent) => window.__flowsRequests.slice(sent).filter((event) => event.type === 'mode.set').length, sent), 0,
          'Finger chords must not send mode changes');
        await quest.evaluate(() => window.__ce.emulator.device.remote.dispatch('set_hand_pose', {
          device: 'hand-left', poseId: 'open', duration: 0.25,
        }));
      } else console.log('SKIP thumb-middle pose: this IWER build lacks per-finger touch poses');
      assert.equal(await quest.evaluate(() => window.__ce.hud.root.getObjectByName('main-menu')?.visible), false,
        'A lowered palm and finger chords must not open Menu; raised deliberate recall is a separate gesture');
      assert.equal(await quest.evaluate(() => window.__ce.hud.deck.userData.anchor), 'world',
        'The Menu pill must stay world-locked while hands move');
      await handPinch('menu-toggle');
      await waitQuest(() => window.__ce.hud.root.getObjectByName('main-menu')?.visible);
      assert.equal(await quest.evaluate(() => window.__ce.modes.mode), 'control', 'Opening Menu must not change mode');
      await screenshot('17a-explicit-menu');
      await handPinch('menu-tools'); await handPinch('mode-annotate');
      await waitQuest(() => window.__ce.modes.mode === 'annotate' && window.__ce.scanner.active
        && !window.__ce.hud.root.getObjectByName('main-menu')?.visible);
      await handPinch('menu-toggle', 'left');
      await waitQuest(() => window.__ce.hud.root.getObjectByName('main-menu')?.visible);
      await handPinch('menu-tools', 'left'); await handPinch('mode-control', 'left');
      await waitQuest(() => window.__ce.modes.mode === 'control' && !window.__ce.scanner.active
        && !window.__ce.hud.root.getObjectByName('main-menu')?.visible);
      const modes = await quest.evaluate((sent) => window.__flowsRequests.slice(sent).filter((event) => event.type === 'mode.set').map((event) => event.payload.mode), sent);
      assert.deepEqual(modes, ['annotate', 'control'], 'Only explicit menu choices may change modes, using either hand');
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
  let macIdentity, questIdentity, spaceId, pairedDevices, savedSpecHash, savedSkinHash, savedSpecId, savedVersionId;
  let recoverySetups = 0;
  const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
  const digest = (value) => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value))).digest('hex');
  const skinHash = async (spec) => {
    if (!spec.gen3d?.skin?.url) return undefined;
    const response = await fetch(new URL(spec.gen3d.skin.url, BASE));
    assert(response.ok, 'A saved skin URL must still serve its image');
    return digest(Buffer.from(await response.arrayBuffer()));
  };
  const savedLibraryDevice = async () => {
    const token = JSON.parse(questIdentity).deviceToken;
    return (await json('/api/library', token)).devices.find((device) => device.cardId === cardId);
  };
  const assertSavedSetup = async () => {
    const device = await savedLibraryDevice();
    assert.equal(device?.connection, 'ready', 'Saved light must be Ready as soon as its paired bridge reconnects');
    assert.equal(device.activeVersionId, savedVersionId, 'Restoration must not create a new setup version');
    const spec = await json(`/api/gen3d/specs/${encodeURIComponent(savedSpecId)}`);
    assert.equal(digest(spec), savedSpecHash, 'Restoration must return the identical interface spec');
    assert.equal(await skinHash(spec), savedSkinHash, 'Restoration must return identical skin bytes');
    assert.equal(recoverySetups, 0, 'Reload and restart must never request setup automatically');
  };
  let newPairRequests = 0;
  const watchPairing = (request) => {
    if (new URL(request.url()).pathname === '/api/pair/start') newPairRequests++;
  };
  await phase('18-companion-reload', async () => {
    // Phase 16 deliberately stopped controls. Explicitly enable the saved setup before testing recovery.
    if (await quest.evaluate(() => window.__ce.modes.mode !== 'control')) await menuAction('mode-control');
    if (await quest.evaluate(id => window.__ce.lockedId !== id, targetId)) {
      await menuAction('change-device');
      await waitQuest(() => !window.__ce.lockedId);
      await pinch({ targetId, turn: true });
    }
    await pinch({ nodeName: 'control-setup' });
    await waitQuest(() => window.__ce.pendingArm && window.__ce.hud.confirm);
    await pinch({ nodeName: 'confirm-yes' });
    await waitQuest((id) => window.__ce.modes.byCard(id)?.connection === 'ready' && window.__ce.armedCards.has(id), cardId);
    savedSpecId = (await target()).specId;
    const savedSpec = await json(`/api/gen3d/specs/${encodeURIComponent(savedSpecId)}`);
    savedSpecHash = digest(savedSpec);
    savedSkinHash = await skinHash(savedSpec);
    // Observe every socket across page reloads, including messages sent before app hydration completes.
    quest.on('websocket', (socket) => socket.on('framesent', ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (['control.setup', 'target.retry', 'gen3d.generate'].includes(message.type)) recoverySetups++;
    }));
    companion.on('request', watchPairing);
    quest.on('request', watchPairing);
    macIdentity = await storedIdentity(companion);
    questIdentity = await storedIdentity(quest);
    assert(macIdentity && questIdentity && macIdentity !== questIdentity, 'Mac and Quest must have separate saved identities');
    ({ space: { spaceId, pairedDevices } } = await json('/api/health'));
    savedVersionId = (await savedLibraryDevice()).activeVersionId;
    await companion.evaluate(() => window.__flowsMidi.connect(true));
    await companion.reload({ waitUntil: 'domcontentloaded' });
    await companion.waitForFunction(() => document.querySelector('#conn-dot')?.classList.contains('on')
      && document.querySelector('#synth-status')?.textContent === 'OP-1 Field on USB');
    assert(await storedIdentity(companion) === macIdentity, 'Companion reload must keep its saved identity');
    assert.equal(newPairRequests, 0, 'Companion reload must not begin another pairing');
    await companionScreenshot('18-companion-reloaded');
    await companion.goto(`${BASE}/pair`, { waitUntil: 'domcontentloaded' });
    await companion.waitForFunction(() => document.querySelector('#conn-dot')?.classList.contains('on')
      && document.querySelector('#paired-summary')?.textContent.includes('Paired with Quest 3'));
    assert(await storedIdentity(companion) === macIdentity, 'Revisiting /pair must reuse the saved companion identity');
    assert.equal(newPairRequests, 0, 'Revisiting /pair must not begin another pairing');
    assert.equal(await companion.locator('#self-qr').isVisible(), false, 'A paired helper must not show a new QR');
    assert.equal(await companion.locator('#paired-summary').isVisible(), true);
    await companionScreenshot('18-companion-pair-revisited');
    await assertSavedSetup();
  }, false);
  await phase('19-quest-reload', async () => {
    await quest.reload({ waitUntil: 'domcontentloaded' });
    await waitQuest(() => window.__ce?.welcome && window.__ce.ws.open);
    assert(await storedIdentity(quest) === questIdentity, 'Quest reload must keep its saved identity');
    assert.equal(newPairRequests, 0, 'Quest reload must not begin another pairing');
    assert.equal(await quest.evaluate(() => window.__ce.hud.card.visible || !!window.__ce.lockedId), false,
      'Restored devices must remain chips until explicitly selected');
    await companion.waitForFunction(() => document.querySelector('#headset-status')?.textContent.includes('Connected to Quest'));
    await companionScreenshot('19-companion-quest-reloaded');
    await assertSavedSetup();
  }, false);
  await phase('20-server-restart', async () => {
    // Keep the camera quiet across reconnect to isolate restoration from optional annotation scanning.
    await quest.evaluate(() => {
      const scanner = window.__ce.scanner;
      window.__flowsScannerTick = scanner.tick;
      scanner.stop(); scanner.tick = () => {};
    });
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
    await sim.waitForFunction(() => window.ceSimDebug?.device.conn?.open
      && document.querySelector('#b-conn')?.textContent.includes('ONLINE'));
    await until('saved light bridge is online after restart', async () => (await savedLibraryDevice())?.connection === 'ready');
    await assertSavedSetup();
    assert.equal((await json('/api/muse/calls')).totals.calls, 0, 'Restart restoration must make zero model calls');
    assert.equal((await json('/api/agent/exec')).sent.length, 0, 'Restart restoration must send zero physical commands');
    await quest.evaluate(() => { window.__ce.scanner.tick = window.__flowsScannerTick; delete window.__flowsScannerTick; });
    await quest.locator('#btn-enter').click();
    await waitQuest(() => window.__ce.renderer.xr.isPresenting && window.__ce.cameraState === 'on');
    await yaw(0);
    // The emulator has no persistent anchors. A fresh fixture detection must place the saved card.
    await waitQuest((id) => {
      const app = window.__ce, target = app.targets.byCard(id);
      // method is the latest placement (later scans overwrite 'reassociated'); identity + a fresh frame are asserted below.
      return app.roomAnchors.states.get(id) === 'located' && target?.cardId === id && !!target.frameId
        && app.visibleTargets.has(target.id);
    }, cardId);
    const chip = await quest.evaluate((id) => {
      const app = window.__ce, target = app.targets.byCard(id);
      return { cardId: target.cardId, frameId: target.frameId, position: target.position.toArray(),
        shown: app.observed.get(target.id)?.target.position };
    }, cardId);
    assert.equal(chip.cardId, cardId, 'Fresh placement must reuse the saved card identity');
    assert(chip.frameId, 'Fallback placement must come from a new detection');
    assert(chip.shown && chip.shown.every((coordinate, axis) => Math.abs(coordinate - chip.position[axis]) <= 0.001),
      'The saved chip must be drawn at its freshly observed place (millimetre display precision)');
    await menuAction('mode-control');
    await waitQuest((id) => window.__ce.modes.byCard(id)?.connection === 'ready', cardId);
    await assertSavedSetup();
    assert.equal(await quest.evaluate(() => window.__ce.hud.card.visible || !!window.__ce.lockedId), false,
      'Entering Control after restart must not reopen a restored device card');
    assert((await json('/api/muse/calls')).calls.every((call) => call.format === 'segmentation'),
      'Only the explicit fallback scan may run; restoring controls must not identify, research or generate again');
    assert.equal((await json('/api/agent/exec')).sent.length, 0, 'Rendering restored controls must not send physical commands');
    await screenshot('20-saved-light-ready');
    await quest.evaluate(() => window.__ce.renderer.xr.getSession().end());
    await waitQuest(() => !window.__ce.renderer.xr.isPresenting);
    await companionScreenshot('20-companion-server-restarted');
  }, false);
  await phase('21-exit-ar-hold', async () => {
    await quest.locator('#btn-enter').click();
    await waitQuest(() => window.__ce.renderer.xr.isPresenting);
    // A plain tap (~200 ms incl. the harness's 100 ms polling) is an unambiguous early release of the 600 ms hold.
    await menuAction('exit-ar');
    assert.equal(await quest.evaluate(() => window.__ce.renderer.xr.isPresenting), true, 'An early release must cancel Exit');
    await waitQuest(() => window.__ce.hud.root.getObjectByName('exit-ar')?.userData.holdProgress === 0);
    await menuAction('exit-ar', { holdMs: 650 });
    await waitQuest(() => !window.__ce.renderer.xr.isPresenting);
    const enter = quest.locator('#btn-enter');
    assert(await enter.isVisible() && await enter.isEnabled(), 'Enter AR must be immediately pressable after Exit');
    const bounds = await enter.boundingBox();
    assert(bounds && bounds.width >= 160 && bounds.height >= 48, 'Enter AR needs a large return target');
    await quest.screenshot({ path: join(SCREENS, '21-exit-ar-ready-to-return.png') });
  }, false);

  await phase('22-general-muse-full-conversation', async () => {
    await quest.evaluate(() => {
      const app = window.__ce;
      window.__round3Requests = [];
      app.ws.tap('out', ({ type, payload }) => window.__round3Requests.push({ type, payload: type === 'scan.frame'
        ? { frameId: payload.frameId, purpose: payload.purpose, width: payload.width, height: payload.height,
          detections: payload.fixtureDetections?.map(d => ({ label: d.label, box: d.box })) } : payload }));
      // Exercise the real microphone button wiring without opening a physical microphone.
      window.__round3Mic = { prepare: app.mic.prepare, start: app.mic.start, stop: app.mic.stop, ready: app.mic.ready, param: app.params.get('mic') };
      app.params.delete('mic'); app.mic.ready = true;
      app.mic.prepare = async () => {}; app.mic.start = () => {}; app.mic.stop = () => {};
    });
    try {
      await quest.locator('#btn-enter').click();
      await waitQuest(() => window.__ce.renderer.xr.isPresenting && window.__ce.cameraState === 'on');
      await menuAction('ask-muse-general');
      await waitQuest(() => window.__ce.assistant.view?.targetId === 'muse-general'
        && window.__ce.assistant.view?.state === 'listening'
        && window.__ce.hud.root.getObjectByName('assistant-panel')?.visible);
      assert.equal(await quest.evaluate(() => window.__ce.hud.root.getObjectByName('assistant-title')?.text), 'Ask Muse');
      const request = 'Please explain how I can create a webpage in this headset, then return to AR to identify an object. '
        + 'I need the complete explanation to stay readable while I move my head, with an obvious next step and no automatic hardware control. '.repeat(5);
      assert.equal(await quest.evaluate(text => window.__ce.assistant.sendGeneralText(text), request), true);
      await waitQuest(() => window.__ce.assistant.view?.state === 'reply');
      const reply = await quest.evaluate(() => window.__ce.assistant.view.text);
      assert.match(reply, /headset browser/i); assert.match(reply, /FIXTURE/);
      await pinch({ nodeName: 'assistant-read', turn: true });
      const retained = { request: [], reply: [] };
      const count = await quest.evaluate(() => window.__ce.hud.root.getObjectByName('assistant-panel').userData.readingPages);
      assert(count >= 3, 'The long transcript must expose multiple readable pages');
      for (let page = 0; page < count; page++) {
        const shown = await quest.evaluate(() => ({ label: window.__ce.hud.root.getObjectByName('assistant-status').text,
          text: window.__ce.hud.root.getObjectByName('object-info-detail').text }));
        assert(!shown.text.includes('…') && shown.text.length <= 280, 'A reading page must not truncate text or exceed its glyph budget');
        retained[shown.label.startsWith('Your full request') ? 'request' : 'reply'].push(shown.text);
        if (page < count - 1) await pinch({ nodeName: 'object-info-sources', turn: true });
      }
      const normalize = text => text.replace(/\s+/g, '');
      assert.equal(normalize(retained.request.join('')), normalize(request));
      assert.equal(normalize(retained.reply.join('')), normalize(reply));
      await screenshot('22a-complete-muse-response');
      await pinch({ nodeName: 'object-info-close', turn: true });
      await waitQuest(() => window.__ce.hud.root.getObjectByName('assistant-dismiss')?.visible);
      await pinch({ nodeName: 'assistant-dismiss', turn: true });
      await waitQuest(() => !window.__ce.hud.root.getObjectByName('assistant-panel')?.visible);
      assert.equal(await quest.evaluate(() => window.__round3Requests.some(e => ['control.event', 'control.setup', 'arm.confirm', 'voice.audio'].includes(e.type))), false,
        'A general question must not send hardware commands, start setup, or capture microphone audio');
    } finally {
      await quest.evaluate(() => {
        const app = window.__ce, saved = window.__round3Mic; app.assistant.cancel();
        app.mic.prepare = saved.prepare; app.mic.start = saved.start; app.mic.stop = saved.stop; app.mic.ready = saved.ready;
        if (saved.param === null) app.params.delete('mic'); else app.params.set('mic', saved.param);
      });
    }
  }, false);

  await phase('23-manual-region-identification', async () => {
    await menuAction('mode-annotate');
    await waitQuest(() => window.__ce.scanner.active && window.__round3Requests.some(e => e.type === 'scan.frame' && e.payload.purpose === 'scan'));
    const fullFrame = await quest.evaluate(() => window.__round3Requests.findLast(e => e.type === 'scan.frame' && e.payload.purpose === 'scan').payload);
    const intended = await quest.evaluate(() => window.__ce.targets.list().find(t => /ceiling (light|lamp)/i.test(t.label))?.position.toArray());
    assert(intended, 'The fixture room must supply an actual visible object for the cropped scan');
    await menuAction('identify-area');
    await waitQuest(() => window.__ce.manualRegion?.active && !window.__ce.scanner.active && !window.__ce.onboarding.visible);
    const baseline = await quest.evaluate(() => window.__round3Requests.length);
    assert.equal(await quest.evaluate(() => window.__ce.visibleTargets.size), 0, 'Old tags must not compete with manual region selection');
    await quest.evaluate(async point => {
      const app = window.__ce, remote = app.emulator.device.remote;
      app.emulator.lookAt(app.desktopCam.position.clone().fromArray(point));
      app.input.mouseAsHand = false; app.input.pointer.inside = app.input.pointer.down = app.input.pointer.latched = false;
      await remote.dispatch('set_input_mode', { mode: 'hand' });
      await remote.dispatch('set_connected', { device: 'hand-left', connected: false });
      await remote.dispatch('set_connected', { device: 'hand-right', connected: true });
      await remote.dispatch('set_hand_pose', { device: 'hand-right', poseId: 'default' });
      await remote.dispatch('set_select_value', { device: 'hand-right', value: 0 });
    }, intended);
    try {
      const corner = async (u, v) => {
        await renderedFrames();
        await quest.evaluate(async ({ u, v }) => {
          const app = window.__ce, selector = app.manualRegion, remote = app.emulator.device.remote, head = app.emulator.head();
          const k = selector.k;
          const target = head.position.clone().set((u * k.width - k.cx) / k.fx, -(v * k.height - k.cy) / k.fy, -1)
            .applyQuaternion(selector.root.quaternion).add(selector.root.position);
          const wrist = head.position.clone().add(head.position.clone().set(0.15, -0.2, -0.2).applyQuaternion(head.quaternion));
          await remote.dispatch('set_select_value', { device: 'hand-right', value: 0 });
          await remote.dispatch('set_transform', { device: 'hand-right', position: { x: wrist.x, y: wrist.y, z: wrist.z } });
          await remote.dispatch('look_at', { device: 'hand-right', target: { x: target.x, y: target.y, z: target.z } });
        }, { u, v });
        await waitQuest(() => !!window.__ce.lastFrame.hands.right?.joints['index-finger-tip'] && !window.__ce.lastFrame.hands.right.pinching);
        await elapsedFrames(250);
        await quest.evaluate(() => window.__ce.emulator.device.remote.dispatch('set_select_value', { device: 'hand-right', value: 1, duration: 0.15 }));
        await waitQuest(() => window.__ce.lastFrame.hands.right?.pinching);
        await renderedFrames();
        await quest.evaluate(() => window.__ce.emulator.device.remote.dispatch('set_select_value', { device: 'hand-right', value: 0 }));
        await waitQuest(() => !window.__ce.lastFrame.hands.right?.pinching);
      };
      await corner(0.22, 0.14);
      await waitQuest(() => window.__ce.manualRegion?.anchor?.length === 2);
      await screenshot('23a-hand-outlined-first-corner');
      await corner(0.78, 0.78);
      await waitQuest(() => !window.__ce.manualRegion.active && !window.__ce.manualScanPending && !window.__ce.scanner.active
        && window.__ce.manualFocusIds?.size > 0 && window.__ce.visibleTargets.size > 0);
      const result = await quest.evaluate(baseline => {
        const app = window.__ce;
        const renderedIds = []; app.hud.root.traverseVisible(node => { if (node.name.startsWith('target-label:')) renderedIds.push(node.name.slice('target-label:'.length)); });
        const frames = window.__round3Requests.slice(baseline).filter(e => e.type === 'scan.frame');
        const frame = frames.find(e => app.capture.get(e.payload.frameId)?.region);
        return { frames: frames.map(e => e.payload), selected: frame?.payload,
          region: frame && app.capture.get(frame.payload.frameId).region,
          focus: [...app.manualFocusIds], visible: [...app.visibleTargets], renderedIds, mountedIds: [...app.mountedTargets],
          commands: window.__round3Requests.slice(baseline).filter(e => ['tag.add', 'control.setup', 'control.event', 'arm.confirm'].includes(e.type)) };
      }, baseline);
      assert.equal(result.frames.length, 1, 'Two corner pinches must issue exactly one scan');
      assert(result.selected && result.region, 'The real scanner must retain the selected crop in its captured-frame record');
      assert(result.selected.width < fullFrame.width && result.selected.height < fullFrame.height, 'The transmitted JPEG dimensions must be cropped, not just a full-view overlay');
      assert(result.selected.detections?.length > 0, 'The selected fixture area must produce actual fixture detections');
      assert(result.visible.every(id => result.focus.includes(id)), 'Only results from the chosen area may be interactive');
      assert(result.renderedIds.length > 0 && result.renderedIds.every(id => result.focus.includes(id)), 'The actual rendered scene must show only region results, including labels previously hidden behind Menu');
      assert(result.mountedIds.every(id => result.focus.includes(id)), 'No out-of-region target may remain mounted to reappear after Menu closes');
      assert.deepEqual(result.commands, [], 'Region identification must not tag or enable/control a device automatically');
      await screenshot('23b-region-limited-fixture-results');
      await elapsedFrames(1800);
      assert.equal(await quest.evaluate(baseline => window.__round3Requests.slice(baseline).filter(e => e.type === 'scan.frame').length, baseline), 1,
        'Whole-view scanning must remain paused after the one-shot result');
      await writeFile(join(SCREENS, '23-manual-region-evidence.json'), JSON.stringify({ source: 'fixture', fullFrame, ...result }, null, 2));
    } finally {
      await quest.evaluate(async () => {
        const app = window.__ce, remote = app.emulator.device.remote;
        await remote.dispatch('set_select_value', { device: 'hand-right', value: 0 });
        await remote.dispatch('set_connected', { device: 'hand-right', connected: false });
        await remote.dispatch('set_input_mode', { mode: 'controller' }); app.input.mouseAsHand = true;
      });
    }
    await menuAction('identify-area'); await waitQuest(() => window.__ce.manualRegion.active);
    await openMenu(); await waitQuest(() => !window.__ce.manualRegion.active && !window.__ce.manualScanPending);
    await pinch({ nodeName: 'exit-ar', turn: true, holdMs: 650 });
    await waitQuest(() => !window.__ce.renderer.xr.isPresenting);
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
      onboarding: window.__ce?.onboarding && { state: window.__ce.onboarding.state, scanning: window.__ce.onboarding.scanning,
        urls: window.__ce.onboarding.urls, pairedName: window.__ce.onboarding.pairedName },
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
