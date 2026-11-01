/** Mono 16-bit PCM WAV (the only format Muse Voice Transcribe accepts: 16 or 24 kHz). */
export function pcm16ToWav(samples: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true); // PCM chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  str(36, 'data');
  v.setUint32(40, dataBytes, true);
  new Int16Array(buf, 44, samples.length).set(samples);
  return new Uint8Array(buf);
}

/** Float32 [-1, 1] → Int16 with clipping (same mapping as the worklet). */
export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** Concatenate Int16 chunks. */
export function concatPcm(chunks: Int16Array[]): Int16Array {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Int16Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/**
 * Linear-interpolation resampler with state across blocks (the same algorithm runs inside the AudioWorklet;
 * this copy is what the unit tests exercise). Feed blocks of any size; returns the output samples so far.
 */
export class LinearResampler {
  private pos = -1;
  private prev = 0;
  readonly ratio: number;
  constructor(inRate: number, outRate: number) {
    this.ratio = inRate / outRate;
  }
  process(input: Float32Array): Float32Array {
    const out: number[] = [];
    const n = input.length;
    let t = this.pos;
    while (t < n - 1) {
      const i = Math.floor(t);
      const f = t - i;
      const a = i < 0 ? this.prev : input[i];
      const b = input[i + 1];
      out.push(a + (b - a) * f);
      t += this.ratio;
    }
    this.pos = t - n;
    if (n) this.prev = input[n - 1];
    return Float32Array.from(out);
  }
}
