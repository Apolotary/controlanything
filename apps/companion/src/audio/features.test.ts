import { describe, expect, it } from 'vitest';
import { BAND_EDGES_HZ, ccEffect, computeFeatures, fft, sine, specDistance, welchPower, wireFeatures } from './features';

const SR = 48000;

function noise(amp: number, ms: number, seed = 1): Float32Array {
  const n = Math.round((SR * ms) / 1000);
  const out = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = amp * ((s / 0x7fffffff) * 2 - 1);
  }
  return out;
}

/** A synth-like tone: harmonics of f0 falling off by `slopeDb` per octave (a low-pass "filter"). */
function tone(f0: number, slopeDb: number, amp: number, ms: number): Float32Array {
  const n = Math.round((SR * ms) / 1000);
  const out = new Float32Array(n);
  for (let h = 1; f0 * h < 12000; h++) {
    const g = amp * 10 ** ((-slopeDb * Math.log2(h)) / 20);
    for (let i = 0; i < n; i++) out[i] += (g * Math.sin((2 * Math.PI * f0 * h * i) / SR)) / h;
  }
  return out;
}

function mix(...xs: Float32Array[]): Float32Array {
  const out = new Float32Array(Math.min(...xs.map((x) => x.length)));
  for (const x of xs) for (let i = 0; i < out.length; i++) out[i] += x[i];
  return out;
}

describe('fft', () => {
  it('puts a bin-centred sine in its bin', () => {
    const n = 64;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 5 * i) / n);
    fft(re, im);
    const mag = Array.from(re, (r, k) => Math.hypot(r, im[k]));
    expect(mag[5]).toBeCloseTo(n / 2, 6);
    expect(mag[59]).toBeCloseTo(n / 2, 6);
    expect(mag[4]).toBeLessThan(1e-9);
  });
});

describe('computeFeatures', () => {
  it('measures RMS, centroid and the band of a 1 kHz sine', () => {
    const f = computeFeatures(sine(1000, 0.5, SR, 500), SR, 'test');
    expect(f.rms).toBeCloseTo(0.5 / Math.SQRT2, 3);
    expect(f.rmsDb).toBeCloseTo(-9.03, 1);
    expect(f.peak).toBeCloseTo(0.5, 2);
    expect(Math.abs(f.centroidHz - 1000)).toBeLessThan(60);
    expect(f.bandEdgesHz).toEqual(BAND_EDGES_HZ);
    const loudest = f.bands.indexOf(Math.max(...f.bands));
    expect(BAND_EDGES_HZ[loudest]).toBe(1000);
    expect(f.windowMs).toBe(500);
    expect(f.silent).toBe(false);
    expect(f.clipped).toBe(false);
    expect(f.input).toBe('test');
  });

  it('power bins sum to the mean square (Parseval)', () => {
    const x = sine(440, 0.8, SR, 300);
    const p = welchPower(x);
    const sum = p.reduce((s, v) => s + v, 0);
    expect(sum).toBeCloseTo((0.8 * 0.8) / 2, 2);
  });

  it('flags silence and clipping, and drops the internal spectrum on the wire', () => {
    const quiet = computeFeatures(new Float32Array(24000), SR);
    expect(quiet.silent).toBe(true);
    const hot = computeFeatures(sine(200, 1, SR, 200), SR);
    expect(hot.clipped).toBe(true);
    const wire = wireFeatures(hot);
    expect(wire.spec).toHaveLength(128);
    expect(Number.isInteger((wire.spec![10] * 10) | 0)).toBe(true);
  });

  it('a brighter sound has a higher centroid', () => {
    const dark = computeFeatures(mix(sine(220, 0.3, SR, 500), noise(0.01, 500)), SR);
    const bright = computeFeatures(mix(sine(220, 0.3, SR, 500), sine(3520, 0.3, SR, 500), noise(0.01, 500)), SR);
    expect(dark.centroidHz).toBeLessThan(300);
    expect(bright.centroidHz).toBeGreaterThan(dark.centroidHz * 2);
    const closed = computeFeatures(tone(110, 24, 0.3, 500), SR);
    const open = computeFeatures(tone(110, 3, 0.3, 500), SR);
    expect(open.centroidHz).toBeGreaterThan(closed.centroidHz * 1.5);
    expect(specDistance(closed.spec, open.spec)).toBeGreaterThan(3);
  });
});

describe('ccEffect (A-B-A-B)', () => {
  const st = (x: Float32Array) => {
    const f = computeFeatures(x, SR);
    return { rmsDb: f.rmsDb, centroidHz: f.centroidHz, spec: f.spec };
  };
  const floor = computeFeatures(noise(0.0005, 300, 9), SR).rmsDb;

  it('passes when the CC really changes the timbre, repeatably', () => {
    // CC lo = filter closed (24 dB/oct), CC hi = open (3 dB/oct); fresh noise in every state
    const A = (seed: number) => st(mix(tone(110, 24, 0.3, 600), noise(0.002, 600, seed)));
    const B = (seed: number) => st(mix(tone(110, 3, 0.3, 600), noise(0.002, 600, seed)));
    const r = ccEffect([A(3), B(4), A(5), B(6)], floor);
    expect(r.audible).toBe(true);
    expect(r.pass).toBe(true);
    expect(r.oct).toBeGreaterThan(0.3);
    expect(r.reason).toMatch(/^changed/);
  });

  it('fails the negative control (an unassigned CC changes nothing)', () => {
    const A = (seed: number) => st(mix(tone(110, 12, 0.3, 600), noise(0.002, 600, seed)));
    const r = ccEffect([A(5), A(6), A(7), A(8)], floor);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/no change|too small|not repeatable/);
  });

  it('fails when nothing is audible', () => {
    const q = () => st(noise(0.0005, 600, 11));
    expect(ccEffect([q(), q(), q(), q()], floor).audible).toBe(false);
  });
});
