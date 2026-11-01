/**
 * Audio features for the oracle, computed from raw samples (pure, unit tested):
 * RMS, peak, magnitude-weighted spectral centroid (bins within 50 dB of the peak, so a room mic's noise
 * floor doesn't drag it up) and octave bands from a Welch-averaged spectrum (Hann, 2048, hop 1024),
 * plus the A-B-A-B causality check of research/05 §5.3 ("did this CC change the sound?").
 */
import type { AudioFeatures } from '@ce/protocol';

export const FFT_SIZE = 2048;
/** 10 edges → 9 octave bands, 31.5 Hz .. 16 kHz */
export const BAND_EDGES_HZ = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const CENTROID_LO = 40;
const CENTROID_HI = 16000;
/** bins more than 50 dB below the loudest bin are ignored by the centroid */
const CENTROID_GATE = 1e-5;
/** the log-spectrum range used to compare A and B states */
const SPEC_LO = 100;
const SPEC_HI = 8000;
const EPS = 1e-12;

/** In-place iterative radix-2 FFT. re/im length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

let hannCache: Float64Array | undefined;
function hann(n: number): Float64Array {
  if (hannCache?.length === n) return hannCache;
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  hannCache = w;
  return w;
}

/**
 * One-sided power spectrum averaged over Hann frames, normalised so the bins sum to the mean square
 * (a full-scale sine sums to 0.5). Windows shorter than one frame are zero-padded.
 */
export function welchPower(samples: Float32Array, n = FFT_SIZE): Float64Array {
  const w = hann(n);
  let wss = 0;
  for (let i = 0; i < n; i++) wss += w[i] * w[i];
  const out = new Float64Array(n / 2 + 1);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const hop = n / 2;
  let frames = 0;
  const starts: number[] = [];
  if (samples.length <= n) starts.push(0);
  else for (let s = 0; s + n <= samples.length; s += hop) starts.push(s);
  const padFix = samples.length < n ? n / Math.max(1, samples.length) : 1;
  for (const s of starts) {
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < n && s + i < samples.length; i++) re[i] = samples[s + i] * w[i];
    fft(re, im);
    for (let k = 0; k <= n / 2; k++) {
      const p = (re[k] * re[k] + im[k] * im[k]) / (n * wss);
      out[k] += k === 0 || k === n / 2 ? p : 2 * p;
    }
    frames++;
  }
  for (let k = 0; k < out.length; k++) out[k] = (out[k] / Math.max(1, frames)) * padFix;
  return out;
}

export interface Spectrum {
  power: Float64Array;
  binHz: number;
}

export function spectrum(samples: Float32Array, sampleRate: number, n = FFT_SIZE): Spectrum {
  return { power: welchPower(samples, n), binHz: sampleRate / n };
}

const db = (p: number) => 10 * Math.log10(p + EPS);

/** Points in the log spectrum carried by sense.result.audio.spec (protocol max 128). */
export const SPEC_POINTS = 128;

/**
 * Log-frequency spectrum, SPEC_LO..SPEC_HI in SPEC_POINTS bands (dB of mean power per band; bands
 * narrower than a bin read the interpolated bin power at their centre). Comparable across windows and
 * sample rates, and what the A-B-A-B check measures distances on.
 */
export function logSpectrum(power: Float64Array, binHz: number, points = SPEC_POINTS): Float64Array {
  const out = new Float64Array(points);
  const ratio = SPEC_HI / SPEC_LO;
  const at = (f: number) => {
    const x = f / binHz;
    const i = Math.floor(x);
    if (i + 1 >= power.length) return power[power.length - 1];
    return power[i] + (power[i + 1] - power[i]) * (x - i);
  };
  for (let b = 0; b < points; b++) {
    const f0 = SPEC_LO * ratio ** (b / points);
    const f1 = SPEC_LO * ratio ** ((b + 1) / points);
    const k0 = Math.ceil(f0 / binHz);
    const k1 = Math.floor(f1 / binHz);
    let p: number;
    if (k1 >= k0) {
      let sum = 0;
      for (let k = k0; k <= k1 && k < power.length; k++) sum += power[k];
      p = sum / (k1 - k0 + 1);
    } else p = at(Math.sqrt(f0 * f1));
    out[b] = db(p);
  }
  return out;
}

/** Features of one window. `input` is the device label, reported as-is. */
/** Features of one window, with every field filled in (the wire form makes some optional). */
export interface Features {
  rms: number;
  rmsDb: number;
  peak: number;
  centroidHz: number;
  bands: number[];
  bandEdgesHz: number[];
  windowMs: number;
  sampleRate: number;
  input?: string;
  silent: boolean;
  clipped: boolean;
  /** SPEC_POINTS-point log spectrum, dB */
  spec: Float64Array;
}

export function computeFeatures(samples: Float32Array, sampleRate: number, input?: string): Features {
  let ss = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    ss += x * x;
    const a = Math.abs(x);
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(ss / Math.max(1, samples.length));
  const { power, binHz } = spectrum(samples, sampleRate);
  const nyq = sampleRate / 2;
  // magnitude-weighted centroid over the bins within CENTROID_GATE of the loudest bin, so a room's
  // noise floor doesn't drag it upward while harmonics still move it
  const hiHz = Math.min(CENTROID_HI, nyq);
  let maxP = 0;
  for (let k = 1; k < power.length; k++) {
    const f = k * binHz;
    if (f >= CENTROID_LO && f <= hiHz && power[k] > maxP) maxP = power[k];
  }
  const gate = maxP * CENTROID_GATE;
  let num = 0;
  let den = 0;
  for (let k = 1; k < power.length; k++) {
    const f = k * binHz;
    if (f < CENTROID_LO || f > hiHz || power[k] < gate) continue;
    const m = Math.sqrt(power[k]);
    num += f * m;
    den += m;
  }
  const bands: number[] = [];
  for (let b = 0; b + 1 < BAND_EDGES_HZ.length; b++) {
    let sum = 0;
    for (let k = 1; k < power.length; k++) {
      const f = k * binHz;
      if (f >= BAND_EDGES_HZ[b] && f < BAND_EDGES_HZ[b + 1]) sum += power[k];
    }
    bands.push(round2(db(sum)));
  }
  const spec = logSpectrum(power, binHz);
  const rmsDb = round2(20 * Math.log10(rms + 1e-9));
  return {
    rms: round6(rms),
    rmsDb,
    peak: round6(peak),
    centroidHz: den > 0 ? Math.round(num / den) : 0,
    bands,
    bandEdgesHz: [...BAND_EDGES_HZ],
    windowMs: Math.round((samples.length / sampleRate) * 1000),
    sampleRate,
    ...(input ? { input } : {}),
    silent: rmsDb < -70,
    clipped: peak >= 0.999,
    spec,
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** Features as sense.result.audio carries them (the spectrum as 128 numbers, 0.1 dB). */
export function wireFeatures(f: Features): AudioFeatures {
  const { spec, ...rest } = f;
  return { ...rest, spec: Array.from(spec, (x) => Math.round(Math.max(-140, x) * 10) / 10) };
}

/** Mean absolute dB distance between two log spectra (same window length). */
export function specDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.abs(a[i] - b[i]);
  return s / n;
}

export interface StateFeatures {
  rmsDb: number;
  centroidHz: number;
  spec: ArrayLike<number>;
}

export interface CcEffect {
  pass: boolean;
  /** mean dB distance between A and B spectra */
  cross: number;
  /** mean dB distance between repeats of the same state */
  same: number;
  /** centroid shift B vs A, octaves */
  oct: number;
  /** level change B vs A, dB */
  lvl: number;
  audible: boolean;
  reason: string;
}

/**
 * research/05 §5.3: states A1 B1 A2 B2 (CC lo, hi, lo, hi). Pass when every state is audible
 * (≥ floor + 12 dB), A and B differ (cross ≥ 3 dB, 4 on a room mic), the difference repeats
 * (cross ≥ 2 × same), and it is big in some way (|Δcentroid| ≥ 0.3 oct, |Δlevel| ≥ 4 dB, or cross ≥ 6 dB).
 */
export function ccEffect(states: [StateFeatures, StateFeatures, StateFeatures, StateFeatures], floorDb: number, mic = false): CcEffect {
  const [a1, b1, a2, b2] = states;
  const cross = (specDistance(a1.spec, b1.spec) + specDistance(a2.spec, b2.spec)) / 2;
  const same = (specDistance(a1.spec, a2.spec) + specDistance(b1.spec, b2.spec)) / 2;
  const ca = (a1.centroidHz + a2.centroidHz) / 2;
  const cb = (b1.centroidHz + b2.centroidHz) / 2;
  const oct = ca > 0 && cb > 0 ? Math.log2(cb / ca) : 0;
  const lvl = (b1.rmsDb + b2.rmsDb - a1.rmsDb - a2.rmsDb) / 2;
  const audible = Math.min(...states.map((s) => s.rmsDb)) >= floorDb + 12;
  const minCross = mic ? 4 : 3;
  const big = Math.abs(oct) >= 0.3 || Math.abs(lvl) >= 4 || cross >= 6;
  const pass = audible && cross >= minCross && cross >= 2 * same && big;
  const reason = !audible
    ? `too quiet (quietest state ${Math.round(Math.min(...states.map((s) => s.rmsDb)))} dB vs floor ${Math.round(floorDb)} dB + 12)`
    : cross < minCross
      ? `no change (A/B differ by ${cross.toFixed(1)} dB < ${minCross})`
      : cross < 2 * same
        ? `not repeatable (A/B ${cross.toFixed(1)} dB vs repeat noise ${same.toFixed(1)} dB)`
        : !big
          ? `change too small (${oct.toFixed(2)} oct, ${lvl.toFixed(1)} dB)`
          : `changed: ${oct >= 0 ? '+' : ''}${oct.toFixed(2)} oct, ${lvl >= 0 ? '+' : ''}${lvl.toFixed(1)} dB, spectra ${cross.toFixed(1)} dB apart`;
  return { pass, cross: round2(cross), same: round2(same), oct: round2(oct), lvl: round2(lvl), audible, reason };
}

/** Synthesis helpers for tests and the simulated listener. */
export function sine(freq: number, amp: number, sampleRate: number, ms: number, phase = 0): Float32Array {
  const n = Math.round((sampleRate * ms) / 1000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(phase + (2 * Math.PI * freq * i) / sampleRate);
  return out;
}
