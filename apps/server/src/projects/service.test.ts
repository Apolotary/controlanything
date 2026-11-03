import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ProjectSpec, type ProjectStatePayload } from '@ce/protocol';
import { FixtureMuse } from '../muse/adapter';
import { ProjectStore } from './store';
import { ProjectService } from './service';
import { registerProjectFixture, PROJECT_FIXTURE } from './fixture';

function harness(file?: string, now?: () => number) {
  const muse = new FixtureMuse({ log: () => {} }); registerProjectFixture(muse);
  const states: ProjectStatePayload[] = [], replies: ProjectStatePayload[] = [], store = new ProjectStore(file);
  const service = new ProjectService({ muse, store, now, broadcast: (s) => states.push(s), send: (_sender, s) => replies.push(s), catalog: () => {} });
  const create = () => service.request('mac', { requestId: 'create', prompt: 'Make a silent interactive orb' });
  const id = () => states[0].projectId;
  return { muse, store, service, states, replies, create, id };
}
describe('Muse project contracts and shared state', () => {
  it('stores a generated AR recipe as bounded data and retains the old revision when its binding is invalid', async () => {
    const h = harness(); await h.create(); const projectId = h.id();
    expect(h.service.snapshot(projectId)?.document?.spec.spatial).toEqual({ kind: 'orb', color: '#80eec2', actionId: 'amount' });
    expect(h.service.snapshot(projectId)?.preview?.count).toBe(0);
    const real = h.muse.chatJson.bind(h.muse);
    vi.spyOn(h.muse, 'chatJson').mockImplementation(async (...args) => {
      const result = await real(...args);
      return { ...result, data: { ...(result.data as ProjectSpec), spatial: { kind: 'ripples', color: '#40ccff', actionId: 'notDeclared' } } } as typeof result;
    });
    expect(await h.service.request('mac', { projectId, baseRevision: 1, requestId: 'bad-scene', prompt: 'Make ripple rings' })).toBe(false);
    expect(h.service.snapshot(projectId)?.document?.revision).toBe(1);
    expect(h.service.snapshot(projectId)?.document?.spec.spatial?.kind).toBe('orb');
    expect(h.states.at(-1)?.status).toBe('error'); h.service.close();
  });

  it('creates an explicit software-only chord preset once without Muse, preview or device execution', () => {
    const h = harness(), model = vi.spyOn(h.muse, 'chatJson');
    const input = { requestId: 'chords', presetId: 'chord-garden-v1' as const };
    expect(h.service.preset('mac', input)).toBe(true);
    const state = h.states.at(-1)!;
    expect(state).toMatchObject({ status: 'ready', requestId: 'chords', revision: 1, preview: { count: 0 },
      document: { source: 'preset', presetId: 'chord-garden-v1', spec: { title: 'Chord Garden' } },
      values: { chord_c: 0, chord_am: 0, chord_f: 0, chord_g: 0, silence: 0 } });
    expect(state.document?.spec.actions).toHaveLength(5);
    expect(state.document?.spec.actions.every(a => a.kind === 'trigger')).toBe(true);
    expect(model).not.toHaveBeenCalled();
    expect(h.service.preset('mac', input)).toBe(false);
    expect(h.service.catalog().projects).toHaveLength(1);
    expect(h.replies.at(-1)?.projectId).toBe(state.projectId);
    expect(h.service.action('quest', { requestId: 'not-running', projectId: state.projectId, revision: 1, actionId: 'chord_c', requirePreview: true })).toBe(false);
    h.service.preview('sound-tab', { projectId: state.projectId, revision: 1, active: true });
    expect(h.service.action('quest', { requestId: 'play', projectId: state.projectId, revision: 1, actionId: 'chord_c', requirePreview: true })).toBe(true);
    expect(h.service.snapshot(state.projectId)?.values?.chord_c).toBe(1);
    h.service.close();
  });
  it('preserves an authored starter on failure but strips its trusted identity after a Muse edit', async () => {
    const h = harness(); h.service.preset('mac', { requestId: 'chords', presetId: 'chord-garden-v1' });
    const projectId = h.id();
    const model = vi.spyOn(h.muse, 'chatJson').mockRejectedValueOnce(new Error('failed'));
    expect(await h.service.request('mac', { projectId, requestId: 'failed', baseRevision: 1, prompt: 'Change the look' })).toBe(false);
    expect(h.service.snapshot(projectId)?.document).toMatchObject({ source: 'preset', presetId: 'chord-garden-v1', revision: 1 });
    model.mockRestore();
    expect(await h.service.request('mac', { projectId, requestId: 'edited', baseRevision: 1, prompt: 'Change the look' })).toBe(true);
    const changed = h.service.snapshot(projectId)?.document;
    expect(changed).toMatchObject({ source: 'fixture', revision: 2 });
    expect(changed?.presetId).toBeUndefined();
    h.service.close();
  });
  it('retains preset provenance on disk and does not restore a running preview', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ce-chord-preset-')); const file = join(dir, 'projects.json');
    try {
      const h = harness(file); h.service.preset('mac', { requestId: 'chords', presetId: 'chord-garden-v1' });
      const projectId = h.id(); h.service.preview('old-tab', { projectId, revision: 1, active: true }); h.service.close();
      const restored = harness(file);
      expect(restored.service.snapshot(projectId)).toMatchObject({ document: { source: 'preset', presetId: 'chord-garden-v1' }, preview: { count: 0 } });
      restored.service.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('gates AR inputs on a current single preview lease and broadcasts stop/recovery across duplicates, expiry and edits', async () => {
    let now = 100; const h = harness(undefined, () => now); await h.create(); const projectId = h.id();
    const action = (requestId: string) => h.service.action('quest', { projectId, revision: 1, requestId, actionId: 'amount', value: .8, requirePreview: true });
    expect(action('none')).toBe(false);
    h.service.preview('socket-a', { projectId, revision: 2, active: true }); expect(h.service.snapshot(projectId)?.preview?.count).toBe(0);
    h.service.preview('socket-a', { projectId, revision: 1, active: true }); expect(action('ready')).toBe(true);
    const count = h.states.length;
    h.service.preview('socket-a', { projectId, revision: 1, active: true }); expect(h.states).toHaveLength(count);
    h.service.preview('socket-b', { projectId, revision: 1, active: true }); expect(action('duplicate')).toBe(false);
    h.service.disconnectPreview('socket-a'); expect(h.states.at(-1)?.preview?.count).toBe(1);
    now += 6000;
    expect(action('stale')).toBe(false);
    h.service.preview('socket-b', { projectId, revision: 1, active: true });
    expect(h.states.slice(-2).map(s => s.preview?.count)).toEqual([0, 1]);
    now += 6000; h.service.sweepPreviews(); expect(h.states.at(-1)?.preview?.count).toBe(0);
    h.service.preview('socket-b', { projectId, revision: 1, active: true });
    await h.service.request('mac', { projectId, requestId: 'edit', baseRevision: 1, prompt: 'Make it blue' });
    expect(h.service.snapshot(projectId)?.preview?.count).toBe(0);
    h.service.preview('socket-b', { projectId, revision: 1, active: true }); expect(h.service.snapshot(projectId)?.preview?.count).toBe(0);
    h.service.close();
  });
  it('rejects duplicate/reserved action ids, invalid ranges and extra capabilities', () => {
    expect(ProjectSpec.safeParse({ ...PROJECT_FIXTURE, actions: [...PROJECT_FIXTURE.actions, PROJECT_FIXTURE.actions[0]] }).success).toBe(false);
    expect(ProjectSpec.safeParse({ ...PROJECT_FIXTURE, actions: [{ id: 'constructor', label: 'x', kind: 'trigger' }] }).success).toBe(false);
    expect(ProjectSpec.safeParse({ ...PROJECT_FIXTURE, actions: [{ id: 'amount', label: 'x', kind: 'number', min: 1, max: 0, initial: 2 }] }).success).toBe(false);
    expect(ProjectSpec.safeParse({ ...PROJECT_FIXTURE, actions: [{ id: 'run', label: 'x', kind: 'trigger', capability: 'midi' }] }).success).toBe(false);
  });
  it('generates actual fixture HTML then shares numeric and exactly-once trigger inputs without resending code', async () => {
    const h = harness(); expect(await h.create()).toBe(true);
    expect(h.states.at(-1)).toMatchObject({ status: 'ready', revision: 1, document: { source: 'fixture', spec: { html: expect.stringContaining('<main>') } }, values: { amount: 0.5, shuffle: 0 } });
    expect(h.service.action('quest', { projectId: h.id(), requestId: 'move', revision: 1, actionId: 'amount', value: 0.9 })).toBe(true);
    expect(h.states.at(-1)).toMatchObject({ revision: 1, values: { amount: 0.9 } }); expect(h.states.at(-1)?.document).toBeUndefined();
    const trigger = { projectId: h.id(), requestId: 'tap', revision: 1, actionId: 'shuffle' };
    h.service.action('mac', trigger); h.service.action('mac', trigger);
    expect(h.service.snapshot(h.id())?.values).toEqual({ amount: 0.9, shuffle: 1 });
    expect(h.service.action('mac', { ...trigger, actionId: 'amount', value: 0.2 })).toBe(false);
    expect(h.replies.at(-1)?.message).toContain('reused'); h.service.close();
  });
  it('rejects stale/out-of-range/unknown inputs and pauses input during generation', async () => {
    const h = harness(); await h.create(); const projectId = h.id();
    for (const [requestId, patch] of [['range', { value: 100 }], ['missing', { actionId: 'noSuch' }], ['stale', { revision: 2 }]] as const)
      expect(h.service.action('quest', { projectId, requestId, revision: 1, actionId: 'amount', value: 0.8, ...patch })).toBe(false);
    const edit = h.service.request('mac', { projectId, requestId: 'edit', prompt: 'Change the colors', baseRevision: 1 });
    expect(h.service.action('quest', { projectId, requestId: 'during', revision: 1, actionId: 'amount', value: 0.8 })).toBe(false);
    await edit; expect(h.service.snapshot(projectId)?.revision).toBe(2);
    expect(h.service.action('quest', { projectId, requestId: 'old', revision: 1, actionId: 'amount', value: 0.8 })).toBe(false);
    expect(await h.service.request('mac', { projectId, requestId: 'stale-edit', prompt: 'Old edit', baseRevision: 1 })).toBe(false); h.service.close();
  });
  it.each(['cancel', 'disconnect'])('discards late generation after %s and retains accepted document', async (reason) => {
    const h = harness(); await h.create(); const projectId = h.id();
    const real = h.muse.chatJson.bind(h.muse); let release!: () => void; const barrier = new Promise<void>((r) => release = r);
    vi.spyOn(h.muse, 'chatJson').mockImplementation(async (...args) => { const value = await real(...args); await barrier; return value; });
    const edit = h.service.request('mac', { projectId, requestId: 'edit', prompt: 'New version', baseRevision: 1 });
    if (reason === 'cancel') h.service.cancel('mac', projectId, 'edit'); else h.service.disconnect('mac');
    release(); expect(await edit).toBe(false); expect(h.service.snapshot(projectId)?.revision).toBe(1); h.service.close();
  });
  it('keeps accepted project on generation failure and reloads its last shared state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ce-project-test-')); const file = join(dir, 'projects.json');
    try {
      const h = harness(file); await h.create(); const id = h.id();
      h.service.action('quest', { projectId: id, requestId: 'move', revision: 1, actionId: 'amount', value: 0.7 });
      vi.spyOn(h.muse, 'chatJson').mockRejectedValue(new Error('failed'));
      expect(await h.service.request('mac', { projectId: id, requestId: 'edit', prompt: 'Edit', baseRevision: 1 })).toBe(false);
      expect(h.states.at(-1)).toMatchObject({ status: 'error', revision: 1, values: { amount: 0.7 } }); h.service.close();
      expect(new ProjectStore(file).get(id)).toMatchObject({ document: { revision: 1, source: 'fixture' }, values: { amount: 0.7 } });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
