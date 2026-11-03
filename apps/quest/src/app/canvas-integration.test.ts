import { describe, expect, it, vi } from 'vitest';
import { initialCanvasGame, makeMessage, type CanvasSpec } from '@ce/protocol';
import { QuestApp } from './app';
import { ModeState } from './modes';
import type { ObjectCanvas } from './canvas';

describe('Quest canvas wiring', () => {
  it('requires trusted selected-card state and pauses local gestures without dispatching hardware commands', () => {
    const app = Object.create(QuestApp.prototype) as QuestApp;
    const modes = new ModeState(); modes.mode = 'control'; modes.tags.set('target-book', { targetId: 'target-book', cardId: 'book', label: 'Book', connection: 'offline' });
    const hud = { setCanvas: vi.fn() }, ws = { open: true, send: vi.fn(() => 'sent') }, pause = vi.fn(), controls = { clear: vi.fn() };
    Object.assign(app, { modes, lockedId: 'target-book', hud, ws, controls, clearHandControl: pause, refreshHome: vi.fn() });
    const canvas = Reflect.get(app, 'canvasController').call(app) as ObjectCanvas; canvas.syncSelection();
    const spec: CanvasSpec = { title: 'Book game', intro: 'Explore it.', objectUse: 'Look at the cover.', ending: 'Done.', rounds: [{ id: 'q', prompt: 'Choose a clue.', choices: [
      { id: 'a', label: 'Title', points: 1, feedback: 'A clue.' }, { id: 'b', label: 'Color', points: 0, feedback: 'A visual clue.' },
    ] }] };
    const payload = { cardId: 'book', status: 'ready' as const, document: { canvasId: 'game', cardId: 'book', revision: 1, spec, source: 'fixture' as const, prompt: 'A game', history: [], updatedAt: 1 }, game: initialCanvasGame(spec) };
    const receive = (from: string, cardId = 'book') => Reflect.get(app, 'onCanvasState').call(app, makeMessage('canvas.state', { ...payload, cardId }, { from }));
    receive('another-headset'); expect(hud.setCanvas).toHaveBeenLastCalledWith(null);
    receive('server', 'other-book'); expect(hud.setCanvas).toHaveBeenLastCalledWith(null);
    receive('server'); expect(hud.setCanvas).toHaveBeenLastCalledWith({ targetId: 'target-book', state: payload });
    expect(pause).toHaveBeenCalledOnce(); expect(controls.clear).toHaveBeenCalledOnce();
    expect(ws.send.mock.calls).toEqual([['canvas.get', { cardId: 'book' }, { to: 'server' }]]);
    modes.mode = 'annotate'; canvas.syncSelection(); expect(hud.setCanvas).toHaveBeenLastCalledWith(null);
  });
});
