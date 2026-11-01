import { describe, expect, it } from 'vitest';
import { clearIdentity, IDENTITY_KEY, type KeyValueStore, loadIdentity, QUEST_IDENTITY_KEY, saveIdentity } from './identity';
import { evidenceSentence, normalizeDetections, type VerifyResultPayload } from './v1';
import { readEnvelope } from './ws';

function memStore(init: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...init };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => void (data[k] = v),
    removeItem: (k) => void delete data[k],
  };
}

describe('identity (localStorage "ce.device")', () => {
  const quest = { deviceId: 'quest-1', deviceToken: 'tok-q', kind: 'quest' as const, name: 'Quest 3' };
  const mac = { deviceId: 'mac-1', deviceToken: 'tok-m', kind: 'mac' as const, name: 'Mac companion' };

  it('stores the headset under ce.device when it is free', () => {
    const s = memStore();
    saveIdentity(quest, s);
    expect(JSON.parse(s.data[IDENTITY_KEY])).toEqual(quest);
    expect(loadIdentity(s)).toEqual(quest);
  });

  it('never clobbers a companion identity on the same origin (desktop testing)', () => {
    const s = memStore({ [IDENTITY_KEY]: JSON.stringify(mac) });
    expect(loadIdentity(s)).toBeUndefined();
    saveIdentity(quest, s);
    expect(JSON.parse(s.data[IDENTITY_KEY])).toEqual(mac);
    expect(JSON.parse(s.data[QUEST_IDENTITY_KEY])).toEqual(quest);
    expect(loadIdentity(s)).toEqual(quest);
    clearIdentity(s);
    expect(JSON.parse(s.data[IDENTITY_KEY])).toEqual(mac);
    expect(s.data[QUEST_IDENTITY_KEY]).toBeUndefined();
  });

  it('ignores garbage', () => {
    expect(loadIdentity(memStore({ [IDENTITY_KEY]: '{not json' }))).toBeUndefined();
    expect(loadIdentity(memStore({ [IDENTITY_KEY]: '{"deviceId":""}' }))).toBeUndefined();
  });
});

describe('normalizeDetections', () => {
  it('passes pixel boxes and polygons through, drops invalid entries', () => {
    const d = normalizeDetections(
      [
        { detId: 'a', label: 'synthesizer', prompt: 'synthesizer', score: 0.9, box: [10, 20, 100, 50], polygon: [[10, 20], [110, 20], [110, 70]], cardId: 'c1' },
        { detId: 'b', label: 'x', box: [1, 2] },
        { detId: 'c', label: 'y', box: [5, 5, 0, 10] },
        'nope',
      ],
      1280,
      960,
    );
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ detId: 'a', box: [10, 20, 100, 50], cardId: 'c1' });
    expect(d[0].polygon).toHaveLength(3);
  });

  it('scales normalised {x,y,w,h} boxes to pixels', () => {
    const [d] = normalizeDetections([{ detId: 7, label: 'ceiling light', score: 0.95, box: { x: 0.5, y: 0.1, w: 0.25, h: 0.1 } }], 1280, 960);
    expect(d.detId).toBe('7');
    expect(d.box).toEqual([640, 96, 320, 96]);
  });
});

describe('evidenceSentence', () => {
  const base = {
    evidenceId: 'e1',
    actionId: 'brighter',
    execId: 'x1',
    attempt: 1,
    sent: { op: { kind: 'ir', protocol: 'NEC', command: 16 }, at: 0 },
    expected: { sense: 'camera', effect: 'brighter' },
    observed: { sense: 'camera', metric: 'luma-mask-vs-ring', before: 0.4, after: 0.78, delta: 0.38, threshold: 0.1 },
    pass: true,
  } as unknown as VerifyResultPayload;

  it('reads as a sentence with the measured delta', () => {
    expect(evidenceSentence(base)).toEqual({ sent: 'IR NEC 16', expect: 'got brighter', seen: 'seen 38 % ✓', verdict: 'ok' });
  });
  it('an honest miss', () => {
    const miss = { ...base, pass: false } as VerifyResultPayload;
    expect(evidenceSentence(miss).seen).toBe('no reaction ✗');
    expect(evidenceSentence(miss).verdict).toBe('fail');
  });
  it('MIDI and audio', () => {
    const midi = { ...base, sent: { op: { kind: 'midi', msg: 'cc', channel: 1, number: 74, value: 100 }, at: 0 }, observed: { ...base.observed, sense: 'audio', metric: 'centroid' } } as unknown as VerifyResultPayload;
    expect(evidenceSentence(midi)).toMatchObject({ sent: 'CC 74 = 100', seen: 'heard ✓' });
  });
});

describe('readEnvelope', () => {
  it('validates known types with @ce/protocol', () => {
    const ok = readEnvelope(JSON.stringify({ v: 1, type: 'toast.unknown', id: 'm1', ts: 1, from: 'server', payload: { a: 1 } }));
    expect(ok.ok).toBe(true);
    const bad = readEnvelope(JSON.stringify({ v: 1, type: 'scan.result', id: 'm2', ts: 1, from: 'server', payload: { frameId: 'f' } }));
    expect(bad.ok).toBe(false);
    expect(readEnvelope('not json').ok).toBe(false);
    expect(readEnvelope(JSON.stringify({ v: 2, type: 'x', id: 'm', ts: 1, from: '', payload: {} })).ok).toBe(false);
  });
});
