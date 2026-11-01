import { Evidence } from '@ce/protocol';
import { describe, expect, it } from 'vitest';
import { describeOp } from '../executor';
import { evidenceSentence, observedPhrase, opSummary } from './words';

const ev = (over: Record<string, unknown>) =>
  Evidence.parse({
    evidenceId: 'ev1',
    actionId: 'a1',
    execId: 'x1',
    attempt: 1,
    sent: { op: { kind: 'midi', msg: 'cc', channel: 1, number: 46, value: 97 }, at: 1 },
    expected: { sense: 'audio', effect: 'tone-up' },
    observed: { sense: 'audio', metric: 'centroid', before: 400, after: 615, delta: 215, threshold: 0.3 },
    pass: true,
    ...over,
  });

describe('evidence words', () => {
  it('says what was sent and what was heard, with the measured number', () => {
    const s = evidenceSentence(ev({}));
    expect(s).toEqual({ text: 'sent CC 46 → 97 → tone up 0.62 oct', pass: true, verdict: 'heard ✓' });
  });

  it('reports a light that did not react', () => {
    const s = evidenceSentence(
      ev({
        sent: { op: { kind: 'ir', protocol: 'NEC', bytes: [0x82, 0x6d, 0xbe, 0x41], ref: 'lib:koizumi/KRH-TG-9A/dimmer' }, at: 1 },
        expected: { sense: 'camera', effect: 'dimmer' },
        observed: { sense: 'camera', metric: 'luma-mask-vs-ring', before: 1.2, after: 1.2, delta: 0, threshold: 0.1 },
        pass: false,
      }),
    );
    expect(s.text).toBe('sent koizumi/KRH-TG-9A/dimmer → no change');
    expect(s.verdict).toBe('no reaction ✗');
  });

  it('phrases camera deltas as measured percentages', () => {
    expect(observedPhrase(ev({ observed: { sense: 'camera', metric: 'luma-mask-vs-ring', before: 2, after: 1.24, delta: -0.76, threshold: 0.1 } }))).toBe('light got 38 % darker');
  });

  it('treats an expected "none" as a negative control', () => {
    const s = evidenceSentence(ev({ expected: { sense: 'audio', effect: 'none' }, sent: { op: { kind: 'midi', msg: 'cc', channel: 1, number: 20, value: 117 }, at: 1 }, observed: { sense: 'audio', metric: 'centroid', before: 400, after: 402, delta: 2, threshold: 0.3 } }));
    expect(s).toMatchObject({ pass: true, verdict: 'heard nothing ✓' });
    expect(s.text).toContain('negative control');
  });

  it('summarises ops for the tape', () => {
    expect(opSummary({ kind: 'ir', protocol: 'AEHA', bytes: [0x2c, 0x52] })).toBe('AEHA 2C 52');
    expect(opSummary({ kind: 'local', op: 'say', arg: 'blackout armed' })).toBe('say blackout armed');
    expect(describeOp({ execId: 'e', executorDeviceId: 'd', op: { kind: 'midi', msg: 'cc', channel: 1, number: 46, value: 69 }, port: 'OP-1' })).toEqual({ what: 'CC 46 → 69 · ch 1', target: 'OP-1' });
  });
});
