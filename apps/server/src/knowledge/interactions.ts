/**
 * Local reference memory for gesture maps explicitly accepted by a person.
 * This is not authority to apply a map: every retrieval checks the CURRENT hardware contract and
 * verification, and the caller must still show its ordinary proposal/Apply flow.
 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { GestureMap } from '@ce/protocol';
import { z } from 'zod';
import { validateGestureMap } from '../devices/gestures';
import { ForgeDriver, VerifyState } from '../gen3d/forgeTypes';

export const INTERACTION_MEMORY_LIMIT = 128;
const FILE_LIMIT = 2_000_000;
const CONTRACT_LIMIT = 524_288;
const Id = z.string().trim().min(1).max(128);
const Source = z.enum(['live', 'fixture']);
const RequestText = z.string().trim().min(1).max(2000);
const Name = z.string().trim().min(1).max(80);
const Verification = z.record(z.string().max(128), VerifyState).refine((v) => Object.keys(v).length <= 128, 'Too many verification entries');
const EntrySchema = z.object({
  id: z.string().uuid(), cardId: Id, name: Name, request: RequestText,
  contract: z.string().regex(/^[a-f0-9]{64}$/), transport: ForgeDriver.shape.transport,
  map: GestureMap.refine((map) => map.axes.length + map.postures.length <= 6, 'At most six reviewable bindings'), source: Source, modelId: z.string().trim().min(1).max(120).optional(),
  acceptedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
type Entry = z.infer<typeof EntrySchema>;
const RootSchema = z.object({ version: z.literal(1), entries: z.array(z.unknown()).max(4096) });
const QuerySchema = z.object({ cardId: Id, request: RequestText, name: Name.optional(), source: Source, verification: Verification });
const InputSchema = QuerySchema.omit({ source: true }).extend({ name: Name, source: Source.default('fixture'), modelId: z.string().trim().min(1).max(120).optional() });

export interface InteractionQuery {
  cardId: string;
  request: string;
  name?: string;
  driver: ForgeDriver;
  verification: Record<string, VerifyState>;
  source: 'live' | 'fixture';
}
export interface InteractionInput extends Omit<InteractionQuery, 'name' | 'source'> {
  name: string;
  map: GestureMap;
  source?: 'live' | 'fixture';
  modelId?: string;
}
export interface MemoryHit {
  id: string;
  request: string;
  name: string;
  map: GestureMap;
  source: 'live' | 'fixture';
  modelId?: string;
  acceptedAt: number;
  match: 'exact' | 'related';
}

/** Do not remove numbers, negation, interior punctuation, or word order from an exact request. */
function normalizeRequest(text: string): string {
  return text.normalize('NFC').toLowerCase().trim().replace(/\s+/gu, ' ').replace(/[.!?。！？]+$/u, '').trim();
}

/** A bounded, deterministic JSON representation. Never invoke toJSON or silently discard non-JSON data. */
function canonical(input: unknown): string {
  let nodes = 0;
  const walk = (value: unknown, depth: number): string => {
    if (++nodes > 100_000 || depth > 12) throw new Error('Hardware contract is too complex');
    if (value === null) return 'null';
    if (typeof value === 'string') {
      if (value.length > 4000) throw new Error('Hardware contract text is too long');
      return JSON.stringify(value);
    }
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (typeof value === 'boolean') return JSON.stringify(value);
    if (Array.isArray(value)) {
      if (value.length > 1024) throw new Error('Hardware contract array is too long');
      return `[${value.map((v) => walk(v, depth + 1)).join(',')}]`;
    }
    if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Object.values(descriptors).some((descriptor) => !('value' in descriptor))) throw new Error('Hardware contract accessors are not data');
      const pairs = Object.entries(descriptors).filter(([, descriptor]) => descriptor.value !== undefined).map(([key, descriptor]) => [key, descriptor.value] as const);
      if (pairs.length > 128) throw new Error('Hardware contract has too many fields');
      return `{${pairs.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => {
        if (k.length > 128 || k === '__proto__' || k === 'constructor' || k === 'prototype') throw new Error('Invalid hardware contract field');
        return `${JSON.stringify(k)}:${walk(v, depth + 1)}`;
      }).join(',')}}`;
    }
    throw new Error('Hardware contract must contain finite JSON data');
  };
  const result = walk(input, 0);
  if (Buffer.byteLength(result) > CONTRACT_LIMIT) throw new Error('Hardware contract is too large');
  return result;
}

function contractOf(input: ForgeDriver): { hash: string; driver: ForgeDriver } {
  // Parse for validation but hash the raw complete encodes, including fields outside Forge's small
  // subset (e.g. MIDI channel/value, IR bytes/timing, local arguments, expectation thresholds).
  const raw = JSON.parse(canonical(input)) as Record<string, unknown> & { actions: Record<string, unknown>[] };
  const driver = ForgeDriver.parse(raw);
  if (new Set(driver.actions.map((a) => a.actionId)).size !== driver.actions.length) throw new Error('Duplicate action IDs');
  const { driverId: _driverId, cardId: _cardId, name: _name, notes: _notes, provenance: _provenance, modelId: _modelId, source: _source, ...contract } = raw;
  contract.actions = raw.actions.map((action) => {
    const { label: _label, description: _description, verified: _verified, ...hardware } = action;
    return hardware;
  }).sort((a, b) => String(a.actionId).localeCompare(String(b.actionId)));
  return { hash: createHash('sha256').update(canonical(contract)).digest('hex'), driver };
}
const entryKey = (e: Pick<Entry, 'cardId' | 'request' | 'contract' | 'source'>) => JSON.stringify([e.cardId, normalizeRequest(e.request), e.contract, e.source]);
const stopWords = new Set('a an the this that it its to of for with and or in on at is are be my your please can could you me make when control controls device map mapping gesture gestures'.split(' '));
function tokens(text: string): Set<string> {
  return new Set((normalizeRequest(text).match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => !stopWords.has(word)));
}
const overlap = (a: Set<string>, b: Set<string>) => [...a].filter((word) => b.has(word));

/** Same-directory exclusive temp file + flush + rename; an interrupted write cannot truncate the old JSON. */
function atomicWrite(file: string, value: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, value);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temp, file);
    const directory = openSync(dirname(file), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
  }
}

export class InteractionMemory {
  private entries: Entry[] = [];
  private readonly issues: string[] = [];
  /** Bounded, content-free diagnostics; corruption never prevents the application starting. */
  get warnings(): readonly string[] { return [...this.issues]; }

  constructor(private readonly file?: string) {
    if (!file || !existsSync(file)) return;
    try {
      if (statSync(file).size > FILE_LIMIT) throw new Error('Memory file exceeds size limit');
      const root = RootSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
      const seen = new Set<string>();
      const valid: Entry[] = [];
      for (const value of root.entries) {
        const parsed = EntrySchema.safeParse(value);
        if (!parsed.success || !normalizeRequest(parsed.data.request)) { this.warn('Skipped invalid interaction memory entry'); continue; }
        valid.push(parsed.data);
      }
      for (const entry of valid.sort((a, b) => b.acceptedAt - a.acceptedAt)) {
        const key = entryKey(entry);
        if (seen.has(key)) continue;
        seen.add(key);
        this.entries.push(entry);
        if (this.entries.length === INTERACTION_MEMORY_LIMIT) break;
      }
    } catch { this.warn('Could not read interaction memory; starting with an empty reference store'); }
  }

  /** Call ONLY after the ordinary human Apply succeeds. Never call on model output or a preview. */
  remember(input: InteractionInput): void {
    const parsed = InputSchema.parse(input);
    if (!normalizeRequest(parsed.request)) throw new Error('Interaction request is empty');
    const { hash, driver } = contractOf(input.driver);
    if (driver.cardId !== parsed.cardId) throw new Error('Interaction and driver card IDs differ');
    const map = validateGestureMap(input.map, driver, parsed.verification);
    if (!map.axes.length && !map.postures.length) throw new Error('Interaction memory needs a gesture binding');
    const base = { ...parsed, contract: hash, transport: driver.transport, map };
    const existing = this.entries.find((entry) => entryKey(entry) === entryKey(base));
    const entry = EntrySchema.parse({ ...base, id: existing?.id ?? randomUUID(), acceptedAt: Date.now() });
    this.entries = [entry, ...this.entries.filter((item) => entryKey(item) !== entryKey(entry))].slice(0, INTERACTION_MEMORY_LIMIT);
    this.persist();
  }

  exact(query: InteractionQuery): MemoryHit | undefined {
    const context = this.context(query);
    if (!context) return undefined;
    const entry = this.entries.find((item) => item.cardId === context.query.cardId && item.source === context.query.source
      && item.contract === context.hash && normalizeRequest(item.request) === context.normalized);
    return entry ? this.hit(entry, context, 'exact') : undefined;
  }

  /** Lexical reference retrieval only; no map from another hardware contract or runtime source escapes. */
  search(query: InteractionQuery): MemoryHit[] {
    const context = this.context(query);
    if (!context) return [];
    const requestWords = tokens(context.query.request);
    const ranked = this.entries.flatMap((entry) => {
      if (entry.contract !== context.hash || entry.source !== context.query.source || entry.transport !== context.driver.transport) return [];
      const exact = entry.cardId === context.query.cardId && normalizeRequest(entry.request) === context.normalized;
      const words = tokens(entry.request);
      const shared = overlap(requestWords, words);
      const actions = tokens([...entry.map.axes, ...entry.map.postures].map((b) => `${b.actionId} ${b.label}`).join(' '));
      const actionMatches = overlap(requestWords, actions).length;
      if (!exact && !actionMatches && !(shared.length >= 2 || shared.some((word) => word.length >= 4))) return [];
      const hit = this.hit(entry, context, exact ? 'exact' : 'related');
      if (!hit) return [];
      const score = exact ? 1_000 : actionMatches * 3 + shared.length / Math.max(requestWords.size, words.size, 1) + (entry.cardId === context.query.cardId ? .1 : 0);
      return [{ hit, score }];
    });
    return ranked.sort((a, b) => b.score - a.score || b.hit.acceptedAt - a.hit.acceptedAt).slice(0, 3).map(({ hit }) => hit);
  }

  /** Explicit device forgetting removes all its sources/contracts and persists the deletion. */
  forget(cardId: string): void {
    if (!Id.safeParse(cardId).success) return;
    const remaining = this.entries.filter((entry) => entry.cardId !== cardId);
    if (remaining.length === this.entries.length) return;
    this.entries = remaining;
    this.persist();
  }

  private context(query: InteractionQuery) {
    try {
      const parsed = QuerySchema.parse(query);
      const normalized = normalizeRequest(parsed.request);
      const { hash, driver } = contractOf(query.driver);
      if (!normalized || driver.cardId !== parsed.cardId) return undefined;
      return { query: parsed, normalized, hash, driver };
    } catch { return undefined; }
  }
  private hit(entry: Entry, context: NonNullable<ReturnType<InteractionMemory['context']>>, match: MemoryHit['match']): MemoryHit | undefined {
    try {
      const map = validateGestureMap(entry.map, context.driver, context.query.verification);
      if ((!map.axes.length && !map.postures.length) || map.axes.length + map.postures.length > 6) return undefined;
      return structuredClone({ id: entry.id, name: entry.name, request: entry.request, map, source: entry.source,
        ...(entry.modelId ? { modelId: entry.modelId } : {}), acceptedAt: entry.acceptedAt, match });
    } catch { return undefined; }
  }
  private persist(): void {
    if (!this.file) return;
    try {
      const json = JSON.stringify({ version: 1, entries: this.entries });
      if (Buffer.byteLength(json) > FILE_LIMIT) throw new Error('Interaction memory exceeds size limit');
      atomicWrite(this.file, `${json}\n`);
    } catch { this.warn('Could not persist interaction memory; accepted references remain available for this session'); }
  }
  private warn(message: string): void {
    if (this.issues.at(-1) === message) return;
    this.issues.push(message);
    if (this.issues.length > 10) this.issues.shift();
  }
}
