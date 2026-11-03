import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DeviceInfo, Evidence, UiSpecPayload } from '@ce/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TagStore } from './tags';
import { TargetStore } from './targets';
import type { Target } from './types';
import { IdentityCorrections } from './identity-correction';

const faults = vi.hoisted(() => ({ rename: false, fsync: false }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    fsyncSync: (fd: number) => {
      if (faults.fsync) { faults.fsync = false; throw new Error('interrupted fsync'); }
      return fs.fsyncSync(fd);
    },
    renameSync: (from: string, to: string) => {
      if (faults.rename && to.endsWith('library.json')) { faults.rename = false; throw new Error('interrupted rename'); }
      return fs.renameSync(from, to);
    },
  };
});

const temporary: string[] = [];
afterEach(() => {
  faults.rename = faults.fsync = false;
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function file(): string {
  const dir = mkdtempSync(join(process.cwd(), '.library-test-'));
  temporary.push(dir);
  return join(dir, 'library.json');
}
function device(cardId = 'lamp'): Target {
  return new TargetStore({ broadcast: () => 0 }).create({
    cardId,
    card: { cardId, name: 'Lamp', maker: 'Maker', model: 'Model', category: 'lighting', confidence: 1, protocols: ['ir'], evidence: ['White shade'] },
  });
}
function setup(target: Target, suffix = '1'): UiSpecPayload {
  target.driver = {
    driverId: `driver-${suffix}`, cardId: target.cardId, transport: 'ir', executor: { deviceId: 'bridge' }, provenance: [],
    actions: [{ actionId: 'off', label: 'Off', kind: 'trigger', encode: { kind: 'ir', protocol: 'NEC', bytes: [1, 2, 3, 4], khz: 38, unitUs: 562 } }],
  };
  target.verification = { off: 'pass' };
  target.specId = `spec-${suffix}`;
  target.armed = true;
  target.evidence = [{
    evidenceId: `evidence-${suffix}`, cardId: target.cardId, driverId: target.driver.driverId,
    actionId: 'off', execId: `exec-${suffix}`, attempt: 1,
    sent: { op: { ...target.driver.actions[0].encode, kind: 'ir' }, at: 10 },
    expected: { sense: 'camera', effect: 'off' }, observed: { sense: 'camera', metric: 'luma-abs', before: 1, after: 0, delta: -1, threshold: 0.2 }, pass: true,
  } as Evidence];
  return { specId: target.specId, cardId: target.cardId, driverId: target.driver.driverId, title: `Lamp controls ${suffix}` };
}

function reviewedCorrection(target: Target) {
  const companion: DeviceInfo = { deviceId: 'mac', name: 'Mac', kind: 'mac', role: 'companion', capabilities: ['midi'], canApprove: true,
    online: true, connections: 1, pairedAt: 1, ports: [{ id: 'op1-out', kind: 'midi-out', name: 'OP-1', state: 'connected' }] };
  const service = new IdentityCorrections();
  const proposed = service.propose(target, 'This is actually an OP-1 Field, not the earlier device.', 'owner', [companion]);
  if (!proposed.ok) throw new Error(proposed.reason);
  const result = service.confirm(target, { proposalId: proposed.proposal.proposalId, cardId: target.cardId, sender: 'owner', accept: true, canApprove: true }, [companion]);
  if (result.status !== 'confirmed') throw new Error(result.reason);
  return { corrected: Object.assign(structuredClone(target), result.patch), audit: result.audit };
}

describe('durable device library', () => {
  it('atomically corrects identity while preserving placement/history and refusing old setups after restart or reassociation', () => {
    const path = file(), library = new TagStore(path), target = device();
    library.add(target, 'Old label', { x: 1, y: 2, z: -1 });
    const spec = setup(target); target.paramValues = { old: 70 }; library.sync(target, spec);
    library.add(device('untouched'), 'Other object');
    const oldVersion = library.library().find((record) => record.cardId === target.cardId)!.activeVersionId!;
    const oldTarget = structuredClone(target);
    target.armed = false;
    const { corrected, audit } = reviewedCorrection(target);
    const saved = library.correctIdentity(corrected, audit)!;
    expect(saved).toMatchObject({ cardId: target.cardId, label: 'OP-1 Field', position: { x: 1, y: 2, z: -1 },
      identityRevision: 1, identityCorrection: { source: 'user-confirmed', firmware: 'unknown', physicalControlVerified: false }, armed: false, verification: {}, paramValues: {} });
    expect(saved.driver).toBeUndefined(); expect(saved.specId).toBeUndefined();
    expect(library.library().find((record) => record.cardId === target.cardId)?.versions).toHaveLength(1);
    expect(library.canRestoreVersion(target.cardId, oldVersion)).toBe(false);
    expect(library.restoreVersion(target.cardId, oldVersion)).toBeUndefined();
    expect(library.setEnabled(target.cardId, true)).toBe(false);
    library.sync(oldTarget, spec); // Late prior setup/Forge completion cannot cross the identity boundary.
    expect(library.saveSetupContext(target.cardId, {}, spec)).toBe(false);
    library.add(oldTarget, 'Stale old label', { x: 9, y: 9, z: 9 });
    expect(library.get(target.cardId)).toMatchObject({ label: 'OP-1 Field', armed: false, position: { x: 1, y: 2, z: -1 } });
    expect(library.get('untouched')?.label).toBe('Other object');
    const restarted = new TagStore(path);
    expect(restarted.get(target.cardId)).toMatchObject({ identityRevision: 1, identityCorrection: { confirmedBy: 'owner', firmware: 'unknown' }, armed: false });
    expect(restarted.restoreVersion(target.cardId, oldVersion)).toBeUndefined();
    restarted.remove(target.cardId);
    const current = new TargetStore({ broadcast: () => 0 }).create(restarted.get(target.cardId));
    restarted.add(current, 'OP-1 Field');
    expect(restarted.get(target.cardId)?.driver).toBeUndefined();
    expect(restarted.canRestoreVersion(target.cardId, oldVersion)).toBe(false);
  });

  it('allows newly verified setups for the corrected identity while still rejecting old late artifacts', () => {
    const library = new TagStore(), target = device(); library.add(target, 'Old');
    const oldSpec = setup(target); library.sync(target, oldSpec); target.armed = false;
    const { corrected, audit } = reviewedCorrection(target);
    const snapshot = library.correctIdentity(corrected, audit)!;
    Object.assign(corrected, { identityRevision: snapshot.identityRevision, identityCorrection: snapshot.identityCorrection });
    const fresh = setup(corrected, 'new');
    // Synthetic completed setup: only the durable revision boundary is exercised here.
    corrected.driver = { driverId: fresh.driverId!, cardId: corrected.cardId, transport: 'midi',
      executor: { deviceId: 'mac', port: 'op1-out' }, provenance: [],
      actions: [{ actionId: 'engine', label: 'Engine', kind: 'set', range: { min: 20, max: 100 },
        encode: { kind: 'midi', msg: 'cc', channel: 1, number: 46, value: '$value' } }] };
    corrected.verification = { engine: 'pass' }; corrected.evidence = [];
    fresh.title = 'Corrected identity controls';
    library.sync(corrected, fresh);
    const active = library.library()[0].activeVersionId!;
    expect(library.canRestoreVersion(target.cardId, active)).toBe(true);
    expect(library.restoreVersion(target.cardId, active)?.identityRevision).toBe(1);
    expect(library.saveSetupContext(target.cardId, {}, oldSpec)).toBe(false);
    expect(library.get(target.cardId)?.specId).toBe(fresh.specId);
  });

  it.each(['rename', 'fsync'] as const)('a failed identity correction %s leaves the old live candidate and saved record unchanged', (fault) => {
    const path = file(), library = new TagStore(path), target = device(); library.add(target, 'Old');
    const spec = setup(target); library.sync(target, spec); target.armed = false;
    const before = readFileSync(path, 'utf8'), originalCard = structuredClone(target.card);
    const { corrected, audit } = reviewedCorrection(target);
    faults[fault] = true;
    expect(() => library.correctIdentity(corrected, audit)).toThrow('interrupted');
    expect(target.card).toEqual(originalCard);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(library.get(target.cardId)?.card).toEqual(originalCard);
    expect(new TagStore(path).get(target.cardId)?.card).toEqual(originalCard);
  });

  it('does not resurrect pre-correction authority when the primary library is damaged', () => {
    const path = file(), library = new TagStore(path), target = device(); library.add(target, 'Old');
    const spec = setup(target); library.sync(target, spec); target.armed = false;
    const oldVersion = library.library()[0].activeVersionId!;
    const { corrected, audit } = reviewedCorrection(target);
    library.correctIdentity(corrected, audit);
    writeFileSync(path, '{');
    const recovered = new TagStore(path);
    expect(recovered.get(target.cardId)).toMatchObject({ card: { model: 'OP-1 Field' }, identityRevision: 1, armed: false });
    expect(recovered.get(target.cardId)?.driver).toBeUndefined();
    expect(recovered.restoreVersion(target.cardId, oldVersion)).toBeUndefined();
  });

  it('rejects an identity transaction that retains a driver or describes another old object', () => {
    const library = new TagStore(), target = device(); library.add(target, 'Old');
    const { corrected, audit } = reviewedCorrection(target);
    const stale = { ...audit, previousIdentity: { ...audit.previousIdentity, model: 'Different old object' } };
    expect(() => library.correctIdentity(corrected, stale)).toThrow('no longer matches');
    setup(corrected);
    expect(() => library.correctIdentity(corrected, audit)).toThrow('clear the old setup');
    expect(library.get(target.cardId)?.card?.model).toBe('Model');
  });

  it('migrates legacy tags once, isolates invalid tags, and never resurrects forgotten records', () => {
    const path = file();
    const legacy = path.replace('library.json', 'tags.json');
    const target = device();
    const uiSpec = setup(target);
    const tag = { ...target, label: 'Desk lamp', uiSpec, position: { x: 1, y: 2, z: -1 } };
    writeFileSync(legacy, JSON.stringify({ version: 1, tags: [tag, { cardId: 'broken' }, { ...tag, cardId: 'wrong-owner' }] }));
    const library = new TagStore(legacy);
    expect(library.get('lamp')).toMatchObject({ armed: true, driver: target.driver, uiSpec, position: tag.position });
    expect(library.library()).toHaveLength(1);
    expect(library.loadWarnings).toHaveLength(2);
    expect(JSON.parse(readFileSync(legacy, 'utf8')).version).toBe(1);
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(2);
    library.forget('lamp');
    expect(new TagStore(legacy).library()).toEqual([]);
  });

  it('retains an old driver without declaring it enabled when its interface was never saved', () => {
    const path = file();
    const target = device();
    setup(target);
    writeFileSync(path.replace('library.json', 'tags.json'), JSON.stringify({ version: 1, tags: [{ ...target, label: 'Lamp' }] }));
    expect(new TagStore(path).get('lamp')).toMatchObject({ driver: target.driver, armed: false, specId: undefined });
  });

  it.each(['rename', 'fsync'] as const)('an interrupted %s keeps the previous disk and in-memory state', (fault) => {
    const path = file();
    const library = new TagStore(path);
    library.add(device(), 'Lamp');
    const before = readFileSync(path, 'utf8');
    faults[fault] = true;
    expect(() => library.rename('lamp', 'Changed')).toThrow('interrupted');
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(library.get('lamp')?.label).toBe('Lamp');
    expect(new TagStore(path).get('lamp')?.label).toBe('Lamp');
    expect(readdirSync(path.replace('/library.json', '')).some((name) => name.includes('.tmp-'))).toBe(false);
    library.rename('lamp', 'Next');
    expect(new TagStore(path).get('lamp')?.label).toBe('Next');
  });

  it('recovers a malformed primary file from the last-good snapshot and ignores abandoned temporary writes', () => {
    const path = file();
    const library = new TagStore(path);
    library.add(device(), 'Lamp');
    library.rename('lamp', 'Renamed lamp');
    writeFileSync(`${path}.tmp-abandoned`, '{');
    writeFileSync(path, '{');
    const restored = new TagStore(path);
    expect(restored.get('lamp')?.label).toBe('Lamp');
    expect(restored.loadWarnings).toEqual(['Could not read library.json']);
  });

  it('isolates invalid records while preserving every valid device', () => {
    const path = file();
    const library = new TagStore(path);
    library.add(device(), 'Lamp');
    library.add(device('second'), 'Second');
    const root = JSON.parse(readFileSync(path, 'utf8'));
    root.records.push({ ...root.records[0], cardId: 'bad-record', enabled: 'yes' });
    writeFileSync(path, JSON.stringify(root));
    const restored = new TagStore(path);
    expect(restored.list().map((tag) => tag.cardId)).toEqual(['lamp', 'second']);
    expect(restored.loadWarnings).toHaveLength(1);
  });

  it('failed reruns preserve the active setup and remembered values through restart', () => {
    const path = file();
    const library = new TagStore(path);
    const target = device();
    library.add(target, 'Lamp');
    const uiSpec = setup(target);
    target.paramValues = { brightness: 0.4 };
    library.sync(target, uiSpec);
    const first = library.library()[0].activeVersionId;
    library.beginCandidate('lamp');
    const replacement = setup(target, '2');
    target.armed = false;
    target.paramValues = {};
    library.sync(target, replacement);
    expect(library.library()[0].candidateVersionId).toBeDefined();
    target.state = 'failed';
    target.driver = undefined;
    target.specId = undefined;
    library.sync(target);
    const restored = new TagStore(path);
    expect(restored.library()[0]).toMatchObject({ activeVersionId: first, enabled: true });
    expect(restored.get('lamp')).toMatchObject({ armed: true, specId: uiSpec.specId, uiSpec, evidence: [{ evidenceId: 'evidence-1' }], paramValues: { brightness: 0.4 } });
  });

  it('activates only after enablement and restores the entire version without undoing a disable', () => {
    const library = new TagStore();
    const target = device();
    library.add(target, 'Lamp');
    const original = setup(target);
    library.sync(target, original, { forgeContext: { prompt: 'Original interface' } });
    const first = library.library()[0].activeVersionId!;
    library.beginCandidate('lamp');
    const replacement = setup(target, '2');
    target.armed = false;
    library.sync(target, replacement, { forgeContext: { prompt: 'Replacement interface' } });
    expect(library.get('lamp')?.uiSpec).toEqual(original);
    target.armed = true;
    library.sync(target, replacement);
    expect(library.get('lamp')?.uiSpec).toEqual(replacement);
    library.setEnabled('lamp', false);
    const restored = library.restoreVersion('lamp', first);
    expect(restored).toMatchObject({ armed: false, specId: original.specId, driver: { driverId: 'driver-1' }, evidence: [{ evidenceId: 'evidence-1' }], forgeContext: { prompt: 'Original interface' } });
    expect(library.library()[0].versions).toHaveLength(2);
  });

  it('rejects late activation after cancellation, and lets an explicit new setup complete', () => {
    const library = new TagStore();
    const target = device();
    library.add(target, 'Lamp');
    const original = setup(target);
    library.sync(target, original);
    library.beginCandidate('lamp');
    const replacement = setup(target, '2');
    library.setEnabled('lamp', false);
    library.sync(target, replacement);
    expect(library.get('lamp')).toMatchObject({ armed: false, uiSpec: original });
    expect(library.activateCandidate('lamp')).toBeUndefined();
    library.beginCandidate('lamp');
    library.sync(target, replacement);
    expect(library.get('lamp')).toMatchObject({ armed: true, uiSpec: replacement });
  });

  it('hides without erasing setup history, but forget explicitly removes the record', () => {
    const path = file();
    const library = new TagStore(path);
    const target = device();
    library.add(target, 'Lamp');
    library.sync(target, setup(target));
    expect(library.remove('lamp')).toBe(true);
    expect(library.list()).toEqual([]);
    const restored = new TagStore(path);
    expect(restored.listAll()).toHaveLength(1);
    expect(restored.get('lamp')).toMatchObject({ armed: false, specId: 'spec-1' });
    expect(restored.library()[0]).toMatchObject({ hidden: true, versions: [expect.objectContaining({ specId: 'spec-1' })] });
    restored.forget('lamp');
    expect(new TagStore(path).library()).toEqual([]);
  });

  it('retains research, captures, full measurements, Forge edits and binary assets with identical bytes', () => {
    const path = file();
    const library = new TagStore(path);
    const target = device();
    library.add(target, 'Lamp');
    const original = setup(target);
    target.research = {
      brief: 'Learned remote', provenance: [{ source: 'learned', ref: 'capture-1' }], allowedCcs: new Set([7, 74]),
      learned: [{ learnId: 'capture-1', button: 'Off', hypothesis: 'off', rawUs: [400, 200, 400, 200], capturedAt: 100 }],
    };
    const skin = library.putAsset(Buffer.from('skin bytes'), 'webp', 'image/webp');
    const context = { prompt: 'Original interface', crop: { jpegBase64: Buffer.from('crop bytes').toString('base64') }, history: ['first'] };
    library.sync(target, original, { forgeContext: context, skinRefs: [skin] });
    const first = library.library()[0].activeVersionId!;
    const edited = { ...original, title: 'Edited controls' };
    library.saveSetupContext('lamp', { forgeContext: { ...context, history: ['first', 'edit'] } }, edited);
    const restored = new TagStore(path);
    expect(restored.get('lamp')).toMatchObject({ uiSpec: edited, evidence: target.evidence, research: target.research, forgeContext: { ...context, history: ['first', 'edit'] }, skinRefs: [skin] });
    expect(restored.readAsset(skin.hash, skin.ext)?.toString()).toBe('skin bytes');
    expect(readFileSync(path, 'utf8')).not.toContain(context.crop.jpegBase64);
    expect(readdirSync(join(path.replace('/library.json', ''), 'library/assets'))).toHaveLength(2);
    expect(restored.restoreVersion('lamp', first)?.uiSpec).toEqual(original);
    expect(restored.library()[0].versions).toHaveLength(2);
  });

  it('stores the full display name and headset-local placement without trusting legacy coordinates', () => {
    const library = new TagStore();
    library.add(device(), 'Lamp', { x: 1, y: 1, z: -1 });
    const displayName = 'A'.repeat(120);
    library.rename('lamp', displayName);
    const placement = { headsetId: 'quest', origin: 'https://example.test', handle: 'anchor-1', panelOffset: { x: 0, y: 0.15, z: 0 }, fallback: { label: 'lamp', appearance: 'White shade' }, updatedAt: 1 };
    library.setPlacement('lamp', placement);
    expect(library.library()[0]).toMatchObject({ displayName, placement });
    expect(library.get('lamp')?.label).toHaveLength(80);
  });

  it.each(['malformed', 'missing'] as const)('a %s crop asset does not prevent other saved devices loading', (failure) => {
    const path = file();
    const library = new TagStore(path);
    for (const id of ['lamp', 'second']) {
      const target = device(id);
      library.add(target, id);
      library.sync(target, setup(target), { forgeContext: { crop: { jpegBase64: Buffer.from(`${id} crop`).toString('base64') } } });
    }
    const root = JSON.parse(readFileSync(path, 'utf8'));
    const crop = root.records[0].versions[0].forgeContext.crop;
    if (failure === 'malformed') crop.jpegBase64.$libraryAsset = { hash: 'invalid', path: '../wrong', ext: 'jpeg' };
    else rmSync(join(path.replace('/library.json', ''), crop.jpegBase64.$libraryAsset.path));
    writeFileSync(path, JSON.stringify(root));
    const restored = new TagStore(path);
    expect(() => restored.list()).not.toThrow();
    expect(restored.list()).toHaveLength(2);
    expect(restored.get('lamp')).toMatchObject({ armed: true, forgeContext: { crop: { jpegBase64: undefined } } });
    expect(restored.get('second')).toMatchObject({ armed: true, forgeContext: { crop: { jpegBase64: Buffer.from('second crop').toString('base64') } } });
  });
});
