#!/usr/bin/env node
/** Read-only, silent Quest compositor mirror. No app reload and no headset input forwarding. */
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { JpegFrames } from './lib/mjpeg.mjs';

const port = Number(process.env.QUEST_LIVE_PORT ?? 8790);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid QUEST_LIVE_PORT');
// Debugging needs readable fresh frames, without running the Mac's JPEG converter at full speed.
const captureFps = Number(process.env.QUEST_LIVE_FPS ?? 6);
const captureWidth = Number(process.env.QUEST_LIVE_WIDTH ?? 960);
if (!Number.isInteger(captureFps) || captureFps < 1 || captureFps > 12) throw new Error('QUEST_LIVE_FPS must be 1–12');
if (!Number.isInteger(captureWidth) || captureWidth < 480 || captureWidth > 1600 || captureWidth % 2) throw new Error('QUEST_LIVE_WIDTH must be an even width from 480–1600');
const devices = execFileSync('adb', ['devices'], { encoding: 'utf8' }).split('\n')
  .map(line => line.match(/^(\S+)\s+device$/)?.[1]).filter(Boolean);
const serial = process.env.ANDROID_SERIAL ?? (devices.length === 1 ? devices[0] : undefined);
if (!serial || !devices.includes(serial)) throw new Error('Connect one authorized Quest over USB, or set ANDROID_SERIAL.');
execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
const outputDir = process.env.QUEST_LIVE_DIR ?? join(tmpdir(), 'ce-quest-live');
mkdirSync(outputDir, { recursive: true, mode: 0o700 });
const framePath = join(outputDir, 'latest.jpg');
const statusPath = join(outputDir, 'status.json');
const token = randomBytes(24).toString('hex');
const clients = new Set();
let capture, decoder, retry, stopping = false, generation = 0, ownsOutput = false;
let latest, sequence = 0, lastFrameAt = 0, startedAt = 0, lastError = '', connected = false;
let frameTimes = [];
const STALE_MS = 2500;
const status = () => ({ state: stopping ? 'stopped' : connected && lastFrameAt && Date.now() - lastFrameAt < STALE_MS ? 'live' : sequence ? 'stale' : 'connecting',
  connected, sequence, lastFrameAt: lastFrameAt || null, ageMs: lastFrameAt ? Date.now() - lastFrameAt : null,
  fps: frameTimes.length > 1 ? Math.round((frameTimes.length - 1) * 10000 / Math.max(1, frameTimes.at(-1) - frameTimes[0])) / 10 : 0,
  audio: false, control: false, error: lastError || null });
function framePart(frame) {
  return Buffer.concat([Buffer.from(`--questframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\nX-Sequence: ${sequence}\r\nX-Captured-At: ${lastFrameAt}\r\n\r\n`), frame, Buffer.from('\r\n')]);
}
function receiveFrame(frame) {
  if (stopping || Date.now() - lastFrameAt < 80) return;
  latest = frame; lastFrameAt = Date.now(); sequence++; connected = true; lastError = '';
  frameTimes.push(lastFrameAt); frameTimes = frameTimes.filter(t => lastFrameAt - t < 4000);
  writeFileSync(`${framePath}.next`, frame, { mode: 0o600 }); renameSync(`${framePath}.next`, framePath);
  writeFileSync(statusPath, JSON.stringify(status()), { mode: 0o600 });
  const part = framePart(frame);
  for (const client of clients) {
    // Never accumulate old video for a slow viewer. A later fresh frame is sent after drain.
    if (client.destroyed) clients.delete(client);
    else if (!client.writableNeedDrain && client.writableLength === 0) client.write(part);
  }
}
function stopChildren() {
  capture?.stdout.unpipe();
  for (const child of [capture, decoder]) {
    if (!child) continue;
    child.kill('SIGTERM');
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 1000);
    child.once('exit', () => clearTimeout(timeout));
  }
  capture = decoder = undefined; connected = false;
}
function restart(reason, run) {
  if (stopping || run !== generation) return;
  generation++; lastError = reason; stopChildren(); clearTimeout(retry);
  writeFileSync(statusPath, JSON.stringify(status()), { mode: 0o600 });
  retry = setTimeout(startCapture, 1500);
}
function startCapture() {
  if (stopping) return;
  const run = ++generation; startedAt = Date.now(); frameTimes = [];
  const parser = new JpegFrames(frame => { if (run === generation) receiveFrame(frame); });
  // Correct the left panel's optical cant on the Mac, preserving the entire eye view.
  const filter = `fps=${captureFps},crop=iw/2:ih:0:0,rotate=22*PI/180:ow=rotw(22*PI/180):oh=roth(22*PI/180):c=black,scale=${captureWidth}:-2`;
  decoder = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-flags', 'low_delay',
    '-probesize', '65536', '-analyzeduration', '0', '-f', 'h264', '-i', 'pipe:0', '-an', '-vf', filter,
    '-c:v', 'mjpeg', '-pix_fmt', 'yuvj420p', '-threads', '1', '-q:v', '4', '-f', 'image2pipe', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
  capture = spawn('adb', ['-s', serial, 'exec-out', 'screenrecord', '--size', '2560x1370', '--bit-rate', '8000000',
    '--time-limit', '0', '--output-format=h264', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
  decoder.stdout.on('data', data => parser.push(data));
  decoder.stdin.on('error', () => {});
  capture.stdout.pipe(decoder.stdin);
  for (const [name, child] of [['Headset capture', capture], ['Video decoder', decoder]]) {
    child.stderr.on('data', data => { if (run === generation) lastError = `${name}: ${String(data).trim().slice(-240)}`; });
    child.once('error', error => restart(`${name} failed: ${error.message}`, run));
    child.once('exit', code => restart(`${name} disconnected${code ? ` (${code})` : ''}`, run));
  }
}
const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quest live view · ControlAnything</title><style>
*{box-sizing:border-box}body{margin:0;background:#0d1117;color:#f8fafc;font:15px system-ui,sans-serif}header{display:flex;align-items:center;gap:18px;padding:16px 22px;background:#171d26;border-bottom:1px solid #ffffff20}h1{font-size:18px;margin:0}#state{color:#fbbf24}#state.live{color:#4ade80}#meta{color:#94a3b8;font-size:13px;flex:1}button,a{background:#283444;color:#f8fafc;border:1px solid #ffffff30;border-radius:8px;padding:9px 12px;text-decoration:none;cursor:pointer}main{height:calc(100vh - 72px);display:grid;place-items:center;position:relative}img{max-width:100%;max-height:100%;object-fit:contain}#notice{position:absolute;top:18px;padding:12px 18px;border-radius:10px;background:#151b25e8;color:#fbbf24}#notice[hidden]{display:none}
</style><header><h1>Quest live view</h1><strong id="state">Connecting</strong><span id="meta">USB · Silent · View only</span><a href="/frame.jpg" target="_blank">Current frame</a><button id="stop">Stop sharing</button></header>
<main><img id="view" alt="Live Quest passthrough and AR interface" src="/stream.mjpg"><div id="notice">Waiting for headset video…</div></main>
<script>
const state=document.querySelector('#state'),meta=document.querySelector('#meta'),notice=document.querySelector('#notice'),view=document.querySelector('#view');let ended=false,retryAt=0;
view.onerror=()=>{if(!ended){notice.hidden=false;notice.textContent='Video disconnected — reconnecting…';retryAt=Date.now()+1500;}};
async function update(){if(ended)return;try{const r=await fetch('/status',{cache:'no-store',signal:AbortSignal.timeout(2000)});if(!r.ok)throw Error();const s=await r.json();state.textContent=s.state==='live'?'Live':s.state==='connecting'?'Connecting':'Feed paused';state.className=s.state==='live'?'live':'';meta.textContent='USB · Silent · View only'+(s.state==='live'?' · '+s.fps+' fps':'');notice.hidden=s.state==='live';if(!notice.hidden)notice.textContent=s.ageMs===null?'Waiting for headset video…':'No fresh video — check that the headset is awake and USB is connected.';if(retryAt&&Date.now()>retryAt){view.src='/stream.mjpg?t='+Date.now();retryAt=0;}}catch{state.textContent='Disconnected';state.className='';notice.hidden=false;notice.textContent='The live viewer has stopped.';}setTimeout(update,700)}update();
document.querySelector('#stop').onclick=async()=>{try{const r=await fetch('/stop',{method:'POST',headers:{'X-Quest-Live-Token':'${token}'}});if(!r.ok)throw Error();ended=true;view.removeAttribute('src');state.textContent='Stopped';state.className='';notice.hidden=false;notice.textContent='Headset sharing stopped.';}catch{notice.hidden=false;notice.textContent='Could not stop sharing. Close the viewer process in its terminal.'}};
</script></html>`;
const server = createServer((req, res) => {
  const host = req.headers.host;
  if (![ `localhost:${port}`, `127.0.0.1:${port}` ].includes(host)) {
    res.writeHead(403).end('Local viewer only'); return;
  }
  const path = new URL(req.url, `http://${host}`).pathname;
  const topLevelNavigation = path === '/' && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
  if (req.headers['sec-fetch-site'] === 'cross-site' && !topLevelNavigation) {
    res.writeHead(403).end('Local viewer only'); return;
  }
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  if (path === '/' && req.method === 'GET') res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page);
  else if (path === '/status' && req.method === 'GET') res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(status()));
  else if (path === '/frame.jpg' && req.method === 'GET') {
    if (!latest || Date.now() - lastFrameAt >= STALE_MS) res.writeHead(503).end('No fresh headset frame');
    else res.writeHead(200, { 'Content-Type': 'image/jpeg', 'X-Sequence': String(sequence), 'X-Captured-At': String(lastFrameAt) }).end(latest);
  } else if (path === '/stream.mjpg' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=questframe', 'Connection': 'keep-alive' });
    res.flushHeaders(); clients.add(res); res.on('close', () => clients.delete(res));
    if (latest && Date.now() - lastFrameAt < STALE_MS) res.write(framePart(latest));
  } else if (path === '/stop' && req.method === 'POST' && req.headers['x-quest-live-token'] === token) {
    res.writeHead(200).end('Stopped'); setImmediate(shutdown);
  } else res.writeHead(404).end('Not found');
});
const watchdog = setInterval(() => {
  if (capture && Date.now() - Math.max(startedAt, lastFrameAt) > 12000) restart('No recent frames; reconnecting', generation);
  if (!stopping) writeFileSync(statusPath, JSON.stringify(status()), { mode: 0o600 });
}, 2000);
function shutdown() {
  if (stopping) return;
  stopping = true; generation++; clearTimeout(retry); clearInterval(watchdog); stopChildren();
  for (const client of clients) client.end(); clients.clear();
  if (ownsOutput) {
    writeFileSync(statusPath, JSON.stringify(status()), { mode: 0o600 });
    for (const path of [framePath, `${framePath}.next`]) { try { unlinkSync(path); } catch {} }
  }
  server.close(); server.closeAllConnections();
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
server.on('error', error => { console.error(error.message); shutdown(); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  ownsOutput = true;
  for (const path of [framePath, `${framePath}.next`]) { try { unlinkSync(path); } catch {} }
  writeFileSync(statusPath, JSON.stringify(status()), { mode: 0o600 });
  console.log(`Quest live viewer: http://localhost:${port}/`);
  console.log(`Current frame: ${framePath}\nStatus: ${statusPath}\nNo audio, no headset controls, no saved video. Ctrl-C stops sharing.`);
  startCapture();
});
