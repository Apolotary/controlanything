import { describe, expect, it } from 'vitest';
import {
  controlChange,
  describeIdentity,
  describeMidi,
  fromHex,
  IDENTITY_REQUEST,
  isIdentityRequest,
  isRealtimeNoise,
  manufacturerName,
  noteName,
  noteOff,
  noteOn,
  parseIdentityReply,
  programChange,
  toHex,
} from './midiDecode';

describe('midiDecode', () => {
  it('names notes with middle C = C4', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(69)).toBe('A4');
    expect(noteName(0)).toBe('C-1');
  });

  it('describes channel and system messages', () => {
    expect(describeMidi([0x90, 60, 100])).toBe('Note on ch1 C4 v100');
    expect(describeMidi([0x9f, 60, 0])).toBe('Note off ch16 C4');
    expect(describeMidi([0xb0, 74, 64])).toBe('CC ch1 #74 = 64');
    expect(describeMidi([0xc2, 4])).toBe('Program ch3 5');
    expect(describeMidi([0xe0, 0, 64])).toBe('Pitch bend ch1 0');
    expect(describeMidi([0xf0, 0x43, 0x10, 0xf7])).toBe('SysEx (4 bytes)');
    expect(describeMidi([0xfa])).toBe('Start');
    expect(describeMidi(IDENTITY_REQUEST)).toBe('Identity request');
  });

  it('builds note, CC and program bytes and spots clock noise', () => {
    expect(noteOn(1, 60, 100)).toEqual([0x90, 60, 100]);
    expect(noteOff(10, 36)).toEqual([0x89, 36, 0]);
    expect(controlChange(1, 46, 69)).toEqual([0xb0, 0x2e, 0x45]);
    expect(controlChange(16, 123, 0)).toEqual([0xbf, 123, 0]);
    expect(programChange(2, 7)).toEqual([0xc1, 7]);
    expect(isRealtimeNoise([0xf8])).toBe(true);
    expect(isRealtimeNoise([0x90, 1, 1])).toBe(false);
    expect(toHex([0x90, 0x3c, 0x64])).toBe('90 3C 64');
  });

  it('parses hex text', () => {
    expect(fromHex('F0 7E 7F 06 01 F7')).toEqual([...IDENTITY_REQUEST]);
    expect(fromHex('0x2c,0x52')).toEqual([0x2c, 0x52]);
    expect(fromHex('F0 7')).toBeUndefined();
    expect(fromHex('zz')).toBeUndefined();
  });

  it('parses the EP-133 identity reply (device byte 0x33, TE 00 20 76, family 0x0020)', () => {
    const reply = fromHex('F0 7E 33 06 02 00 20 76 20 00 02 00 00 00 00 00 F7')!;
    const id = parseIdentityReply(reply)!;
    expect(id.deviceId).toBe(0x33);
    expect(id.manufacturer).toEqual([0x00, 0x20, 0x76]);
    expect(id.manufacturerName).toBe('Teenage Engineering');
    expect(id.family).toBe(0x20);
    expect(id.member).toBe(2);
    expect(id.version).toEqual([0, 0, 0, 0]);
    expect(describeMidi(reply)).toContain('Teenage Engineering');
    expect(describeIdentity(id)).toContain('family 0x0020');
  });

  it('parses a one-byte manufacturer and the Move family (LSB-first 7-bit pairs)', () => {
    const sim = parseIdentityReply(fromHex('F0 7E 7F 06 02 7D 01 00 01 00 00 01 00 00 F7')!)!;
    expect(sim.manufacturer).toEqual([0x7d]);
    expect(sim.family).toBe(1);
    const move = parseIdentityReply(fromHex('F0 7E 7F 06 02 00 21 1D 58 32 01 00 01 02 03 04 F7')!)!;
    expect(move.manufacturerName).toBe('Ableton');
    expect(move.family).toBe(0x1958);
  });

  it('rejects non-identity SysEx', () => {
    expect(parseIdentityReply([0xf0, 0x43, 0x10, 0xf7])).toBeUndefined();
    expect(parseIdentityReply(IDENTITY_REQUEST)).toBeUndefined();
    expect(isIdentityRequest(IDENTITY_REQUEST)).toBe(true);
    expect(manufacturerName([0x00, 0x99, 0x99])).toContain('unknown');
  });
});
