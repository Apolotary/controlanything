import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { proposeGestureMap } from '../devices/gestures';
import { boundedInteractionReferences, MAX_REFERENCE_CHARACTERS, type InteractionReferenceQuery } from '../gen3d/interactionReferences';
import { interactionReferences } from './interaction-references';
import { LibraryRecord } from './library-schema';
import { TagStore } from './tags';

const folders: string[] = [];
afterEach(() => folders.splice(0).forEach((folder) => rmSync(folder, { recursive: true, force: true })));
function saved(id: string, options: { maker?: string; model?: string; category?: string; label?: string } = {}): LibraryRecord {
  const driver = { driverId: `driver-${id}`, cardId: id, transport: 'local' as const, executor: { deviceId: 'private-executor', port: 'private-port' }, provenance: [],
    actions: [{ actionId: `private-action-${id}`, label: options.label ?? 'System volume', kind: 'set' as const,
      range: { min: 0, max: 100, step: 1 }, encode: { kind: 'local' as const, op: 'volume' as const, arg: '$value' } }] };
  const verification = { [driver.actions[0].actionId]: 'pass' as const };
  return LibraryRecord.parse({ cardId: id, displayName: id, hidden: false,
    identity: { label: id, maker: options.maker ?? 'Acme', model: options.model ?? 'Speaker', category: options.category ?? 'audio' },
    position: { x: 0, y: 0, z: -1 }, createdAt: 1, updatedAt: 1, enabled: true, activeVersionId: `version-${id}`,
    versions: [{ versionId: `version-${id}`, createdAt: 1, driver, verification, evidence: [], specId: `spec-${id}`,
      uiSpec: { specId: `spec-${id}`, cardId: id, driverId: driver.driverId, source: 'live',
        widgets: [{ id: 'private-widget', kind: 'fader', label: 'Volume', binding: { action: driver.actions[0].actionId, driverId: driver.driverId }, layout: { size: 'l' } }],
        gestureMap: proposeGestureMap(driver, verification) } }],
  });
}
function query(): InteractionReferenceQuery {
  return { device: { cardId: 'new', name: 'New speaker', maker: 'Acme', model: 'Speaker', category: 'audio' },
    driver: { driverId: 'new-driver', cardId: 'new', transport: 'local', actions: [{ actionId: 'new-volume', label: 'Volume', kind: 'set', range: { min: 0, max: 1 } }] },
    verification: { 'new-volume': 'pass' }, request: 'Make a volume control' };
}

describe('saved interaction retrieval', () => {
  it('ranks exact identity, then category, then compatible semantics without depending on action ids', () => {
    const exact = saved('exact');
    const category = saved('category', { model: 'Other' });
    const semantics = saved('semantics', { model: 'Other', category: 'computer' });
    const older = saved('older', { model: 'Other', category: 'computer' });
    older.updatedAt = 0;
    const refs = interactionReferences([older, semantics, category, exact], query());
    expect(refs.map((reference) => reference.device.name)).toEqual(['exact', 'category', 'semantics']);
    expect(refs[0]).toMatchObject({ source: 'saved-library', origin: 'live', actions: [{ label: 'System volume', kind: 'set', range: { min: 0, max: 100, step: 1 } }],
      controls: [{ label: 'Volume', archetype: 'fader', size: 'l' }], gestures: [{ gesture: 'right_height', control: 'System volume' }] });
    const serialized = JSON.stringify(refs);
    for (const secret of ['private-', 'driver-', 'spec-', 'version-', 'encode', 'executor', 'verification', 'pass']) expect(serialized).not.toContain(secret);
  });

  it('excludes hidden, disabled, candidate-only, incomplete, mismatched and unrelated setups', () => {
    const records = Array.from({ length: 10 }, (_, i) => saved(`case-${i}`));
    records[0].hidden = true;
    records[1].enabled = false;
    records[2].candidateVersionId = records[2].activeVersionId;
    records[2].activeVersionId = undefined;
    records[3].versions[0].verification = {};
    records[4].versions[0].uiSpec.widgets = undefined;
    records[5].versions[0].driver.transport = 'midi';
    records[6].versions[0].driver.actions[0].label = 'Brightness 0-100';
    records[7].versions[0].uiSpec.driverId = 'stale-driver';
    records[8].versions[0].uiSpec.check = { ok: false, attempts: 1, errors: 1, warnings: 0 };
    records[9].versions[0].driver.actions[0].kind = 'trigger';
    const request = query();
    request.driver.actions[0].label = 'Volume 0-100';
    expect(interactionReferences(records, request)).toEqual([]);
    expect(interactionReferences([saved('ok')], { ...request, verification: {} })).toEqual([]);
  });

  it('uses only active versions and current verified controls, not unaccepted candidate preferences', () => {
    const record = saved('active');
    const candidate = structuredClone(record.versions[0]);
    candidate.versionId = 'pending-version';
    candidate.uiSpec.widgets![0].kind = 'knob';
    candidate.uiSpec.gestureMap!.axes[0].axis = 'right_roll';
    record.versions.push(candidate);
    record.candidateVersionId = candidate.versionId;
    expect(interactionReferences([record], query())[0]).toMatchObject({ controls: [{ archetype: 'fader' }], gestures: [{ gesture: 'right_height' }] });
  });

  it('reads saved preferences after restart and immediately honors disable, hide and Forget', () => {
    const folder = mkdtempSync(join(tmpdir(), 'ce-reference-'));
    folders.push(folder);
    const file = join(folder, 'library.json');
    writeFileSync(file, JSON.stringify({ version: 2, records: [saved('speaker')] }));
    const first = new TagStore(file);
    expect(interactionReferences(first.library(), query())).toHaveLength(1);
    const restored = new TagStore(file);
    expect(interactionReferences(restored.library(), query())).toEqual(interactionReferences(first.library(), query()));
    restored.setEnabled('speaker', false);
    expect(interactionReferences(restored.library(), query())).toEqual([]);
    restored.setEnabled('speaker', true);
    restored.remove('speaker');
    expect(interactionReferences(restored.library(), query())).toEqual([]);
    restored.forget('speaker');
    expect(interactionReferences(new TagStore(file).library(), query())).toEqual([]);
  });

  it('caps examples and prompt size, strips provider extras, and labels fixture references', () => {
    const record = saved('fixture');
    record.versions[0].uiSpec.source = 'fixture';
    const reference = interactionReferences([record], query())[0];
    expect(reference.origin).toBe('fixture');
    const polluted = { ...reference, executable: { encode: 'secret' }, actions: reference.actions.map((action) => ({ ...action, actionId: 'secret' })) };
    const bounded = boundedInteractionReferences([null, { broken: true }, ...Array(20).fill(polluted)]);
    expect(bounded).toHaveLength(3);
    expect(JSON.stringify(bounded)).not.toContain('secret');
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(MAX_REFERENCE_CHARACTERS);
    const huge = { ...reference, controls: Array(6).fill({ label: '\\'.repeat(60), archetype: '\\'.repeat(32) }),
      actions: Array(6).fill({ label: '\\'.repeat(60), kind: 'set', range: { min: -Number.MAX_VALUE, max: Number.MAX_VALUE } }),
      gestures: Array(6).fill({ gesture: '\\'.repeat(32), control: '\\'.repeat(60) }) };
    expect(JSON.stringify(boundedInteractionReferences(Array(10).fill(huge))).length).toBeLessThanOrEqual(MAX_REFERENCE_CHARACTERS);
  });
});
