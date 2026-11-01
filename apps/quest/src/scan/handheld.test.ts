import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { HandheldTracker } from './handheld';

const wrist = (x: number, yawDeg = 0) => ({ position: new Vector3(x, 1.1, -0.3), quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (yawDeg * Math.PI) / 180) });

describe('HandheldTracker', () => {
  it('attaches a held remote to the nearest wrist and follows it', () => {
    const h = new HandheldTracker();
    expect(h.observe('r', 'remote control', new Vector3(0.1, 1.12, -0.38), { right: wrist(0.1) }, 0)).toBe('attached');
    // the hand moves 20 cm left and turns 90°: the remote moves with it, keeping its offset in the wrist frame
    const moved = h.update({ right: wrist(-0.1, 90) }, 100);
    expect(moved).toHaveLength(1);
    expect(moved[0].position.x).toBeCloseTo(-0.1 - 0.08, 5);
    expect(moved[0].position.z).toBeCloseTo(-0.3, 5);
  });

  it('ignores things people do not hold, and devices out of reach', () => {
    const h = new HandheldTracker();
    expect(h.observe('l', 'ceiling light', new Vector3(0.1, 1.1, -0.3), { right: wrist(0.1) }, 0)).toBe('none');
    expect(h.observe('r', 'remote control', new Vector3(0.6, 1.1, -0.3), { right: wrist(0.1) }, 0)).toBe('none');
  });

  it('throttles redraws and releases the device when the hand is lost or it is put down', () => {
    const h = new HandheldTracker();
    h.observe('r', 'remote control', new Vector3(0.1, 1.1, -0.4), { left: wrist(0.1) }, 0);
    expect(h.update({ left: wrist(0.1) }, 10)).toHaveLength(0); // did not move
    expect(h.update({ left: wrist(0.2) }, 20)).toHaveLength(0); // moved, but < 66 ms since the last redraw
    expect(h.update({ left: wrist(0.2) }, 100)).toHaveLength(1);
    h.update({}, 500);
    expect(h.isAttached('r')).toBe(true);
    h.update({}, 1200);
    expect(h.isAttached('r')).toBe(false);
    h.observe('r', 'remote control', new Vector3(0.1, 1.1, -0.4), { left: wrist(0.1) }, 2000);
    expect(h.observe('r', 'remote control', new Vector3(0.1, 0.75, -0.6), { left: wrist(0.1) }, 2100)).toBe('detached');
  });
});
