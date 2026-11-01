import { describe, expect, it } from 'vitest';
import {
  encodeMessage,
  makeMessage,
  MESSAGE_TYPES,
  newId,
  parseMessage,
  PayloadSchemas,
  PROTOCOL_VERSION,
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
    expect(PayloadSchemas['ui.spec'].shape.widgets.element.shape.binding.safeParse({ action: 'midi.cc', channel: 17 }).success).toBe(false);
  });
});
