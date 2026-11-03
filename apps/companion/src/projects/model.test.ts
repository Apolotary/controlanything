import { describe, expect, it, vi } from 'vitest';
import type { ProjectDocument, ProjectStatePayload } from '@ce/protocol';
import { ProjectStudio } from './model';

const document = (revision = 1): ProjectDocument => ({ projectId: 'project-one', revision, createdAt: 1, prompt: 'An orb', source: 'fixture', modelId: 'fixture', spec: {
  title: 'Orb', description: 'A silent orb', html: '<div></div>', css: '', js: '', actions: [{ id: 'amount', label: 'Intensity', kind: 'number', min: 0, max: 1, initial: .5 }, { id: 'shuffle', label: 'Shuffle', kind: 'trigger' }],
} });
const ready = (revision = 1): ProjectStatePayload => ({ projectId: 'project-one', status: 'ready', document: document(revision), revision, sequence: 0, values: { amount: .5, shuffle: 0 } });
function setup() { const send = vi.fn(() => true); const model = new ProjectStudio(send); model.connection(true, true); model.select('project-one'); model.receive(ready()); send.mockClear(); return { send, model }; }

describe('Muse Canvas studio state', () => {
  it('creates the built-in demo explicitly and selects only its acknowledged project', () => {
    const { model, send } = setup();
    expect(model.createChordDemo()).toBe(true);
    const requestId = model.pending!.requestId;
    expect(model.pending?.preset).toBe(true);
    expect(send).toHaveBeenLastCalledWith('project.preset', { requestId, presetId: 'chord-garden-v1' });
    expect(model.createChordDemo()).toBe(false);
    model.receive({ ...ready(), projectId: 'chords', requestId, document: { ...document(), projectId: 'chords', source: 'preset', presetId: 'chord-garden-v1' } });
    expect(model.selectedId).toBe('chords'); expect(model.pending).toBeUndefined();
    model.connection(false, true); expect(model.createChordDemo()).toBe(false);
    model.connection(true, false); expect(model.createChordDemo()).toBe(false);
  });
  it('sends version-bound numeric and trigger actions, rejects undeclared/out-of-range values', () => {
    const { send, model } = setup();
    expect(model.action('amount', .7)).toBe(true);
    expect(send).toHaveBeenLastCalledWith('project.action', expect.objectContaining({ projectId: 'project-one', revision: 1, actionId: 'amount', value: .7 }));
    expect(model.action('shuffle')).toBe(true);
    for (const invalid of [NaN, Infinity, -.1, 1.1]) expect(model.action('amount', invalid)).toBe(false);
    expect(model.action('amount')).toBe(false); expect(model.action('shuffle', 1)).toBe(false); expect(model.action('undeclared', 1)).toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('cannot generate or change state while disconnected, read-only, or generating', () => {
    const { model } = setup(); model.connection(false, true);
    expect(model.request('New version')).toBe(false); expect(model.action('amount', .8)).toBe(false);
    model.connection(true, false); expect(model.request('New version')).toBe(false); expect(model.action('amount', .8)).toBe(false);
    model.connection(true, true); model.receive({ ...ready(), status: 'generating' }); expect(model.action('amount', .8)).toBe(false);
  });
  it('merges action-only updates without losing generated code and ignores stale revisions/sequences', () => {
    const { model } = setup(); model.receive({ projectId: 'project-one', status: 'ready', revision: 1, sequence: 2, values: { amount: .9, shuffle: 0 } });
    expect(model.document?.spec.title).toBe('Orb'); expect(model.current?.values?.amount).toBe(.9);
    model.receive({ projectId: 'project-one', status: 'ready', revision: 1, sequence: 1, values: { amount: .1 } });
    expect(model.current?.values?.amount).toBe(.9);
    model.receive(ready(2)); model.receive({ projectId: 'project-one', status: 'ready', revision: 1, sequence: 90, values: { amount: .2 } });
    model.receive(ready(1)); expect(model.document?.revision).toBe(2); expect(model.current?.values?.amount).toBe(.5);
  });
  it('adopts only the new project created by its request and ignores a cancelled late result', () => {
    const { model, send } = setup(); model.select(undefined); model.request('A new scene');
    const requestId = model.pending!.requestId;
    model.receive({ ...ready(), projectId: 'unrelated', document: { ...document(), projectId: 'unrelated' } }); expect(model.selectedId).toBeUndefined();
    model.receive({ projectId: 'new-project', requestId, status: 'generating' }); expect(model.selectedId).toBe('new-project');
    model.cancel(); expect(send).toHaveBeenLastCalledWith('project.cancel', { projectId: 'new-project', requestId });
    expect(model.current?.status).toBe('error');
    model.receive({ ...ready(), projectId: 'new-project', requestId, document: { ...document(), projectId: 'new-project' } });
    expect(model.document).toBeUndefined();
    expect(model.request('Try a new idea')).toBe(true);
  });
  it('edits the exact saved revision and keeps project selection on unrelated broadcasts', () => {
    const { model, send } = setup(); model.request('More colorful');
    expect(send).toHaveBeenLastCalledWith('project.request', expect.objectContaining({ projectId: 'project-one', baseRevision: 1, prompt: 'More colorful' }));
    model.receive({ ...ready(), projectId: 'project-two', document: { ...document(), projectId: 'project-two' } }); expect(model.selectedId).toBe('project-one');
  });
  it('cancels a new generation when its project ID arrives after the Cancel click', () => {
    const { model, send } = setup(); model.select(undefined); model.request('A new scene'); const requestId = model.pending!.requestId;
    model.cancel(); send.mockClear();
    model.receive({ projectId: 'late-project', status: 'generating', requestId });
    expect(send).toHaveBeenCalledExactlyOnceWith('project.cancel', { projectId: 'late-project', requestId });
    model.receive({ ...ready(), projectId: 'late-project', requestId });
    expect(send).toHaveBeenCalledTimes(1); expect(model.selectedId).toBeUndefined(); expect(model.document).toBeUndefined();
  });
});
