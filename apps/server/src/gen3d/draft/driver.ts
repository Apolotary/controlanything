/**
 * BENCHMARK ONLY (research/12): the pre-SPEC driver description used by the gen3d-draft/0 benchmark.
 * What the generator knows about a device's driver: the actions a binding may call (with typed, ranged
 * params and the physical effects each can cause) and the signals it emits (for daemons). Plus the
 * deterministic binding check the verification loop runs on every hack step, control and daemon.
 */
import { z } from 'zod';

export const DriverParam = z.object({
  name: z.string().min(1).max(32),
  type: z.enum(['int', 'number', 'enum', 'bool', 'string']),
  min: z.number().optional(),
  max: z.number().optional(),
  values: z.array(z.string().max(64)).max(64).optional(),
  /** default true */
  required: z.boolean().optional(),
  description: z.string().max(200).optional(),
});
export type DriverParam = z.infer<typeof DriverParam>;

export const DriverActionSpec = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(400),
  params: z.array(DriverParam).max(12),
  /** physical effects this action can cause, as "sensor:effect" (e.g. "camera:darker", "mic:timbre_change") */
  effects: z.array(z.string().max(48)).max(12).optional(),
});
export type DriverActionSpec = z.infer<typeof DriverActionSpec>;

export const DriverSignal = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(300),
  /** typical event rate */
  rateHz: z.number().min(0).optional(),
});
export type DriverSignal = z.infer<typeof DriverSignal>;

/** One device's driver as the generator sees it. `cardId` ties it to the identified device card. */
export const DeviceDriver = z.object({
  cardId: z.string().min(1).max(64),
  name: z.string().max(120),
  transport: z.string().max(40),
  actions: z.array(DriverActionSpec).min(1).max(64),
  signals: z.array(DriverSignal).max(32).optional(),
  /** the device emits visible light: anything that changes it is capped at 3 Hz (photosensitivity) */
  emitsLight: z.boolean().optional(),
  notes: z.string().max(1000).optional(),
});
export type DeviceDriver = z.infer<typeof DeviceDriver>;

import { issue, type Issue } from '../issues';

export { issue, type Issue, type Severity, type Stage } from '../issues';

export interface CallArg {
  name: string;
  value: string | number | boolean;
}

export interface ValueRange {
  min: number;
  max: number;
  step: number;
}

const paramNames = (a: DriverActionSpec) => a.params.map((p) => p.name).join(', ') || '(none)';

function checkArgValue(p: DriverParam, v: CallArg['value'], path: string): Issue | undefined {
  const range = `${p.min ?? '-∞'}..${p.max ?? '∞'}`;
  switch (p.type) {
    case 'int':
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) return issue('bindings', 'arg_type', path, `${p.name} must be a number, got ${JSON.stringify(v)}`);
      if (p.type === 'int' && !Number.isInteger(v)) return issue('bindings', 'arg_type', path, `${p.name} must be an integer, got ${v}`);
      if ((p.min !== undefined && v < p.min) || (p.max !== undefined && v > p.max)) return issue('bindings', 'arg_range', path, `${p.name}=${v} is outside ${range}`);
      return undefined;
    case 'enum':
      if (typeof v !== 'string' || !(p.values ?? []).includes(v)) return issue('bindings', 'arg_enum', path, `${p.name}=${JSON.stringify(v)} is not one of ${(p.values ?? []).join(', ')}`);
      return undefined;
    case 'bool':
      if (typeof v !== 'boolean') return issue('bindings', 'arg_type', path, `${p.name} must be true or false, got ${JSON.stringify(v)}`);
      return undefined;
    case 'string':
      if (typeof v !== 'string') return issue('bindings', 'arg_type', path, `${p.name} must be a string, got ${JSON.stringify(v)}`);
      return undefined;
  }
}

/**
 * Check one call (a hack step, a control binding or a daemon target) against a driver.
 * `value` is the live control range when `valueArg` is set (controls); omit it for one-shot steps.
 */
export function checkCall(
  driver: DeviceDriver | undefined,
  call: { action: string; args: CallArg[]; valueArg?: string },
  path: string,
  value?: ValueRange,
): Issue[] {
  if (!driver) return [issue('bindings', 'unknown_device', path, 'no driver for this device')];
  const action = driver.actions.find((a) => a.name === call.action);
  if (!action) {
    return [issue('bindings', 'unknown_action', `${path}.action`, `"${call.action}" is not an action of ${driver.name}; available: ${driver.actions.map((a) => a.name).join(', ')}`)];
  }
  const out: Issue[] = [];
  const seen = new Set<string>();
  const valueArg = call.valueArg ?? '';
  for (const [i, a] of call.args.entries()) {
    const at = `${path}.args[${i}]`;
    if (seen.has(a.name)) out.push(issue('bindings', 'duplicate_arg', at, `${a.name} is given twice`));
    seen.add(a.name);
    const p = action.params.find((q) => q.name === a.name);
    if (!p) {
      out.push(issue('bindings', 'unknown_arg', at, `${call.action} has no param "${a.name}" (params: ${paramNames(action)})`));
      continue;
    }
    if (a.name === valueArg) {
      out.push(issue('bindings', 'value_arg_fixed', at, `${a.name} is the valueArg; do not also fix it in args`));
      continue;
    }
    const bad = checkArgValue(p, a.value, at);
    if (bad) out.push(bad);
  }
  if (valueArg) {
    const p = action.params.find((q) => q.name === valueArg);
    if (!p) out.push(issue('bindings', 'unknown_value_arg', `${path}.valueArg`, `${call.action} has no param "${valueArg}" (params: ${paramNames(action)})`));
    else if (p.type === 'enum' || p.type === 'string') out.push(issue('bindings', 'value_arg_type', `${path}.valueArg`, `${valueArg} is a ${p.type} param; a live control value must go to an int, number or bool param`));
    else if (value) {
      if (p.type === 'bool') {
        if (value.min !== 0 || value.max !== 1) out.push(issue('bindings', 'value_out_of_range', `${path}.valueArg`, `${valueArg} is a bool: the control must use min 0, max 1 (has ${value.min}..${value.max})`));
      } else {
        if ((p.min !== undefined && value.min < p.min) || (p.max !== undefined && value.max > p.max)) {
          out.push(issue('bindings', 'value_out_of_range', `${path}.valueArg`, `control range ${value.min}..${value.max} must lie inside ${valueArg}'s ${p.min ?? '-∞'}..${p.max ?? '∞'}`));
        }
        if (p.type === 'int' && (!Number.isInteger(value.min) || !Number.isInteger(value.max) || !(Number.isInteger(value.step) && value.step >= 1))) {
          out.push(issue('bindings', 'non_integer_step', `${path}.valueArg`, `${valueArg} is an integer param: use integer min/max and step >= 1 (has ${value.min}..${value.max} step ${value.step})`));
        }
      }
    }
  }
  for (const p of action.params) {
    if (p.required === false || p.name === valueArg) continue;
    if (!seen.has(p.name)) out.push(issue('bindings', 'missing_arg', `${path}.args`, `${call.action} needs ${p.name} (${p.type}${p.values ? `: ${p.values.join('|')}` : p.min !== undefined || p.max !== undefined ? ` ${p.min ?? ''}..${p.max ?? ''}` : ''})`));
  }
  return out;
}

/** Effect families: a "lights out" hack that expects `darker` is fine for an action declared `light_off`. */
const FAMILY: Record<string, string> = { light_off: 'darker', light_on: 'brighter', sound_stops: 'quieter', sound_starts: 'louder' };
const family = (sensorEffect: string) => {
  const [sensor, effect] = sensorEffect.split(':');
  return `${sensor}:${FAMILY[effect] ?? effect}`;
};

/**
 * Does an expected effect match what the called actions can do? `undefined` when the driver declares no
 * effects for any of the actions (nothing to compare against).
 */
export function effectMatches(driver: DeviceDriver | undefined, actions: string[], sensor: string, effect: string): boolean | undefined {
  if (!driver || sensor === 'none' || effect === 'none') return undefined;
  const declared = actions.flatMap((name) => driver.actions.find((a) => a.name === name)?.effects ?? []);
  if (!declared.length) return undefined;
  const want = family(`${sensor}:${effect}`);
  return declared.some((d) => family(d) === want);
}

const LIGHT_EFFECTS = new Set(['brighter', 'darker', 'light_on', 'light_off', 'warmer', 'cooler']);

/** True when an action changes visible light (so rates and sequences fall under the 3 Hz cap). */
export function changesLight(driver: DeviceDriver | undefined, action: string): boolean {
  if (!driver) return false;
  const a = driver.actions.find((x) => x.name === action);
  if (!a) return false;
  if (a.effects?.some((e) => e.startsWith('camera:') && LIGHT_EFFECTS.has(e.slice(7)))) return true;
  return Boolean(driver.emitsLight);
}

export const MAX_LIGHT_RATE_HZ = 3;
