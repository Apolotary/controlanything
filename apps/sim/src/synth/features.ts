/**
 * Audio features for the server's audio oracle, read straight from the virtual synth's analyser (no mic).
 * Same recipe as the companion's mic path (research/05 §5.3): AnalyserNode fftSize 4096, smoothing 0, one
 * frame every 20 ms; per window: median RMS / centroid, mean band powers and a mean log spectrum
 * (100 Hz-8 kHz) for A-B-A-B comparisons. A 10 s ring buffer gives "before" windows for free (offsetMs < 0).
 */
import type { AudioFeatures } from '@ce/protocol';

export const BAND_EDGES_HZ = [44, 88, 177, 354, 707, 1414, 2828, 5657, 11314];
export const SPEC_BINS = 64;
const FLOOR_DB = -120;

export interface FeatureFrame {
  t: number;
  rms: number;
  peak: number;
  centroidHz: number;
  /** band powers, dB */
  bands: number[];
  /** log spectrum 100 Hz-8 kHz, dB */
  spec: number[];
}

/** Features of one analyser frame (pure; exported for tests). */
export function frameFeatures(td: Float32Array, freqDb: Float32Array, sampleRate: number, t = 0): FeatureFrame {
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < td.length; i++) {
    const x = td[i]!;
    sum += x * x;
    const a = x < 0 ? -x : x;
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sum / Math.max(1, td.length));
  const binHz = sampleRate / 2 / freqDb.length;
  let num = 0;
  let den = 0;
  const bandPow = new Array(BAND_EDGES_HZ.length - 1).fill(0);
  const bandN = new Array(BAND_EDGES_HZ.length - 1).fill(0);
  const pow = new Float32Array(freqDb.length);
  for (let i = 1; i < freqDb.length; i++) {
    const db = Math.max(FLOOR_DB, freqDb[i]!);
    const p = 10 ** (db / 10);
    pow[i] = p;
    const f = i * binHz;
    if (f >= 40) {
      const m = Math.sqrt(p);
      num += m * f;
      den += m;
    }
    for (let b = 0; b < bandPow.length; b++) {
      if (f >= BAND_EDGES_HZ[b]! && f < BAND_EDGES_HZ[b + 1]!) {
        bandPow[b] += p;
        bandN[b]++;
        break;
      }
    }
  }
  const bands = bandPow.map((p, b) => (bandN[b] ? Math.max(FLOOR_DB, 10 * Math.log10(p / bandN[b] + 1e-30)) : FLOOR_DB));
  const spec: number[] = [];
  const lo = Math.log(100);
  const hi = Math.log(8000);
  for (let k = 0; k < SPEC_BINS; k++) {
    const f0 = Math.exp(lo + ((hi - lo) * k) / SPEC_BINS);
    const f1 = Math.exp(lo + ((hi - lo) * (k + 1)) / SPEC_BINS);
    const i0 = Math.max(1, Math.floor(f0 / binHz));
    const i1 = Math.max(i0 + 1, Math.ceil(f1 / binHz));
    let p = 0;
    for (let i = i0; i < i1 && i < pow.length; i++) p += pow[i]!;
    spec.push(Math.max(FLOOR_DB, 10 * Math.log10(p / (i1 - i0) + 1e-30)));
  }
  return { t, rms, peak, centroidHz: den > 0 ? num / den : 0, bands, spec };
}

const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1]!;
};
const meanCols = (rows: number[][]) => rows[0]!.map((_, i) => rows.reduce((s, r) => s + r[i]!, 0) / rows.length);

/** Aggregate frames into the protocol's AudioFeatures (pure; exported for tests). */
export function aggregate(frames: FeatureFrame[], sampleRate: number, windowMs: number, input = 'CE Sim Synth'): AudioFeatures {
  if (!frames.length) {
    return { rms: 0, rmsDb: FLOOR_DB, peak: 0, centroidHz: 0, bands: BAND_EDGES_HZ.slice(1).map(() => FLOOR_DB), bandEdgesHz: BAND_EDGES_HZ, windowMs, sampleRate, input, silent: true, clipped: false };
  }
  const rms = median(frames.map((f) => f.rms));
  const rmsDb = rms > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(rms)) : FLOOR_DB;
  const peak = Math.max(...frames.map((f) => f.peak));
  const round = (x: number) => Math.round(x * 100) / 100;
  return {
    rms: round(rms * 1000) / 1000,
    rmsDb: round(rmsDb),
    peak: round(peak * 1000) / 1000,
    centroidHz: Math.round(median(frames.map((f) => f.centroidHz))),
    bands: meanCols(frames.map((f) => f.bands)).map(round),
    bandEdgesHz: BAND_EDGES_HZ,
    spec: meanCols(frames.map((f) => f.spec)).map(round),
    windowMs,
    sampleRate,
    input,
    silent: rmsDb < -60,
    clipped: peak >= 0.999,
  };
}

/** Samples the analyser on every audio-clock tick (~20 ms) into a 10 s ring buffer while audio runs. */
export class FeatureMeter {
  private frames: FeatureFrame[] = [];
  private unsubscribe?: () => void;
  private td?: Float32Array<ArrayBuffer>;
  private fd?: Float32Array<ArrayBuffer>;
  private lastSample = 0;

  constructor(
    private readonly getAnalyser: () => AnalyserNode | undefined,
    private readonly isRunning: () => boolean,
    private readonly subscribeTick: (fn: () => void) => () => void,
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.subscribeTick(() => this.sample());
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** latest frame, for meters */
  get latest(): FeatureFrame | undefined {
    return this.frames.at(-1);
  }

  private sample(): void {
    const an = this.getAnalyser();
    if (!an || !this.isRunning()) return;
    const t = Date.now();
    if (t - this.lastSample < 15) return;
    this.lastSample = t;
    if (!this.td || this.td.length !== an.fftSize) this.td = new Float32Array(an.fftSize);
    if (!this.fd || this.fd.length !== an.frequencyBinCount) this.fd = new Float32Array(an.frequencyBinCount);
    an.getFloatTimeDomainData(this.td);
    an.getFloatFrequencyData(this.fd);
    const now = Date.now();
    this.frames.push(frameFeatures(this.td, this.fd, an.context.sampleRate, now));
    while (this.frames.length && now - this.frames[0]!.t > 10_000) this.frames.shift();
  }

  /**
   * Features of the window [now + offsetMs, now + offsetMs + durationMs]. A window that ends in the future is
   * waited for; one in the past comes from the ring buffer.
   */
  async measure(durationMs = 600, offsetMs = 0): Promise<AudioFeatures> {
    const start = Date.now() + offsetMs;
    const end = start + durationMs;
    // wait on the audio clock's ticks, not on a (possibly throttled) timer
    if (end > Date.now()) {
      await new Promise<void>((resolve) => {
        const off = this.subscribeTick(() => {
          if (Date.now() >= end + 25) {
            off();
            resolve();
          }
        });
        setTimeout(() => {
          off();
          resolve();
        }, end - Date.now() + 2000); // safety net if audio stops
      });
    }
    const an = this.getAnalyser();
    const frames = this.frames.filter((f) => f.t >= start && f.t <= end);
    return aggregate(frames, an?.context.sampleRate ?? 48_000, durationMs);
  }
}
