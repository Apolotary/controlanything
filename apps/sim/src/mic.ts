/**
 * Microphone clip for the "say line" oracle: the server asks (sense.request kind "audio-clip"), the page records
 * the laptop microphone for a few seconds at 16 kHz and returns a mono 16-bit PCM WAV, exactly what Muse Voice
 * Transcribe accepts. The browser asks for microphone permission the first time.
 */
export interface Clip {
  wav: string;
  sampleRate: number;
  durationMs: number;
  input?: string;
}

export function encodeWav16(samples: Float32Array, sampleRate: number): Uint8Array {
  const data = samples.length * 2;
  const buf = new ArrayBuffer(44 + data);
  const v = new DataView(buf);
  const ascii = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + data, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, data, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
  }
  return new Uint8Array(buf);
}

/** Linear resample to `outRate` (the capture context may refuse 16 kHz and run at 48 kHz). */
export function resample(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate) return input;
  const ratio = inRate / outRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const j = Math.floor(pos);
    const t = pos - j;
    out[i] = input[j] * (1 - t) + (input[Math.min(input.length - 1, j + 1)] ?? 0) * t;
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Record the microphone for `ms` milliseconds. Throws when the browser refuses. */
export async function recordClip(ms: number): Promise<Clip> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
  const track = stream.getAudioTracks()[0];
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const node = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  node.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  source.connect(node);
  node.connect(ctx.destination);
  const started = performance.now();
  await new Promise((r) => setTimeout(r, ms));
  node.disconnect();
  source.disconnect();
  for (const t of stream.getTracks()) t.stop();
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  const rate = 16_000;
  const pcm = resample(all, ctx.sampleRate, rate);
  await ctx.close();
  return { wav: toBase64(encodeWav16(pcm, rate)), sampleRate: rate, durationMs: Math.round(performance.now() - started), input: track?.label || 'microphone' };
}
