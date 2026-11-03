import type { Control, Gen3dSpec } from '@ce/gen3d';
import { THEME } from './theme';

export type CardControlShape = 'slider' | 'knob' | 'lever';
export const DIAL_DIAMETER = 0.060;
export const LEVER_TRAVEL = 0.048;

/** Honor the supported generated archetype while keeping one stable, bounded control card. */
export function cardControlShape(spec: Gen3dSpec, control: Control): CardControlShape {
  if (control.kind === 'xy') return 'slider';
  const part = spec.parts.find((item) => item.kind === 'archetype' && item.controlId === control.id);
  return part?.archetype === 'knob' ? 'knob' : part?.archetype === 'lever' ? 'lever' : 'slider';
}

export function controlFraction(shape: CardControlShape, point: { x: number; y: number }, previous: number): number {
  if (shape === 'lever') return Math.max(0, Math.min(1, point.y / LEVER_TRAVEL + .5));
  if (shape === 'knob') {
    // A center pinch acquires the knob without jumping its value. The bottom gap stays on its nearest end.
    if (Math.hypot(point.x, point.y) < DIAL_DIAMETER * .16) return previous;
    const angle = Math.atan2(point.x, point.y);
    if (Math.abs(angle) > .75 * Math.PI) return previous > .5 ? 1 : 0;
    return Math.max(0, Math.min(1, (angle / Math.PI + .75) / 1.5));
  }
  return Math.max(0, Math.min(1, point.x / THEME.control.width + .5));
}

export function controlValue(fraction: number, range: { min: number; max: number; step?: number }): number {
  const raw = range.min + fraction * (range.max - range.min);
  const value = range.step ? range.min + Math.round((raw - range.min) / range.step) * range.step : raw;
  return Math.max(range.min, Math.min(range.max, value));
}
