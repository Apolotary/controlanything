import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CanvasSpec } from '@ce/protocol';
import { CanvasStore } from './store';

export const spec: CanvasSpec = { title: 'Cover adventure', intro: 'An original story inspired by a visible cover.', objectUse: 'Look at the cover for inspiration.',
  rounds: [{ id: 'one', prompt: 'Pick a path.', choices: [{ id: 'forest', label: 'Forest', points: 3, feedback: 'A curious path.' }, { id: 'sea', label: 'Sea', points: 1, feedback: 'A wide horizon.' }] }], ending: 'Your story begins.' };
const roots: string[] = [];
const file = () => { const root = mkdtempSync(join(tmpdir(), 'ce-canvas-')); roots.push(root); return join(root, 'canvas.json'); };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const input = (title = spec.title) => ({ spec: { ...spec, title }, source: 'fixture' as const, modelId: 'fixture', prompt: 'Make a game' });

describe('canvas history', () => {
  it('persists bounded revisions and restores as a new revision with original provenance', () => {
    const path = file(); let store = new CanvasStore(path);
    const first = store.commit('book', input());
    for (let revision = 2; revision <= 10; revision++) store.commit('book', input(`Game ${revision}`), revision - 1);
    store = new CanvasStore(path);
    expect(store.get('book')!.history.map((item) => item.revision)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(() => store.restore('book', 1, 10)).toThrow('no longer');
    const restored = store.restore('book', 3, 10);
    expect(restored).toMatchObject({ canvasId: first.canvasId, revision: 11, source: 'fixture', modelId: 'fixture', spec: { title: 'Game 3' } });
    expect(new CanvasStore(path).get('book')).toEqual(restored);
    expect(JSON.parse(readFileSync(path, 'utf8')).records[0].versions).toHaveLength(8);
  });
  it('rejects stale edits without changing stored content and returns detached snapshots', () => {
    const store = new CanvasStore(); const first = store.commit('book', input());
    expect(() => store.commit('book', input('stale'))).toThrow('changed');
    expect(() => store.restore('book', 1, 99)).toThrow('changed');
    first.spec.title = 'mutated';
    expect(store.get('book')!.spec.title).toBe(spec.title);
  });
  it('tolerates corrupt files, caps objects and forgets saved software history', () => {
    const path = file(); writeFileSync(path, '{bad');
    const store = new CanvasStore(path); expect(store.warnings).toHaveLength(1);
    for (let i = 0; i < 65; i++) store.commit(`object-${i}`, input());
    expect(store.list()).toHaveLength(64); expect(store.get('object-0')).toBeUndefined();
    store.forget('object-64'); expect(new CanvasStore(path).get('object-64')).toBeUndefined();
  });
});
