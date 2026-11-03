import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallLog } from '../muse/callLog';
import { RequestCancelledError } from '../muse/cancellation';
import { resolveMuseConfig } from '../muse/config';
import { CachedWebSearcher, OBJECT_RESEARCH_CACHE_TTL_MS, WEB_RESEARCH_CACHE_MAX_BYTES, WEB_RESEARCH_CACHE_MAX_ENTRIES, WEB_RESEARCH_CACHE_TTL_MS } from './cache';
import { createWebSearcher, type WebResearch, type WebResearchOptions, type WebSearcher } from './websearch';

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function file() { const dir = mkdtempSync(join(tmpdir(), 'ce-research-cache-')); folders.push(dir); return join(dir, 'research-cache.json'); }
const good = (): WebResearch => ({ text: '  Cutoff is CC74, range 0–127.\n', citations: [{ url: 'https://manual.example/synth', title: 'Synth manual' }],
  model: 'model-response-version', source: 'live', latencyMs: 83, effort: 'low' });
function upstream(mode: 'live' | 'fixture' = 'live') {
  return { mode, research: vi.fn(async (_question: string, _opts?: WebResearchOptions): Promise<WebResearch> => good()) };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

describe('device web research cache', () => {
  it('reuses normalized exact questions, preserves provenance, and protects stored data from caller mutation', async () => {
    let now = 1000; const source = upstream();
    const cache = new CachedWebSearcher(source, { runtimeKey: 'model@runtime', now: () => now });
    const fresh = await cache.research(' Synth\n cutoff   CC? ');
    expect(fresh).toEqual({ ...good(), researchedAt: 1000 }); expect(fresh.cached).toBeUndefined();
    fresh.citations[0].url = 'https://caller.invalid/changed';
    now = 2000;
    const hit = await cache.research('Synth cutoff CC?');
    expect(hit).toEqual({ ...good(), cached: true, researchedAt: 1000, retrievedAt: 2000 });
    hit.citations[0].title = 'Changed';
    expect((await cache.research('Synth cutoff CC?')).citations[0].title).toBe('Synth manual');
    expect(source.research).toHaveBeenCalledTimes(1);
    await cache.research('Synth cutoff CC!'); await cache.research('synth cutoff CC?');
    expect(source.research).toHaveBeenCalledTimes(3); // No semantic or case-folded device match.
  });

  it('persists atomically and reuses after restart without another model call', async () => {
    const cacheFile = file(); const first = upstream();
    await new CachedWebSearcher(first, { runtimeKey: 'one', cacheFile, now: () => 1000 }).research('q');
    const source = upstream();
    const result = await new CachedWebSearcher(source, { runtimeKey: 'one', cacheFile, now: () => 2000 }).research('q');
    expect(source.research).not.toHaveBeenCalled(); expect(result).toEqual({ ...good(), cached: true, researchedAt: 1000, retrievedAt: 2000 });
    expect(readdirSync(join(cacheFile, '..'))).toEqual(['research-cache.json']);
    expect(readFileSync(cacheFile, 'utf8')).not.toContain('cached');
  });

  it('expires at seven days; hits never extend the original research date', async () => {
    const cacheFile = file(); let now = 1000; const source = upstream();
    const cache = new CachedWebSearcher(source, { runtimeKey: 'one', cacheFile, now: () => now });
    await cache.research('q'); now += WEB_RESEARCH_CACHE_TTL_MS - 1;
    expect((await cache.research('q')).cached).toBe(true); expect(source.research).toHaveBeenCalledTimes(1);
    now++;
    expect((await new CachedWebSearcher(source, { runtimeKey: 'one', cacheFile, now: () => now }).research('q')).cached).toBeUndefined();
    expect(source.research).toHaveBeenCalledTimes(2);
  });

  it('separates runtime/model and effort and defaults omitted effort to low', async () => {
    const cacheFile = file(); const source = upstream();
    const old = new CachedWebSearcher(source, { runtimeKey: 'endpoint/model-v1', cacheFile });
    await old.research('q'); await old.research('q', { effort: 'low' }); await old.research('q', { effort: 'medium' });
    await new CachedWebSearcher(source, { runtimeKey: 'endpoint/model-v2', cacheFile }).research('q');
    await new CachedWebSearcher(source, { runtimeKey: 'different-endpoint/model-v2', cacheFile }).research('q');
    expect(source.research).toHaveBeenCalledTimes(4);
  });

  it.each(['broken JSON', JSON.stringify({ version: 99, entries: [] }), JSON.stringify({ version: 1, entries: [{ key: 'bad', result: good() }] })])(
    'ignores corrupt or unsupported cache data: %s', async (contents) => {
      const cacheFile = file(); writeFileSync(cacheFile, contents); const source = upstream();
      expect((await new CachedWebSearcher(source, { runtimeKey: 'one', cacheFile }).research('q')).cached).toBeUndefined();
      expect(source.research).toHaveBeenCalledTimes(1);
      expect(JSON.parse(readFileSync(cacheFile, 'utf8')).entries).toHaveLength(1);
    },
  );

  it('rejects poisoned citations, empty text, invalid dates, and oversized files during loading', async () => {
    const cacheFile = file(); const source = upstream();
    await new CachedWebSearcher(source, { runtimeKey: 'one', cacheFile, now: () => 1000 }).research('q');
    const saved = JSON.parse(readFileSync(cacheFile, 'utf8'));
    for (const mutate of [
      (entry: any) => { entry.result.citations[0].url = 'javascript:alert(1)'; },
      (entry: any) => { entry.result.text = ' '; },
      (entry: any) => { entry.researchedAt = 3000; },
      (entry: any) => { entry.researchedAt = -1; },
    ]) {
      const changed = structuredClone(saved); mutate(changed.entries[0]); writeFileSync(cacheFile, JSON.stringify(changed));
      expect((await new CachedWebSearcher(source, { runtimeKey: 'one', cacheFile, now: () => 2000 }).research('q')).cached).toBeUndefined();
    }
    writeFileSync(cacheFile, ' '.repeat(WEB_RESEARCH_CACHE_MAX_BYTES + 1));
    expect((await new CachedWebSearcher(source, { runtimeKey: 'one', cacheFile }).research('q')).cached).toBeUndefined();
    expect(source.research).toHaveBeenCalledTimes(6);
  });

  it.each([
    { text: '' }, { text: '  \n' }, { citations: [] }, { citations: [{ url: 'file:///manual' }] },
    { citations: [{ url: 'not a URL' }] }, { text: 'Not found.' }, { text: 'No search results found.' },
    { text: 'I could not find any documentation.' }, { source: 'fixture' as const }, { cached: true as const },
  ])('never caches empty, unsuccessful, fixture, or uncited results: %j', async (patch) => {
    const source = upstream(); source.research.mockResolvedValue({ ...good(), ...patch });
    const cache = new CachedWebSearcher(source, { runtimeKey: 'one', cacheFile: file() });
    await cache.research('q'); await cache.research('q'); expect(source.research).toHaveBeenCalledTimes(2);
  });

  it('does not cache failures or resurrect a prior entry after failed refresh, including after restart', async () => {
    const source = upstream(), cacheFile = file(); const cache = new CachedWebSearcher(source, { runtimeKey: 'one', cacheFile });
    source.research.mockRejectedValueOnce(new Error('network failure'));
    await expect(cache.research('q')).rejects.toThrow('network failure');
    await cache.research('q');
    source.research.mockRejectedValueOnce(new Error('refresh failure'));
    await expect(cache.research('q', { refresh: true })).rejects.toThrow('refresh failure');
    expect(JSON.parse(readFileSync(cacheFile, 'utf8')).entries).toHaveLength(0);
    expect((await new CachedWebSearcher(source, { runtimeKey: 'one', cacheFile }).research('q')).cached).toBeUndefined();
    expect(source.research).toHaveBeenCalledTimes(4);
  });

  it('evicts previous research when refresh returns no results', async () => {
    const source = upstream(), cacheFile = file(); const cache = new CachedWebSearcher(source, { runtimeKey: 'one', cacheFile });
    await cache.research('q'); source.research.mockResolvedValueOnce({ ...good(), text: 'Not found.', citations: [] });
    await cache.research('q', { refresh: true });
    expect(JSON.parse(readFileSync(cacheFile, 'utf8')).entries).toHaveLength(0);
    expect((await cache.research('q')).cached).toBeUndefined(); expect(source.research).toHaveBeenCalledTimes(3);
  });

  it('refresh bypasses and replaces the exact entry with its new research timestamp', async () => {
    let now = 1000; const source = upstream(); const cache = new CachedWebSearcher(source, { runtimeKey: 'one', now: () => now });
    await cache.research('q'); now = 2000;
    source.research.mockResolvedValueOnce({ ...good(), text: 'Updated manual: CC71.' });
    const fresh = await cache.research('q', { refresh: true });
    expect(fresh.cached).toBeUndefined(); expect(fresh.researchedAt).toBe(2000);
    const cached = await cache.research('q'); expect(cached.text).toBe(fresh.text); expect(cached.researchedAt).toBe(2000);
    expect(source.research).toHaveBeenLastCalledWith('q', { refresh: true }); expect(source.research).toHaveBeenCalledTimes(2);
  });

  it('checks aborted calls before cache hits and never publishes a result after the caller cancels', async () => {
    const cacheFile = file(); const source = upstream(); const cache = new CachedWebSearcher(source, { runtimeKey: 'one', cacheFile });
    await cache.research('hit'); const saved = readFileSync(cacheFile, 'utf8');
    const aborted = AbortSignal.abort();
    await expect(cache.research('hit', { signal: aborted })).rejects.toBeInstanceOf(RequestCancelledError);
    await expect(cache.research('new', { signal: aborted })).rejects.toBeInstanceOf(RequestCancelledError);
    expect(source.research).toHaveBeenCalledTimes(1);
    const pending = deferred<WebResearch>(); source.research.mockReturnValueOnce(pending.promise);
    const controller = new AbortController(); const result = cache.research('cancelled', { signal: controller.signal });
    controller.abort(); pending.resolve(good());
    await expect(result).rejects.toBeInstanceOf(RequestCancelledError);
    expect(readFileSync(cacheFile, 'utf8')).toBe(saved);
    expect((await cache.research('cancelled')).cached).toBeUndefined();
  });

  it('isolates concurrent callers so cancelling one does not cancel or poison another', async () => {
    const first = deferred<WebResearch>(), second = deferred<WebResearch>(); const source = upstream();
    source.research.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const cache = new CachedWebSearcher(source, { runtimeKey: 'one' });
    const a = new AbortController(), b = new AbortController();
    const cancelled = cache.research('q', { signal: a.signal }), successful = cache.research('q', { signal: b.signal });
    a.abort(); expect(b.signal.aborted).toBe(false);
    second.resolve({ ...good(), text: 'Second caller result' }); await successful;
    first.resolve({ ...good(), text: 'Obsolete cancelled result' }); await expect(cancelled).rejects.toBeInstanceOf(RequestCancelledError);
    expect((await cache.research('q')).text).toBe('Second caller result'); expect(source.research).toHaveBeenCalledTimes(2);
  });

  it('bounds persisted size and entry count, evicting oldest research first', async () => {
    const cacheFile = file(); let now = 1000; const source = upstream();
    const cache = new CachedWebSearcher(source, { runtimeKey: 'one', cacheFile, now: () => now++ });
    for (let i = 0; i <= WEB_RESEARCH_CACHE_MAX_ENTRIES; i++) await cache.research(`q${i}`);
    expect(JSON.parse(readFileSync(cacheFile, 'utf8')).entries).toHaveLength(WEB_RESEARCH_CACHE_MAX_ENTRIES);
    expect((await cache.research('q0')).cached).toBeUndefined();
    source.research.mockResolvedValue({ ...good(), text: 'x'.repeat(100_000) });
    for (let i = 0; i < 45; i++) await cache.research(`large${i}`);
    expect(readFileSync(cacheFile).length).toBeLessThanOrEqual(WEB_RESEARCH_CACHE_MAX_BYTES);
    expect((await cache.research('large44')).cached).toBe(true);
  });

  it('continues with memory caching when persistence is unavailable', async () => {
    const parentFile = file(); writeFileSync(parentFile, 'not a directory'); const source = upstream();
    const cache = new CachedWebSearcher(source, { runtimeKey: 'one', cacheFile: join(parentFile, 'cache.json') });
    await cache.research('q'); expect((await cache.research('q')).cached).toBe(true); expect(source.research).toHaveBeenCalledTimes(1);
  });
});

describe('web search factory cache integration', () => {
  const liveConfig = () => resolveMuseConfig({ MODEL_MODE: 'live', MODEL_API_KEY: 'test-only-key', MUSE_MODEL: 'model-v1', MUSE_API_BASE: 'https://model.invalid/v1' });
  function response(extra = {}) { return new Response(JSON.stringify({ model: 'returned-model-v1', output: [{ type: 'message', content: [
    { type: 'output_text', text: good().text, annotations: [{ type: 'url_citation', ...good().citations[0] }] },
  ] }], ...extra })); }

  it('separates object-inspection instructions/cache and expires offers after one hour', async () => {
    let now = 1000; const source = upstream();
    const cache = new CachedWebSearcher(source, { runtimeKey: 'test', now: () => now });
    await cache.research('same'); await cache.research('same', { purpose: 'object-information' });
    expect(source.research).toHaveBeenCalledTimes(2);
    now += OBJECT_RESEARCH_CACHE_TTL_MS - 1;
    expect((await cache.research('same', { purpose: 'object-information' })).cached).toBe(true);
    now++;
    expect((await cache.research('same', { purpose: 'object-information' })).cached).toBeUndefined();
    expect((await cache.research('same')).cached).toBe(true);
    expect(source.research).toHaveBeenCalledTimes(3);
  });

  it('uses factual-object instructions and preserves actual search snippets across a cache hit', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response({ output: [
      { type: 'web_search_call', results: [{ url: good().citations[0].url, title: 'Actual source', snippet: 'Exact extracted page text.' }] },
      { type: 'message', content: [{ type: 'output_text', text: good().text, annotations: [{ type: 'url_citation', ...good().citations[0] }] }] },
    ] }));
    const search = createWebSearcher(liveConfig(), { fetchImpl, callLog: new CallLog(() => {}), cacheFile: file() });
    const first = await search.research('object', { purpose: 'object-information' });
    const cached = await search.research('object', { purpose: 'object-information' });
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body.instructions).toContain('ONE selected physical object');
    expect(first.citations[0].snippet).toBe('Exact extracted page text.');
    expect(cached.citations[0].snippet).toBe(first.citations[0].snippet); expect(cached.cached).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('serves restart hits without fetch or fake model-call log entries, invalidating changed models/endpoints', async () => {
    const cacheFile = file(), callLog = new CallLog(() => {});
    const fetchImpl = vi.fn<typeof fetch>(async () => response()); const cfg = liveConfig();
    await createWebSearcher(cfg, { cacheFile, callLog, fetchImpl }).research('q');
    expect((await createWebSearcher(cfg, { cacheFile, callLog, fetchImpl }).research('q')).cached).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(callLog.totals().calls).toBe(1);
    await createWebSearcher({ ...cfg, model: 'model-v2' }, { cacheFile, callLog, fetchImpl }).research('q');
    await createWebSearcher({ ...cfg, baseUrl: 'https://other.invalid/v1' }, { cacheFile, callLog, fetchImpl }).research('q');
    expect(fetchImpl).toHaveBeenCalledTimes(3); expect(callLog.totals().calls).toBe(3);
    expect(readFileSync(cacheFile, 'utf8')).not.toContain(cfg.apiKey);
  });

  it('keeps fixture results deterministic and outside persisted/live entries', async () => {
    const cacheFile = file(); const fetchImpl = vi.fn<typeof fetch>(async () => response()); const callLog = new CallLog(() => {});
    await createWebSearcher(liveConfig(), { cacheFile, callLog, fetchImpl }).research('q'); const saved = readFileSync(cacheFile, 'utf8');
    const fixture = createWebSearcher(resolveMuseConfig({ MODEL_MODE: 'fixture' }), { cacheFile, callLog, fetchImpl });
    expect((await fixture.research('q')).source).toBe('fixture'); expect((await fixture.research('q')).cached).toBeUndefined();
    expect(readFileSync(cacheFile, 'utf8')).toBe(saved); expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(fixture.research('q', { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(RequestCancelledError);
  });

  it.each([{ status: 'incomplete' }, { status: 'failed' }, { error: { message: 'tool failed' } }])(
    'does not cache failed API responses containing partial cited output: %j', async (extra) => {
      const fetchImpl = vi.fn<typeof fetch>(async () => response(extra));
      const cache = createWebSearcher(liveConfig(), { cacheFile: file(), callLog: new CallLog(() => {}), fetchImpl });
      await expect(cache.research('q')).rejects.toThrow('did not complete');
      await expect(cache.research('q')).rejects.toThrow('did not complete'); expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );

  it('discards a response body arriving after abort without recording a successful model call', async () => {
    const controller = new AbortController(); const body = deferred<string>();
    const fetchImpl = vi.fn<typeof fetch>(async () => ({ ok: true, text: () => body.promise }) as Response);
    const callLog = new CallLog(() => {}), cache = createWebSearcher(liveConfig(), { callLog, fetchImpl, cacheFile: file() });
    const pending = cache.research('q', { signal: controller.signal }); await Promise.resolve(); controller.abort();
    body.resolve(await response().text()); await expect(pending).rejects.toBeInstanceOf(RequestCancelledError);
    expect(callLog.totals().calls).toBe(0);
  });
});
