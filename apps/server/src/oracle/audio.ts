/**
 * Audio oracle (SPEC §3.3): did a CC sweep change the sound? Features come from the companion (the synth's
 * own USB audio input, or the Mac mic) as two windows, before and after: RMS (dBFS) and spectral centroid.
 * louder/quieter = RMS delta beyond a threshold; tone-up/tone-down = centroid moved by more than a fraction
 * of an octave; `any` = either. Deterministic, no model.
 */
import type { AudioFeatures, Effect, Evidence } from '@ce/protocol';

export interface AudioThresholds {
  /** dB */
  rmsDb: number;
  /** octaves of centroid movement */
  centroidOctaves: number;
  /** below this level the window counts as silence (dBFS) */
  silenceDb: number;
}

export const DEFAULT_AUDIO_THRESHOLDS: AudioThresholds = { rmsDb: 3, centroidOctaves: 0.2, silenceDb: -60 };

export type AudioEffect = Extract<Effect, 'louder' | 'quieter' | 'tone-up' | 'tone-down' | 'none'>;

export interface AudioObservation {
  rmsDbBefore: number;
  rmsDbAfter: number;
  rmsDelta: number;
  centroidBefore: number;
  centroidAfter: number;
  /** log2(after/before) */
  centroidOctaves: number;
  silent: boolean;
  effect: AudioEffect;
  secondary?: AudioEffect;
}

export function rmsDb(f: AudioFeatures): number {
  if (typeof f.rmsDb === 'number') return f.rmsDb;
  return f.rms > 0 ? 20 * Math.log10(f.rms) : -120;
}

export function observeAudio(before: AudioFeatures, after: AudioFeatures, th: AudioThresholds = DEFAULT_AUDIO_THRESHOLDS): AudioObservation {
  const a = rmsDb(before);
  const b = rmsDb(after);
  const rmsDelta = b - a;
  const octaves = before.centroidHz > 0 && after.centroidHz > 0 ? Math.log2(after.centroidHz / before.centroidHz) : 0;
  const silent = a < th.silenceDb && b < th.silenceDb;
  const level: AudioEffect | undefined = rmsDelta > th.rmsDb ? 'louder' : rmsDelta < -th.rmsDb ? 'quieter' : undefined;
  const tone: AudioEffect | undefined = silent ? undefined : octaves > th.centroidOctaves ? 'tone-up' : octaves < -th.centroidOctaves ? 'tone-down' : undefined;
  let effect: AudioEffect = 'none';
  let secondary: AudioEffect | undefined;
  if (level && tone) {
    if (Math.abs(rmsDelta) / th.rmsDb >= Math.abs(octaves) / th.centroidOctaves) {
      effect = level;
      secondary = tone;
    } else {
      effect = tone;
      secondary = level;
    }
  } else effect = level ?? tone ?? 'none';
  return { rmsDbBefore: a, rmsDbAfter: b, rmsDelta, centroidBefore: before.centroidHz, centroidAfter: after.centroidHz, centroidOctaves: octaves, silent, effect, secondary };
}

export function audioMatches(obs: AudioObservation, expected: Effect): boolean {
  const seen = new Set<AudioEffect>([obs.effect]);
  if (obs.secondary) seen.add(obs.secondary);
  switch (expected) {
    case 'louder':
    case 'quieter':
    case 'tone-up':
    case 'tone-down':
      return seen.has(expected);
    case 'on':
      return seen.has('louder');
    case 'off':
      return seen.has('quieter');
    case 'any':
      return obs.effect !== 'none';
    case 'none':
      return obs.effect === 'none';
    default:
      return false;
  }
}

export function audioEvidence(obs: AudioObservation, expected: Effect, th: AudioThresholds = DEFAULT_AUDIO_THRESHOLDS): Evidence['observed'] {
  const seen = obs.effect === 'none' ? (obs.silent ? 'silence' : 'no change') : obs.secondary ? `${obs.effect} + ${obs.secondary}` : obs.effect;
  const tonal = expected === 'tone-up' || expected === 'tone-down' || (expected === 'any' && (obs.effect === 'tone-up' || obs.effect === 'tone-down'));
  return tonal
    ? { sense: 'audio', metric: 'centroid', before: round(obs.centroidBefore), after: round(obs.centroidAfter), delta: round(obs.centroidOctaves), threshold: th.centroidOctaves, note: `seen: ${seen}` }
    : { sense: 'audio', metric: 'rms', before: round(obs.rmsDbBefore), after: round(obs.rmsDbAfter), delta: round(obs.rmsDelta), threshold: th.rmsDb, note: `seen: ${seen}` };
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
