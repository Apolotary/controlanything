import { describe, expect, it } from 'vitest';
import { fromHex, parseIdentityReply } from '../midiDecode';
import { unsafeReason } from '../midiExec';
import { CHARTS, chartForPort, checkIdentity } from './charts';

const [OP1, EP133, MOVE] = CHARTS;
const ep133Reply = parseIdentityReply(fromHex('F0 7E 33 06 02 00 20 76 20 00 02 00 00 00 00 00 F7')!)!;

describe('charts', () => {
  it('picks a chart from the port name', () => {
    expect(chartForPort('OP-1')?.id).toBe('op-1-field');
    expect(chartForPort('EP-133')?.id).toBe('ep-133');
    expect(chartForPort('Ableton Move Standalone Port')?.id).toBe('ableton-move');
    expect(chartForPort('IAC Driver Bus 1')).toBeUndefined();
  });

  it('never sweeps a CC the executor would refuse, or a skipped one', () => {
    for (const c of CHARTS) {
      const skipped = new Set(c.skipped.map((s) => s.cc));
      for (const s of c.sweep) {
        expect(skipped.has(s.cc)).toBe(false);
        expect(unsafeReason(c.name, [0xb0, s.cc, 127])).toBeUndefined();
      }
      expect(c.sweep.some((s) => s.cc === c.negativeCc)).toBe(false);
    }
    expect(OP1.sweep.slice(0, 4).map((s) => s.cc)).toEqual([46, 47, 48, 49]);
  });
});

describe('checkIdentity', () => {
  it('EP-133 reply on an EP-133 port: confirmed', () => {
    expect(checkIdentity(EP133, 'EP-133', ep133Reply).verdict).toBe('confirmed');
  });

  it('EP-133 reply while expecting the OP-1 Field: wrong device, refused', () => {
    const r = checkIdentity(OP1, 'EP-133', ep133Reply);
    expect(r.verdict).toBe('mismatch');
    expect(r.actual?.id).toBe('ep-133');
    expect(r.text).toContain('wrong device · refused');
  });

  it('no reply on the OP-1 port is consistent (port name only)', () => {
    expect(checkIdentity(OP1, 'OP-1', undefined).verdict).toBe('consistent');
    expect(checkIdentity(OP1, 'IAC Driver', undefined).verdict).toBe('unknown');
  });

  it('a TE reply with a new family on the OP-1 port confirms it and asks to record the family', () => {
    const r = checkIdentity(OP1, 'OP-1', parseIdentityReply(fromHex('F0 7E 7F 06 02 00 20 76 02 00 01 00 01 07 03 00 F7')!));
    expect(r.verdict).toBe('confirmed');
    expect(r.text).toContain('Record this family');
  });

  it('another maker is a mismatch', () => {
    const roland = parseIdentityReply(fromHex('F0 7E 10 06 02 41 0E 02 00 00 00 03 00 00 F7')!)!;
    expect(checkIdentity(OP1, 'OP-1', roland).verdict).toBe('mismatch');
    expect(MOVE.identity.sendRequest).toBe(false);
  });
});
