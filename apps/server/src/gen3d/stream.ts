/**
 * Streaming chat/completions client for the Meta Model API (SSE), for structured output and tool calls.
 * Streaming matters here twice: the headset can show the object assembling while tokens arrive, and
 * streamed requests are exempt from the non-streaming 504 time limit (dev.meta.ai/docs/error-handling).
 *
 * Observed live (Nov 2): usage arrives in the final chunk with stream_options.include_usage; json_schema
 * output streams token by token; parallel tool calls stream one index after another; object keys come out
 * in alphabetical order, not schema order. temperature stays unset (the docs recommend the default).
 */
import { ModelCallError } from '../muse/adapter';
import { forwardCancellation, RequestCancelledError, throwIfCancelled } from '../muse/cancellation';
import type { ContentPart } from '../muse/adapter';
import type { ReasoningEffort } from '../muse/config';

export interface ToolCallOut {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type StreamMessage =
  | { role: 'system' | 'developer' | 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string; tool_calls?: ToolCallOut[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown>; strict?: boolean };
}

export interface StreamRequest {
  model: string;
  messages: StreamMessage[];
  responseFormat?: Record<string, unknown>;
  tools?: ToolDef[];
  parallelToolCalls?: boolean;
  reasoningEffort?: ReasoningEffort;
  maxTokens?: number;
  /** groups requests that share the stable system prompt (better cache hits) */
  promptCacheKey?: string;
}

export interface StreamUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
}

export interface StreamedToolCall {
  index: number;
  id: string;
  name: string;
  arguments: string;
  /** ms after the request started: first delta, and when the next call (or the end) arrived */
  startedMs: number;
  doneMs: number;
}

export interface StreamResult {
  content: string;
  toolCalls: StreamedToolCall[];
  finishReason?: string;
  usage?: StreamUsage;
  model: string;
  /** first visible token (content or tool call) */
  ttftMs?: number;
  latencyMs: number;
  chunks: number;
}

export interface StreamHandlers {
  onContent?: (delta: string, soFar: string) => void;
  onToolCall?: (call: StreamedToolCall) => void;
}

export interface StreamClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export const DEFAULT_STREAM_TIMEOUT_MS = 180_000;

function snippet(s: string, n = 400): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function parseStreamUsage(u: any): StreamUsage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  return {
    promptTokens: num(u.prompt_tokens ?? u.input_tokens),
    completionTokens: num(u.completion_tokens ?? u.output_tokens),
    reasoningTokens: num(u.completion_tokens_details?.reasoning_tokens),
    cachedTokens: num(u.prompt_tokens_details?.cached_tokens),
  };
}

export function buildStreamBody(r: StreamRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: r.model,
    messages: r.messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (r.responseFormat) body.response_format = r.responseFormat;
  if (r.tools?.length) {
    body.tools = r.tools;
    if (r.parallelToolCalls !== undefined) body.parallel_tool_calls = r.parallelToolCalls;
  }
  if (r.reasoningEffort) body.reasoning_effort = r.reasoningEffort;
  if (r.maxTokens) body.max_completion_tokens = r.maxTokens;
  if (r.promptCacheKey) body.prompt_cache_key = r.promptCacheKey;
  return body;
}

/** Incremental SSE decoder: feed text, get complete `data:` payloads. */
export class SseDecoder {
  private buf = '';
  push(text: string): string[] {
    this.buf += text;
    const out: string[] = [];
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      if (line.startsWith('data:')) out.push(line.slice(5).trimStart());
    }
    return out;
  }
  flush(): string[] {
    const rest = this.buf.replace(/\r$/, '');
    this.buf = '';
    return rest.startsWith('data:') ? [rest.slice(5).trimStart()] : [];
  }
}

export class StreamClient {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly o: StreamClientOptions) {
    if (!o.apiKey) throw new Error('StreamClient needs MODEL_API_KEY');
    this.url = `${(o.baseUrl || 'https://api.meta.ai/v1').replace(/\/+$/, '')}/chat/completions`;
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  async stream(req: StreamRequest, handlers: StreamHandlers = {}, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<StreamResult> {
    throwIfCancelled(opts.signal);
    const started = Date.now();
    const budget = opts.timeoutMs ?? this.o.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
    const controller = new AbortController();
    const unlink = forwardCancellation(opts.signal, controller);
    const timer = setTimeout(() => controller.abort(), budget);
    const fail = (e: unknown): never => {
      if (opts.signal?.aborted) throw new RequestCancelledError();
      if (controller.signal.aborted) throw new ModelCallError(`Muse did not finish within ${Math.round(budget / 1000)}s`);
      if (e instanceof ModelCallError) throw e;
      throw new ModelCallError(`Meta Model API stream failed: ${(e as Error).message}`);
    };
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.o.apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify(buildStreamBody(req)),
          signal: controller.signal,
        });
      } catch (e) {
        return fail(e);
      }
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        throw new ModelCallError(`Meta Model API HTTP ${res.status}: ${snippet(text)}`, res.status);
      }
      const out: StreamResult = { content: '', toolCalls: [], model: req.model, latencyMs: 0, chunks: 0 };
      const calls = new Map<number, StreamedToolCall>();
      let openIndex: number | undefined;
      const closeOpen = () => {
        if (openIndex === undefined) return;
        const c = calls.get(openIndex)!;
        c.doneMs = Date.now() - started;
        handlers.onToolCall?.(c);
        openIndex = undefined;
      };
      const onPayload = (data: string) => {
        if (data === '[DONE]') return;
        let j: any;
        try {
          j = JSON.parse(data);
        } catch {
          return;
        }
        if (j?.error) throw new ModelCallError(`Meta Model API stream error: ${snippet(JSON.stringify(j.error))}`, num(j.error?.status) || undefined);
        out.chunks++;
        if (typeof j.model === 'string') out.model = j.model;
        if (j.usage) out.usage = parseStreamUsage(j.usage);
        const choice = j.choices?.[0];
        if (!choice) return;
        const delta = choice.delta ?? {};
        if (typeof delta.content === 'string' && delta.content) {
          out.ttftMs ??= Date.now() - started;
          out.content += delta.content;
          handlers.onContent?.(delta.content, out.content);
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const index = typeof tc.index === 'number' ? tc.index : 0;
            let c = calls.get(index);
            if (!c) {
              if (openIndex !== undefined && openIndex !== index) closeOpen();
              out.ttftMs ??= Date.now() - started;
              c = { index, id: '', name: '', arguments: '', startedMs: Date.now() - started, doneMs: 0 };
              calls.set(index, c);
              openIndex = index;
            }
            if (tc.id) c.id = tc.id;
            if (tc.function?.name) c.name += tc.function.name;
            if (typeof tc.function?.arguments === 'string') c.arguments += tc.function.arguments;
          }
        }
        if (choice.finish_reason) out.finishReason = choice.finish_reason;
      };
      const dec = new SseDecoder();
      const text = new TextDecoder();
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          if (controller.signal.aborted) throw new Error('aborted');
          for (const d of dec.push(text.decode(chunk, { stream: true }))) onPayload(d);
        }
        for (const d of dec.flush()) onPayload(d);
      } catch (e) {
        return fail(e);
      }
      closeOpen();
      out.toolCalls = [...calls.values()].sort((a, b) => a.index - b.index);
      out.latencyMs = Date.now() - started;
      return out;
    } finally {
      clearTimeout(timer);
      unlink();
    }
  }
}

// --- cost -----------------------------------------------------------------------------------

/** USD per million tokens (dev.meta.ai/docs/pricing-rate-limits, Nov 2026). */
export const PRICES: Record<string, { input: number; cached: number; output: number }> = {
  'muse-spark-1.3': { input: 1.25, cached: 0.15, output: 4.25 },
  'muse-spark-1.2': { input: 1.25, cached: 0.15, output: 4.25 },
  'muse-wonder-1.0': { input: 4, cached: 0.2, output: 20 },
};

export function costUsd(model: string, u: StreamUsage | undefined): number {
  if (!u) return 0;
  const p = PRICES[model] ?? PRICES['muse-wonder-1.0'];
  const fresh = Math.max(0, u.promptTokens - u.cachedTokens);
  return (fresh * p.input + u.cachedTokens * p.cached + u.completionTokens * p.output) / 1e6;
}
