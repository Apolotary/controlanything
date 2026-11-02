/**
 * Usage: npm run build && npm run e2e:judge (requires system Chrome; no browser download).
 * Runs a muted fixture demo on its own ports 8796/8446. Screenshots and failure diagnostics
 * go to research/screens/v2-flow/. Never reuses an existing server; removes its temporary data.
 * Optional YOLO preview is disabled: this checks the two-mode server scan and HUD judge path.
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
const SCREENS = join(ROOT, 'research/screens/v2-flow');
const BASE = 'http://127.0.0.1:8796';
const UI_TIMEOUT = 30_000;
const PIPELINE_TIMEOUT = 180_000;
let server, browser, quest, sim, dataDir, cardId;
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
  for (const app of ['sim', 'quest']) {
    await access(join(ROOT, `apps/${app}/dist/index.html`)).catch(() => {
      throw new Error(`${app} is not built. Run npm run build before npm run e2e:judge.`);
    });
  }
  await portMustBeFree(8796);
  await portMustBeFree(8446);
  const freshDir = await mkdtemp(join(tmpdir(), 'ce-e2e-judge-'));
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
      HTTP_PORT: '8796', HTTPS_PORT: '8446',
      HTTP_HOST: '127.0.0.1', HTTPS_HOST: '127.0.0.1', PUBLIC_HOST: '127.0.0.1',
      CE_DATA_DIR: dataDir, MODEL_MODE: 'fixture', MODEL_API_KEY: '', CE_SCAN_PROMPTS: '',
      CE_MAC_SILENT: '1', CE_MAC_LOCAL: '0',
      CE_REMO: '0', REMO_HOST: '', REMO_SEND: '0',
      CE_TRUST_FIRST_DEVICE: '1', CE_TRUST_LOOPBACK: '1', CE_CONSOLE_APPROVE: '0',
      MUSE_REPLAY: '1', MUSE_RECORD: '0', MUSE_RECORD_DIR: '',
      FIXTURE_DELAY_MS: '300', GEN3D_REPLAY_SPEED: '0', VITEST: '',
    },
  });
  server.on('error', (error) => { serverError = error; });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', (chunk) => {
    serverLog = (serverLog + chunk.toString()).slice(-250_000);
    // HTTP starts before HTTPS: wait until the entry point has finished starting both.
    serverReady ||= serverLog.includes('ControlEverything server ');
  });
  await until('own HTTP/HTTPS fixture server startup', () => serverReady);
  const health = await json('/api/health');
  assert.equal(health.mode, 'fixture');
  assert.equal(health.space.pairedDevices, 0, 'Server must start with an empty registry');
  assert.equal(new URL(health.urls.https).port, '8446');
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
      window.__judgeEvents = [];
      window.__judgeControls = [];
      window.__judgeRequests = [];
      const types = new Set(['mode.state', 'tags.state', 'target.status', 'device.card', 'agent.step', 'verify.result', 'ui.spec', 'arm.request', 'arm.result']);
      window.__ce.ws.tap('in', ({ type, payload }) => {
        if (!types.has(type)) return;
        window.__judgeEvents.push({ type, payload });
        if (window.__judgeEvents.length > 300) window.__judgeEvents.shift();
      });
      window.__ce.ws.tap('out', ({ type, payload }) => {
        if (type === 'control.event') window.__judgeControls.push(payload);
        window.__judgeRequests.push({ type, payload });
        if (window.__judgeRequests.length > 500) window.__judgeRequests.shift();
      });
    });
    await quest.locator('#btn-enter').click();
    await waitQuest(() => window.__ce.renderer.xr.isPresenting && window.__ce.cameraState === 'on');
  });

  let targetId, tagGaze;
  await phase('02-annotate', async () => {
    await waitQuest(() => window.__ce.modes.mode === 'annotate' && window.__ce.scanner.active
      && window.__ce.targets.list().some((t) => /ceiling (light|lamp)/i.test(t.label)));
    assert(await quest.evaluate(() => window.__judgeRequests.some((e) => e.type === 'mode.set' && e.payload.mode === 'annotate')),
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
    assert(await quest.evaluate((id) => window.__judgeRequests.some((e) => e.type === 'tag.add' && e.payload.targetId === id), targetId),
      'Pinching an annotation must tag the device');
  });
  await phase('04-identify', async () => {
    await waitQuest((id) => window.__judgeEvents.some((e) => e.type === 'tags.state'
      && e.payload.tags.some((tag) => tag.cardId === id && /light|lamp/i.test(tag.name ?? tag.label))), cardId);
    assert.equal(await quest.evaluate(() => window.__ce.modes.mode), 'annotate');
    assert.equal(await quest.evaluate(() => window.__judgeRequests.some((e) => ['target.select', 'control.setup', 'control.event', 'arm.confirm'].includes(e.type))), false,
      'Annotation must not request setup, arming, or physical control');
    assert.equal(await quest.evaluate(() => window.__judgeEvents.some((e) => ['agent.step', 'verify.result', 'ui.spec', 'arm.request'].includes(e.type))), false,
      'Tagging must not start the control pipeline');
    assert.equal(await sim.evaluate(() => window.ceSim.lamp().power), 'off');
  });
  await phase('05-control-mode', async () => {
    await pinch({ nodeName: 'mode-control', turn: true });
    await waitQuest(() => window.__ce.modes.mode === 'control' && !window.__ce.scanner.active);
    await waitQuest((id) => window.__ce.modes.byCard(id)?.connection === 'setup', cardId);
    await assertDockIcons('control');
    assert.equal(await quest.evaluate(() => window.__judgeRequests.some((e) => e.type === 'control.setup')), false,
      'Switching mode alone must not start setup');
  });
  await phase('06-set-up-control', async () => {
    await pinch({ targetId, turn: true });
    await pinch({ nodeName: 'control-setup' });
    await waitQuest((id) => window.__judgeRequests.some((e) => e.type === 'control.setup' && e.payload.cardId === id), cardId);
    // A user keeps the light in view while it is tested; FIXTURE SAM re-finds it at the tag-time image position.
    await quest.evaluate((gaze) => { const app = window.__ce; app.emulator.lookAt(app.desktopCam.position.clone().fromArray(gaze)); }, tagGaze);
  });
  await phase('07-learn-remote', async () => {
    await until('all seven remote buttons captured', async () => {
      const t = await target();
      return t.research?.learned?.length === 7;
    }, PIPELINE_TIMEOUT);
    assert(await sim.evaluate(() => window.ceSimDebug.device.logLines.some((l) => l.kind === 'learn' && l.text.includes('captured press'))), 'Sim must capture the virtual remote');
  });
  await phase('08-verify', async () => {
    await until('physical verification completed', async () => {
      const t = await target();
      return ['verified', 'forging', 'forged', 'arming'].includes(t.state)
        && Object.values(t.verification).includes('pass') && t;
    }, PIPELINE_TIMEOUT);
    await waitQuest((id) => window.__judgeEvents.some((e) => e.type === 'verify.result'
      && e.payload.cardId === id && e.payload.pass && e.payload.observed?.sense === 'camera'), cardId);
  });
  await phase('09-controls-ready', async () => {
    await waitQuest((id) => {
      const app = window.__ce;
      return app.pendingArm && app.hud.confirm
        && [...app.hud.specs.values()].some((m) => m.targetId === id && m.spec.controls.length > 0);
    }, targetId, PIPELINE_TIMEOUT);
    assert.equal((await target()).armed, false, 'Server must gate controls until ARM');
  });
  await phase('10-arm', async () => {
    assert.equal(await quest.evaluate(() => !!window.__ce.hud.confirm.hold), false, 'Light should use one-tap confirmation');
    await pinch({ nodeName: 'confirm-yes' });
    await waitQuest((id) => window.__judgeEvents.some((e) => e.type === 'arm.result' && e.payload.cardId === id && e.payload.armed)
      && [...window.__ce.hud.specs.values()].some((m) => m.targetId === window.__ce.lockedId && m.armed), cardId);
    assert.equal((await target()).armed, true);
    await assertDockIcons('control', true);
  });
  await phase('11-control-changes-light', async () => {
    await sim.waitForFunction(() => window.ceSim.lamp().power === 'on' && window.ceSimDebug.device.animator.settled);
    const before = await sim.evaluate(() => window.ceSim.lamp());
    const control = await quest.evaluate((cardId) => {
      const app = window.__ce;
      const ui = window.__judgeEvents.findLast((e) => e.type === 'ui.spec' && e.payload.cardId === cardId)?.payload;
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
      return { id, nodeName: node.name, specId: ui.specId, sent: window.__judgeControls.length };
    }, cardId);
    assert(control, 'Armed device HUD must expose its off action by hack id or command role');
    // Looking at the controls after verification is complete leaves its camera evidence undisturbed.
    await pinch({ nodeName: control.nodeName, turn: true });
    await waitQuest(({ id, specId, sent }) => window.__judgeControls.slice(sent)
      .some((event) => event.specId === specId && event.widgetId === id && event.value === true), control);
    await sim.waitForFunction(() => window.ceSim.lamp().power === 'off' && window.ceSimDebug.device.animator.settled);
    const after = await sim.evaluate(() => window.ceSim.lamp());
    assert.notDeepEqual(after, before);
    assert.equal(await sim.evaluate(() => window.ceSimDebug.device.lastIr?.source), 'exec', 'Lamp must change through the server executor');
    console.log(`  lamp: ${before.power} -> ${after.power} (HUD ${control.id})`);
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
      targets: window.__ce?.targets.list(), events: window.__judgeEvents, requests: window.__judgeRequests, controls: window.__judgeControls,
      specs: window.__ce?.hud.specs && [...window.__ce.hud.specs.values()].map((m) => ({
        specId: m.spec.specId, targetId: m.targetId, armed: m.armed,
        controls: m.spec.controls.map((c) => ({ id: c.id, action: c.binding?.action, armed: c.armed })),
      })),
      log: document.querySelector('#log')?.textContent,
    })).catch((e) => ({ error: e.message }));
    await quest.screenshot({ path: join(SCREENS, `${currentPhase}-FAIL.png`), timeout: 5000 }).catch(() => {});
  }
  if (sim && !sim.isClosed()) state.sim = await sim.evaluate(() => ({
    lamp: window.ceSim?.lamp(), learn: window.ceSim?.learn(), logs: window.ceSimDebug?.device.logLines,
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
const deadline = setTimeout(() => abort.abort(new Error('Judge path exceeded 8 minutes')), 8 * 60_000);
try {
  await Promise.race([run(), interrupted]);
  console.log(`PASS judge path; screenshots: ${SCREENS}`);
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
