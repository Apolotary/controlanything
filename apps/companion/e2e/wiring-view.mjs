/**
 * The Mac's code view for Muse's wiring, in a real Chrome. Own silent fixture server on PORT (default 8798), the real
 * companion at /companion/?visuals=1&inject=1 (paired Mac identity); wire.progress / wire.ready are injected into the
 * page the way the server would send them (validated by the protocol schemas, nothing goes on the wire), then:
 *   - the full-screen visuals show the code streaming in a corner overlay and let it go ~8 s after ready;
 *   - the calm card has one status line, a source chip and a See code toggle;
 *   - Details has a Wiring tab with the code, model, source and phase notes;
 *   - nothing in the card or the tab is rebuilt when nothing changed (MutationObserver).
 * Then ?replay=wire plays the scripted run end to end. Screenshots: research/screens/wiring-view/.
 *
 *   npm run build -w @ce/companion   then   node apps/companion/e2e/wiring-view.mjs
 *
 * Silent (audio constructors throw). Requires sockets and Chrome (system, no download).
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openMacBrowser, pairMac, ROOT, startFixtureServer } from './harness.mjs';

const OUT = join(ROOT, 'research/screens/wiring-view');
const PORT = Number(process.env.PORT || 8798);
const CODE = `// Touch the water: your fingertip on the screen drives the ripples.
var f = s.screen;
if (!f || !f.inside) { out.set('cc24', 0); return; }
mem.x = mem.x === undefined ? f.u : mem.x + (f.u - mem.x) * 0.6;
mem.y = mem.y === undefined ? f.v : mem.y + (f.v - mem.y) * 0.6;
out.set('cc22', mem.x * 127);
out.set('cc23', mem.y * 127);
// hovering (1-20) grows a glow, touching (21+) splashes
out.set('cc24', f.touching ? 100 : Math.round(f.hover * 20));
`;
let fixture, mac;

const inject = (page, type, payload) => page.evaluate(([type, payload]) => {
  const ok = window.__ceInject({ v: 1, type, id: `e2e-${type}-${Math.random().toString(36).slice(2)}`, ts: Date.now(), from: 'server', payload });
  if (!ok) throw Error(`the page refused ${type}`);
}, [type, payload]);
const visible = (page, selector) => page.locator(selector).evaluate((node) => { const s = getComputedStyle(node); return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.5 && !node.hidden; });

try {
  await mkdir(OUT, { recursive: true });
  fixture = await startFixtureServer(PORT, 'wiring-view');
  const identity = await pairMac(fixture, 'Wiring-view fixture Mac');
  mac = await openMacBrowser(identity);
  const page = await mac.newPage();
  const CARD = `visual-synth-${identity.deviceId}`;
  const wire = { cardId: CARD, wiringId: 'wire-e2e-1', model: 'muse-spark-1.3', source: 'fixture' };
  await page.goto(`${fixture.base}/companion/?visuals=1&inject=1`);
  await page.locator('#visual-launcher canvas').waitFor({ state: 'visible' });
  await page.waitForFunction(() => typeof window.__ceInject === 'function');
  assert.equal(await page.locator('.visual-launcher-code.show').count(), 0, 'no overlay before any wiring');

  // 1. Muse writes: the code streams into the corner overlay on the full-screen visuals.
  await inject(page, 'device.card', { cardId: CARD, name: 'ControlAnything Visual Synth', maker: 'ControlAnything', model: 'Visual synth', category: 'computer', confidence: .95, protocols: ['midi'], evidence: ['Mac screen'], requires: ['midi'] });
  await inject(page, 'wire.progress', { ...wire, phase: 'writing', request: 'Let me touch the water', code: '' });
  const chunk = 14;
  let streamed = '';
  for (let i = 0; i < CODE.length; i += chunk) {
    streamed += CODE.slice(i, i + chunk);
    await inject(page, 'wire.progress', { ...wire, phase: 'writing', codeDelta: CODE.slice(i, i + chunk) });
    await delay(40);
    if (i === chunk * 12) await page.screenshot({ path: join(OUT, 'visuals-overlay-writing.png') });
  }
  await page.locator('.visual-launcher-code.show').waitFor({ state: 'attached' });
  assert(await visible(page, '.visual-launcher-code'), 'the overlay shows while the code is written');
  assert.equal(await page.locator('.visual-launcher-code-pre').textContent(), CODE);
  assert.match(await page.locator('.visual-launcher-code-head').textContent(), /^muse-spark-1\.3 is wiring your hands to the Visual synth$/);
  assert(['pointer-events'].every((p) => true));
  assert.equal(await page.locator('.visual-launcher-code').evaluate((node) => getComputedStyle(node).pointerEvents), 'none', 'the overlay never intercepts the finger');
  const overlayBox = await page.locator('.visual-launcher-code').boundingBox();
  assert(overlayBox.x < 100 && overlayBox.y < 120 && overlayBox.width < 460, `a corner overlay, got ${JSON.stringify(overlayBox)}`);
  assert(overlayBox.height < 330, 'about 14 lines of small monospace');

  for (const [phase, extra] of [['validating', { note: 'checked against the verified driver' }], ['dry-run', { note: 'dry-run ✓ 120 frames · 3 actions' }], ['verifying', {}]]) {
    await inject(page, 'wire.progress', { ...wire, phase, ...extra }); await delay(120);
  }
  await inject(page, 'wire.progress', { ...wire, phase: 'ready', title: 'Touch the water', note: 'armed' });
  await inject(page, 'wire.ready', { ...wire, code: CODE, title: 'Touch the water', explanation: 'Your fingertip on the Mac screen splashes ripples where it lands and drags a wake behind it; hovering makes a soft glow.', needs: ['screen'],
    actions: [{ actionId: 'cc22', label: 'Touch X', kind: 'set', min: 0, max: 127 }, { actionId: 'cc23', label: 'Touch Y', kind: 'set', min: 0, max: 127 }, { actionId: 'cc24', label: 'Touch pressure', kind: 'set', min: 0, max: 127 }] });
  const readyAt = Date.now();
  await delay(500);
  assert.match(await page.locator('.visual-launcher-code-head').textContent(), /^Wiring ready: Touch the water$/);
  assert(await visible(page, '.visual-launcher-code'), 'the overlay stays up after ready');
  await page.screenshot({ path: join(OUT, 'visuals-overlay-ready.png') });
  // ~8 s after ready it lets go (a repeated message must not extend it)
  await delay(Math.max(0, 6000 - (Date.now() - readyAt)));
  await inject(page, 'wire.progress', { ...wire, phase: 'ready', title: 'Touch the water', note: 'armed' }); // a repeat
  assert(await visible(page, '.visual-launcher-code'), 'still up at ~6 s');
  await delay(Math.max(0, 9200 - (Date.now() - readyAt)));
  assert.equal(await page.locator('.visual-launcher-code.show').count(), 0, 'the overlay is gone ~8 s after ready');
  assert(!(await visible(page, '.visual-launcher-code')));
  await page.screenshot({ path: join(OUT, 'visuals-after-hide.png') });

  // 2. The calm card: one line, a source chip, a See code toggle.
  await page.getByRole('button', { name: 'Back to companion', exact: true }).click();
  await page.locator('#wiring-card').waitFor({ state: 'visible' });
  assert.equal((await page.locator('#wiring-line').textContent()).trim(), 'Wiring ready: Touch the water');
  assert.equal(await page.locator('#wiring-chip').textContent(), 'FIXTURE');
  assert.equal(await page.locator('#wiring-toggle').textContent(), 'See code');
  assert(!(await page.locator('#wiring-code').isVisible()), 'the code is hidden until asked');
  await page.screenshot({ path: join(OUT, 'card-ready.png') });
  await page.locator('#wiring-toggle').click();
  await page.locator('#wiring-code').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#wiring-code').textContent(), CODE);
  assert.equal(await page.locator('#wiring-toggle').textContent(), 'Hide code');
  await page.screenshot({ path: join(OUT, 'card-code-open.png') });

  // 3. Idempotent: the same state again, unrelated updates and a quiet second change nothing in the card or the tab.
  await page.evaluate(() => {
    window.__mutations = [];
    const watch = new MutationObserver((records) => { for (const r of records) window.__mutations.push(`${r.type}:${r.target.id || r.target.className || r.target.nodeName}`); });
    for (const id of ['wiring-card']) watch.observe(document.getElementById(id), { subtree: true, childList: true, characterData: true, attributes: true });
    watch.observe(document.getElementById('wiring'), { subtree: true, childList: true, characterData: true, attributes: true });
  });
  await inject(page, 'wire.progress', { ...wire, phase: 'ready', title: 'Touch the water', note: 'armed' });
  await inject(page, 'wire.ready', { ...wire, code: CODE, title: 'Touch the water', explanation: 'Your fingertip on the Mac screen splashes ripples where it lands and drags a wake behind it; hovering makes a soft glow.', needs: ['screen'],
    actions: [{ actionId: 'cc22', label: 'Touch X', kind: 'set', min: 0, max: 127 }, { actionId: 'cc23', label: 'Touch Y', kind: 'set', min: 0, max: 127 }, { actionId: 'cc24', label: 'Touch pressure', kind: 'set', min: 0, max: 127 }] });
  await inject(page, 'agent.step', { stepId: 'idle-1', phase: 'verify', status: 'ok', title: 'unrelated step', cardId: 'some-other-card' });
  await delay(2500);
  const mutations = await page.evaluate(() => window.__mutations);
  assert.deepEqual(mutations, [], `the wiring card and tab were touched without a change: ${mutations.slice(0, 5)}`);

  // 4. Details: a Wiring tab next to Driver with the current code, model, source and phase notes.
  await page.locator('#simple-details').click();
  await page.locator('#drawer').waitFor({ state: 'visible' });
  const tabs = await page.locator('#drawer [role=tab]').allTextContents();
  assert.deepEqual(tabs, ['Driver', 'Wiring', 'Recording', 'Spec']);
  assert.equal(await page.locator('#tab-wiring').getAttribute('aria-selected'), 'true', 'the tab follows the new wiring');
  await page.locator('#wiring').waitFor({ state: 'visible' });
  const details = await page.locator('#wiring').textContent();
  for (const text of ['Touch the water', 'You asked: “Let me touch the water”', 'muse-spark-1.3', 'FIXTURE', 'ready', 'screen calibration', 'Touch X, Touch Y, Touch pressure', 'checked against the verified driver', 'dry-run ✓ 120 frames · 3 actions']) assert(details.includes(text), `Details lacks "${text}"`);
  assert.equal(await page.locator('#wiring-source').textContent(), CODE);
  await page.screenshot({ path: join(OUT, 'details-wiring.png') });
  await page.locator('#tab-code').click();
  assert(!(await page.locator('#wiring').isVisible()));
  await page.locator('#tab-wiring').click();
  assert(await page.locator('#wiring').isVisible());

  // 5. A template wiring says so.
  await inject(page, 'wire.progress', { ...wire, wiringId: 'wire-e2e-2', model: 'template', source: 'template', phase: 'writing', code: '// template' });
  await page.locator('#simple-back').click();
  await delay(300);
  assert.equal((await page.locator('#wiring-line').textContent()).trim(), 'Template wiring for the Visual synth (no Meta model wrote this)…');
  assert.equal(await page.locator('#wiring-chip').textContent(), 'Template');
  await page.screenshot({ path: join(OUT, 'card-template.png') });

  // 6. ?replay=wire plays the scripted run: the card and the Wiring tab fill in on their own.
  const replay = await mac.newPage();
  await replay.goto(`${fixture.base}/companion/?replay=wire`);
  await replay.locator('#wiring-card').waitFor({ state: 'visible', timeout: 10_000 });
  await delay(2500);
  await replay.screenshot({ path: join(OUT, 'replay-wire-writing.png') });
  await replay.waitForFunction(() => /^Wiring ready/.test(document.getElementById('wiring-line').textContent), undefined, { timeout: 30_000 });
  await delay(400);
  await replay.screenshot({ path: join(OUT, 'replay-wire-ready.png') });
  assert.equal(await replay.locator('#wiring-chip').textContent(), 'FIXTURE');

  assert.equal(await page.evaluate(() => window.__audioAttempts), 0);
  assert.deepEqual(mac.errors, []);
  await writeFile(join(OUT, 'report.json'), JSON.stringify({ overlayBox, tabs, mutationsWhileIdle: mutations.length }, null, 2));
  console.log('PASS wiring view: overlay streams and hides ~8 s after ready, calm card line/chip/See code, Details Wiring tab, idempotent DOM, ?replay=wire');
} catch (error) {
  console.error('FAIL', error); process.exitCode = 1;
} finally {
  await mac?.browser.close();
  await fixture?.stop();
  if (mac?.errors.length) console.error('browser errors:', mac.errors.slice(0, 5));
}
