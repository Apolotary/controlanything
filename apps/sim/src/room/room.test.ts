import { describe, expect, it } from 'vitest';
import { cctToRgb, luma } from './cct';
import { compose, stats, tone, type CameraParams, type RoomLayers } from './compose';
import { decodeHdr } from './hdr';
import { applyCmd, DEFAULT_STATE, LampAnimator, LEVELS, NIGHT_SHADE_GLOW, targetDisplay, type LampState } from './lamp';

/** A tiny synthetic room: a bright disc (the lamp) on a dim ceiling, lit walls below. */
function tinyRoom(w = 64, h = 48): { layers: RoomLayers; lampBox: { x: number; y: number; w: number; h: number } } {
  const n = w * h * 3;
  const sky = new Float32Array(n);
  const lamp = new Float32Array(n);
  const night = new Float32Array(n);
  const lampBox = { x: 24, y: 4, w: 16, h: 8 };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const inLamp = x >= lampBox.x && x < lampBox.x + lampBox.w && y >= lampBox.y && y < lampBox.y + lampBox.h;
      sky.set([0.02, 0.025, 0.04], i);
      lamp.set(inLamp ? [1, 1, 1] : y > 16 ? [0.05, 0.05, 0.05] : [0.015, 0.015, 0.015], i);
      night.set(inLamp && x > 30 && x < 34 ? [1, 1, 1] : [0.0005, 0.0005, 0.0005], i);
    }
  }
  return { layers: { width: w, height: h, sky, lamp, night }, lampBox };
}

const CAM: CameraParams = { exposure: 1, skyGain: 1, lampGain: 1.4, nightGain: 0.2 };

function frame(layers: RoomLayers, s: LampState, noise = 0) {
  const out = new Uint8ClampedArray(layers.width * layers.height * 4);
  compose(layers, targetDisplay(s), CAM, out, { noise, seed: 5 });
  return out;
}

describe('lamp state machine', () => {
  it('follows the remote', () => {
    let s = DEFAULT_STATE;
    expect(s.power).toBe('off');
    s = applyCmd(s, 'brighter');
    expect(s.power).toBe('off'); // brightness keys do nothing while off
    s = applyCmd(s, 'fullOn');
    expect(s).toMatchObject({ power: 'on', level: 10 });
    for (let i = 0; i < 12; i++) s = applyCmd(s, 'dimmer');
    expect(s.level).toBe(1);
    expect(s.cctK).toBe(4800);
    s = applyCmd(applyCmd(s, 'warmer'), 'warmer');
    expect(s.cctK).toBe(3200);
    for (let i = 0; i < 9; i++) s = applyCmd(s, 'cooler');
    expect(s.cctK).toBe(6500);
    s = applyCmd(s, 'night');
    expect(targetDisplay(s)).toMatchObject({ main: NIGHT_SHADE_GLOW, night: 1 });
    s = applyCmd(s, 'on');
    expect(targetDisplay(s).main).toBe(LEVELS[0]);
  });

  it('fades smoothly (no flashes) as a function of time, with history for "before" frames', () => {
    const t0 = 1_000_000;
    const a = new LampAnimator(DEFAULT_STATE, 450, 600, t0);
    a.setTarget(applyCmd(DEFAULT_STATE, 'fullOn'), { now: t0 });
    let prev = 0;
    let settledAt = 0;
    for (let t = t0; t <= t0 + 6000; t += 16) {
      const m = a.at(t).main;
      expect(m).toBeGreaterThanOrEqual(prev); // monotonic, no overshoot
      expect(m - prev).toBeLessThan(0.05); // < 5 % of full per 16 ms frame
      if (!settledAt && m === 1) settledAt = t;
      prev = m;
    }
    expect(prev).toBe(1);
    expect((settledAt - t0) / 1000).toBeGreaterThan(1.0);
    expect((settledAt - t0) / 1000).toBeLessThan(5.0);
    expect(a.at(t0 - 5).main).toBe(0);
    // a new command mid-fade starts from where the light is, not from the old target
    a.setTarget(DEFAULT_STATE, { now: t0 + 300 });
    expect(a.at(t0 + 300).main).toBeCloseTo(1 - Math.exp(-300 / 450), 5);
    expect(a.at(t0 + 300 + 8000).main).toBe(0);
  });
});

describe('colour temperature', () => {
  it('keeps luminance and moves R/B the right way', () => {
    const warm = cctToRgb(2700);
    const mid = cctToRgb(5000);
    const cool = cctToRgb(6500);
    for (const c of [warm, mid, cool]) expect(luma(c)).toBeCloseTo(1, 1);
    expect(mid[0] / mid[2]).toBeCloseTo(1, 2);
    expect(warm[0] / warm[2]).toBeGreaterThan(1.5);
    expect(cool[0] / cool[2]).toBeLessThan(0.9);
  });
});

describe('sim camera (compositor)', () => {
  const { layers, lampBox } = tinyRoom();

  it('brightness steps change the frame and the lamp region monotonically', () => {
    const off = stats(frame(layers, DEFAULT_STATE), layers.width);
    let prevFrame = off.luma;
    let prevLamp = stats(frame(layers, DEFAULT_STATE), layers.width, lampBox).luma;
    for (let level = 1; level <= 10; level++) {
      const s: LampState = { ...DEFAULT_STATE, power: 'on', level };
      const f = frame(layers, s);
      const all = stats(f, layers.width).luma;
      const roi = stats(f, layers.width, lampBox).luma;
      expect(all).toBeGreaterThan(prevFrame);
      expect(roi).toBeGreaterThan(prevLamp);
      prevFrame = all;
      prevLamp = roi;
    }
    // full on vs off is a big, unmistakable change
    expect(prevFrame / off.luma).toBeGreaterThan(2);
  });

  it('colour keys show up as an R/B change of >= 10 % in the lamp region', () => {
    const on: LampState = { ...DEFAULT_STATE, power: 'on', level: 10 };
    const rb = (k: number) => stats(frame(layers, { ...on, cctK: k }), layers.width, lampBox).rb;
    expect(rb(2700) / rb(5000)).toBeGreaterThan(1.1);
    expect(rb(5000) / rb(6500)).toBeGreaterThan(1.1);
  });

  it('night light is dim but visible', () => {
    const night = stats(frame(layers, { ...DEFAULT_STATE, power: 'night' }), layers.width, lampBox);
    const off = stats(frame(layers, DEFAULT_STATE), layers.width, lampBox);
    const full = stats(frame(layers, { ...DEFAULT_STATE, power: 'on', level: 10 }), layers.width, lampBox);
    expect(night.luma).toBeGreaterThan(off.luma);
    expect(night.luma).toBeLessThan(full.luma);
    expect(night.rb).toBeGreaterThan(1.05); // amber
  });

  it('adds bounded sensor noise only when asked', () => {
    const s: LampState = { ...DEFAULT_STATE, power: 'on', level: 5 };
    const clean = frame(layers, s);
    const noisy = frame(layers, s, 1);
    let diff = 0;
    for (let i = 0; i < clean.length; i += 4) diff += Math.abs(clean[i]! - noisy[i]!);
    const mean = diff / (clean.length / 4);
    expect(mean).toBeGreaterThan(0.3);
    expect(mean).toBeLessThan(6);
  });

  it('tone curve is monotonic and bounded', () => {
    let prev = -1;
    for (let x = 0; x < 20; x += 0.05) {
      const y = tone(x);
      expect(y).toBeGreaterThanOrEqual(prev);
      expect(y).toBeLessThanOrEqual(1);
      prev = y;
    }
  });
});

describe('Radiance HDR decoder', () => {
  function rgbe(r: number, g: number, b: number): number[] {
    const v = Math.max(r, g, b);
    if (v < 1e-32) return [0, 0, 0, 0];
    const e = Math.ceil(Math.log2(v) + 1e-9);
    const f = 256 / 2 ** e;
    return [Math.floor(r * f), Math.floor(g * f), Math.floor(b * f), e + 128];
  }
  it('decodes flat and RLE scanlines', () => {
    const w = 10;
    const h = 2;
    const header = `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${h} +X ${w}\n`;
    const px = [0.5, 0.25, 0.125];
    const flatRow: number[] = [];
    for (let x = 0; x < w; x++) flatRow.push(...rgbe(px[0]!, px[1]!, px[2]!));
    // RLE row: 2 2 0 w, then each channel as one run of w identical bytes
    const one = rgbe(2, 1, 0.5);
    const rleRow = [2, 2, 0, w, ...one.flatMap((v) => [128 + w, v])];
    const bytes = new Uint8Array([...new TextEncoder().encode(header), ...flatRow, ...rleRow]);
    const img = decodeHdr(bytes);
    expect(img.width).toBe(w);
    expect(img.height).toBe(h);
    expect(img.data[0]).toBeCloseTo(0.5, 2);
    expect(img.data[2]).toBeCloseTo(0.125, 2);
    expect(img.data[w * 3]).toBeCloseTo(2, 1);
    expect(img.data[w * 3 + 2]).toBeCloseTo(0.5, 1);
  });
});
