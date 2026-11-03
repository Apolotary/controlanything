/**
 * What FORGE gets from the discovery loop: the identified device and its VERIFIED declarative Driver
 * (SPEC §3.2; @ce/protocol `Driver`). These are structural subsets, so a protocol Driver / device.card can be
 * passed as-is: `encode` is never read here; the model only sees actionIds, kinds, ranges, expected effects
 * and undo actions, and every binding it writes must name one of those actionIds.
 */
import { z } from 'zod';

export const VerifyState = z.enum(['pending', 'pass', 'fail', 'untested']);
export type VerifyState = z.infer<typeof VerifyState>;

export const ForgeAction = z.object({
  actionId: z.string().min(1).max(64),
  label: z.string().max(80),
  kind: z.enum(['set', 'trigger', 'toggle']),
  description: z.string().max(300).optional(),
  range: z.object({ min: z.number(), max: z.number(), step: z.number().optional() }).optional(),
  expect: z
    .object({
      sense: z.enum(['camera', 'audio', 'ack', 'none']),
      effect: z.string().max(24),
    })
    .optional(),
  /** the action that undoes this one */
  inverseActionId: z.string().max(64).optional(),
  /** Keep routing identity and step dependencies for recording remaps and gesture validation. */
  encode: z.object({
    kind: z.string().max(16), msg: z.string().max(24).optional(), number: z.number().optional(),
    op: z.string().max(24).optional(),
    upActionId: z.string().max(64).optional(), downActionId: z.string().max(64).optional(),
    steps: z.number().optional(),
  }).optional(),
  /** "hold" = irreversible on the device */
  confirm: z.enum(['tap', 'hold']).optional(),
  /** optional per-action verification (otherwise taken from ForgeRequest.verification) */
  verified: VerifyState.optional(),
});
export type ForgeAction = z.infer<typeof ForgeAction>;

export const ForgeDriver = z.object({
  driverId: z.string().min(1).max(64),
  /** the device.card this driver controls */
  cardId: z.string().min(1).max(64),
  name: z.string().max(120).optional(),
  transport: z.enum(['midi', 'ir', 'local', 'ble']),
  executor: z.object({ deviceId: z.string().max(64), port: z.string().max(120).optional() }).optional(),
  actions: z.array(ForgeAction).min(1).max(64),
  maxRateHz: z.number().min(0.1).max(200).optional(),
  /** events the device emits (daemon triggers), e.g. {name: "clock_bpm"} */
  signals: z.array(z.object({ name: z.string().max(64), description: z.string().max(200).optional() })).max(16).optional(),
});
export type ForgeDriver = z.infer<typeof ForgeDriver>;

export const ForgeDevice = z.object({
  cardId: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  maker: z.string().max(80).optional(),
  model: z.string().max(80).optional(),
  category: z.string().max(40).optional(),
  /** the device's own colours, in order (e.g. the OP-1 Field's encoder colours) */
  accents: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(8).optional(),
  notes: z.string().max(600).optional(),
});
export type ForgeDevice = z.infer<typeof ForgeDevice>;

export function verificationOf(driver: ForgeDriver, verification?: Record<string, VerifyState>): Record<string, VerifyState> {
  const out: Record<string, VerifyState> = {};
  for (const a of driver.actions) out[a.actionId] = (verification ? verification[a.actionId] : a.verified) ?? 'untested';
  return out;
}
