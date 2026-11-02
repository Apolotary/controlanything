import { ceilingDimmer } from '@ce/gen3d';
import { describe, expect, it } from 'vitest';
import { SAMPLE_HACKSET } from './driver.test';
import {
  DROPPABLE_TYPES,
  encodeMessage,
  makeMessage,
  MESSAGE_TYPES,
  newId,
  parseMessage,
  PayloadSchemas,
  PROTOCOL_VERSION,
  SERVER_ONLY_TYPES,
  Widget,
} from './index';

describe('envelope', () => {
  it('makeMessage fills v, id, ts and from', () => {
    const m = makeMessage('control.event', { widgetId: 'cutoff', value: 0.5, ts: 1 });
    expect(m.v).toBe(PROTOCOL_VERSION);
    expect(m.type).toBe('control.event');
    expect(m.id).toMatch(/^m/);
    expect(typeof m.ts).toBe('number');
    expect(m.from).toBe('');
    expect('to' in m).toBe(false);
    expect(makeMessage('log', { level: 'info', message: 'x' }, { to: 'dev1', from: 'server' })).toMatchObject({ to: 'dev1', from: 'server' });
  });

  it('round-trips through JSON', () => {
    const r = parseMessage(encodeMessage('control.event', { widgetId: 'pad', value: { x: 0.1, y: 0.9 }, ts: 2, phase: 'move' }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.message.type).toBe('control.event');
      expect(r.experimental).toBe(false);
    }
  });

  it('rejects bad JSON, wrong version, unknown types and invalid payloads with readable issues', () => {
    expect(parseMessage('{nope')).toMatchObject({ ok: false, error: 'not valid JSON' });
    expect(parseMessage('[1]')).toMatchObject({ ok: false });
    expect(parseMessage({ ...makeMessage('log', { level: 'info', message: 'x' }), v: 2 })).toMatchObject({ ok: false, error: expect.stringMatching(/version/) });
    expect(parseMessage({ ...makeMessage('log', { level: 'info', message: 'x' }), type: 'nope' })).toMatchObject({ ok: false, type: 'nope' });
    const bad = parseMessage(JSON.stringify({ ...makeMessage('control.event', { widgetId: 'w', value: 1, ts: 1 }), payload: { value: 'loud' } }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).toBe('invalid control.event');
      expect(bad.issues.join('\n')).toMatch(/payload\.widgetId/);
      expect(bad.id).toMatch(/^m/);
    }
  });

  it('relays experimental x.* types with envelope-only checks and keeps the raw object', () => {
    const r = parseMessage({ v: 1, type: 'x.hand.pose', id: 'a', ts: 1, from: '', payload: { anything: [1, 2] }, extra: true });
    expect(r).toMatchObject({ ok: true, experimental: true });
    if (r.ok) expect(r.raw.extra).toBe(true);
  });

  it('newId works without crypto.randomUUID and is unique', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newId('x')));
    expect(ids.size).toBe(200);
  });

  it('has a payload schema for every type in the brief', () => {
    for (const t of ['hello', 'welcome', 'presence', 'snapshot', 'agent.step', 'device.card', 'ui.spec', 'control.event', 'driver.deploy', 'driver.status', 'log']) {
      expect(MESSAGE_TYPES).toContain(t);
    }
    for (const t of ['pair.start', 'pair.status', 'pair.approve', 'pair.deny', 'pair.pending', 'pair.approved', 'pair.denied']) {
      expect(Object.keys(PayloadSchemas)).toContain(t);
    }
  });
});

describe('payloads', () => {
  it('accepts a full snapshot with pose, intrinsics and detections', () => {
    const r = parseMessage(
      makeMessage('snapshot', {
        snapshotId: 's1',
        jpegBase64: '/9j/4AAQ',
        width: 1280,
        height: 960,
        capturedAt: Date.now(),
        space: 'local-floor',
        headPose: { position: { x: 0, y: 1.6, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
        intrinsics: { fx: 900, fy: 900, cx: 640, cy: 480, width: 1280, height: 960 },
        detections: [{ label: 'keyboard', score: 0.8, bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.2 }, trackId: 't1' }],
        text: 'what is this?',
      }),
    );
    expect(r.ok).toBe(true);
  });

  it('accepts a ui.spec with every widget kind and rejects an empty one', () => {
    const spec = {
      specId: 'u1',
      title: 'Synth',
      widgets: [
        { id: 'cutoff', kind: 'knob', label: 'Cutoff', range: { min: 0, max: 127 }, default: 64, binding: { action: 'midi.cc', channel: 1, cc: 74 } },
        { id: 'level', kind: 'fader', label: 'Level', binding: { action: 'midi.cc', cc: 7 } },
        { id: 'play', kind: 'button', label: 'Play', binding: { action: 'transport.play' } },
        { id: 'mute', kind: 'toggle', label: 'Mute', default: false, binding: { action: 'mute', args: { track: 1 } } },
        { id: 'xy', kind: 'xy', label: 'Filter XY', binding: { action: 'midi.cc', cc: 74 }, yBinding: { action: 'midi.cc', cc: 71 } },
        { id: 'drums', kind: 'pads', label: 'Drums', binding: { action: 'midi.note', channel: 10 }, pads: [{ note: 36, label: 'Kick' }] },
      ],
    };
    expect(PayloadSchemas['ui.spec'].safeParse(spec).success).toBe(true);
    expect(PayloadSchemas['ui.spec'].safeParse({ ...spec, widgets: [] }).success).toBe(false);
    expect(PayloadSchemas['ui.spec'].safeParse({ ...spec, widgets: [{ ...spec.widgets[0], kind: 'slider' }] }).success).toBe(false);
  });

  it('bounds device.card confidence and MIDI fields', () => {
    const card = { cardId: 'c1', name: 'Digitakt II', maker: 'Elektron', model: 'DT2', category: 'drum-machine', confidence: 0.9, protocols: ['midi'], evidence: ['logo'] };
    expect(PayloadSchemas['device.card'].safeParse(card).success).toBe(true);
    expect(PayloadSchemas['device.card'].safeParse({ ...card, confidence: 1.2 }).success).toBe(false);
    expect(Widget.shape.binding.safeParse({ action: 'midi.cc', channel: 17 }).success).toBe(false);
  });
});

describe('protocol v1: discovery loop', () => {
  it('has every SPEC §3.1 message type and marks the server-only ones', () => {
    for (const t of [
      'scan.frame', 'scan.result', 'target.select', 'target.cancel', 'target.retry', 'target.status', 'link.request', 'link.result', 'driver.spec', 'driver.status',
      'exec.command', 'exec.ack', 'sense.request', 'sense.result', 'verify.result', 'arm.request', 'arm.confirm', 'arm.result',
      'panic', 'voice.audio', 'voice.text', 'ui.spec', 'ui.partial', 'gen3d.generate', 'gen3d.edit', 'device.signal', 'daemon.status',
    ]) {
      expect(MESSAGE_TYPES).toContain(t);
    }
    for (const t of ['exec.command', 'sense.request', 'verify.result', 'arm.request', 'scan.result', 'link.request', 'driver.spec']) expect(SERVER_ONLY_TYPES).toContain(t);
    for (const t of ['exec.ack', 'sense.result', 'arm.confirm', 'scan.frame', 'control.event', 'panic', 'target.cancel', 'target.retry']) expect(SERVER_ONLY_TYPES).not.toContain(t);
    expect(DROPPABLE_TYPES).toContain('scan.frame');
  });

  it.each(['target.cancel', 'target.retry'] as const)('%s addresses a target and optionally one run', (type) => {
    for (const payload of [{ cardId: 'c1' }, { cardId: 'c1', runId: 'r1' }]) {
      const result = parseMessage(encodeMessage(type, payload, { to: 'server' }));
      expect(result).toMatchObject({ ok: true, message: { type, payload } });
    }
    expect(PayloadSchemas[type].safeParse({}).success).toBe(false);
    expect(PayloadSchemas[type].safeParse({ cardId: 'c1', runId: '' }).success).toBe(false);
    expect(DROPPABLE_TYPES).not.toContain(type);
  });

  it('accepts plain guidance while keeping older step and target messages valid', () => {
    const step = { stepId: 's1', phase: 'identify' as const, status: 'running' as const, title: 'Identify' };
    const target = { cardId: 'c1', state: 'identifying' as const, since: 1 };
    for (const [type, payload] of [['agent.step', step], ['target.status', target]] as const) {
      expect(PayloadSchemas[type].safeParse(payload).success).toBe(true);
      for (const action of ['retry', 'cancel', 'open-companion', 'pair-device'] as const) {
        const guided = { ...payload, runId: 'r1', sentence: 'Working out what this is…', hint: 'Keep the device in view.', action };
        expect(PayloadSchemas[type].parse(guided)).toEqual(guided);
      }
      expect(PayloadSchemas[type].safeParse({ ...payload, action: 'send-command' }).success).toBe(false);
      expect(PayloadSchemas[type].safeParse({ ...payload, sentence: 'x'.repeat(201) }).success).toBe(false);
      expect(PayloadSchemas[type].safeParse({ ...payload, hint: 'x'.repeat(301) }).success).toBe(false);
    }
  });

  it('accepts a scan.frame without pose (handheld) and with full camera info (Quest)', () => {
    const minimal = { frameId: 'f1', jpeg: '/9j/4AAQ', width: 1280, height: 960, capturedAt: 1, purpose: 'scan' };
    expect(PayloadSchemas['scan.frame'].safeParse(minimal).success).toBe(true);
    const quest = {
      ...minimal,
      space: 'local-floor',
      pose: { position: { x: 0, y: 1.6, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
      camera: { width: 1280, height: 960, fovY: 58, intrinsics: { fx: 868.3, fy: 868.3, cx: 640.2, cy: 482.1 }, eye: 'left', source: 'passthrough', exposure: 'locked', cameraPose: { position: { x: 0, y: 1.6, z: -0.05 }, orientation: { x: 0, y: 0, z: 0, w: 1 } } },
      senseId: 's1',
    };
    expect(PayloadSchemas['scan.frame'].safeParse(quest).success).toBe(true);
    expect(PayloadSchemas['scan.frame'].safeParse({ ...minimal, purpose: 'track' }).success).toBe(false);
  });

  it('scan.result carries pixel boxes, <= 64-point polygons and the SAM model id', () => {
    const r = {
      frameId: 'f1', width: 1280, height: 960, modelId: 'sam-3.1', source: 'live', latencyMs: 1800, prompts: ['electronic device', 'ceiling light'],
      detections: [{ detId: 'd1', label: 'ceiling light', prompt: 'ceiling light', score: 0.93, box: [600, 20, 200, 120], polygon: [[600, 20], [800, 20], [800, 140], [600, 140]] }],
      qr: [{ text: 'https://192.168.1.2:8443/p/abc#K7Q4M2', pairingId: 'abc', approved: true }],
    };
    expect(PayloadSchemas['scan.result'].safeParse(r).success).toBe(true);
    expect(PayloadSchemas['scan.result'].safeParse({ ...r, detections: [{ ...r.detections[0], box: [1, 2, 3] }] }).success).toBe(false);
    const tooMany = Array.from({ length: 65 }, (_, i) => [i, i]);
    expect(PayloadSchemas['scan.result'].safeParse({ ...r, detections: [{ ...r.detections[0], polygon: tooMany }] }).success).toBe(false);
  });

  it('exec.command takes only executor ops (no step composites) and exec.ack carries reply bytes', () => {
    const base = { execId: 'e1', executorDeviceId: 'mac-1', port: 'OP-1' };
    expect(PayloadSchemas['exec.command'].safeParse({ ...base, op: { kind: 'midi', msg: 'cc', channel: 1, number: 46, value: 100 } }).success).toBe(true);
    expect(PayloadSchemas['exec.command'].safeParse({ ...base, op: { kind: 'ir', protocol: 'AEHA', bytes: [0x2c, 0x52, 0x09, 0x2f, 0x26], rawUs: [3456, 1728, 432, 432], khz: 38, repeats: 1, frameGapUs: 75000 } }).success).toBe(true);
    expect(PayloadSchemas['exec.command'].safeParse({ ...base, op: { kind: 'local', op: 'volume', arg: 40 } }).success).toBe(true);
    expect(PayloadSchemas['exec.command'].safeParse({ ...base, op: { kind: 'local', op: 'print', arg: { title: 'LINK', lines: ['light: ok'], verdict: 'ok' } } }).success).toBe(true);
    expect(PayloadSchemas['exec.command'].safeParse({ ...base, op: { kind: 'step', upActionId: 'a', downActionId: 'b', steps: 10 } }).success).toBe(false);
    expect(PayloadSchemas['exec.command'].safeParse({ ...base, op: { kind: 'midi', msg: 'cc', channel: 0, number: 46, value: 1 } }).success).toBe(false);
    expect(PayloadSchemas['exec.ack'].safeParse({ execId: 'e1', ok: true, sentAt: 1, reply: [0xf0, 0x7e, 0x33, 0x06, 0x02, 0x00, 0x20, 0x76, 0xf7], latencyMs: 3 }).success).toBe(true);
    expect(PayloadSchemas['exec.ack'].safeParse({ execId: 'e1', ok: false, sentAt: 1, error: 'no_port' }).success).toBe(true);
    expect(PayloadSchemas['exec.ack'].safeParse({ execId: 'e1', ok: false, sentAt: 1, error: 'exploded' }).success).toBe(false);
  });

  it('sense.result carries a frame, audio features or an IR capture', () => {
    const frame = { frameId: 'f2', jpeg: '/9j/', width: 640, height: 480, capturedAt: 2, purpose: 'verify', senseId: 's1', cardId: 'c1' };
    expect(PayloadSchemas['sense.result'].safeParse({ senseId: 's1', kind: 'frame', frame, at: 2 }).success).toBe(true);
    const audio = { rms: 0.2, rmsDb: -14, centroidHz: 1800, bands: [-40, -35, -30, -28, -30, -35, -40, -50], bandEdgesHz: [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000], windowMs: 600, input: 'OP-1', silent: false };
    expect(PayloadSchemas['sense.result'].safeParse({ senseId: 's2', kind: 'audio-features', audio, at: 3 }).success).toBe(true);
    expect(PayloadSchemas['sense.result'].safeParse({ senseId: 's3', kind: 'ir-capture', ir: { rawUs: [9000, 4500, 560, 560], khz: 38, protocol: 'UNKNOWN' }, at: 4 }).success).toBe(true);
    expect(PayloadSchemas['sense.request'].safeParse({ senseId: 's2', sensorDeviceId: 'mac-1', kind: 'audio-features', durationMs: 600, offsetMs: -500 }).success).toBe(true);
    expect(PayloadSchemas['sense.request'].safeParse({ senseId: 's4', sensorDeviceId: 'card-1', kind: 'ir-capture', durationMs: 15000, prompt: 'press 全灯 once' }).success).toBe(true);
    expect(PayloadSchemas['sense.result'].safeParse({ senseId: 's5', kind: 'audio-clip', clip: { wav: 'UklGRg==', sampleRate: 16000, durationMs: 3000 }, at: 5 }).success).toBe(true);
    expect(PayloadSchemas['device.signal'].safeParse({ signal: 'clock_bpm', value: 120, at: 1, cardId: 'synth' }).success).toBe(true);
    expect(PayloadSchemas['daemon.status'].safeParse({ daemonId: 'd_breathe', state: 'running', bpm: 120, rateHz: 1, source: 'midi-clock', at: 1 }).success).toBe(true);
    expect(PayloadSchemas['daemon.status'].safeParse({ daemonId: 'd', state: 'running', rateHz: 4, at: 1 }).success).toBe(false);
  });

  it('ui.spec v1 accepts a gen3d spec + hack set, and still accepts a v0 widget list', () => {
    const v0 = { specId: 'u0', title: 'Synth', widgets: [{ id: 'cutoff', kind: 'knob', label: 'Cutoff', binding: { action: 'midi.cc', cc: 74 } }] };
    expect(PayloadSchemas['ui.spec'].safeParse(v0).success).toBe(true);
    const v1 = { specId: 'u1', cardId: 'light', rev: 1, gen3d: ceilingDimmer, hackset: SAMPLE_HACKSET, source: 'live', modelId: 'muse-spark-1.3', check: { ok: true, attempts: 1, errors: 0, warnings: 0 } };
    const r = PayloadSchemas['ui.spec'].safeParse(v1);
    expect(r.success, JSON.stringify(r.success ? '' : r.error.issues.slice(0, 3))).toBe(true);
    expect(PayloadSchemas['ui.spec'].safeParse({ ...v1, hackset: { ...SAMPLE_HACKSET, hacks: [{ ...SAMPLE_HACKSET.hacks[0], max_rate_hz: 5 }] } }).success).toBe(false);
  });

  it('voice, arm and panic payloads', () => {
    expect(PayloadSchemas['voice.audio'].safeParse({ utteranceId: 'u1', seq: 0, sampleRate: 16000, pcm16: 'AAAA', final: true }).success).toBe(true);
    expect(PayloadSchemas['voice.audio'].safeParse({ utteranceId: 'u1', seq: 0, sampleRate: 44100, pcm16: 'AAAA' }).success).toBe(false);
    expect(PayloadSchemas['voice.text'].safeParse({ text: 'make resonance a big red lever', final: true, specId: 'u1' }).success).toBe(true);
    expect(PayloadSchemas['arm.request'].safeParse({ armId: 'a1', cardId: 'c1', driverId: 'd1', title: 'Arm OP-1 Field', summary: '4 verified controls', actions: [{ actionId: 'cc46', label: 'Blue', verified: 'pass' }], expiresAt: 9 }).success).toBe(true);
    expect(PayloadSchemas['arm.confirm'].safeParse({ armId: 'a1', approve: true, hold: true }).success).toBe(true);
    expect(PayloadSchemas.panic.safeParse({}).success).toBe(true);
    expect(PayloadSchemas['pair.start'].safeParse({ name: 'Cardputer', kind: 'cardputer', capabilities: ['ir', 'display'], requireApproval: true }).success).toBe(true);
    expect(PayloadSchemas['pair.start'].safeParse({ name: 'Sim room', kind: 'sim', capabilities: ['ir', 'midi', 'camera', 'mic', 'local', 'printer'] }).success).toBe(true);
    expect(PayloadSchemas['pair.start'].safeParse({ name: 'Nature Remo (Remo-E61798)', kind: 'remo', capabilities: ['ir'] }).success).toBe(true);
  });
});
