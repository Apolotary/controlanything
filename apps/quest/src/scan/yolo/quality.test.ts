import { describe, expect, it } from 'vitest';
import { claimSamTarget, overlapsHand } from './quality';
import type { Box } from './prep';

const box: Box = [100, 100, 80, 60];

describe('projected hand suppression', () => {
  it('keeps a device when a fingertip touches an edge or only part of it is occluded', () => {
    expect(overlapsHand(box, [{ u: 101, v: 159, radius: 0 }])).toBe(false);
    expect(overlapsHand(box, [{ u: 95, v: 125, radius: 6 }])).toBe(false);
    expect(overlapsHand(box, [0, 1, 2, 3, 4].map((i) => ({ u: 105 + i * 2, v: 125, radius: 6 })))).toBe(false);
  });

  it('suppresses a hand-sized detection substantially covered by a joint cluster', () => {
    expect(overlapsHand(box, [{ u: 105, v: 105 }, { u: 175, v: 105 }, { u: 105, v: 155 }, { u: 175, v: 155 }])).toBe(true);
  });

  it('keeps boxes when tracking is unavailable or a projection is invalid', () => {
    expect(overlapsHand(box, [])).toBe(false);
    expect(overlapsHand(box, [{ u: NaN, v: 100 }, { u: 100, v: Infinity }])).toBe(false);
  });
});

describe('SAM ownership of live objects', () => {
  it('associates the strongest screen overlap regardless of the predicted class', () => {
    expect(claimSamTarget(box, [
      { id: 'nearby-device', box: [170, 100, 80, 60] },
      { id: 'ceiling-light', box: [104, 102, 78, 59] },
      { id: 'wide-device', box: [100, 100, 120, 80] },
    ])).toBe('ceiling-light');
  });

  it('accepts mutual coverage despite a different estimated depth', () => {
    expect(claimSamTarget(box, [{ id: 'sam', box: [85, 80, 110, 100] }])).toBe('sam');
  });

  it('does not hand a whole device to a small subobject, even at the same anchor', () => {
    expect(claimSamTarget(box, [{ id: 'button', box: [120, 120, 5, 5], position: { x: 0, y: 0, z: -1 } }], { x: 0, y: 0, z: -1 })).toBeUndefined();
  });

  it('uses close world anchors when a screen box is unavailable', () => {
    expect(claimSamTarget(box, [
      { id: 'far', position: { x: 0.3, y: 0, z: -1 }, sizeM: [0.3, 0.2, 0.1] },
      { id: 'same', position: { x: 0.04, y: 0.02, z: -1 }, sizeM: [0.3, 0.2, 0.1] },
    ], { x: 0, y: 0, z: -1 }, [0.32, 0.22, 0.1])).toBe('same');
  });

  it('rejects tiny subobjects and unknown physical extents when both objects are behind the camera', () => {
    const position = { x: 0, y: 0, z: 1 };
    expect(claimSamTarget(box, [{ id: 'button', position, sizeM: [0.03, 0.02, 0.01] }], position, [0.3, 0.2, 0.1])).toBeUndefined();
    expect(claimSamTarget(box, [{ id: 'unknown-size', position }], position, [0.3, 0.2, 0.1])).toBeUndefined();
    expect(claimSamTarget(box, [{ id: 'known-size', position, sizeM: [0.3, 0.2, 0.1] }], position)).toBeUndefined();
    expect(claimSamTarget(box, [{ id: 'invalid-size', position, sizeM: [-0.3, -0.2, 0.1] }], position, [0.3, 0.2, 0.1])).toBeUndefined();
  });

  it('prefers direct screen evidence over proximity and keeps unrelated objects separate', () => {
    expect(claimSamTarget(box, [
      { id: 'near-anchor', position: { x: 0, y: 0, z: -1 }, sizeM: [0.3, 0.2, 0.1] },
      { id: 'screen-match', box: [102, 100, 80, 60] },
    ], { x: 0, y: 0, z: -1 }, [0.3, 0.2, 0.1])).toBe('screen-match');
    expect(claimSamTarget(box, [{ id: 'other', box: [200, 200, 80, 60] }])).toBeUndefined();
    expect(claimSamTarget(box, [{ id: 'other', position: { x: 0.2, y: 0, z: -1 } }], { x: 0, y: 0, z: -1 })).toBeUndefined();
  });

  it('cannot transfer ownership to a different visible object just because their guessed anchors are close', () => {
    const position = { x: 0, y: 0, z: -1 };
    expect(claimSamTarget(box, [{ id: 'neighbor', box: [200, 100, 80, 60], position, sizeM: [0.3, 0.2, 0.1] }], position, [0.3, 0.2, 0.1])).toBeUndefined();
    expect(claimSamTarget(box, [{ id: 'edge-overlap', box: [170, 100, 80, 60], position, sizeM: [0.3, 0.2, 0.1] }], position, [0.3, 0.2, 0.1])).toBeUndefined();
  });
});
