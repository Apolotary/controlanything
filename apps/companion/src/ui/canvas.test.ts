import { initialCanvasGame, makeMessage, type CanvasDocument, type CanvasStatePayload, type PayloadOf } from '@ce/protocol';
import { describe, expect, it, vi } from 'vitest';
import { CompanionCanvas, type CanvasCommandType } from './canvas';

function document(cardId = 'book', revision = 1): CanvasDocument {
  return { canvasId: `canvas-${cardId}`, cardId, revision, source: 'fixture', modelId: 'fixture-canvas', prompt: 'Make an adventure',
    history: revision > 1 ? [{ revision: 1, title: 'First draft' }] : [], updatedAt: revision,
    spec: { title: 'The Missing Bookmark', intro: 'Follow a paper trail.', objectUse: 'Use the book as inspiration; no reading required.',
      rounds: [{ id: 'trail', prompt: 'Where will you look?', choices: [
        { id: 'cover', label: 'Inspect the cover', points: 2, feedback: 'You find a clue.' },
        { id: 'shelf', label: 'Search the shelf', points: 1, feedback: 'A faint trail remains.' },
      ] }], ending: 'You found the bookmark.' } };
}

function setup(writable = true) {
  const send = vi.fn((_type: CanvasCommandType, _payload: PayloadOf<CanvasCommandType>) => true);
  const model = new CompanionCanvas(send);
  model.setTags([{ cardId: 'book', label: 'Book', connection: 'offline' }, { cardId: 'lamp', label: 'Lamp', connection: 'ready' }]);
  model.connection(true, writable);
  send.mockClear();
  let time = 10;
  const state = (extra: Partial<CanvasStatePayload> = {}, ts = ++time, from = 'server') => {
    const doc = document(extra.cardId);
    return model.receive(makeMessage('canvas.state', { cardId: doc.cardId, status: 'ready', document: doc, game: initialCanvasGame(doc.spec), ...extra }, { ts, from }));
  };
  const requestId = () => (send.mock.calls.findLast(([type]) => type !== 'canvas.get')?.[1] as { requestId?: string } | undefined)?.requestId;
  return { model, send, state, requestId };
}

describe('companion object canvas', () => {
  it('requires a connected owner, but no hardware connection or executor, to create', () => {
    const { model, send } = setup(false);
    model.setDraft('Make a book adventure');
    expect(model.create()).toBe(false);
    model.connection(false, true);
    expect(model.create()).toBe(false);
    model.connection(true, true);
    send.mockClear();
    expect(model.create()).toBe(true);
    expect(send).toHaveBeenCalledExactlyOnceWith('canvas.request', expect.objectContaining({ cardId: 'book', prompt: 'Make a book adventure' }));
    expect(send.mock.calls[0]![1]).not.toHaveProperty('baseRevision');
  });

  it('keeps drafts and game state scoped to explicitly selected tagged objects', () => {
    const { model, send, state } = setup();
    model.setDraft('Book request');
    state(); state({ cardId: 'lamp' });
    model.select('lamp');
    expect(send).toHaveBeenLastCalledWith('canvas.get', { cardId: 'lamp' });
    expect(model.view().state?.document?.cardId).toBe('lamp');
    expect(model.view().draft).toBe('');
    model.setDraft('Lamp request'); model.select('book');
    expect(model.view().draft).toBe('Book request');
    model.select('not-tagged');
    expect(model.view().selected?.cardId).toBe('book');
  });

  it('ignores spoofed, mismatched, stale and removed-object updates', () => {
    const { model, state } = setup();
    expect(state({}, 20, 'another-mac')).toBe(false);
    expect(state({ document: document('lamp') })).toBe(false);
    expect(state({ document: document('book', 2) }, 20)).toBe(true);
    expect(state({}, 21)).toBe(false);
    expect(state({ document: document('book', 3) }, 19)).toBe(false);
    expect(model.view().state?.document?.revision).toBe(2);
    model.setTags([]);
    expect(state({}, 30)).toBe(false);
    expect(model.view().state).toBeUndefined();
  });

  it('waits for server state and blocks repeated actions without optimistic score changes', () => {
    const { model, send, state, requestId } = setup();
    state();
    expect(model.action('choose', 'cover')).toBe(false);
    expect(model.action('play')).toBe(true);
    expect(model.action('play')).toBe(false);
    expect(model.view().state?.game?.phase).toBe('preview');
    expect(model.view().cancellable).toBe(false);
    const doc = document();
    state({ requestId: requestId(), game: { ...initialCanvasGame(doc.spec), phase: 'playing' } });
    expect(model.action('choose', 'injected')).toBe(false);
    expect(model.action('choose', 'cover')).toBe(true);
    expect(send).toHaveBeenLastCalledWith('canvas.action', expect.objectContaining({ cardId: 'book', revision: 1, action: 'choose', roundId: 'trail', choiceId: 'cover' }));
    expect(model.view().state?.game?.score).toBe(0);
    state({ requestId: requestId(), game: { ...initialCanvasGame(doc.spec), phase: 'feedback', choiceId: 'cover', score: 2, feedback: 'You found a clue.' } });
    expect(model.action('next')).toBe(true);
    expect(send).toHaveBeenLastCalledWith('canvas.action', expect.objectContaining({ action: 'next', roundId: 'trail' }));
  });

  it('uses current revision for edits and restores only a grounded previous revision', () => {
    const { model, send, state } = setup();
    state();
    expect(model.restorePrevious()).toBe(false);
    state({ document: document('book', 2) });
    model.setDraft('  Make it harder  ');
    expect(model.create()).toBe(true);
    expect(send).toHaveBeenLastCalledWith('canvas.request', expect.objectContaining({ cardId: 'book', baseRevision: 2, prompt: 'Make it harder' }));
    const requestId = (send.mock.calls.at(-1)![1] as { requestId: string }).requestId;
    state({ requestId, document: document('book', 3) });
    expect(model.view().draft).toBe('');
    expect(model.restorePrevious()).toBe(true);
    expect(send).toHaveBeenLastCalledWith('canvas.restore', expect.objectContaining({ cardId: 'book', baseRevision: 3, revision: 1 }));
  });

  it('disables play during generation and sends cancellation for the actual request', () => {
    const { model, send, state } = setup();
    state();
    model.setDraft('A new ending'); model.create();
    const requestId = (send.mock.calls.at(-1)![1] as { requestId: string }).requestId;
    expect(model.cancel()).toBe(true);
    expect(send).toHaveBeenLastCalledWith('canvas.cancel', { cardId: 'book', requestId });
    state({ status: 'generating', requestId: 'quest-request' });
    expect(model.action('play')).toBe(false);
  });

  it('retains the last playable revision on a generation failure and retries without a stuck lock', () => {
    const { model, send, state, requestId } = setup();
    state(); model.setDraft('Add another round'); model.create();
    state({ requestId: requestId(), status: 'error', document: undefined, game: undefined, message: 'Try a shorter request.' });
    expect(model.view().state?.document?.revision).toBe(1);
    expect(model.view().draft).toBe('Add another round');
    expect(model.view().pending).toBe(false);
    send.mockReturnValue(false);
    expect(model.create()).toBe(false);
    expect(model.view().message).toContain('Could not send');
    expect(model.view().pending).toBe(false);
  });

  it('bounds text and refreshes authoritative state after reconnect without auto-playing', () => {
    const { model, send, state } = setup();
    state(); model.setDraft('a'.repeat(1100));
    expect(model.view().draft).toHaveLength(1000);
    model.action('play');
    model.connection(false, false);
    expect(model.view().pending).toBe(false);
    expect(model.action('play')).toBe(false);
    send.mockClear();
    model.connection(true, true);
    expect(send).toHaveBeenCalledExactlyOnceWith('canvas.get', { cardId: 'book' });
    expect(model.view().state?.game?.phase).toBe('preview');
  });

  it('does not complete an edit on an unrelated get, action or error response', () => {
    const { model, state, requestId } = setup();
    state(); model.setDraft('Make it harder'); model.create();
    const mine = requestId();
    state(); // a get response already in flight
    state({ requestId: 'another-player', status: 'error', message: 'Another request failed.' });
    expect(model.view().pending).toBe(true);
    expect(model.view().draft).toBe('Make it harder');
    expect(model.create()).toBe(false);
    state({ requestId: mine, document: document('book', 2) });
    expect(model.view().pending).toBe(false);
    expect(model.view().draft).toBe('');
  });

  it('offers cancellation only for creation initiated by this client and retains its lock until acknowledged', () => {
    const { model, send, state, requestId } = setup();
    state({ status: 'generating', requestId: 'quest-request' });
    expect(model.view().cancellable).toBe(false);
    expect(model.cancel()).toBe(false);
    expect(send).not.toHaveBeenCalled();
    state(); model.setDraft('Make a mystery'); model.create();
    const mine = requestId();
    state({ status: 'generating', requestId: mine });
    expect(model.view().cancellable).toBe(true);
    expect(model.cancel()).toBe(true);
    expect(model.cancel()).toBe(false);
    state(); // a stale uncorrelated snapshot must not unlock Cancel
    expect(model.view().pending).toBe(true);
    state({ requestId: mine });
    expect(model.view().pending).toBe(false);
    expect(model.view().draft).toBe('Make a mystery');
  });

  it('keeps read-only previews usable without sending forbidden reads or mutations', () => {
    const { model, send, state } = setup(false);
    state(); model.select('lamp'); state({ cardId: 'lamp' });
    model.connection(false, false); model.connection(true, false);
    expect(send).not.toHaveBeenCalled();
    model.setDraft('A request');
    expect(model.create()).toBe(false);
    expect(model.action('play')).toBe(false);
    expect(model.restorePrevious()).toBe(false);
    expect(model.cancel()).toBe(false);
    expect(model.view().state?.document?.cardId).toBe('lamp');
    model.connection(true, true);
    expect(send).toHaveBeenCalledExactlyOnceWith('canvas.get', { cardId: 'lamp' });
    model.create();
    model.connection(true, false);
    expect(model.view().cancellable).toBe(false);
    expect(model.cancel()).toBe(false);
  });
});
