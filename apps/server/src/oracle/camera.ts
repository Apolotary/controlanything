/**
 * Camera oracle (SPEC §3.3): did the device visibly change the way the action said it would?
 * Before/after frames at (nearly) the same pose; mean luma inside the SAM polygon vs a ring around it
 * (cancels auto-exposure); delta = (mask_after/ring_after) - (mask_before/ring_before). R/B ratio inside the
 * mask for colour temperature. Deterministic, no model, < 200 ms.
 */
import type { Effect, Evidence, Polygon } from '@ce/protocol';
import { type DecodedImage, maskAndRing } from './image';

export interface CameraThresholds {
  /** relative change of mask/ring luma ratio that counts as brighter/dimmer */
  luma: number;
  /** relative change of the R/B ratio that counts as warmer/cooler */
  rb: number;
  /** relative change that counts as on/off (a big step) */
  onOff: number;
}

export const DEFAULT_CAMERA_THRESHOLDS: CameraThresholds = { luma: 0.12, rb: 0.08, onOff: 0.4 };

export type ObservedEffect = Extract<Effect, 'brighter' | 'dimmer' | 'warmer' | 'cooler' | 'none'>;

export interface CameraObservation {
  /** mask/ring luma ratio before and after */
  before: number;
  after: number;
  /** relative change of the ratio */
  delta: number;
  /** relative change of the R/B ratio */
  rbDelta: number;
  rbBefore: number;
  rbAfter: number;
  maskPixels: number;
  /** the dominant effect seen */
  effect: ObservedEffect;
  /** a second, weaker effect (dimmer AND warmer for a night light) */
  secondary?: ObservedEffect;
}

export function normalizedLuma(img: DecodedImage, polygon: Polygon): { ratio: number; rb: number; pixels: number } {
  const { mask, ring } = maskAndRing(img, polygon);
  const ratio = (mask.luma + 1) / (ring.luma + 1);
  return { ratio, rb: mask.rb, pixels: mask.pixels };
}

/** Compare two frames inside one polygon. */
export function observeCamera(before: DecodedImage, after: DecodedImage, polygon: Polygon, th: CameraThresholds = DEFAULT_CAMERA_THRESHOLDS): CameraObservation {
  const a = normalizedLuma(before, polygon);
  const b = normalizedLuma(after, polygon);
  const delta = (b.ratio - a.ratio) / a.ratio;
  const rbDelta = (b.rb - a.rb) / a.rb;
  let effect: ObservedEffect = 'none';
  let secondary: ObservedEffect | undefined;
  const lumaEffect: ObservedEffect | undefined = delta > th.luma ? 'brighter' : delta < -th.luma ? 'dimmer' : undefined;
  const rbEffect: ObservedEffect | undefined = rbDelta > th.rb ? 'warmer' : rbDelta < -th.rb ? 'cooler' : undefined;
  if (lumaEffect && rbEffect) {
    // the bigger relative change leads
    if (Math.abs(delta) / th.luma >= Math.abs(rbDelta) / th.rb) {
      effect = lumaEffect;
      secondary = rbEffect;
    } else {
      effect = rbEffect;
      secondary = lumaEffect;
    }
  } else effect = lumaEffect ?? rbEffect ?? 'none';
  return { before: a.ratio, after: b.ratio, delta, rbDelta, rbBefore: a.rb, rbAfter: b.rb, maskPixels: a.pixels, effect, secondary };
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
      return obs.delta > th.onOff;
    case 'off':
      return obs.delta < -th.onOff;
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
  return colour
    ? { sense: 'camera', metric: 'rb-ratio', before: round(obs.rbBefore), after: round(obs.rbAfter), delta: round(obs.rbDelta), threshold: th.rb, note: `seen: ${seen}` }
    : { sense: 'camera', metric: 'luma-mask-vs-ring', before: round(obs.before), after: round(obs.after), delta: round(obs.delta), threshold: expected === 'on' || expected === 'off' ? th.onOff : th.luma, note: `seen: ${seen}` };
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
