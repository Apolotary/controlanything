/**
 * Speech-to-text with Meta's Muse Voice Transcribe, plus a FIXTURE transcriber when no key is set.
 * Ported and adapted from FAMILIAR (same author, built earlier in this hackathon): server/transcribe.ts.
 *
 * Request (docs: dev.meta.ai/docs/api-reference/voice/transcribe):
 *   POST {MUSE_API_BASE|https://api.meta.ai/v1}/asr/transcribe
 *   Authorization: Bearer $MODEL_API_KEY
 *   multipart/form-data with EXACTLY two parts, in this order:
 *     request  Content-Type: application/json (no filename)
 *              {"model":"muse-voice-transcribe-1.0","audioEncoding":"WAV","mode":"PUSH_TO_TALK","keywords":[…],"languageBias":["English"]}
 *     audio    filename "speech.wav", Content-Type: audio/wav; RIFF/WAVE, mono, 16-bit PCM, 16 or 24 kHz
 * Response: {sessionId, transcript, audioDurationMs, turns}; we read `transcript` (fallback `text`).
 * Limits: body <= 32 MB, audio <= 10 min. Browser webm/opus or Safari mp4 must be converted to WAV first.
 */
import { randomBytes } from 'node:crypto';
import { CallLog } from './callLog';
import { cancellableDelay, forwardCancellation, RequestCancelledError, throwIfCancelled } from './cancellation';
import { DEFAULT_MUSE_BASE_URL, DEFAULT_TRANSCRIBE_MODEL, type ModelMode, type MuseConfig } from './config';

export const TRANSCRIBE_TIMEOUT_MS = 30_000;
export const FIXTURE_TRANSCRIBE_MODEL = 'fixture';
export const MAX_AUDIO_MS = 10 * 60 * 1000;
export const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const ALLOWED_RATES = [16_000, 24_000];

/** Vocabulary bias: device names and control words people say to ControlEverything. */
export const TRANSCRIBE_KEYWORDS: readonly string[] = [
  'synth', 'synthesizer', 'MIDI', 'knob', 'fader', 'cutoff', 'resonance', 'filter', 'envelope', 'tempo',
  'Digitakt', 'Elektron', 'OP-1', 'Teenage Engineering', 'K.O.', 'EP-133', 'Ableton', 'Move', 'Kastle', 'Bastl',
  'Cardputer', 'M5Stack', 'DevTerm', 'Quest', 'infrared', 'remote', 'lamp', 'brightness', 'dimmer',
];

/** Canned transcripts for fixture mode, returned in turn so a spoken beat can be rehearsed offline. */
export const FIXTURE_TRANSCRIPTS: readonly string[] = [
  '[FIXTURE] what is this device?',
  '[FIXTURE] make me a controller for this synth',
  '[FIXTURE] dim the lamp a little',
];

export interface TranscribeResult {
  text: string;
  source: ModelMode;
  model: string;
  durationMs: number;
}

/** The upload is not something Meta accepts; a route answers 400 with `message`. */
export class TranscribeInputError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'TranscribeInputError';
  }
}

/** Meta failed, timed out, or answered something unusable; a route answers 502 with `message`. */
export class TranscribeUpstreamError extends Error {
  readonly status = 502;
  constructor(message: string) {
    super(message);
    this.name = 'TranscribeUpstreamError';
  }
}

// --- WAV header check -----------------------------------------------------------------------

export interface WavInfo {
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataBytes: number;
  durationMs: number;
}

/**
 * Walk the RIFF chunks and check the format Meta accepts: PCM (format 1), mono, 16-bit, 16 or 24 kHz,
 * some audio, at most 10 minutes. Throws TranscribeInputError with a plain sentence.
 */
export function inspectWav(buf: Uint8Array): WavInfo {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < 12 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    throw new TranscribeInputError('The recording must be a WAV file (RIFF/WAVE); this upload is something else.');
  }
  let fmt: Omit<WavInfo, 'dataBytes' | 'durationMs'> | null = null;
  let dataBytes = -1;
  let off = 12;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > b.length) throw new TranscribeInputError('The WAV file has a broken format header.');
      fmt = {
        format: b.readUInt16LE(body),
        channels: b.readUInt16LE(body + 2),
        sampleRate: b.readUInt32LE(body + 4),
        bitsPerSample: b.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      // streaming writers leave the size at 0 or 0xFFFFFFFF; trust the bytes actually present
      const present = b.length - body;
      dataBytes = size === 0 || size > present ? present : size;
      break;
    }
    off = body + size + (size % 2); // chunks are padded to an even length
  }
  if (!fmt) throw new TranscribeInputError('The WAV file has no format header.');
  if (fmt.format !== 1) throw new TranscribeInputError(`The recording must be plain PCM WAV (format 1); this one uses format ${fmt.format}.`);
  if (fmt.channels !== 1) throw new TranscribeInputError(`The recording must be mono; this one has ${fmt.channels} channels.`);
  if (fmt.bitsPerSample !== 16) throw new TranscribeInputError(`The recording must be 16-bit; this one is ${fmt.bitsPerSample}-bit.`);
  if (!ALLOWED_RATES.includes(fmt.sampleRate)) {
    throw new TranscribeInputError(`The recording must be 16 kHz or 24 kHz; this one is ${fmt.sampleRate} Hz.`);
  }
  if (dataBytes <= 0) throw new TranscribeInputError('The recording has no audio in it.');
  const durationMs = Math.round((dataBytes / (fmt.sampleRate * 2)) * 1000);
  if (durationMs > MAX_AUDIO_MS) throw new TranscribeInputError('The recording is longer than 10 minutes, the most Muse Voice Transcribe accepts.');
  return { ...fmt, dataBytes, durationMs };
}

/** Mono 16-bit PCM WAV from float samples in [-1, 1] (for tests and server-side tools). */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const data = samples.length * 2;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + data, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(data, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    b.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
  }
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

// --- request to Meta ------------------------------------------------------------------------

export interface TranscribeRequestJson {
  model: string;
  audioEncoding: 'WAV';
  mode: 'PUSH_TO_TALK';
  keywords: string[];
  languageBias: string[];
}

export function buildTranscribeRequest(model: string = DEFAULT_TRANSCRIBE_MODEL, keywords: readonly string[] = TRANSCRIBE_KEYWORDS): TranscribeRequestJson {
  return { model, audioEncoding: 'WAV', mode: 'PUSH_TO_TALK', keywords: [...keywords], languageBias: ['English'] };
}

/**
 * The two-part multipart body, written by hand so the bytes match curl's -F exactly
 * (a FormData Blob part would carry filename="blob" on the JSON part).
 */
export function buildTranscribeMultipart(
  request: TranscribeRequestJson,
  wav: Uint8Array,
  boundary = `----controleverything${randomBytes(12).toString('hex')}`,
): { body: Buffer; contentType: string } {
  const head = (name: string, type: string, filename?: string) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename ? `; filename="${filename}"` : ''}\r\nContent-Type: ${type}\r\n\r\n`;
  const body = Buffer.concat([
    Buffer.from(head('request', 'application/json') + JSON.stringify(request) + '\r\n', 'utf8'),
    Buffer.from(head('audio', 'audio/wav', 'speech.wav'), 'utf8'),
    Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength),
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

function snippet(s: string, n = 300): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, n);
}

/** Read the transcript out of Meta's JSON answer. */
export function parseTranscribeResponse(raw: string): string {
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new TranscribeUpstreamError(`Meta transcription returned non-JSON: ${snippet(raw, 200)}`);
  }
  const out = json?.transcript ?? json?.text ?? json?.results?.[0]?.text;
  if (typeof out !== 'string') throw new TranscribeUpstreamError('Meta transcription response had no text');
  return out.replace(/\s+/g, ' ').trim();
}

export interface LiveTranscribeOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/** Live call. `wav` must already pass inspectWav. */
export async function transcribeLive(wav: Uint8Array, o: LiveTranscribeOptions): Promise<string> {
  throwIfCancelled(o.signal);
  if (!o.apiKey) throw new TranscribeUpstreamError('MODEL_API_KEY is not set');
  const fetchImpl = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? TRANSCRIBE_TIMEOUT_MS;
  const { body, contentType } = buildTranscribeMultipart(buildTranscribeRequest(o.model || DEFAULT_TRANSCRIBE_MODEL), wav);
  const controller = new AbortController();
  const unlink = forwardCancellation(o.signal, controller);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const base = (o.baseUrl || DEFAULT_MUSE_BASE_URL).replace(/\/+$/, '');
    const res = await fetchImpl(`${base}/asr/transcribe`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${o.apiKey}`, 'Content-Type': contentType, Accept: 'application/json' },
      body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new TranscribeUpstreamError(`Meta transcription HTTP ${res.status}: ${snippet(text)}`);
    return parseTranscribeResponse(text);
  } catch (e) {
    if (o.signal?.aborted) throw new RequestCancelledError();
    if (controller.signal.aborted) throw new TranscribeUpstreamError(`Transcription timed out after ${Math.round(timeoutMs / 1000)}s`);
    if (e instanceof TranscribeUpstreamError) throw e;
    throw new TranscribeUpstreamError(`Could not reach Meta transcription: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
    unlink();
  }
}

// --- the transcriber routes use -------------------------------------------------------------

export interface Transcriber {
  readonly mode: ModelMode;
  readonly model: string;
  /** Checks the WAV, then transcribes (live) or returns the next FIXTURE transcript. */
  transcribe(wav: Uint8Array, signal?: AbortSignal): Promise<TranscribeResult>;
}

export function createTranscriber(cfg: MuseConfig, opts: { fetchImpl?: typeof fetch; timeoutMs?: number; callLog?: CallLog } = {}): Transcriber {
  const calls = opts.callLog ?? new CallLog(() => {});
  if (cfg.mode === 'live') {
    const model = cfg.transcribeModel;
    return {
      mode: 'live',
      model,
      async transcribe(wav, signal) {
        throwIfCancelled(signal);
        const { durationMs } = inspectWav(wav);
        const started = Date.now();
        try {
          const text = await transcribeLive(wav, { apiKey: cfg.apiKey, model, baseUrl: cfg.baseUrl, timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl, signal });
          calls.add({ at: started, label: 'transcribe', model, source: 'live', ok: true, latencyMs: Date.now() - started, audioMs: durationMs });
          return { text, source: 'live', model, durationMs };
        } catch (e) {
          calls.add({ at: started, label: 'transcribe', model, source: 'live', ok: false, latencyMs: Date.now() - started, audioMs: durationMs, error: (e as Error).message });
          throw e;
        }
      },
    };
  }
  let next = 0;
  return {
    mode: 'fixture',
    model: FIXTURE_TRANSCRIBE_MODEL,
    async transcribe(wav, signal) {
      throwIfCancelled(signal);
      const { durationMs } = inspectWav(wav);
      const started = Date.now();
      if (cfg.fixtureDelayMs > 0) await cancellableDelay(cfg.fixtureDelayMs, signal);
      const text = FIXTURE_TRANSCRIPTS[next % FIXTURE_TRANSCRIPTS.length];
      next += 1;
      calls.add({ at: started, label: 'transcribe', model: FIXTURE_TRANSCRIBE_MODEL, source: 'fixture', ok: true, latencyMs: Date.now() - started, audioMs: durationMs });
      return { text, source: 'fixture', model: FIXTURE_TRANSCRIBE_MODEL, durationMs };
    },
  };
}
