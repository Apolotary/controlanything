import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { throwIfCancelled } from '../muse/cancellation';
import type { WebResearch, WebResearchOptions, WebSearcher } from './websearch';

/** Device documentation is reused for seven days; refresh invalidates the old entry before searching. */
export const WEB_RESEARCH_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Object offers are short-lived; their original lookup timestamp is preserved. */
export const OBJECT_RESEARCH_CACHE_TTL_MS = 60 * 60 * 1000;
export const WEB_RESEARCH_CACHE_MAX_ENTRIES = 128;
export const WEB_RESEARCH_CACHE_MAX_BYTES = 4 * 1024 * 1024;

function httpUrl(value: string): boolean {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !!url.hostname; }
  catch { return false; }
}

const Research = z.object({
  text: z.string().min(1).max(100_000).refine((text) => !!text.trim()),
  citations: z.array(z.object({ url: z.string().max(4096).refine(httpUrl), title: z.string().max(2000).optional(), snippet: z.string().max(12_000).optional() }).strict()).min(1).max(12),
  model: z.string().min(1).max(256), source: z.literal('live'),
  latencyMs: z.number().finite().nonnegative(), effort: z.string().min(1).max(64),
}).strict();
const Entry = z.object({ key: z.string().regex(/^[a-f0-9]{64}$/), researchedAt: z.number().int().nonnegative(), result: Research }).strict();
const CacheFile = z.object({ version: z.literal(1), entries: z.array(z.unknown()).max(WEB_RESEARCH_CACHE_MAX_ENTRIES) }).strict();
type Entry = z.infer<typeof Entry>;

function cacheable(result: WebResearch): Entry['result'] | undefined {
  if (result.cached) return undefined;
  const { text, citations, model, source, latencyMs, effort } = result;
  const parsed = Research.safeParse({ text, citations, model, source, latencyMs, effort });
  if (!parsed.success) return undefined;
  // An unsuccessful lookup can still cite a search page. Never turn that into durable knowledge.
  if (/^\s*(?:\[[^\]]*\]\s*)?(?:not found|nothing found|no (?:search )?results|(?:i (?:could not|couldn't|cannot|can't)|could not|unable to) (?:find|locate))\b/i.test(text)) return undefined;
  // Validation must not normalize the research text or remove its provenance.
  return { text, citations: citations.map((citation) => ({ ...citation })), model, source: 'live', latencyMs, effort };
}

/**
 * Exact-question reuse, not semantic retrieval. Only whitespace is normalized; case and punctuation
 * remain significant. runtimeKey identifies the endpoint, model, and research instructions; effort
 * is keyed separately. Without cacheFile, entries live only in this instance's memory.
 *
 * Calls in flight are deliberately independent: aborting one device's setup cannot cancel another.
 * Bounded synchronous disk transactions keep cancellation checks and publication in one turn.
 * Disk errors degrade to memory caching; a corrupt/old file is treated as an empty cache.
 */
export class CachedWebSearcher implements WebSearcher {
  readonly mode: WebSearcher['mode'];
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  constructor(private readonly underlying: WebSearcher, private readonly o: {
    runtimeKey: string; cacheFile?: string; now?: () => number;
  }) {
    this.mode = underlying.mode;
    this.now = o.now ?? Date.now;
    if (this.mode === 'live' && o.cacheFile) this.load(o.cacheFile);
  }

  async research(question: string, opts: WebResearchOptions = {}): Promise<WebResearch> {
    throwIfCancelled(opts.signal);
    if (this.mode !== 'live') {
      const result = await this.underlying.research(question, opts);
      throwIfCancelled(opts.signal);
      return result;
    }
    const key = createHash('sha256').update(JSON.stringify([
      this.o.runtimeKey, opts.purpose ?? 'device-control', opts.effort ?? 'low', question.trim().replace(/\s+/gu, ' '),
    ])).digest('hex');
    this.expire();
    // Explicit refresh abandons old knowledge even if the new lookup fails or finds nothing.
    // Persist this invalidation now so a restart cannot resurrect a rejected cached result.
    if (opts.refresh && this.entries.delete(key)) this.persist();
    let cached = !opts.refresh && this.entries.get(key);
    if (cached && opts.purpose === 'object-information' && this.now() - cached.researchedAt >= OBJECT_RESEARCH_CACHE_TTL_MS) {
      this.entries.delete(key); this.persist(); cached = false;
    }
    if (cached) {
      throwIfCancelled(opts.signal);
      return { ...structuredClone(cached.result), cached: true, researchedAt: cached.researchedAt, retrievedAt: this.now() };
    }
    const result = await this.underlying.research(question, opts);
    throwIfCancelled(opts.signal);
    const researchedAt = this.now();
    const valid = cacheable(result);
    if (valid) {
      this.entries.delete(key);
      this.entries.set(key, { key, researchedAt, result: valid });
      this.persist();
    }
    // The original model, source, citations, and call latency remain the provenance of this result.
    return result.source === 'live' && !result.cached ? { ...result, researchedAt } : result;
  }

  private expire(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.researchedAt > now || now - entry.researchedAt >= WEB_RESEARCH_CACHE_TTL_MS) this.entries.delete(key);
    }
  }

  private load(file: string): void {
    let fd: number | undefined;
    try {
      fd = openSync(file, 'r');
      // Never read an arbitrarily large or concurrently growing file into memory.
      const buffer = Buffer.alloc(WEB_RESEARCH_CACHE_MAX_BYTES + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
        if (!count) break;
        bytes += count;
      }
      if (bytes > WEB_RESEARCH_CACHE_MAX_BYTES) return;
      const parsed = CacheFile.safeParse(JSON.parse(buffer.toString('utf8', 0, bytes)));
      if (!parsed.success) return;
      const valid: Entry[] = [];
      for (const value of parsed.data.entries) {
        const entry = Entry.safeParse(value);
        if (entry.success && cacheable(entry.data.result)) valid.push(entry.data);
      }
      for (const entry of valid.sort((a, b) => a.researchedAt - b.researchedAt)) this.entries.set(entry.key, entry);
      this.expire();
    } catch { /* Missing, corrupt, or inaccessible cache never prevents research. */ }
    finally { if (fd !== undefined) closeSync(fd); }
  }

  private persist(): void {
    this.expire();
    while (this.entries.size > WEB_RESEARCH_CACHE_MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
    let bytes = JSON.stringify({ version: 1, entries: [...this.entries.values()] });
    while (Buffer.byteLength(bytes) > WEB_RESEARCH_CACHE_MAX_BYTES && this.entries.size) {
      this.entries.delete(this.entries.keys().next().value!);
      bytes = JSON.stringify({ version: 1, entries: [...this.entries.values()] });
    }
    if (!this.o.cacheFile) return;
    const temporary = `${this.o.cacheFile}.tmp-${process.pid}-${randomUUID()}`;
    try {
      mkdirSync(dirname(this.o.cacheFile), { recursive: true });
      writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.o.cacheFile);
    } catch { /* Keep the last atomic file and this process's bounded memory cache. */ }
    finally { try { rmSync(temporary, { force: true }); } catch { /* Best-effort temporary cleanup. */ } }
  }
}
