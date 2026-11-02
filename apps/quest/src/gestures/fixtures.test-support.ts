import { Quaternion, Vector3 } from 'three';
import type { ShellFrame, ShellHand } from '../app/hud-contract';
import type { HandPosture } from './posture';

/** Deterministic anatomical proportions; fixtures are never imported by the application. */
export function makeGestureHand(posture: HandPosture = 'open_palm', scale = 1): ShellHand {
  const hand: ShellHand = {
    joints: {}, pinchPoint: new Vector3(), pinching: false, justPinched: false, justReleased: false,
    ray: { origin: new Vector3(), dir: new Vector3(0, 0, -1) }, palmUp: false, palmUpMs: 0, controller: false,
  };
  setPosture(hand, posture, scale);
  return hand;
}

export function setPosture(hand: ShellHand, posture: HandPosture, scale = 1): void {
  const origin = hand.joints.wrist?.position.clone() ?? new Vector3();
  const orientation = hand.joints.wrist?.quaternion.clone() ?? new Quaternion();
  hand.joints = {};
  const add = (name: XRHandJoint, x: number, z: number) => {
    hand.joints[name] = { position: new Vector3(x * scale, 0, z * scale).add(origin), quaternion: orientation.clone(), radius: 0.008 * scale };
  };
  add('wrist', 0, 0);
  add('middle-finger-metacarpal', 0, -0.07);
  add('middle-finger-phalanx-proximal', 0, -0.07);
  const open = posture === 'open_palm' || posture === 'pinch';
  add('index-finger-tip', 0, posture === 'point' || posture === 'open_palm' ? -0.14 : -0.07);
  add('middle-finger-tip', 0.01, open ? -0.145 : -0.07);
  add('ring-finger-tip', 0.02, open ? -0.14 : -0.065);
  add('pinky-finger-tip', 0.025, open ? -0.13 : -0.06);
  add('thumb-tip', posture === 'pinch' ? 0.01 : open ? -0.09 : -0.03, posture === 'pinch' ? -0.07 : open ? -0.07 : -0.05);
  if (posture === 'unknown') delete hand.joints['pinky-finger-tip'];
}

/** Set wrist position, translating every finger by the same amount. */
export function moveHand(hand: ShellHand, x: number, y: number, z: number): void {
  const wrist = hand.joints.wrist?.position ?? hand.grip?.position ?? hand.ray.origin;
  const delta = new Vector3(x, y, z).sub(wrist);
  for (const joint of Object.values(hand.joints)) joint?.position.add(delta);
  hand.ray.origin.add(delta);
  hand.pinchPoint.add(delta);
  hand.grip?.position.add(delta);
}

export function makeGestureFrame(left: HandPosture = 'fist', right: HandPosture = 'open_palm'): ShellFrame {
  const lh = makeGestureHand(left), rh = makeGestureHand(right);
  moveHand(lh, -0.2, 1.3, -0.4);
  moveHand(rh, 0.2, 1.3, -0.4);
  return {
    time: 0, dt: 1 / 90,
    head: { position: new Vector3(0, 1.6, 0), quaternion: new Quaternion(), ray: { origin: new Vector3(0, 1.6, 0), dir: new Vector3(0, 0, -1) } },
    hands: { left: lh, right: rh },
  };
}
