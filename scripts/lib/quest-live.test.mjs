import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { JpegFrames } from './mjpeg.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  assert.notEqual(port, 8790, 'The offline test must never use the live viewer port');
  return port;
}

async function response(port, path, headers = {}, method = 'GET') {
  return new Promise((resolveResponse, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolveResponse({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(1500, () => req.destroy(new Error(`HTTP timeout: ${path}`)));
    req.on('error', reject);
    req.end();
  });
}

test('offline mirror streams fresh frames, reports capture loss, reconnects, and stops cleanly', { timeout: 20000 }, async () => {
  const port = await freePort();
  const dir = await mkdtemp(join(tmpdir(), 'ce-quest-live-test-'));
  const bin = join(dir, 'bin'), output = join(dir, 'output');
  await mkdir(bin); await mkdir(output);
  // This executable is the only adb the viewer can find first on PATH. The explicit
  // nonexistent real serial is an extra guard: no real headset is ever a fallback.
  const fakeAdb = `#!${process.execPath}
const { spawn } = require('node:child_process');
const { readFileSync, writeFileSync, appendFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2), dir = process.env.QUEST_TEST_DIR;
if (args.length === 1 && args[0] === 'devices') {
  console.log('List of devices attached\\noffline-test-quest\\tdevice'); process.exit(0);
}
if (args[0] !== '-s' || args[1] !== 'offline-test-quest' || args[2] !== 'exec-out' || args[3] !== 'screenrecord') process.exit(64);
const countPath = join(dir, 'starts');
let count = 0; try { count = Number(readFileSync(countPath, 'utf8')); } catch {}
writeFileSync(countPath, String(count + 1));
writeFileSync(join(dir, 'capture.pid'), String(process.pid));
appendFileSync(join(dir, 'children'), process.pid + '\\n');
let encoder, timer, stopping = false;
function stop() {
  if (stopping) return; stopping = true; clearTimeout(timer);
  if (!encoder) process.exit(0);
  encoder.kill('SIGTERM');
  setTimeout(() => encoder.kill('SIGKILL'), 500).unref();
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
// The second producer waits long enough to exercise the stale-frame threshold,
// then recovers naturally through the viewer's own restart logic.
timer = setTimeout(() => {
  encoder = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi',
    '-i', 'testsrc2=size=320x180:rate=12', '-an', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-tune', 'zerolatency', '-g', '12', '-pix_fmt', 'yuv420p', '-f', 'h264', 'pipe:1'],
    { stdio: ['ignore', 'inherit', 'inherit'] });
  appendFileSync(join(dir, 'children'), encoder.pid + '\\n');
  encoder.on('error', () => process.exit(1));
  encoder.on('exit', code => process.exit(stopping ? 0 : code ?? 1));
}, count ? 2100 : 0);
`;
  await writeFile(join(bin, 'adb'), fakeAdb); await chmod(join(bin, 'adb'), 0o700);
  const viewer = spawn(process.execPath, [join(root, 'scripts/quest-live.mjs')], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ANDROID_SERIAL: 'offline-test-quest',
      QUEST_LIVE_PORT: String(port), QUEST_LIVE_DIR: output, QUEST_TEST_DIR: dir },
  });
  const exited = once(viewer, 'exit');
  let log = '';
  viewer.stdout.on('data', data => { log += data; }); viewer.stderr.on('data', data => { log += data; });
  const until = async (label, probe, timeout = 7000) => {
    const deadline = Date.now() + timeout;
    let error;
    while (Date.now() < deadline) {
      if (viewer.exitCode !== null || viewer.signalCode !== null) throw new Error(`Viewer exited during ${label}: ${log}`);
      try { const result = await probe(); if (result) return result; } catch (caught) { error = caught; }
      await delay(60);
    }
    throw new Error(`Timed out: ${label}${error ? ` (${error.message})` : ''}\n${log}`);
  };
  const getStatus = async () => JSON.parse((await response(port, '/status')).body);
  const streamAbort = new AbortController();
  try {
    const initial = await until('initial synthetic frame', async () => {
      const value = await getStatus(); return value.state === 'live' && value.sequence >= 2 && value;
    });
    assert.equal(initial.audio, false); assert.equal(initial.control, false);
    assert.equal(initial.connected, true);
    const frame = await response(port, '/frame.jpg');
    assert.equal(frame.status, 200); assert.equal(frame.headers['content-type'], 'image/jpeg');
    assert.equal(frame.headers['cache-control'], 'no-store');
    assert.equal(frame.body.readUInt16BE(0), 0xffd8);
    assert.equal(frame.body.readUInt16BE(frame.body.length - 2), 0xffd9);
    assert(Number(frame.headers['x-sequence']) >= initial.sequence);
    assert(Number(frame.headers['x-captured-at']) >= initial.lastFrameAt);
    await access(join(output, 'latest.jpg'));
    const advancing = await until('frame sequence advances', async () => {
      const value = await getStatus(); return value.sequence > initial.sequence && value;
    });

    const stream = await fetch(`http://127.0.0.1:${port}/stream.mjpg`, {
      signal: AbortSignal.any([streamAbort.signal, AbortSignal.timeout(3000)]),
    });
    assert.match(stream.headers.get('content-type'), /multipart\/x-mixed-replace; boundary=questframe/);
    let streamed = 0;
    const parser = new JpegFrames(() => streamed++);
    const reader = stream.body.getReader();
    while (streamed < 2) {
      const value = await reader.read();
      assert.equal(value.done, false, 'MJPEG response must stay open');
      parser.push(Buffer.from(value.value));
    }
    await reader.cancel();

    assert.equal((await response(port, '/status', { Host: 'untrusted.example' })).status, 403);
    assert.equal((await response(port, '/frame.jpg', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await response(port, '/stop', {}, 'POST')).status, 404);
    const page = await response(port, '/', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' });
    assert.equal(page.status, 200, 'An explicit top-level navigation may open the local viewer');
    const token = page.body.toString().match(/'X-Quest-Live-Token':'([a-f0-9]+)'/)?.[1];
    assert(token, 'Stop sharing requires the per-process token embedded in its local page');

    // This PID belongs to the fake adb child created by this test, never real adb.
    const capturePid = Number(await readFile(join(dir, 'capture.pid'), 'utf8'));
    process.kill(capturePid, 'SIGTERM');
    await until('capture loss appears immediately in status', async () => {
      const value = await getStatus();
      const disk = JSON.parse(await readFile(join(output, 'status.json'), 'utf8'));
      return value.state === 'stale' && !value.connected && disk.state === 'stale';
    });
    await until('expired frame is rejected', async () => (await response(port, '/frame.jpg')).status === 503, 4000);
    const recovered = await until('synthetic capture recovers', async () => {
      const value = await getStatus(); return value.state === 'live' && value.sequence > advancing.sequence && value;
    });
    assert.equal(recovered.error, null);
    assert.equal(Number(await readFile(join(dir, 'starts'), 'utf8')), 2, 'One failure must schedule exactly one new capture');
    assert.equal((await response(port, '/stop', { 'X-Quest-Live-Token': token }, 'POST')).status, 200);
    const [code, signal] = await Promise.race([exited, delay(3000, undefined, { ref: false }).then(() => { throw new Error('Viewer did not exit after Stop'); })]);
    assert.equal(code, 0); assert.equal(signal, null);
    assert.equal(JSON.parse(await readFile(join(output, 'status.json'), 'utf8')).state, 'stopped');
    await assert.rejects(access(join(output, 'latest.jpg')), { code: 'ENOENT' });
    await assert.rejects(access(join(output, 'latest.jpg.next')), { code: 'ENOENT' });
  } finally {
    streamAbort.abort();
    if (viewer.exitCode === null && viewer.signalCode === null) {
      viewer.kill('SIGTERM');
      await Promise.race([exited, delay(1500, undefined, { ref: false })]);
      if (viewer.exitCode === null && viewer.signalCode === null) viewer.kill('SIGKILL');
    }
    // Only fixtures recorded in this test's private temporary directory are eligible.
    const children = (await readFile(join(dir, 'children'), 'utf8').catch(() => '')).trim().split('\n').map(Number).filter(Number.isInteger);
    for (const pid of children) { if (pid > 1) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } } }
    await rm(dir, { recursive: true, force: true });
  }
});
