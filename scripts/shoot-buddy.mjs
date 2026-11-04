/**
 * Buddy screenshots in the Quest emulator (a dev helper, not a test). A fixture server must already run on PORT
 * (default 8799) with apps/quest built. MODE: flow (open, frame lit, holding, looking, thinking, reaction, sticker),
 * hand (a tracked hand in the frame), round (three quests + celebration), show (the Show button), exit (toggle + Stop).
 * Writes research/screens/buddy/. REACT_DELAY (ms) slows Muse's answer so "Thinking…" is visible.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'research/screens/buddy');
const BASE = `http://127.0.0.1:${process.env.PORT || 8799}`;
const MODE = process.argv[2] || 'flow';
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
context.setDefaultTimeout(30000);
await context.addInitScript(() => {
  window.__ceMute = true; window.__audioAttempts = 0;
  for (const key of ['AudioContext', 'webkitAudioContext']) if (window[key]) {
    window[key] = new Proxy(window[key], { construct() { window.__audioAttempts++; throw new Error('No audio'); } });
  }
});
const quest = await context.newPage();
const log = [];
quest.on('pageerror', (e) => log.push('PAGEERROR ' + (e.stack ?? e.message)));
quest.on('console', (m) => { const t = m.text(); if (m.type() === 'error' || /\[buddy\]/.test(t)) log.push(m.type() + ' ' + t); });
// make Muse "take its time" so Thinking… is visible
const REACT_DELAY = Number(process.env.REACT_DELAY || 4500);
await quest.route('**/api/buddy/react', async (route) => { await delay(REACT_DELAY); await route.continue(); });
await quest.goto(`${BASE}/quest/?emulate=1&camera=sim&mute=1&mic=0`, { waitUntil: 'domcontentloaded' });
await quest.waitForFunction(() => window.__ce?.welcome && window.__ce.ws.open && window.__ce.room?.sim?.canvas, undefined, { timeout: 60000 });
await quest.locator('#btn-enter').click();
await quest.waitForFunction(() => window.__ce.renderer.xr.isPresenting && window.__ce.cameraState === 'on', undefined, { timeout: 60000 });

const frames = async (n = 2) => {
  for (let i = 0; i < n; i++) {
    const t = await quest.evaluate(() => window.__ce.lastFrame?.time ?? 0);
    await quest.waitForFunction((p) => (window.__ce.lastFrame?.time ?? 0) > p, t, { polling: 50 });
  }
};
const shot = async (name, wait = 0) => {
  if (wait) await frames(wait);
  const canvas = await quest.evaluateHandle(() => window.__ce.renderer.domElement);
  await canvas.asElement().screenshot({ path: join(OUT, `${name}.png`) });
  await canvas.dispose();
  const s = await buddy();
  console.log(`SHOT ${name}: phase=${s.phase} frame=${s.frame.mode}/"${s.frame.label}"/${s.frame.progress.toFixed(2)} polaroid=${s.polaroid} bubble="${s.bubble}" meta="${s.meta}"`);
};
const buddy = () => quest.evaluate(() => window.__ce.buddy.state());
const until = async (what, fn, timeout = 20000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const r = await quest.evaluate(fn); if (r) return r; await delay(100); }
  throw new Error('timeout: ' + what + ' ' + JSON.stringify(await buddy()));
};

await delay(1500);
await frames(5);
await quest.evaluate(() => window.__ce.buddy?.state());
await shot('00-before');
// toggle Buddy through the wrist menu's own handler (same as key B)
await quest.keyboard.press('b');
await until('buddy open', () => window.__ce.buddy?.isOpen());
await delay(1200);
await shot('01-open');


const setSlow = (k) => quest.evaluate((k) => {
  const app = window.__ce;
  if (!app.__wrapped) { app.__wrapped = true; app.frameHooks.forEach((h, i) => { app.frameHooks[i] = (f, dt, t, x) => h(f, dt * (window.__slow ?? 1), t, x); }); }
  window.__slow = k;
}, k);
const hands = (poses, wait = 20) => quest.evaluate(async ({ poses, wait }) => {
  const app = window.__ce, remote = app.emulator.device.remote, head = app.emulator.head();
  app.input.mouseAsHand = false; app.input.pointer.inside = app.input.pointer.down = app.input.pointer.latched = false;
  await remote.dispatch('set_input_mode', { mode: 'hand' });
  const xyz = (v) => ({ x: v.x, y: v.y, z: v.z });
  for (const [side, { offset, pose, palm }] of Object.entries(poses)) {
    const device = `hand-${side}`;
    const position = head.position.clone().add(head.position.clone().fromArray(offset).applyQuaternion(head.quaternion));
    const palmDir = palm === 'out' ? head.position.clone().set(0, 0, -1).applyQuaternion(head.quaternion) : head.position.clone().sub(position).normalize();
    const fingers = head.position.clone().set(0, 1, 0).applyQuaternion(head.quaternion);
    fingers.addScaledVector(palmDir, -fingers.dot(palmDir)).normalize();
    await remote.dispatch('set_connected', { device, connected: true });
    await remote.dispatch('set_select_value', { device, value: 0 });
    await remote.dispatch('set_hand_pose', { device, poseId: pose });
    await remote.dispatch('set_transform', { device, anchor: 'wrist', position: xyz(position), orientation: { fingers: xyz(fingers), palm: xyz(palmDir) } });
  }
  await new Promise((r) => { let k = 0; const f = () => (++k >= wait ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
}, { poses, wait });

if (MODE === 'flow' || MODE === 'all') {
  const fps = await quest.evaluate(async () => { const t0 = performance.now(); const f0 = window.__ce.lastFrame?.time ?? 0; await new Promise((r) => setTimeout(r, 1500)); return { dtGame: (window.__ce.lastFrame?.time ?? 0) - f0, dtReal: performance.now() - t0 }; });
  console.log('clock', JSON.stringify(fps));
  await setSlow(0.3);
  await quest.evaluate(() => window.__ce.buddy.holdUp());
  await until('holding', () => window.__ce.buddy.state().phase === 'holding');
  await shot('02-frame-lit');
  await until('ring part', () => window.__ce.buddy.state().frame.progress > 0.5 || window.__ce.buddy.state().phase !== 'holding');
  await shot('03-holding');
  await setSlow(1);
  await until('thinking', () => window.__ce.buddy.state().phase === 'thinking');
  await shot('04-looking');
  await until('thinking text', () => window.__ce.buddy.state().bubble === 'Thinking…', 8000);
  await shot('05-thinking');
  await until('reacting', () => window.__ce.buddy.state().phase === 'reacting', 30000);
  await delay(900);
  await shot('06-reaction');
  await delay(500);
  await shot('07-sticker-flying');
  await until('shelf', () => window.__ce.buddy.state().polaroid === 'hidden', 15000);
  await shot('08-shelf');
  await delay(6000);
  await shot('09-after-sticker');
}
if (MODE === 'hand' || MODE === 'all') {
  await quest.evaluate(() => window.__ce.buddy.lower());
  await delay(500);
  // a real tracked hand (IWER) with its wrist a hand-length below the frame centre, fingers up into the frame
  const place = await quest.evaluate(() => {
    const app = window.__ce, head = app.emulator.head(), fp = app.buddy.state().frame.position;
    const rel = head.position.clone().fromArray(fp).sub(head.position).applyQuaternion(head.quaternion.clone().invert());
    return rel.toArray();
  });
  console.log('frame in head space', place.map((v) => +v.toFixed(3)));
  const off = [place[0], place[1] - 0.09, place[2]];
  await hands({ right: { offset: off, pose: 'open', palm: process.env.PALM === 'out' ? 'out' : 'in' } }, 30);
  const inFrame = await until('hand in frame', () => window.__ce.buddy.state().phase === 'holding' || window.__ce.buddy.state().phase === 'thinking' || window.__ce.buddy.state().phase === 'capturing', 8000).catch((e) => String(e));
  console.log('real hand presence ->', inFrame);
  await shot('10-real-hand-in-frame');
}
if (MODE === 'round' || MODE === 'all') {
  await quest.evaluate(() => window.__ce.buddy.lower());
  const quick = true;
  for (let i = 0; i < 3; i++) {
    const before = (await buddy()).done;
    await until('idle', () => ['idle'].includes(window.__ce.buddy.state().phase), 40000);
    await delay(1300);
    await quest.evaluate(() => window.__ce.buddy.holdUp());
    await until('holding', () => window.__ce.buddy.state().phase === 'holding', 15000);
    await until('reacting', () => window.__ce.buddy.state().phase === 'reacting', 40000);
    await quest.evaluate(() => window.__ce.buddy.lower());
    await delay(700);
    await shot(`20-round-${i + 1}-reaction`);
    console.log('round step', i + 1, JSON.stringify({ done: (await buddy()).done, kicker: (await buddy()).kicker }));
  }
  await delay(5500);
  await shot('21-celebration');
  await delay(2500);
  await shot('22-free-play');
}
if (MODE === 'show') {
  await quest.evaluate(() => window.__ce.buddy.holdUp());
  // stop the sim presence from auto-starting: put the picture in the frame, then press Show with the mouse (pinch)
  await until('holding', () => window.__ce.buddy.state().phase === 'holding', 8000).catch(() => null);
  await until('settled', () => ['reacting', 'idle'].includes(window.__ce.buddy.state().phase), 30000);
  await delay(1500);
  await quest.evaluate(() => window.__ce.buddy.lower());
  await until('idle', () => window.__ce.buddy.state().phase === 'idle', 20000);
  await delay(1500);
  const p = await quest.evaluate(() => {
    const app = window.__ce; let node = null;
    app.scene.traverse((o) => { if (!node && o.name === 'buddy-show') node = o; });
    const pos = node.getWorldPosition(app.desktopCam.position.clone());
    const ndc = pos.project(app.renderer.xr.getCamera().cameras[0] ?? app.desktopCam);
    const r = app.renderer.domElement.getBoundingClientRect();
    return { x: r.left + (ndc.x + 1) * r.width / 2, y: r.top + (1 - ndc.y) * r.height / 2 };
  });
  console.log('show button at', p);
  await quest.mouse.move(p.x - 8, p.y - 8); await frames(4); await quest.mouse.move(p.x, p.y); await frames(6);
  await quest.mouse.down(); await frames(3); await quest.mouse.up();
  await until('countdown', () => ['countdown', 'capturing', 'thinking'].includes(window.__ce.buddy.state().phase), 8000);
  await shot('40-show-countdown');
  await until('reacting', () => window.__ce.buddy.state().phase === 'reacting', 30000);
  console.log('show-button flow reached reacting:', (await buddy()).bubble);
}
if (MODE === 'exit' || MODE === 'all') {
  console.log('open?', await quest.evaluate(() => window.__ce.buddy.isOpen()));
  await quest.keyboard.press('b');
  await delay(600);
  console.log('after B open?', await quest.evaluate(() => window.__ce.buddy.isOpen()), (await buddy()).phase);
  await shot('30-closed-by-toggle');
  await quest.keyboard.press('b');
  await delay(900);
  console.log('reopened?', await quest.evaluate(() => window.__ce.buddy.isOpen()));
  await quest.keyboard.press('x');
  await delay(900);
  console.log('after Stop open?', await quest.evaluate(() => window.__ce.buddy.isOpen()), (await buddy()).phase);
  await shot('31-closed-by-stop');
}
console.log(JSON.stringify(await buddy(), null, 1).slice(0, 1500));
console.log(log.slice(-30).join('\n'));
await browser.close();
