import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PayloadSchemas } from '@ce/protocol';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createMuseChat,
  FIXTURE_LABEL,
  FixtureMuse,
  imagePart,
  ModelCallError,
  ModelOutputError,
  MuseClient,
  parseModelJson,
  splitThink,
  userMessage,
} from './adapter';
import { resolveMuseConfig } from './config';
import { DEFAULT_FIXTURES } from './fixtures';
import { fileRecorder, loadRecorded, type RecordedCall } from './recorded';

type Call = { url: string; init: RequestInit; body: any };
function mockFetch(responses: { status: number; body: unknown }[]) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const completion = (content: unknown, extra: Record<string, unknown> = {}) => ({
  model: 'muse-spark-1.3',
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1500, completion_tokens: 300, total_tokens: 1800, completion_tokens_details: { reasoning_tokens: 120 } },
  ...extra,
});

const quiet = () => {};
const Card = PayloadSchemas['device.card'];
const card = { cardId: 'c1', name: 'Digitakt II', maker: 'Elektron', model: 'DT2', category: 'drum-machine', confidence: 0.9, protocols: ['midi'], evidence: ['logo'] };

describe('MuseClient request shape', () => {
  it('posts OpenAI-compatible chat/completions with an image part, no temperature, Bearer auth', async () => {
    const f = mockFetch([{ status: 200, body: completion('hello') }]);
    const client = new MuseClient({ apiKey: 'sk-test', fetchImpl: f.impl, log: quiet });
    const out = await client.chat([{ role: 'system', content: 'SYS' }, userMessage('what is this?', ['/9j/AAAA'], 'low')]);
    expect(out).toMatchObject({ text: 'hello', model: 'muse-spark-1.3', source: 'live', format: 'text', attempts: 1, finishReason: 'stop' });
    expect(f.calls[0].url).toBe('https://api.meta.ai/v1/chat/completions');
    const headers = f.calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');
    expect(headers['Content-Type']).toBe('application/json');
    expect(f.calls[0].body).toEqual({
      model: 'muse-spark-1.3',
      messages: [
        { role: 'system', content: 'SYS' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/AAAA', detail: 'low' } },
          ],
        },
      ],
    });
  });

  it('sends reasoning_effort, max_completion_tokens and a custom base/model only when set', async () => {
    const f = mockFetch([{ status: 200, body: completion('ok') }]);
    const client = new MuseClient({ apiKey: 'k', model: 'muse-spark-1.2', baseUrl: 'https://example.test/v1/', reasoningEffort: 'low', fetchImpl: f.impl, log: quiet });
    await client.chat([userMessage('hi')], { maxTokens: 900, temperature: 0.7 });
    expect(f.calls[0].url).toBe('https://example.test/v1/chat/completions');
    expect(f.calls[0].body).toMatchObject({ model: 'muse-spark-1.2', reasoning_effort: 'low', max_completion_tokens: 900, temperature: 0.7 });
    await client.chat([userMessage('hi')], { reasoningEffort: 'xhigh' });
    expect(f.calls[1].body.reasoning_effort).toBe('xhigh');
    expect(f.calls[1].body.temperature).toBeUndefined();
  });

  it('keeps data URLs and http URLs as given', () => {
    expect(imagePart('data:image/png;base64,AAA').image_url.url).toBe('data:image/png;base64,AAA');
    expect(imagePart('https://x.test/a.jpg').image_url.url).toBe('https://x.test/a.jpg');
  });

  it('refuses images outside user messages and more than 50 images', async () => {
    const client = new MuseClient({ apiKey: 'k', fetchImpl: mockFetch([]).impl, log: quiet });
    await expect(client.chat([{ role: 'system', content: [imagePart('AAA')] }])).rejects.toThrow(/user message/);
    await expect(client.chat([userMessage('x', Array.from({ length: 51 }, () => 'AAA'))])).rejects.toThrow(/50/);
  });
});

describe('MuseClient structured output and fallbacks', () => {
  it('chatJson sends json_schema and validates the answer', async () => {
    const f = mockFetch([{ status: 200, body: completion(JSON.stringify(card)) }]);
    const client = new MuseClient({ apiKey: 'k', fetchImpl: f.impl, log: quiet });
    const out = await client.chatJson([userMessage('identify')], Card, { name: 'device_card' });
    expect(out.data.name).toBe('Digitakt II');
    expect(out.format).toBe('json_schema');
    const rf = f.calls[0].body.response_format;
    expect(rf.type).toBe('json_schema');
    expect(rf.json_schema.name).toBe('device_card');
    expect(rf.json_schema.schema.properties.confidence).toMatchObject({ type: 'number', minimum: 0, maximum: 1 });
  });

  it('falls back json_schema -> json_object -> plain on 400, keeping the schema in the prompt', async () => {
    const f = mockFetch([
      { status: 400, body: { error: { message: "response_format type 'json_schema' is not supported" } } },
      { status: 400, body: { error: { message: 'Unsupported parameter: response_format' } } },
      { status: 200, body: completion('```json\n' + JSON.stringify(card) + '\n```') },
    ]);
    const client = new MuseClient({ apiKey: 'k', fetchImpl: f.impl, log: quiet });
    const out = await client.chatJson([{ role: 'system', content: 'S' }, userMessage('identify')], Card, { name: 'device_card' });
    expect(out.data.maker).toBe('Elektron');
    expect(out.format).toBe('text');
    expect(out.attempts).toBe(3);
    expect(f.calls.map((c) => c.body.response_format?.type)).toEqual(['json_schema', 'json_object', undefined]);
    const second = f.calls[1].body.messages;
    expect(second).toHaveLength(3);
    expect(second[1].role).toBe('system');
    expect(second[1].content).toMatch(/JSON Schema named "device_card"/);
  });

  it('drops reasoning_effort when the deployment rejects it', async () => {
    const f = mockFetch([
      { status: 400, body: { error: { message: "reasoning_effort 'max' is not supported for this model" } } },
      { status: 200, body: completion('fine') },
    ]);
    const client = new MuseClient({ apiKey: 'k', reasoningEffort: 'max', fetchImpl: f.impl, log: quiet });
    await client.chat([userMessage('x')]);
    expect(f.calls[0].body.reasoning_effort).toBe('max');
    expect(f.calls[1].body.reasoning_effort).toBeUndefined();
  });

  it('throws ModelOutputError with issues when the JSON does not match', async () => {
    const f = mockFetch([{ status: 200, body: completion(JSON.stringify({ ...card, confidence: 3 })) }]);
    const client = new MuseClient({ apiKey: 'k', fetchImpl: f.impl, log: quiet });
    const err = await client.chatJson([userMessage('x')], Card, { name: 'device_card' }).catch((e) => e);
    expect(err).toBeInstanceOf(ModelOutputError);
    expect((err as ModelOutputError).issues.join()).toMatch(/confidence/);
  });
});

describe('MuseClient output handling', () => {
  it('strips <think> blocks and returns them as reasoning', async () => {
    const f = mockFetch([{ status: 200, body: completion('<think>it is a drum machine</think>\n{"a":1}') }]);
    const out = await new MuseClient({ apiKey: 'k', fetchImpl: f.impl, log: quiet }).chat([userMessage('x')]);
    expect(out.text).toBe('{"a":1}');
    expect(out.reasoning).toBe('it is a drum machine');
  });

  it('splitThink and parseModelJson handle fences, prose and unterminated think', () => {
    expect(splitThink('a<think>b</think>c<think>d</think>')).toEqual({ text: 'ac', reasoning: 'b\n\nd' });
    expect(parseModelJson('Sure! Here it is: {"x": 2} hope that helps')).toEqual({ x: 2 });
    expect(parseModelJson('<think>truncated {"x": 3}')).toEqual({ x: 3 });
  });

  it('reports usage and logs one line without the key', async () => {
    const lines: string[] = [];
    const f = mockFetch([{ status: 200, body: completion('ok') }]);
    const client = new MuseClient({ apiKey: 'sk-secret-123', fetchImpl: f.impl, log: (l) => lines.push(l) });
    const out = await client.chat([userMessage('x')], { label: 'identify' });
    expect(out.usage).toEqual({ promptTokens: 1500, completionTokens: 300, totalTokens: 1800, reasoningTokens: 120, cachedTokens: undefined });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/\[muse\] identify model=muse-spark-1.3 format=text in=1500 out=300 \(reasoning 120\)/);
    expect(lines.join()).not.toContain('sk-secret-123');
    expect(client.totals()).toMatchObject({ calls: 1, promptTokens: 1500, completionTokens: 300, reasoningTokens: 120 });
  });

  it('surfaces HTTP errors with status and a body snippet', async () => {
    const f = mockFetch([{ status: 401, body: { error: 'invalid api key' } }]);
    const err = await new MuseClient({ apiKey: 'k', fetchImpl: f.impl, log: quiet }).chat([userMessage('x')]).catch((e) => e);
    expect(err).toBeInstanceOf(ModelCallError);
    expect(err.status).toBe(401);
    expect(err.message).toMatch(/HTTP 401.*invalid api key/);
  });

  it('explains an empty answer cut off by max tokens', async () => {
    const f = mockFetch([{ status: 200, body: { model: 'm', choices: [{ message: { content: '<think>long</think>' }, finish_reason: 'length' }] } }]);
    await expect(new MuseClient({ apiKey: 'k', fetchImpl: f.impl, log: quiet }).chat([userMessage('x')])).rejects.toThrow(/ran out of tokens/);
  });

  it('times out with AbortController', async () => {
    const slow = ((_u: string, init: RequestInit) =>
      new Promise((_res, rej) => init.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch;
    const client = new MuseClient({ apiKey: 'k', fetchImpl: slow, timeoutMs: 30, log: quiet });
    await expect(client.chat([userMessage('x')])).rejects.toThrow(/did not answer within/);
    expect(client.totals().failures).toBe(1);
  });

  it('honours a caller AbortSignal', async () => {
    const slow = ((_u: string, init: RequestInit) =>
      new Promise((_res, rej) => init.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch;
    const ac = new AbortController();
    const p = new MuseClient({ apiKey: 'k', fetchImpl: slow, log: quiet }).chat([userMessage('x')], { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow(/cancelled/);
  });
});

describe('fixture mode', () => {
  it('is chosen without a key, and MODEL_MODE can force it', () => {
    expect(resolveMuseConfig({}).mode).toBe('fixture');
    expect(resolveMuseConfig({ MODEL_API_KEY: 'k' })).toMatchObject({ mode: 'live', apiKey: 'k', model: 'muse-spark-1.3' });
    expect(resolveMuseConfig({ MODEL_API_KEY: 'k', MODEL_MODE: 'fixture' })).toMatchObject({ mode: 'fixture', apiKey: '' });
    expect(resolveMuseConfig({ MODEL_MODE: 'live' }).warnings[0]).toMatch(/FIXTURE/);
    expect(resolveMuseConfig({ MUSE_REASONING_EFFORT: 'none' }).warnings[0]).toMatch(/ignoring/);
  });

  it('labels plain replies FIXTURE and never calls fetch', async () => {
    const f = mockFetch([]);
    const chat = createMuseChat(resolveMuseConfig({ FIXTURE_DELAY_MS: '0' }), { fetchImpl: f.impl, log: quiet });
    const out = await chat.chat([userMessage('turn the lamp on')]);
    expect(out.text.startsWith(FIXTURE_LABEL)).toBe(true);
    expect(out).toMatchObject({ source: 'fixture', model: 'fixture' });
    expect(f.calls).toHaveLength(0);
  });

  it('answers chatJson from registered fixtures that validate against the protocol', async () => {
    const chat = new FixtureMuse({ fixtures: DEFAULT_FIXTURES, log: quiet });
    const c = await chat.chatJson([userMessage('x')], Card, { name: 'device_card' });
    expect(c.data.name).toMatch(/FIXTURE/);
    expect(c.source).toBe('fixture');
    const ui = await chat.chatJson([userMessage('x')], PayloadSchemas['ui.spec'], { name: 'ui_spec' });
    expect(ui.data.title).toMatch(/FIXTURE/);
    await expect(chat.chatJson([userMessage('x')], z.object({ a: z.string() }), { name: 'unknown_thing' })).rejects.toThrow(/no fixture or recording/);
    chat.register('unknown_thing', () => ({ a: 'FIXTURE' }));
    expect((await chat.chatJson([userMessage('x')], z.object({ a: z.string() }), { name: 'unknown_thing' })).data.a).toBe('FIXTURE');
  });
});

describe('call log and recorded responses', () => {
  it('logs every live call, including failures, with model id and latency', async () => {
    const lines: string[] = [];
    const f = mockFetch([
      { status: 200, body: completion('ok') },
      { status: 500, body: 'upstream down' },
    ]);
    const client = new MuseClient({ apiKey: 'k', fetchImpl: f.impl, log: (l) => lines.push(l) });
    await client.chat([userMessage('x')], { label: 'plan' });
    await client.chat([userMessage('x')], { label: 'plan' }).catch(() => {});
    const calls = client.calls();
    expect(calls.map((c) => [c.label, c.model, c.ok])).toEqual([
      ['plan', 'muse-spark-1.3', true],
      ['plan', 'muse-spark-1.3', false],
    ]);
    expect(calls[0].usage?.promptTokens).toBe(1500);
    expect(typeof calls[1].latencyMs).toBe('number');
    expect(lines[1]).toMatch(/\[muse\] plan model=muse-spark-1.3 .*FAILED: Meta Model API HTTP 500/);
    expect(client.totals()).toMatchObject({ calls: 2, failures: 1 });
  });

  it('records keyed live responses and replays them in fixture mode (labelled as fixture)', async () => {
    const recs: RecordedCall[] = [];
    const f = mockFetch([{ status: 200, body: completion(JSON.stringify(card)) }]);
    const live = new MuseClient({ apiKey: 'k', fetchImpl: f.impl, log: quiet, recorder: (r) => recs.push(r) });
    await live.chatJson([userMessage('identify')], Card, { name: 'device_card' });
    await live.chat([userMessage('unkeyed')]);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ name: 'device_card', model: 'muse-spark-1.3', usage: { promptTokens: 1500 } });

    const dir = mkdtempSync(join(tmpdir(), 'ce-rec-'));
    try {
      fileRecorder(dir, quiet)(recs[0]);
      const loaded = loadRecorded(dir);
      const fx = new FixtureMuse({ fixtures: DEFAULT_FIXTURES, recorded: loaded, log: quiet });
      expect(fx.recordedKeys()).toEqual(['device_card']);
      const out = await fx.chatJson([userMessage('identify')], Card, { name: 'device_card' });
      expect(out.data.name).toBe('Digitakt II'); // the recorded real answer beats the canned FIXTURE card
      expect(out).toMatchObject({ source: 'fixture', model: 'fixture', recordedFrom: 'muse-spark-1.3' });
      expect(fx.calls()[0]).toMatchObject({ source: 'fixture', recordedFrom: 'muse-spark-1.3' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enables recording only in live mode and replay only in fixture mode', async () => {
    const { loadConfig } = await import('../config');
    expect(loadConfig({ MODEL_API_KEY: 'k', MUSE_RECORD: '1' }).muse.recordDir).toMatch(/fixtures\/recorded$/);
    expect(loadConfig({ MODEL_API_KEY: 'k' }).muse.recordDir).toBeUndefined();
    expect(loadConfig({}).muse.replayDir).toMatch(/fixtures\/recorded$/);
    expect(loadConfig({ MUSE_REPLAY: '0' }).muse.replayDir).toBeUndefined();
  });
});
