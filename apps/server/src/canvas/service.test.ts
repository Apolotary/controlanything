import { describe, expect, it, vi } from 'vitest';
import type { CanvasStatePayload } from '@ce/protocol';
import { FixtureMuse } from '../muse/adapter';
import { CanvasService, registerCanvasFixture, type CanvasObject } from './service';
import { CanvasStore } from './store';

function harness() {
  const muse = new FixtureMuse({ log: () => {} }); registerCanvasFixture(muse);
  const store = new CanvasStore(), states: CanvasStatePayload[] = [], replies: Array<{ sender: string; state: CanvasStatePayload }> = [];
  const objects = new Map<string, CanvasObject>([['book', { name: 'Blue book', category: 'book', visibleText: ['A visible title'], evidence: ['A blue cover'] }], ['cup', { name: 'Cup' }]]);
  const service = new CanvasService({ muse, store, object: (id) => objects.get(id), broadcast: (state) => states.push(structuredClone(state)), send: (sender, state) => replies.push({ sender, state: structuredClone(state) }) });
  const request = (id = 'create', baseRevision?: number) => service.request('quest', { cardId: 'book', requestId: id, prompt: 'Make a game with this book', baseRevision });
  return { muse, store, service, objects, states, replies, request };
}
describe('software canvas service', () => {
  it('grounds generation, remains preview-only, and shares revision-bound play with no duplicate scoring', async () => {
    const h = harness(), chat = vi.spyOn(h.muse, 'chatJson');
    expect(await h.request()).toBe(true);
    const context = JSON.parse(String(chat.mock.calls[0][0].at(-1)!.content));
    expect(context.object).toMatchObject({ name: 'Blue book', visibleText: ['A visible title'] });
    expect(h.states[0]).toMatchObject({ status: 'generating', requestId: 'create' });
    expect(h.states.at(-1)).toMatchObject({ status: 'ready', document: { revision: 1, source: 'fixture' }, game: { phase: 'preview', score: 0 } });
    const base = { cardId: 'book', revision: 1 };
    expect(h.service.action('quest', { ...base, requestId: 'play', action: 'play' })).toBe(true);
    const choose = { ...base, requestId: 'answer', action: 'choose' as const, roundId: 'opening', choiceId: 'mystery' };
    expect(h.service.action('mac', choose)).toBe(true);
    h.service.action('mac', choose);
    expect(h.service.snapshot('book')!.game).toMatchObject({ phase: 'feedback', score: 3 });
    h.service.action('mac', { ...base, requestId: 'next', action: 'next', roundId: 'opening' });
    expect(h.service.snapshot('book')!.game?.phase).toBe('finished');
    // Replaying a formerly successful Play request cannot restart or erase score.
    h.service.action('quest', { ...base, requestId: 'play', action: 'play' });
    expect(h.service.snapshot('book')!.game?.phase).toBe('finished');
    expect(chat).toHaveBeenCalledTimes(1);
  });
  it('edits and restores reset progress, preserve history, and reject stale actions', async () => {
    const h = harness(); await h.request();
    h.service.action('quest', { cardId: 'book', revision: 1, requestId: 'play', action: 'play' });
    const editing = h.request('edit', 1);
    expect(h.service.snapshot('book')!.game?.phase).toBe('preview');
    expect(h.service.action('quest', { cardId: 'book', revision: 1, requestId: 'during', action: 'play' })).toBe(false);
    await editing;
    expect(h.service.action('quest', { cardId: 'book', revision: 1, requestId: 'old', action: 'play' })).toBe(false);
    expect(h.service.restore('mac', { cardId: 'book', requestId: 'restore', revision: 1, baseRevision: 2 })).toBe(true);
    expect(h.service.snapshot('book')).toMatchObject({ document: { revision: 3 }, game: { phase: 'preview', score: 0 } });
    h.service.restore('mac', { cardId: 'book', requestId: 'restore', revision: 1, baseRevision: 2 });
    expect(h.service.document('book')!.revision).toBe(3);
    expect(h.replies.at(-1)!.state.requestId).toBe('restore');
  });
  it.each(['cancel', 'switch', 'disconnect', 'mode', 'identity', 'forget'])('ignores late results after %s', async (reason) => {
    const h = harness();
    const real = h.muse.chatJson.bind(h.muse); let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(h.muse, 'chatJson').mockImplementation(async (...args) => { const result = await real(...args); await barrier; return result; });
    const pending = h.request();
    if (reason === 'cancel') h.service.cancel('quest', 'book', 'create');
    if (reason === 'switch') h.service.select('quest', 'cup');
    if (reason === 'disconnect') h.service.disconnect('quest');
    if (reason === 'mode') { h.objects.clear(); h.service.invalidate(); }
    if (reason === 'identity') h.objects.set('book', { name: 'Different book' });
    if (reason === 'forget') { h.objects.delete('book'); h.service.forget('book'); }
    release(); expect(await pending).toBe(false);
    expect(h.service.document('book')).toBeUndefined();
    expect(h.states.some((state) => state.document)).toBe(false);
  });
  it('an older cancel or competing stale edit cannot alter the current accepted game', async () => {
    const h = harness(); await h.request(); await h.request('edit', 1);
    h.service.action('quest', { cardId: 'book', revision: 2, requestId: 'play', action: 'play' });
    h.service.cancel('quest', 'book', 'create');
    expect(h.service.snapshot('book')!.game?.phase).toBe('playing');
    expect(await h.request('stale', 1)).toBe(false);
    expect(h.replies.at(-1)!.state).toMatchObject({ requestId: 'stale', status: 'error', document: { revision: 2 } });
  });
  it('keeps the saved document after a model failure and rejects absent object context', async () => {
    const h = harness(); await h.request(); vi.spyOn(h.muse, 'chatJson').mockRejectedValue(new Error('unavailable'));
    expect(await h.request('failed-edit', 1)).toBe(false);
    expect(h.states.at(-1)).toMatchObject({ status: 'error', requestId: 'failed-edit', document: { revision: 1 }, game: { phase: 'preview' } });
    h.objects.clear(); expect(await h.request('gone', 1)).toBe(false);
    expect(h.service.action('quest', { cardId: 'book', revision: 1, requestId: 'denied', action: 'play' })).toBe(false);
  });
});
