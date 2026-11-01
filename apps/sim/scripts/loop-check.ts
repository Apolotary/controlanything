/**
 * End-to-end check of the sim as a device, through the real WebSocket hub and protocol validation, judged by the
 * server's real oracles. Starts its own small server (hub + pairing + /sim/ static, in-memory registry, no model
 * calls) on :8899, waits for the sim page to connect, then drives it the way the agent will:
 *
 *   MIDI identity → camera "before" → IR honest miss (another brand) → learn from the virtual remote →
 *   replay the learned code → camera "after" (oracle: on) → dim one step → synth A-B-A-B on CC 46 with
 *   audio features (oracle: tone change) → negative control CC 20 (oracle: none)
 *
 *   npx tsx apps/sim/scripts/loop-check.ts       then open http://localhost:8899/sim/ and click once (audio);
 *                                                tick "auto-press" on the remote for an unattended run
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AnyMessage, type ExecOp, newId, type PayloadOf, PairStartRequest, type Polygon } from '@ce/protocol';
import express from 'express';
import { observeAudio } from '../../server/src/oracle/audio';
import { cameraMatches, observeCamera } from '../../server/src/oracle/camera';
import { type DecodedImage, decodeJpeg } from '../../server/src/oracle/image';
import { Hub } from '../../server/src/hub';
import { PairingManager } from '../../server/src/pairing/manager';
import { DeviceRegistry } from '../../server/src/pairing/registry';
import { decodeAll, encodePress, hex, parseHex } from '../src/ir/codec';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.LOOP_PORT || 8899);
const meta = JSON.parse(readFileSync(join(here, '../public/room/meta.json'), 'utf8'));
const lampPolygon = (meta.views.room.devices as { id: string; polygon: [number, number][] }[]).find((d) => d.id === 'ceiling-light')!.polygon as Polygon;

const registry = new DeviceRegistry(undefined);
const pairing = new PairingManager(registry, { qrBase: () => `http://localhost:${PORT}` });
const hub = new Hub({ registry, pairing, mode: 'fixture', serverName: 'sim-loop-check', isLocal: () => true, log: () => {} });

const app = express();
app.use(express.json({ limit: '16mb' }));
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, mode: 'fixture', version: 'loop-check', models: {}, urls: { host: 'localhost', lan: [] } });
});
app.post('/api/pair/start', (req, res) => {
  const body = PairStartRequest.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  res.status(201).json(pairing.start(body.data, { origin: req.socket.remoteAddress, autoApprove: true }));
});
app.get('/api/pair/status', (req, res) => {
  res.json(pairing.status(String(req.query.pairingId), String(req.query.pollSecret)));
});
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'not_found' });
});
app.use('/sim', express.static(join(here, '../dist')));
const server = createServer(app);
hub.attach(server);

const waiters: { match: (m: AnyMessage) => boolean; resolve: (m: AnyMessage) => void }[] = [];
hub.onMessage(({ message }) => {
  for (const w of [...waiters]) {
    if (w.match(message)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(message);
    }
  }
});
function next<T extends AnyMessage>(match: (m: AnyMessage) => boolean, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const w = { match, resolve: resolve as (m: AnyMessage) => void };
    waiters.push(w);
    setTimeout(() => {
      const i = waiters.indexOf(w);
      if (i >= 0) {
        waiters.splice(i, 1);
        reject(new Error(`timed out waiting for ${what}`));
      }
    }, ms);
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let simId = '';
async function exec(op: ExecOp): Promise<PayloadOf<'exec.ack'>> {
  const execId = newId('x');
  const p = next<{ type: 'exec.ack'; payload: PayloadOf<'exec.ack'> } & AnyMessage>((m) => m.type === 'exec.ack' && (m.payload as { execId: string }).execId === execId, 8000, `exec.ack ${execId}`);
  hub.sendToDevice(simId, 'exec.command', { execId, executorDeviceId: simId, op });
  return ((await p) as unknown as { payload: PayloadOf<'exec.ack'> }).payload;
}
async function sense(kind: 'frame' | 'audio-features' | 'ir-capture', extra: { durationMs?: number; offsetMs?: number; prompt?: string } = {}, timeout = 10_000): Promise<PayloadOf<'sense.result'>> {
  const senseId = newId('s');
  const p = next((m) => m.type === 'sense.result' && (m.payload as { senseId: string }).senseId === senseId, timeout, `sense.result ${kind}`);
  hub.sendToDevice(simId, 'sense.request', { senseId, sensorDeviceId: simId, kind, ...extra });
  return ((await p) as unknown as { payload: PayloadOf<'sense.result'> }).payload;
}
async function frame(): Promise<DecodedImage> {
  const r = await sense('frame');
  if (!r.frame) throw new Error('sense.result without a frame');
  return decodeJpeg(r.frame.jpeg);
}

let fails = 0;
function report(ok: boolean, what: string, detail = ''): void {
  if (!ok) fails++;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}${detail ? `  · ${detail}` : ''}`);
}

async function main(): Promise<void> {
  await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', () => r()));
  console.log(`loop-check server on :${PORT} · open http://localhost:${PORT}/sim/ and click once (audio). Waiting for the sim…`);
  for (;;) {
    const sim = hub.devices().find((d) => d.kind === 'sim' && d.online);
    if (sim) {
      simId = sim.deviceId;
      break;
    }
    await sleep(500);
  }
  console.log(`sim online: ${simId}`);
  await sleep(1500);

  // 1. MIDI identity (non-commercial ID, never TE)
  const id = await exec({ kind: 'midi', msg: 'sysex-identity', channel: 1 });
  report(Boolean(id.ok && id.reply && id.reply[5] === 0x7d), 'MIDI identity reply uses the non-commercial ID 7D', id.reply ? hex(id.reply) : id.detail ?? '');

  // 2. make sure the lamp starts OFF (learned code later), camera before
  await exec({ kind: 'ir', protocol: 'AEHA', rawUs: encodePress({ proto: 'AEHA', bytes: [0xce, 0x51, 0x06, 0x13, 0x15], unitUs: 420 }, 1) });
  await sleep(2500);
  const before = await frame();
  report(before.width === 1280 && before.height === 960, 'verify frame arrives as a 1280×960 JPEG through the hub');

  // 3. honest miss: another brand's full-on code
  const miss = await exec({ kind: 'ir', protocol: 'AEHA', bytes: parseHex('2C 52 09 2C 25'), rawUs: encodePress({ proto: 'AEHA', bytes: parseHex('2C 52 09 2C 25'), unitUs: 432 }, 1), ref: 'lib:panasonic/ceiling/CH1/fullOn' });
  await sleep(2500);
  const missObs = observeCamera(before, await frame(), lampPolygon, undefined, { exposureLocked: true });
  report(miss.ok && cameraMatches(missObs, 'none'), 'Panasonic CH1 全灯: sent ✓ · seen ✗ (the honest miss)', `mask∪ring luma ${(missObs.absDelta * 100).toFixed(1)} %`);

  // 4. learn from the virtual remote
  console.log('  …  learn window open: press 全灯 on the virtual remote (or tick auto-press)');
  const cap = await sense('ir-capture', { durationMs: 30_000, prompt: 'press 全灯 once' }, 32_000);
  const learned = cap.ir ? decodeAll(cap.ir.rawUs)[0] : undefined;
  report(Boolean(cap.ok && learned), 'learned a press from the virtual remote', learned ? `${learned.proto} ${hex(learned.bytes)} · ${cap.ir!.rawUs.length} edges · frames ${cap.ir!.frames ?? '?'}` : cap.error ?? '');
  if (!learned || !cap.ir) throw new Error('nothing learned');

  // 5. replay the learned raw timings; the camera must see the light come on
  const t0 = Date.now();
  const hit = await exec({ kind: 'ir', protocol: 'RAW', rawUs: cap.ir.rawUs.map((x) => Math.min(65_000, x)), ref: 'learned:fullOn' });
  await sleep(2500);
  const on = await frame();
  const onObs = observeCamera(before, on, lampPolygon, undefined, { exposureLocked: true });
  report(hit.ok && cameraMatches(onObs, 'on'), 'learned code replayed: sent ✓ · seen ✓ (on)', `mask∪ring luma ${(onObs.absDelta * 100).toFixed(0)} %, mask/ring ${(onObs.delta * 100).toFixed(0)} % · ack in ${hit.latencyMs} ms · ${Date.now() - t0} ms incl. fade`);

  // 6. one step dimmer (SIM-KZ CH1 暗く) while the camera watches
  await exec({ kind: 'ir', protocol: 'AEHA', rawUs: encodePress({ proto: 'AEHA', bytes: [0xce, 0x51, 0x06, 0x15, 0x13], unitUs: 420 }, 1) });
  await sleep(2500);
  const dimObs = observeCamera(on, await frame(), lampPolygon, undefined, { exposureLocked: true });
  report(cameraMatches(dimObs, 'dimmer'), 'one 暗く step reads as dimmer (camera oracle)', `mask∪ring luma ${(dimObs.absDelta * 100).toFixed(1)} % · R/B ${(dimObs.rbDelta * 100).toFixed(1)} %`);

  // 7. synth: held note + A-B-A-B on CC 46 with audio features from the synth's own output
  await exec({ kind: 'midi', msg: 'note', channel: 1, number: 48, velocity: 100, durationMs: 10_000 });
  await sleep(400);
  const feats: PayloadOf<'sense.result'>['audio'][] = [];
  for (const v of [10, 117, 10, 117]) {
    await exec({ kind: 'midi', msg: 'cc', channel: 1, number: 46, value: v });
    await sleep(350);
    const r = await sense('audio-features', { durationMs: 600 });
    if (!r.ok) console.log(`  …  ${r.error}`);
    feats.push(r.audio);
  }
  if (feats.every(Boolean)) {
    const up = observeAudio(feats[0]!, feats[1]!);
    const down = observeAudio(feats[1]!, feats[2]!);
    const up2 = observeAudio(feats[2]!, feats[3]!);
    report(up.effect !== 'none' && down.effect !== 'none' && up2.effect !== 'none', 'CC 46 sweep changes the sound (audio oracle, A-B-A-B)', `centroid ${feats.map((f) => f!.centroidHz).join('/')} Hz · ${up.effect}/${down.effect}/${up2.effect}`);
    await exec({ kind: 'midi', msg: 'cc', channel: 1, number: 20, value: 10 });
    await sleep(350);
    const n1 = (await sense('audio-features', { durationMs: 600 })).audio!;
    await exec({ kind: 'midi', msg: 'cc', channel: 1, number: 20, value: 117 });
    await sleep(350);
    const n2 = (await sense('audio-features', { durationMs: 600 })).audio!;
    const neg = observeAudio(n1, n2);
    report(neg.effect === 'none', 'negative control: CC 20 (not in the chart) changes nothing', `${neg.rmsDelta.toFixed(1)} dB, ${neg.centroidOctaves.toFixed(2)} oct`);
  } else {
    report(false, 'audio features (click the sim page once to start audio)');
  }
  await exec({ kind: 'midi', msg: 'panic', channel: 1 });
  console.log(fails ? `${fails} check(s) failed` : 'all checks passed');
  server.close();
  hub.close();
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.error(`loop-check aborted: ${(e as Error).message}`);
  process.exit(1);
});
