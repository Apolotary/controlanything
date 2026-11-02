import { Evidence } from '@ce/protocol';
import { describe, expect, it } from 'vitest';
import { describeOp } from '../executor';
import { agentPhaseName, companionText, evidenceSentence, isDevDevice, observedPhrase, opSummary } from './words';

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

describe('companion display wording', () => {
  it('translates server summaries without changing the counts or identifiers', () => {
    expect(companionText('Hack set ready: 5 hacks (2 controls)')).toBe('Control set ready: 5 controls (2 sliders)');
    expect(companionText('0/5 armed')).toBe('0 of 5 enabled');
    expect(companionText('NOT ARMED no confirmation in time')).toBe('Not enabled · No confirmation in time from the headset');
    expect(companionText('muse-spark-1.3 · OP-1 Field · V3GECL')).toBe('muse-spark-1.3 · OP-1 Field · V3GECL');
    expect(companionText('PANIC · ALL OFF')).toBe('Stop all');
  });

  it('gives protocol phases plain display names', () => {
    expect(agentPhaseName('forge')).toBe('Making controls');
    expect(agentPhaseName('verify')).toBe('Checking');
    expect(agentPhaseName('deploy')).toBe('Controls ready');
  });
});

describe('evidence words', () => {
  it('says what was sent and what was heard, with the measured number', () => {
    const s = evidenceSentence(ev({}));
    expect(s).toEqual({ text: 'Sent CC 46 → 97 → tone up 0.62 oct', pass: true, verdict: 'Heard ✓' });
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
    expect(s.text).toBe('Sent koizumi/KRH-TG-9A/dimmer → no change');
    expect(s.verdict).toBe('No reaction ✗');
  });

  it('phrases camera deltas as measured percentages', () => {
    expect(observedPhrase(ev({ observed: { sense: 'camera', metric: 'luma-mask-vs-ring', before: 2, after: 1.24, delta: -0.76, threshold: 0.1 } }))).toBe('light got 38 % darker');
  });

  it('treats an expected "none" as a negative control', () => {
    const s = evidenceSentence(ev({ expected: { sense: 'audio', effect: 'none' }, sent: { op: { kind: 'midi', msg: 'cc', channel: 1, number: 20, value: 117 }, at: 1 }, observed: { sense: 'audio', metric: 'centroid', before: 400, after: 402, delta: 2, threshold: 0.3 } }));
    expect(s).toMatchObject({ pass: true, verdict: 'Heard nothing ✓' });
    expect(s.text).toContain('negative control');
  });

  it('summarises ops for the recording', () => {
    expect(opSummary({ kind: 'ir', protocol: 'AEHA', bytes: [0x2c, 0x52] })).toBe('AEHA 2C 52');
    expect(opSummary({ kind: 'local', op: 'say', arg: 'blackout armed' })).toBe('say blackout armed');
    expect(describeOp({ execId: 'e', executorDeviceId: 'd', op: { kind: 'midi', msg: 'cc', channel: 1, number: 46, value: 69 }, port: 'OP-1' })).toEqual({ what: 'CC 46 → 69 · ch 1', target: 'OP-1' });
  });
});

describe('stage mode filter', () => {
  it('hides simulators, mocks, emulators and test nodes, keeps real devices', () => {
    for (const name of ['Test node (iPhone lane)', 'iPhone 18 Pro (sim)', 'mock-brain', 'Quest (desktop emulator)']) expect(isDevDevice({ kind: 'web', name })).toBe(true);
    expect(isDevDevice({ kind: 'sim', name: 'Sim room' })).toBe(true);
    for (const name of ['Cardputer', 'Quest 3', 'MacBook Pro', 'DevTerm (demo)', 'iPhone']) expect(isDevDevice({ kind: 'mac', name })).toBe(false);
  });
});
