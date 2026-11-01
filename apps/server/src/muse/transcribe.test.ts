import { describe, expect, it } from 'vitest';
import { resolveMuseConfig } from './config';
import {
  buildTranscribeMultipart,
  buildTranscribeRequest,
  createTranscriber,
  encodeWav,
  FIXTURE_TRANSCRIPTS,
  inspectWav,
  parseTranscribeResponse,
  TranscribeInputError,
  transcribeLive,
  TranscribeUpstreamError,
} from './transcribe';

/** `ms` of a quiet 220 Hz tone, mono int16 at `rate`. */
function wav(ms = 200, rate = 24_000): Buffer {
  const n = Math.round((rate * ms) / 1000);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / rate);
  return Buffer.from(encodeWav(s, rate));
}

function patched(at: number, bytes: 2 | 4, value: number): Buffer {
  const b = Buffer.from(wav());
  if (bytes === 2) b.writeUInt16LE(value, at);
  else b.writeUInt32LE(value, at);
  return b;
}

/** Minimal multipart/form-data parser for the assertions below. */
function parseMultipart(body: Buffer, contentType: string) {
  const boundary = /boundary=([^;]+)/.exec(contentType)![1];
  const delim = Buffer.from(`--${boundary}`);
  const parts: { headers: Record<string, string>; body: Buffer }[] = [];
  let pos = body.indexOf(delim);
  while (pos >= 0) {
    const after = pos + delim.length;
    if (body.subarray(after, after + 2).toString() === '--') break;
    const headEnd = body.indexOf('\r\n\r\n', after);
    const next = body.indexOf(delim, headEnd);
    const headers: Record<string, string> = {};
    for (const line of body.subarray(after + 2, headEnd).toString('utf8').split('\r\n')) {
      const i = line.indexOf(':');
      headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    parts.push({ headers, body: body.subarray(headEnd + 4, next - 2) });
    pos = next;
  }
  return parts;
}

describe('inspectWav', () => {
  it('accepts mono 16-bit PCM at 16 and 24 kHz', () => {
    expect(inspectWav(wav(500, 24_000))).toMatchObject({ format: 1, channels: 1, sampleRate: 24_000, bitsPerSample: 16, durationMs: 500 });
    expect(inspectWav(wav(250, 16_000)).durationMs).toBe(250);
  });

  it.each([
    ['not RIFF', Buffer.from('hello world, not audio'), /WAV file/],
    ['stereo', patched(22, 2, 2), /mono/],
    ['8-bit', patched(34, 2, 8), /16-bit/],
    ['44.1 kHz', patched(24, 4, 44_100), /16 kHz or 24 kHz/],
    ['float format', patched(20, 2, 3), /format 1/],
  ])('rejects %s', (_name, buf, msg) => {
    expect(() => inspectWav(buf)).toThrow(TranscribeInputError);
    expect(() => inspectWav(buf)).toThrow(msg);
  });

  it('rejects a recording with no samples', () => {
    expect(() => inspectWav(wav(0))).toThrow(/no audio/);
  });
});

describe('Meta request', () => {
  it('builds exactly two parts: request JSON (no filename) then audio WAV', () => {
    const audio = wav();
    const { body, contentType } = buildTranscribeMultipart(buildTranscribeRequest(), audio, 'BOUNDARY');
    expect(contentType).toBe('multipart/form-data; boundary=BOUNDARY');
    const parts = parseMultipart(body, contentType);
    expect(parts).toHaveLength(2);
    expect(parts[0].headers['content-disposition']).toBe('form-data; name="request"');
    expect(parts[0].headers['content-type']).toBe('application/json');
    expect(JSON.parse(parts[0].body.toString())).toMatchObject({ model: 'muse-voice-transcribe-1.0', audioEncoding: 'WAV', mode: 'PUSH_TO_TALK', languageBias: ['English'] });
    expect(parts[1].headers['content-disposition']).toBe('form-data; name="audio"; filename="speech.wav"');
    expect(parts[1].headers['content-type']).toBe('audio/wav');
    expect(Buffer.compare(parts[1].body, audio)).toBe(0);
  });

  it('parses transcript, falls back to text, rejects junk', () => {
    expect(parseTranscribeResponse('{"transcript":"  make it   brighter ","turns":[]}')).toBe('make it brighter');
    expect(parseTranscribeResponse('{"text":"hi"}')).toBe('hi');
    expect(() => parseTranscribeResponse('<html>')).toThrow(TranscribeUpstreamError);
    expect(() => parseTranscribeResponse('{}')).toThrow(/no text/);
  });

  it('posts to /asr/transcribe with Bearer auth and reads the transcript', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ transcript: 'what is this synth', audioDurationMs: 200 }), { status: 200 });
    }) as unknown as typeof fetch;
    const text = await transcribeLive(wav(), { apiKey: 'sk-t', fetchImpl });
    expect(text).toBe('what is this synth');
    expect(seen!.url).toBe('https://api.meta.ai/v1/asr/transcribe');
    const h = seen!.init.headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer sk-t');
    expect(h['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);
  });

  it('maps HTTP errors and timeouts to TranscribeUpstreamError', async () => {
    const bad = (async () => new Response('{"error":"Both a \'request\' and an \'audio\' part are required"}', { status: 400 })) as unknown as typeof fetch;
    await expect(transcribeLive(wav(), { apiKey: 'k', fetchImpl: bad })).rejects.toThrow(/HTTP 400.*request/);
    const slow = ((_u: string, init: RequestInit) =>
      new Promise((_r, rej) => init.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch;
    await expect(transcribeLive(wav(), { apiKey: 'k', fetchImpl: slow, timeoutMs: 20 })).rejects.toThrow(/timed out/);
  });
});

describe('createTranscriber', () => {
  it('fixture mode checks the WAV and cycles FIXTURE transcripts without network', async () => {
    const t = createTranscriber(resolveMuseConfig({ FIXTURE_DELAY_MS: '0' }));
    expect(t.mode).toBe('fixture');
    const a = await t.transcribe(wav());
    const b = await t.transcribe(wav());
    expect(a).toMatchObject({ text: FIXTURE_TRANSCRIPTS[0], source: 'fixture', model: 'fixture', durationMs: 200 });
    expect(b.text).toBe(FIXTURE_TRANSCRIPTS[1]);
    expect(a.text).toMatch(/FIXTURE/);
    await expect(t.transcribe(Buffer.from('nope'))).rejects.toThrow(TranscribeInputError);
  });

  it('live mode uses the configured model and base URL', async () => {
    let url = '';
    let model = '';
    const fetchImpl = (async (u: string, init: RequestInit) => {
      url = u;
      model = /"model":"([^"]+)"/.exec(Buffer.from(init.body as ArrayBuffer).toString('latin1'))![1];
      return new Response('{"transcript":"ok"}', { status: 200 });
    }) as unknown as typeof fetch;
    const t = createTranscriber(resolveMuseConfig({ MODEL_API_KEY: 'k', MUSE_API_BASE: 'https://x.test/v1', MUSE_TRANSCRIBE_MODEL: 'muse-voice-transcribe-2.0' }), { fetchImpl });
    expect(await t.transcribe(wav())).toMatchObject({ text: 'ok', source: 'live', model: 'muse-voice-transcribe-2.0' });
    expect(url).toBe('https://x.test/v1/asr/transcribe');
    expect(model).toBe('muse-voice-transcribe-2.0');
  });
});
