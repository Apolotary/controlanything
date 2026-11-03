/** Real browser encoder → take ZIP → local viewer → synchronized playback and dataset export.
 * Uses generated imagery/poses, an isolated static server and one muted Chrome. No headset or API calls.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'apps/companion/dist');
const screens = join(root, 'research/screens/tracking');
const temporary = await mkdtemp(join(tmpdir(), 'ce-tracking-e2e-'));
let browser, server;
const errors = [], outbound = [];
try {
  await stat(join(dist, 'tracking/index.html'));
  const compiled = await build({ configFile: false, logLevel: 'error',
    build: { write: false, minify: false, lib: { entry: join(root, 'scripts/fixtures/tracking-browser.ts'), name: 'TrackingTest', formats: ['iife'] } } });
  const bundle = (Array.isArray(compiled) ? compiled[0] : compiled).output.find((item) => item.type === 'chunk').code;
  server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (path === '/__encoder.js') { res.setHeader('content-type', 'text/javascript'); res.end(bundle); return; }
      if (!path.startsWith('/companion/')) { res.writeHead(404).end(); return; }
      const file = resolve(dist, `.${path.slice('/companion'.length)}${path.endsWith('/') ? 'index.html' : ''}`);
      if (!file.startsWith(`${dist}/`)) { res.writeHead(403).end(); return; }
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };
      res.setHeader('content-type', mime[extname(file)] ?? 'application/octet-stream'); res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, acceptDownloads: true });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => { if (/^https?:/.test(request.url()) && !request.url().startsWith(base)) outbound.push(request.url()); });
  await page.goto(`${base}/companion/tracking/`);
  await page.addScriptTag({ url: `${base}/__encoder.js` });
  assert.equal(await page.locator('#play').isDisabled(), true);
  assert.equal(await page.locator('#export-data').isDisabled(), true);
  const result = await page.evaluate(() => window.TrackingTest.recordFixture());
  assert(result.videoBytes > 1000, 'Real browser encoder must produce a video');
  assert(result.sharedTrackAlive, 'Stopping recorder must leave shared camera tracks alive');
  assert.deepEqual(result.warnings, []);
  const zip = join(temporary, 'browser-encoder-fixture.zip');
  await writeFile(zip, Buffer.from(result.bytes));
  await page.locator('#take-file').setInputFiles(zip);
  await page.waitForFunction(() => document.querySelector('#take-name').textContent === 'browser-encoder-fixture');
  await page.waitForFunction(() => document.querySelector('#recording-video').readyState >= 2);
  assert.match(await page.locator('#provenance-badge').textContent(), /emulat|synthetic/i);
  const scrub = async (time) => page.locator('#timeline').evaluate((el, value) => { el.value = String(value); el.dispatchEvent(new Event('input', { bubbles: true })); }, time);
  await scrub(150);
  assert.match(await page.locator('#left-status').textContent(), /25/);
  await scrub(450);
  await page.waitForFunction(() => /untracked|unavailable|no .*tracking/i.test(document.querySelector('#right-status').textContent));
  await scrub(980);
  await page.waitForFunction(() => /untracked|unavailable|no .*tracking/i.test(document.querySelector('#head-status').textContent));
  await scrub(0);
  await page.locator('#play').click();
  await page.waitForFunction(() => Number(document.querySelector('#timeline').value) > 200);
  await page.locator('#play').click();
  const sync = await page.evaluate(() => ({ t: Number(document.querySelector('#timeline').value), media: document.querySelector('#recording-video').currentTime * 1000,
    offset: Number(document.querySelector('#video-offset').value), muted: document.querySelector('#recording-video').muted, paused: document.querySelector('#recording-video').paused }));
  assert(Math.abs(sync.t - sync.offset - sync.media) < 180, `Video and take timeline diverged: ${JSON.stringify(sync)}`);
  assert(sync.muted && sync.paused);
  for (const view of ['pov', 'left', 'right', 'world']) {
    await page.locator(`[data-view="${view}"]`).click();
    assert.equal(await page.locator(`[data-view="${view}"]`).getAttribute('aria-pressed'), 'true');
  }
  await page.locator('#video-offset').fill('150');
  await page.locator('#video-offset').dispatchEvent('change');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export-data').click();
  const download = await downloadPromise;
  const exportFile = join(temporary, 'dataset.jsonl'); await download.saveAs(exportFile);
  const exported = (await readFile(exportFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(exported[0].dataset.poseSource, 'emulator');
  assert.equal(exported[0].video.startOffsetMs, 150);
  assert(exported.some((row) => row.kind === 'pose' && row.head === null));
  assert(exported.some((row) => row.kind === 'pose' && row.hands.right.source === 'untracked'));
  assert(new Set(exported.filter((row) => row.kind === 'pose').map((row) => row.spaceId)).size >= 2);
  assert(exported.some((row) => row.kind === 'event' && row.type === 'hack'));
  await mkdir(screens, { recursive: true });
  await scrub(750);
  await page.screenshot({ path: join(screens, '01-browser-recording.png'), fullPage: true });

  // A rejected play promise from the old video cannot poison the next take's state.
  await page.evaluate(() => {
    const media = document.querySelector('#recording-video');
    window.__originalTestPlay = media.play.bind(media);
    media.play = () => new Promise((resolve, reject) => { window.__rejectTestPlay = reject; });
  });
  await page.locator('#play').click();
  await page.waitForFunction(() => Boolean(window.__rejectTestPlay));
  await page.locator('#load-demo').click();
  await page.evaluate(async () => {
    window.__rejectTestPlay(new DOMException('Interrupted by source switch', 'AbortError'));
    document.querySelector('#recording-video').play = window.__originalTestPlay;
    await Promise.resolve(); await Promise.resolve();
  });
  assert.match(await page.locator('#load-status').textContent(), /Synthetic sample loaded/);

  // Invalid local data must recover gracefully; the explicit sample remains marked synthetic.
  await page.locator('#take-file').setInputFiles({ name: 'broken.jsonl', mimeType: 'text/plain', buffer: Buffer.from('not json') });
  await page.waitForFunction(() => /could|invalid|error|json|read/i.test(document.querySelector('#load-status').textContent));
  await page.locator('#load-demo').click();
  assert.equal(await page.locator('#demo-banner').isVisible(), true);
  await scrub(2000);
  await page.screenshot({ path: join(screens, '02-synthetic-sample.png'), fullPage: true });
  const sampleDownloadPromise = page.waitForEvent('download'); await page.locator('#export-data').click();
  const sampleDownload = await sampleDownloadPromise;
  const sampleFile = join(temporary, 'sample.jsonl'); await sampleDownload.saveAs(sampleFile);
  const sampleMeta = JSON.parse((await readFile(sampleFile, 'utf8')).split('\n')[0]);
  assert.equal(sampleMeta.dataset.synthetic, true);
  await page.setViewportSize({ width: 640, height: 900 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal page overflow at 640 px');
  await page.screenshot({ path: join(screens, '03-narrow.png'), fullPage: true });

  // A hidden viewer must stop its playback loop and video.
  await page.locator('#play').click();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  assert.match(await page.locator('#play').getAttribute('aria-label'), /play/i);
  assert.deepEqual(errors, []); assert.deepEqual(outbound, []);
  console.log(JSON.stringify({ ok: true, encodedVideoBytes: result.videoBytes, exportedSamples: exported.filter((row) => row.kind === 'pose').length,
    checks: ['real video encoder', 'shared camera retained', 'ZIP import', 'missing hand/head', 'space reset', 'video sync', 'four views', 'offset export', 'events', 'stale play cancellation', 'synthetic provenance', '640px layout', 'hidden pause', 'no external requests'], screenshots: screens }, null, 2));
} finally {
  await browser?.close();
  await new Promise((done) => server ? server.close(done) : done());
  await rm(temporary, { recursive: true, force: true });
}
