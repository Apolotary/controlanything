import { describe, expect, it } from 'vitest';
import { Group, Quaternion, Vector3 } from 'three';
import type { HandState, HudFrame } from '../contract';
import { HandDockAnchor } from './hand-dock';

function hand(x = -0.2, palmUp = true, palmUpMs = 300): HandState {
  return {
    joints: {
      wrist: { position: new Vector3(x, 1.1, -0.4), quaternion: new Quaternion(), radius: 0.01 },
      'middle-finger-phalanx-proximal': { position: new Vector3(x, 1.1, -0.48), quaternion: new Quaternion(), radius: 0.008 },
    },
    palmUp, palmUpMs, controller: false,
    pinching: false, justPinched: false, justReleased: false, pinchPoint: new Vector3(),
    ray: { origin: new Vector3(), dir: new Vector3(0, 0, -1) },
  };
}

function setup(nonDominant: 'left' | 'right' = 'left') {
  const anchor = new HandDockAnchor(nonDominant), dock = new Group(), wrist = new Group();
  const frame: HudFrame = {
    time: 0, dt: 0.016,
    head: { position: new Vector3(0, 1.6, 0), quaternion: new Quaternion() },
    hands: {},
  };
  const update = (time: number) => { frame.time = time; anchor.update(frame, dock, wrist, 0.192); };
  return { anchor, dock, wrist, frame, update };
}

describe('HandDockAnchor', () => {
  it.each(['left', 'right'] as const)('attaches to the %s non-dominant hand after its palm dwell', (side) => {
    const { anchor, dock, wrist, frame, update } = setup(side);
    const menuHand = hand(side === 'left' ? -0.2 : 0.2, true, 299);
    frame.hands = { left: hand(-0.2), right: hand(0.2), [side]: menuHand };
    update(299);
    expect(anchor.tracked).toBe(true);
    expect(anchor.open).toBe(false);
    expect(wrist.visible).toBe(true);
    expect(anchor.wristOpacity).toBe(0.6);
    menuHand.palmUpMs = 300;
    update(300);
    expect(anchor.open).toBe(true);
    expect(anchor.justOpened).toBe(true);
    expect(anchor.opacity).toBe(0);
    const knuckle = menuHand.joints['middle-finger-phalanx-proximal']!.position;
    expect(dock.position.distanceTo(knuckle)).toBeCloseTo(0.06);
    expect(Math.sign(dock.position.x)).toBe(side === 'left' ? -1 : 1);
    const facing = new Vector3(0, 0, 1).applyQuaternion(dock.quaternion);
    expect(facing.dot(frame.head.position.clone().sub(dock.position).normalize())).toBeCloseTo(1);
    update(480);
    expect(anchor.opacity).toBe(1);
    expect(anchor.justOpened).toBe(false);
    expect(wrist.visible).toBe(false);
  });

  it('waits 300 ms after the palm turns away, then fades out over 180 ms', () => {
    const { anchor, wrist, frame, update } = setup();
    frame.hands.left = hand();
    update(0); update(180);
    frame.hands.left.palmUp = false;
    update(200); update(499);
    expect(anchor.open).toBe(true);
    update(500);
    expect(anchor.open).toBe(false);
    expect(anchor.opacity).toBe(1);
    update(590);
    expect(anchor.opacity).toBeGreaterThan(0);
    expect(anchor.opacity).toBeLessThan(1);
    expect(wrist.visible).toBe(true);
    update(680);
    expect(anchor.opacity).toBe(0);
    expect(anchor.wristOpacity).toBe(0.6);
  });

  it('holds an open dock near the other fingertip, including the row ends, then releases it', () => {
    const { anchor, dock, frame, update } = setup();
    frame.hands.left = hand();
    update(0); update(180);
    const other = hand(0.2);
    const tip = { position: dock.localToWorld(new Vector3(0.17, 0, 0.04)), quaternion: new Quaternion(), radius: 0.008 };
    other.joints['index-finger-tip'] = tip;
    frame.hands.right = other;
    frame.hands.left.palmUp = false;
    update(200); update(1000);
    expect(anchor.open).toBe(true);
    tip.position.copy(dock.localToWorld(new Vector3(0.25, 0, 0)));
    update(1100); update(1400); update(1580);
    expect(anchor.open).toBe(false);
    expect(anchor.opacity).toBe(0);
    tip.position.copy(dock.position);
    update(1800);
    expect(anchor.open).toBe(false);
  });

  it('does not keep itself open with the menu hand fingertip', () => {
    const { anchor, dock, frame, update } = setup();
    frame.hands.left = hand();
    update(0); update(180);
    frame.hands.left.palmUp = false;
    frame.hands.left.joints['index-finger-tip'] = { position: dock.position.clone(), quaternion: new Quaternion(), radius: 0.008 };
    update(200); update(500);
    expect(anchor.open).toBe(false);
  });

  it('smooths hand motion with an 80 ms time constant while keeping the row upright', () => {
    const { dock, frame, update } = setup();
    const menuHand = hand(); frame.hands.left = menuHand;
    update(0);
    const before = dock.position.clone();
    menuHand.joints.wrist!.position.x += 0.2;
    menuHand.joints['middle-finger-phalanx-proximal']!.position.x += 0.2;
    menuHand.joints.wrist!.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), 0.6);
    frame.dt = 0.08;
    update(80);
    const knuckle = menuHand.joints['middle-finger-phalanx-proximal']!.position;
    const destination = knuckle.clone().addScaledVector(frame.head.position.clone().sub(knuckle).normalize(), 0.06);
    expect(dock.position.distanceTo(before.clone().lerp(destination, 1 - Math.exp(-1)))).toBeLessThan(1e-8);
    expect(new Vector3(1, 0, 0).applyQuaternion(dock.quaternion).y).toBeCloseTo(0, 2);
  });

  it('hides immediately when only the dominant hand remains and requires a new palm dwell on return', () => {
    const { anchor, wrist, frame, update } = setup();
    frame.hands.left = hand(); frame.hands.right = hand(0.2);
    update(0); update(180);
    delete frame.hands.left;
    update(200);
    expect(anchor.tracked).toBe(true);
    expect(anchor.open).toBe(false);
    expect(anchor.opacity).toBe(0);
    expect(wrist.visible).toBe(false);
    frame.hands.left = hand(-0.2, true, 0);
    update(300);
    expect(anchor.open).toBe(false);
  });

  it('uses an untouched fallback for controllers or mouse, and hands take priority immediately', () => {
    const { anchor, dock, wrist, frame, update } = setup();
    dock.position.set(1, 2, 3);
    frame.hands.left = { ...hand(), controller: true };
    update(0);
    expect(anchor.tracked).toBe(false);
    expect(anchor.open).toBe(true);
    expect(anchor.opacity).toBe(1);
    expect(wrist.visible).toBe(false);
    expect(dock.position.toArray()).toEqual([1, 2, 3]);
    frame.hands.left = { ...hand(), joints: {} };
    update(20);
    expect(anchor.tracked).toBe(false);
    frame.hands.left = hand(-0.2, false, 0);
    update(40);
    expect(anchor.tracked).toBe(true);
    expect(anchor.open).toBe(false);
    expect(anchor.opacity).toBe(0);
    expect(wrist.visible).toBe(true);
  });
});
