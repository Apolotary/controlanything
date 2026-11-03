import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ForgeDriver } from '../gen3d/forgeTypes';
import { InteractionMemory, INTERACTION_MEMORY_LIMIT, type InteractionInput, type InteractionQuery } from './interactions';

const faults = vi.hoisted(() => ({ rename: false, flush: false }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs,
    renameSync: (from: string, to: string) => { if (faults.rename) throw new Error('interrupted rename'); return fs.renameSync(from, to); },
    fsyncSync: (fd: number) => { if (faults.flush) throw new Error('interrupted flush'); return fs.fsyncSync(fd); },
  };
});
const dirs: string[] = [];
afterEach(() => { faults.rename = faults.flush = false; vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function file() { const d = mkdtempSync(join(tmpdir(), 'ce-interactions-')); dirs.push(d); return join(d, 'data', 'interactions.json'); }
function sample(): InteractionInput {
  const driver = { driverId: 'driver-1', cardId: 'synth', name: 'Synth driver', transport: 'midi', maxRateHz: 20,
    executor: { deviceId: 'helper', port: 'USB Synth' },
    actions: [{ actionId: 'filter', label: 'Filter', kind: 'set', range: { min: 0, max: 127, step: 1 },
      encode: { kind: 'midi', msg: 'cc', number: 74, channel: 1, value: '$value' }, expect: { sense: 'camera', effect: 'any' } }],
  } satisfies ForgeDriver & { actions: (ForgeDriver['actions'][number] & { encode: Record<string, unknown> })[] };
  return { cardId: 'synth', name: 'Synth', request: 'Raise my right hand to control the filter', source: 'live', modelId: 'muse-spark-test', driver,
    verification: { filter: 'pass' }, map: { version: 1, clutchPosture: 'L_FIST', panicPosture: 'BOTH_PALMS_OUT', axes: [{ axis: 'right_height', actionId: 'filter', label: 'Filter', outMin: 0, outMax: 127,
      curve: 'linear', deadzone: .02, smoothingMinCutoff: 1.2, smoothingBeta: .4, quantizeStep: 1, maxRateHz: 20 }], postures: [] } };
}
function query(input = sample()): InteractionQuery { return { cardId: input.cardId, request: input.request, driver: input.driver, verification: input.verification, source: input.source ?? 'fixture' }; }

describe('local accepted interaction memory', () => {
  it('persists only detached validated mappings with acceptance time and model provenance across restart', () => {
    const path = file(); const input = sample(); const memory = new InteractionMemory(path);
    expect(memory.exact(query(input))).toBeUndefined();
    vi.spyOn(Date, 'now').mockReturnValue(123456);
    memory.remember(input);
    const hit = new InteractionMemory(path).exact(query(input))!;
    expect(hit).toMatchObject({ name: 'Synth', request: input.request, map: input.map, source: 'live', modelId: 'muse-spark-test', acceptedAt: 123456, match: 'exact' });
    expect(hit.id).toMatch(/^[a-f0-9-]{36}$/);
    input.map.axes[0].outMax = 40;
    hit.map.axes[0].outMax = 50;
    expect(memory.exact(query())?.map.axes[0].outMax).toBe(127);
    expect(new InteractionMemory(path).exact(query())?.map.axes[0].outMax).toBe(127);
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    expect(stored).toMatchObject({ version: 1, entries: [{ acceptedAt: 123456, source: 'live' }] });
    expect(stored.entries[0].verification).toBeUndefined(); // old verification must never grant authority
    expect(readdirSync(join(path, '..'))).toEqual(['interactions.json']);
  });

  it('normalizes case, whitespace and trailing punctuation, preserving numbers, negation and word order', () => {
    const memory = new InteractionMemory(); const input = { ...sample(), request: 'Set filter to 20, not 30!' };
    memory.remember(input);
    expect(memory.exact({ ...query(input), request: '  SET   filter\nto 20, not 30?!  ' })?.match).toBe('exact');
    for (const request of ['Set filter to 30, not 20!', 'Set filter to 20, 30!', 'Set filter to 2, not 30!', 'Set filter to 20.0, not 30!', 'Set not filter to 20, 30!']) {
      expect(memory.exact({ ...query(input), request })).toBeUndefined();
    }
  });

  it('requires the same card for exact reuse and allows only related reference retrieval for another compatible card', () => {
    const memory = new InteractionMemory(); const input = sample(); memory.remember(input);
    const other = { ...query(), cardId: 'second-synth', driver: { ...input.driver, cardId: 'second-synth', driverId: 'new-driver-id' } };
    expect(memory.exact(other)).toBeUndefined();
    expect(memory.search(other)).toMatchObject([{ match: 'related', request: input.request }]);
    expect(memory.exact({ ...query(), driver: { ...input.driver, driverId: 'regenerated-driver' } })?.match).toBe('exact');
    expect(memory.exact({ ...query(), cardId: 'mismatched-card' })).toBeUndefined();
  });

  it('canonicalizes field order and action order while ignoring descriptive/model metadata and stored verified flags', () => {
    const memory = new InteractionMemory(); const input = sample();
    input.driver.actions.push({ actionId: 'resonance', label: 'Resonance', kind: 'set', range: { min: 0, max: 127, step: 1 }, encode: { kind: 'midi', msg: 'cc', number: 71 } });
    memory.remember(input);
    const changed = structuredClone(input.driver);
    changed.driverId = 'new'; changed.name = 'Renamed'; changed.actions.reverse();
    changed.actions[1].label = 'Localized name'; changed.actions[1].verified = 'fail';
    (changed.actions[1] as any).description = 'New explanation';
    (changed as any).modelId = 'different-planner'; (changed as any).source = 'fixture';
    changed.actions[1].range = { step: 1, max: 127, min: 0 };
    expect(memory.exact({ ...query(input), driver: changed })).toBeDefined();
  });

  const changes: [string, (d: any) => void][] = [
    ['range', (d) => { d.actions[0].range.max = 100; }],
    ['step', (d) => { d.actions[0].range.step = 2; }],
    ['CC number', (d) => { d.actions[0].encode.number = 71; }],
    ['MIDI channel outside Forge subset', (d) => { d.actions[0].encode.channel = 2; }],
    ['MIDI value outside Forge subset', (d) => { d.actions[0].encode.value = 64; }],
    ['kind', (d) => { d.actions[0].kind = 'trigger'; }],
    ['action identity', (d) => { d.actions[0].actionId = 'resonance'; }],
    ['confirmation', (d) => { d.actions[0].confirm = 'hold'; }],
    ['rate', (d) => { d.maxRateHz = 10; }],
    ['expectation', (d) => { d.actions[0].expect.effect = 'brighter'; }],
    ['expectation threshold outside Forge subset', (d) => { d.actions[0].expect.minDelta = .2; }],
    ['inverse', (d) => { d.actions[0].inverseActionId = 'reset'; }],
    ['firmware revision', (d) => { d.firmwareVersion = '2.0'; }],
    ['driver format version', (d) => { d.version = 2; }],
    ['transport', (d) => { d.transport = 'ir'; }],
    ['executor port', (d) => { d.executor.port = 'Other synth'; }],
  ];
  it.each(changes)('invalidates exact and actionable related hits after changed %s', (_name, change) => {
    const memory = new InteractionMemory(); memory.remember(sample());
    const q = query(); change(q.driver);
    expect(memory.exact(q)).toBeUndefined(); expect(memory.search(q)).toEqual([]);
  });

  it.each(['fail', 'pending', 'untested', 'missing'])('revalidates CURRENT verification on exact and related retrieval: %s', (status) => {
    const memory = new InteractionMemory(); const input = sample(); memory.remember(input);
    const verification: InteractionQuery['verification'] = status === 'missing' ? {} : { filter: status as 'fail' };
    expect(memory.exact({ ...query(), verification })).toBeUndefined();
    expect(memory.search({ ...query(), request: 'Right hand filter control', verification })).toEqual([]);
    expect(memory.exact(query())).toBeDefined(); // mismatch invalidates retrieval, not remembered human intent
  });

  it('validates composite step dependencies on every retrieval', () => {
    const input = sample(); input.driver.transport = 'ir'; input.driver.maxRateHz = 2;
    input.driver.actions = [
      { actionId: 'filter', label: 'Brightness', kind: 'set', range: { min: 0, max: 100, step: 10 }, encode: { kind: 'step', upActionId: 'up', downActionId: 'down', steps: 10 } },
      { actionId: 'up', label: 'Brighter', kind: 'trigger', encode: { kind: 'ir' } },
      { actionId: 'down', label: 'Dimmer', kind: 'trigger', encode: { kind: 'ir' } },
    ];
    input.map.axes[0] = { ...input.map.axes[0], outMax: 100, quantizeStep: 10, maxRateHz: 2 };
    input.verification = { filter: 'pass', up: 'pass', down: 'pass' };
    const memory = new InteractionMemory(); memory.remember(input);
    expect(memory.exact(query(input))).toBeDefined();
    expect(memory.exact({ ...query(input), verification: { ...input.verification, down: 'fail' } })).toBeUndefined();
  });

  it('isolates live and fixture references, including fixture default when provenance is omitted', () => {
    const memory = new InteractionMemory(); const fixture = { ...sample(), source: undefined };
    memory.remember(fixture);
    expect(memory.exact(query())).toBeUndefined(); expect(memory.search(query())).toEqual([]);
    expect(memory.exact({ ...query(), source: 'fixture' })?.source).toBe('fixture');
    memory.remember(sample());
    expect(memory.exact(query())?.source).toBe('live');
    expect(memory.exact({ ...query(), source: 'fixture' })?.source).toBe('fixture');
  });

  it('ranks compatible lexical/action references, returns at most three, and ignores unrelated requests', () => {
    const memory = new InteractionMemory();
    for (const request of ['Raise right hand for filter', 'Roll wrist for filter', 'Open pinch for filter', 'Two hand distance for filter']) memory.remember({ ...sample(), request });
    expect(memory.search({ ...query(), request: 'Adjust filter using hand motion' })).toHaveLength(3);
    expect(memory.search({ ...query(), request: 'Adjust filter using hand motion' }).every((hit) => hit.match === 'related')).toBe(true);
    expect(memory.search({ ...query(), request: 'Tomorrow weather forecast' })).toEqual([]);
    expect(memory.search({ ...query(), request: 'Roll wrist for filter' })[0]).toMatchObject({ match: 'exact', request: 'Roll wrist for filter' });
  });

  it('updates the latest acceptance for a request and evicts to a bounded 128 entries', () => {
    const path = file(); const memory = new InteractionMemory(path); const input = sample();
    vi.spyOn(Date, 'now').mockReturnValue(100);
    memory.remember(input); const id = memory.exact(query())!.id;
    vi.mocked(Date.now).mockReturnValue(200);
    const updated = { ...sample(), request: 'RAISE my right hand to control the FILTER!', map: { ...input.map, axes: [{ ...input.map.axes[0], outMax: 100 }] } };
    memory.remember(updated);
    expect(memory.exact(query())).toMatchObject({ id, acceptedAt: 200, map: { axes: [{ outMax: 100 }] } });
    expect(JSON.parse(readFileSync(path, 'utf8')).entries).toHaveLength(1);
    // Fast in-memory insertion; persistence bound is separately verified on one final flush below.
    const bounded = new InteractionMemory();
    for (let n = 0; n < INTERACTION_MEMORY_LIMIT + 5; n++) bounded.remember({ ...input, request: `Filter gesture request ${n}` });
    expect(bounded.exact({ ...query(), request: 'Filter gesture request 0' })).toBeUndefined();
    expect(bounded.exact({ ...query(), request: 'Filter gesture request 5' })).toBeDefined();
    expect(bounded.exact({ ...query(), request: 'Filter gesture request 132' })).toBeDefined();
  });

  it('forgets every reference for the card across sources and contracts, durably', () => {
    const path = file(); const memory = new InteractionMemory(path); memory.remember(sample());
    memory.remember({ ...sample(), source: 'fixture' });
    const second = sample(); second.cardId = second.driver.cardId = 'second-synth'; memory.remember(second);
    memory.forget('synth'); memory.forget('missing');
    const reopened = new InteractionMemory(path);
    expect(reopened.exact(query())).toBeUndefined(); expect(reopened.exact({ ...query(), source: 'fixture' })).toBeUndefined();
    expect(reopened.exact(query(second))).toBeDefined();
    expect(JSON.parse(readFileSync(path, 'utf8')).entries).toHaveLength(1);
  });

  it('tolerates invalid JSON, unknown versions and oversized files without trusting corrupt data', () => {
    const path = file(); new InteractionMemory(path).remember(sample());
    for (const text of ['{broken', JSON.stringify({ version: 9000, entries: [] }), ' '.repeat(2_000_001)]) {
      writeFileSync(path, text);
      const memory = new InteractionMemory(path);
      expect(memory.exact(query())).toBeUndefined(); expect(memory.warnings).toHaveLength(1);
    }
  });

  it('loads valid records beside malformed entries and revalidates plausible but tampered maps', () => {
    const path = file(); new InteractionMemory(path).remember(sample());
    const root = JSON.parse(readFileSync(path, 'utf8'));
    root.entries.push({ ...root.entries[0], id: 'invalid', source: 'untrusted' });
    writeFileSync(path, JSON.stringify(root));
    const mixed = new InteractionMemory(path);
    expect(mixed.exact(query())).toBeDefined(); expect(mixed.warnings).toHaveLength(1);
    root.entries[0].map.axes[0].outMax = 500;
    writeFileSync(path, JSON.stringify(root));
    const tampered = new InteractionMemory(path);
    expect(tampered.exact(query())).toBeUndefined(); expect(tampered.search(query())).toEqual([]);
  });

  it.each(['rename', 'flush'] as const)('preserves the last durable file after interrupted atomic %s and removes temp files', (fault) => {
    const path = file(); const memory = new InteractionMemory(path); memory.remember(sample());
    const before = readFileSync(path, 'utf8'); faults[fault] = true;
    memory.remember({ ...sample(), request: 'Roll wrist to control filter' });
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(readdirSync(join(path, '..'))).toEqual(['interactions.json']);
    expect(memory.warnings[0]).toContain('Could not persist');
    expect(memory.exact({ ...query(), request: 'Roll wrist to control filter' })).toBeDefined();
    expect(new InteractionMemory(path).exact({ ...query(), request: 'Roll wrist to control filter' })).toBeUndefined();
  });

  it('rejects unsafe or malformed writes and fails closed for malformed queries', () => {
    const memory = new InteractionMemory(); const input = sample();
    expect(() => memory.remember({ ...input, request: 'x'.repeat(2001) })).toThrow();
    expect(() => memory.remember({ ...input, request: '!!!' })).toThrow();
    expect(() => memory.remember({ ...input, name: 'x'.repeat(81) })).toThrow();
    expect(() => memory.remember({ ...input, cardId: 'other' })).toThrow('card IDs differ');
    expect(() => memory.remember({ ...input, verification: { filter: 'fail' } })).toThrow('verified');
    const forged = structuredClone(input.map); forged.axes[0].maxRateHz = 30;
    expect(() => memory.remember({ ...input, map: forged })).toThrow('rate limit');
    const code = structuredClone(input.driver); (code.actions[0].encode as any).run = () => {};
    expect(() => memory.remember({ ...input, driver: code })).toThrow('JSON');
    expect(memory.exact({ ...query(), source: 'unknown' as never })).toBeUndefined();
    expect(memory.search({ ...query(), request: 'x'.repeat(2001) })).toEqual([]);
    expect(memory.exact(query())).toBeUndefined();
  });
});
