/**
 * ?replay=1: a scripted OP-1 Field run, injected into the workbench's own handlers so the panels can be
 * checked (and shown) without the agent. Display only: the banner says REPLAY, nothing is executed and
 * nothing is sent to the server. Every message is validated against the protocol schemas on injection.
 */
import { makeMessage, type MessageType, type PayloadOf } from '@ce/protocol';

type Step = { at: number; type: MessageType; payload: unknown };

const CARD = 'card-op1f';
const DRV = 'drv-op1f-1';
const t0 = () => Date.now();

function steps(): Step[] {
  const now = t0();
  const s = (id: string, phase: string, status: string, title: string, extra: Record<string, unknown> = {}) => ({ stepId: id, runId: 'run-replay', cardId: CARD, phase, status, title, ...extra });
  const cc = (n: number) => ({ kind: 'midi', msg: 'cc', channel: 1, number: n, value: '$value' });
  const ev = (id: string, actionId: string, n: number, before: number, after: number, pass: boolean, attempt = 1, note?: string, effect = 'tone-up') => ({
    evidenceId: id,
    cardId: CARD,
    driverId: DRV,
    actionId,
    execId: `x-${id}`,
    attempt,
    sent: { op: { kind: 'midi', msg: 'cc', channel: 1, number: n, value: 117 }, at: now + 9000 },
    expected: { sense: 'audio', effect },
    observed: { sense: 'audio', metric: 'centroid', before, after, delta: after - before, threshold: 0.3, sensorDeviceId: 'mac' },
    pass,
    ...(note ? { note } : {}),
  });
  return [
    { at: 0, type: 'agent.step', payload: s('st1', 'scan', 'running', 'SCAN · 6 prompts', { model: 'sam-3.1', startedAt: now }) },
    { at: 900, type: 'agent.step', payload: s('st1', 'scan', 'ok', 'SCAN · 3 devices outlined', { model: 'sam-3.1', startedAt: now, endedAt: now + 900, latencyMs: 900, kind: 'proof', evidence: 'synth · laptop · light' }) },
    { at: 1000, type: 'agent.step', payload: s('st2', 'identify', 'running', 'IDENTIFY the selected device', { model: 'muse-spark-1.3', effort: 'low', startedAt: now + 1000 }) },
    {
      at: 2600,
      type: 'device.card',
      payload: { cardId: CARD, name: 'OP-1 Field', maker: 'Teenage Engineering', model: 'TE002AS002', category: 'synthesizer', confidence: 0.91, protocols: ['midi'], evidence: ['OP-1 field logo', 'four coloured encoders', 'tape screen'], requires: ['midi'], companion: 'computer_usb', modelId: 'muse-spark-1.3' },
    },
    { at: 2600, type: 'agent.step', payload: s('st2', 'identify', 'ok', 'IDENTIFY → camera says OP-1 Field', { model: 'muse-spark-1.3', effort: 'low', startedAt: now + 1000, endedAt: now + 2600, latencyMs: 1600, kind: 'opinion', evidence: 'logo + 4 encoders' }) },
    { at: 2800, type: 'link.request', payload: { linkId: 'lk1', cardId: CARD, needs: ['midi'], reason: 'needs a USB-MIDI companion: plug the synth into the Mac', suggestedClients: ['mac'], status: 'waiting' } },
    {
      at: 4200,
      type: 'link.result',
      payload: {
        linkId: 'lk1',
        cardId: CARD,
        verdict: 'mismatch',
        channel: 'midi',
        port: { id: 'p-ep', kind: 'midi-out', name: 'EP-133' },
        evidence: [
          { kind: 'port-name', ok: false, detail: 'port "EP-133", not "OP-1"' },
          { kind: 'midi-identity', ok: false, detail: 'reply: Teenage Engineering family 0x0020 = EP-133' },
        ],
        reason: 'the cable goes to an EP-133 K.O. II, not the OP-1 Field the camera saw',
      },
    },
    { at: 4300, type: 'agent.step', payload: s('st3', 'link', 'fail', 'LINK refused: wrong device on the cable', { kind: 'proof', evidence: 'identity 0x0020 ≠ OP-1', latencyMs: 820 }) },
    {
      at: 6500,
      type: 'link.result',
      payload: {
        linkId: 'lk1',
        cardId: CARD,
        verdict: 'consistent',
        channel: 'midi',
        port: { id: 'p-op', kind: 'midi-out', name: 'OP-1', manufacturer: 'teenage engineering' },
        executorDeviceId: 'mac',
        evidence: [
          { kind: 'port-name', ok: true, detail: 'USB · teenage engineering OP-1' },
          { kind: 'midi-identity', ok: true, detail: 'no reply (expected for the OP-1)' },
        ],
      },
    },
    { at: 6600, type: 'agent.step', payload: s('st4', 'link', 'ok', 'LINK · USB MIDI via this Mac', { kind: 'proof', evidence: 'port OP-1 ✓', latencyMs: 640 }) },
    { at: 6700, type: 'agent.step', payload: s('st5', 'research', 'ok', 'RESEARCH · TE MIDI chart, firmware 1.7', { model: 'muse-spark-1.3', effort: 'low', latencyMs: 3100, detail: 'web_search: teenage.engineering/guides/op-1#midi-reference' }) },
    { at: 6800, type: 'agent.step', payload: s('st6', 'drive', 'running', 'DRIVE · writing the driver', { model: 'muse-wonder-1.0', startedAt: now + 6800 }) },
    {
      at: 10_800,
      type: 'driver.spec',
      payload: {
        driverId: DRV,
        cardId: CARD,
        name: 'OP-1 Field',
        transport: 'midi',
        executor: { deviceId: 'mac', port: 'OP-1' },
        provenance: [{ source: 'midi.guide', ref: 'teenage-engineering/op-1-field', note: 'CC 46-49 engine, 54-57 FX' }],
        actions: [
          { actionId: 'a-cut', label: 'Engine 1 (blue)', kind: 'set', range: { min: 0, max: 127 }, encode: cc(46), expect: { sense: 'audio', effect: 'tone-up' }, verified: 'pending' },
          { actionId: 'a-res', label: 'Engine 2 (ochre)', kind: 'set', range: { min: 0, max: 127 }, encode: cc(47), expect: { sense: 'audio', effect: 'any' }, verified: 'pending' },
          { actionId: 'a-fx', label: 'FX mix', kind: 'set', range: { min: 0, max: 127 }, encode: cc(57), expect: { sense: 'audio', effect: 'any' }, verified: 'pending' },
          { actionId: 'a-off', label: 'All notes off', kind: 'trigger', encode: { kind: 'midi', msg: 'cc', channel: 1, number: 123, value: 0 }, expect: { sense: 'none', effect: 'none' } },
        ],
        modelId: 'muse-wonder-1.0',
        source: 'live',
        version: 1,
      },
    },
    { at: 10_800, type: 'agent.step', payload: s('st6', 'drive', 'ok', 'DRIVE · 4 actions, allowlist ✓', { model: 'muse-wonder-1.0', startedAt: now + 6800, endedAt: now + 10_800, latencyMs: 19_400, kind: 'proof', evidence: 'schema ✓ chart ✓ ranges ✓' }) },
    { at: 11_000, type: 'driver.status', payload: { driverId: DRV, cardId: CARD, phase: 'verifying', actions: [{ actionId: 'a-cut', verified: 'pending' }, { actionId: 'a-res', verified: 'pending' }, { actionId: 'a-fx', verified: 'pending' }] } },
    { at: 12_500, type: 'verify.result', payload: ev('e1', 'a-cut', 46, 410, 640, true) },
    { at: 14_000, type: 'verify.result', payload: ev('e2', 'a-res', 47, 520, 524, false, 1, 'Caught: CC on channel 8') },
    { at: 15_500, type: 'verify.result', payload: ev('e3', 'a-res', 47, 520, 760, true, 2, 'wrong channel fixed') },
    { at: 17_000, type: 'verify.result', payload: ev('e4', 'a-fx', 57, 700, 1180, true) },
    { at: 18_500, type: 'verify.result', payload: { ...ev('e5', 'neg-20', 20, 615, 618, true, 1, undefined, 'none'), actionId: 'neg-20' } },
    { at: 19_000, type: 'driver.status', payload: { driverId: DRV, cardId: CARD, phase: 'verified', actions: [{ actionId: 'a-cut', verified: 'pass' }, { actionId: 'a-res', verified: 'pass' }, { actionId: 'a-fx', verified: 'pass' }] } },
    {
      at: 19_500,
      type: 'ui.spec',
      payload: {
        specId: 'spec-op1f-1',
        cardId: CARD,
        driverId: DRV,
        rev: 1,
        title: 'OP-1 Field hacks',
        modelId: 'muse-spark-1.3',
        hackset: {
          spec: 'ce.hackset/1',
          device: { id: CARD, name: 'OP-1 Field', kind: 'synth', channel: { type: 'midi', via: 'mac' } },
          hacks: [
            { id: 'h_open_filter', name: 'Open filter', kind: 'control', blurb: 'engine param 1', params: [{ id: 'p1', name: 'Cutoff', min: 0, max: 127 }], control: { archetype: 'knob', param: 'p1' }, commands: [{ action: 'a-cut', param: 'p1' }], oracle: { type: 'mic', expect: 'centroid_up' }, max_rate_hz: 3, status: 'verified' },
            { id: 'h_bite', name: 'Add bite', kind: 'control', params: [{ id: 'p2', name: 'Res', min: 0, max: 127 }], control: { archetype: 'knob', param: 'p2' }, commands: [{ action: 'a-res', param: 'p2' }], oracle: { type: 'mic', expect: 'colour_shift' }, max_rate_hz: 3, status: 'verified' },
            { id: 'h_space', name: 'Add space', kind: 'control', params: [{ id: 'p3', name: 'Mix', min: 0, max: 127 }], control: { archetype: 'slider', param: 'p3' }, commands: [{ action: 'a-fx', param: 'p3' }], oracle: { type: 'mic', expect: 'louder' }, max_rate_hz: 3, status: 'verified' },
          ],
          daemons: [{ id: 'd_breathe', name: 'Breathe to tempo', blurb: 'light follows the synth', trigger: { source: `device.${CARD}.clock_bpm` }, targets: [{ hack: 'h_open_filter' }], max_rate_hz: 1, status: 'proposed' }],
          modelId: 'muse-spark-1.3',
        },
      },
    },
    {
      at: 20_000,
      type: 'arm.request',
      payload: {
        armId: 'arm1',
        cardId: CARD,
        driverId: DRV,
        title: '3 verified hacks for OP-1 Field',
        summary: 'Open filter · Add bite · Add space, each heard on the synth’s USB audio',
        actions: [
          { actionId: 'a-cut', label: 'Engine 1 (blue)', verified: 'pass' },
          { actionId: 'a-res', label: 'Engine 2 (ochre)', verified: 'pass' },
          { actionId: 'a-fx', label: 'FX mix', verified: 'pass' },
        ],
        expiresAt: now + 120_000,
      },
    },
  ];
}

/** Inject the script; returns a stop function. */
export function runReplay(inject: (m: object) => boolean, done: () => void): () => void {
  const timers = steps().map((st) => setTimeout(() => inject(makeMessage(st.type, st.payload as PayloadOf<typeof st.type>, { from: 'server' })), st.at));
  timers.push(setTimeout(done, 20_500));
  return () => timers.forEach(clearTimeout);
}

/** The arm.result the replay answers an arm.confirm with. */
export function replayArmResult(armId: string, approve: boolean) {
  return makeMessage('arm.result', { armId, cardId: CARD, driverId: DRV, armed: approve, by: 'Mac companion (replay)', ...(approve ? {} : { reason: 'cancelled on the Mac' }) }, { from: 'server' });
}
