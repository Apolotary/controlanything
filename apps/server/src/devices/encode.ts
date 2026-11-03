/**
 * Deterministic encode: a verified driver action + a control value -> the op an executor receives.
 * This is the whole "runtime" of a driver: no model, no generated code, a few arithmetic lines.
 */
import { type Driver, type DriverAction, type ExecOp, VALUE_PLACEHOLDER } from '@ce/protocol';
import { fillRaw } from './ir';

export interface NumRange {
  min: number;
  max: number;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Map a value from one range to another; `int` rounds to the nearest integer. */
export function mapRange(value: number, from: NumRange, to: NumRange, int = false): number {
  const span = from.max - from.min;
  const t = span === 0 ? 0 : clamp((value - from.min) / span, 0, 1);
  const out = to.min + t * (to.max - to.min);
  return int ? Math.round(out) : out;
}

/** The domain a "$value" placeholder maps onto for an op. */
function placeholderDomain(op: ExecOp): { range: NumRange; int: boolean } {
  if (op.kind === 'midi') return { range: { min: 0, max: 127 }, int: true };
  if (op.kind === 'local') {
    switch (op.op) {
      case 'volume':
        return { range: { min: 0, max: 100 }, int: true };
      case 'torch':
        return { range: { min: 0, max: 1 }, int: false };
      case 'beep':
        return { range: { min: 200, max: 2000 }, int: true };
      default:
        return { range: { min: 0, max: 1 }, int: false };
    }
  }
  return { range: { min: 0, max: 1 }, int: false };
}

/** A control value in the action's range -> a resolved op (no placeholders left). Throws for step composites. */
export function resolveOp(action: DriverAction, value?: number): ExecOp {
  const e = action.encode;
  if (e.kind === 'step') throw new Error(`action ${action.actionId} is a step composite; expand it with planSteps()`);
  if (e.kind === 'ir') return fillRaw(e);
  const op: ExecOp = { ...e } as ExecOp;
  const needs = (op.kind === 'midi' && op.value === VALUE_PLACEHOLDER) || (op.kind === 'local' && op.arg === VALUE_PLACEHOLDER);
  if (needs) {
    if (value === undefined) throw new Error(`action ${action.actionId} needs a value`);
    const from = action.range ?? { min: 0, max: 1 };
    const { range, int } = placeholderDomain(op);
    // MIDI CC ranges are wire-value bounds (including reviewed subsets), not normalized UI
    // domains. Expanding 20–100 into 0–127 would send values the chart never authorized.
    const domain = op.kind === 'midi' && op.msg === 'cc' && action.range
      ? { min: clamp(action.range.min, 0, 127), max: clamp(action.range.max, 0, 127) } : range;
    const mapped = mapRange(value, from, domain, int);
    if (op.kind === 'midi') op.value = mapped;
    else if (op.kind === 'local') op.arg = op.op === 'torch' ? mapped > 0.5 : mapped;
  }
  if (op.kind === 'midi' && op.msg === 'note' && op.durationMs === undefined) op.durationMs = 250;
  return op;
}

/** Control value -> step index 0..steps-1 for a step composite. */
export function stepIndex(action: DriverAction, value: number): number {
  const e = action.encode;
  if (e.kind !== 'step') throw new Error('not a step action');
  const from = action.range ?? { min: 0, max: 1 };
  return Math.round(mapRange(value, from, { min: 0, max: e.steps - 1 }));
}

/**
 * Plan the trigger actions that move a step device from `currentIndex` to the index for `value`.
 * Returns the action ids to fire in order (all up or all down) and the new index.
 */
export function planSteps(driver: Driver, action: DriverAction, currentIndex: number, value: number): { actionIds: string[]; index: number; settleMs: number } {
  const e = action.encode;
  if (e.kind !== 'step') throw new Error('not a step action');
  const target = stepIndex(action, value);
  const diff = target - currentIndex;
  const id = diff > 0 ? e.upActionId : e.downActionId;
  if (!driver.actions.some((a) => a.actionId === id)) throw new Error(`step target ${id} is not an action of the driver`);
  return { actionIds: Array.from({ length: Math.min(Math.abs(diff), e.steps - 1) }, () => id), index: target, settleMs: e.settleMs ?? 300 };
}

/** The panic op for an executor of a transport. */
export function panicOp(transport: Driver['transport']): ExecOp | undefined {
  if (transport === 'midi') return { kind: 'midi', msg: 'panic', channel: 1 };
  return undefined;
}
