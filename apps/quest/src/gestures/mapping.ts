import type { GestureMap } from '@ce/protocol';

export type AxisBinding = GestureMap['axes'][number];
type Curve = AxisBinding['curve'];
export const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export function applyCurve(value: number, curve: Curve): number {
  const u = clamp01(value);
  switch (curve) {
    case 'exp': return u * u;
    case 'log': return Math.sqrt(u);
    case 's-curve': return u * u * (3 - 2 * u);
    default: return u;
  }
}

/** The inverse curve lets a re-clutch start at the last device value without a jump. */
export function inverseCurve(value: number, curve: Curve): number {
  const u = clamp01(value);
  switch (curve) {
    case 'exp': return Math.sqrt(u);
    case 'log': return u * u;
    case 's-curve': return 0.5 - Math.sin(Math.asin(1 - 2 * u) / 3);
    default: return u;
  }
}

/** Signed movement around the engage reference, with a smooth dead zone. */
export function applyDeadzone(delta: number, deadzone: number): number {
  return Math.sign(delta) * Math.max(0, Math.abs(delta) - deadzone) / (1 - deadzone);
}

export function mapAxisValue(normalized: number, binding: AxisBinding): number {
  const value = binding.outMin + applyCurve(normalized, binding.curve) * (binding.outMax - binding.outMin);
  const quantized = binding.quantizeStep > 0
    ? binding.outMin + Math.round((value - binding.outMin) / binding.quantizeStep) * binding.quantizeStep
    : value;
  return Math.max(binding.outMin, Math.min(binding.outMax, quantized));
}
