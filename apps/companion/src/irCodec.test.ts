import { IrOp } from '@ce/protocol';
import { describe, expect, it } from 'vitest';
import { aehaParityOk, checkTimings, decodeFrame, describeTimings, encodeFrame, irOpToRaw, msbValueToBytes, necBytes, necCommandOk } from './irCodec';
import { encodeHostLine, LineSplitter, parseDeviceLine } from './serial/protocol';

const jitter = (us: number[], pct: number) => us.map((x, i) => Math.round(x * (1 + (i % 2 ? pct : -pct))));

describe('irCodec', () => {
  it('encodes NEC (9.0/4.5 ms leader, 32 bits, trailer) and decodes it back with jitter', () => {
    const bytes = [0x82, 0x6d, 0xbe, 0x41]; // HotaluX CH1 off, a format example
    const us = encodeFrame({ proto: 'NEC', bytes });
    expect(us).toHaveLength(2 + 64 + 1);
    expect(us.slice(0, 2)).toEqual([9000, 4500]);
    expect(decodeFrame(jitter(us, 0.12))).toMatchObject({ proto: 'NEC', bytes });
    expect(necCommandOk(bytes)).toBe(true);
    expect(describeTimings(us)).toBe('NEC 82 6D BE 41');
  });

  it('encodes AEHA with its unit and checks the customer-code parity', () => {
    const bytes = [0x2c, 0x52, 0x09, 0x2f, 0x26]; // Panasonic CH1 off (format example)
    const us = encodeFrame({ proto: 'AEHA', bytes, unitUs: 432 });
    expect(us.slice(0, 2)).toEqual([3456, 1728]);
    expect(decodeFrame(jitter(us, 0.1))).toMatchObject({ proto: 'AEHA', bytes });
    expect(aehaParityOk(bytes)).toBe(true);
    expect(aehaParityOk([0x2c, 0x52, 0x08])).toBe(false);
  });

  it('builds NEC bytes from address/command and IRremoteESP8266 MSB-first values', () => {
    expect(necBytes(0x04, 0x08)).toEqual([0x04, 0xfb, 0x08, 0xf7]);
    expect(necBytes(0x6d82, 0xbe)).toEqual([0x82, 0x6d, 0xbe, 0x41]);
    expect(msbValueToBytes('0x41B67D82')).toEqual([0x82, 0x6d, 0xbe, 0x41]);
    expect(msbValueToBytes('zz')).toBeUndefined();
  });

  it('turns protocol IrOps into raw frames and refuses what the device cannot play', () => {
    const nec = irOpToRaw(IrOp.parse({ kind: 'ir', protocol: 'NEC', bytes: msbValueToBytes('0x41B67D82') }));
    expect(nec).toMatchObject({ ok: true, value: { khz: 38, repeats: 0, gapMs: 40, label: 'NEC 82 6D BE 41' } });
    expect(nec.ok && nec.value.us.slice(0, 2)).toEqual([9000, 4500]);
    const aeha = irOpToRaw(IrOp.parse({ kind: 'ir', protocol: 'AEHA', bytes: [0x2c, 0x52, 0x09, 0x2f, 0x26], repeats: 1, frameGapUs: 75_000, ref: 'lib:panasonic/hk/off' }));
    expect(aeha.ok && aeha.value.us[0]).toBe(3400);
    expect(aeha.ok && aeha.value).toMatchObject({ repeats: 1, gapMs: 75, label: 'panasonic/hk/off' });
    // the server fills rawUs: it wins over bytes
    const filled = irOpToRaw(IrOp.parse({ kind: 'ir', protocol: 'NEC', bytes: [1, 2, 3, 4], rawUs: [9000, 4500, 560, 560] }));
    expect(filled.ok && filled.value.us).toEqual([9000, 4500, 560, 560]);
    const raw = irOpToRaw(IrOp.parse({ kind: 'ir', protocol: 'RAW', rawUs: [3400, 1700, 425, 425, 425] }));
    expect(raw.ok && raw.value.label).toContain('RAW 5 edges');
    expect(irOpToRaw(IrOp.parse({ kind: 'ir', protocol: 'NEC', address: 0x6d82, command: 0xbe }))).toMatchObject({ ok: true, value: { label: 'NEC' } });
    expect(irOpToRaw(IrOp.parse({ kind: 'ir', protocol: 'SONY', address: 1, command: 2 }))).toMatchObject({ ok: false });
    expect(irOpToRaw(IrOp.parse({ kind: 'ir', protocol: 'RAW', rawUs: new Array(40).fill(60_000) }))).toMatchObject({ ok: false });
    expect(checkTimings([1, 2])).toBeUndefined();
    expect(checkTimings([1])).toContain('2-1024');
  });

  it('does not decode an unknown leader', () => {
    expect(decodeFrame([5000, 5000, 500, 500])).toBeUndefined();
    expect(describeTimings([5000, 5000, 500, 500])).toBe('RAW 4 edges · leader 5.0/5.0 ms');
  });
});

describe('serial protocol', () => {
  it('splits lines across chunks, strips CR and drops overlong lines', () => {
    const s = new LineSplitter(24);
    expect(s.push('{"t":"key",')).toEqual([]);
    expect(s.push('"key":"a"}\r\nROM boot\n')).toEqual(['{"t":"key","key":"a"}', 'ROM boot']);
    expect(s.push(`${'x'.repeat(30)}\n{"t":"log"}\n`)).toEqual(['{"t":"log"}']);
    expect(s.overlong).toBe(1);
  });

  it('parses device messages and ignores boot noise', () => {
    expect(parseDeviceLine('ESP-ROM:esp32s3-20210327')).toMatchObject({ kind: 'noise' });
    expect(parseDeviceLine('{oops')).toMatchObject({ kind: 'bad' });
    const hello = parseDeviceLine('{"t":"hello","proto":1,"fw":"ce-cardputer@0.1.0","board":"cardputer","chip":"a1b2c3d4e5f6","name":"Cardputer","caps":["ir","display","ir-rx"],"rx":"G1","tx":["G44","G2"]}');
    expect(hello).toMatchObject({ kind: 'message', message: { t: 'hello', board: 'cardputer', chip: 'a1b2c3d4e5f6', caps: ['ir', 'display', 'ir-rx'], tx: ['G44', 'G2'] } });
    const ack = parseDeviceLine('{"t":"ack","id":"c7","ok":false,"err":"busy","msg":"ir pending","ms":3,"fw":"x"}');
    expect(ack).toMatchObject({ kind: 'message', message: { t: 'ack', id: 'c7', ok: false, err: 'busy', ms: 3, extra: { fw: 'x' } } });
    expect(parseDeviceLine('{"t":"pick","item":"h-dim","key":"1"}')).toMatchObject({ message: { t: 'pick', item: 'h-dim', key: '1' } });
    expect(parseDeviceLine('{"t":"learned","us":[9000,4500,560],"khz":38,"proto":"NEC","bytes":"82 6D BE 41","marks":34}')).toMatchObject({
      message: { t: 'learned', us: [9000, 4500, 560], proto: 'NEC', marks: 34 },
    });
    expect(parseDeviceLine('{"t":"weird"}')).toMatchObject({ message: { t: 'other', type: 'weird' } });
  });

  it('encodes host commands with an id and enforces the line limit', () => {
    expect(encodeHostLine({ t: 'beep', hz: 2000, ms: 60 }, 'c1')).toBe('{"t":"beep","hz":2000,"ms":60,"id":"c1"}\n');
    expect(() => encodeHostLine({ t: 'ir', khz: 38, us: new Array(3000).fill(1000), repeats: 0, gapMs: 0 }, 'c2')).toThrow(/too long/);
  });
});
