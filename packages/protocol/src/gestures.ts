import { z } from 'zod';
import { Id } from './primitives';

export const GestureAxis = z.enum(['right_height', 'right_depth', 'right_roll', 'right_pinch_aperture', 'two_hand_distance']);
export type GestureAxis = z.infer<typeof GestureAxis>;

export const GesturePosture = z.enum(['R_FIST', 'R_OPEN_PALM', 'R_POINT', 'R_PINCH']);
export type GesturePosture = z.infer<typeof GesturePosture>;

export const GestureAxisBinding = z.object({
  axis: GestureAxis,
  actionId: Id,
  label: z.string().min(1).max(80),
  outMin: z.number().finite(),
  outMax: z.number().finite(),
  curve: z.enum(['linear', 'exp', 'log', 's-curve']),
  deadzone: z.number().min(0).max(0.49),
  smoothingMinCutoff: z.number().min(0.1).max(20),
  smoothingBeta: z.number().min(0).max(10),
  quantizeStep: z.number().finite().positive(),
  maxRateHz: z.number().min(0.1).max(30),
  bipolar: z.boolean().optional(),
}).refine((binding) => binding.outMin < binding.outMax, { message: 'outMin must be below outMax' });
export type GestureAxisBinding = z.infer<typeof GestureAxisBinding>;

export const GesturePostureBinding = z.object({
  posture: GesturePosture,
  actionId: Id,
  label: z.string().min(1).max(80),
  mode: z.literal('press'),
  value: z.union([z.number().finite(), z.boolean()]).optional(),
  maxRateHz: z.number().min(0.1).max(2).default(2),
});
export type GesturePostureBinding = z.infer<typeof GesturePostureBinding>;

/** Server-owned bindings to verified driver actions. Releasing the clutch always freezes values. */
export const GestureMap = z.object({
  version: z.literal(1),
  clutchPosture: z.literal('L_FIST'),
  panicPosture: z.literal('BOTH_PALMS_OUT'),
  axes: z.array(GestureAxisBinding).max(4),
  postures: z.array(GesturePostureBinding).max(4),
}).superRefine((map, ctx) => {
  for (const [key, names] of [
    ['axes', map.axes.map((binding) => binding.axis)],
    ['postures', map.postures.map((binding) => binding.posture)],
  ] as const) {
    if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', path: [key], message: 'Each gesture can have only one binding' });
  }
});
export type GestureMap = z.infer<typeof GestureMap>;
