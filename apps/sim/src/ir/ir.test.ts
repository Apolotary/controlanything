import { describe, expect, it } from 'vitest';
import { aehaParityOk, decodeAll, decodeFrame, encodeFrame, encodePress, hex, necBytes, necCommandOk, parseHex, receiverDistort } from './codec';
import { codeFor, fromLearned, matchTimings, pressTimings, SIM_KZ, simBytes } from './table';

describe('IR codec', () => {
  it('round-trips AEHA and NEC frames, also through receiver distortion', () => {
    for (const [proto, s, unit] of [
      ['AEHA', '2C 52 09 2F 26', 432],
      ['NEC', '82 6D BE 41', undefined],
    ] as const) {
      const bytes = parseHex(s);
      const us = encodeFrame({ proto, bytes, unitUs: unit });
      expect(hex(decodeFrame(us)!.bytes)).toBe(s);
      expect(decodeFrame(us)!.proto).toBe(proto);
      const distorted = receiverDistort(us, 42);
      expect(hex(decodeFrame(distorted)!.bytes)).toBe(s);
      const jitter = us.map((x, i) => Math.round(x * (1 + (i % 3 === 0 ? 0.12 : -0.08))));
      expect(hex(decodeFrame([...jitter, 30_000])!.bytes)).toBe(s);
    }
  });

  it('encodes a press with extra frames (repeats = extra) and decodes each frame', () => {
    const us = encodePress({ proto: 'AEHA', bytes: [0x2c, 0x52, 0x09, 0x2f, 0x26], unitUs: 432 }, 1, 40_000);
    const frames = decodeAll(us);
    expect(frames).toHaveLength(2);
    expect(hex(frames[1]!.bytes)).toBe('2C 52 09 2F 26');
    expect(encodePress({ proto: 'NEC', bytes: [1, 2, 3, 0xfc] }, 0)).toHaveLength(2 + 64 + 1);
    expect(Math.max(...encodePress({ proto: 'NEC', bytes: [1] }, 1, 90_000))).toBe(65_000);
  });

  it('checks AEHA parity and NEC complements', () => {
    expect(aehaParityOk([0x2c, 0x52, 0x09])).toBe(true);
    expect(aehaParityOk([0x2c, 0x52, 0x08])).toBe(false);
    expect(necCommandOk(parseHex('82 6D BE 41'))).toBe(true);
    expect(necBytes(0x6d82, 0xbe)).toEqual(parseHex('82 6D BE 41'));
  });

  it('ignores noise', () => {
    expect(decodeFrame([100, 200, 300])).toBeUndefined();
    expect(decodeAll([5000, 5000, 5000, 5000])).toEqual([]);
  });
});

describe('SIM-KZ synthetic code set', () => {
  it('is a valid AEHA family with a made-up customer code and unique frames', () => {
    expect(SIM_KZ.synthetic).toBe(true);
    expect(SIM_KZ.codes).toHaveLength(16);
    const seen = new Set<string>();
    for (const c of SIM_KZ.codes) {
      expect(aehaParityOk(c.bytes)).toBe(true);
      expect(c.bytes[4]).toBe(c.bytes[2]! ^ c.bytes[3]!);
      seen.add(hex(c.bytes));
    }
    expect(seen.size).toBe(16);
    expect(hex(simBytes('off', 1))).toBe('CE 51 06 13 15');
  });

  it('matches its own presses on the right channel only', () => {
    const off1 = codeFor(SIM_KZ, 'off', 1)!;
    const us = receiverDistort(pressTimings(off1), 3);
    expect(matchTimings(SIM_KZ, us, 1).code?.cmd).toBe('off');
    const other = matchTimings(SIM_KZ, us, 2);
    expect(other.code).toBeUndefined();
    expect(other.otherChannel?.channel).toBe(1);
  });

  it('ignores other brands (the honest miss)', () => {
    const panasonicOff = encodeFrame({ proto: 'AEHA', bytes: parseHex('2C 52 09 2F 26'), unitUs: 432 });
    const necOff = encodeFrame({ proto: 'NEC', bytes: parseHex('82 6D BE 41') });
    for (const us of [panasonicOff, necOff]) {
      const m = matchTimings(SIM_KZ, us, 1);
      expect(m.code).toBeUndefined();
      expect(m.summary).toMatch(/not a code this lamp knows/);
    }
  });

  it('builds a code set from learned captures', () => {
    const learned = {
      remote: 'KOIZUMI KRH-TG-9A',
      codes: [
        { function: 'off', channel: 1, rawUs: receiverDistort(encodeFrame({ proto: 'NEC', bytes: parseHex('11 22 33 CC') }), 9) },
        { button: '全灯', channel: 1, protocol: 'AEHA', bytes: '40 04 01 2C 2D' },
        { function: 'mystery', rawUs: [1, 2, 3] },
      ],
    };
    const set = fromLearned(learned, 'koizumi')!;
    expect(set.synthetic).toBe(false);
    expect(set.codes.map((c) => c.cmd)).toEqual(['off', 'fullOn']);
    const us = encodeFrame({ proto: 'NEC', bytes: parseHex('11 22 33 CC') });
    expect(matchTimings(set, us, 1).code?.cmd).toBe('off');
    expect(fromLearned({ codes: [] })).toBeUndefined();
  });
});
