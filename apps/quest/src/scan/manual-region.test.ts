import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import type { Handedness, ShellFrame } from '../app/hud-contract';
import { ManualRegionSelector } from './manual-region';
import { cameraPoseFromHead, pixelToRay, questIntrinsics } from './projection';

function setup() {
  const selector = new ManualRegionSelector();
  const head = { position: new Vector3(0, 1.6, 0), quaternion: new Quaternion() };
  const cam = cameraPoseFromHead(head, 'left'), k = questIntrinsics(1280, 960);
  const frame = { head: { ...head, ray: pixelToRay(640, 480, k, cam) }, hands: {} } as ShellFrame;
  const hand = (side: Handedness, u: number, v: number, pinching: boolean) => {
    frame.hands[side] = { pinching, ray: pixelToRay(u * 1280, v * 960, k, cam) } as ShellFrame['hands']['right'];
  };
  hand('left', 0.2, 0.2, false); hand('right', 0.9, 0.9, false);
  selector.begin();
  const step = () => selector.update(frame, 'left');
  const expectRegion = (region: ReturnType<typeof step>) => {
    expect(region).toBeDefined();
    [0.2, 0.2, 0.7, 0.8].forEach((value, index) => expect(region![index]).toBeCloseTo(value));
    expect(selector.active).toBe(false);
  };
  return { selector, frame, hand, step, expectRegion };
}

describe('manual scan hand ownership', () => {
  it('accepts two left-hand corners while the tracked right hand stays idle', () => {
    const f = setup(); f.step();
    f.hand('left', 0.2, 0.2, true); expect(f.step()).toBeUndefined();
    f.hand('left', 0.7, 0.8, false); f.step();
    f.hand('left', 0.7, 0.8, true); f.expectRegion(f.step());
  });

  it('keeps the first-corner hand when the other hand pinches or its owner is lost', () => {
    const f = setup(); f.hand('right', 0.2, 0.2, false); f.step();
    f.hand('right', 0.2, 0.2, true); f.step();
    f.hand('right', 0.7, 0.8, false); f.step();
    delete f.frame.hands.right;
    f.hand('left', 0.7, 0.8, true); expect(f.step()).toBeUndefined();
    expect(f.selector.active).toBe(true);
    // Recovering an already held owner pinch is not a new corner.
    f.hand('right', 0.7, 0.8, true); expect(f.step()).toBeUndefined();
    f.hand('right', 0.7, 0.8, false); f.step();
    f.hand('right', 0.7, 0.8, true); f.expectRegion(f.step());
  });

  it('suppresses each hand held at activation until that hand releases', () => {
    const f = setup();
    f.hand('left', 0.2, 0.2, true); f.hand('right', 0.9, 0.9, true);
    expect(f.step()).toBeUndefined();
    f.hand('left', 0.2, 0.2, false); f.step();
    f.hand('left', 0.2, 0.2, true); expect(f.step()).toBeUndefined();
    f.hand('left', 0.7, 0.8, false); f.step();
    f.hand('left', 0.7, 0.8, true); f.expectRegion(f.step());
  });

  it('releases ownership on cancellation before another hand starts a new region', () => {
    const f = setup(); f.step();
    f.hand('left', 0.2, 0.2, true); f.step();
    f.selector.cancel(); f.selector.begin();
    f.hand('right', 0.2, 0.2, false); f.step();
    f.hand('right', 0.2, 0.2, true); f.step();
    f.hand('right', 0.7, 0.8, false); f.step();
    f.hand('right', 0.7, 0.8, true); f.expectRegion(f.step());
  });
});
