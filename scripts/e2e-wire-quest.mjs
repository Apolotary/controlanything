/**
 * "Muse writes the glue", headset half, in the Quest emulator (system Chrome; nothing is sent to a Meta model):
 *
 *   Mac armed -> the card asks "What should your hands do?" (hands do nothing yet) -> a chip -> wire.request ->
 *   the code card types the program -> validating / dry-run / ready -> calibrate the screen (two corners) ->
 *   the program runs in the sandbox -> a fingertip on the screen sends cc22/cc23/cc24 -> both palms out stops it.
 *
 * Until the real WIRE step is on the server (wire.progress / wire.ready), a stand-in inside the page plays the server's
 * part: it watches the outgoing wire.request and answers with a recorded "Touch the water" program (labelled FIXTURE).
 * Set WIRE_LIVE=1 to skip the stand-in and let the server answer.
 *
 * Runs its own muted fixture server on PORT (default 8797). Screenshots: research/screens/wire-quest/.
 *   /Volumes/macbook_ext/Developer/muse_hack2/research/e2e-lock.sh env PORT=8797 node scripts/e2e-wire-quest.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCREENS = join(ROOT, 'research/screens/wire-quest');
const PORT = Number(process.env.PORT || 8797);
const BASE = `http://127.0.0.1:${PORT}`;
const LIVE = process.env.WIRE_LIVE === '1';
const UI_TIMEOUT = 30_000;
const PIPELINE_TIMEOUT = 120_000;
const SCREEN = /visual[\s-]?synth|laptop|macbook|computer|monitor|screen|display/i;
let server, browser, quest, sim, dataDir, cardId;
let serverLog = '';
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
    if (server && (server.exitCode !== null || server.signalCode !== null)) throw new Error(`Fixture server exited (${server.exitCode ?? server.signalCode})`);
    const result = await probe();
    if (result) return result;
    await delay(150, undefined, { signal: abort.signal });
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
    await access(join(dist, 'index.html')).catch(() => { throw new Error(`${app} is not built (${dist}). Run npm run build first, or set ${env}.`); });
  }
  await portMustBeFree(PORT);
  dataDir = await mkdtemp(join(tmpdir(), 'ce-e2e-wire-'));
  server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: join(ROOT, 'apps/server'), stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, HTTP_PORT: String(PORT), HTTPS_PORT: '0', HTTP_HOST: '127.0.0.1', PUBLIC_HOST: '127.0.0.1',
      CE_DATA_DIR: dataDir, MODEL_MODE: 'fixture', MODEL_API_KEY: '', CE_SCAN_PROMPTS: '',
      CE_DEMO: '1', CE_MAC_SILENT: '1', CE_MAC_LOCAL: '0', CE_OSMO: '', CE_REMO: '0', REMO_HOST: '', REMO_SEND: '0',
      CE_TRUST_FIRST_DEVICE: '1', CE_TRUST_LOOPBACK: '1', CE_CONSOLE_APPROVE: '0',
      MUSE_REPLAY: '1', MUSE_RECORD: '0', MUSE_RECORD_DIR: '', FIXTURE_DELAY_MS: '300', GEN3D_REPLAY_SPEED: '0', GEN3D_SKIN: '0', VITEST: '',
    },
  });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', (chunk) => { serverLog = (serverLog + chunk).slice(-250_000); });
  await until('fixture server startup', () => serverLog.includes('ControlAnything server '));
  await until('health', () => json('/api/health').catch(() => null));
}
function watchPage(page, name) {
  const log = (text) => { browserLog.push(`${name}: ${text}`); if (browserLog.length > 300) browserLog.shift(); };
  page.on('pageerror', (error) => log(error.stack ?? error.message));
  page.on('console', (message) => { if (message.type() === 'error' || /wir/i.test(message.text())) log(message.text()); });
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
  const started = Date.now();
  await action();
  if (capture) await screenshot(name);
  console.log(`PASS ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}
function screenPoint(spec) {
  return quest.evaluate(({ name, world }) => {
    const app = window.__ce;
    const shown = (o) => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
    let position;
    if (name) {
      let node = null;
      app.scene.traverse((o) => { if (!node && o.name === name && shown(o)) node = o; });
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

/** Emulated tracked hands (IWER). `tip` places the index fingertip at a WORLD point instead of an offset from the head. */
const hands = (poses, wait = 20) => quest.evaluate(async ({ poses, wait }) => {
  const app = window.__ce, remote = app.emulator.device.remote, head = app.emulator.head();
  app.input.mouseAsHand = false; app.input.pointer.inside = app.input.pointer.down = app.input.pointer.latched = false;
  await remote.dispatch('set_input_mode', { mode: 'hand' });
  const xyz = (v) => ({ x: v.x, y: v.y, z: v.z });
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  for (const [side, spec] of Object.entries(poses)) {
    const { offset, tip, pose, palm } = spec, device = `hand-${side}`;
    const placeWrist = async (position) => {
      const palmDir = palm === 'out' ? head.position.clone().set(0, 0, -1).applyQuaternion(head.quaternion) : head.position.clone().sub(position).normalize();
      const fingers = palm === 'out' ? head.position.clone().set(0, 1, 0).applyQuaternion(head.quaternion) : head.position.clone().set(0, 0, -1).applyQuaternion(head.quaternion);
      fingers.addScaledVector(palmDir, -fingers.dot(palmDir)).normalize();
      await remote.dispatch('set_connected', { device, connected: true });
      await remote.dispatch('set_select_value', { device, value: 0 });
      await remote.dispatch('set_hand_pose', { device, poseId: pose });
      await remote.dispatch('set_transform', { device, anchor: 'wrist', position: xyz(position), orientation: { fingers: xyz(fingers), palm: xyz(palmDir) } });
    };
    if (offset) await placeWrist(head.position.clone().add(head.position.clone().fromArray(offset).applyQuaternion(head.quaternion)));
    else {
      // fingertip placement: guess the wrist 0.11 m behind the tip along the view direction, read the real tip, correct once
      const goal = head.position.clone().fromArray(tip);
      const back = goal.clone().sub(head.position).setY(0).normalize();
      let wrist = goal.clone().addScaledVector(back, -0.11);
      for (let i = 0; i < 2; i++) {
        await placeWrist(wrist);
        await frame();
        const joint = app.lastFrame?.hands?.[side]?.joints?.['index-finger-tip']?.position;
        if (joint) wrist = wrist.clone().add(goal.clone().sub(joint));
      }
      await placeWrist(wrist);
    }
  }
  await new Promise((r) => { let k = 0; const f = () => (++k >= wait ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
}, { poses, wait });
const dropHands = () => quest.evaluate(async () => {
  const remote = window.__ce.emulator.device.remote;
  for (const device of ['hand-left', 'hand-right']) await remote.dispatch('set_connected', { device, connected: false });
});

/** What the server will say for "Touch the water": a recorded answer, labelled FIXTURE. */
const FIXTURE_CODE = `// Touch the water: your fingertip is the ripple.
const sc = s.screen;
if (!sc || !sc.inside) {
  out.set('cc24', 0);
  mem.wasTouching = false;
  return;
}
// where the finger is on the screen
out.set('cc22', sc.u * 127);
out.set('cc23', sc.v * 127);
// glow while it hovers, a full splash while it touches
const pressure = sc.touching ? 127 : Math.round(sc.hover * 36);
out.set('cc24', pressure);
mem.wasTouching = sc.touching;
`;

async function installStub() {
  await quest.evaluate(({ code, live }) => {
    const app = window.__ce;
    window.__wire = { out: [], requests: [], progress: [] };
    app.ws.tap('out', ({ type, payload }) => {
      if (type === 'control.event' && String(payload.widgetId).startsWith('wire:')) window.__wire.out.push({ ...payload, at: performance.now() });
      if (type === 'wire.request') window.__wire.requests.push(payload);
    });
    if (live) return;
    // The stand-in for the server's WIRE step: stream the program, validate, dry-run, ready.
    app.ws.tap('out', ({ type, payload }) => {
      if (type !== 'wire.request') return;
      const wiringId = `w-${Date.now()}`;
      const base = { cardId: payload.cardId, wiringId, request: payload.text, model: 'muse-spark-1.3', source: 'fixture' };
      const send = (p) => { window.__wire.progress.push(p.phase); app.wiring.onProgress({ ...base, ...p }); };
      let i = 0;
      send({ phase: 'writing' });
      const timer = setInterval(() => {
        if (i < code.length) { send({ phase: 'writing', codeDelta: code.slice(i, i + 24) }); i += 24; return; }
        clearInterval(timer);
        setTimeout(() => send({ phase: 'validating', code }), 300);
        setTimeout(() => send({ phase: 'dry-run', note: 'dry-run ✓ 120 frames · 3 actions' }), 900);
        setTimeout(() => send({ phase: 'verifying' }), 1400);
        setTimeout(() => {
          const act = (actionId, label) => ({ actionId, label, kind: 'set', min: 0, max: 127, maxRateHz: 60 });
          app.wiring.onReady({ ...base, code, title: 'Touch the water', explanation: 'Your fingertip on the screen is a ripple: where you touch is where it splashes; a hovering finger leaves a soft glow.',
            actions: [act('cc22', 'Touch X'), act('cc23', 'Touch Y'), act('cc24', 'Touch pressure')], needs: ['right', 'screen'] });
        }, 1800);
      }, 55);
    });
  }, { code: FIXTURE_CODE, live: LIVE });
}

async function run() {
  await mkdir(SCREENS, { recursive: true });
  await phase('00-server', startServer, false);

  await phase('01-enter-ar', async () => {
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    context.setDefaultTimeout(UI_TIMEOUT);
    await context.addInitScript(() => {
      window.__ceMute = true;
      for (const key of ['AudioContext', 'webkitAudioContext']) if (window[key]) window[key] = new Proxy(window[key], { construct() { throw new Error('No audio in the check'); } });
    });
    sim = await context.newPage(); watchPage(sim, 'sim');
    await sim.goto(`${BASE}/sim/?mute=1`, { waitUntil: 'domcontentloaded' });
    await sim.waitForFunction(() => window.ceSim?.leader() && window.ceSimDebug?.device.conn?.open);
    quest = await context.newPage(); watchPage(quest, 'quest');
    await quest.goto(`${BASE}/quest/?emulate=1&camera=sim&mute=1&mic=0`, { waitUntil: 'domcontentloaded' });
    await waitQuest(() => window.__ce?.welcome && window.__ce.ws.open && window.__ce.room?.sim?.canvas);
    await quest.evaluate(() => {
      window.__judge = { events: [], requests: [] };
      const types = new Set(['tags.state', 'device.card', 'agent.step', 'verify.result', 'ui.spec', 'arm.request', 'arm.result', 'panic']);
      window.__ce.ws.tap('in', ({ type, payload }) => { if (types.has(type)) window.__judge.events.push({ type, payload }); });
      window.__ce.ws.tap('out', ({ type, payload }) => { if (type !== 'scan.frame') window.__judge.requests.push({ type, payload }); });
    });
    await installStub();
    await quest.locator('#btn-enter').click();
    await waitQuest(() => window.__ce.renderer.xr.isPresenting && window.__ce.cameraState === 'on');
  });

  let screen;
  await phase('02-find-and-pinch-the-mac', async () => {
    screen = await until('a box on the Mac screen', () => quest.evaluate((source) => {
      const app = window.__ce, re = new RegExp(source, 'i');
      if (app.modes.mode !== 'annotate') return null;
      const t = app.targets.list().find((t) => re.test(t.label) && app.visibleTargets.has(t.id));
      return t ? { id: t.id, label: t.label, position: t.position.toArray() } : null;
    }, SCREEN.source), 60_000);
    await quest.evaluate((c) => {
      const app = window.__ce, target = app.desktopCam.position.clone().fromArray(c), head = app.emulator.head();
      const dir = target.clone().sub(head.position).setY(0).normalize();
      const pos = target.clone().addScaledVector(dir, -0.95); pos.y = target.y + 0.4;
      app.emulator.setHead(pos, head.quaternion); app.emulator.lookAt(target);
    }, screen.position);
    await frames(20);
    await click({ world: screen.position });
    await waitQuest(() => [...window.__ce.modes.tags.values()].some((t) => t.cardId?.startsWith('visual-synth')));
    cardId = await quest.evaluate(() => [...window.__ce.modes.tags.values()].find((t) => t.cardId?.startsWith('visual-synth')).cardId);
  }, false);

  await phase('03-armed-and-asking', async () => {
    await until('controls armed', async () => (await json(`/api/agent/targets/${encodeURIComponent(cardId)}`)).armed, PIPELINE_TIMEOUT);
    await waitQuest((id) => window.__ce.modes.byCard(id)?.connection === 'ready' && window.__ce.canControl?.(id) !== false, cardId);
    await waitQuest(() => window.__ce.hud.root.userData.wire?.chips?.length === 3);
    const wire = await quest.evaluate(() => window.__ce.hud.root.userData.wire);
    assert.equal(wire.prompt, 'What should your hands do?');
    assert.deepEqual(wire.chips, ['Touch the water', 'Hands as knobs', 'Surprise me']);
    assert.equal(wire.phase, 'idle');
    console.log(`  card: "${wire.prompt}" · chips ${wire.chips.join(' | ')} · mic ${wire.mic}`);
  });

  await phase('04-hands-do-nothing-before-wiring', async () => {
    // Raise and move the right hand in the play zone; nothing may reach the device before a wiring runs.
    const before = await quest.evaluate(() => window.__judge.requests.filter((r) => r.type === 'control.event').length);
    const left = { offset: [-0.25, -0.7, -0.15], pose: 'default' };
    for (let i = 0; i < 12; i++) await hands({ left, right: { offset: [0.2, -0.3 + i * 0.02, -0.4 - i * 0.01], pose: 'open' } }, 3);
    await frames(10);
    const after = await quest.evaluate(() => window.__judge.requests.filter((r) => r.type === 'control.event').length);
    assert.equal(after, before, 'No control.event goes out from hand movement alone');
    const hand = await quest.evaluate(() => ({ mapping: !!window.__ce.handMapping, wiring: window.__ce.wiring.phase }));
    assert.equal(hand.mapping, false, 'No hand-written mapping started by itself');
    assert.equal(hand.wiring, 'idle');
    await dropHands();
  });

  await phase('05-ask-a-chip', async () => {
    await frames(10);
    const chip = await screenPoint({ name: 'wire-chip:Touch the water' });
    await quest.mouse.move(chip.x - 5, chip.y - 5); await frames(4);
    await quest.mouse.move(chip.x, chip.y); await frames(6);
    await quest.mouse.down(); await frames(2); await quest.mouse.up(); await frames(4);
    await until('wire.request sent', () => quest.evaluate(() => window.__wire.requests.length > 0));
    const request = await quest.evaluate(() => window.__wire.requests[0]);
    assert.equal(request.text, 'Touch the water'); assert.equal(request.source, 'chip'); assert.equal(request.cardId, cardId);
    // mid-stream: the code card is up and typing
    await until('the code card is typing', () => quest.evaluate(() => {
      const w = window.__ce.hud.root.userData.wire;
      return w?.phase === 'writing' && w.card.code.length > 60;
    }));
    await delay(250);
  });
  await screenshot('05b-code-streaming');
  await until('the program is ready and the screen needs calibrating', () => quest.evaluate(() => window.__ce.wiring.phase === 'calibrating'), 20_000);
  const card = await quest.evaluate(() => window.__ce.hud.root.userData.wire.card);
  assert(/muse-spark-1\.3 (is|wired)/.test(card.header), `header names the model (${card.header})`);
  assert.equal(card.badge, 'FIXTURE', 'the source is labelled honestly');
  console.log(`  header: ${card.header} · badge ${card.badge} · phase "${card.phase}"`);
  await screenshot('06-calibrate-top-left');

  // --- calibrate: touch the top-left, then the bottom-right corner of the sim Mac's screen -------------------------
  const geometry = await quest.evaluate((c) => {
    const app = window.__ce, p = app.desktopCam.position.clone().fromArray(c), head = app.emulator.head();
    const f = p.clone().sub(head.position).setY(0).normalize(), right = f.clone().cross(head.position.clone().set(0, 1, 0));
    const at = (u, v, d) => p.clone().addScaledVector(right, (u - 0.5) * 0.5).add(head.position.clone().set(0, 0.16 - v * 0.3, 0)).addScaledVector(f, -d);
    return { tl: at(0, 0, 0.0).toArray(), br: at(1, 1, 0.0).toArray(), mid: at(0.5, 0.5, 0.0).toArray(), toward: f.clone().negate().toArray(), right: right.toArray(), anchor: c };
  }, screen.position);
  const pt = (a, d = 0) => a.map((n, i) => n + geometry.toward[i] * d);
  await phase('06b-touch-corners', async () => {
    const left = { offset: [-0.25, -0.7, -0.15], pose: 'default' };
    await hands({ left, right: { tip: pt(geometry.tl), pose: 'point' } }, 40);
    await until('top-left captured', () => quest.evaluate(() => window.__ce.wiring.calibrator.step === 'bottom-right'), 10_000);
    await screenshot('06c-top-left-taken');
    await hands({ left, right: { tip: pt(geometry.br), pose: 'point' } }, 10);
    await hands({ left, right: { tip: pt(geometry.br), pose: 'point' } }, 40);
    await until('the program is running', () => quest.evaluate(() => window.__ce.wiring.phase === 'running'), 10_000);
    const stored = await quest.evaluate((id) => localStorage.getItem(`ce.screen-plane.v1.${id}`), cardId);
    assert(stored, 'The calibrated plane is stored per card in localStorage');
    const plane = JSON.parse(stored);
    console.log(`  plane ${plane.width.toFixed(2)} x ${plane.height.toFixed(2)} m`);
  });

  await phase('07-explanation-then-touch', async () => {
    await delay(300);
    const card = await quest.evaluate(() => window.__ce.hud.root.userData.wire.card);
    assert(/Touch the water/.test(card.explanation), `title + explanation shown (${card.explanation})`);
  });

  await phase('08-touch-the-water', async () => {
    const left = { offset: [-0.25, -0.7, -0.15], pose: 'default' };
    const since = await quest.evaluate(() => window.__wire.out.length);
    // hover 6 cm in front of the middle of the screen, then touch, then drag right
    await hands({ left, right: { tip: pt(geometry.mid, 0.06), pose: 'point' } }, 25);
    const hover = await quest.evaluate(() => window.__wire.out.filter((e) => e.widgetId === 'wire:cc24').slice(-1)[0]?.value);
    assert(hover > 0 && hover < 127, `hovering sends a soft glow (cc24=${hover})`);
    await hands({ left, right: { tip: pt(geometry.mid, 0.003), pose: 'point' } }, 25);
    const touch = await quest.evaluate(() => window.__wire.out.filter((e) => e.widgetId === 'wire:cc24').slice(-1)[0]?.value);
    assert.equal(touch, 127, 'touching sends full pressure');
    const x0 = await quest.evaluate(() => window.__wire.out.filter((e) => e.widgetId === 'wire:cc22').slice(-1)[0]?.value);
    for (let i = 1; i <= 8; i++) await hands({ left, right: { tip: pt(geometry.mid.map((n, k) => n + geometry.right[k] * i * 0.02), 0.003), pose: 'point' } }, 3);
    await frames(6);
    const x1 = await quest.evaluate(() => window.__wire.out.filter((e) => e.widgetId === 'wire:cc22').slice(-1)[0]?.value);
    assert(x1 > x0 + 10, `dragging right moves Touch X (${x0} -> ${x1})`);
    const events = await quest.evaluate((n) => window.__wire.out.slice(n), since);
    assert(events.every((e) => /^wire:cc2[234]$/.test(e.widgetId)), 'Only wire:<actionId> events go out');
    console.log(`  ${events.length} wire events; X ${Math.round(x0)} -> ${Math.round(x1)}; pressure ${hover} (hover) -> ${touch} (touch)`);
    await screenshot('08-touching');
    // the wrist menu stays shut while the hands work
    await hands({ left: { offset: [-0.18, -0.12, -0.32], pose: 'open', palm: 'toward' }, right: { tip: pt(geometry.mid, 0.05), pose: 'point' } }, 40);
    const busy = await quest.evaluate(() => { const p = window.__ce.hud.root.getObjectByName('wrist-palette'); return { open: !!(p?.visible && p.anchor.open && p.anchor.source === 'hand'), block: p?.anchor.blockOpen }; });
    assert.equal(busy.block, true, 'blockOpen is set while the finger is near the screen');
    assert.equal(busy.open, false, 'The wrist menu stays shut while controlling');
  });

  await phase('09-both-palms-out-stops', async () => {
    const out = await quest.evaluate(() => window.__wire.out.length);
    await hands({ left: { offset: [-0.22, -0.05, -0.45], pose: 'open', palm: 'out' }, right: { offset: [0.22, -0.05, -0.45], pose: 'open', palm: 'out' } }, 30);
    await until('the wiring stopped', () => quest.evaluate(() => window.__ce.wiring.phase === 'stopped'), 5000);
    const lift = await quest.evaluate((n) => window.__wire.out.slice(n).filter((e) => e.widgetId === 'wire:cc24').map((e) => e.value), out);
    assert.equal(lift[lift.length - 1], 0, `the pressure lifts to 0 on stop (${lift})`);
    const card = await quest.evaluate(() => window.__ce.hud.root.userData.wire.card);
    assert(/stopped/.test(card.pill), `pill says stopped (${card.pill})`);
    const after = await quest.evaluate(() => window.__wire.out.length);
    await frames(20);
    assert.equal(await quest.evaluate(() => window.__wire.out.length), after, 'nothing is sent after stop');
  });

  await phase('10-collapses-to-a-pill-while-running', async () => {
    await dropHands();
    await quest.evaluate(() => window.__ce.wiring.ask('Touch the water', 'chip'));
    await until('running again', () => quest.evaluate(() => window.__ce.wiring.phase === 'running'), 30_000);
    await until('collapsed to a pill', () => quest.evaluate(() => window.__ce.hud.root.userData.wire?.card?.mode === 'pill'), 12_000);
    const card = await quest.evaluate(() => window.__ce.hud.root.userData.wire.card);
    assert(/Touch the water · running/.test(card.pill), `pill: ${card.pill}`);
    console.log(`  pill: ${card.pill}`);
  });

  console.log('\nOK');
}

try { await run(); } catch (error) {
  console.error(`\nFAIL: ${error.stack ?? error}`);
  console.error(`\n-- browser log --\n${browserLog.slice(-25).join('\n')}`);
  console.error(`\n-- server log (tail) --\n${serverLog.slice(-2500)}`);
  process.exitCode = 1;
} finally {
  abort.abort();
  await browser?.close().catch(() => {});
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await delay(500); if (server.exitCode === null) server.kill('SIGKILL'); }
  if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}
