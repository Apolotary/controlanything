/** Descriptive examples only. References never carry executable bindings or verification authority. */
import { z } from 'zod';
import type { ForgeDevice, ForgeDriver, VerifyState } from './forgeTypes';

const Label = z.string().min(1).max(60);
const Range = z.object({ min: z.number().finite(), max: z.number().finite(), step: z.number().finite().optional() });
export const InteractionReference = z.object({
  source: z.literal('saved-library'),
  origin: z.enum(['live', 'fixture', 'unknown']),
  device: z.object({ name: Label, maker: Label.optional(), model: Label.optional(), category: Label.optional() }),
  actions: z.array(z.object({ label: Label, kind: z.enum(['set', 'trigger', 'toggle']), range: Range.optional() })).min(1).max(6),
  controls: z.array(z.object({
    label: Label, archetype: z.string().min(1).max(32),
    size: z.enum(['s', 'm', 'l']).optional(), placement: z.enum(['left', 'center', 'right']).optional(),
  })).max(6),
  gestures: z.array(z.object({ gesture: z.string().min(1).max(32), control: Label })).max(6),
});
export type InteractionReference = z.infer<typeof InteractionReference>;
export interface InteractionReferenceQuery {
  device: ForgeDevice;
  driver: ForgeDriver;
  verification: Record<string, VerifyState>;
  request: string;
}
export type InteractionReferenceProvider = (query: InteractionReferenceQuery) => InteractionReference[];

export const MAX_INTERACTION_REFERENCES = 3;
export const MAX_REFERENCE_CHARACTERS = 6000;

/** Also protects the prompt when a different provider is installed; unknown fields are stripped. */
export function boundedInteractionReferences(input: unknown): InteractionReference[] {
  if (!Array.isArray(input)) return [];
  const out: InteractionReference[] = [];
  for (const candidate of input.slice(0, 64)) {
    const parsed = InteractionReference.safeParse(candidate);
    if (!parsed.success) continue;
    if (JSON.stringify([...out, parsed.data]).length > MAX_REFERENCE_CHARACTERS) continue;
    out.push(parsed.data);
    if (out.length === MAX_INTERACTION_REFERENCES) break;
  }
  return out;
}
