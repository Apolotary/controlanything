/**
 * SAM 3.1 through the Meta Model API Responses endpoint (research/03 §3, live-measured):
 *   POST {base}/responses  { model: "sam-3.1", input: [{ type: "message", role: "user", content: [{type:"input_text", text: <one noun phrase>}, {type:"input_image", image_url: <data url>}] }],
 *                           metadata: { include_confidence: "true", mask_encoding: "one_bit" } }   // metadata values are strings
 *   -> output_text: "<0f>id<|box;x1=;y1=;x2=;y2=;w=;h=;c=|><|mask;x=0;y=0;c=;data=H,W,!payload|>,id..."  (empty = nothing found)
 * One concept per request (lists and "and" break it), stream:false for stills (faster), ~1-3.5 s each,
 * $0.0025 per image per prompt. Masks are box-cropped one_bit rasters decoded with @meta-sam/parser.
 *
 * FIXTURE mode answers from recordings (MUSE_RECORD=1 saves every live reply under
 * apps/server/fixtures/recorded/sam/) or, failing that, from a canned FIXTURE scene, always labelled.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeMaskToRaster } from '@meta-sam/parser';
import type { CallLog } from '../muse/callLog';
import { cancellableDelay, forwardCancellation, RequestCancelledError, throwIfCancelled } from '../muse/cancellation';
import { ModelCallError } from '../muse/adapter';
import type { MuseConfig } from '../muse/config';

export const SAM_MODEL = 'sam-3.1';
export const SAM_TIMEOUT_MS = 20_000;

export interface SamMask {
  encoding: 'lossless' | 'one_bit';
  payload: string;
  /** raster size: columns x rows, sits at the box's top-left */
  width: number;
  height: number;
}

export interface SamRecord {
  id: number;
  /** source pixels, x2/y2 inclusive */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** source image size the model saw */
  w: number;
  h: number;
  confidence?: number;
  mask?: SamMask;
}

export interface SamResult {
  prompt: string;
  records: SamRecord[];
  model: string;
  source: 'live' | 'fixture';
  latencyMs: number;
  /** images billed (usage.images_processed) */
  billed?: number;
  recordedFrom?: string;
  /** the raw output_text, kept for recording */
  text: string;
}

export interface SegmentOptions {
  signal?: AbortSignal;
  /** source image size (needed only for fixture bookkeeping and box prompts) */
  width?: number;
  height?: number;
  label?: string;
}

export interface Sam {
  readonly mode: 'live' | 'fixture';
  /** One noun phrase on one JPEG (base64, no data: prefix). */
  segment(prompt: string, jpegBase64: string, opts?: SegmentOptions): Promise<SamResult>;
  /** Several prompts on the same frame, in parallel. Failed prompts come back with an empty record list and `error`. */
  segmentAll(prompts: string[], jpegBase64: string, opts?: SegmentOptions): Promise<(SamResult & { error?: string })[]>;
}

// --- output grammar -------------------------------------------------------------------------

const RECORD_RE = /(?:^<\d+f>|,)(\d+)<\|box;([^|]*)\|><\|mask;([^|]*)\|>/g;

function kv(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

/** Parse the special-token text of an image response (frame 0 only). Empty text = no matches (valid). */
export function parseSamText(text: string): SamRecord[] {
  const out: SamRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('<0f>') && !line.startsWith('<')) continue;
    for (const m of line.matchAll(RECORD_RE)) {
      const b = kv(m[2]);
      const mk = kv(m[3]);
      const rec: SamRecord = { id: Number(m[1]), x1: +b.x1, y1: +b.y1, x2: +b.x2, y2: +b.y2, w: +b.w, h: +b.h };
      if (b.c !== undefined) rec.confidence = Number(b.c);
      const data = mk.data;
      if (data) {
        const first = data.indexOf(',');
        const second = data.indexOf(',', first + 1);
        if (first > 0 && second > first) {
          const height = Number(data.slice(0, first));
          const width = Number(data.slice(first + 1, second));
          const enc = data[second + 1];
          const payload = data.slice(second + 2);
          if (Number.isFinite(width) && Number.isFinite(height) && (enc === '!' || enc === '~')) {
            rec.mask = { encoding: enc === '!' ? 'one_bit' : 'lossless', payload, width, height };
          }
        }
      }
      if ([rec.x1, rec.y1, rec.x2, rec.y2, rec.w, rec.h].every(Number.isFinite)) out.push(rec);
    }
  }
  return out;
}

/** Decode a record's mask to a 0/1 raster (row-major, width x height, at the box's top-left). Null when absent or malformed. */
export function decodeMask(rec: SamRecord): Uint8Array | null {
  if (!rec.mask) return null;
  try {
    return decodeMaskToRaster(rec.mask);
  } catch {
    return null;
  }
}

/** Build the one-concept request body. */
export function samBody(prompt: string, imageDataUrl: string): Record<string, unknown> {
  return {
    model: SAM_MODEL,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: imageDataUrl }] }],
    metadata: { include_confidence: 'true', mask_encoding: 'one_bit' },
  };
}

function outputText(json: any): string {
  const out = Array.isArray(json?.output) ? json.output : [];
  return out
    .flatMap((o: any) => (Array.isArray(o?.content) ? o.content : []))
    .filter((c: any) => c?.type === 'output_text' && typeof c.text === 'string')
    .map((c: any) => c.text)
    .join('\n');
}

// --- recordings -----------------------------------------------------------------------------

export interface RecordedSam {
  kind: 'sam';
  name: string;
  prompt: string;
  width: number;
  height: number;
  frameHash: string;
  model: string;
  recordedAt: string;
  latencyMs: number;
  billed?: number;
  text: string;
}

export function frameHash(jpegBase64: string): string {
  return createHash('sha256').update(jpegBase64).digest('hex').slice(0, 12);
}

export function samKey(prompt: string, width: number | undefined, height: number | undefined, hash: string): string {
  return `sam.${prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.${width ?? 0}x${height ?? 0}.${hash}`;
}

export function loadRecordedSam(dir: string | undefined): RecordedSam[] {
  if (!dir || !existsSync(dir)) return [];
  const out: RecordedSam[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    try {
      const r = JSON.parse(readFileSync(join(dir, f), 'utf8')) as RecordedSam;
      if (r?.kind === 'sam' && typeof r.text === 'string' && typeof r.prompt === 'string') out.push(r);
    } catch {
      // not a recording
    }
  }
  return out;
}

export function samRecorder(dir: string, log: (line: string) => void = () => {}): (rec: RecordedSam) => void {
  return (rec) => {
    try {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${rec.name}.json`);
      writeFileSync(`${file}.tmp`, `${JSON.stringify(rec, null, 2)}\n`);
      renameSync(`${file}.tmp`, file);
      log(`[sam] recorded ${rec.name}`);
    } catch (e) {
      log(`[sam] could not record: ${(e as Error).message}`);
    }
  };
}

// --- live -----------------------------------------------------------------------------------

export interface SamClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  callLog: CallLog;
  recorder?: (rec: RecordedSam) => void;
}

export class SamClient implements Sam {
  readonly mode = 'live' as const;
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly o: SamClientOptions) {
    if (!o.apiKey) throw new Error('SamClient needs MODEL_API_KEY');
    this.url = `${(o.baseUrl || 'https://api.meta.ai/v1').replace(/\/+$/, '')}/responses`;
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  async segment(prompt: string, jpegBase64: string, opts: SegmentOptions = {}): Promise<SamResult> {
    throwIfCancelled(opts.signal);
    const started = Date.now();
    const controller = new AbortController();
    const unlink = forwardCancellation(opts.signal, controller);
    const timer = setTimeout(() => controller.abort(), this.o.timeoutMs ?? SAM_TIMEOUT_MS);
    const label = opts.label ?? `sam:${prompt}`;
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.o.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(samBody(prompt, `data:image/jpeg;base64,${jpegBase64}`)),
          signal: controller.signal,
        });
      } catch (e) {
        if (opts.signal?.aborted) throw new RequestCancelledError();
        if (controller.signal.aborted) throw new ModelCallError(`SAM did not answer within ${Math.round((this.o.timeoutMs ?? SAM_TIMEOUT_MS) / 1000)}s`);
        throw new ModelCallError(`Could not reach the Meta Model API: ${(e as Error).message}`);
      }
      const bodyText = await res.text();
      if (!res.ok) throw new ModelCallError(`SAM HTTP ${res.status}: ${bodyText.slice(0, 300)}`, res.status);
      let json: any;
      try {
        json = JSON.parse(bodyText);
      } catch {
        throw new ModelCallError('SAM returned non-JSON');
      }
      const text = outputText(json);
      const records = parseSamText(text);
      const latencyMs = Date.now() - started;
      const billed = typeof json?.usage?.images_processed === 'number' ? json.usage.images_processed : undefined;
      const model = typeof json?.model === 'string' ? json.model : SAM_MODEL;
      this.o.callLog.add({ at: started, label, model, source: 'live', ok: true, latencyMs, format: 'segmentation', finishReason: `${records.length} objects` });
      if (this.o.recorder) {
        const hash = frameHash(jpegBase64);
        this.o.recorder({ kind: 'sam', name: samKey(prompt, opts.width, opts.height, hash), prompt, width: opts.width ?? 0, height: opts.height ?? 0, frameHash: hash, model, recordedAt: new Date().toISOString(), latencyMs, billed, text });
      }
      return { prompt, records, model, source: 'live', latencyMs, billed, text };
    } catch (e) {
      if (!(e instanceof RequestCancelledError)) {
        this.o.callLog.add({ at: started, label, model: SAM_MODEL, source: 'live', ok: false, latencyMs: Date.now() - started, error: (e as Error).message });
      }
      throw e;
    } finally {
      clearTimeout(timer);
      unlink();
    }
  }

  segmentAll(prompts: string[], jpegBase64: string, opts: SegmentOptions = {}): Promise<(SamResult & { error?: string })[]> {
    return segmentAllWith(this, prompts, jpegBase64, opts);
  }
}

async function segmentAllWith(sam: Sam, prompts: string[], jpegBase64: string, opts: SegmentOptions): Promise<(SamResult & { error?: string })[]> {
  return Promise.all(
    prompts.map(async (prompt) => {
      const started = Date.now();
      try {
        return await sam.segment(prompt, jpegBase64, opts);
      } catch (e) {
        if (e instanceof RequestCancelledError) throw e;
        return { prompt, records: [], model: SAM_MODEL, source: sam.mode, latencyMs: Date.now() - started, text: '', error: (e as Error).message };
      }
    }),
  );
}

// --- fixture --------------------------------------------------------------------------------

/**
 * Canned FIXTURE detections for the sim's 1280x960 room when there is no recording: a ceiling light at the
 * top centre and a synth on the desk. Boxes only (no masks), so the oracle falls back to the box polygon.
 */
export function cannedSamText(prompt: string, width: number, height: number): string {
  const W = width || 1280;
  const H = height || 960;
  const box = (x1: number, y1: number, x2: number, y2: number, c: number, id: number) =>
    `${id}<|box;x1=${Math.round(x1 * W)};y1=${Math.round(y1 * H)};x2=${Math.round(x2 * W)};y2=${Math.round(y2 * H)};w=${W};h=${H};c=${c}|><|mask;x=0;y=0;c=${c};data=0,0,!|>`;
  const p = prompt.toLowerCase();
  if (p.includes('ceiling light') || p.includes('lamp')) return `<0f>${box(0.38, 0.04, 0.62, 0.22, 0.9, 0)}`;
  if (p.includes('synth') || p.includes('keyboard')) return `<0f>${box(0.3, 0.62, 0.62, 0.84, 0.9, 1)}`;
  if (p.includes('electronic device')) return `<0f>${box(0.3, 0.62, 0.62, 0.84, 0.86, 1)},${box(0.7, 0.6, 0.9, 0.8, 0.8, 2)}`;
  return '';
}

export interface FixtureSamOptions {
  recorded?: RecordedSam[];
  delayMs?: number;
  callLog: CallLog;
}

export class FixtureSam implements Sam {
  readonly mode = 'fixture' as const;
  private readonly byName = new Map<string, RecordedSam>();
  private readonly byPrompt = new Map<string, RecordedSam[]>();

  constructor(private readonly o: FixtureSamOptions) {
    for (const r of o.recorded ?? []) {
      this.byName.set(r.name, r);
      const list = this.byPrompt.get(r.prompt.toLowerCase()) ?? [];
      list.push(r);
      this.byPrompt.set(r.prompt.toLowerCase(), list);
    }
  }

  recordedKeys(): string[] {
    return [...this.byName.keys()];
  }

  async segment(prompt: string, jpegBase64: string, opts: SegmentOptions = {}): Promise<SamResult> {
    throwIfCancelled(opts.signal);
    const started = Date.now();
    if (this.o.delayMs) await cancellableDelay(this.o.delayMs, opts.signal);
    const hash = frameHash(jpegBase64);
    const exact = this.byName.get(samKey(prompt, opts.width, opts.height, hash));
    const sameSize = this.byPrompt.get(prompt.toLowerCase())?.filter((r) => !opts.width || (r.width === opts.width && r.height === opts.height));
    const rec = exact ?? sameSize?.at(-1) ?? this.byPrompt.get(prompt.toLowerCase())?.at(-1);
    const text = rec ? rec.text : cannedSamText(prompt, opts.width ?? 0, opts.height ?? 0);
    const records = parseSamText(text).filter((r) => !rec || r.mask?.payload); // canned rows have empty masks; keep them (box only)
    const latencyMs = Date.now() - started;
    this.o.callLog.add({ at: started, label: opts.label ?? `sam:${prompt}`, model: 'fixture', source: 'fixture', ok: true, latencyMs, format: 'segmentation', recordedFrom: rec?.model, finishReason: `${records.length} objects` });
    return { prompt, records: rec ? records : parseSamText(text), model: 'fixture', source: 'fixture', latencyMs, text, recordedFrom: rec?.model };
  }

  segmentAll(prompts: string[], jpegBase64: string, opts: SegmentOptions = {}): Promise<(SamResult & { error?: string })[]> {
    return segmentAllWith(this, prompts, jpegBase64, opts);
  }
}

export function createSam(cfg: MuseConfig, deps: { callLog: CallLog; fetchImpl?: typeof fetch; log?: (line: string) => void }): Sam {
  if (cfg.mode === 'live') {
    return new SamClient({
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      fetchImpl: deps.fetchImpl,
      callLog: deps.callLog,
      recorder: cfg.recordDir ? samRecorder(join(cfg.recordDir, 'sam'), deps.log) : undefined,
    });
  }
  return new FixtureSam({ recorded: loadRecordedSam(cfg.replayDir ? join(cfg.replayDir, 'sam') : undefined), delayMs: cfg.fixtureDelayMs, callLog: deps.callLog });
}
