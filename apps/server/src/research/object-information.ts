/** Source-bounded object inspection. No page fetching, commands, identification mutation or model-planning side effects. */
import { isIP } from 'node:net';
import { z } from 'zod';
import type { ObjectInformation } from '@ce/protocol';
import { throwIfCancelled } from '../muse/cancellation';
import type { WebResearch, WebSearcher } from './websearch';

export interface ObjectIdentity {
  maker?: string; model?: string; category?: string; confidence?: number;
  visibleText?: string[]; evidence?: string[]; notes?: string;
}
export interface InspectableObject { name: string; identity?: ObjectIdentity }
const Urls = z.array(z.string().max(1000)).max(3);
const Fact = z.object({ value: z.string().max(500).nullable(), quote: z.string().max(1000).nullable(), urls: Urls });
const ResearchAnswer = z.object({
  identity: z.object({ matchedIdentifier: z.string().max(200).nullable(), name: z.string().max(200), note: z.string().max(400), quote: z.string().max(1000).nullable(), urls: Urls }),
  description: Fact, dimensions: Fact, weight: Fact,
  price: z.object({ amount: z.string().max(60), currency: z.string().regex(/^[A-Z]{3}$/), retailer: z.string().min(1).max(160),
    asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), condition: z.string().min(1).max(160), quote: z.string().max(1000), urls: Urls }).nullable(),
});
const normal = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const quoted = (s: string) => s.replace(/\s+/gu, ' ').trim();
const known = (s?: string) => !!s?.trim() && !/^(unknown|none|generic|n\/a|unspecified)$/i.test(s.trim());
/** Permit printed separators (including ISBN hyphens), never a longer alphanumeric model prefix. */
function containsIdentifier(text: string, identifier: string): boolean {
  const atoms = identifier.match(/\p{L}+|\p{N}/gu);
  if (!atoms?.length) return false;
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${atoms.join('[^\\p{L}\\p{N}]*')}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(text);
}
const genericWords = new Set('a an the of for and or in on by with this that it its my your selected visible unknown generic unidentified unbranded unspecified object device item book publication instrument electronics keyboard laptop computer external wired wireless compact backlit usb ready cover blue red green black white small large'.split(' '));

/** Generic labels cannot link an arbitrary search hit to the object. Named titles must match as a whole token set. */
function describesSelectedObject(object: InspectableObject, snippet: string, title: string): boolean {
  const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const sourceWords = new Set(words(`${title} ${snippet}`));
  const names = [object.name, object.identity?.model, ...(object.identity?.visibleText?.slice(0, 12) ?? [])];
  return names.some((name) => {
    if (!name || !known(name)) return false;
    const meaningful = [...new Set(words(name).filter((word) => !genericWords.has(word)))];
    if (!meaningful.length || !meaningful.some((word) => /\p{L}/u.test(word))) return false;
    if (meaningful.length === 1 && meaningful[0].length < 6) return false;
    return meaningful.every((word) => sourceWords.has(word));
  });
}

/** No URL from a model is fetched. Restrict displayed links to public HTTPS citations returned by the search tool. */
export function publicCitation(value: string): string | undefined {
  try {
    const u = new URL(value);
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    if (value.length > 1000 || u.protocol !== 'https:' || u.username || u.password || u.port && u.port !== '443'
      || !host.includes('.') || isIP(host.replace(/^\[|\]$/g, '')) || /(^|\.)(localhost|local|internal|test|invalid)$/.test(host)) return;
    u.hash = ''; return u.href;
  } catch { return; }
}

/** The explicit Inspect route and factual specs cannot accidentally become a control/game plan. */
export function isObjectInformationRequest(text: string): boolean {
  const t = text.trim();
  if (/^(?:please\s+)?inspect\b/i.test(t) || /\b(?:dimensions?|weight|weighs?|price|pricing|retailer|isbn|specifications?)\b/i.test(t)) return true;
  if (controlVocabulary.test(t)) return false;
  return /^(?:please\s+)?(?:describe|identify|tell me (?:more )?about|give me (?:some )?information about|about this object)\b/i.test(t)
    || /^(?:what (?:is|are)|who (?:made|makes|wrote|published)|how (?:much|heavy|big|large|tall|wide|long))\b/i.test(t);
}
const controlVocabulary = /\b(?:controls?|gestures?|mapping|clutch|setup|connection|pairing|menu)\b/i;
/** Explanations stay read-only even if a planner misclassifies the request as an action. */
export function isControlExplanationRequest(text: string): boolean {
  return controlVocabulary.test(text) && /^(?:please\s+)?(?:tell me (?:more )?about|describe|explain|what|why|which|how does|how do these|how do the)\b/i.test(text.trim());
}

function context(object: InspectableObject) {
  const i = object.identity;
  return { name: object.name.slice(0, 200), maker: i?.maker?.slice(0, 120), model: i?.model?.slice(0, 160), category: i?.category?.slice(0, 80),
    confidence: i?.confidence, visibleText: i?.visibleText?.slice(0, 12).map((s) => s.slice(0, 200)),
    evidence: i?.evidence?.slice(0, 6).map((s) => s.slice(0, 240)), notes: i?.notes?.slice(0, 600) };
}
function identifiers(object: InspectableObject): string[] {
  const c = context(object);
  const text = [c.name, c.model, c.notes, ...(c.visibleText ?? [])].filter(Boolean).join(' ');
  const isBook = /book|publication|paperback|hardback|hardcover|publisher|isbn/i.test(`${c.category ?? ''} ${text} ${(c.evidence ?? []).join(' ')}`);
  const isbn = text.match(/(?:97[89][\d -]{10,17}|\b\d[\d -]{8,15}[\dXx]\b)/g)?.map((s) => s.replace(/[ -]/g, '').toUpperCase()).filter((s) => {
    if (/^97[89]\d{10}$/.test(s)) return [...s].reduce((sum, n, i) => sum + Number(n) * (i % 2 ? 3 : 1), 0) % 10 === 0;
    if (/^\d{9}[\dX]$/.test(s)) return [...s].reduce((sum, n, i) => sum + (n === 'X' ? 10 : Number(n)) * (10 - i), 0) % 11 === 0;
    return false;
  }) ?? [];
  // A title alone cannot distinguish paperback/hardback, language, print run or dimensions.
  if (isBook) return isbn;
  if (known(c.model) && known(c.maker) && !/\b(?:generic|unbranded|unidentified|unknown|unspecified)\b/i.test(`${c.maker} ${c.model}`)) {
    return [normal(c.model!), normal(`${c.maker} ${c.model}`)];
  }
  return [];
}

export function unknownObjectInformation(object: InspectableObject, note: string, now: number, source: 'live' | 'fixture' = 'fixture'): ObjectInformation {
  return { title: object.name.slice(0, 200) || 'Selected object', identityStatus: 'uncertain', identityNote: note.slice(0, 400),
    description: { value: null, sourceIds: [] }, dimensions: { value: null, sourceIds: [] }, weight: { value: null, sourceIds: [] },
    price: null, sources: [], researchedAt: now, cached: false, source };
}

export function objectInformationText(info: ObjectInformation): string {
  const fact = (label: string, f: ObjectInformation['description']) => `${label}: ${f.value?.slice(0, label === 'Description' ? 220 : 120) ?? 'Unknown'}${f.sourceIds.length ? ` [${f.sourceIds.join(', ')}]` : ''}`;
  const p = info.price;
  const lines = [info.title.slice(0, 120), info.identityNote.slice(0, 240), fact('Description', info.description), fact('Dimensions', info.dimensions), fact('Weight', info.weight),
    p ? `Price: ${p.amount} ${p.currency} · ${p.retailer} · ${p.condition} · checked ${p.asOf} [${p.sourceIds.join(', ')}]` : 'Price: Unknown',
    info.cached ? `Reused research from ${new Date(info.researchedAt).toISOString()}.` : 'Reported source facts; not a physical measurement.'];
  let out = lines.join('\n').slice(0, 1450);
  for (const s of info.sources) {
    const line = `\n[${s.id}] ${s.url}`;
    if (out.length + line.length > 1950) break;
    out += line;
  }
  return out;
}

export class ObjectInformationService {
  constructor(private readonly web?: WebSearcher, private readonly now: () => number = Date.now) {}
  async inspect(object: InspectableObject, request: string, signal: AbortSignal): Promise<ObjectInformation> {
    throwIfCancelled(signal);
    const now = this.now(), day = new Date(now).toISOString().slice(0, 10);
    const empty = (note: string, source = this.web?.mode ?? 'fixture') => unknownObjectInformation(object, note, now, source);
    if (!this.web) return empty('Web research is unavailable. Confirm the exact model or book ISBN/edition; specifications and current price are unknown.');
    // Inspect always retrieves the same bounded card fields. User phrasing is not part of the cache
    // key: an explicit refresh must replace the entry that the next ordinary Inspect will reuse.
    const question = `Object inspection v2. Lookup date: ${day}. Selected object data: ${JSON.stringify(context(object))}. ` +
      'Research the description, dimensions, weight and current advertised price. ' +
      'Return one JSON object with identity:{matchedIdentifier:string|null,name:string,note:string,quote:string|null,urls:string[]}, ' +
      'description:{value:string|null,quote:string|null,urls:string[]}, dimensions:{value:string|null,quote:string|null,urls:string[]}, weight:{value:string|null,quote:string|null,urls:string[]}, ' +
      'price:null|{amount:string,currency:ISO4217,retailer:string,asOf:YYYY-MM-DD,condition:string,quote:string,urls:string[]}. ' +
      'matchedIdentifier must exactly match a supplied model (optionally maker plus model), or ISBN for books. ' +
      'If only a book title or uncertain visual identity is supplied, give a sourced general description but null dimensions, weight and price; ask for its ISBN/edition. ' +
      'Use null for missing facts, never estimate. Dimensions need units and axis order; weight must distinguish product from shipping weight. ' +
      'Price amount is one numeric amount without currency symbols; cite a current retailer listing for the exact variant, state new/used and market context, and use the lookup date. ' +
      'Every quote must be a short exact substring of the raw search-result snippet for its URL. Each fact value must itself be a substring of that quote, never a paraphrase. ' +
      'Identity quotes must contain the supplied identifier. A price quote must contain the amount, ISO currency code and condition; its source title or URL must identify the retailer. ' +
      'All non-null facts require source URLs also included as web-search citations. If snippets do not support a field, return null. Do not return markdown or reveal unread book contents.';
    const research = await this.web.research(question, { signal, purpose: 'object-information', effort: 'low', refresh: /\b(refresh|latest|search again)\b/i.test(request) });
    throwIfCancelled(signal);
    const completedAt = this.now();
    return this.normalize(object, research, new Date(completedAt).toISOString().slice(0, 10), completedAt);
  }

  private normalize(object: InspectableObject, research: WebResearch, day: string, now: number): ObjectInformation {
    const out = unknownObjectInformation(object, 'No source-backed match was found. Confirm the exact model or book ISBN/edition.', now, research.source);
    out.modelId = research.model.slice(0, 120); out.cached = research.cached === true;
    out.researchedAt = Number.isSafeInteger(research.researchedAt) && research.researchedAt! >= 0 && research.researchedAt! <= now ? research.researchedAt! : now;
    if (research.source === 'fixture') { out.identityNote = 'Fixture mode: no live web lookup was made. Specifications and current price remain unknown.'; return out; }
    if (research.text.length > 30_000) return out;
    let answer: z.infer<typeof ResearchAnswer>;
    try { answer = ResearchAnswer.parse(JSON.parse(research.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))); }
    catch { return out; }
    const citations = new Map<string, { url: string; title: string; snippet: string }>();
    for (const c of research.citations.slice(0, 12)) { const url = publicCitation(c.url); if (url && c.snippet) citations.set(url, { url, title: (c.title || new URL(url).hostname).slice(0, 180), snippet: c.snippet }); }
    const sourceIds = (urls: string[], quote: string | null, identifier?: string, bindDescription = false) => [...new Set(urls.flatMap((raw) => {
      const url = publicCitation(raw), c = url && citations.get(url);
      if (!c || !quote?.trim() || !quoted(c.snippet).includes(quoted(quote))) return [];
      if (identifier && !containsIdentifier(c.snippet, identifier)) return [];
      if (bindDescription && !describesSelectedObject(object, c.snippet, c.title)) return [];
      let s = out.sources.find((s) => s.url === c.url);
      if (!s && out.sources.length < 6) { s = { id: String(out.sources.length + 1), url: c.url, title: c.title, excerpt: quote }; out.sources.push(s); }
      else if (s && !s.excerpt?.includes(quote)) s.excerpt = `${s.excerpt ?? ''}\n${quote}`.trim().slice(0, 1000);
      return s ? [s.id] : [];
    }))];
    const identityRefs = sourceIds(answer.identity.urls, answer.identity.quote, answer.identity.matchedIdentifier ?? undefined);
    const ids = identifiers(object);
    const exact = !!identityRefs.length && !!answer.identity.matchedIdentifier && containsIdentifier(answer.identity.quote ?? '', answer.identity.matchedIdentifier)
      && ids.some((id) => normal(id) === normal(answer.identity.matchedIdentifier!));
    out.identityStatus = exact ? 'matched' : 'uncertain';
    out.identityNote = exact ? 'Sources matched the supplied model or ISBN. The selected identity has not been independently verified.'
      : 'Exact model/edition is unconfirmed. Confirm the model or book ISBN; dimensions, weight and price remain unknown.';
    const fact = (value: z.infer<typeof Fact>, allowed: boolean, bindDescription = false) => {
      if (!allowed || !value.value?.trim() || !value.quote || !quoted(value.quote).includes(quoted(value.value))) return { value: null, sourceIds: [] };
      const refs = sourceIds(value.urls, value.quote, exact ? answer.identity.matchedIdentifier! : undefined, bindDescription && !exact);
      return refs.length ? { value: value.value, sourceIds: refs } : { value: null, sourceIds: [] };
    };
    out.description = fact(answer.description, true, true);
    out.dimensions = fact(answer.dimensions, exact);
    out.weight = fact(answer.weight, exact);
    const p = answer.price;
    if (exact && p && p.asOf === day && /^\d+(?:\.\d{1,4})?$/.test(p.amount) && Number.isFinite(Number(p.amount)) && Number(p.amount) > 0) {
      const priceQuoted = new RegExp(`(?:^|[^0-9.])${p.amount.replace(/\./g, '\\.')}([^0-9.]|$)`).test(p.quote)
        && p.quote.includes(p.currency) && quoted(p.quote).toLowerCase().includes(quoted(p.condition).toLowerCase());
      const urls = p.urls.filter((url) => { const c = citations.get(publicCitation(url) ?? ''); return c && normal(`${new URL(c.url).hostname} ${c.title}`).includes(normal(p.retailer)); });
      const refs = priceQuoted ? sourceIds(urls, p.quote, answer.identity.matchedIdentifier!) : [];
      if (refs.length) out.price = { amount: p.amount, currency: p.currency, retailer: p.retailer, asOf: p.asOf, condition: p.condition, sourceIds: refs };
    }
    return out;
  }
}
