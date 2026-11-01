/**
 * Drives the iPhone app through the real hub without the agent loop: pairs as a localhost "web" client
 * (auto-approved), then sends the paired iPhone a ui.spec (gen3d + hackset), a run of agent.step lines, and
 * "x."-prefixed twins of the server-only messages (exec.command, arm.request, verify.result, scan.result),
 * which the app accepts in DEBUG builds only. Prints everything the iPhone sends back.
 *
 *   npx tsx apps/iphone/scripts/mock-brain.ts [scenario ...] [--listen]
 *     scenarios: steps spec targets arm exec scan disarmed (default: steps spec targets)
 *     --listen   stay connected and answer hack uploads with verify.result evidence (else exit after ~2.5 s)
 *     --loud     really speak/beep in the exec scenario (default: say and beep go out as dryRun, so no sound)
 *     debug k=v  send an x.debug command (DEBUG app builds): tab=log · surface=spec_op1 · hack=full ·
 *                control=brightness value=40 · scanFile=/path.jpg · arm=approve · approvePending=1 · undo=1
 *   CE_SERVER=http://localhost:8787
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { EXAMPLES } from '../../../packages/gen3d/src/index';
import { makeMessage, parseMessage, type MessageType, type PayloadOf } from '../../../packages/protocol/src/index';

const SERVER = process.env.CE_SERVER ?? 'http://localhost:8787';
const TOKEN_FILE = join(tmpdir(), 'ce-mock-brain-token.json');
const args = process.argv.slice(2);
const listen = args.includes('--listen');
const loud = args.includes('--loud');
const debugArgs = args.includes('debug') ? Object.fromEntries(args.filter((a) => a.includes('=')).map((a) => a.split(/=(.*)/s).slice(0, 2))) : null;
const scenarios = args.filter((a) => !a.startsWith('--') && !a.includes('=') && a !== 'debug');
const want = (name: string) =>
  scenarios.length ? scenarios.includes(name) || scenarios.includes('all') : !debugArgs && ['steps', 'spec', 'targets'].includes(name);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function credentials(): Promise<{ deviceId: string; deviceToken: string }> {
  try {
    const c = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
    const me = await fetch(`${SERVER}/api/me`, { headers: { authorization: `Bearer ${c.deviceToken}` } });
    if (me.ok) return c;
  } catch {}
  const r = await fetch(`${SERVER}/api/pair/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'mock-brain', kind: 'web' }),
  });
  const j = (await r.json()) as { status: string; deviceId?: string; deviceToken?: string };
  if (j.status !== 'approved' || !j.deviceToken || !j.deviceId) throw new Error(`pairing was not auto-approved (run on the Mac): ${JSON.stringify(j)}`);
  writeFileSync(TOKEN_FILE, JSON.stringify({ deviceId: j.deviceId, deviceToken: j.deviceToken }));
  return { deviceId: j.deviceId, deviceToken: j.deviceToken };
}

const creds = await credentials();
const ws = new WebSocket(SERVER.replace(/^http/, 'ws') + '/ws');
let iphone: string | undefined;
const sent = new Map<string, string>(); // hack widgetId -> driver actionId (for evidence)

function send<T extends MessageType>(type: T, payload: PayloadOf<T>, to?: string) {
  const m = makeMessage(type, payload, { to });
  const check = parseMessage(JSON.parse(JSON.stringify(m)));
  if (!check.ok) throw new Error(`invalid ${type}: ${check.error} ${check.issues.join('; ')}`);
  ws.send(JSON.stringify(m));
}

/** "x." twin of a server-only type: the hub relays it after checking only the envelope. */
function sendX(type: string, payload: unknown, to?: string) {
  ws.send(JSON.stringify({ v: 1, type: `x.${type}`, id: `m${Date.now().toString(36)}${Math.random().toString(16).slice(2, 10)}`, ts: Date.now(), from: '', to, payload }));
}

const runId = `run-${Date.now().toString(36)}`;
async function step(stepId: string, phase: string, title: string, extra: Record<string, unknown> = {}, runMs = 700, fail = false) {
  const base = { stepId, runId, phase, title, startedAt: Date.now() } as Record<string, unknown>;
  send('agent.step', { ...base, status: 'running', ...extra } as PayloadOf<'agent.step'>, iphone);
  await sleep(runMs);
  send('agent.step', { ...base, status: fail ? 'fail' : 'ok', endedAt: Date.now(), latencyMs: runMs, ...extra } as PayloadOf<'agent.step'>, iphone);
}

const lightHackset = {
  spec: 'ce.hackset/1',
  device: { id: 'card_light', name: 'Ceiling light', kind: 'light', channel: { type: 'ir', via: 'cardputer' } },
  hacks: [
    { id: 'full', name: 'Full on', kind: 'action', blurb: '全灯 · all LEDs', commands: [{ action: 'ir_full' }], oracle: { type: 'camera', region: 'mask', expect: 'brighter' }, inverse: { commands: [{ action: 'ir_night' }] }, max_rate_hz: 1, status: 'verified' },
    { id: 'night', name: 'Night light', kind: 'action', blurb: '常夜灯 · amber 5 %', commands: [{ action: 'ir_night' }], oracle: { type: 'camera', region: 'mask', expect: 'dimmer+warmer' }, inverse: { commands: [{ action: 'ir_full' }] }, max_rate_hz: 1, status: 'verified' },
    { id: 'off', name: 'Lights off', kind: 'action', blurb: '消灯', commands: [{ action: 'ir_off' }], oracle: { type: 'camera', region: 'mask', expect: 'off' }, inverse: { commands: [{ action: 'ir_full' }] }, max_rate_hz: 1, status: 'ready' },
    { id: 'brightness', name: 'Dim room', kind: 'control', blurb: 'brightness 0-100', params: [{ id: 'p_lvl', name: 'Level', min: 0, max: 100, default: 70, unit: '%', step: 5 }], control: { archetype: 'ring', size: 'm', param: 'p_lvl' }, commands: [{ action: 'ir_brighter', param: 'p_lvl' }], oracle: { type: 'camera', region: 'mask', expect: 'luminance_tracks_param' }, inverse: { restore: 'p_lvl' }, max_rate_hz: 2 },
  ],
  daemons: [
    { id: 'breathe', name: 'Breathe to tempo', blurb: 'light follows the OP-1 clock', trigger: { source: 'device.card_op1f.clock_bpm' }, map: { curve: 'sine', range: [40, 100], period_bars: 2 }, targets: [{ hack: 'brightness', param: 'p_lvl' }], max_rate_hz: 1, status: 'proposed' },
  ],
  modelId: 'muse-spark-1.3',
  source: 'fixture',
};
for (const h of lightHackset.hacks) sent.set(h.id, h.commands[0].action);

const op1Hackset = {
  spec: 'ce.hackset/1',
  device: { id: 'card_op1f', name: 'OP-1 Field', kind: 'synth', channel: { type: 'usb' } },
  hacks: [
    { id: 'panic_notes', name: 'Silence synth', kind: 'action', blurb: 'all notes off', commands: [{ action: 'cc_123' }], oracle: { type: 'mic', expect: 'silent' }, max_rate_hz: 1 },
    { id: 'reset_tape', name: 'Wipe tape', kind: 'action', blurb: 'erases the tape track', commands: [{ action: 'cc_tape_clear' }], oracle: { type: 'wire', expect: 'usb_echo' }, confirm: 'hold', reversible: false, max_rate_hz: 0.2 },
  ],
  modelId: 'muse-spark-1.3',
  source: 'fixture',
};
sent.set('panic_notes', 'cc_123');

async function sendSpecs() {
  const light = { ...EXAMPLES['ceiling-dimmer'], specId: 'spec_light', source: 'fixture' as const };
  send('ui.spec', { specId: 'spec_light', title: 'Ceiling light', cardId: 'card_light', rev: 1, gen3d: light, hackset: lightHackset as never, source: 'fixture', modelId: 'muse-spark-1.3' }, iphone);
  await sleep(400);
  const op1 = { ...EXAMPLES['op1-knobs'], specId: 'spec_op1', source: 'fixture' as const };
  send('ui.spec', { specId: 'spec_op1', title: 'OP-1 Field', cardId: 'card_op1f', rev: 1, gen3d: op1, hackset: op1Hackset as never, source: 'fixture', modelId: 'muse-spark-1.3' }, iphone);
}

/** The light before its hacks arm: the remote is still being learned (controls render disarmed). */
async function sendDisarmed() {
  const light = {
    ...EXAMPLES['ceiling-dimmer'],
    specId: 'spec_light',
    rev: 2,
    source: 'fixture' as const,
    state: { armed: false, reason: 'learning the remote… 3 / 7 captured, 2 verified' },
  };
  const hs = { ...lightHackset, hacks: lightHackset.hacks.map((h) => ({ ...h, status: h.id === 'full' ? 'verified' : 'locked' })) };
  send('ui.spec', { specId: 'spec_light', title: 'Ceiling light', cardId: 'card_light', rev: 2, gen3d: light, hackset: hs as never, source: 'fixture', modelId: 'muse-spark-1.3' }, iphone);
}

async function sendSteps() {
  send('device.card', { cardId: 'card_light', name: 'Ceiling light', maker: 'Koizumi', model: 'KRH-TG-9A remote', category: 'lighting', confidence: 0.86, protocols: ['ir'], evidence: ['round LED fixture', 'remote reads KOIZUMI'], source: 'fixture', modelId: 'muse-spark-1.3' }, iphone);
  send('device.card', { cardId: 'card_op1f', name: 'OP-1 Field', maker: 'Teenage Engineering', model: 'OP-1 Field', category: 'synthesizer', confidence: 0.95, protocols: ['midi'], evidence: ['four colour encoders', 'USB says OP-1 Field'], source: 'fixture', modelId: 'muse-spark-1.3' }, iphone);
  await step('s1', 'scan', 'Scan: 3 devices in view', { model: 'sam-3.1', source: 'fixture', evidence: 'ceiling light · synth · laptop', kind: 'opinion' }, 900);
  await step('s2', 'identify', 'Identify: Koizumi ceiling light', { model: 'muse-spark-1.3', effort: 'low', source: 'fixture', evidence: 'remote reads KOIZUMI', kind: 'opinion' }, 1200);
  await step('s3', 'link', 'Link: Cardputer IR node', { evidence: 'serial ack ✓', kind: 'proof', detail: 'Cardputer-Adv on /dev/cu.usbmodem101' }, 500);
  await step('s4', 'drive', 'Driver: 7 IR actions', { model: 'muse-wonder-1.0', source: 'fixture', detail: 'NEC codes from the disclosed library; validated against the allowlist', kind: 'opinion' }, 1500);
  await step('s5', 'verify', 'Verify 全灯: no reaction', { evidence: 'sent 0x2A → no change ✗', kind: 'proof', detail: 'hand over the beam; retry 2 of 3' }, 700, true);
  await step('s6', 'verify', 'Verify 全灯: brighter', { evidence: 'seen ✓ luma +38 %', kind: 'proof' }, 700);
  await step('s7', 'forge', 'Forge controls: dimmer ring + 3 hacks', { model: 'muse-spark-1.3', effort: 'low', source: 'fixture', kind: 'opinion' }, 900);
}

async function sendTargets() {
  sendX('target.status', { cardId: 'card_light', state: 'armed', since: Date.now(), detail: 'IR via Cardputer · 3 of 3 hacks verified' }, iphone);
  sendX('link.result', { linkId: 'l1', cardId: 'card_light', verdict: 'confirmed', channel: 'ir', evidence: [{ kind: 'sim', ok: true, detail: 'camera saw the light react to 全灯' }] }, iphone);
  sendX('target.status', { cardId: 'card_op1f', state: 'linking', since: Date.now(), detail: 'waiting for MIDI identity' }, iphone);
}

async function sendArm() {
  sendX('arm.request', {
    armId: 'arm1', cardId: 'card_op1f', driverId: 'drv_op1', specId: 'spec_op1', title: 'Arm 4 controls for OP-1 Field?',
    summary: 'USB says OP-1 Field; CC 1-4 echoed. Arming lets these knobs drive the synth.',
    actions: [
      { actionId: 'cc1', label: 'BLUE', verified: 'pass' },
      { actionId: 'cc2', label: 'GREEN', verified: 'pass' },
      { actionId: 'cc3', label: 'WHITE', verified: 'pass' },
      { actionId: 'cc4', label: 'ORANGE', verified: 'untested' },
    ],
    expiresAt: Date.now() + 60_000,
  }, iphone);
}

async function sendScan() {
  // boxes in pixels of the 1280x720 synthetic test frame (apps/iphone README: debug scanFile)
  sendX('scan.result', {
    frameId: '*', width: 1280, height: 720, modelId: 'sam-3.1', source: 'fixture', latencyMs: 2140,
    prompts: ['ceiling light', 'synthesizer', 'laptop', 'device with screen and keyboard'],
    detections: [
      { detId: 'd1', label: 'ceiling light', prompt: 'ceiling light', score: 0.93, box: [465, 35, 350, 110], cardId: 'card_light' },
      { detId: 'd2', label: 'synthesizer', prompt: 'synthesizer', score: 0.88, box: [165, 425, 390, 120], cardId: 'card_op1f' },
      { detId: 'd3', label: 'laptop', prompt: 'laptop', score: 0.91, box: [645, 325, 340, 222] },
      { detId: 'd4', label: 'handheld terminal', prompt: 'device with screen and keyboard', score: 0.71, box: [1035, 465, 130, 80] },
    ],
  }, iphone);
}

async function sendExec() {
  const ops: [string, unknown][] = [
    ['screen', { color: '#38F0FF', mode: 'steady', ms: 2500 }],
    ['haptic', 'pulse'],
    ['torch', 0.6],
    ['say', 'Ceiling light linked. Your phone is listening.'],
    ['beep', { freq: 660, count: 2 }],
    ['screen', { color: '#FF3DBE', mode: 'pulse', hz: 5, ms: 3000 }],
    ['screen', { color: '#FF2020', mode: 'flash' }],
    ['volume', 40],
  ];
  for (const [op, arg] of ops) {
    const dryRun = !loud && (op === 'say' || op === 'beep');
    sendX('exec.command', { execId: `x-${op}-${Date.now().toString(36)}`, executorDeviceId: iphone, op: { kind: 'local', op, arg }, ...(dryRun ? { dryRun } : {}) }, iphone);
    await sleep(op === 'screen' ? 3300 : 1500);
  }
  sendX('exec.command', { execId: `x-torch-off-${Date.now().toString(36)}`, executorDeviceId: iphone, op: { kind: 'local', op: 'torch', arg: 0 } }, iphone);
}

ws.on('open', () => send('hello', { deviceToken: creds.deviceToken, role: 'controller', app: 'mock-brain@0.1.0' }));
ws.on('message', async (data) => {
  const m = JSON.parse(String(data));
  if (m.type === 'presence') {
    const phone = m.payload.devices.find((d: { kind: string; online: boolean }) => d.kind === 'iphone' && d.online);
    if (phone && !iphone) {
      iphone = phone.deviceId;
      console.log(`[mock] iPhone online: ${phone.name} (${iphone}); scenarios: ${scenarios.join(' ') || 'steps spec targets'}`);
      if (want('steps')) await sendSteps();
      if (want('spec')) await sendSpecs();
      if (want('disarmed')) await sendDisarmed();
      if (want('targets')) await sendTargets();
      if (want('arm')) await sendArm();
      if (want('scan')) await sendScan();
      if (want('exec')) await sendExec();
      if (debugArgs) sendX('debug', debugArgs, iphone);
      if (!listen) { setTimeout(() => process.exit(0), 2500); }
      console.log(listen ? '[mock] sent; listening (Ctrl+C to stop)' : '[mock] sent; exiting shortly');
    } else if (!phone && !iphone) {
      console.log('[mock] waiting for a paired iPhone to come online…');
    }
    return;
  }
  if (m.from !== iphone) return;
  const p = JSON.stringify(m.payload);
  console.log(`[iphone] ${m.type} ${p.length > 300 ? p.slice(0, 300) + '…' : p}`);
  // answer a hack upload with evidence, like the camera oracle would
  if (m.type === 'control.event' && sent.has(m.payload.widgetId) && m.payload.phase === 'end' && m.payload.value === true) {
    await sleep(1600);
    const actionId = sent.get(m.payload.widgetId)!;
    const pass = m.payload.widgetId !== 'off';
    sendX('verify.result', {
      evidenceId: `ev-${Date.now().toString(36)}`, cardId: 'card_light', actionId, execId: `x-${actionId}`, attempt: 1,
      sent: { op: { kind: 'ir', protocol: 'NEC', address: 0x20, command: 0x2a }, at: Date.now() - 1500 },
      expected: { sense: 'camera', effect: pass ? 'brighter' : 'off' },
      observed: { sense: 'camera', metric: 'luma-mask-vs-ring', before: 0.41, after: pass ? 0.57 : 0.42, delta: pass ? 0.38 : 0.01, threshold: 0.15, samples: pass ? [0.41, 0.41, 0.42, 0.47, 0.55, 0.57, 0.57] : [0.41, 0.42, 0.41, 0.42, 0.42] },
      pass,
      note: pass ? `sent ${m.payload.widgetId.toUpperCase()} → light got 38 % brighter ✓` : 'sent OFF → no change ✗ (retry 2 of 3)',
    }, iphone);
  }
});
ws.on('close', (code) => { console.log(`[mock] socket closed ${code}`); process.exit(0); });
ws.on('error', (e) => { console.error(`[mock] ${e.message}`); process.exit(1); });
