import { z } from 'zod';
import { Id, ModelSource } from './primitives';

const GameId = z.string().min(1).max(32).regex(/^[a-zA-Z0-9_-]+$/);
const CanvasChoice = z.object({
  id: GameId,
  label: z.string().min(1).max(80),
  points: z.number().int().min(0).max(3),
  feedback: z.string().min(1).max(160),
}).strict();
const CanvasRound = z.object({
  id: GameId,
  prompt: z.string().min(1).max(240),
  choices: z.array(CanvasChoice).min(2).max(3),
}).strict();

/** Muse authors bounded game data. Renderers never evaluate scripts, markup or expressions. */
export const CanvasSpec = z.object({
  title: z.string().min(1).max(80),
  intro: z.string().min(1).max(400),
  objectUse: z.string().min(1).max(200),
  rounds: z.array(CanvasRound).min(1).max(6),
  ending: z.string().min(1).max(240),
}).strict().superRefine((spec, context) => {
  const rounds = new Set<string>();
  spec.rounds.forEach((round, index) => {
    if (rounds.has(round.id)) context.addIssue({ code: 'custom', path: ['rounds', index, 'id'], message: 'Round IDs must be unique' });
    rounds.add(round.id);
    const choices = new Set<string>();
    round.choices.forEach((choice, n) => {
      if (choices.has(choice.id)) context.addIssue({ code: 'custom', path: ['rounds', index, 'choices', n, 'id'], message: 'Choice IDs must be unique within a round' });
      choices.add(choice.id);
    });
  });
});
export type CanvasSpec = z.infer<typeof CanvasSpec>;

export const CanvasDocument = z.object({
  canvasId: Id,
  cardId: Id,
  revision: z.number().int().min(1),
  spec: CanvasSpec,
  source: ModelSource,
  modelId: z.string().max(120).optional(),
  prompt: z.string().max(1000),
  history: z.array(z.object({ revision: z.number().int().min(1), title: z.string().max(80) })).max(8),
  updatedAt: z.number().finite(),
});
export type CanvasDocument = z.infer<typeof CanvasDocument>;

export const CanvasGameState = z.object({
  phase: z.enum(['preview', 'playing', 'feedback', 'finished']),
  roundIndex: z.number().int().min(0).max(5),
  score: z.number().int().min(0).max(18),
  maxScore: z.number().int().min(0).max(18),
  choiceId: GameId.optional(),
  feedback: z.string().max(240).optional(),
});
export type CanvasGameState = z.infer<typeof CanvasGameState>;

export const CanvasRequestPayload = z.object({
  requestId: Id, cardId: Id, prompt: z.string().trim().min(1).max(1000), baseRevision: z.number().int().min(1).optional(),
});
export type CanvasRequestPayload = z.infer<typeof CanvasRequestPayload>;
export const CanvasGetPayload = z.object({ cardId: Id });
export type CanvasGetPayload = z.infer<typeof CanvasGetPayload>;
export const CanvasCancelPayload = z.object({ requestId: Id, cardId: Id });
export type CanvasCancelPayload = z.infer<typeof CanvasCancelPayload>;
export const CanvasRestorePayload = z.object({ requestId: Id, cardId: Id, revision: z.number().int().min(1), baseRevision: z.number().int().min(1) });
export type CanvasRestorePayload = z.infer<typeof CanvasRestorePayload>;
export const CanvasActionPayload = z.object({
  requestId: Id, cardId: Id, revision: z.number().int().min(1),
  action: z.enum(['play', 'choose', 'next', 'restart']), roundId: GameId.optional(), choiceId: GameId.optional(),
});
export type CanvasActionPayload = z.infer<typeof CanvasActionPayload>;
export const CanvasStatePayload = z.object({
  cardId: Id, status: z.enum(['generating', 'ready', 'error']), requestId: Id.optional(),
  document: CanvasDocument.optional(), game: CanvasGameState.optional(), message: z.string().max(300).optional(),
});
export type CanvasStatePayload = z.infer<typeof CanvasStatePayload>;

/** Explicit Play is required after generation, revision restore and server restart. */
export function initialCanvasGame(spec: CanvasSpec): CanvasGameState {
  return { phase: 'preview', roundIndex: 0, score: 0, maxScore: spec.rounds.reduce((sum, round) => sum + Math.max(...round.choices.map(choice => choice.points)), 0) };
}

/** Trusted shared mechanics; no timers, dynamic code or device-control effects. */
export function reduceCanvasGame(spec: CanvasSpec, state: CanvasGameState,
  action: Pick<CanvasActionPayload, 'action' | 'roundId' | 'choiceId'>): { ok: boolean; state: CanvasGameState; reason?: string } {
  const reject = (reason: string) => ({ ok: false, state, reason });
  if (action.action === 'restart') return { ok: true, state: { ...initialCanvasGame(spec), phase: 'playing' } };
  if (action.action === 'play') return state.phase !== 'preview' ? reject('This game has already started. Use Restart to begin again.')
    : { ok: true, state: { ...initialCanvasGame(spec), phase: 'playing' } };
  const round = spec.rounds[state.roundIndex];
  if (!round || action.roundId !== round.id) return reject('This round changed. Use the current game panel.');
  if (action.action === 'choose') {
    if (state.phase !== 'playing') return reject('This round is not accepting an answer.');
    const choice = round.choices.find(value => value.id === action.choiceId);
    if (!choice) return reject('Choose one of the displayed answers.');
    return { ok: true, state: { ...state, phase: 'feedback', score: Math.min(state.maxScore, state.score + choice.points), choiceId: choice.id, feedback: choice.feedback } };
  }
  if (action.action === 'next') {
    if (state.phase !== 'feedback') return reject('Answer this round before continuing.');
    return { ok: true, state: state.roundIndex + 1 >= spec.rounds.length
      ? { ...state, phase: 'finished', feedback: spec.ending }
      : { phase: 'playing', roundIndex: state.roundIndex + 1, score: state.score, maxScore: state.maxScore } };
  }
  return reject('Unknown game action.');
}
