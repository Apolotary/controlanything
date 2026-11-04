/**
 * The judge path, automated: npm run build && npm run e2e:judge (system Chrome; no browser download).
 *
 *   Enter AR → pinch the MacBook's box → setup ring → armed arc dials → drag Warp → hands do nothing until Muse
 *   writes the wiring: "Touch the water" chip → code card → calibrate the screen → touch the water → both palms out = stop.
 *
 * Runs its own muted FIXTURE server (CE_DEMO=1, CE_MAC_SILENT=1, fresh data dir) on PORT (default 8796,
 * HTTPS off), the sim room as the paired Mac (its laptop screen runs the visual synth) and the desktop Quest
 * emulator with camera=sim. Never reuses an existing server. Screenshots/diagnostics: research/screens/judge/.
 * Boxes come only from SAM 3.1 (here the server's SAM fixtures; there is no on-device detector), so this does not measure
 * detector accuracy, headset frame rate or the real Mac display.
 * Optional: CE_QUEST_DIST / CE_SIM_DIST / CE_COMPANION_DIST point the server at scratch builds.
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
const SCREENS = join(ROOT, 'research/screens/judge');
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

/** Point on an arc dial at `frac` of its sweep. */
const arcPoint = (side, frac) => quest.evaluate(({ side, frac }) => {
  const app = window.__ce; let dial;
  app.scene.traverse((o) => { if (o.name === `dial-${side}`) dial = o; });
  const sweep = Math.atan2(Math.sin(dial.to - dial.from), Math.cos(dial.to - dial.from));
  const a = dial.from + sweep * frac;
  const world = dial.localToWorld(app.desktopCam.position.clone().set(dial.center.x + dial.radius * Math.cos(a), dial.radius * Math.sin(a), 0.002));
  const p = world.project(app.renderer.xr.getCamera().cameras[0]);
  const r = app.renderer.domElement.getBoundingClientRect();
  return { x: r.left + (p.x + 1) * r.width / 2, y: r.top + (1 - p.y) * r.height / 2 };
}, { side, frac });

async function dragArc(side, from, to) {
  const start = await arcPoint(side, from);
  await quest.mouse.move(start.x, start.y); await frames(4); await quest.mouse.down(); await frames(4);
  for (let i = 1; i <= 15; i++) { const p = await arcPoint(side, from + (to - from) * i / 15); await quest.mouse.move(p.x, p.y); await frames(2); }
  await quest.mouse.up(); await frames(8);
}

/** Press the visible chip through the production pointing/click path. No synthetic button events. */
async function pressChip(label) {
  await click({ name: `wire-chip:${label}` });
  await waitQuest(() => !['idle', 'stopped', 'failed'].includes(window.__ce.wiring.phase));
}

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
    await quest.evaluate(() => {
      window.__judge = { events: [], requests: [], ringSeen: false };
      const types = new Set(['tags.state', 'device.card', 'agent.step', 'verify.result', 'ui.spec', 'arm.request', 'arm.result', 'panic']);
      window.__ce.ws.tap('in', ({ type, payload }) => { if (types.has(type)) window.__judge.events.push({ type, payload }); });
      window.__ce.ws.tap('out', ({ type, payload }) => { if (type !== 'scan.frame') window.__judge.requests.push({ type, payload }); });
      const watch = () => {
        let ring = null; window.__ce.scene.traverse((o) => { if (o.name === 'setup-ring') ring = o; });
        if (ring) { let shown = true; for (let p = ring; p; p = p.parent) if (!p.visible) shown = false; if (shown) window.__judge.ringSeen = true; }
        requestAnimationFrame(watch);
      };
      requestAnimationFrame(watch);
    });
    await quest.locator('#btn-enter').click();
    await waitQuest(() => window.__ce.renderer.xr.isPresenting && window.__ce.cameraState === 'on');
    await waitQuest(() => window.__ce.tutorial?.snapshot().visible);
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
    for (const key of ['visual-synth', 'deck:panic', 'exit-ar']) assert(palette.keys.includes(key), `Palette offers ${key} (has ${palette.keys})`);
    console.log(`  box: "${screen.label}"; palette: ${palette.keys.join(' · ')}`);
  });

  await phase('03-pinch-the-mac', async () => {
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
    await waitQuest(() => [...window.__ce.modes.tags.values()].some((t) => t.cardId?.startsWith('visual-synth')));
    cardId = await quest.evaluate(() => [...window.__ce.modes.tags.values()].find((t) => t.cardId?.startsWith('visual-synth')).cardId);
    assert(await quest.evaluate(() => window.__judge.requests.some((r) => r.type === 'target.select' && r.payload.virtual === 'visual-synth')),
      'Pinching the Mac screen selects its visual synth');
    timings.pinchedAt = pinchedAt;
  });

  await phase('04-setup-ring', async () => {
    await until('Muse setup steps for the visual synth', () => quest.evaluate((id) =>
      window.__judge.events.filter((e) => e.type === 'agent.step' && e.payload.cardId === id).length >= 3, cardId), PIPELINE_TIMEOUT);
  }, false);

  let verifiedBy;
  await phase('05-armed-dials', async () => {
    await until('controls armed (CE_DEMO=1 arms a verified, silent target itself)', async () => (await target()).armed, PIPELINE_TIMEOUT);
    await waitQuest((id) => window.__ce.modes.byCard(id)?.connection === 'ready', cardId);
    await waitQuest(() => { let n = 0; window.__ce.scene.traverse((o) => { if (/^dial-(left|right)$/.test(o.name)) { let v = true; for (let p = o; p; p = p.parent) if (!p.visible) v = false; if (v) n++; } }); return n === 2; });
    timings.pinchToArmed = +((Date.now() - timings.pinchedAt) / 1000).toFixed(1);
    const results = await quest.evaluate((id) => window.__judge.events.filter((e) => e.type === 'verify.result' && e.payload.cardId === id).map((e) => e.payload), cardId);
    assert(results.some((r) => r.pass), 'At least one action passed verification');
    const notes = results.filter((r) => r.pass).map((r) => r.observed?.note ?? r.observed?.sense ?? '').join(' | ');
    // Honest label: the camera only when it saw the change; else the Mac renderer's own report; else a bare ack.
    verifiedBy = /verified by renderer/i.test(notes) ? 'renderer report' : results.some((r) => r.pass && r.observed?.sense === 'camera') ? 'camera' : 'acknowledgement';
    assert(await quest.evaluate(() => window.__judge.ringSeen), 'The setup ring showed progress on the screen');
    assert.equal(await quest.evaluate(() => !!window.__ce.pendingArm), false, 'CE_DEMO=1 needs no Enable tap');
    console.log(`  pinch → armed ${timings.pinchToArmed}s; verified by: ${verifiedBy}; evidence: ${notes.slice(0, 160)}`);
  });

  await phase('06-no-manual-bypass-before-muse', async () => {
    const since = Date.now(), before = await visualState();
    assert.equal(await quest.evaluate(() => window.__ce.hud.root.getObjectByName('spatial-controls')?.userData.mode), 'waiting');
    await dragArc('left', 0.1, 0.95);
    assert.equal((await exec(since)).length, 0, 'A setup driver alone must not allow interaction before the wearer asks Muse');
    assert.equal(await visualState(), before, 'Pre-request dials are displays, not prewired controls');
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
    assert.deepEqual(ask.chips, ['Touch the water', 'Hands as knobs', 'Surprise me']);
    await hands({ left, right: { offset: [0.2, -0.7, -0.15], pose: 'default' } });
  });

  let geometry;
  await phase('08-ask-muse-then-calibrate', async () => {
    // The wearer taps the "Touch the water" chip; Muse (fixture here) writes the wiring and the code card shows it.
    await pressChip('Touch the water');
    await waitQuest(() => window.__judge.requests.some((r) => r.type === 'wire.request'));
    const request = await quest.evaluate(() => window.__judge.requests.find((r) => r.type === 'wire.request').payload);
    assert.deepEqual(request, { cardId: request.cardId, text: 'Touch the water', source: 'chip' });
    await until('Muse wrote the wiring and it needs the screen calibrated', () => quest.evaluate(() => window.__ce.wiring.phase === 'calibrating'), PIPELINE_TIMEOUT);
    const card = await quest.evaluate(() => window.__ce.hud.root.userData.wire.card);
    assert(/Touch the water/.test(card.header) && card.badge === 'FIXTURE', `the code card names the request and its source (${card.header} / ${card.badge})`);
    await screenshot('08-code-card');
    geometry = await quest.evaluate((c) => {
      const app = window.__ce, p = app.desktopCam.position.clone().fromArray(c), head = app.emulator.head();
      const f = p.clone().sub(head.position).setY(0).normalize(), right = f.clone().cross(head.position.clone().set(0, 1, 0));
      const at = (u, v) => p.clone().addScaledVector(right, (u - 0.5) * 0.5).add(head.position.clone().set(0, 0.16 - v * 0.3, 0));
      return { tl: at(0, 0).toArray(), br: at(1, 1).toArray(), mid: at(0.5, 0.5).toArray(), toward: f.clone().negate().toArray(), right: right.toArray() };
    }, screen.position);
    const pt = (a, d = 0) => a.map((n, i) => n + geometry.toward[i] * d);
    const left = { offset: [-0.25, -0.7, -0.15], pose: 'default' };
    await hands({ left, right: { tip: pt(geometry.mid.map((n, k) => n - geometry.right[k] * 0.3 + (k === 1 ? -0.3 : 0)), 0.2), pose: 'point' } }, 8);
    await hands({ left, right: { tip: pt(geometry.tl), pose: 'point' } }, 40);
    await until('top-left corner taken', () => quest.evaluate(() => window.__ce.wiring.calibrator.step === 'bottom-right'), 10_000);
    await hands({ left, right: { tip: pt(geometry.br), pose: 'point' } }, 40);
    await until('the wiring runs', () => quest.evaluate(() => window.__ce.wiring.phase === 'running'), 10_000);
  });

  await phase('09-touch-the-water', async () => {
    const pt = (a, d = 0) => a.map((n, i) => n + geometry.toward[i] * d), left = { offset: [-0.25, -0.7, -0.15], pose: 'default' };
    const since = Date.now(), before = await visualState();
    await hands({ left, right: { tip: pt(geometry.mid, 0.06), pose: 'point' } }, 20);
    await hands({ left, right: { tip: pt(geometry.mid, 0.003), pose: 'point' } }, 25);
    for (let i = 1; i <= 8; i++) await hands({ left, right: { tip: pt(geometry.mid.map((n, k) => n + geometry.right[k] * i * 0.02), 0.003), pose: 'point' } }, 3);
    const touch = await until('the fingertip reached the driver (touch CCs 22-24)', async () => (await exec(since)).filter((e) => [22, 23, 24].includes(e.op?.number)), 10_000);
    await sim.waitForFunction((s) => JSON.stringify(window.ceSimDebug.visualSynth.getState()) !== s, before);
    console.log(`  ${touch.length} touch ops reached the sim Mac (CC ${[...new Set(touch.map((e) => e.op.number))].join('/')})`);
    const busy = await quest.evaluate(() => { const p = window.__ce.hud.root.getObjectByName('wrist-palette'); return p?.anchor.blockOpen; });
    assert.equal(busy, true, 'The wrist menu stays shut while the finger works the screen');
  });

  await phase('10-both-palms-stop', async () => {
    await hands({ left: { offset: [-0.22, -0.05, -0.45], pose: 'open', palm: 'out' }, right: { offset: [0.22, -0.05, -0.45], pose: 'open', palm: 'out' } });
    await until('the wiring stopped', () => quest.evaluate(() => !window.__ce.wiring.running && ['idle', 'stopped'].includes(window.__ce.wiring.phase)), 5000);
    await until('server disarmed after palms Stop', async () => !(await target()).armed);
    await sim.waitForFunction(() => window.ceSimDebug.visualSynth.getState().touchPressure === 0);
    assert(await quest.evaluate(() => window.__judge.requests.some(r => r.type === 'panic')), 'Palms Stop must revoke server wiring authority');
    for (const page of [sim, quest]) for (const frame of page.frames()) {
      assert.equal(await frame.evaluate(() => window.__audioAttempts ?? 0), 0, 'No page may construct an audio graph');
    }
  });
  await phase('11-tutorial-menu-replay-and-skip', async () => {
    await hands({ left: { offset: [-.18, -.12, -.32], pose: 'open', palm: 'toward' }, right: { offset: [.3, -.7, -.2], pose: 'default' } }, 50);
    await waitQuest(() => { const p=window.__ce.hud.root.getObjectByName('wrist-palette'); return p?.visible && p.anchor.open; });
    await click({ name: 'tutorial' });
    await waitQuest(() => window.__ce.tutorial?.snapshot().visible);
    await screenshot('11a-tutorial-replayed');
    await click({ name: 'tutorial-skip' });
    await waitQuest(() => window.__ce.tutorial?.snapshot().finished);
    assert.equal(await quest.evaluate(() => localStorage.getItem('ce.tutorial.wire.v1')), 'skipped');
  });
  await writeFile(join(SCREENS, 'summary.json'), JSON.stringify({ fixture: true, demo: true, verifiedBy, timings }, null, 2));
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
