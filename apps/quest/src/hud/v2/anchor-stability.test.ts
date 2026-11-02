import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { ChipAttention, StableAnchor, candidateScore, chipScale } from './anchor-stability';

describe('stable device anchors', () => {
  it('holds through 12 cm of detector noise without cumulative drift', () => {
    const anchor = new StableAnchor(), point = new Vector3(0, 1, -2);
    anchor.reset(point);
    for (let i = 0; i < 120; i++) {
      anchor.observe(new Vector3(Math.sin(i) * 0.1, 1, -2), i / 30);
      expect(anchor.update(i / 30)).toBe(false);
      expect(anchor.accepted.equals(point)).toBe(true);
    }
  });
  it('accepts movement only after a sustained half second, and rejects stale evidence', () => {
    const anchor = new StableAnchor(), moved = new Vector3(0.3, 0, -1);
    anchor.reset(new Vector3(0, 0, -1));
    anchor.observe(moved, 0);
    expect(anchor.update(0.49)).toBe(false);
    expect(anchor.update(0.51)).toBe(false); // One outlier is not sustained detector evidence.
    anchor.observe(moved, 0.5);
    expect(anchor.update(0.5)).toBe(true);
    expect(anchor.accepted.equals(moved)).toBe(true);
    anchor.observe(new Vector3(1, 0, -1), 1);
    expect(anchor.update(2)).toBe(false);
  });
  it('cancels a briefly displaced observation when it returns inside the deadband', () => {
    const anchor = new StableAnchor(); anchor.reset(new Vector3());
    anchor.observe(new Vector3(0.2, 0, 0), 0);
    anchor.observe(new Vector3(0.01, 0, 0), 0.3);
    expect(anchor.update(0.6)).toBe(false);
  });
});

describe('chip attention and angular sizes', () => {
  const cos = (degrees: number) => Math.cos(degrees * Math.PI / 180);
  it('requires 250 ms to expand and keeps its state between 12 and 16 degrees', () => {
    const state = new ChipAttention();
    expect(state.update(cos(10), 0)).toBe(false);
    expect(state.update(cos(10), 0.249)).toBe(false);
    expect(state.update(cos(10), 0.25)).toBe(true);
    expect(state.update(cos(14), 0.3)).toBe(true);
    expect(state.update(cos(17), 0.4)).toBe(false);
    expect(state.update(cos(14), 0.7)).toBe(false);
    expect(state.update(cos(90), 0.8, true)).toBe(true);
  });
  it('ranks central candidates first and excludes distant or peripheral candidates', () => {
    expect(candidateScore(2, cos(1))).toBeLessThan(candidateScore(1, cos(20)));
    expect(candidateScore(3.01, 1)).toBe(Infinity);
    expect(candidateScore(1, cos(31))).toBe(Infinity);
  });
  it.each([0.5, 1, 2, 3])('keeps a chip at least four degrees tall at %s m', (distance) => {
    const height = 0.07 * chipScale(distance, 0.07);
    expect(2 * Math.atan(height / (2 * distance)) * 180 / Math.PI).toBeGreaterThanOrEqual(4);
  });
});
