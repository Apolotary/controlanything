/**
 * Camera oracle (SPEC §3.3): did the device visibly change the way the action said it would?
 * Before/after frames at (nearly) the same pose. Two luma metrics:
 *   - mask vs ring: mean luma inside the SAM polygon over a ring around it; cancels auto-exposure, sees on/off
 *     and anything that changes the lamp more than its surroundings;
 *   - absolute: mean luma of mask + ring; sees brightness STEPS of a lamp that lights its own ring (the ceiling
 *     around it, where the ratio barely moves), but only at a fixed exposure (`exposureLocked`: synthetic or
 *     replayed frames, or a camera with AE off). Under auto-exposure it is ignored.
 * R/B ratio inside the mask for colour temperature. Deterministic, no model, < 200 ms.
 */
import type { Effect, Evidence, Polygon } from '@ce/protocol';
import { type DecodedImage, maskAndRing } from './image';

export interface CameraThresholds {
  /** relative change of mask/ring luma ratio that counts as brighter/dimmer */
  luma: number;
  /** relative change of the absolute mask+ring luma that counts as a step (fixed exposure only) */
  abs: number;
  /** relative change of the R/B ratio that counts as warmer/cooler */
  rb: number;
  /** relative change of the ratio that counts as on/off (a big step) */
  onOff: number;
  /** relative change of the absolute luma that counts as on/off (fixed exposure only) */
  onOffAbs: number;
}

export const DEFAULT_CAMERA_THRESHOLDS: CameraThresholds = { luma: 0.12, abs: 0.04, rb: 0.08, onOff: 0.4, onOffAbs: 0.5 };

export type ObservedEffect = Extract<Effect, 'brighter' | 'dimmer' | 'warmer' | 'cooler' | 'none'>;
export type LumaMetric = 'luma-mask-vs-ring' | 'luma-abs';

export interface CameraOptions {
  /** the frames were taken at a fixed exposure (synthetic/replay frames, AE locked): absolute luma is meaningful */
  exposureLocked?: boolean;
}

export interface CameraObservation {
  /** mask/ring luma ratio before and after */
  before: number;
  after: number;
  /** relative change of the ratio */
  delta: number;
  /**
   * absolute luma of what the lamp lights (the RING only: the shade itself clips at every level) before/after
   * and its relative change: the brightness-step metric at a fixed exposure
   */
  absBefore: number;
  absAfter: number;
  absDelta: number;
  /** absolute luma of mask + ring: the on/off metric at a fixed exposure */
  allDelta: number;
  /** which luma metric decided the brightness verdict */
  metric: LumaMetric;
  /** relative change of the R/B ratio */
  rbDelta: number;
  rbBefore: number;
  rbAfter: number;
  maskPixels: number;
  exposureLocked: boolean;
  /** the dominant effect seen */
  effect: ObservedEffect;
  /** a second, weaker effect (dimmer AND warmer for a night light) */
  secondary?: ObservedEffect;
}

export function normalizedLuma(img: DecodedImage, polygon: Polygon): { ratio: number; ring: number; all: number; rb: number; pixels: number } {
  const { mask, ring, all } = maskAndRing(img, polygon);
  const ratio = (mask.luma + 1) / (ring.luma + 1);
  return { ratio, ring: ring.luma + 1, all: all.luma + 1, rb: mask.rb, pixels: mask.pixels };
}

/** Compare two frames inside one polygon. */
export function observeCamera(before: DecodedImage, after: DecodedImage, polygon: Polygon, th: CameraThresholds = DEFAULT_CAMERA_THRESHOLDS, o: CameraOptions = {}): CameraObservation {
  const a = normalizedLuma(before, polygon);
  const b = normalizedLuma(after, polygon);
  const delta = (b.ratio - a.ratio) / a.ratio;
  const absDelta = (b.ring - a.ring) / a.ring;
  const allDelta = (b.all - a.all) / a.all;
  const rbDelta = (b.rb - a.rb) / a.rb;
  const locked = Boolean(o.exposureLocked);
  const ratioEffect: ObservedEffect | undefined = delta > th.luma ? 'brighter' : delta < -th.luma ? 'dimmer' : undefined;
  const absEffect: ObservedEffect | undefined = locked ? (absDelta > th.abs ? 'brighter' : absDelta < -th.abs ? 'dimmer' : undefined) : undefined;
  // at a fixed exposure the absolute metric sees steps the ratio cannot (the lamp lights its own ring); it leads there
  let lumaEffect: ObservedEffect | undefined;
  let metric: LumaMetric = 'luma-mask-vs-ring';
  if (locked && absEffect) {
    lumaEffect = absEffect;
    metric = 'luma-abs';
  } else if (ratioEffect) lumaEffect = ratioEffect;
  const rbEffect: ObservedEffect | undefined = rbDelta > th.rb ? 'warmer' : rbDelta < -th.rb ? 'cooler' : undefined;
  let effect: ObservedEffect = 'none';
  let secondary: ObservedEffect | undefined;
  if (lumaEffect && rbEffect) {
    const lumaStrength = metric === 'luma-abs' ? Math.abs(absDelta) / th.abs : Math.abs(delta) / th.luma;
    if (lumaStrength >= Math.abs(rbDelta) / th.rb) {
      effect = lumaEffect;
      secondary = rbEffect;
    } else {
      effect = rbEffect;
      secondary = lumaEffect;
    }
  } else effect = lumaEffect ?? rbEffect ?? 'none';
  return { before: a.ratio, after: b.ratio, delta, absBefore: a.ring, absAfter: b.ring, absDelta, allDelta, metric, rbDelta, rbBefore: a.rb, rbAfter: b.rb, maskPixels: a.pixels, exposureLocked: locked, effect, secondary };
}

/** Does an observation satisfy an expected effect? `any` passes on any clear change. */
export function cameraMatches(obs: CameraObservation, expected: Effect, th: CameraThresholds = DEFAULT_CAMERA_THRESHOLDS): boolean {
  const seen = new Set<ObservedEffect>([obs.effect]);
  if (obs.secondary) seen.add(obs.secondary);
  switch (expected) {
    case 'brighter':
      return seen.has('brighter');
    case 'dimmer':
      return seen.has('dimmer');
    case 'on':
      return obs.delta > th.onOff || (obs.exposureLocked && obs.allDelta > th.onOffAbs);
    case 'off':
      return obs.delta < -th.onOff || (obs.exposureLocked && obs.allDelta < -th.onOffAbs / (1 + th.onOffAbs));
    case 'warmer':
      return seen.has('warmer');
    case 'cooler':
      return seen.has('cooler');
    case 'any':
      return obs.effect !== 'none';
    case 'none':
      return obs.effect === 'none';
    default:
      return false;
  }
}

/** The `observed` part of an Evidence record for a camera check. */
export function cameraEvidence(obs: CameraObservation, expected: Effect, th: CameraThresholds = DEFAULT_CAMERA_THRESHOLDS): Evidence['observed'] {
  const colour = expected === 'warmer' || expected === 'cooler';
  const seen = obs.effect === 'none' ? 'no change' : obs.secondary ? `${obs.effect} + ${obs.secondary}` : obs.effect;
  if (colour) return { sense: 'camera', metric: 'rb-ratio', before: round(obs.rbBefore), after: round(obs.rbAfter), delta: round(obs.rbDelta), threshold: th.rb, note: `seen: ${seen}` };
  const onOff = expected === 'on' || expected === 'off';
  if (onOff && obs.exposureLocked && Math.abs(obs.allDelta) >= Math.abs(obs.delta)) return { sense: 'camera', metric: 'luma-abs', before: round(obs.absBefore), after: round(obs.absAfter), delta: round(obs.allDelta), threshold: th.onOffAbs, note: `seen: ${seen} (mask+ring, fixed exposure)` };
  if (!onOff && obs.exposureLocked && obs.metric === 'luma-abs') return { sense: 'camera', metric: 'luma-abs', before: round(obs.absBefore), after: round(obs.absAfter), delta: round(obs.absDelta), threshold: th.abs, note: `seen: ${seen} (ring, fixed exposure)` };
  return { sense: 'camera', metric: 'luma-mask-vs-ring', before: round(obs.before), after: round(obs.after), delta: round(obs.delta), threshold: onOff ? th.onOff : th.luma, note: `seen: ${seen}` };
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
