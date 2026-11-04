/** Isolated no-credit rich-instrument golden paths. No live server, tabs or hardware. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCREENS = join(ROOT, 'research/screens/2026-11-04-instruments');
const PORT = Number(process.env.PORT || 8798), BASE = `http://127.0.0.1:${PORT}`;
let server, browser, log = '', page;
const until = async (what, probe, ms = 30000) => { const end = Date.now() + ms; for (;;) { const r = await probe(); if (r) return r; if (Date.now() > end) throw new Error(`timeout: ${what}`); await delay(150); } };
const receipt = [];
try {
 await mkdir(SCREENS, { recursive: true });
 const dataDir = await mkdtemp(join(tmpdir(), 'ce-instruments-'));
 server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: join(ROOT, 'apps/server'), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
  HTTP_PORT: String(PORT), HTTPS_PORT: '0', HTTP_HOST: '127.0.0.1', PUBLIC_HOST: '127.0.0.1', CE_DATA_DIR: dataDir, CE_AGENT_WORKSPACE: join(dataDir, 'muse-agent'), REMO_SEND: '0', MODEL_MODE: 'fixture', MODEL_API_KEY: '', CE_OSMO: 'mock',
  CE_DEMO: '1', CE_MAC_SILENT: '1', CE_MAC_LOCAL: '0', CE_REMO: '0', REMO_HOST: '', CE_TRUST_FIRST_DEVICE: '1', CE_TRUST_LOOPBACK: '1', CE_CONSOLE_APPROVE: '0', MUSE_REPLAY: '1', GEN3D_SKIN: '0', VITEST: '' } });
 for (const s of [server.stdout, server.stderr]) s.on('data', c => { log = (log + c).slice(-300000); });
 await until('server', () => log.includes('ControlAnything server '));
 browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
 const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } });
 const sim = await ctx.newPage(); await sim.goto(`${BASE}/sim/?mute=1`);
 page = await ctx.newPage(); page.on('pageerror', e => console.log('pageerror', e.message));
 await page.goto(`${BASE}/quest/?emulate=1&camera=sim&mute=1&mic=0&tutorial=0`);
 await page.waitForFunction(() => window.__ce?.ws?.open);
 await page.click('#btn-enter');
 await page.waitForFunction(() => window.__ce.targets.list().length >= 2, null, { timeout: 60000 });
 console.log('targets:', await page.evaluate(() => window.__ce.targets.list().map(t => ({ id: t.id, label: t.label }))));
 // Tag both observed fixture devices before turning away; untagged offscreen targets expire.
 for (const id of await page.evaluate(() => window.__ce.targets.list().map(t => t.id))) {
  await page.evaluate(id => window.__ce.lock(id, 'api'), id);
  await page.waitForFunction(id => !!window.__ce.modes.tags.get(id)?.cardId, id);
 }

 const shot = async name => { const handle = await page.evaluateHandle(() => window.__ce.renderer.domElement); await handle.asElement().screenshot({ path: join(SCREENS, `${name}.png`) }); };
 const point = async name => page.evaluate(name => { const ce = window.__ce, n = ce.scene.getObjectByName(name); if (!n) throw new Error('missing part '+name); const p = n.getWorldPosition(ce.desktopCam.position.clone()).project(ce.renderer.xr.getCamera().cameras[0] ?? ce.desktopCam); const r = ce.renderer.domElement.getBoundingClientRect(); return { x: r.left + (p.x + 1) * r.width / 2, y: r.top + (1 - p.y) * r.height / 2 }; }, name);
 const cases = [
  { id: 'op1', pattern: 'OP[- ]?1|keyboard|^synthesizer$', ask: 'Give me keys and colourful knobs for this OP-1 instrument', part: 'part_widget4.k4.face', ack: '→ note', press: true },
  { id: 'visual', pattern: 'laptop|mac|visual', ask: 'Give me knobs for ripples, warp and zoom', part: 'part_widget1.cap', ack: '→ CC21', press: false },
  { id: 'gimbal', pattern: 'laptop|mac|visual', ask: 'Write pan and tilt controls for the gimbal camera', part: 'part_widget0.cap', ack: '→ gimbal pan', press: false },
 ];
 for (const c of cases) {
  const targetId = await page.evaluate(pattern => { const ce = window.__ce; ce.setMode('annotate'); const t = ce.targets.list().find(t => new RegExp(pattern, 'i').test(t.label)); if (!t) throw new Error('no '+pattern); ce.lock(t.id, 'api'); return t.id; }, c.pattern);
  await page.waitForFunction(id => !!window.__ce.modes.tags.get(id)?.cardId, targetId);
  assert.equal(await page.evaluate(() => window.__ce.modes.mode), 'annotate');
  await page.evaluate(pattern => { const ce = window.__ce, t = ce.targets.list().find(t => new RegExp(pattern, 'i').test(t.label)); ce.setMode('control'); ce.lock(t.id, 'api'); if(t.anchor) ce.emulator.lookAt(t.anchor); }, c.pattern);
  await page.waitForFunction(() => window.__ce.hud.root.userData.wire?.phase === 'idle');
  const baselineDrawCalls = await page.evaluate(() => window.__ce.renderer.info.render.calls);
  await page.evaluate(ask => window.__ce.wiring.ask(ask, 'text'), c.ask);
  await page.waitForFunction(() => ['running', 'failed'].includes(window.__ce.hud.root.userData.wire?.phase), null, { timeout: 60000 });
  assert.equal(await page.evaluate(() => window.__ce.hud.root.userData.wire.phase), 'running');
  await page.waitForFunction(() => !!window.__ce.hud.root.userData.instrument);
  await page.evaluate(() => { const ce = window.__ce, p = ce.scene.getObjectByName('muse-instrument').position.clone(); ce.emulator.lookAt(p); });
  await page.evaluate(() => { const ce = window.__ce, group = ce.hud.root.getObjectByName('muse-instrument'), undo = []; let calls = 0; group.traverse(o => { if (!o.isMesh && !o.isLine) return; const prev = o.onBeforeRender; o.onBeforeRender = function(...args) { calls++; prev.apply(this, args); }; undo.push(() => { o.onBeforeRender = prev; }); }); const off = ce.addFrameHook(() => { group.userData.renderCalls = calls; calls = 0; }); window.__instrumentCaptureCleanup = () => { off(); for (const fn of undo) fn(); }; });
  await delay(350);
  const before = await page.evaluate(() => window.__ce.hud.root.userData.instrument.visualizerEvents);
  const opsBefore = (await (await fetch(`${BASE}/api/agent/connectors`)).json()).connectors.reduce((sum, c) => sum + c.ops, 0);
  const pt = await point(c.part);
  assert.ok(pt.x > 0 && pt.x < 1440 && pt.y > 0 && pt.y < 960, `offscreen ${c.id} ${JSON.stringify(pt)}`);
  await page.mouse.move(pt.x, pt.y); await delay(180); await page.mouse.down(); await delay(180);
  if (!c.press) for (let i = 1; i <= 10; i++) { await page.mouse.move(pt.x, pt.y - i * 7); await delay(45); }
  await page.mouse.up();
  if (c.id === 'visual') {
    const xy = await point('part_widget0.orb');
    await page.mouse.move(xy.x, xy.y); await page.mouse.down(); await delay(120);
    for (let i = 1; i <= 5; i++) { await page.mouse.move(xy.x + i * 6, xy.y - i * 5); await delay(60); }
    await page.mouse.up();
    await page.waitForFunction(() => { const a = window.__ce.hud.root.userData.instrument.visualizerActions; return a.cc22 > 0 && a.cc23 > 0; });
  }
  await until(c.id + ' connector ack', async () => { const j = await (await fetch(`${BASE}/api/agent/connectors`)).json(); return j.connectors.reduce((sum, c) => sum + c.ops, 0) > opsBefore && j.connectors.flatMap(c => c.logs).some(l => l.includes(c.ack)); });
  await page.waitForFunction(before => window.__ce.hud.root.userData.instrument.visualizerEvents > before, before);
  const info = await page.evaluate(() => ({ instrument: window.__ce.hud.root.userData.instrument, render: window.__ce.renderer.info.render, snapshot: window.__ce.wiring.snapshot(), codeMode: window.__ce.hud.root.userData.wire.card.mode, instrumentDrawCalls: window.__ce.hud.root.getObjectByName('muse-instrument').userData.renderCalls }));
  assert.ok(info.instrument.activeEffects > 0); assert.equal(info.codeMode, 'pill');
  await shot(`${c.id}-playing`);
  const connectors = (await (await fetch(`${BASE}/api/agent/connectors`)).json()).connectors;
  receipt.push({ case: c.id, baselineDrawCalls, ...info, logs: connectors.flatMap(c => c.logs).slice(-12) });
  console.log('PASS', c.id, JSON.stringify(info));
  await page.evaluate(() => { window.__instrumentCaptureCleanup?.(); window.__ce.wiring.stop('Both palms out', 'user'); });
  await until('connector stopped', async () => (await (await fetch(`${BASE}/api/agent/connectors`)).json()).connectors.length === 0);
 }
 await writeFile(join(SCREENS, 'receipt.json'), JSON.stringify(receipt, null, 2));
 console.log('ALL PASS: OP-1 key → note ack + visualization; visual CC → ripple; mock gimbal pan → ack; Stop cleanup.');
} catch (e) {
 console.error('FAIL', e.stack);
 console.error(log.split('\n').filter(l => /muse-agent|connector|wire|error/i.test(l)).slice(-25).join('\n'));
 if(page) { try { await page.screenshot({ path: join(SCREENS, 'failure.png') }); console.error('connector debug', JSON.stringify(await (await fetch(`${BASE}/api/agent/connectors`)).json())); console.error('debug', await page.evaluate(() => ({ wire: window.__ce?.hud.root.userData.wire, instrument: window.__ce?.hud.root.userData.instrument }))); } catch {} }
 process.exitCode = 1;
} finally { await browser?.close(); server?.kill('SIGTERM'); }
