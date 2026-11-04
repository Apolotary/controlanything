/**
 * "Muse writes the glue", end to end against a FIXTURE server on its own port (default 8796), no browser, no Muse credits:
 *
 *   node --import tsx apps/server/scripts/wire-e2e.ts            (from the repo root; PORT=8796 by default)
 *
 * Starts `node --import tsx apps/server/src/index.ts` with HTTP_PORT=$PORT HTTPS_PORT=0 CE_DATA_DIR=<tmp> MODEL_MODE=fixture
 * MODEL_API_KEY= CE_DEMO=1 CE_MAC_SILENT=1, pairs a sim Mac (the visual synth's renderer, answering exec.command with the
 * real visual synth state machine) and a sim headset, selects the Mac, and checks:
 *   - nothing is asked of Muse and nothing is controllable before the wearer asks (no prefetch, no wiring);
 *   - wire.request -> wire.progress (writing deltas, validating, dry-run) -> wire.ready on the headset AND the companion;
 *   - wire:<actionId> control.events reach the Mac as exec.command, clamped to the range, rate limited, latest value wins;
 *   - actions outside the current wire.ready are refused; a second request replaces the first; panic clears it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AnyMessage, makeMessage, type MessageType, parseMessage, type PayloadOf } from '@ce/protocol';
import WebSocket from 'ws';
import { buildTraces } from '../src/agent/wire-check';
import { applyVisualSynthMidi, createVisualSynthState, VISUAL_SYNTH_IDENTITY_REPLY, VISUAL_SYNTH_PORT, VISUAL_SYNTH_PORT_ID } from '../../../packages/vsynth/src/state';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const PORT = Number(process.env.PORT || 8796);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let server: ChildProcess | undefined;
let serverLog = '';
let dataDir = '';
let failures = 0;

function check(ok: unknown, what: string, extra?: unknown): void {
  if (ok) console.log(`  PASS ${what}`);
  else { failures++; console.log(`  FAIL ${what}${extra !== undefined ? ` — ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : ''}`); }
}

async function until<T>(what: string, probe: () => T | undefined | false, timeout = 30_000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const r = probe();
    if (r) return r;
    if (server?.exitCode != null) throw new Error(`server exited while waiting for: ${what}\n${serverLog.slice(-1500)}`);
    if (Date.now() > end) throw new Error(`timed out (${timeout / 1000}s): ${what}\n--- server log tail ---\n${serverLog.slice(-1800)}`);
    await sleep(50);
  }
}

async function pair(name: string, kind: string, capabilities: string[]): Promise<{ deviceId: string; deviceToken: string }> {
  const res = await fetch(`${BASE}/api/pair/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify({ name, kind, capabilities }) });
  const j = (await res.json()) as { status: string; deviceId: string; deviceToken: string };
  if (j.status !== 'approved') throw new Error(`pairing ${name}: ${res.status} ${JSON.stringify(j)} (loopback is trusted only with CE_TRUST_LOOPBACK)`);
  return j;
}

class Peer {
  readonly log: AnyMessage[] = [];
  private constructor(readonly name: string, readonly ws: WebSocket, readonly deviceId: string) {}
  static async open(name: string, deviceId: string, token: string, hello: Record<string, unknown>, onMessage?: (m: AnyMessage) => void): Promise<Peer> {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws`);
    const peer = new Peer(name, ws, deviceId);
    ws.on('message', (d) => { const r = parseMessage(d.toString()); if (r.ok) { peer.log.push(r.message); onMessage?.(r.message); } });
    await new Promise<void>((ok, bad) => { ws.once('open', ok); ws.once('error', bad); });
    peer.send('hello', { deviceToken: token, app: 'wire-e2e', ...hello } as never);
    await until(`${name} welcome`, () => peer.log.find((m) => m.type === 'welcome'));
    return peer;
  }
  send<T extends MessageType>(type: T, payload: PayloadOf<T>, to?: string): void { this.ws.send(JSON.stringify(makeMessage(type, payload, to ? { to } : {}))); }
  of<T extends MessageType>(type: T): (Extract<AnyMessage, { type: T }> & { payload: PayloadOf<T> })[] { return this.log.filter((m) => m.type === type) as never; }
  close(): void { this.ws.close(); }
}

async function main(): Promise<void> {
  await new Promise<void>((ok, bad) => {
    const s = createConnection({ host: '127.0.0.1', port: PORT });
    s.once('connect', () => { s.destroy(); bad(new Error(`port ${PORT} is occupied; set PORT=<free port>`)); });
    s.once('error', () => ok());
  });
  dataDir = mkdtempSync(join(tmpdir(), 'ce-wire-e2e-'));
  server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: join(ROOT, 'apps/server'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, HTTP_PORT: String(PORT), HTTPS_PORT: '0', HTTP_HOST: '127.0.0.1', PUBLIC_HOST: '127.0.0.1', CE_DATA_DIR: dataDir,
      MODEL_MODE: 'fixture', MODEL_API_KEY: '', CE_SCAN_PROMPTS: '', CE_DEMO: '1', CE_MAC_SILENT: '1', CE_MAC_LOCAL: '0', CE_OSMO: '', CE_REMO: '0', REMO_HOST: '', REMO_SEND: '0',
      CE_TRUST_FIRST_DEVICE: '1', CE_TRUST_LOOPBACK: '1', CE_CONSOLE_APPROVE: '0', MUSE_REPLAY: '1', MUSE_RECORD: '0', MUSE_RECORD_DIR: '', FIXTURE_DELAY_MS: '100', GEN3D_REPLAY_SPEED: '0', GEN3D_SKIN: '0', CE_WIRE_CHUNK_MS: '20', VITEST: '',
      CE_PREFETCH: '',
    },
  });
  for (const stream of [server.stdout!, server.stderr!]) stream.on('data', (c) => { serverLog = (serverLog + c).slice(-400_000); });
  await until('server startup', () => serverLog.includes('ControlAnything server '));
  console.log(`fixture server on :${PORT}`);

  // --- the sim Mac: the visual synth's renderer, driven by the real state machine --------------------------------
  let visual = createVisualSynthState();
  const execs: { op: Record<string, unknown>; actionId?: string; at: number }[] = [];
  const macCreds = await pair('wire-mac', 'mac', ['midi']);
  let mac!: Peer;
  mac = await Peer.open('mac', macCreds.deviceId, macCreds.deviceToken, {
    role: 'companion', executor: true, capabilities: ['midi'],
    ports: [{ id: VISUAL_SYNTH_PORT_ID, kind: 'midi-out', name: VISUAL_SYNTH_PORT, state: 'connected' }],
  }, (m) => {
    if (m.type !== 'exec.command') return;
    const p = m.payload as PayloadOf<'exec.command'>;
    if (p.executorDeviceId !== macCreds.deviceId) return;
    const op = p.op as Record<string, unknown>;
    execs.push({ op, actionId: p.actionId, at: Date.now() });
    const sentAt = Date.now();
    let ack: PayloadOf<'exec.ack'> = { execId: p.execId, ok: true, sentAt, latencyMs: 1 };
    if (op.msg === 'sysex-identity') ack = { ...ack, reply: [...VISUAL_SYNTH_IDENTITY_REPLY], detail: VISUAL_SYNTH_PORT };
    else if (op.msg === 'panic') visual = createVisualSynthState();
    else if (op.msg === 'cc' || op.msg === 'pc') {
      const status = op.msg === 'cc' ? 0xb0 : 0xc0;
      const bytes = op.msg === 'cc' ? [status + (Number(op.channel) - 1), Number(op.number), Number(op.value)] : [status + (Number(op.channel) - 1), Number(op.number)];
      const change = applyVisualSynthMidi(visual, bytes);
      if (change) { visual = change.parameters; ack = { ...ack, applied: { source: 'renderer', params: { ...visual }, visible: true, frame: 1 } }; }
    }
    mac.send('exec.ack', ack, 'server');
  });
  const questCreds = await pair('wire-quest', 'quest', []);
  const quest = await Peer.open('quest', questCreds.deviceId, questCreds.deviceToken, { role: 'hmd', capabilities: [] });
  console.log('paired and connected: sim Mac (visual synth renderer) + sim headset');

  // --- 1. nothing before the wearer asks --------------------------------------------------------------------------
  console.log('1. nothing is pre-wired');
  await sleep(1500);
  check(!/prefetch/i.test(serverLog), 'no Muse prefetch when the Mac appears (CE_PREFETCH is off)', serverLog.match(/.*prefetch.*/i)?.[0]);
  check(!/wire_program/.test(serverLog), 'no wiring requested from Muse');
  quest.send('control.event', { widgetId: 'wire:cc71', value: 100, ts: Date.now(), phase: 'move' });
  await sleep(300);
  check(execs.filter((e) => e.actionId === 'cc71').length === 0, 'a wire: event with no wiring reaches nothing');
  check(quest.of('wire.progress').length === 0 && quest.of('wire.ready').length === 0, 'no wire.progress / wire.ready before a request');

  // --- 2. select the Mac: identify, link, driver (+ dials) as before ---------------------------------------------
  console.log('2. pinch the Mac: identify, link, driver');
  quest.send('mode.set', { mode: 'control' });
  quest.send('target.select', { virtual: 'visual-synth', requestId: 'sel-1' });
  const armed = await until('the visual synth to arm', () => quest.of('target.status').find((m) => m.payload.cardId === 'visual-synth-mac' && m.payload.state === 'armed'), 90_000);
  const cardId = armed.payload.cardId;
  console.log(`   ${cardId} armed`);
  check(!/prefetch/i.test(serverLog), 'selecting the Mac did not start a prefetch');
  check(!/wire_program/.test(serverLog), 'selecting the Mac asked Muse for no wiring');
  const spec = quest.of('ui.spec').filter((m) => m.payload.cardId === cardId).at(-1);
  const specId = spec?.payload.specId;
  check(!!specId, 'the dial spec arrived', specId);

  // --- 3. "Touch the water" ---------------------------------------------------------------------------------------
  console.log('3. wire.request "Touch the water"');
  const t0 = Date.now();
  quest.send('wire.request', { cardId, text: 'Touch the water', source: 'chip' });
  const ready = await until('wire.ready on the headset', () => quest.of('wire.ready').at(-1), 60_000);
  const readyMs = Date.now() - t0;
  const progress = quest.of('wire.progress').filter((m) => m.payload.wiringId === ready.payload.wiringId).map((m) => m.payload);
  const phases = progress.map((p) => p.phase);
  const deltas = progress.filter((p) => p.codeDelta).map((p) => p.codeDelta!);
  console.log(`   ready in ${readyMs} ms: "${ready.payload.title}" ${ready.payload.source} ${ready.payload.model} · actions ${ready.payload.actions.map((a) => a.actionId).join(',')} · needs ${ready.payload.needs.join('+')}`);
  console.log(`   phases: ${[...new Set(phases)].join(' → ')}; ${deltas.length} code deltas`);
  check(['writing', 'validating', 'dry-run', 'ready'].every((p) => phases.includes(p as never)), 'progress covers writing → validating → dry-run → ready', phases);
  check(deltas.length >= 5 && deltas.join('') === ready.payload.code, `the code streamed in ${deltas.length} deltas and they add up to the final program`);
  check(progress.some((p) => /dry-run ✓ 480 frames · \d+ actions?/.test(p.note ?? '')), 'dry-run note "dry-run ✓ 480 frames · N actions"', progress.map((p) => p.note).filter(Boolean));
  check(ready.payload.source === 'fixture' && /FIXTURE/.test(ready.payload.title), 'labelled FIXTURE', ready.payload.title);
  check(ready.payload.code.length > 0 && ready.payload.code.length <= 4096, 'the program is within 4 KB', ready.payload.code.length);
  check(ready.payload.needs.includes('screen'), 'needs includes screen for a touch wiring', ready.payload.needs);
  check(mac.of('wire.ready').length === 1 && mac.of('wire.progress').some((p) => p.payload.phase === 'ready'), 'the companion (Mac) got wire.progress and wire.ready too');
  check(/\[wire\] .* ready /.test(serverLog), 'the server logged the phases with timings');

  // --- 4. the control path ----------------------------------------------------------------------------------------
  console.log('4. wire:<actionId> events dispatch through the driver');
  const setActions = ready.payload.actions.filter((a) => a.kind === 'set');
  const first = setActions[0]!;
  const ccOf = (id: string) => Number(/cc(\d+)/.exec(id)?.[1]);
  const before = execs.length;
  quest.send('control.event', { widgetId: `wire:${first.actionId}`, value: 64, ts: Date.now(), phase: 'move', specId });
  await until('the Mac to get the CC', () => execs.slice(before).find((e) => e.op.msg === 'cc' && e.op.number === ccOf(first.actionId)), 3000).catch(() => undefined);
  const got = execs.slice(before).find((e) => e.op.msg === 'cc' && e.op.number === ccOf(first.actionId));
  check(!!got && got.op.value === 64, `${first.actionId}=64 reached the Mac as MIDI CC ${ccOf(first.actionId)}`, got?.op);
  // range clamp
  await sleep(150);
  const b2 = execs.length;
  quest.send('control.event', { widgetId: `wire:${first.actionId}`, value: 9999, ts: Date.now(), phase: 'move', specId });
  await sleep(300);
  const clamped = execs.slice(b2).find((e) => e.op.number === ccOf(first.actionId));
  check(clamped?.op.value === 127, 'a value outside the range is clamped (9999 -> 127)', clamped?.op);
  // coalescing: 60 events in ~600 ms for one action -> about 30 Hz at most, and the last value wins
  await sleep(200);
  const b3 = execs.length;
  const sendStart = Date.now();
  for (let i = 0; i < 60; i++) { quest.send('control.event', { widgetId: `wire:${first.actionId}`, value: i, ts: Date.now(), phase: 'move', specId }); await sleep(10); }
  await sleep(250);
  const burst = execs.slice(b3).filter((e) => e.op.number === ccOf(first.actionId));
  const elapsed = (burst.at(-1)?.at ?? Date.now()) - sendStart;
  console.log(`   60 events in ${Date.now() - sendStart - 250} ms -> ${burst.length} CCs, ${(burst.length / Math.max(0.1, elapsed / 1000)).toFixed(1)} Hz`);
  check(burst.length >= 5 && burst.length <= 24, 'the burst is coalesced to the action rate (<= 30 Hz)', burst.length);
  check(burst.at(-1)?.op.value === 59, 'latest value wins: the last event (59) is the last CC', burst.at(-1)?.op.value);
  // an action that is not in the current wiring
  const outside = 'cc7';
  const b4 = execs.length;
  quest.send('control.event', { widgetId: `wire:${outside}`, value: 100, ts: Date.now(), phase: 'move', specId });
  await sleep(300);
  check(!execs.slice(b4).some((e) => e.op.number === 7), `wire:${outside} (not in the current wire.ready) is refused`);
  // without a specId the only active wiring is used
  const b5 = execs.length;
  quest.send('control.event', { widgetId: `wire:${first.actionId}`, value: 20, ts: Date.now(), phase: 'move' });
  await sleep(300);
  check(execs.slice(b5).some((e) => e.op.number === ccOf(first.actionId) && e.op.value === 20), 'an event without specId resolves to the single active wiring');

  // --- 4b. run the program the way the headset does, on a recorded touch-drag, and watch the Mac's water --------------
  if (ready.payload.actions.some((a) => a.actionId === 'cc24')) {
    console.log('4b. the program on a touch-drag trace (what the headset runtime would send)');
    check(['cc22', 'cc23', 'cc24'].every((id) => ready.payload.actions.some((a) => a.actionId === id)), 'Touch the water uses Touch X / Y / pressure (cc22, cc23, cc24)', ready.payload.actions.map((a) => a.actionId));
    const verifyOps = execs.filter((e) => e.at >= t0 && e.op.number === 24).map((e) => Number(e.op.value));
    check(verifyOps.length > 0 && Math.max(...verifyOps) <= 20, 'verifying the touch actions only hovered (cc24 <= 20): no splash, nothing confusing', verifyOps);
    const frames = [...buildTraces().find((t) => t.name === 'touch-drag')!.frames, ...Array.from({ length: 6 }, (_, i) => ({ t: 2 + i / 60, dt: 1 / 60, right: null, left: null, screen: null }))];
    // eslint-disable-next-line no-new-func
    const program = new Function('s', 'out', 'mem', ready.payload.code) as (s: unknown, out: { set(id: string, v: number): void; trigger(id: string): void }, mem: object) => void;
    const mem = {};
    const seen = { x: [] as number[], pressure: [] as number[] };
    const startState = execs.length;
    for (const frame of frames) {
      const sets: [string, number][] = [];
      program(frame, { set: (id, v) => sets.push([id, v]), trigger: () => undefined }, mem);
      for (const [id, value] of sets) quest.send('control.event', { widgetId: `wire:${id}`, value, ts: Date.now(), phase: 'move', specId });
      await sleep(16);
    }
    await sleep(400);
    for (const e of execs.slice(startState)) {
      if (e.op.msg !== 'cc') continue;
      if (e.op.number === 22) seen.x.push(Number(e.op.value));
      if (e.op.number === 24) seen.pressure.push(Number(e.op.value));
    }
    const downAt = seen.pressure.findIndex((v) => v > 20);
    console.log(`   Mac got ${seen.x.length} X, ${seen.pressure.length} pressure CCs; X ${Math.min(...seen.x)}..${Math.max(...seen.x)}; pressure max ${Math.max(...seen.pressure)}, last ${seen.pressure.at(-1)}`);
    check(seen.x.length >= 20 && Math.min(...seen.x) < 45 && Math.max(...seen.x) > 85, 'X follows the finger across the screen (30 Hz at most)', [Math.min(...seen.x), Math.max(...seen.x), seen.x.length]);
    check(seen.pressure.some((v) => v >= 1 && v <= 20) && downAt >= 0, 'pressure hovers (1-20) on approach and touches (>20) on contact', seen.pressure.slice(0, 12));
    check(seen.pressure.at(-1) === 0, 'pressure 0 is the last thing sent when the hand is lost (a lift)', seen.pressure.slice(-4));
  }

  // --- 5. a second request replaces the wiring --------------------------------------------------------------------
  console.log('5. wire.request "Hands as knobs"');
  quest.send('wire.request', { cardId, text: 'Hands as knobs', source: 'chip' });
  const second = await until('second wire.ready', () => quest.of('wire.ready').find((m) => m.payload.wiringId !== ready.payload.wiringId), 60_000);
  console.log(`   "${second.payload.title}" · actions ${second.payload.actions.map((a) => a.actionId).join(',')} · needs ${second.payload.needs.join('+')}`);
  check(/FIXTURE/.test(second.payload.title) && second.payload.code !== ready.payload.code, 'a new, different wiring was written');
  check(!second.payload.needs.includes('screen') && second.payload.needs.includes('right'), 'hands as knobs needs the right hand and no screen', second.payload.needs);
  const gone = ready.payload.actions.find((a) => !second.payload.actions.some((b) => b.actionId === a.actionId));
  if (gone) {
    const b6 = execs.length;
    quest.send('control.event', { widgetId: `wire:${gone.actionId}`, value: 50, ts: Date.now(), phase: 'move', specId });
    await sleep(300);
    check(!execs.slice(b6).some((e) => e.op.number === ccOf(gone.actionId)), `${gone.actionId} from the first wiring is no longer accepted`);
  }
  const knob = second.payload.actions.find((a) => a.kind === 'set')!;
  const b7 = execs.length;
  quest.send('control.event', { widgetId: `wire:${knob.actionId}`, value: 33, ts: Date.now(), phase: 'move', specId });
  await sleep(300);
  check(execs.slice(b7).some((e) => e.op.number === ccOf(knob.actionId) && e.op.value === 33), `${knob.actionId}=33 from the new wiring reaches the Mac`);

  // --- 6. stop ----------------------------------------------------------------------------------------------------
  console.log('6. panic clears the wiring');
  quest.send('panic', { reason: 'wire-e2e stop' });
  await sleep(500);
  const b8 = execs.length;
  quest.send('control.event', { widgetId: `wire:${knob.actionId}`, value: 80, ts: Date.now(), phase: 'move', specId });
  await sleep(300);
  check(!execs.slice(b8).some((e) => e.op.number === ccOf(knob.actionId) && e.op.value === 80), 'after panic a wire: event reaches nothing');

  // --- 6b. select again: the saved driver comes back from the library, and the ask works right behind the pinch ------
  console.log('6b. pinch again (driver from the library) and ask straight away');
  quest.send('target.select', { virtual: 'visual-synth', requestId: 'sel-2' });
  quest.send('wire.request', { cardId, text: 'Hands as knobs', source: 'voice' });
  const third = await until('wire.ready after the re-selection', () => quest.of('wire.ready').find((m) => m.payload.wiringId !== second.payload.wiringId && m.payload.wiringId !== ready.payload.wiringId), 60_000);
  const prog3 = quest.of('wire.progress').filter((m) => m.payload.wiringId === third.payload.wiringId).map((m) => m.payload);
  check(prog3.some((p) => /driver from your library · model fixture · source fixture/.test(p.note ?? '')), 'the reused driver is labelled with its actual fixture source', prog3.map((p) => p.note).filter(Boolean));
  const knob3 = third.payload.actions.find((a) => a.kind === 'set')!;
  const b9 = execs.length;
  quest.send('control.event', { widgetId: `wire:${knob3.actionId}`, value: 77, ts: Date.now(), phase: 'move', specId });
  await sleep(300);
  check(execs.slice(b9).some((e) => e.op.number === ccOf(knob3.actionId) && e.op.value === 77), 'the wiring written after re-arming drives the Mac');

  // --- 7. a bad request fails clearly -----------------------------------------------------------------------------
  console.log('7. wire.request for an unknown card');
  const n = quest.of('wire.progress').length;
  quest.send('wire.request', { cardId: 'no-such-card', text: 'Touch the water', source: 'text' });
  const failed = await until('failed progress', () => quest.of('wire.progress').slice(n).find((m) => m.payload.phase === 'failed'), 10_000);
  check(!!failed.payload.note, 'an unknown card fails with a reason', failed.payload.note);

  mac.close(); quest.close();
}

main()
  .catch((e) => { failures++; console.error(`ERROR ${(e as Error).message}`); })
  .finally(async () => {
    server?.kill('SIGTERM');
    await sleep(300);
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
    if (failures && process.env.WIRE_E2E_LOG) console.log(serverLog.split('\n').filter((l) => /\[wire\]|\[control\]|\[setup\]|\[drive\]/.test(l)).join('\n'));
    process.exit(failures ? 1 : 0);
  });
