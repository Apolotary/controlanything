import { describe, expect, it } from 'vitest';
import { ModelCallError } from '../muse/adapter';
import { TopLevelItemScanner } from './partial';
import { buildStreamBody, costUsd, SseDecoder, StreamClient } from './stream';
import { contentEvents, mockFetch, sseResponse } from './testkit';

describe('SseDecoder', () => {
  it('reassembles data lines split across chunks, with CRLF', () => {
    const d = new SseDecoder();
    expect(d.push('data: {"a"')).toEqual([]);
    expect(d.push(':1}\r\n\r\ndata: [DO')).toEqual(['{"a":1}']);
    expect(d.push('NE]\n')).toEqual(['[DONE]']);
    expect(d.push(': comment\nevent: x\n')).toEqual([]);
  });
});

describe('StreamClient', () => {
  it('posts a streamed chat/completions body (no temperature) and accumulates content + usage', async () => {
    const f = mockFetch([() => sseResponse(contentEvents('{"hello": "world"}', 4))]);
    const c = new StreamClient({ apiKey: 'sk-test', fetchImpl: f.impl });
    const deltas: string[] = [];
    const r = await c.stream({ model: 'muse-spark-1.3', messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'low', maxTokens: 900, responseFormat: { type: 'json_schema' } }, { onContent: (d) => deltas.push(d) });
    expect(r.content).toBe('{"hello": "world"}');
    expect(deltas.length).toBeGreaterThan(1);
    expect(r.finishReason).toBe('stop');
    expect(r.usage).toEqual({ promptTokens: 3000, completionTokens: 2000, reasoningTokens: 900, cachedTokens: 2800 });
    expect(f.calls[0].url).toBe('https://api.meta.ai/v1/chat/completions');
    expect(f.calls[0].body).toMatchObject({ model: 'muse-spark-1.3', stream: true, stream_options: { include_usage: true }, reasoning_effort: 'low', max_completion_tokens: 900, response_format: { type: 'json_schema' } });
    expect(f.calls[0].body.temperature).toBeUndefined();
  });

  it('accumulates parallel tool calls by index and reports each when the next starts', async () => {
    const ev = (tc: unknown, finish: string | null = null) => ({ choices: [{ index: 0, delta: { tool_calls: [tc] }, finish_reason: finish }] });
    const f = mockFetch([
      () =>
        sseResponse([
          ev({ index: 0, id: 'call_a', type: 'function', function: { name: 'add_control', arguments: '' } }),
          ev({ index: 0, function: { arguments: '{"id":"cut' } }),
          ev({ index: 0, function: { arguments: 'off"}' } }),
          ev({ index: 1, id: 'call_b', type: 'function', function: { name: 'bind', arguments: '{"id":"cutoff"}' } }),
          { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        ]),
    ]);
    const done: string[] = [];
    const r = await new StreamClient({ apiKey: 'k', fetchImpl: f.impl }).stream({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [] }, { onToolCall: (t) => done.push(t.name) });
    expect(r.toolCalls.map((t) => [t.id, t.name, t.arguments])).toEqual([
      ['call_a', 'add_control', '{"id":"cutoff"}'],
      ['call_b', 'bind', '{"id":"cutoff"}'],
    ]);
    expect(done).toEqual(['add_control', 'bind']);
    expect(r.finishReason).toBe('tool_calls');
  });

  it('turns HTTP errors into ModelCallError with the status', async () => {
    const f = mockFetch([() => new Response('{"error":{"message":"bad schema"}}', { status: 400 })]);
    await expect(new StreamClient({ apiKey: 'k', fetchImpl: f.impl }).stream({ model: 'm', messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ name: 'ModelCallError', status: 400 });
    await expect(new StreamClient({ apiKey: 'k', fetchImpl: f.impl }).stream({ model: 'm', messages: [{ role: 'user', content: 'x' }] })).rejects.toBeInstanceOf(ModelCallError);
  });

  it('omits unset options from the body', () => {
    const b = buildStreamBody({ model: 'm', messages: [] });
    expect(Object.keys(b).sort()).toEqual(['messages', 'model', 'stream', 'stream_options']);
  });

  it('prices usage with cached input at the cached rate', () => {
    expect(costUsd('muse-spark-1.3', { promptTokens: 1_000_000, cachedTokens: 1_000_000, completionTokens: 0, reasoningTokens: 0 })).toBeCloseTo(0.15);
    expect(costUsd('muse-wonder-1.0', { promptTokens: 0, cachedTokens: 0, completionTokens: 1_000_000, reasoningTokens: 0 })).toBeCloseTo(20);
  });
});

describe('TopLevelItemScanner', () => {
  it('emits each finished element of a top-level array while the rest is still streaming', () => {
    const full = '{"hacks": [{"id": "h_a", "name": "A {x}", "blurb": "say \\"hi\\" ]"}, {"id": "h_b", "steps": [{"x": 1}]}], "title": "T"}';
    const s = new TopLevelItemScanner();
    const seen: unknown[] = [];
    for (let i = 1; i <= full.length; i++) for (const it of s.push(full.slice(0, i))) seen.push(it);
    expect(seen).toEqual([
      { key: 'hacks', index: 0, value: { id: 'h_a', name: 'A {x}', blurb: 'say "hi" ]' } },
      { key: 'hacks', index: 1, value: { id: 'h_b', steps: [{ x: 1 }] } },
    ]);
  });
});
