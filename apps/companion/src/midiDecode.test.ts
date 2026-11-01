import { describe, expect, it } from 'vitest';
import { describeMidi, isRealtimeNoise, noteName, noteOff, noteOn, toHex } from './midiDecode';

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
  });

  it('builds note bytes and spots clock noise', () => {
    expect(noteOn(1, 60, 100)).toEqual([0x90, 60, 100]);
    expect(noteOff(10, 36)).toEqual([0x89, 36, 0]);
    expect(isRealtimeNoise([0xf8])).toBe(true);
    expect(isRealtimeNoise([0x90, 1, 1])).toBe(false);
    expect(toHex([0x90, 0x3c, 0x64])).toBe('90 3C 64');
  });
});
