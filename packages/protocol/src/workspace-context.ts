import { z } from 'zod';
import { Id } from './primitives';

/** A bounded snapshot of what the requester sees. It never grants device authority. */
export const WorkspaceContext = z.object({
  version: z.literal(1),
  scope: z.enum(['general', 'device']),
  surface: z.enum(['menu', 'device', 'assistant', 'project', 'inspect']),
  stage: z.enum(['choose', 'prepare', 'building', 'review', 'ready', 'perform']),
  performance: z.enum(['off', 'live', 'paused', 'tracking-lost']),
  selected: z.object({
    targetId: Id,
    cardId: Id,
    specId: Id.optional(),
    specRevision: z.number().int().nonnegative().optional(),
    identityRevision: z.number().int().nonnegative().optional(),
  }).strict().optional(),
  pending: z.object({
    kind: z.enum(['setup', 'gesture', 'identity', 'peripheral', 'inspect', 'project']),
    state: z.enum(['working', 'review']),
  }).strict().optional(),
  mappingOutcome: z.enum(['working', 'review', 'applied', 'unchanged', 'failed', 'cancelled']).optional(),
}).strict();
export type WorkspaceContext = z.infer<typeof WorkspaceContext>;
