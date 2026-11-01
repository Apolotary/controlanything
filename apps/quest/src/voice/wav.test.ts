import { describe, expect, it } from 'vitest';
import { concatPcm, floatToPcm16, LinearResampler, pcm16ToWav } from './wav';

describe('WAV', () => {
  it('writes a 44-byte mono 16-bit header', () => {
    const wav = pcm16ToWav(new Int16Array([1, -1, 32767]), 16000);
    const v = new DataView(wav.buffer);
    const str = (o: number, n: number) => String.fromCharCode(...wav.subarray(o, o + n));
    expect(str(0, 4)).toBe('RIFF');
    expect(str(8, 4)).toBe('WAVE');
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(6);
    expect(wav.length).toBe(50);
    expect(v.getInt16(48, true)).toBe(32767);
  });

  it('clips floats to Int16', () => {
    expect(Array.from(floatToPcm16(new Float32Array([0, 1, -1, 2, -2])))).toEqual([0, 32767, -32768, 32767, -32768]);
  });

  it('concatenates chunks', () => {
    expect(Array.from(concatPcm([new Int16Array([1, 2]), new Int16Array([3])]))).toEqual([1, 2, 3]);
  });
});

describe('LinearResampler (same algorithm as the AudioWorklet)', () => {
  it('48 kHz → 16 kHz keeps one sample in three, continuous across blocks', () => {
    const r = new LinearResampler(48000, 16000);
    const ramp = (start: number, n: number) => Float32Array.from({ length: n }, (_, i) => (start + i) / 1000);
    const out = [...r.process(ramp(0, 128)), ...r.process(ramp(128, 128)), ...r.process(ramp(256, 128))];
    expect(out.length).toBeGreaterThanOrEqual(127);
    expect(out.length).toBeLessThanOrEqual(129);
    // a linear ramp stays a linear ramp with a step of 3 input samples
    for (let i = 2; i < out.length; i++) expect(out[i] - out[i - 1]).toBeCloseTo(0.003, 6);
  });

  it('16 kHz → 16 kHz is the identity (delayed by one sample)', () => {
    const r = new LinearResampler(16000, 16000);
    const a = r.process(Float32Array.from([0.1, 0.2, 0.3]));
    const b = r.process(Float32Array.from([0.4, 0.5]));
    expect([...a, ...b].map((x) => Math.round(x * 10) / 10)).toEqual([0, 0.1, 0.2, 0.3, 0.4]);
  });
});
