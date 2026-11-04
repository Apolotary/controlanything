/**
 * The judge path, automated: npm run build && npm run e2e:judge (system Chrome; no browser download).
 *
 *   Enter AR in Annotate → pinch/tag the MacBook without opening a demo → More → Visual synth → setup ring → Ask Muse.
 *   The software demo is an explicit choice. No side dials or hand interaction before the request:
 *   Touch the water → code → runs at once (no setup step: the first touch on the screen finds it) → touch → palms Stop
 *   → Ask again without setup → wrist Stop all.
 *
 * The older setup-first flow: the server runs the legacy harness (CE_AGENT=0, pinned unless CE_AGENT is set). The Muse
 * agent golden path (no setup ring) is scripts/e2e-muse-agent.mjs.
 * Runs its own muted FIXTURE server (CE_DEMO=1, CE_MAC_SILENT=1, fresh data dir) on PORT (default 8796,
 * HTTPS off), the sim room as the paired Mac (its laptop screen runs the visual synth) and the desktop Quest
 * emulator with camera=sim. Never reuses an existing server. Screenshots/diagnostics: research/screens/judge/.
 * Boxes come only from SAM 3.1 (here the server's SAM fixtures; there is no on-device detector), so this does not measure
 * detector accuracy, headset frame rate or the real Mac display.
 * Optional: CE_QUEST_DIST / CE_SIM_DIST / CE_COMPANION_DIST point the server at scratch builds;
 * CE_E2E_OUT writes evidence to a separate directory instead of replacing the default captures.
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
const SCREENS = process.env.CE_E2E_OUT?.trim() ? resolve(ROOT, process.env.CE_E2E_OUT.trim()) : join(ROOT, 'research/screens/judge');
const PORT = Number(process.env.PORT || 8796);
const BASE = `http://127.0.0.1:${PORT}`;
const UI_TIMEOUT = 30_000;
const PIPELINE_TIMEOUT = 120_000;
const SCREEN = /visual[\s-]?synth|laptop|macbook|computer|monitor|screen|display/i;
let server, browser, quest, sim, dataDir, cardId;
let serverLog = '';
let currentPhase = '00-server';
const browserLog = [];
const timings = {};
let harnessProof;
let deliberateSelectionProof;
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
    if (server && (server.exitCode !== null || server.signalCode !== null)) throw new Error(`Fixture server exited (${server.exitCode ?? server.signalCode})`);
    const result = await probe();
    if (result) return result;
    await delay(200, undefined, { signal: abort.signal });
  } while (Date.now() < deadline);
  throw new Error(`Timed out after ${timeout / 1000}s: ${description}`);
}

async function portMustBeFree(port) {
  await new Promise((ok, fail) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); fail(new Error(`Port ${port} is occupied; set PORT=<free port>.`)); });
    socket.once('error', (error) => error.code === 'ECONNREFUSED' ? ok() : fail(error));
    socket.setTimeout(1500, () => { socket.destroy(); fail(new Error(`Could not check port ${port}`)); });
  });
}

async function startServer() {
  for (const [app, env] of [['sim', 'CE_SIM_DIST'], ['quest', 'CE_QUEST_DIST']]) {
    const dist = process.env[env]?.trim() || join(ROOT, `apps/${app}/dist`);
    await access(join(dist, 'index.html')).catch(() => { throw new Error(`${app} is not built (${dist}). Run npm run build first.`); });
  }
  await portMustBeFree(PORT);
  dataDir = await mkdtemp(join(tmpdir(), 'ce-e2e-judge-'));
  server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: join(ROOT, 'apps/server'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HTTP_PORT: String(PORT), HTTPS_PORT: '0',
      HTTP_HOST: '127.0.0.1', PUBLIC_HOST: '127.0.0.1',
      CE_DATA_DIR: dataDir, MODEL_MODE: 'fixture', MODEL_API_KEY: '', CE_SCAN_PROMPTS: '',
      // This is the older setup-first flow (setup ring, armed target): pin the legacy harness unless asked otherwise.
      CE_AGENT: process.env.CE_AGENT ?? '0',
      CE_DEMO: '1', CE_MAC_SILENT: '1', CE_MAC_LOCAL: '0', CE_OSMO: '',
      CE_REMO: '0', REMO_HOST: '', REMO_SEND: '0',
      CE_TRUST_FIRST_DEVICE: '1', CE_TRUST_LOOPBACK: '1', CE_CONSOLE_APPROVE: '0',
      MUSE_REPLAY: '1', MUSE_RECORD: '0', MUSE_RECORD_DIR: '',
      CE_WIRE_CHUNK_MS: '180', FIXTURE_DELAY_MS: '300', GEN3D_REPLAY_SPEED: '0', GEN3D_SKIN: '0', VITEST: '',
    },
  });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', (chunk) => { serverLog = (serverLog + chunk).slice(-250_000); });
  await until('fixture server startup', () => serverLog.includes('ControlAnything server '));
  await until('health', () => json('/api/health').catch(() => null));
  const health = await json('/api/health');
  assert.equal(health.mode, 'fixture');
  assert.equal(health.space.pairedDevices, 0, 'Server must start with an empty registry');
}

function watchPage(page, name) {
  const log = (text) => { browserLog.push(`${name}: ${text}`); if (browserLog.length > 300) browserLog.shift(); };
  page.on('pageerror', (error) => log(error.stack ?? error.message));
  page.on('console', (message) => { if (message.type() === 'error') log(message.text()); });
}

async function waitQuest(predicate, arg, timeout = UI_TIMEOUT) {
  abort.signal.throwIfAborted();
  await quest.waitForFunction(predicate, arg, { timeout, polling: 100 });
}

async function frames(count = 2) {
  for (let i = 0; i < count; i++) {
    const time = await quest.evaluate(() => window.__ce.lastFrame?.time ?? 0);
    await waitQuest((previous) => (window.__ce.lastFrame?.time ?? 0) > previous, time);
  }
}

async function screenshot(name) {
  await frames(3);
  const canvas = await quest.evaluateHandle(() => window.__ce.renderer.domElement);
  try { await canvas.asElement().screenshot({ path: join(SCREENS, `${name}.png`), timeout: UI_TIMEOUT }); } finally { await canvas.dispose(); }
}

async function phase(name, action, capture = true) {
  abort.signal.throwIfAborted();
  currentPhase = name;
  const started = Date.now();
  await action();
  if (capture) await screenshot(name);
  timings[name] = +((Date.now() - started) / 1000).toFixed(1);
  console.log(`PASS ${name} (${timings[name]}s)`);
}

/** Screen point of a visible named node (HUD or scene) or of a world position. */
function screenPoint(spec) {
  return quest.evaluate(({ name, world, any }) => {
    const app = window.__ce;
    const shown = (o) => { for (let p=o; p; p=p.parent) { if (p.isVisible?.peek) { if (!p.isVisible.peek()) return false; } else if (!p.visible) return false; } return true; };
    let position;
    if (name) {
      let node = null;
      app.scene.traverse((o) => { if (!node && o.name === name && (any || shown(o))) node = o; });
      if (!node) throw new Error(`Node not visible: ${name}`);
      position = node.getWorldPosition(app.desktopCam.position.clone());
    } else position = app.desktopCam.position.clone().fromArray(world);
    const ndc = position.project(app.renderer.xr.getCamera().cameras[0] ?? app.desktopCam);
    if (Math.abs(ndc.x) > 0.98 || Math.abs(ndc.y) > 0.98) throw new Error(`Outside the emulator view: ${name ?? world}`);
    const rect = app.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + (ndc.x + 1) * rect.width / 2, y: rect.top + (1 - ndc.y) * rect.height / 2 };
  }, spec);
}

async function click(spec) {
  const point = await screenPoint(spec);
  await quest.mouse.move(point.x, point.y); await frames(3);
  await quest.mouse.down(); await frames(3); await quest.mouse.up(); await frames(6);
}

/** Ops the server sent since `since` (the monitor keeps the last 100). */
const exec = async (since = 0) => ((await json('/api/agent/exec')).sent ?? []).filter((e) => e.at > since);
const target = async () => {
  const result = await json(`/api/agent/targets/${encodeURIComponent(cardId)}`);
  assert.notEqual(result.state, 'failed', `Agent failed: ${JSON.stringify(result).slice(0, 600)}`);
  return result;
};

/** click(), pressed again (at most 3 times) only while `done` is still false: on a loaded machine a click can miss its frames. */
async function clickUntil(spec, done, arg) {
  for (let attempt = 1; ; attempt++) {
    await click(spec);
    try { await waitQuest(done, arg, attempt < 3 ? 6000 : UI_TIMEOUT); return; } catch (e) { if (attempt >= 3) throw e; }
  }
}

/** Press the visible chip through the production pointing/click path. No synthetic button events. */
async function pressChip(label) {
  await clickUntil({ name: `wire-chip:${label}` }, () => !['idle', 'stopped', 'failed'].includes(window.__ce.wiring.phase));
}
/** In-page predicate (pass the presentation as waitQuest's arg): the device card shows that presentation. */
const cardIs = (presentation) => window.__ce.scene.getObjectByName('device-card-v3')?.userData.view?.presentation === presentation;

/** Emulated tracked hands (IWER): pose both hands relative to the head, or put the index fingertip at a WORLD point (`tip`). */
const hands = (poses, wait = 20) => quest.evaluate(async ({ poses, wait }) => {
  const app = window.__ce, remote = app.emulator.device.remote, head = app.emulator.head(), V = head.position.constructor;
  app.input.mouseAsHand = false; app.input.pointer.inside = app.input.pointer.down = app.input.pointer.latched = false;
  await remote.dispatch('set_input_mode', { mode: 'hand' });
  const xyz = (v) => ({ x: v.x, y: v.y, z: v.z });
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  for (const [side, { offset, tip, pose, palm }] of Object.entries(poses)) {
    const device = `hand-${side}`;
    const place = async (position, fingers, palmDir) => {
      await remote.dispatch('set_connected', { device, connected: true });
      await remote.dispatch('set_select_value', { device, value: 0 });
      await remote.dispatch('set_hand_pose', { device, poseId: pose });
      await remote.dispatch('set_transform', { device, anchor: 'wrist', position: xyz(position), orientation: { fingers: xyz(fingers), palm: xyz(palmDir) } });
    };
    if (offset) {
      const position = head.position.clone().add(new V().fromArray(offset).applyQuaternion(head.quaternion));
      const palmDir = palm === 'out' ? new V(0, 0, -1).applyQuaternion(head.quaternion) : head.position.clone().sub(position).normalize();
      const fingers = new V(0, 1, 0).applyQuaternion(head.quaternion);
      fingers.addScaledVector(palmDir, -fingers.dot(palmDir)).normalize();
      await place(position, fingers, palmDir);
    } else {
      // Fingertip at a WORLD point: palm down, fingers forward (a fixed orientation), so wrist -> tip is one constant offset,
      // measured once away from the screen. One placement, so the fingertip never lingers anywhere on the way.
      const forward = new V(0, 0, -1).applyQuaternion(head.quaternion).setY(0).normalize(), down = new V(0, -1, 0);
      window.__tipOffset ??= {};
      const key = `${side}:${pose}`;
      if (!window.__tipOffset[key]) {
        await place(head.position.clone().add(new V(0.3, -0.7, -0.2)), forward, down); await frame(); await frame();
        const j = app.lastFrame.hands[side].joints;
        window.__tipOffset[key] = j['index-finger-tip'].position.clone().sub(j.wrist.position);
      }
      await place(new V().fromArray(tip).sub(window.__tipOffset[key]), forward, down);
    }
  }
  await new Promise((r) => { let k = 0; const f = () => (++k >= wait ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
}, { poses, wait });

/** Move the right index fingertip from `from` to `to` (world) in `steps` frames, a new pose every frame: never at rest. */
const sweep = (points, steps) => quest.evaluate(async ({ points, steps }) => {
  const app = window.__ce, remote = app.emulator.device.remote, head = app.emulator.head(), V = head.position.constructor;
  const forward = new V(0, 0, -1).applyQuaternion(head.quaternion).setY(0).normalize(), down = new V(0, -1, 0);
  const offset = window.__tipOffset?.['right:point'], xyz = (v) => ({ x: v.x, y: v.y, z: v.z });
  if (!offset) throw new Error('sweep: place the pointing hand once with hands() first');
  const touching = [];
  for (let k = 1; k < points.length; k++) for (let i = k === 1 ? 0 : 1; i <= steps; i++) {
    const tip = new V().fromArray(points[k - 1]).lerp(new V().fromArray(points[k]), i / steps);
    await remote.dispatch('set_transform', { device: 'hand-right', anchor: 'wrist', position: xyz(tip.sub(offset)), orientation: { fingers: xyz(forward), palm: xyz(down) } });
    await new Promise((r) => requestAnimationFrame(r));
    touching.push(app.wiring.snapshot().touching);
  }
  return touching;
}, { points, steps });

const visualState = () => sim.evaluate(() => JSON.stringify(window.ceSimDebug.visualSynth.getState()));

async function run() {
  await mkdir(SCREENS, { recursive: true });
  await phase('00-server', startServer, false);

  await phase('01-enter-ar', async () => {
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    context.setDefaultTimeout(UI_TIMEOUT);
    await context.addInitScript(() => {
      window.__ceMute = true; window.__audioAttempts = 0;
      for (const key of ['AudioContext', 'webkitAudioContext']) if (window[key]) {
        window[key] = new Proxy(window[key], { construct() { window.__audioAttempts++; throw new Error('No audio in the judge check'); } });
      }
    });
    sim = await context.newPage();
    watchPage(sim, 'sim');
    await sim.goto(`${BASE}/sim/?mute=1`, { waitUntil: 'domcontentloaded' });
    await sim.waitForFunction(() => window.ceSim?.leader() && window.ceSimDebug?.device.conn?.open);
    const port = await sim.evaluate(() => window.ceSimDebug.device.conn.hello().ports.find((p) => p.id === 'ce-visual-synth'));
    assert.equal(port?.state, 'connected', 'The sim (the paired Mac) advertises its visual synth');

    quest = await context.newPage();
    watchPage(quest, 'quest');
    await quest.goto(`${BASE}/quest/?emulate=1&camera=sim&mute=1&mic=0`, { waitUntil: 'domcontentloaded' });
    await waitQuest(() => window.__ce?.welcome && window.__ce.ws.open && window.__ce.room?.sim?.canvas);
    assert.equal(await quest.evaluate(() => window.__ce.welcome.mode), 'fixture');
    assert.equal(await quest.evaluate(() => window.__ce.hudKind), 'v2');
    assert.equal(await quest.evaluate(() => window.__ce.modes.mode), 'annotate', 'A ready companion must not choose Control on startup');
    assert.equal(await quest.evaluate(() => !!window.__ce.virtualSelection || !!window.__ce.visualSynthIntent), false, 'Startup must not choose a software instrument');
    await quest.evaluate(() => {
      window.__judge = { events: [], requests: [], ringSeen: false, toasts: [], wirePhases: [] };
      const toast = window.__ce.hud.toast.bind(window.__ce.hud);
      window.__ce.hud.toast = (text, level) => { window.__judge.toasts.push(text); return toast(text, level); };
      const types = new Set(['tags.state', 'device.card', 'agent.step', 'verify.result', 'ui.spec', 'arm.request', 'arm.result', 'wire.ready', 'wire.stopped', 'panic']);
      window.__ce.ws.tap('in', ({ type, payload }) => { if (types.has(type)) window.__judge.events.push({ type, payload }); });
      window.__ce.ws.tap('out', ({ type, payload }) => { if (type !== 'scan.frame') window.__judge.requests.push({ type, payload }); });
      const watch = () => {
        let ring = null; window.__ce.scene.traverse((o) => { if (o.name === 'setup-ring') ring = o; });
        if (ring) { let shown = true; for (let p = ring; p; p = p.parent) if (!p.visible) shown = false; if (shown) window.__judge.ringSeen = true; }
        const phase = window.__ce.wiring?.phase;
        if (phase && window.__judge.wirePhases.at(-1) !== phase) window.__judge.wirePhases.push(phase);
        requestAnimationFrame(watch);
      };
      requestAnimationFrame(watch);
    });
    await quest.locator('#btn-enter').click();
    await waitQuest(() => window.__ce.renderer.xr.isPresenting && window.__ce.cameraState === 'on');
    await waitQuest(() => window.__ce.tutorial?.snapshot().visible);
    assert.equal(await quest.evaluate(() => window.__ce.modes.mode), 'annotate', 'Entering AR preserves Annotate until the wearer chooses Control');
    assert.equal(await quest.evaluate(() => window.__judge.requests.some(r => ['target.select', 'control.setup', 'wire.request'].includes(r.type))), false, 'Entering AR must not select or set up a demo');
    const tutorialWidth = await quest.evaluate(() => window.__ce.scene.getObjectByName('tutorial-bubble-plate').size.peek()[0] * .001);
    assert(tutorialWidth <= .221, `Tutorial must fit a 22cm bubble (${tutorialWidth}m)`);
  });

  let screen;
  await phase('02-annotate-sees-the-mac', async () => {
    screen = await until('a box on the Mac screen', () => quest.evaluate((source) => {
      const app = window.__ce, re = new RegExp(source, 'i');
      if (app.modes.mode !== 'annotate') return null;
      const t = app.targets.list().find((t) => re.test(t.label) && app.visibleTargets.has(t.id));
      return t ? { id: t.id, label: t.label, position: t.position.toArray() } : null;
    }, SCREEN.source), 60_000);
    const palette = await quest.evaluate(() => {
      const p = window.__ce.hud.root.getObjectByName('wrist-palette');
      return { visible: !!p?.visible, keys: p ? p.buttons.map((b) => b.name) : [] };
    });
    assert(palette.visible, 'The wrist palette docks in view in the desktop emulator');
    for (const key of ['layer:annotate', 'layer:control', 'track:electronics', 'track:objects', 'track:everything', 'palette-more', 'deck:panic', 'exit-ar']) {
      assert(palette.keys.includes(key), `Primary wrist actions offer ${key} (has ${palette.keys})`);
    }
    assert(!palette.keys.includes('visual-synth') && !palette.keys.includes('musical-synth'), 'Software demos remain deliberate choices under More');
    assert.equal(await quest.evaluate(() => window.__ce.modes.mode), 'annotate', 'Companion presence and detection must not choose Control');
    console.log(`  box: "${screen.label}"; palette: ${palette.keys.join(' · ')}`);
  });

  let physicalCardId;
  await phase('03-pinch-tags-the-mac', async () => {
    // Stand ~1 m from the screen, as a seated wearer would.
    await quest.evaluate((c) => {
      const app = window.__ce, target = app.desktopCam.position.clone().fromArray(c), head = app.emulator.head();
      const dir = target.clone().sub(head.position).setY(0).normalize();
      const pos = target.clone().addScaledVector(dir, -0.95); pos.y = target.y + 0.4;
      app.emulator.setHead(pos, head.quaternion); app.emulator.lookAt(target);
    }, screen.position);
    await frames(20);
    const pinchedAt = Date.now();
    await click({ world: screen.position });
    await waitQuest((id) => {
      const tag = window.__ce.modes.tags.get(id);
      return !!tag?.cardId && !!tag.name && !tag.pending;
    }, screen.id);
    // Wait beyond the asynchronous identity snapshot: naming a laptop must not continue into a software demo.
    await frames(15);
    const state = await quest.evaluate((id) => {
      const app = window.__ce;
      return { mode: app.modes.mode, tag: app.modes.tags.get(id), virtualSelection: !!app.virtualSelection,
        virtualIntent: !!app.visualSynthIntent, virtualTags: [...app.modes.tags.values()].filter(t => /^(visual|musical)-synth/.test(t.cardId ?? '')),
        requests: window.__judge.requests.filter(r => ['tag.add', 'target.select', 'control.setup', 'wire.request'].includes(r.type)) };
    }, screen.id);
    assert.equal(state.mode, 'annotate', 'Pinching and identifying the Mac keeps the wearer in Annotate');
    assert(state.tag?.cardId && !/^(visual|musical)-synth/.test(state.tag.cardId), 'The pinched object remains a physical laptop tag');
    assert.equal(state.virtualSelection || state.virtualIntent, false, 'Tagging the Mac creates no implicit software-demo intent');
    assert.deepEqual(state.virtualTags, [], 'Identifying a laptop must not add a virtual instrument');
    assert.deepEqual(state.requests.map(r => r.type), ['tag.add'], 'The physical pinch only tags the object; no virtual selection, setup or wiring');
    physicalCardId = state.tag.cardId;
    const physicalTarget = await json(`/api/agent/targets/${encodeURIComponent(physicalCardId)}`);
    assert.equal(physicalTarget.armed, false, 'Identification must not arm the physical Mac');
    assert.equal((await exec(pinchedAt)).length, 0, 'No device command follows a tag-only pinch');
    deliberateSelectionProof = { physicalCardId, tag: state.tag, modeAfterIdentity: state.mode, requestsBeforeDemoChoice: state.requests,
      noImplicitVirtualSelection: true, noCommandsAfterTag: true };
    timings.pinchedAt = pinchedAt;
  });

  await phase('03a-choose-physical-control-without-setup', async () => {
    const since = Date.now();
    await click({ name: 'layer:control' });
    await waitQuest((id) => {
      const app = window.__ce;
      return app.modes.mode === 'control' && app.lockedId === id && app.hud.deviceState?.targetId === id;
    }, screen.id);
    await frames(10);
    const state = await quest.evaluate((id) => {
      const app = window.__ce, card = app.scene.getObjectByName('device-card-v3');
      let visible = !!card;
      for (let parent = card; parent; parent = parent.parent) if (!parent.visible) visible = false;
      return { mode: app.modes.mode, lockedId: app.lockedId, tag: app.modes.tags.get(id),
        deviceState: app.hud.deviceState, card: card?.userData.view, cardVisible: visible,
        virtualCard: app.virtualCards.has(app.modes.tags.get(id)?.cardId),
        requests: window.__judge.requests.filter(request => ['target.select', 'control.setup', 'wire.request'].includes(request.type)) };
    }, screen.id);
    assert.equal(state.lockedId, screen.id, 'Choosing Control selects the tagged physical object');
    assert.equal(state.tag?.cardId, physicalCardId, 'Control preserves the identity of the physical Mac');
    assert.equal(state.deviceState.connection, state.tag.connection, 'The physical card displays its current connection state');
    assert(state.cardVisible && state.card?.title && state.card.subtitle, 'The wearer sees the physical object card and connection guidance');
    assert.equal(!!state.deviceState.silentVisual || !!state.deviceState.musicalSynth || state.virtualCard, false,
      'Physical Control must not substitute a software instrument, even when its screen displays a synth');
    assert.deepEqual(state.requests, [], 'Choosing Control alone neither selects a virtual instrument nor starts setup or wiring');
    assert.equal((await exec(since)).length, 0, 'Choosing Control alone sends no device commands');
    deliberateSelectionProof.explicitPhysicalControl = { mode: state.mode, lockedId: state.lockedId,
      connection: state.tag.connection, card: state.card, noSetupOrCommands: true };
    await screenshot('03a-physical-mac-control-card');
    await click({ name: 'layer:annotate' });
    await waitQuest(() => window.__ce.modes.mode === 'annotate');
    assert.equal(await quest.evaluate(({ id, card }) => window.__ce.modes.tags.get(id)?.cardId === card, { id: screen.id, card: physicalCardId }), true,
      'Returning to Annotate retains the tagged physical object');
    assert.equal(await quest.evaluate(() => !!window.__ce.virtualSelection || !!window.__ce.visualSynthIntent), false);
    deliberateSelectionProof.returnedToAnnotateBeforeDemo = true;
  }, false);

  await phase('03b-choose-visual-demo-explicitly', async () => {
    await click({ name: 'palette-more' });
    await waitQuest(() => {
      const palette = window.__ce.hud.root.getObjectByName('wrist-palette');
      return palette?.userData.page === 'more' && palette.buttons.some(button => button.name === 'visual-synth');
    });
    timings.virtualSelectedAt = Date.now();
    await click({ name: 'visual-synth' });
    await waitQuest(() => [...window.__ce.modes.tags.values()].some(tag => tag.cardId?.startsWith('visual-synth')));
    cardId = await quest.evaluate(() => [...window.__ce.modes.tags.values()].find(tag => tag.cardId?.startsWith('visual-synth')).cardId);
    assert(await quest.evaluate(() => window.__judge.requests.some(r => r.type === 'target.select' && r.payload.virtual === 'visual-synth')),
      'The visible More → Visual synth choice explicitly selects the software instrument');
    assert.equal(await quest.evaluate(() => window.__ce.modes.mode), 'control');
    assert.equal(await quest.evaluate(({ id, card }) => window.__ce.modes.tags.get(id)?.cardId === card, { id: screen.id, card: physicalCardId }), true,
      'Choosing the optional software demo preserves the separately tagged physical Mac');
    assert.equal(await quest.evaluate(id => window.__judge.requests.some(r => r.type === 'control.setup' && r.payload.cardId === id), physicalCardId), false,
      'The demo choice must not silently set up the physical laptop');
    deliberateSelectionProof.explicitDemoChoice = 'More → Visual synth';
    deliberateSelectionProof.virtualCardId = cardId;
    deliberateSelectionProof.physicalTagPreserved = true;
  });

  await phase('04-setup-ring', async () => {
    await until('Muse setup steps for the visual synth', () => quest.evaluate((id) =>
      window.__judge.events.filter((e) => e.type === 'agent.step' && e.payload.cardId === id).length >= 3, cardId), PIPELINE_TIMEOUT);
  }, false);

  let verifiedBy;
  await phase('05-ready-to-ask', async () => {
    await until('controls armed (CE_DEMO=1 arms a verified, silent target itself)', async () => (await target()).armed, PIPELINE_TIMEOUT);
    await waitQuest((id) => window.__ce.modes.byCard(id)?.connection === 'ready', cardId);
    await waitQuest(() => {
      let shown=0;
      window.__ce.scene.traverse(o=>{
        if(!/^dial-(left|right)$/.test(o.name))return;
        for(let p=o;p;p=p.parent)if(!p.visible)return;
        shown++;
      });
      return shown===0;
    });
    timings.virtualSelectionToArmed = +((Date.now() - timings.virtualSelectedAt) / 1000).toFixed(1);
    const results = await quest.evaluate((id) => window.__judge.events.filter((e) => e.type === 'verify.result' && e.payload.cardId === id).map((e) => e.payload), cardId);
    assert(results.some((r) => r.pass), 'At least one action passed verification');
    const notes = results.filter((r) => r.pass).map((r) => r.observed?.note ?? r.observed?.sense ?? '').join(' | ');
    // Honest label: the camera only when it saw the change; else the Mac renderer's own report; else a bare ack.
    verifiedBy = /verified by renderer/i.test(notes) ? 'renderer report' : results.some((r) => r.pass && r.observed?.sense === 'camera') ? 'camera' : 'acknowledgement';
    assert(await quest.evaluate(() => window.__judge.ringSeen), 'The setup ring showed progress on the screen');
    assert.equal(await quest.evaluate(() => !!window.__ce.pendingArm), false, 'CE_DEMO=1 needs no Enable tap');
    console.log(`  explicit visual choice → armed ${timings.virtualSelectionToArmed}s; verified by: ${verifiedBy}; evidence: ${notes.slice(0, 160)}`);
    // Show the real hand workflow, with the wrist lowered once the device is selected.
    await hands({ left: {offset:[-.25,-.7,-.15],pose:'default'}, right: {offset:[.2,-.7,-.15],pose:'default'} },40);
  });

  await phase('06-no-manual-bypass-before-muse', async () => {
    const since = Date.now(), before = await visualState();
    assert.equal(await quest.evaluate(() => {
      const rig=window.__ce.hud.root.getObjectByName('spatial-controls');
      return !rig||!rig.visible;
    }),true,'The default ready screen has no parameter handles or ring');
    await click({world:screen.position});
    assert.equal((await exec(since)).length, 0, 'A setup driver alone must not allow interaction before the wearer asks Muse');
    assert.equal(await visualState(), before, 'Pinching the selected screen is not a prewired interaction');
    assert.equal(await quest.evaluate(() => window.__judge.requests.some(r=>r.type==='wire.request')),false);
  });

  await phase('07-hands-do-nothing-until-muse-wires-it', async () => {
    // Armed and selected, but nothing is wired: raising and moving the right hand changes nothing on the Mac.
    const since = Date.now(), left = { offset: [-0.25, -0.7, -0.15], pose: 'default' };
    for (let i = 0; i < 10; i++) await hands({ left, right: { offset: [0.2, -0.3 + i * 0.02, -0.4 - i * 0.01], pose: 'open' } }, 3);
    await frames(10);
    assert.equal(await quest.evaluate(() => !!window.__ce['handMapping']), false, 'No hand-written mapping starts by itself');
    assert.equal(await quest.evaluate(() => window.__ce.wiring.phase), 'idle');
    assert.equal((await exec(since)).length, 0, 'Hands alone send nothing to the Mac');
    const ask = await quest.evaluate(() => window.__ce.hud.root.userData.wire);
    assert.equal(ask.prompt, 'What should your hands do?');
    // The visual synth's chips (WIRE_CHIPS + VISUAL_SCENE_CHIP in apps/quest/src/wiring/controller.ts).
    const visualChips = ['Touch the water', 'Give me knobs for the visuals', 'Hands as knobs', 'Show the ripples as a 3D field'];
    assert.deepEqual(ask.chips, visualChips);
    await hands({ left, right: { offset: [0.2, -0.7, -0.15], pose: 'default' } });
    const invitation=await quest.evaluate(()=>window.__ce.scene.getObjectByName('device-card-v3').userData.view);
    assert.equal(invitation.presentation,'invitation');
    assert.equal(invitation.ask.mic,'off','This run exercises the silent fallback');
    assert.deepEqual(invitation.ask.chips.map(c=>c.label),['Touch the water']);
    const requests=await quest.evaluate(()=>window.__judge.requests.filter(r=>r.type==='wire.request').length);
    await clickUntil({name:'wire-more-ideas'}, cardIs, 'ideas');
    assert.equal(await quest.evaluate(()=>window.__ce.scene.getObjectByName('device-card-v3').userData.view.ask.chips.length),visualChips.length);
    await clickUntil({name:'wire-back'}, cardIs, 'invitation');
    assert.equal(await quest.evaluate(()=>window.__judge.requests.filter(r=>r.type==='wire.request').length),requests,'Ideas and Back never ask or run anything');
  });

  let geometry;
  await phase('08-ask-muse-no-setup', async () => {
    // The wearer taps the "Touch the water" chip; Muse (fixture here) writes the wiring and the code card shows it.
    await pressChip('Touch the water');
    await waitQuest(() => window.__judge.requests.some((r) => r.type === 'wire.request'));
    const request = await quest.evaluate(() => window.__judge.requests.find((r) => r.type === 'wire.request').payload);
    assert.equal(typeof request.requestId, 'string', 'Every new ask has a client epoch');
    assert.deepEqual(request, { cardId: request.cardId, text: 'Touch the water', source: 'chip', requestId: request.requestId });
    await until('Muse wrote the wiring and it runs at once, with no setup step', () => quest.evaluate(() => window.__ce.wiring.phase === 'running'), PIPELINE_TIMEOUT);
    const card = await quest.evaluate(() => window.__ce.hud.root.userData.wire.card);
    assert(/Touch the water/.test(card.header) && card.badge === 'FIXTURE', `the code card names the request and its source (${card.header} / ${card.badge})`);
    const ready = await quest.evaluate(() => window.__judge.events.findLast(e => e.type === 'wire.ready').payload);
    assert(ready.needs.includes('screen'), 'The touch program reads the screen');
    const harness = await json('/api/agent/harness');
    assert.equal(harness.backend, 'muse-bridge');
    harnessProof = harness.runs.find(run => run.runId === ready.wiringId);
    assert(harnessProof, 'The actual request must reach the Mac agent harness');
    assert.equal(harnessProof.outcome, 'checked'); assert.equal(harnessProof.source, 'fixture');
    assert.equal(harnessProof.currentlyAuthorized, true);
    for (const name of ['inspect_selected_device', 'inspect_gesture_signals', 'check_program', 'finish_program']) {
      assert(harnessProof.tools.some(tool => tool.name === name && tool.ok), `Missing successful actual tool: ${name}`);
    }
    assert(harnessProof.artifact.hash && harnessProof.artifact.dryRunFrames > 0);
    await writeFile(join(SCREENS, 'harness-receipt.json'), JSON.stringify(harnessProof, null, 2));
    await frames(4);
    // No setup step: never 'calibrating'; the plane is guessed from the tagged Mac and the wearer is told to touch the water.
    const seen = await quest.evaluate(() => ({ phases: window.__judge.wirePhases, toasts: window.__judge.toasts, snap: window.__ce.wiring.snapshot(),
      next: window.__ce.hud.root.getObjectByName('wrist-palette').dashboardView().next,
      copy: JSON.stringify([window.__ce.hud.root.userData.wire, window.__ce.scene.getObjectByName('device-card-v3')?.userData.view, window.__judge.toasts]) }));
    assert(!seen.phases.includes('calibrating'), `No calibration phase in the default path (${seen.phases})`);
    assert.equal(seen.snap.screen, 'guessed', 'The screen plane is guessed from the tagged Mac, waiting for the first touch');
    assert(seen.toasts.includes('Touch the water on your screen'), `The wearer is told what to do (${seen.toasts.slice(-4)})`);
    assert.equal(seen.next, 'Touch the water on your screen.', 'The wrist dashboard says the next step');
    assert(!/corner|calibrat/i.test(JSON.stringify(JSON.parse(seen.copy), (k, v) => typeof v === 'object' && v && !Array.isArray(v) ? Object.values(v) : v)), 'No corners or calibration in what the wearer sees');
    await screenshot('08-code-card');
    // The sim laptop's live screen, as it lies on the emulator's room (the "glass" a real fingertip would stop on).
    geometry = await quest.evaluate(() => {
      const app = window.__ce, room = app.room, V = app.desktopCam.position.constructor;
      const meta = document.querySelector('iframe[src*="embed=room"]').contentWindow.ceSimDebug.room.meta;
      const quad = meta.views[room.sim.view].screens['laptop-screen'];
      const [bl, br, tr, tl] = quad.map(([x, y]) => room.imageToWorld(x * room.imageWidth / meta.width, y * room.imageHeight / meta.height));
      const mid = new V().add(bl).add(br).add(tr).add(tl).multiplyScalar(0.25);
      const right = br.clone().sub(bl).normalize(), down = bl.clone().sub(tl).normalize(), toward = new V(0, 0, 1).applyQuaternion(room.quaternion);
      // Where the guessed plane's centre is seen (its line of sight onto the room) and how far its depth is off.
      const plane = app.wiring.snapshot().plane, head = app.emulator.head().position;
      const c = new V(...plane.origin).addScaledVector(new V(...plane.right), plane.width / 2).addScaledVector(new V(...plane.down), plane.height / 2);
      const hit = room.raycast({ origin: head.clone(), dir: c.clone().sub(head).normalize() });
      return { mid: mid.toArray(), right: right.toArray(), down: down.toArray(), toward: toward.toArray(), width: br.distanceTo(bl), height: bl.distanceTo(tl),
        guess: { width: plane.width, height: plane.height, sightError: hit ? hit.point.distanceTo(mid) : null, depthError: hit ? hit.point.distanceTo(head) - c.distanceTo(head) : null } };
    });
    console.log(`  sim laptop screen ${geometry.width.toFixed(2)} x ${geometry.height.toFixed(2)} m; guessed plane ${geometry.guess.width.toFixed(2)} x ${geometry.guess.height.toFixed(2)} m, its centre seen ${(geometry.guess.sightError * 100).toFixed(1)} cm from the screen's centre, depth off by ${(geometry.guess.depthError * 100).toFixed(1)} cm`);
  });

  await phase('09-touch-the-water', async () => {
    const pt = (a, d = 0) => a.map((n, i) => n + geometry.toward[i] * d), left = { offset: [-0.25, -0.7, -0.15], pose: 'default' };
    const along = (a, k, du, dv = 0) => a.map((n, i) => n + geometry.right[i] * du + geometry.down[i] * dv);
    // The hand comes in from below and the side (a hand already resting somewhere is not a touch).
    await hands({ left, right: { tip: pt(along(geometry.mid, 0, -0.3, 0.3), 0.2), pose: 'point' } }, 8);
    // Waving through the air ~10 cm in front of the screen, before it is found: not a touch.
    let since = Date.now();
    const wave = await sweep([pt(along(geometry.mid, 0, -0.12), 0.1), pt(along(geometry.mid, 0, 0.12), 0.1), pt(along(geometry.mid, 0, -0.12, 0.05), 0.1), pt(along(geometry.mid, 0, 0.1, 0.3), 0.3)], 12);
    assert(!wave.some(Boolean), 'Waving is never a touch');
    let snap = await quest.evaluate(() => window.__ce.wiring.snapshot());
    assert.equal(snap.screen, 'guessed', 'A finger moving through the air does not find the screen');
    assert.equal(snap.touching, false);
    assert.deepEqual((await exec(since)).filter((e) => [22, 23, 24].includes(e.op?.number)), [], 'No touch reaches the Mac before the screen is found');
    // The first rest on the sim laptop's screen finds the screen and counts as a touch.
    since = Date.now();
    const before = await visualState();
    await hands({ left, right: { tip: pt(geometry.mid, 0), pose: 'point' } }, 30);
    await until('the first touch found the screen', () => quest.evaluate(() => window.__ce.wiring.snapshot().screen === 'found'), 10_000);
    snap = await quest.evaluate(() => window.__ce.wiring.snapshot());
    const first = await until('the first touch splashed (touch CCs 22-24)', async () => (await exec(since)).filter((e) => [22, 23, 24].includes(e.op?.number)), 10_000);
    console.log(`  first touch found the screen: plane ${snap.plane.width.toFixed(2)} x ${snap.plane.height.toFixed(2)} m; ${first.length} touch ops on that touch`);
    await screenshot('09a-screen-found');
    await sim.waitForFunction((s) => JSON.stringify(window.ceSimDebug.visualSynth.getState()) !== s, before);
    // The following touches move the water: hover, touch, drag right.
    since = Date.now();
    await hands({ left, right: { tip: pt(geometry.mid, 0.06), pose: 'point' } }, 20);
    await hands({ left, right: { tip: pt(geometry.mid, 0.003), pose: 'point' } }, 25);
    const step = Math.min(0.02, geometry.guess.width * 0.4 / 8);
    for (let i = 1; i <= 8; i++) await hands({ left, right: { tip: pt(along(geometry.mid, 0, i * step), 0.003), pose: 'point' } }, 3);
    const touch = await until('X, Y and pressure acknowledged by the sim Mac (touch CCs 22-24)', async () => {
      const ops = (await exec(since)).filter((e) => [22, 23, 24].includes(e.op?.number) && e.ack?.ok);
      return new Set(ops.map((e) => e.op.number)).size === 3 ? ops : null;
    }, 10_000);
    const ccs = [...new Set(touch.map((e) => e.op.number))].sort();
    console.log(`  ${touch.length} touch ops acknowledged by the sim Mac (CC ${ccs.join('/')})`);
    // Only the left (menu) hand opens the wrist menu now; the right finger on the screen leaves it shut without blocking it.
    const menuOpen = await quest.evaluate(() => !!window.__ce.hud.root.getObjectByName('wrist-palette')?.anchor.open);
    assert.equal(menuOpen, false, 'The wrist menu stays shut while the finger works the screen');
    await waitQuest(()=>window.__ce.scene.getObjectByName('device-card-v3').userData.view.presentation==='cue');
    const cue=await quest.evaluate(()=>window.__ce.scene.getObjectByName('device-card-v3').userData.view);
    assert.equal(cue.ask,null); assert.deepEqual(cue.actions,[]);
    assert(cue.subtitle.length>0,'Quiet play retains Muse’s generated gesture instructions');
  });

  await phase('10-both-palms-stop', async () => {
    await hands({ left: { offset: [-0.22, -0.05, -0.45], pose: 'open', palm: 'out' }, right: { offset: [0.22, -0.05, -0.45], pose: 'open', palm: 'out' } });
    await until('the current wiring stopped', () => quest.evaluate(() => !window.__ce.wiring.running && window.__ce.wiring.phase === 'stopped'), 5000);
    await waitQuest(() => window.__judge.events.some(r => r.type === 'wire.stopped' && r.payload.ok && r.payload.releaseConfirmed));
    assert.equal((await target()).armed, true, 'Palms Stop keeps the verified device ready for a new ask');
    assert.equal(await quest.evaluate(() => window.__ce.canControl(window.__ce.modes.tags.get(window.__ce.lockedId)?.cardId)), true);
    await sim.waitForFunction(() => window.ceSimDebug.visualSynth.getState().touchPressure === 0);
    assert(await quest.evaluate(() => window.__judge.requests.some(r => r.type === 'wire.stop')), 'Palms Stop must revoke this request');
    assert.equal(await quest.evaluate(() => window.__judge.requests.some(r => r.type === 'panic')), false, 'Palms Stop is distinct from Stop all');
    for (const page of [sim, quest]) for (const frame of page.frames()) {
      assert.equal(await frame.evaluate(() => window.__audioAttempts ?? 0), 0, 'No page may construct an audio graph');
    }
  });
  await phase('10a-ask-again-without-setup', async () => {
    const before = await target();
    const old = await quest.evaluate(() => window.__judge.events.findLast(r => r.type === 'wire.ready').payload);
    await hands({ left: { offset: [-.25,-.7,-.15], pose: 'default' }, right: { offset: [.2,-.7,-.15], pose: 'default' } }, 10);
    await clickUntil({name:'wire-more-ideas'}, cardIs, 'ideas');
    await pressChip('Hands as knobs');
    await until('new requested wiring runs', () => quest.evaluate(() => window.__ce.wiring.running), PIPELINE_TIMEOUT);
    const next = await quest.evaluate(() => window.__judge.events.findLast(r => r.type === 'wire.ready').payload);
    assert.notEqual(next.wiringId, old.wiringId); assert.notEqual(next.requestId, old.requestId);
    const after = await target();
    assert.equal(after.runId, before.runId, 'Another interaction must not require setup again');
    assert.equal(after.driver.driverId, before.driver.driverId, 'The checked driver is preserved');
    assert.equal(after.armed, true);
  });
  await phase('10b-wrist-stop-all', async () => {
    await hands({ left: { offset: [-.18,-.12,-.32], pose: 'open', palm: 'toward' }, right: { offset: [.3,-.7,-.2], pose: 'default' } }, 50);
    await waitQuest(() => { const p=window.__ce.hud.root.getObjectByName('wrist-palette'); return p?.visible && p.anchor.open; });
    await click({ name: 'deck:panic' });
    await until('Stop all disarms the server', async () => !(await target()).armed);
    await waitQuest(() => !window.__ce.wiring.running);
    assert(await quest.evaluate(() => window.__judge.requests.some(r => r.type === 'panic')));
  });
  await phase('11-tutorial-menu-replay-and-skip', async () => {
    await hands({ left: { offset: [-.25,-.7,-.15], pose: 'default' }, right: { offset: [.3,-.7,-.2], pose: 'default' } }, 12);
    await hands({ left: { offset: [-.18, -.12, -.32], pose: 'open', palm: 'toward' }, right: { offset: [.3, -.7, -.2], pose: 'default' } }, 50);
    await waitQuest(() => { const p=window.__ce.hud.root.getObjectByName('wrist-palette'); return p?.visible && p.anchor.open; });
    await click({name:'palette-more'});
    await click({ name: 'tutorial' });
    await waitQuest(() => window.__ce.tutorial?.snapshot().visible);
    await screenshot('11a-tutorial-replayed');
    await click({ name: 'tutorial-skip' });
    await waitQuest(() => window.__ce.tutorial?.snapshot().finished);
    assert.equal(await quest.evaluate(() => localStorage.getItem('ce.tutorial.wire.v1')), 'skipped');
  });
  assert.equal((await json(`/api/agent/harness/runs/${harnessProof.runId}`)).currentlyAuthorized, false, 'Stop all revokes harness-created wiring');
  await writeFile(join(SCREENS, 'summary.json'), JSON.stringify({ fixture: true, demo: true, verifiedBy, timings, deliberateSelection: deliberateSelectionProof, harness: harnessProof }, null, 2));
}

async function diagnostics() {
  await mkdir(SCREENS, { recursive: true });
  await writeFile(join(SCREENS, 'server.log'), serverLog);
  await writeFile(join(SCREENS, 'browser.log'), browserLog.join('\n'));
  const state = {};
  if (quest && !quest.isClosed()) {
    state.quest = await quest.evaluate(() => ({
      mode: window.__ce?.modes.mode, tags: window.__ce?.modes.tags && [...window.__ce.modes.tags.values()],
      targets: window.__ce?.targets.list().map((t) => ({ id: t.id, label: t.label })), judge: window.__judge,
    })).catch((e) => ({ error: e.message }));
    await quest.screenshot({ path: join(SCREENS, `${currentPhase}-FAIL.png`), timeout: 5000 }).catch(() => {});
  }
  if (cardId) state.target = await target().catch((e) => ({ error: e.message }));
  await writeFile(join(SCREENS, 'failure.json'), JSON.stringify(state, null, 2));
}

async function cleanup() {
  if (server?.pid && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise((done) => server.once('exit', done));
    server.kill('SIGTERM');
    const force = setTimeout(() => server.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(force); }
  }
  try { await browser?.close(); } finally { if (dataDir) await rm(dataDir, { recursive: true, force: true }); }
}

const interrupted = new Promise((_, reject) => abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true }));
const stop = (signal) => { process.exitCode = signal === 'SIGINT' ? 130 : 143; abort.abort(new Error(`Interrupted by ${signal}`)); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
const deadline = setTimeout(() => abort.abort(new Error('Judge path exceeded 6 minutes')), 6 * 60_000);
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
