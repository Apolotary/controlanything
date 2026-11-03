import { describe, expect, it } from 'vitest';
import { CanvasSpec, CanvasStatePayload, initialCanvasGame, reduceCanvasGame } from './canvas';
import { makeMessage, parseMessage, SERVER_ONLY_TYPES } from './messages';

const game: CanvasSpec = {
  title: 'Book explorer', intro: 'Use a page of your choice.', objectUse: 'Read the physical book yourself; the app cannot see unread pages.',
  rounds: [
    { id: 'find', prompt: 'Find a word with five letters.', choices: [
      { id: 'found', label: 'Found one', points: 2, feedback: 'Read your word aloud to the other player.' },
      { id: 'skip', label: 'Skip', points: 0, feedback: 'Try another page next time.' },
    ] },
    { id: 'story', prompt: 'Make a sentence with your word.', choices: [
      { id: 'found', label: 'Done', points: 1, feedback: 'Nice sentence.' },
      { id: 'skip', label: 'Skip', points: 0, feedback: 'You can try again.' },
    ] },
  ], ending: 'Explore another page next time.',
};

describe('bounded object canvas games', () => {
  it('registers the canvas protocol while reserving authoritative state for the server', () => {
    const payloads = [
      makeMessage('canvas.request', { requestId: 'create', cardId: 'book', prompt: 'Make a word game' }),
      makeMessage('canvas.get', { cardId: 'book' }),
      makeMessage('canvas.cancel', { cardId: 'book', requestId: 'create' }),
      makeMessage('canvas.restore', { cardId: 'book', requestId: 'restore', revision: 1, baseRevision: 2 }),
      makeMessage('canvas.action', { cardId: 'book', requestId: 'play', revision: 1, action: 'play' }),
      makeMessage('canvas.state', { cardId: 'book', status: 'ready', document: { cardId: 'book', canvasId: 'canvas', revision: 1,
        spec: game, source: 'fixture', prompt: 'Make a word game', history: [{ revision: 1, title: game.title }], updatedAt: 1 }, game: initialCanvasGame(game) }),
    ];
    for (const message of payloads) expect(parseMessage(message).ok).toBe(true);
    expect(SERVER_ONLY_TYPES).toContain('canvas.state');
    expect(CanvasStatePayload.safeParse({ cardId: 'book', status: 'ready', game: { ...initialCanvasGame(game), score: 100 } }).success).toBe(false);
  });

  it('rejects authored code, excess choices, duplicate IDs and impossible scoring', () => {
    expect(CanvasSpec.safeParse({ ...game, code: 'fetch("/control")' }).success).toBe(false);
    expect(CanvasSpec.safeParse({ ...game, rounds: [game.rounds[0], game.rounds[0]] }).success).toBe(false);
    expect(CanvasSpec.safeParse({ ...game, rounds: [{ ...game.rounds[0], choices: [game.rounds[0].choices[0], game.rounds[0].choices[0]] }] }).success).toBe(false);
    expect(CanvasSpec.safeParse({ ...game, rounds: [{ ...game.rounds[0], choices: Array(4).fill(game.rounds[0].choices[0]) }] }).success).toBe(false);
    expect(CanvasSpec.safeParse({ ...game, rounds: [{ ...game.rounds[0], choices: [{ ...game.rounds[0].choices[0], points: 4 }, game.rounds[0].choices[1]] }] }).success).toBe(false);
  });

  it('requires Play, counts a choice once, and rejects stale-round input', () => {
    let state = initialCanvasGame(game);
    expect(state).toEqual({ phase: 'preview', roundIndex: 0, score: 0, maxScore: 3 });
    expect(reduceCanvasGame(game, state, { action: 'choose', roundId: 'find', choiceId: 'found' }).ok).toBe(false);
    state = reduceCanvasGame(game, state, { action: 'play' }).state;
    expect(reduceCanvasGame(game, state, { action: 'next', roundId: 'find' }).ok).toBe(false);
    state = reduceCanvasGame(game, state, { action: 'choose', roundId: 'find', choiceId: 'found' }).state;
    expect(state).toMatchObject({ phase: 'feedback', score: 2 });
    expect(reduceCanvasGame(game, state, { action: 'choose', roundId: 'find', choiceId: 'found' })).toMatchObject({ ok: false, state: { score: 2 } });
    state = reduceCanvasGame(game, state, { action: 'next', roundId: 'find' }).state;
    expect(state).toMatchObject({ phase: 'playing', roundIndex: 1 });
    expect(reduceCanvasGame(game, state, { action: 'choose', roundId: 'find', choiceId: 'found' }).ok).toBe(false);
    state = reduceCanvasGame(game, state, { action: 'choose', roundId: 'story', choiceId: 'found' }).state;
    state = reduceCanvasGame(game, state, { action: 'next', roundId: 'story' }).state;
    expect(state).toMatchObject({ phase: 'finished', score: 3, feedback: game.ending });
    expect(reduceCanvasGame(game, state, { action: 'restart' }).state).toEqual({ ...initialCanvasGame(game), phase: 'playing' });
  });
});
