/**
 * Muse Spark chat client for the Meta Model API (OpenAI-compatible chat/completions), plus a FIXTURE
 * client used when MODEL_API_KEY is absent. The API key lives only here and in config; never log it.
 *
 * Ported and adapted from FAMILIAR (same author, built earlier in this hackathon): server/adapter.ts.
 * Changes: multi-part messages with images, json_schema -> json_object -> plain fallback chain,
 * temperature left unset by default, max_completion_tokens, usage logging, zod-validated chatJson.
 *
 * API rules (dev.meta.ai/docs: image-understanding, structured-output, reasoning, chat-completions):
 * - POST {base}/chat/completions with `Authorization: Bearer <key>`.
 * - Images only count in user-role messages, as {type:"image_url", image_url:{url, detail?}} where url may be
 *   "data:image/jpeg;base64,..."; at most 50 per request (more is HTTP 400). HEIC is not accepted.
 * - response_format: json_schema (constrained decoding, preferred), json_object (legacy), or omitted.
 * - reasoning_effort: minimal | low | medium | high | xhigh | max ("none" is HTTP 400); omitted = model decides.
 *   Reasoning tokens count toward max_completion_tokens.
 * - temperature: leave unset; Muse Spark is tuned for the default.
 */
import type { z } from 'zod';
import { museResponseFormat, type ResponseFormatJsonSchema } from '@ce/protocol';
import { CallLog, type CallRecord, type CallTotals } from './callLog';
import { cancellableDelay, forwardCancellation, RequestCancelledError, throwIfCancelled } from './cancellation';
import { DEFAULT_MUSE_BASE_URL, DEFAULT_MUSE_MODEL, type MuseConfig, type ReasoningEffort } from './config';
import { fileRecorder, loadRecorded, type RecordedCall } from './recorded';

export const DEFAULT_TIMEOUT_MS = 60_000;
export const FIXTURE_MODEL = 'fixture';
export const FIXTURE_LABEL = '[FIXTURE]';
export const MAX_IMAGES_PER_REQUEST = 50;

export type ChatRole = 'system' | 'developer' | 'user' | 'assistant';
export interface TextPart {
  type: 'text';
  text: string;
}
export interface ImagePart {
  type: 'image_url';
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
}
export type ContentPart = TextPart | ImagePart;
export interface ChatMessage {
  role: ChatRole;
  content: string | ContentPart[];
}

export type ResponseFormat = ResponseFormatJsonSchema | { type: 'json_object' } | { type: 'text' };
export type FormatUsed = 'json_schema' | 'json_object' | 'text';

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;
}

export interface ChatOptions {
  responseFormat?: ResponseFormat;
  /** overrides the client default for this call */
  reasoningEffort?: ReasoningEffort;
  /** sent as max_completion_tokens (includes reasoning tokens) */
  maxTokens?: number;
  /** leave unset unless you have a reason; the docs recommend the default */
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** tag for the usage log, e.g. "identify" */
  label?: string;
  /** fixture mode only: key of the canned reply (defaults to the json_schema name) */
  fixture?: string;
}

export interface ChatResult {
  /** answer text with <think> blocks removed */
  text: string;
  /** removed <think> content or a separate reasoning field, if the API returned any */
  reasoning?: string;
  model: string;
  source: 'live' | 'fixture';
  /** response_format actually used after fallbacks */
  format: FormatUsed;
  finishReason?: string;
  usage?: Usage;
  latencyMs: number;
  attempts: number;
  /** fixture replay of a recorded real response: the model that produced it */
  recordedFrom?: string;
}

export interface ChatJsonOptions extends Omit<ChatOptions, 'responseFormat'> {
  /** json_schema name: 1-64 chars of [A-Za-z0-9_-]; also the default fixture key */
  name: string;
  description?: string;
}

/** What the rest of the server depends on; live and fixture clients both implement it. */
export interface MuseChat {
  readonly mode: 'live' | 'fixture';
  readonly model: string;
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
  chatJson<S extends z.ZodType>(messages: ChatMessage[], schema: S, opts: ChatJsonOptions): Promise<ChatResult & { data: z.infer<S> }>;
  /** token and call counts so far */
  totals(): CallTotals;
  /** recent calls with model id, latency and usage (newest last) */
  calls(): CallRecord[];
}

/** Stable key of a call for fixtures and recordings: `fixture`, else the json_schema name, else `label`. */
export function callKey(opts: ChatOptions): string | undefined {
  return opts.fixture ?? (opts.responseFormat?.type === 'json_schema' ? opts.responseFormat.json_schema.name : undefined) ?? opts.label;
}

export class ModelCallError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ModelCallError';
  }
}

/** The model answered, but not with what the schema asks for. `text` and `issues` feed a repair prompt. */
export class ModelOutputError extends Error {
  constructor(
    message: string,
    readonly text: string,
    readonly issues: string[],
  ) {
    super(message);
    this.name = 'ModelOutputError';
  }
}

// --- message helpers ------------------------------------------------------------------------

/** An image part from base64 JPEG bytes, a data URL, or an http(s) URL. */
export function imagePart(image: string, detail?: 'auto' | 'low' | 'high', mime = 'image/jpeg'): ImagePart {
  const url = /^(data:|https?:\/\/)/i.test(image) ? image : `data:${mime};base64,${image}`;
  return { type: 'image_url', image_url: detail ? { url, detail } : { url } };
}

/** A user message with text first, then images. */
export function userMessage(text: string, images: string[] = [], detail?: 'auto' | 'low' | 'high'): ChatMessage {
  if (!images.length) return { role: 'user', content: text };
  return { role: 'user', content: [{ type: 'text', text }, ...images.map((i) => imagePart(i, detail))] };
}

function checkMessages(messages: ChatMessage[]): void {
  if (!messages.length) throw new Error('chat needs at least one message');
  let images = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') continue;
    for (const p of m.content) {
      if (p.type !== 'image_url') continue;
      if (m.role !== 'user') throw new Error(`images in a ${m.role} message are ignored by the Meta API; put them in a user message`);
      images++;
    }
  }
  if (images > MAX_IMAGES_PER_REQUEST) throw new Error(`${images} images in one request; the Meta API allows ${MAX_IMAGES_PER_REQUEST}`);
}

// --- output helpers (ported) ----------------------------------------------------------------

/** Remove <think>…</think> blocks and return them separately. An unterminated <think> loses only its tag. */
export function splitThink(raw: string): { text: string; reasoning?: string } {
  const thoughts: string[] = [];
  let text = raw.replace(/<think>([\s\S]*?)<\/think>/gi, (_m, inner: string) => {
    thoughts.push(inner.trim());
    return '';
  });
  // truncated reasoning: drop the tag and keep the rest, so a JSON object after it can still be found
  text = text.replace(/<think>/gi, '');
  return { text: text.trim(), reasoning: thoughts.length ? thoughts.join('\n\n') : undefined };
}

/** Reasoning blocks and markdown fences removed; the JSON object text. */
export function stripModelText(text: string): string {
  let t = splitThink(text).text;
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1];
  t = t.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) {
    const i = t.indexOf('{');
    const j = t.lastIndexOf('}');
    if (i >= 0 && j > i) t = t.slice(i, j + 1);
  }
  return t;
}

export function parseModelJson(text: string): unknown {
  return JSON.parse(stripModelText(text));
}

function snippet(s: string, n = 300): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

/** OpenAI-style content may be a string or an array of parts. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).join('');
  }
  return '';
}

function parseUsage(u: unknown): Usage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const o = u as Record<string, any>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const prompt = num(o.prompt_tokens) ?? num(o.input_tokens) ?? 0;
  const completion = num(o.completion_tokens) ?? num(o.output_tokens) ?? 0;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: num(o.total_tokens) ?? prompt + completion,
    reasoningTokens: num(o.completion_tokens_details?.reasoning_tokens),
    cachedTokens: num(o.prompt_tokens_details?.cached_tokens),
  };
}

function validateJson<S extends z.ZodType>(schema: S, text: string, name: string): z.infer<S> {
  let value: unknown;
  try {
    value = parseModelJson(text);
  } catch {
    throw new ModelOutputError(`${name}: the model's answer is not JSON`, text, ['(root): not valid JSON']);
  }
  const r = schema.safeParse(value);
  if (!r.success) {
    const issues = r.error.issues.slice(0, 20).map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`);
    throw new ModelOutputError(`${name}: the model's answer does not match the schema`, text, issues);
  }
  return r.data;
}

/** When json_schema is dropped, put the schema into the prompt so the fallback still knows the shape. */
function withSchemaInstruction(messages: ChatMessage[], rf: ResponseFormatJsonSchema): ChatMessage[] {
  const instruction: ChatMessage = {
    role: 'system',
    content: `Reply with only one JSON object (no prose, no markdown) that conforms to this JSON Schema named "${rf.json_schema.name}":\n${JSON.stringify(rf.json_schema.schema)}`,
  };
  const firstNonSystem = messages.findIndex((m) => m.role !== 'system' && m.role !== 'developer');
  const at = firstNonSystem < 0 ? messages.length : firstNonSystem;
  return [...messages.slice(0, at), instruction, ...messages.slice(at)];
}

// --- live client ----------------------------------------------------------------------------

export interface MuseClientOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  reasoningEffort?: ReasoningEffort;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  /** shared record of every call (one log line each) */
  callLog?: CallLog;
  /** save keyed successful responses for later fixture replay (MUSE_RECORD=1) */
  recorder?: (rec: RecordedCall) => void;
}

export class MuseClient implements MuseChat {
  readonly mode = 'live' as const;
  readonly model: string;
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly callLog: CallLog;

  constructor(private readonly opts: MuseClientOptions) {
    if (!opts.apiKey) throw new Error('MuseClient needs MODEL_API_KEY');
    this.model = opts.model || DEFAULT_MUSE_MODEL;
    this.url = `${(opts.baseUrl || DEFAULT_MUSE_BASE_URL).replace(/\/+$/, '')}/chat/completions`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.callLog = opts.callLog ?? new CallLog(opts.log);
  }

  totals(): CallTotals {
    return this.callLog.totals();
  }

  calls(): CallRecord[] {
    return this.callLog.list();
  }

  /** The exact JSON body sent to the Meta Model API. */
  buildBody(messages: ChatMessage[], o: ChatOptions = {}): Record<string, unknown> {
    const body: Record<string, unknown> = { model: this.model, messages };
    if (o.responseFormat && o.responseFormat.type !== 'text') body.response_format = o.responseFormat;
    const effort = o.reasoningEffort ?? this.opts.reasoningEffort;
    if (effort) body.reasoning_effort = effort;
    if (o.maxTokens) body.max_completion_tokens = o.maxTokens;
    if (o.temperature !== undefined) body.temperature = o.temperature;
    return body;
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    checkMessages(messages);
    const started = Date.now();
    const budget = opts.timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = started + budget;
    let msgs = messages;
    let format = opts.responseFormat;
    let effort = opts.reasoningEffort ?? this.opts.reasoningEffort;
    const fallbacks: string[] = [];
    try {
      for (let attempt = 1; ; attempt++) {
        const left = deadline - Date.now();
        if (left <= 0) throw new ModelCallError(`Muse did not answer within ${Math.round(budget / 1000)}s`);
        const body = this.buildBody(msgs, { ...opts, responseFormat: format, reasoningEffort: effort });
        if (!effort) delete body.reasoning_effort;
        const res = await this.post(body, left, budget, opts.signal);
        // compatibility fallbacks share the first request's time budget
        if (res.status === 400 && attempt < 4) {
          if (format?.type === 'json_schema' && /response_format|json_schema|schema/i.test(res.text)) {
            msgs = withSchemaInstruction(messages, format);
            format = { type: 'json_object' };
            fallbacks.push('json_schema->json_object');
            continue;
          }
          if (format?.type === 'json_object' && /response_format|json_object|json/i.test(res.text)) {
            format = undefined;
            fallbacks.push('json_object->text');
            continue;
          }
          if (effort && /reasoning/i.test(res.text)) {
            effort = undefined;
            fallbacks.push('no reasoning_effort');
            continue;
          }
        }
        const result = this.read(res, format, started, attempt);
        const key = callKey(opts);
        this.callLog.add({
          at: started,
          label: key ?? 'chat',
          model: result.model,
          source: 'live',
          ok: true,
          latencyMs: result.latencyMs,
          format: result.format,
          effort,
          finishReason: result.finishReason,
          usage: result.usage,
          fallbacks: fallbacks.length ? fallbacks : undefined,
        });
        if (key && this.opts.recorder) {
          this.opts.recorder({ name: key, model: result.model, recordedAt: new Date().toISOString(), latencyMs: result.latencyMs, usage: result.usage, text: result.text });
        }
        return result;
      }
    } catch (e) {
      this.callLog.add({
        at: started,
        label: callKey(opts) ?? 'chat',
        model: this.model,
        source: 'live',
        ok: false,
        latencyMs: Date.now() - started,
        effort,
        fallbacks: fallbacks.length ? fallbacks : undefined,
        error: (e as Error).message,
      });
      throw e;
    }
  }

  async chatJson<S extends z.ZodType>(messages: ChatMessage[], schema: S, opts: ChatJsonOptions): Promise<ChatResult & { data: z.infer<S> }> {
    const responseFormat = museResponseFormat(opts.name, schema, { description: opts.description });
    const res = await this.chat(messages, { ...opts, responseFormat, label: opts.label ?? opts.name });
    return { ...res, data: validateJson(schema, res.text, opts.name) };
  }

  private async post(body: Record<string, unknown>, timeoutMs: number, budgetMs: number, signal?: AbortSignal): Promise<{ status: number; text: string }> {
    throwIfCancelled(signal);
    const controller = new AbortController();
    const unlink = forwardCancellation(signal, controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.opts.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return { status: res.status, text: await res.text() };
    } catch (e) {
      if (signal?.aborted) throw new RequestCancelledError();
      if (controller.signal.aborted) throw new ModelCallError(`Muse did not answer within ${Math.round(budgetMs / 1000)}s`);
      throw new ModelCallError(`Could not reach the Meta Model API: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
      unlink();
    }
  }

  private read(res: { status: number; text: string }, format: ResponseFormat | undefined, started: number, attempts: number): ChatResult {
    if (res.status < 200 || res.status >= 300) {
      throw new ModelCallError(`Meta Model API HTTP ${res.status}: ${snippet(res.text)}`, res.status);
    }
    let json: any;
    try {
      json = JSON.parse(res.text);
    } catch {
      throw new ModelCallError(`Meta Model API returned non-JSON: ${snippet(res.text)}`);
    }
    const choice = json?.choices?.[0];
    const finishReason: string | undefined = typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined;
    const split = splitThink(contentText(choice?.message?.content));
    const extra = choice?.message?.reasoning_content ?? choice?.message?.reasoning;
    const reasoning = [split.reasoning, typeof extra === 'string' ? extra : undefined].filter(Boolean).join('\n\n') || undefined;
    if (!split.text) {
      const hint = finishReason === 'length' ? ' (ran out of tokens; raise maxTokens or lower reasoning_effort)' : '';
      throw new ModelCallError(`Muse returned an empty message (finish_reason=${finishReason ?? 'unknown'})${hint}`);
    }
    return {
      text: split.text,
      reasoning,
      model: typeof json?.model === 'string' ? json.model : this.model,
      source: 'live',
      format: format?.type ?? 'text',
      finishReason,
      usage: parseUsage(json?.usage),
      latencyMs: Date.now() - started,
      attempts,
    };
  }

}

// --- fixture client -------------------------------------------------------------------------

export type FixtureValue = unknown;
export type FixtureFn = (messages: ChatMessage[]) => unknown;

function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    return typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '[image]')).join(' ');
  }
  return '';
}

/**
 * No network. JSON calls answer from registered fixtures (keyed by json_schema name); plain calls answer a
 * FIXTURE-labelled sentence. Results carry source "fixture" and model "fixture" so nothing can pass as live.
 */
export interface FixtureMuseOptions {
  delayMs?: number;
  fixtures?: Record<string, FixtureValue | FixtureFn>;
  /** recorded real responses by key; they win over `fixtures` */
  recorded?: Map<string, RecordedCall>;
  log?: (line: string) => void;
  callLog?: CallLog;
}

export class FixtureMuse implements MuseChat {
  readonly mode = 'fixture' as const;
  readonly model = FIXTURE_MODEL;
  private readonly fixtures = new Map<string, FixtureValue | FixtureFn>();
  private readonly recorded: Map<string, RecordedCall>;
  private readonly callLog: CallLog;

  constructor(private readonly o: FixtureMuseOptions = {}) {
    for (const [k, v] of Object.entries(o.fixtures ?? {})) this.fixtures.set(k, v);
    this.recorded = o.recorded ?? new Map();
    this.callLog = o.callLog ?? new CallLog(o.log);
  }

  register(key: string, value: FixtureValue | FixtureFn): void {
    this.fixtures.set(key, value);
  }

  /** keys answered from recorded real responses */
  recordedKeys(): string[] {
    return [...this.recorded.keys()];
  }

  totals(): CallTotals {
    return this.callLog.totals();
  }

  calls(): CallRecord[] {
    return this.callLog.list();
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    throwIfCancelled(opts.signal);
    checkMessages(messages);
    const started = Date.now();
    if (this.o.delayMs) await cancellableDelay(this.o.delayMs, opts.signal);
    const rf = opts.responseFormat;
    const wantsJson = rf?.type === 'json_schema' || rf?.type === 'json_object';
    const key = callKey(opts);
    const rec = key ? this.recorded.get(key) : undefined;
    let text: string;
    if (rec) {
      text = rec.text;
    } else if (key && (this.fixtures.has(key) || this.fixtures.has(key.split(':')[0]))) {
      // "device_card:ceiling-light" falls back to the generic "device_card" fixture
      const v = this.fixtures.get(key) ?? this.fixtures.get(key.split(':')[0]);
      text = JSON.stringify(typeof v === 'function' ? (v as FixtureFn)(messages) : v);
    } else if (wantsJson) {
      const error = `${FIXTURE_LABEL} no fixture or recording for "${key ?? 'json_object'}"; set MODEL_API_KEY for live calls, record one (MUSE_RECORD=1) or register a fixture`;
      this.callLog.add({ at: started, label: key ?? 'chat', model: FIXTURE_MODEL, source: 'fixture', ok: false, latencyMs: Date.now() - started, error });
      throw new ModelCallError(error);
    } else {
      text = `${FIXTURE_LABEL} No Meta model was called (fixture mode, MODEL_API_KEY not set). Last user message: "${snippet(lastUserText(messages), 120)}"`;
    }
    const latencyMs = Date.now() - started;
    this.callLog.add({ at: started, label: key ?? 'chat', model: FIXTURE_MODEL, source: 'fixture', ok: true, latencyMs, format: rf?.type ?? 'text', recordedFrom: rec?.model });
    const result: ChatResult = { text, model: FIXTURE_MODEL, source: 'fixture', format: rf?.type ?? 'text', finishReason: 'stop', latencyMs, attempts: 0 };
    if (rec) result.recordedFrom = rec.model;
    return result;
  }

  async chatJson<S extends z.ZodType>(messages: ChatMessage[], schema: S, opts: ChatJsonOptions): Promise<ChatResult & { data: z.infer<S> }> {
    const responseFormat = museResponseFormat(opts.name, schema, { description: opts.description });
    const res = await this.chat(messages, { ...opts, responseFormat, fixture: opts.fixture ?? opts.name, label: opts.label ?? opts.name });
    return { ...res, data: validateJson(schema, res.text, opts.name) };
  }
}

export function createMuseChat(
  cfg: MuseConfig,
  deps: { fetchImpl?: typeof fetch; log?: (line: string) => void; fixtures?: Record<string, FixtureValue | FixtureFn>; callLog?: CallLog } = {},
): MuseChat {
  const callLog = deps.callLog ?? new CallLog(deps.log);
  if (cfg.mode === 'live') {
    return new MuseClient({
      apiKey: cfg.apiKey,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      reasoningEffort: cfg.reasoningEffort,
      fetchImpl: deps.fetchImpl,
      callLog,
      recorder: cfg.recordDir ? fileRecorder(cfg.recordDir, deps.log) : undefined,
    });
  }
  return new FixtureMuse({ delayMs: cfg.fixtureDelayMs, fixtures: deps.fixtures, recorded: loadRecorded(cfg.replayDir), callLog });
}
