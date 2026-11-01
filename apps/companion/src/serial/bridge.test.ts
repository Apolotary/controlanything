import { ExecCommandPayload, IrCapture } from '@ce/protocol';
import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import { encodeFrame } from '../irCodec';
import { CardputerBridge, countFrames, pairScreenCommand, toCapture } from './bridge';
import { encodeHostLine } from './protocol';
import type { CardputerLink, SerialAck } from './cardputer';
import { parseDeviceLine } from './protocol';

const panasonicOff = [0x2c, 0x52, 0x09, 0x2f, 0x26];

describe('Cardputer pairing screen', () => {
  it('shows the short CE1:<CODE> QR (uppercase, no dash) and the readable code beside it', () => {
    const cmd = pairScreenCommand({ code: 'k7q-4m2', display: 'K7Q-4M2', expiresAt: 301_000 }, 1000);
    expect(cmd).toEqual({ t: 'pair', state: 'pending', code: 'K7Q4M2', display: 'K7Q-4M2', qr: 'CE1:K7Q4M2', ttlMs: 300_000 });
    expect(encodeHostLine(cmd, 'p1')).toBe('{"t":"pair","state":"pending","code":"K7Q4M2","display":"K7Q-4M2","qr":"CE1:K7Q4M2","ttlMs":300000,"id":"p1"}\n');
  });

  it('fits a version-1 QR (21 modules: 5 px each in 135 px), where the pairing URL needs version 4', () => {
    expect(QRCode.create('CE1:K7Q4M2', { errorCorrectionLevel: 'M' }).version).toBe(1);
    expect(QRCode.create('https://192.168.1.20:8443/p/abcdefghij#K7Q4M2', { errorCorrectionLevel: 'M' }).version).toBeGreaterThanOrEqual(3);
    expect(pairScreenCommand({ code: 'ABCDEF', display: '', expiresAt: 0 }, 5).display).toBe('ABC-DEF');
  });
});

describe('learned → IrCapture', () => {
  it('maps the Cardputer learned event to a valid protocol IrCapture (hex bytes → numbers)', () => {
    const one = encodeFrame({ proto: 'AEHA', bytes: panasonicOff, unitUs: 432 });
    const us = [...one.slice(0, -1), one.at(-1)!, 40_000, ...one]; // two frames, 40 ms apart
    const line = JSON.stringify({ t: 'learned', us, khz: 38, protocol: 'AEHA', bytes: '2C 52 09 2F 26', unitUs: 432, frames: 2, frameGapUs: 40000, checkOk: true, label: '消灯' });
    const p = parseDeviceLine(line);
    if (p.kind !== 'message' || p.message.t !== 'learned') throw new Error('not parsed');
    const cap = toCapture(p.message);
    expect(IrCapture.safeParse(cap).success).toBe(true);
    expect(cap).toMatchObject({ khz: 38, protocol: 'AEHA', bytes: panasonicOff, unitUs: 432, frames: 2, frameGapUs: 40000 });
    expect(cap.rawUs).toHaveLength(us.length);
  });

  it('decodes on the companion when the device did not', () => {
    const us = encodeFrame({ proto: 'NEC', bytes: [0x82, 0x6d, 0xbe, 0x41] });
    const cap = toCapture({ t: 'learned', us, khz: 38 });
    expect(cap).toMatchObject({ protocol: 'NEC', bytes: [0x82, 0x6d, 0xbe, 0x41], frames: 1 });
    expect(countFrames([9000, 4500, 560, 20000, 9000, 4500])).toBe(2);
    expect(toCapture({ t: 'learned', us: [5000, 5000, 500, 500], khz: 38 }).protocol).toBe('UNKNOWN');
  });
});

describe('CardputerBridge.exec', () => {
  function fakeLink(reply: Partial<SerialAck> = { ok: true, ms: 68 }) {
    const sent: unknown[] = [];
    const link = {
      ready: true,
      info: { caps: ['ir'], chip: 'a1b2c3d4e5f6', fw: 'ce-cardputer@0.1.0', board: 'cardputer' },
      sendIr: async (raw: unknown, extra?: unknown) => {
        sent.push(raw);
        sent.push(extra);
        return { id: 'c1', writtenAt: performance.now(), writtenEpoch: 1234, ...reply } as SerialAck;
      },
      request: async () => ({ id: 'c2', ok: true }) as SerialAck,
    };
    return { link: link as unknown as CardputerLink, sent };
  }
  const cmd = (op: object, extra: object = {}) => ExecCommandPayload.parse({ execId: 'x1', executorDeviceId: 'cp-1', op, ...extra });

  it('plays the server-filled rawUs and acks with the device line in detail', async () => {
    const { link, sent } = fakeLink();
    const b = new CardputerBridge(link, 'test');
    const ack = await b.exec(cmd({ kind: 'ir', protocol: 'NEC', bytes: [0x82, 0x6d, 0xbe, 0x41], rawUs: encodeFrame({ proto: 'NEC', bytes: [0x82, 0x6d, 0xbe, 0x41] }), ref: 'lib:hotalux/re0201/off' }));
    expect(ack).toMatchObject({ execId: 'x1', ok: true, sentAt: 1234 });
    expect(ack.detail).toContain('hotalux/re0201/off (built-in LED) → Cardputer (68 ms on device)');
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({ tx: 'led' });
    expect((sent[0] as { us: number[] }).us.slice(0, 2)).toEqual([9000, 4500]);
  });

  it('maps device errors to protocol error codes', async () => {
    const { link } = fakeLink({ ok: false, err: 'busy', msg: 'ir pending' });
    const ack = await new CardputerBridge(link, 'test').exec(cmd({ kind: 'ir', protocol: 'RAW', rawUs: [9000, 4500, 560, 560] }));
    expect(ack).toMatchObject({ ok: false, error: 'rate_limited' });
    const { link: l2 } = fakeLink();
    expect((await new CardputerBridge(l2, 'test').exec(cmd({ kind: 'midi', msg: 'cc', channel: 1, number: 1, value: 1 }))).error).toBe('unsupported');
    const dry = await new CardputerBridge(l2, 'test').exec(cmd({ kind: 'ir', protocol: 'RAW', rawUs: [9000, 4500, 560, 560] }, { dryRun: true }));
    expect(dry.detail).toContain('dry run');
  });
});
