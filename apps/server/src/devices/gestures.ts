import { GestureMap, type GestureAxis, type GestureAxisBinding, type GesturePosture, type VerifyState } from '@ce/protocol';
import type { ForgeAction, ForgeDevice, ForgeDriver } from '../gen3d/forgeTypes';

type Verification = Readonly<Record<string, VerifyState>>;

function passed(action: ForgeAction, verification?: Verification): boolean {
  return (verification ? verification[action.actionId] : action.verified) === 'pass';
}

function available(action: ForgeAction, driver: ForgeDriver, verification?: Verification): boolean {
  if (!passed(action, verification) || action.confirm === 'hold') return false;
  if (action.encode?.kind !== 'step') return true;
  return [action.encode.upActionId, action.encode.downActionId].every((id) => {
    const step = driver.actions.find((candidate) => candidate.actionId === id);
    return step && step.encode?.kind !== 'step' && step.confirm !== 'hold' && passed(step, verification);
  });
}

function axisCap(action: ForgeAction, driver: ForgeDriver): number {
  const light = action.expect?.sense === 'camera' && ['on', 'off', 'brighter', 'dimmer', 'warmer', 'cooler'].includes(action.expect.effect);
  return Math.min(30, driver.maxRateHz ?? 30, driver.transport === 'ir' || action.encode?.kind === 'step' ? 2 : light ? 3 : driver.transport === 'local' ? 10 : 30);
}

function continuous(action: ForgeAction): boolean {
  return action.kind === 'set' && !!action.range && Number.isFinite(action.range.min) && Number.isFinite(action.range.max)
    && action.range.min < action.range.max && (action.range.step === undefined || (Number.isFinite(action.range.step) && action.range.step > 0 && action.range.step <= action.range.max - action.range.min))
    && (action.encode?.kind !== 'midi' || action.encode.msg === 'cc');
}

function aligned(value: number, origin: number, step: number): boolean {
  const ratio = (value - origin) / step;
  return Math.abs(ratio - Math.round(ratio)) < 1e-6;
}

/** Validation uses live verification, including step dependencies; client claims never grant access. */
export function validateGestureMap(input: unknown, driver: ForgeDriver, verification?: Verification): GestureMap {
  const map = GestureMap.parse(input);
  const errors: string[] = [];
  const actions = new Map(driver.actions.map((action) => [action.actionId, action]));
  const used = new Set<string>();
  for (const binding of [...map.axes, ...map.postures]) {
    const action = actions.get(binding.actionId);
    if (!action || !available(action, driver, verification)) {
      errors.push(`${binding.actionId}: requires a verified action without hold confirmation`);
      continue;
    }
    if ('axis' in binding) {
      if (!continuous(action)) errors.push(`${binding.actionId}: axis requires a supported numeric set action`);
      if (used.has(binding.actionId)) errors.push(`${binding.actionId}: only one axis can drive an action`);
      used.add(binding.actionId);
      const range = action.range;
      if (range && (binding.outMin < range.min || binding.outMax > range.max)) errors.push(`${binding.actionId}: output exceeds the driver range`);
      if (binding.quantizeStep > binding.outMax - binding.outMin) errors.push(`${binding.actionId}: quantization exceeds the output span`);
      if (range?.step && (!aligned(binding.quantizeStep, 0, range.step) || !aligned(binding.outMin, range.min, range.step)
        || !aligned(binding.outMax, range.min, range.step))) errors.push(`${binding.actionId}: quantization must follow the driver step`);
      if (binding.maxRateHz > axisCap(action, driver)) errors.push(`${binding.actionId}: exceeds the action rate limit`);
    } else {
      if (binding.maxRateHz > Math.min(2, axisCap(action, driver))) errors.push(`${binding.actionId}: exceeds the posture rate limit`);
      const value = binding.value;
      if (action.kind === 'set' && (typeof value !== 'number' || !action.range || value < action.range.min || value > action.range.max
        || (action.range.step && !aligned(value, action.range.min, action.range.step)))) errors.push(`${binding.actionId}: posture needs a value within the driver range and step`);
      if (action.kind === 'toggle' && value !== undefined) errors.push(`${binding.actionId}: toggle uses the driver's fixed operation; omit value`);
    }
  }
  if (errors.length) throw new Error(`Invalid gesture map: ${errors.join('; ')}`);
  return map;
}

function words(action: ForgeAction): string {
  return `${action.actionId} ${action.label}`.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
}

/** Small semantic defaults: action names and declared ranges are the hardware contract. */
export function proposeGestureMap(driver: ForgeDriver, verification?: Verification, _device?: ForgeDevice): GestureMap | undefined {
  const actions = driver.actions.filter((action) => available(action, driver, verification));
  const map: GestureMap = { version: 1, clutchPosture: 'L_FIST', panicPosture: 'BOTH_PALMS_OUT', axes: [], postures: [] };
  const used = new Set<string>();
  const find = (patterns: RegExp[], numeric: boolean): ForgeAction | undefined => {
    for (const pattern of patterns) {
      const action = actions.find((candidate) => !used.has(candidate.actionId) && (numeric ? continuous(candidate) : candidate.kind !== 'set') && pattern.test(words(candidate)));
      if (action) return action;
    }
    return undefined;
  };
  const axis = (id: GestureAxis, patterns: RegExp[], options: Partial<GestureAxisBinding> = {}) => {
    const action = find(patterns, true);
    if (!action?.range) return;
    const { min, max, step } = action.range;
    const binding: GestureAxisBinding = {
      axis: id, actionId: action.actionId, label: action.label, outMin: min, outMax: step ? min + Math.floor((max - min) / step) * step : max,
      curve: 'linear', deadzone: id === 'right_roll' ? 0.08 : 0.02,
      smoothingMinCutoff: 1.2, smoothingBeta: 0.4,
      quantizeStep: step ?? (max - min) / 127, maxRateHz: axisCap(action, driver), ...options,
    };
    if (driver.transport === 'ir') {
      binding.quantizeStep = step ?? (max - min) / 10;
      binding.smoothingMinCutoff = 0.8;
      binding.smoothingBeta = 0.2;
    }
    binding.maxRateHz = Math.min(binding.maxRateHz, axisCap(action, driver));
    used.add(action.actionId);
    map.axes.push(binding);
  };
  const posture = (id: GesturePosture, patterns: RegExp[]) => {
    const action = find(patterns, false);
    if (!action) return;
    used.add(action.actionId);
    map.postures.push({ posture: id, actionId: action.actionId, label: action.label, mode: 'press', maxRateHz: Math.min(2, axisCap(action, driver)) });
  };
  if (driver.transport === 'ir') {
    axis('right_height', [/\bbrightness\b/, /\blevel\b/, /\bdimmer\b/]);
    posture('R_PINCH', [/\bfull(?:\s+on)?\b/, /\bon\b/]);
    posture('R_FIST', [/\boff\b/]);
    posture('R_POINT', [/\bbrighter\b/, /\bbrightness up\b/]);
    posture('R_OPEN_PALM', [/\bdimmer\b/, /\bdarker\b/, /\bbrightness down\b/]);
  } else if (driver.transport === 'local') {
    axis('right_height', [/\bvolume\b/], { maxRateHz: Math.min(10, driver.maxRateHz ?? 10) });
    posture('R_PINCH', [/\bplay\s*pause\b/]);
    posture('R_POINT', [/\bnext\b/]);
    posture('R_FIST', [/\bprev(?:ious)?\b/]);
  } else {
    axis('right_height', [/\bwarp\b/, /\bcutoff\b/, /\bfilter\b/, /\btimbre\b/, /\bengine param(?:eter)? 1\b/], { curve: 's-curve' });
    // The visual synth's golden path: push/pull plays the water ripples with no extra Ask Muse round-trip.
    axis('right_depth', [/\b(?:water )?ripples?\b/, /\bwater\b/], { smoothingMinCutoff: 2.5, smoothingBeta: 0.7, maxRateHz: Math.min(20, driver.maxRateHz ?? 20) });
    axis('right_roll', [/\bzoom\b/, /\bpitch\s*bend\b/, /\bresonance\b/, /\bengine param(?:eter)? 2\b/], { bipolar: true });
    axis('right_pinch_aperture', [/\bhue\b/, /\bresonance\b/, /\b(?:fx|effect) mix\b/, /\bengine param(?:eter)? 3\b/]);
    axis('two_hand_distance', [/\breverb\b/, /\b(?:fx|effect) mix\b/]);
  }
  return map.axes.length || map.postures.length ? validateGestureMap(map, driver, verification) : undefined;
}
