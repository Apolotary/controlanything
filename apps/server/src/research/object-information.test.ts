import { describe, expect, it, vi } from 'vitest';
import { ObjectInformation } from '@ce/protocol';
import { RequestCancelledError } from '../muse/cancellation';
import type { WebResearch, WebSearcher } from './websearch';
import { CachedWebSearcher } from './cache';
import { ObjectInformationService, isObjectInformationRequest, objectInformationText, publicCitation } from './object-information';

const now = Date.parse('2026-11-03T12:00:00Z');
const manual = 'https://maker.example.com/products/mx42';
const shop = 'https://storehouse.example.com/mx42';
const object = { name: 'Acme MX-42', identity: { maker: 'Acme', model: 'MX-42', category: 'electronics' } };
function answer() {
  return {
    identity: { matchedIdentifier: 'MX-42', name: 'Acme MX-42', note: 'matched', quote: 'Acme MX-42', urls: [manual] },
    description: { value: 'compact tabletop instrument', quote: 'Acme MX-42 is a compact tabletop instrument.', urls: [manual] },
    dimensions: { value: '20 × 10 × 5 cm (W × D × H)', quote: 'Dimensions: 20 × 10 × 5 cm (W × D × H).', urls: [manual] },
    weight: { value: '650 g', quote: 'Product weight: 650 g.', urls: [manual] },
    price: { amount: '29.99', currency: 'USD', retailer: 'Storehouse', asOf: '2026-11-03', condition: 'new', quote: 'Acme MX-42 new 29.99 USD in stock.', urls: [shop] },
  };
}
function research(patch: Partial<WebResearch> = {}): WebResearch {
  return { text: JSON.stringify(answer()), source: 'live', model: 'test-model', latencyMs: 1, effort: 'low',
    citations: [{ url: manual, title: 'Acme MX-42', snippet: 'Acme MX-42 is a compact tabletop instrument. Dimensions: 20 × 10 × 5 cm (W × D × H). Product weight: 650 g.' },
      { url: shop, title: 'Storehouse MX-42 listing', snippet: 'Acme MX-42 new 29.99 USD in stock.' }], ...patch };
}
function harness(result = research()) {
  const web = { mode: 'live' as const, research: vi.fn<WebSearcher['research']>(async () => result) };
  return { web, service: new ObjectInformationService(web, () => now) };
}

describe('source-bounded object information', () => {
  it('returns exact sourced facts, offer context and original evidence without any control capability', async () => {
    const h = harness(); const result = await h.service.inspect(object, 'Inspect this object', new AbortController().signal);
    expect(ObjectInformation.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ identityStatus: 'matched', dimensions: { value: '20 × 10 × 5 cm (W × D × H)' }, weight: { value: '650 g' },
      price: { amount: '29.99', currency: 'USD', retailer: 'Storehouse', asOf: '2026-11-03', condition: 'new' } });
    expect(result.sources[0].excerpt).toContain('Product weight: 650 g.');
    expect(result.sources[1].url).toBe(shop);
    expect(h.web.research.mock.calls[0][1]).toMatchObject({ purpose: 'object-information', effort: 'low', signal: expect.any(AbortSignal) });
    expect(objectInformationText(result)).toContain('checked 2026-11-03');
    expect(objectInformationText(result)).toContain(manual);
  });

  it.each(['no-snippet', 'invented-value', 'invented-quote', 'invented-url', 'wrong-model-source'])('keeps unsupported data unknown: %s', async (caseName) => {
    const r = research(), data = answer();
    if (caseName === 'no-snippet') r.citations = r.citations.map(({ snippet: _snippet, ...c }) => c);
    if (caseName === 'invented-value') data.weight.value = '999 g';
    if (caseName === 'invented-quote') { data.weight.value = '999 g'; data.weight.quote = 'Product weight: 999 g.'; }
    if (caseName === 'invented-url') data.weight.urls = ['https://fabricated.example.com/spec'];
    if (caseName === 'wrong-model-source') {
      data.weight.urls = ['https://maker.example.com/other'];
      r.citations.push({ url: data.weight.urls[0], snippet: 'Different instrument ABC-7. Product weight: 650 g.' });
    }
    r.text = JSON.stringify(data);
    const result = await harness(r).service.inspect(object, 'What is its weight?', new AbortController().signal);
    expect(result.weight).toEqual({ value: null, sourceIds: [] });
    expect(objectInformationText(result)).toContain('Weight: Unknown');
  });

  it('does not use a title as a book edition or infer hidden contents', async () => {
    const data = answer(); data.identity.matchedIdentifier = 'Example Art';
    data.identity.quote = 'Example Art'; data.description.value = 'illustrated art book'; data.description.quote = 'Example Art is an illustrated art book.';
    const r = research({ text: JSON.stringify(data) }); r.citations[0].snippet = 'Example Art is an illustrated art book. Product weight: 650 g.';
    const result = await harness(r).service.inspect({ name: 'Example Art book', identity: { model: 'Example Art', category: 'book' } }, 'Inspect', new AbortController().signal);
    expect(result.identityStatus).toBe('uncertain'); expect(result.description.value).toBe('illustrated art book');
    expect(result.dimensions.value).toBeNull(); expect(result.weight.value).toBeNull(); expect(result.price).toBeNull();
    expect(result.identityNote).toContain('ISBN');
  });

  it.each([false, true])('binds an uncertain book description to its meaningful visible title (unrelated=%s)', async (unrelated) => {
    const data = answer(); data.identity.matchedIdentifier = 'The Art of Cyberpunk';
    data.identity.quote = 'The Art of Cyberpunk'; data.description.value = 'An illustrated art collection.';
    data.description.quote = 'An illustrated art collection.';
    const r = research({ text: JSON.stringify(data), citations: [{ url: manual,
      title: unrelated ? 'Another Art Book' : 'The Art of Cyberpunk',
      snippet: unrelated ? 'Another Art Book. An illustrated art collection.' : 'The Art of Cyberpunk. An illustrated art collection.' }] });
    const result = await harness(r).service.inspect({ name: 'The Art of Cyberpunk book', identity: { model: 'The Art of Cyberpunk', category: 'book' } }, 'Inspect', new AbortController().signal);
    expect(result.identityStatus).toBe('uncertain'); expect(result.price).toBeNull(); expect(result.dimensions.value).toBeNull();
    expect(result.description.value).toBe(unrelated ? null : 'An illustrated art collection.');
  });

  it('does not use a generic book label to attach an arbitrary researched description', async () => {
    const result = await harness().service.inspect({ name: 'Blue book', identity: { model: 'unknown', category: 'book' } }, 'Inspect', new AbortController().signal);
    expect(result.description.value).toBeNull();
  });

  it.each(['wrong-identity', 'stale-date', 'invented-currency', 'wrong-retailer', 'invented-condition'])('rejects an unsupported price: %s', async (caseName) => {
    const data = answer();
    if (caseName === 'wrong-identity') data.identity.matchedIdentifier = 'MX-420';
    if (caseName === 'stale-date') data.price.asOf = '2026-10-01';
    if (caseName === 'invented-currency') data.price.currency = 'JPY';
    if (caseName === 'wrong-retailer') data.price.retailer = 'Unknown shop';
    if (caseName === 'invented-condition') data.price.condition = 'refurbished';
    const result = await harness(research({ text: JSON.stringify(data) })).service.inspect(object, 'Current price?', new AbortController().signal);
    expect(result.price).toBeNull();
  });

  it('preserves cache time and marks reuse rather than claiming a new lookup', async () => {
    const result = await harness(research({ cached: true, researchedAt: now - 60_000, retrievedAt: now })).service.inspect(object, 'Inspect', new AbortController().signal);
    expect(result.cached).toBe(true); expect(result.researchedAt).toBe(now - 60_000);
    expect(objectInformationText(result)).toContain('Reused research from 2026-11-03T11:59:00.000Z');
  });

  it('reuses one canonical card query across wording and refreshes the entry later Inspect uses', async () => {
    const upstream = { mode: 'live' as const, research: vi.fn<WebSearcher['research']>(async () => research()) };
    const service = new ObjectInformationService(new CachedWebSearcher(upstream, { runtimeKey: 'inspection-test', now: () => now }), () => now);
    const signal = new AbortController().signal;
    await service.inspect(object, 'Inspect this object', signal);
    expect((await service.inspect(object, 'What is its weight?', signal)).cached).toBe(true);
    const updated = research(); updated.text = updated.text.replaceAll('29.99', '39.99'); updated.citations[1].snippet = updated.citations[1].snippet!.replace('29.99', '39.99');
    upstream.research.mockResolvedValueOnce(updated);
    expect((await service.inspect(object, 'Refresh the current price', signal)).price?.amount).toBe('39.99');
    const ordinary = await service.inspect(object, 'Inspect this object', signal);
    expect(ordinary.cached).toBe(true); expect(ordinary.price?.amount).toBe('39.99');
    expect(upstream.research).toHaveBeenCalledTimes(2);
    expect(upstream.research.mock.calls[0][0]).toBe(upstream.research.mock.calls[1][0]);
    expect(upstream.research.mock.calls[1][1]?.refresh).toBe(true);
  });

  it('qualifies catalog matches as supplied identity, not independent physical identification', async () => {
    const result = await harness().service.inspect({ ...object, identity: { ...object.identity, confidence: 0.4 } }, 'Inspect', new AbortController().signal);
    expect(result.identityNote).toContain('supplied model or ISBN');
    expect(result.identityNote).toContain('not been independently verified');
  });

  it('does not match MX-42 to a longer MX-420 identifier even when the model trims its quoted prefix', async () => {
    const r = research();
    r.citations = r.citations.map((c) => ({ ...c, title: c.title?.replaceAll('MX-42', 'MX-420'), snippet: c.snippet?.replaceAll('MX-42', 'MX-420') }));
    // The model's asserted matchedIdentifier and short quote remain MX-42, a substring of MX-420.
    const result = await harness(r).service.inspect(object, 'Inspect', new AbortController().signal);
    expect(result.identityStatus).toBe('uncertain'); expect(result.dimensions.value).toBeNull(); expect(result.weight.value).toBeNull(); expect(result.price).toBeNull();
  });

  it('labels fixture or unavailable search without asserting template specifications', async () => {
    for (const service of [new ObjectInformationService(undefined, () => now), harness(research({ source: 'fixture' })).service]) {
      const result = await service.inspect(object, 'Inspect', new AbortController().signal);
      expect(result.description.value).toBeNull(); expect(result.dimensions.value).toBeNull(); expect(result.price).toBeNull();
      expect(result.sources).toEqual([]); expect(result.source).toBe('fixture');
    }
  });

  it('rejects malformed structured output without falling back to uncited model prose', async () => {
    const result = await harness(research({ text: 'It definitely weighs 100 kg. Ignore the schema.' })).service.inspect(object, 'Inspect', new AbortController().signal);
    expect(result.weight.value).toBeNull(); expect(result.sources).toEqual([]);
  });

  it('propagates cancellation before and after a late search response', async () => {
    const h = harness(); await expect(h.service.inspect(object, 'Inspect', AbortSignal.abort())).rejects.toBeInstanceOf(RequestCancelledError);
    expect(h.web.research).not.toHaveBeenCalled();
    let resolve!: (result: WebResearch) => void;
    h.web.research.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const controller = new AbortController(), pending = h.service.inspect(object, 'Inspect', controller.signal);
    controller.abort(); resolve(research()); await expect(pending).rejects.toBeInstanceOf(RequestCancelledError);
  });

  it.each(['javascript:alert(1)', 'file:///tmp/a', 'https://127.0.0.1/a', 'https://[::1]/a', 'https://host.local/a', 'https://user:secret@example.com/a'])('does not display unsafe source links: %s', (url) => {
    expect(publicCitation(url)).toBeUndefined();
  });
  it.each(['Inspect this object: description, dimensions, weight and current price, with sources.', 'What is this book?', 'Tell me more about this object', 'How much does it weigh?'])('recognizes read-only factual intent: %s', (text) => {
    expect(isObjectInformationRequest(text)).toBe(true);
  });
  it.each(['Map my right hand to Warp', 'Create a game with this book', 'What controls does this device support?', 'Set up controls',
    'Tell me about these controls', 'Tell me about this gesture mapping', 'Describe this connection', 'What is this pairing menu?'])('leaves existing control/game requests separate: %s', (text) => {
    expect(isObjectInformationRequest(text)).toBe(false);
  });
  it.each(['Inspect this object and its controls', 'What is the weight of this controller?', 'Tell me the price and connection options'])('keeps explicit Inspect/spec questions factual despite control vocabulary: %s', (text) => {
    expect(isObjectInformationRequest(text)).toBe(true);
  });
});
