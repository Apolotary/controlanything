/**
 * Muse XR scenes in the Quest emulator (system Chrome, FIXTURE: no Meta model is called):
 *   tag the laptop -> Control -> "Visualize my hands in 3D" -> the agent returns a scene program (no connector) ->
 *   the headset runs it in its sandboxed Worker and draws the display list -> emulated hands move the drawing ->
 *   both palms held out still stop it. Then "Visualize the visual synth's ripple parameters as a floating 3D field":
 *   connector + knobs + a scene that reads the knob values.
 * Runs its own fixture server on PORT (default 8811). Screens: research/screens/2026-11-05-xr-scenes/.
 *   CE_QUEST_DIST=/tmp/ce-stage-b node scripts/e2e-xr-scene.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCREENS = join(ROOT, 'research/screens/2026-11-05-xr-scenes');
const PORT = Number(process.env.PORT || 8811);
const BASE = `http://127.0.0.1:${PORT}`;
let server, browser, quest, log = '';
const evidence = {};
const until = async (what, probe, ms = 30_000) => { const end = Date.now() + ms; for (;;) { const r = await probe(); if (r) return r; if (Date.now() > end) throw new Error(`timeout: ${what}`); await delay(200); } };
const pass = (what, extra = '') => console.log(`PASS ${what}${extra ? ` · ${extra}` : ''}`);

/** Emulated tracked hands (IWER), as in e2e-wire-quest.mjs: offsets are metres from the head in head axes. */
const hands = (poses, wait = 20) => quest.evaluate(async ({ poses, wait }) => {
  const app = window.__ce, remote = app.emulator.device.remote, head = app.emulator.head(), V = head.position.constructor;
  app.input.mouseAsHand = false; app.input.pointer.inside = app.input.pointer.down = app.input.pointer.latched = false;
  await remote.dispatch('set_input_mode', { mode: 'hand' });
  const xyz = (v) => ({ x: v.x, y: v.y, z: v.z });
  for (const [side, { offset, pose, palm }] of Object.entries(poses)) {
    const device = `hand-${side}`;
    const position = head.position.clone().add(new V().fromArray(offset).applyQuaternion(head.quaternion));
    const palmDir = palm === 'out' ? new V(0, 0, -1).applyQuaternion(head.quaternion) : palm === 'down' ? new V(0, -1, 0) : head.position.clone().sub(position).normalize();
    const fingers = palm === 'down' ? new V(0, 0, -1).applyQuaternion(head.quaternion) : new V(0, 1, 0).applyQuaternion(head.quaternion);
    fingers.addScaledVector(palmDir, -fingers.dot(palmDir)).normalize();
    await remote.dispatch('set_connected', { device, connected: true });
    await remote.dispatch('set_select_value', { device, value: 0 });
    await remote.dispatch('set_hand_pose', { device, poseId: pose ?? 'open' });
    await remote.dispatch('set_transform', { device, anchor: 'wrist', position: xyz(position), orientation: { fingers: xyz(fingers), palm: xyz(palmDir) } });
  }
  await new Promise((r) => { let k = 0; const f = () => (++k >= wait ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
}, { poses, wait });
const dropHands = () => quest.evaluate(async () => {
  const remote = window.__ce.emulator.device.remote;
  for (const device of ['hand-left', 'hand-right']) await remote.dispatch('set_connected', { device, connected: false });
});
/** What the scene sandbox returned last: counts, first trail point, a hash of the first 1600 points, texts. */
const sceneState = () => quest.evaluate(() => {
  const ce = window.__ce, v = ce.wiring.scene.view, snap = ce.wiring.snapshot().scene, layer = ce.hud.root.userData.scene;
  let hash = 0;
  if (v.data) for (let i = 0; i < Math.min(v.counts.points, 1600) * 8; i += 8) hash += v.data[i] * 1.3 + v.data[i + 1] * 1.7 + v.data[i + 2] * 1.1;
  const s = ce.wiring.sceneSignals?.signals;
  return { active: v.active, placed: v.placed, seq: v.seq, counts: { ...v.counts }, texts: v.texts.map((t) => t.text), hash,
    stats: snap ? { ticks: snap.ticks, avgMs: snap.avgMs, maxMs: snap.maxMs, strikes: snap.strikes } : undefined,
    layer: layer ? { visible: layer.visible, counts: layer.counts } : undefined, right: s?.right ? { x: s.right.x, y: s.right.y, z: s.right.z } : null,
    phase: ce.hud.root.userData.wire?.phase, calls: ce.renderer.info.render.calls };
});

try {
  await mkdir(SCREENS, { recursive: true });
  const dataDir = await mkdtemp(join(tmpdir(), 'ce-e2e-scene-'));
  server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: join(ROOT, 'apps/server'), stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, HTTP_PORT: String(PORT), HTTPS_PORT: '0', HTTP_HOST: '127.0.0.1', PUBLIC_HOST: '127.0.0.1', CE_DATA_DIR: dataDir, CE_AGENT_WORKSPACE: join(dataDir, 'muse-agent'), MODEL_MODE: 'fixture', MODEL_API_KEY: '',
    CE_OSMO: '', REMO_SEND: '0', CE_DEMO: '1', CE_MAC_SILENT: '1', CE_MAC_LOCAL: '0', CE_REMO: '0', REMO_HOST: '', CE_TRUST_FIRST_DEVICE: '1', CE_TRUST_LOOPBACK: '1', CE_CONSOLE_APPROVE: '0', MUSE_REPLAY: '1', GEN3D_SKIN: '0', VITEST: '' } });
  for (const s of [server.stdout, server.stderr]) s.on('data', (c) => { log = (log + c).slice(-200_000); });
  await until('server', () => log.includes('ControlAnything server '));
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const sim = await ctx.newPage();
  await sim.goto(`${BASE}/sim/?mute=1`);
  quest = await ctx.newPage();
  quest.on('pageerror', (e) => console.log('pageerror', e.message));
  quest.on('console', (m) => { if (m.type() === 'error') console.log('console.error', m.text().slice(0, 200)); });
  await quest.goto(`${BASE}/quest/?emulate=1&camera=sim&mute=1&mic=0&tutorial=0`);
  await quest.waitForFunction(() => window.__ce?.ws?.open, null, { timeout: 30_000 });
  await quest.click('#btn-enter');
  await quest.waitForFunction(() => window.__ce.targets.list().some((t) => /visual|laptop|mac/i.test(t.label)), null, { timeout: 60_000 });
  const shot = async (name, wait = 500) => { await delay(wait); const c = await quest.evaluateHandle(() => window.__ce.renderer.domElement); await c.asElement().screenshot({ path: join(SCREENS, `${name}.png`) }); };
  // Tag the laptop in Annotate, then choose Control.
  await quest.evaluate(() => { const t = window.__ce.targets.list().find((x) => /visual|laptop|mac/i.test(x.label)); window.__ce.lock(t.id, 'api'); });
  await quest.waitForFunction(() => [...window.__ce.modes.tags.values()].some((t) => t.cardId), null, { timeout: 20_000 });
  await quest.evaluate(() => { const ce = window.__ce; const t = ce.targets.list().find((x) => /visual|laptop|mac/i.test(x.label)); ce.setMode('control'); ce.lock(t.id, 'api'); });
  await quest.waitForFunction(() => window.__ce.hud.root.userData.wire?.phase === 'idle', null, { timeout: 15_000 });
  const chips = await quest.evaluate(() => window.__ce.hud.root.userData.wire.chips);
  assert.ok(chips.some((c) => /3D/.test(c)), `no visualization chip: ${chips.join(' | ')}`);
  pass('card offers a 3D visualization ask', chips.join(' | '));
  await quest.evaluate(() => { window.__ready = null; window.__ce.ws.tap('in', ({ type, payload }) => { if (type === 'wire.ready') window.__ready = payload; }); });

  // 1. A pure visualization: no connector, the scene streams into the code card, then runs.
  const ask = chips.find((c) => /3D/.test(c));
  await quest.evaluate((text) => window.__ce.wiring.ask(text, 'chip'), ask);
  await quest.waitForFunction(() => window.__ce.wiring.snapshot().codeChars > 1200, null, { timeout: 20_000 });
  await shot('01-muse-writes-scene');
  // what the code card is typing out: the agent's terminal, ending with the scene program
  const card = await quest.evaluate(() => window.__ce.wiring.w?.code ?? '');
  assert.match(card, /\/\/ 3D scene \(runs on the headset\)[\s\S]*draw\./, 'the code card was not given the scene code');
  pass('the code card streams the scene code', `${card.length} chars`);
  await quest.waitForFunction(() => ['running', 'failed'].includes(window.__ce.hud.root.userData.wire?.phase), null, { timeout: 60_000 });
  assert.equal(await quest.evaluate(() => window.__ce.hud.root.userData.wire.phase), 'running', 'agent failed');
  const ready = await quest.evaluate(() => window.__ready);
  assert.ok(ready?.scene?.code?.length > 500, 'wire.ready has no scene');
  assert.equal(ready.actions.length, 0, 'a pure scene should not need connector actions');
  const conns = (await (await fetch(`${BASE}/api/agent/connectors`)).json()).connectors.length;
  assert.equal(conns, 0, 'a pure scene deployed a connector');
  pass('wire.ready carries a validated scene and no connector', `${ready.scene.title} · ${ready.scene.code.length} chars`);
  const idle = await until('scene draws', async () => { const s = await sceneState(); return s.counts.points > 1000 && s.layer?.visible ? s : null; }, 15_000);
  pass('scene runs and draws with no hands', `${idle.counts.points} points · ${idle.counts.spheres} spheres · ${idle.counts.rings} rings`);
  await delay(1500);
  await shot('02-galaxy-no-hands');

  // 2. Hands in: trails appear and follow the fingertips; palms push the galaxy.
  await hands({ right: { offset: [0.12, -0.24, -0.38], pose: 'open', palm: 'down' }, left: { offset: [-0.14, -0.22, -0.42], pose: 'open', palm: 'down' } }, 30);
  const withHands = await sceneState();
  assert.ok(withHands.right, 'scene signals have no right hand');
  for (let i = 0; i < 24; i++) await hands({ right: { offset: [0.12 - i * 0.008, -0.24 + Math.sin(i / 4) * 0.05, -0.38 - i * 0.004], pose: 'open', palm: 'down' }, left: { offset: [-0.14 + Math.sin(i / 3) * 0.04, -0.22, -0.42 + i * 0.003], pose: 'open', palm: 'down' } }, 2);
  // keep moving while the screenshot is taken: trails only exist while the fingertips travel
  const sweep = (async () => { for (let i = 0; i < 40; i++) await hands({ right: { offset: [0.02 + Math.sin(i / 2.2) * 0.16, -0.2 + Math.cos(i / 2.2) * 0.09, -0.46], pose: 'open', palm: 'down' }, left: { offset: [-0.14 - Math.cos(i / 2.6) * 0.1, -0.24 + Math.sin(i / 2.6) * 0.08, -0.44], pose: 'open', palm: 'down' } }, 1); })();
  await delay(1200); await shot('03-galaxy-hands-trails', 0); await sweep;
  const moved = await sceneState();
  assert.ok(moved.counts.points > idle.counts.points + 20, `no trail points (${idle.counts.points} -> ${moved.counts.points})`);
  assert.ok(Math.abs(moved.hash - idle.hash) > 0.01, 'the galaxy did not change');
  assert.ok(Math.hypot(moved.right.x - withHands.right.x, moved.right.y - withHands.right.y, moved.right.z - withHands.right.z) > 0.08, 'the right hand did not move in scene space');
  pass('hand movement changes the drawing', `points ${idle.counts.points} -> ${moved.counts.points} · lines ${moved.counts.lines} · right palm at (${moved.right.x.toFixed(2)}, ${moved.right.y.toFixed(2)}, ${moved.right.z.toFixed(2)})`);
  for (let i = 0; i < 16; i++) await hands({ right: { offset: [0.05 + Math.cos(i / 3) * 0.08, -0.25 + Math.sin(i / 3) * 0.06, -0.47], pose: 'open', palm: 'down' }, left: { offset: [-0.08 - Math.cos(i / 3) * 0.06, -0.26, -0.45], pose: 'open', palm: 'down' } }, 2);
  await shot('04-galaxy-pushed');
  const perf = await sceneState();
  evidence.galaxy = { idle: idle.counts, hands: moved.counts, stats: perf.stats, drawCalls: perf.calls };
  pass('sandbox timing', `avg ${perf.stats.avgMs.toFixed(2)} ms · max ${perf.stats.maxMs.toFixed(1)} ms · strikes ${perf.stats.strikes} · ${perf.stats.ticks} frames · draw calls ${perf.calls}`);

  // 2b. Optional: run a scene a live Muse Spark run wrote (LIVE_SCENE=file) in the same sandbox, for a screenshot.
  if (process.env.LIVE_SCENE) {
    const code = await readFile(process.env.LIVE_SCENE, 'utf8');
    await quest.evaluate((code) => { const w = window.__ce.wiring; w.scene.start({ wiringId: 'live', cardId: 'live', title: 'Live Muse scene', code }); w.scene.setAnchor(w.sceneSignals.anchor, w.sceneSignals.yaw); }, code);
    const wave = (async () => { for (let i = 0; i < 40; i++) await hands({ right: { offset: [Math.sin(i / 2.5) * 0.18, -0.2 + Math.cos(i / 2.5) * 0.1, -0.45], pose: 'open', palm: 'down' }, left: { offset: [-0.15 - Math.cos(i / 3) * 0.08, -0.22 + Math.sin(i / 3) * 0.08, -0.42], pose: 'open', palm: 'down' } }, 1); })();
    await delay(1500); await shot('07-live-muse-hand-speed-trails', 0); await wave;
    const live = await sceneState();
    assert.ok(live.counts.points > 50 && live.active, 'the live scene did not draw');
    evidence.live = { counts: live.counts, texts: live.texts, stats: live.stats };
    pass('a live Muse-written scene runs in the sandbox', `${live.counts.points} points · ${live.counts.spheres} spheres · ${live.texts.join(', ')}`);
  }

  // 3. Both palms out, held still: stops the scene and clears it.
  await hands({ left: { offset: [-0.22, -0.05, -0.45], pose: 'open', palm: 'out' }, right: { offset: [0.22, -0.05, -0.45], pose: 'open', palm: 'out' } }, 20);
  const notYet = await quest.evaluate(() => window.__ce.hud.root.userData.wire.phase);
  await until('palms stop', async () => (await quest.evaluate(() => window.__ce.hud.root.userData.wire?.phase)) === 'stopped' ? true : (await hands({ left: { offset: [-0.22, -0.05, -0.45], pose: 'open', palm: 'out' }, right: { offset: [0.22, -0.05, -0.45], pose: 'open', palm: 'out' } }, 10), false), 10_000);
  const cleared = await sceneState();
  assert.equal(cleared.active, false, 'scene still active after Stop');
  assert.ok(!cleared.layer, 'scene layer still visible after Stop');
  pass('both palms held out still stop the scene and clear it', `phase after 20 frames: ${notYet}`);
  await dropHands();
  await shot('05-stopped');

  // 4. The visual synth's parameters as a floating field: connector + knobs + a scene that reads their values.
  await quest.evaluate(() => { window.__ready = null; window.__ce.wiring.ask("Visualize the visual synth's ripple parameters as a floating 3D field", 'voice'); });
  await quest.waitForFunction(() => ['running', 'failed'].includes(window.__ce.hud.root.userData.wire?.phase), null, { timeout: 90_000 });
  const ready2 = await quest.evaluate(() => window.__ready);
  assert.ok(ready2?.scene && ready2.actions.some((a) => a.actionId === 'cc21'), 'field scene without cc21');
  await until('field draws', async () => (await sceneState()).counts.points > 500, 15_000);
  const before = await sceneState();
  for (let i = 0; i < 12; i++) { await quest.evaluate((v) => window.__ce.wiring.control('cc21', v, 'move'), 20 + i * 9); await delay(40); }
  await quest.evaluate(() => window.__ce.wiring.control('cc21', 120, 'end'));
  const after = await until('values reach the scene', async () => { const s = await sceneState(); return s.texts.includes('Ripples 120') ? s : null; }, 8_000);
  assert.ok(Math.abs(after.hash - before.hash) > 0.01, 'field did not change');
  const logs = (await (await fetch(`${BASE}/api/agent/connectors`)).json()).connectors.flatMap((c) => c.logs);
  pass('knob values drive the field', `${before.texts.join(', ')} -> ${after.texts.join(', ')} · connector: ${logs.filter((l) => /CC21/.test(l)).slice(-1)[0] ?? '(no ack line)'}`);
  await hands({ right: { offset: [0.05, -0.27, -0.5], pose: 'point', palm: 'down' } }, 30);
  await shot('06-ripple-field');
  evidence.field = { counts: after.counts, texts: after.texts, stats: after.stats };
  await quest.evaluate(() => window.__ce.wiring.stop('Stop', 'user'));
  await until('connector stopped', async () => (await (await fetch(`${BASE}/api/agent/connectors`)).json()).connectors.length === 0, 10_000);
  assert.equal((await sceneState()).active, false);
  pass('Stop retires the connector and clears the field');
  await writeFile(join(SCREENS, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log('ALL PASS');
} catch (e) {
  console.error('FAIL', e.message); console.error(log.split('\n').filter((l) => /muse-agent|scene|wire|error/i.test(l)).slice(-20).join('\n'));
  try { if (quest) { const c = await quest.evaluateHandle(() => window.__ce.renderer.domElement); await c.asElement().screenshot({ path: join(SCREENS, 'zz-failure.png') }); } } catch { /* no page */ }
  process.exitCode = 1;
} finally { await browser?.close(); server?.kill('SIGTERM'); }
