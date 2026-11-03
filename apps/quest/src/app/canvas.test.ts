import { describe, expect, it, vi } from 'vitest';
import { initialCanvasGame, type CanvasDocument, type CanvasSpec, type CanvasStatePayload } from '@ce/protocol';
import { ObjectCanvas, type CanvasTarget } from './canvas';

const spec: CanvasSpec = { title: 'Book explorer', intro: 'Look at your book and choose what to investigate.', objectUse: 'Use the cover as a clue.',
  rounds: [{ id: 'cover', prompt: 'What would you inspect first?', choices: [
    { id: 'title', label: 'The title', points: 2, feedback: 'A useful clue.' }, { id: 'spine', label: 'The spine', points: 1, feedback: 'Another clue.' },
  ] }], ending: 'You explored the object.' };
const document = (revision = 1, cardId = 'book'): CanvasDocument => ({ canvasId: `canvas-${cardId}`, cardId, revision, spec, source: 'fixture', prompt: 'A book game',
  history: revision > 1 ? [{ revision: 1, title: 'First game' }] : [], updatedAt: revision });
const ready = (revision = 1, requestId?: string, cardId = 'book'): CanvasStatePayload => ({ cardId, requestId, status: 'ready', document: document(revision, cardId), game: initialCanvasGame(spec) });
function setup() {
  let selected: CanvasTarget | undefined = { targetId: 'target-book', cardId: 'book' };
  const send = vi.fn<(...args: [string, unknown]) => boolean>(() => true), render = vi.fn(), pauseControls = vi.fn();
  const canvas = new ObjectCanvas({ selected: () => selected, send, render, pauseControls }); canvas.syncSelection();
  const request = (kind = 'canvas.request') => send.mock.calls.filter(([type]) => type === kind).at(-1)?.[1] as { requestId: string; cardId: string; revision?: number; baseRevision?: number };
  return { canvas, send, render, pauseControls, request, select: (value?: CanvasTarget) => { selected = value; canvas.syncSelection(); } };
}

describe('object canvas client lifecycle', () => {
  it('loads on selection once and prevents delayed get snapshots from overriding a newer generation', () => {
    const f = setup(); f.canvas.syncSelection(); expect(f.send).toHaveBeenCalledExactlyOnceWith('canvas.get', { cardId: 'book' });
    f.canvas.openOrCreate('target-book'); const id = f.request().requestId;
    f.canvas.receive(ready(1)); expect(f.render.mock.lastCall?.[0].state.status).toBe('generating');
    f.canvas.receive(ready(2, id)); expect(f.render.mock.lastCall?.[0].state.document.revision).toBe(2);
    f.canvas.receive(ready(1)); expect(f.render.mock.lastCall?.[0].state.document.revision).toBe(2);
    expect(f.pauseControls).toHaveBeenCalled(); expect(f.send.mock.calls.every(([type]) => type.startsWith('canvas.'))).toBe(true);
  });

  it('does not reopen a closed panel for cancelled or unrelated shared states', () => {
    const f = setup(); f.canvas.openOrCreate('target-book'); const id = f.request().requestId;
    f.canvas.close('target-book'); expect(f.send).toHaveBeenCalledWith('canvas.cancel', { requestId: id, cardId: 'book' });
    f.canvas.receive(ready(1, id)); f.canvas.receive(ready(2, 'another-client')); expect(f.render).toHaveBeenLastCalledWith(null);
    f.canvas.openOrCreate('target-book'); f.canvas.receive(ready(2, f.request().requestId)); f.canvas.close();
    f.canvas.receive(ready(3, 'mac-edit')); expect(f.render).toHaveBeenLastCalledWith(null); expect(f.canvas.open).toBe(false);
  });

  it('cancels work on selection, annotation and disconnect and ignores late results for old cards', () => {
    const f = setup(); f.canvas.openOrCreate('target-book'); const id = f.request().requestId;
    f.select({ targetId: 'target-lamp', cardId: 'lamp' }); f.canvas.receive(ready(1, id)); expect(f.render).toHaveBeenLastCalledWith(null);
    f.canvas.receive(ready(1, undefined, 'lamp')); expect(f.render.mock.lastCall?.[0].targetId).toBe('target-lamp');
    f.select(); expect(f.render).toHaveBeenLastCalledWith(null);
    f.select({ targetId: 'target-book', cardId: 'book' }); f.canvas.openOrCreate('target-book'); const later = f.request().requestId;
    f.canvas.disconnect(); f.canvas.receive(ready(1, later)); expect(f.render).toHaveBeenLastCalledWith(null);
  });

  it('sends revision-bound game actions and ignores duplicates and superseded responses', () => {
    const f = setup(); f.canvas.receive(ready(2));
    f.canvas.action('target-book', { revision: 1, action: 'play' }); expect(f.request('canvas.action')).toBeUndefined();
    f.canvas.action('target-book', { revision: 2, action: 'play' }); const id = f.request('canvas.action').requestId;
    f.canvas.action('target-book', { revision: 2, action: 'play' }); expect(f.send.mock.calls.filter(([type]) => type === 'canvas.action')).toHaveLength(1);
    f.canvas.receive({ ...ready(2, id), game: { ...initialCanvasGame(spec), phase: 'playing' } });
    f.canvas.receive(ready(2, id)); expect(f.render.mock.lastCall?.[0].state.game.phase).toBe('playing');
    f.canvas.receive({ ...ready(2, 'mac-answer'), game: { ...initialCanvasGame(spec), phase: 'feedback', feedback: 'A clue', choiceId: 'title', score: 2 } });
    expect(f.render.mock.lastCall?.[0].state.game.phase).toBe('feedback');
  });

  it('restores only a real previous revision and displays the server new draft', () => {
    const f = setup(); f.canvas.receive(ready(2));
    f.canvas.restore('target-book', 1, 1); f.canvas.restore('target-book', 9, 2); expect(f.request('canvas.restore')).toBeUndefined();
    f.canvas.restore('target-book', 1, 2); expect(f.request('canvas.restore')).toMatchObject({ revision: 1, baseRevision: 2 });
    expect(f.render.mock.lastCall?.[0].state.status).toBe('generating');
    f.canvas.receive(ready(3, f.request('canvas.restore').requestId)); expect(f.render.mock.lastCall?.[0].state.game.phase).toBe('preview');
  });

  it('admits only the selected voice request and cancels its generation without accepting its late reply', () => {
    const f = setup(); f.canvas.receive({ cardId: 'book', status: 'ready' });
    f.canvas.allowVoice('target-book', 'voice-edit'); expect(f.canvas.open).toBe(false);
    f.canvas.receive({ cardId: 'book', requestId: 'unrelated-voice', status: 'generating' }); expect(f.canvas.open).toBe(false);
    f.canvas.receive({ cardId: 'book', requestId: 'voice-edit', status: 'generating' }); expect(f.canvas.open).toBe(true);
    f.canvas.cancelVoice('voice-edit'); expect(f.send).toHaveBeenCalledWith('canvas.cancel', { requestId: 'voice-edit', cardId: 'book' });
    f.canvas.receive(ready(1, 'voice-edit')); expect(f.render).toHaveBeenLastCalledWith(null);
  });

  it('fetches Mac edits made while closed and disables stale actions until the authoritative state arrives', () => {
    const f = setup(); f.canvas.receive(ready()); f.canvas.close();
    f.canvas.receive(ready(2, 'mac-edit')); expect(f.canvas.open).toBe(false);
    f.canvas.openOrCreate('target-book'); expect(f.send).toHaveBeenLastCalledWith('canvas.get', { cardId: 'book' });
    expect(f.render.mock.lastCall?.[0].state.status).toBe('generating');
    expect(f.render.mock.lastCall?.[0].state.document.revision).toBe(1);
    f.canvas.action('target-book', { revision: 1, action: 'play' }); expect(f.request('canvas.action')).toBeUndefined();
    f.canvas.receive(ready(2)); expect(f.render.mock.lastCall?.[0].state.document.revision).toBe(2);
    f.canvas.action('target-book', { revision: 1, action: 'play' }); expect(f.request('canvas.action')).toBeUndefined();
    f.canvas.action('target-book', { revision: 2, action: 'play' }); expect(f.request('canvas.action')).toMatchObject({ revision: 2 });
    expect(f.request()).toBeUndefined();
  });

  it('reports send failures while preserving the saved document', () => {
    const f = setup(); f.canvas.receive(ready());
    f.send.mockReturnValue(false); f.canvas.action('target-book', { revision: 1, action: 'play' });
    expect(f.render.mock.lastCall?.[0].state.status).toBe('error'); expect(f.render.mock.lastCall?.[0].state.message).toContain('disconnected');
  });

  it.each(['empty', 'error'] as const)('resolves the loading view when fetching a saved game returns %s', (result) => {
    const f = setup(); f.canvas.receive(ready()); f.canvas.close(); f.canvas.openOrCreate('target-book');
    f.canvas.receive({ cardId: 'book', status: result === 'empty' ? 'ready' : 'error', ...(result === 'error' ? { message: 'Could not load the saved game.' } : {}) });
    if (result === 'empty') {
      expect(f.canvas.open).toBe(false); expect(f.canvas.hasDocument('book')).toBe(false); expect(f.render).toHaveBeenLastCalledWith(null);
      f.canvas.openOrCreate('target-book'); expect(f.request()).toBeDefined();
    } else {
      expect(f.render.mock.lastCall?.[0].state).toMatchObject({ status: 'error', message: 'Could not load the saved game.', document: { revision: 1 } });
      f.canvas.openOrCreate('target-book'); expect(f.send).toHaveBeenLastCalledWith('canvas.get', { cardId: 'book' }); expect(f.request()).toBeUndefined();
    }
  });
});
