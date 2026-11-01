import type { AudioFeatures, Polygon } from '@ce/protocol';
import { describe, expect, it } from 'vitest';
import { audioEvidence, audioMatches, observeAudio } from './audio';
import { cameraEvidence, cameraMatches, observeCamera } from './camera';
import { type DecodedImage, decodeJpeg, encodeJpeg, maskAndRing } from './image';

/** A room: grey background at `bg`, a round lamp of `lamp` brightness (and colour tint) at the top centre. */
export function roomImage(opts: { bg: number; lamp: number; warm?: number; width?: number; height?: number }): DecodedImage {
  const width = opts.width ?? 320;
  const height = opts.height ?? 240;
  const data = new Uint8Array(width * height * 4);
  const cx = width / 2;
  const cy = height * 0.25;
  const r = height * 0.15;
  const warm = opts.warm ?? 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const inLamp = (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
      const v = inLamp ? opts.lamp : opts.bg;
      data[i] = Math.min(255, v + (inLamp ? warm : 0));
      data[i + 1] = v;
      data[i + 2] = Math.max(0, v - (inLamp ? warm : 0));
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

/** Octagon around the lamp (what SAM's polygon would be). */
export function lampPolygon(width = 320, height = 240): Polygon {
  const cx = width / 2;
  const cy = height * 0.25;
  const r = height * 0.15;
  return Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * Math.PI * 2;
    return [Math.round(cx + r * Math.cos(a)), Math.round(cy + r * Math.sin(a))] as [number, number];
  });
}

describe('camera oracle', () => {
  const poly = lampPolygon();

  it('sees the lamp get dimmer and brighter, through JPEG compression', () => {
    const on = decodeJpeg(encodeJpeg(roomImage({ bg: 90, lamp: 230 })));
    const off = decodeJpeg(encodeJpeg(roomImage({ bg: 90, lamp: 95 })));
    const obs = observeCamera(on, off, poly);
    expect(obs.effect).toBe('dimmer');
    expect(obs.delta).toBeLessThan(-0.4);
    expect(cameraMatches(obs, 'off')).toBe(true);
    expect(cameraMatches(obs, 'dimmer')).toBe(true);
    expect(cameraMatches(obs, 'brighter')).toBe(false);
    const back = observeCamera(off, on, poly);
    expect(back.effect).toBe('brighter');
    expect(cameraMatches(back, 'on')).toBe(true);
    expect(cameraEvidence(obs, 'off')).toMatchObject({ sense: 'camera', metric: 'luma-mask-vs-ring', threshold: 0.4 });
  });

  it('cancels auto-exposure: a globally darker frame with the same lamp is "no change"', () => {
    const a = roomImage({ bg: 90, lamp: 230 });
    const b = roomImage({ bg: 70, lamp: 180 }); // exposure dropped ~22% everywhere
    const obs = observeCamera(a, b, poly);
    expect(Math.abs(obs.delta)).toBeLessThan(0.12);
    expect(obs.effect).toBe('none');
    expect(cameraMatches(obs, 'none')).toBe(true);
    expect(cameraMatches(obs, 'any')).toBe(false);
  });

  it('reads colour temperature from the R/B ratio inside the mask', () => {
    const cool = roomImage({ bg: 90, lamp: 200, warm: 0 });
    const warm = roomImage({ bg: 90, lamp: 200, warm: 40 });
    const obs = observeCamera(cool, warm, poly);
    expect(obs.effect).toBe('warmer');
    expect(cameraMatches(obs, 'warmer')).toBe(true);
    expect(cameraEvidence(obs, 'warmer').metric).toBe('rb-ratio');
    expect(observeCamera(warm, cool, poly).effect).toBe('cooler');
  });

  it('a step dimmer counts as dimmer but not as off', () => {
    const a = roomImage({ bg: 90, lamp: 230 });
    const b = roomImage({ bg: 90, lamp: 190 });
    const obs = observeCamera(a, b, poly);
    expect(obs.effect).toBe('dimmer');
    expect(cameraMatches(obs, 'off')).toBe(false);
    const stats = maskAndRing(a, poly);
    expect(stats.mask.luma).toBeGreaterThan(stats.ring.luma);
  });
});

describe('audio oracle', () => {
  const quiet: AudioFeatures = { rms: 0.05, centroidHz: 800, bands: [] };
  const loud: AudioFeatures = { rms: 0.2, centroidHz: 800, bands: [] };
  const bright: AudioFeatures = { rms: 0.05, centroidHz: 1600, bands: [] };
  const silence: AudioFeatures = { rms: 0.0001, rmsDb: -80, centroidHz: 0, bands: [] };

  it('hears level and timbre changes', () => {
    const l = observeAudio(quiet, loud);
    expect(l.effect).toBe('louder');
    expect(l.rmsDelta).toBeCloseTo(12.04, 1);
    expect(audioMatches(l, 'louder')).toBe(true);
    expect(audioMatches(l, 'any')).toBe(true);
    const t = observeAudio(quiet, bright);
    expect(t.effect).toBe('tone-up');
    expect(t.centroidOctaves).toBeCloseTo(1, 5);
    expect(audioMatches(t, 'tone-down')).toBe(false);
    expect(audioEvidence(t, 'tone-up').metric).toBe('centroid');
    expect(audioEvidence(l, 'louder').metric).toBe('rms');
  });

  it('is quiet about silence and small wobbles', () => {
    const s = observeAudio(silence, silence);
    expect(s.effect).toBe('none');
    expect(s.silent).toBe(true);
    const wobble = observeAudio(quiet, { ...quiet, rms: 0.055, centroidHz: 850 });
    expect(wobble.effect).toBe('none');
    expect(audioMatches(wobble, 'none')).toBe(true);
  });
});
