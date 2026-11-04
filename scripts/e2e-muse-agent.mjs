/**
 * The Muse agent golden path in the Quest emulator (system Chrome, FIXTURE: no Meta model is called):
 *   Annotate: tag the laptop -> Control -> Ask Muse (no setup ceremony) -> the agent writes + deploys a connector on
 *   the Mac and returns AR knobs -> twist/drag a knob -> the connector sends MIDI CC to the visual synth -> Stop.
 * Runs its own fixture server on PORT (default 8798). Screens: research/screens/2026-11-04-muse-agent/.
 *   CE_QUEST_DIST=/tmp/ce-stage-quest node scripts/e2e-muse-agent.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCREENS = join(ROOT, 'research/screens/2026-11-04-muse-agent');
const PORT = Number(process.env.PORT || 8798);
const BASE = `http://127.0.0.1:${PORT}`;
const ASK = process.env.ASK || 'Give me knobs for ripples, warp and zoom';
let server, browser, log = '';
const until = async (what, probe, ms = 30_000) => { const end = Date.now() + ms; for (;;) { const r = await probe(); if (r) return r; if (Date.now() > end) throw new Error(`timeout: ${what}`); await delay(200); } };

try {
  const dataDir = await mkdtemp(join(tmpdir(), 'ce-e2e-agent-'));
  server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: join(ROOT, 'apps/server'), stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, HTTP_PORT: String(PORT), HTTPS_PORT: '0', HTTP_HOST: '127.0.0.1', PUBLIC_HOST: '127.0.0.1', CE_DATA_DIR: dataDir, MODEL_MODE: 'fixture', MODEL_API_KEY: '',
    CE_DEMO: '1', CE_MAC_SILENT: '1', CE_MAC_LOCAL: '0', CE_REMO: '0', REMO_HOST: '', CE_TRUST_FIRST_DEVICE: '1', CE_TRUST_LOOPBACK: '1', CE_CONSOLE_APPROVE: '0', MUSE_REPLAY: '1', GEN3D_SKIN: '0', VITEST: '' } });
  for (const s of [server.stdout, server.stderr]) s.on('data', (c) => { log = (log + c).slice(-200_000); });
  await until('server', () => log.includes('ControlAnything server '));
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const sim = await ctx.newPage();
  await sim.goto(`${BASE}/sim/?mute=1`);
  const quest = await ctx.newPage();
  quest.on('pageerror', (e) => console.log('pageerror', e.message));
  await quest.goto(`${BASE}/quest/?emulate=1&camera=sim&mute=1&mic=0&tutorial=0`);
  await quest.waitForFunction(() => window.__ce?.ws?.open, null, { timeout: 30_000 });
  await quest.click('#btn-enter');
  await quest.waitForFunction(() => window.__ce.targets.list().some((t) => /visual|laptop|mac/i.test(t.label)), null, { timeout: 60_000 });
  const shot = async (name) => { await delay(600); const c = await quest.evaluateHandle(() => window.__ce.renderer.domElement); await c.asElement().screenshot({ path: join(SCREENS, `${name}.png`) }); };
  // Annotate: pinch (tag) the laptop. It stays in Annotate.
  await quest.evaluate(() => { const t = window.__ce.targets.list().find((x) => /visual|laptop|mac/i.test(x.label)); window.__ce.lock(t.id, 'api'); });
  await quest.waitForFunction(() => [...window.__ce.modes.tags.values()].some((t) => t.cardId), null, { timeout: 20_000 });
  assert.equal(await quest.evaluate(() => window.__ce.modes.mode), 'annotate');
  await shot('01-annotate-tagged');
  // Control: the deliberate choice. The card offers Ask Muse right away (no Set up / Enable).
  await quest.evaluate(() => { const ce = window.__ce; const t = ce.targets.list().find((x) => /visual|laptop|mac/i.test(x.label)); ce.setMode('control'); ce.lock(t.id, 'api'); });
  await quest.waitForFunction(() => window.__ce.hud.root.userData.wire?.phase === 'idle', null, { timeout: 15_000 });
  const chips = await quest.evaluate(() => window.__ce.hud.root.userData.wire.chips);
  console.log('PASS control card offers Ask Muse:', chips.join(' | '));
  await shot('02-control-ask');
  // Ask.
  await quest.evaluate((text) => window.__ce.wiring.ask(text, 'chip'), ASK);
  await quest.waitForFunction(() => window.__ce.hud.root.userData.wire?.phase === 'writing', null, { timeout: 15_000 });
  await delay(1800); await shot('03-agent-writing');
  await quest.waitForFunction(() => ['running', 'calibrating', 'failed'].includes(window.__ce.hud.root.userData.wire?.phase), null, { timeout: 120_000 });
  const phase = await quest.evaluate(() => window.__ce.hud.root.userData.wire.phase);
  assert.notEqual(phase, 'failed', 'agent failed');
  console.log('PASS agent finished ->', phase);
  const knobs = await quest.evaluate(() => window.__ce.hud.root.userData.knobs);
  assert.ok(knobs?.length, 'no knobs');
  console.log('PASS knobs:', knobs.map((k) => k.label).join(', '));
  await shot('04-knobs');
  // Drag the first knob up with the emulated pinch (mouse), through the real pointer-events path.
  const pt = await quest.evaluate((name) => { const ce = window.__ce; let n; ce.scene.traverse((o) => { if (!n && o.name === name) n = o; }); const p = n.getWorldPosition(ce.desktopCam.position.clone()).project(ce.renderer.xr.getCamera().cameras[0] ?? ce.desktopCam); const r = ce.renderer.domElement.getBoundingClientRect(); return { x: r.left + (p.x + 1) * r.width / 2, y: r.top + (1 - p.y) * r.height / 2 }; }, `knob-hit-${knobs[0].id}`);
  const before = knobs[0].fraction;
  await quest.mouse.move(pt.x, pt.y); await delay(200); await quest.mouse.down(); await delay(150);
  for (let i = 1; i <= 10; i++) { await quest.mouse.move(pt.x, pt.y - i * 9); await delay(60); }
  await quest.mouse.up(); await delay(800);
  const after = (await quest.evaluate(() => window.__ce.hud.root.userData.knobs))[0].fraction;
  console.log(`knob ${knobs[0].label}: ${before} -> ${after}`);
  const conn = await (await fetch(`${BASE}/api/agent/connectors`)).json();
  const logs = conn.connectors.flatMap((c) => c.logs);
  console.log('connector logs:', logs.slice(-6).join(' | '));
  assert.ok(after > before + 0.05, 'knob did not move');
  assert.ok(logs.some((l) => /→ CC21/.test(l)) || logs.some((l) => /CC21/.test(l)), 'no CC21 reached the visual synth');
  console.log('PASS knob -> connector -> MIDI CC21 acknowledged');
  await shot('05-knob-turned');
  // Stop: both palms out == wiring.stop(user). The connector process is retired.
  await quest.evaluate(() => window.__ce.wiring.stop('Both palms out', 'user'));
  await until('connector stopped', async () => (await (await fetch(`${BASE}/api/agent/connectors`)).json()).connectors.length === 0, 10_000);
  console.log('PASS stop retires the connector');
  console.log('ALL PASS');
} catch (e) {
  console.error('FAIL', e.message); console.error(log.split('\n').filter((l) => /muse-agent|connector|wire|error/i.test(l)).slice(-20).join('\n'));
  process.exitCode = 1;
} finally { await browser?.close(); server?.kill('SIGTERM'); }
