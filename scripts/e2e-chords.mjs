/**
 * Chord Garden: authored preset → explicit preview/audio unlock → real HUD pad input.
 * Own silent fixture server on 8803/8453; run serialized after npm run build.
 * Chrome runs headless with --mute-audio: actual WebAudio nodes execute, no audible test.
 * No physical headset, microphone, camera, MIDI, live model or hardware executor is used.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createConnection } from 'node:net';
import { chromium } from 'playwright-core';
import WebSocket from 'ws';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'research/screens/chords');
const BASE = 'http://127.0.0.1:8803';
const CHORDS = [
  { id: 'chord_c', label: 'Cmaj7', notes: [60, 64, 67, 71] },
  { id: 'chord_am', label: 'Am7', notes: [57, 60, 64, 67] },
  { id: 'chord_f', label: 'Fmaj7', notes: [53, 57, 60, 64] },
  { id: 'chord_g', label: 'G7', notes: [55, 59, 62, 65] },
];
let server, browser, dataDir, observer, studio, quest;
let log = '', phase = 'startup';
const messages = [], pageErrors = [], previousSentTypes = [];

async function until(label, fn, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (server && (server.exitCode !== null || server.signalCode !== null)) throw new Error(`Server exited: ${log.slice(-3000)}`);
    const value = await fn(); if (value) return value;
    await delay(75);
  }
  throw new Error(`Timed out: ${label}`);
}
async function freePort(port) {
  await new Promise((yes, no) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); no(new Error(`Port ${port} occupied; run this check serially`)); });
    socket.once('error', e => e.code === 'ECONNREFUSED' ? yes() : no(e));
    socket.setTimeout(1500, () => { socket.destroy(); no(new Error(`Port ${port} probe timed out`)); });
  });
}
async function json(path, body) {
  const r = await fetch(`${BASE}${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) } : { signal: AbortSignal.timeout(3000) });
  assert(r.ok, `${path}: ${r.status}`); return r.json();
}
async function identity(kind, name) {
  const p = await json('/api/pair/start', { kind, name });
  const s = p.deviceToken ? p : await json(`/api/pair/status?pairingId=${encodeURIComponent(p.pairingId)}&pollSecret=${encodeURIComponent(p.pollSecret)}`);
  assert.equal(s.status, 'approved');
  return { deviceId: s.deviceId, deviceToken: s.deviceToken, kind, name };
}
function send(type, payload) {
  observer.send(JSON.stringify({ v: 1, type, id: `e2e-${crypto.randomUUID()}`, ts: Date.now(), from: '', to: 'server', payload }));
}
const latest = id => messages.findLast(m => m.type === 'project.state' && (!id || m.payload.projectId === id))?.payload;
async function frames(count = 3) {
  for (let i = 0; i < count; i++) {
    const t = await quest.evaluate(() => window.__ce.lastFrame?.time ?? 0);
    await quest.waitForFunction(t => window.__ce.lastFrame?.time > t, t);
  }
}
async function pinch(name, holdFrames = 3) {
  await quest.evaluate(name => {
    const app = window.__ce, node = app.hud.root.getObjectByName(name);
    if (!node) throw Error(`Missing ${name}`);
    app.emulator.lookAt(node.getWorldPosition(app.desktopCam.position.clone()));
  }, name);
  await frames(5);
  const point = await quest.evaluate(name => {
    const app = window.__ce, node = app.hud.root.getObjectByName(name);
    for (let n = node; n; n = n.parent) if (!n.visible) throw Error(`Hidden ${name}`);
    const camera = app.renderer.xr.getCamera().cameras[0];
    const point = node.getWorldPosition(app.desktopCam.position.clone()).project(camera);
    const rect = app.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + (point.x + 1) * rect.width / 2, y: rect.top + (1 - point.y) * rect.height / 2 };
  }, name);
  await quest.mouse.move(point.x, point.y); await quest.mouse.down();
  try { await frames(holdFrames); } finally { await quest.mouse.up(); }
  await frames(3);
}
async function shot(name, page = studio) {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
}
function watch(page, label) {
  page.on('pageerror', e => { pageErrors.push(`${label}: ${e.message}`); log += `\n${label} ERROR: ${e.stack ?? e.message}`; });
}
async function installEvidence(context) {
  await context.addInitScript(() => {
    if (window !== window.top) return;
    window.__chordSentTypes = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try { const message = JSON.parse(data); if (typeof message.type === 'string') window.__chordSentTypes.push(message.type); } catch { /* Non-JSON traffic is not part of this audit. */ }
      return send.call(this, data);
    };
    window.__chordAudioStarts = [];
    // Observe real oscillator construction/start. This does not replace WebAudio
    // or bypass browser gesture activation; Chrome's output is muted at launch.
    if (typeof AudioContext !== 'undefined') {
      const create = AudioContext.prototype.createOscillator;
      AudioContext.prototype.createOscillator = function (...args) {
        const context = this, oscillator = create.apply(this, args), start = oscillator.start;
        const schedule = oscillator.frequency.setValueAtTime;
        let scheduledFrequency, frequencyScheduledAt;
        oscillator.frequency.setValueAtTime = function (value, time) {
          const result = schedule.call(this, value, time);
          scheduledFrequency = value; frequencyScheduledAt = time;
          return result;
        };
        oscillator.start = function (...times) {
          // AudioParam.value can still expose its default before the next audio
          // quantum. Record the successfully scheduled native automation and
          // keep the immediate getter value as a diagnostic, not pitch evidence.
          window.__chordAudioStarts.push({ scheduledFrequency, frequencyScheduledAt,
            observedFrequencyAtStart: oscillator.frequency.value, contextState: context.state,
            when: context.currentTime, startAt: times[0] ?? context.currentTime });
          return start.apply(this, times);
        };
        return oscillator;
      };
    }
  });
}
const audioStarts = () => studio.evaluate(() => window.__chordAudioStarts);
async function enableAudio(id) {
  await studio.locator('#chord-audio-enable').click();
  await studio.waitForFunction(() => window.__museCanvas.chordSynth.enabled);
  await until('audio-ready preview lease', () => latest(id)?.preview?.count === 1);
}
async function waitQuestReady(ready) {
  await quest.waitForFunction(ready => window.__ce.projects.ready === ready, ready);
}

try {
  await mkdir(OUT, { recursive: true });
  await freePort(8803); await freePort(8453);
  dataDir = await mkdtemp(join(tmpdir(), 'ce-chords-'));
  server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: join(ROOT, 'apps/server'), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      HTTP_PORT: '8803', HTTPS_PORT: '8453', HTTP_HOST: '127.0.0.1', HTTPS_HOST: '127.0.0.1', PUBLIC_HOST: '127.0.0.1',
      CE_DATA_DIR: dataDir, MODEL_MODE: 'fixture', MODEL_API_KEY: '', CE_MAC_SILENT: '1', CE_MAC_LOCAL: '0',
      CE_REMO: '0', REMO_HOST: '', REMO_SEND: '0', CE_TRUST_FIRST_DEVICE: '1', CE_TRUST_LOOPBACK: '1',
      CE_CONSOLE_APPROVE: '0', MUSE_REPLAY: '1', MUSE_RECORD: '0', MUSE_RECORD_DIR: '', FIXTURE_DELAY_MS: '150', GEN3D_SKIN: '0', VITEST: '' },
  });
  server.on('error', e => { log += `\nSERVER START ERROR: ${e.message}`; });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', b => { log = (log + b).slice(-200000); });
  await until('server startup', () => log.includes('ControlAnything server '));
  assert.equal((await json('/api/health')).mode, 'fixture');
  const mac = await identity('mac', 'Chord fixture Mac');
  observer = new WebSocket(`${BASE.replace('http', 'ws')}/ws`);
  observer.on('message', data => messages.push(JSON.parse(String(data))));
  await new Promise((yes, no) => { observer.once('open', yes); observer.once('error', no); });
  send('hello', { deviceToken: mac.deviceToken, app: 'chord-e2e-observer', executor: false });
  await until('observer welcome', () => messages.find(m => m.type === 'welcome'));
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'] });
  const macContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  macContext.setDefaultTimeout(30_000); await installEvidence(macContext);
  await macContext.addInitScript(id => { if (window === window.top) localStorage.setItem('ce.device', JSON.stringify(id)); }, mac);
  studio = await macContext.newPage(); watch(studio, 'MAC');
  await studio.goto(`${BASE}/companion/canvas/`);

  phase = 'preset-without-generation';
  await studio.locator('#project-chord-demo').click();
  const created = await until('authored chord preset', () => messages.find(m => m.type === 'project.state' && m.payload.document?.presetId === 'chord-garden-v1')?.payload);
  const document = created.document, id = document.projectId;
  assert.equal(document.source, 'preset'); assert.equal(document.revision, 1);
  assert.deepEqual(document.spec.actions.map(a => a.id), [...CHORDS.map(c => c.id), 'silence']);
  assert.equal(await studio.locator('#project-preview').count(), 0, 'Creating a preset does not run it');
  assert.equal((await json('/api/muse/calls')).calls.length, 0, 'Authored preset does not call Muse');
  assert.match(await studio.locator('#project-provenance').textContent(), /Built-in demo/);
  assert.equal((await audioStarts()).length, 0);
  await shot('01-authored-chord-demo');

  phase = 'explicit-preview-and-audio';
  await studio.locator('#project-run').click();
  await studio.waitForFunction(() => window.__museCanvas.runtime.ready);
  assert.equal(latest(id)?.preview?.count, 0, 'Visual runtime alone does not advertise audible readiness');
  assert.equal(await studio.evaluate(() => window.__museCanvas.chordSynth.enabled), false);
  assert.equal((await audioStarts()).length, 0, 'Run cannot play sound');
  assert.equal(await studio.locator('#project-preview').getAttribute('sandbox'), 'allow-scripts');
  const preview = await (await studio.locator('#project-preview').elementHandle()).contentFrame();
  await preview.waitForFunction(() => !!window.museCanvas);
  const questContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  questContext.setDefaultTimeout(30_000); await installEvidence(questContext);
  quest = await questContext.newPage(); watch(quest, 'QUEST');
  await quest.goto(`${BASE}/quest/?emulate=1&camera=sim&mute=1&mic=0&hud=v2&yolo=0`);
  await quest.waitForFunction(() => window.__ce?.welcome && window.__ce.ws.open);
  await quest.locator('#btn-enter').click();
  await quest.waitForFunction(() => window.__ce.renderer.xr.isPresenting);
  // Muse Canvas is a lab feature (headset: ?lab=1 → palette "More (lab)"); open it through its HUD event.
  await quest.evaluate(() => window.__ce.hud.events.emit('projectsOpen', {}));
  await quest.waitForFunction(() => window.__ce.hud.root.getObjectByName('project-pad-chord_c')?.visible);
  await waitQuestReady(false);
  await pinch('project-start');
  assert.equal(await quest.evaluate(() => window.__ce.projects.running), false, 'Pads cannot enable before Mac sound');
  await shot('02-quest-needs-sound', quest);
  await enableAudio(id); await waitQuestReady(true);
  assert.equal((await audioStarts()).length, 0, 'Unlocking sound does not replay a chord');
  assert.equal(await quest.evaluate(() => window.__ce.projects.running), false, 'Audio readiness does not enable pads');

  phase = 'actual-hud-pad-bank';
  await pinch('project-start');
  await quest.waitForFunction(() => window.__ce.projects.running);
  await shot('03-quest-chord-pads', quest);
  const played = [];
  for (const [index, chord] of CHORDS.entries()) {
    const before = (await audioStarts()).length;
    await pinch(`project-pad-${chord.id}`, index === 0 ? 30 : 3);
    await until(`${chord.label} exactly one canonical trigger`, () => latest(id)?.values?.[chord.id] === 1);
    await until(`${chord.label} starts four real oscillators`, async () => (await audioStarts()).length === before + 4);
    const nodes = (await audioStarts()).slice(before);
    assert(nodes.every(node => node.contextState === 'running'));
    const expected = chord.notes.map(note => 440 * 2 ** ((note - 69) / 12));
    nodes.forEach((node, i) => {
      assert(Math.abs(node.scheduledFrequency - expected[i]) < .01,
        `${chord.label}: note ${i} scheduled ${node.scheduledFrequency}Hz, expected ${expected[i]}Hz (immediate getter ${node.observedFrequencyAtStart}Hz)`);
      assert(Number.isFinite(node.frequencyScheduledAt) && node.frequencyScheduledAt <= node.startAt,
        `${chord.label}: note ${i} frequency is scheduled by oscillator start`);
    });
    assert.equal(latest(id)?.values?.[chord.id], 1, 'A held pinch produces one chord');
    played.push({ actionId: chord.id, label: chord.label, notes: chord.notes, starts: nodes });
  }
  assert.deepEqual(Object.fromEntries(CHORDS.map(c => [c.id, latest(id).values[c.id]])), Object.fromEntries(CHORDS.map(c => [c.id, 1])));
  await shot('04-mac-chord-feedback'); await shot('05-quest-played-chord', quest);

  phase = 'stop-and-mute';
  const beforeSilence = latest(id).values.silence;
  await pinch('project-stop');
  await until('Stop sends silence', () => latest(id)?.values?.silence === beforeSilence + 1);
  await quest.waitForFunction(() => !window.__ce.projects.running);
  await studio.waitForFunction(() => !window.__museCanvas.chordSynth.current);
  const beforeDisabled = latest(id).values.chord_c;
  await pinch('project-pad-chord_c'); await frames(10);
  assert.equal(latest(id).values.chord_c, beforeDisabled, 'Stopped pads cannot play');
  await pinch('project-start'); await quest.waitForFunction(() => window.__ce.projects.running);
  await studio.locator('#chord-audio-mute').click();
  await until('Mute withdraws preview readiness', () => latest(id)?.preview?.count === 0);
  await waitQuestReady(false);
  assert.equal(await quest.evaluate(() => window.__ce.projects.running), false);
  assert.equal(await studio.evaluate(() => window.__museCanvas.chordSynth.enabled), false);
  await pinch('project-start');
  assert.equal(await quest.evaluate(() => window.__ce.projects.running), false, 'Muted pads cannot start');
  const startsBeforeReenable = (await audioStarts()).length;
  await enableAudio(id); await waitQuestReady(true); await frames(12);
  assert.equal((await audioStarts()).length, startsBeforeReenable, 'Re-enabling sound never replays prior chords');
  assert.equal(await quest.evaluate(() => window.__ce.projects.running), false, 'Sound recovery requires a new pad enable');
  await shot('06-explicit-restart', quest);

  phase = 'owner-readiness-loss';
  await studio.evaluate(() => window.__museCanvas.studio.connection(true, false));
  await studio.waitForFunction(() => !window.__museCanvas.chordSynth.enabled);
  await until('Losing writable state withdraws sound readiness', () => latest(id)?.preview?.count === 0);
  await waitQuestReady(false);
  await studio.evaluate(() => window.__museCanvas.studio.connection(true, true));
  await studio.waitForFunction(() => window.__museCanvas.studio.writable && window.__museCanvas.runtime.ready);
  assert.equal(await studio.evaluate(() => window.__museCanvas.chordSynth.enabled), false, 'Restoring permissions does not unlock audio');
  assert.equal(latest(id)?.preview?.count, 0);
  await enableAudio(id); await waitQuestReady(true);
  assert.equal((await audioStarts()).length, startsBeforeReenable);
  assert.equal(await quest.evaluate(() => window.__ce.projects.running), false);

  phase = 'reload-does-not-replay';
  previousSentTypes.push(...await studio.evaluate(() => window.__chordSentTypes));
  await studio.reload();
  await studio.waitForFunction(() => window.__museCanvas?.studio.document?.presetId === 'chord-garden-v1' && window.__museCanvas.studio.online);
  await until('Reload withdraws preview lease', () => latest(id)?.preview?.count === 0);
  await waitQuestReady(false);
  assert.equal(await studio.locator('#project-preview').count(), 0, 'Reload leaves preview stopped');
  assert.equal(await studio.evaluate(() => window.__museCanvas.chordSynth.enabled), false);
  assert.equal((await audioStarts()).length, 0);
  await studio.locator('#project-run').click();
  await studio.waitForFunction(() => window.__museCanvas.runtime.ready);
  assert.equal(latest(id)?.preview?.count, 0);
  await enableAudio(id); await waitQuestReady(true); await frames(12);
  assert.equal((await audioStarts()).length, 0, 'Restored trigger counters cannot replay on audio unlock');
  assert.equal(await quest.evaluate(() => window.__ce.projects.running), false);
  await shot('07-reloaded-awaiting-pads');

  phase = 'software-only-and-cleanup';
  const sentTypes = [...previousSentTypes, ...await studio.evaluate(() => window.__chordSentTypes), ...await quest.evaluate(() => window.__chordSentTypes)];
  const forbidden = ['control.event', 'control.setup', 'exec.command', 'arm.confirm', 'driver.spec'];
  assert.deepEqual(sentTypes.filter(type => forbidden.includes(type)), [], 'The chord route does not issue device-control commands');
  assert.equal(messages.some(message => forbidden.includes(message.type)), false);
  assert.equal(sentTypes.includes('project.request'), false, 'The authored demo does not request live generation');
  assert.deepEqual(pageErrors, []);
  await studio.locator('#project-stop').click();
  await until('Final stop withdraws renderer', () => latest(id)?.preview?.count === 0);
  await writeFile(join(OUT, 'validation.json'), JSON.stringify({
    checkedAt: new Date().toISOString(), fixture: true, physicalHeadset: false, audibleValidation: false,
    audioEvidence: 'Real WebAudio oscillator graph and native frequency automation in headless Chrome with muted output; no listening or measured acoustic-pitch claim.',
    projectId: id, revision: 1, presetId: document.presetId, source: document.source, presetMuseCalls: 0,
    played, checks: ['explicit-preset', 'no-generation', 'explicit-run', 'explicit-audio-unlock', 'audio-ready-lease', 'quest-pad-bank',
      'actual-hud-pinch', 'one-held-pinch-one-chord', 'four-voice-frequency-scheduling', 'stop-silence', 'mute-disarms', 'no-auto-resume',
      'permission-loss-disables-audio', 'reload-no-replay', 'no-hardware-commands'],
  }, null, 2));
  console.log('PASS authored chord demo, explicit Run/audio/pad enable, real HUD pinch, four WebAudio chords, Stop/Mute, permission loss, reload and no hardware route');
} catch (error) {
  if (studio) await shot('failure-studio').catch(() => {});
  if (quest) await shot('failure-quest', quest).catch(() => {});
  console.error(`FAIL ${phase}:`, error); process.exitCode = 1;
} finally {
  observer?.close(); await browser?.close();
  if (server && server.exitCode === null) {
    server.kill('SIGTERM'); await Promise.race([new Promise(r => server.once('exit', r)), delay(3000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true }); await writeFile(join(OUT, 'server.log'), log);
}
