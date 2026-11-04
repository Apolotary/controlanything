/** Current Buddy screenshots on an already-running FIXTURE server, never a physical camera.
 * PORT=8801 node scripts/shoot-buddy.mjs
 * Open -> held object does not capture -> explicit preview -> retake -> virtual object -> Show -> reaction.
 */
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = `http://127.0.0.1:${Number(process.env.PORT || 8801)}`, OUT = join(ROOT, 'research/screens/buddy');
await mkdir(OUT, { recursive: true });
const health = await (await fetch(`${BASE}/api/health`)).json();
if (health.mode !== 'fixture') throw new Error('Buddy screenshot helper only runs on a separate fixture server.');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const sim = await context.newPage(); await sim.goto(`${BASE}/sim/?mute=1`);
  const quest = await context.newPage(); await quest.goto(`${BASE}/quest/?emulate=1&camera=sim&mute=1&mic=0&tutorial=0`);
  await quest.waitForFunction(() => window.__ce?.ws?.open && window.__ce.buddy, null, { timeout: 30_000 });
  await quest.click('#btn-enter'); await quest.waitForFunction(() => window.__ce.cameraState === 'on', null, { timeout: 30_000 });
  const shot = async name => { await delay(800); const canvas = await quest.evaluateHandle(() => window.__ce.renderer.domElement); await canvas.asElement().screenshot({ path: join(OUT, name + '.png') }); await canvas.dispose(); };
  await quest.evaluate(() => { window.__ce.input.mouseAsHand = false; window.__ce.buddy.open(); }); await shot('01-open');
  await quest.evaluate(() => window.__ce.buddy.holdUp()); await delay(1300);
  const phase = await quest.evaluate(() => window.__ce.buddy.state().phase);
  if (phase !== 'idle') throw new Error('An object still auto-captures without an explicit press.');
  await quest.evaluate(() => window.__ce.buddy.show()); await quest.waitForFunction(() => window.__ce.buddy.state().phase === 'preview'); await shot('02-camera-preview');
  await quest.evaluate(() => { window.__ce.buddy.retake(); window.__ce.buddy.showVirtual(); }); await shot('03-virtual-preview');
  await quest.evaluate(() => window.__ce.buddy.show()); await quest.waitForFunction(() => window.__ce.buddy.state().phase === 'reacting', null, { timeout: 30_000 }); await shot('04-reaction');
  await quest.evaluate(() => window.__ce.buddy.wave()); await shot('05-wave');
  console.log('Buddy preview/reaction screenshots saved; verified in the emulator.');
} finally { await browser.close(); }
