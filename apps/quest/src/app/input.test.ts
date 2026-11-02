import { ArrayCamera, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { InputSampler } from './input';

function xrFixture(withHand = false) {
  const session = Object.assign(new EventTarget(), { inputSources: [] as XRInputSource[] });
  const joints = new Map<XRHandJoint, XRJointSpace>();
  const positions = new Map<XRJointSpace, Vector3>();
  const setJoint = (name: XRHandJoint, point: Vector3 | null) => {
    let space = joints.get(name);
    if (!space) {
      space = {} as XRJointSpace;
      joints.set(name, space);
    }
    if (point) positions.set(space, point);
    else positions.delete(space);
  };
  const source = {
    handedness: 'right', targetRaySpace: {}, ...(withHand ? { hand: joints } : {}),
  } as unknown as XRInputSource;
  session.inputSources.push(source);
  const pose = (point: Vector3) => ({ transform: { position: point, orientation: { x: 0, y: 0, z: 0, w: 1 } }, radius: 0.008 });
  const state = { rayTracked: true };
  const frame = {
    session,
    getViewerPose: () => pose(new Vector3(0, 1.6, 0)),
    getPose: () => state.rayTracked ? pose(new Vector3(0.2, 1.2, -0.3)) : null,
    getJointPose: (space: XRJointSpace) => {
      const point = positions.get(space);
      return point ? pose(point) : null;
    },
  } as unknown as XRFrame;
  const sampler = new InputSampler();
  sampler.attach(session as unknown as XRSession);
  const camera = new PerspectiveCamera(60, 1, 0.1, 10);
  camera.updateMatrixWorld();
  const refSpace = {} as XRReferenceSpace;
  let time = 0;
  const sample = () => sampler.sample(time += 16, camera, frame, refSpace);
  const select = (type: 'selectstart' | 'selectend') => session.dispatchEvent(Object.assign(new Event(type), { inputSource: source }));
  return { sampler, session, source, sample, select, setJoint, state };
}

describe('InputSampler', () => {
  it('preserves a platform select completed between render frames', () => {
    const f = xrFixture();
    f.select('selectstart');
    f.select('selectend');
    expect(f.sample().hands.right).toMatchObject({ pinching: true, justPinched: true });
    expect(f.sample().hands.right).toMatchObject({ pinching: false, justPinched: false, justReleased: true });
  });

  it('recognizes a hand pinch from tracked fingertip distance', () => {
    const f = xrFixture(true);
    f.setJoint('thumb-tip', new Vector3(0.2, 1.2, -0.3));
    f.setJoint('index-finger-tip', new Vector3(0.21, 1.2, -0.3));
    expect(f.sample().hands.right?.pinching).toBe(false);
    expect(f.sample().hands.right).toMatchObject({ pinching: true, justPinched: true, controller: false });
  });

  it('resets a removed source so its next select can start again', () => {
    const f = xrFixture();
    f.select('selectstart');
    expect(f.sample().hands.right?.justPinched).toBe(true);
    f.session.inputSources.length = 0;
    expect(f.sample().hands.right).toBeUndefined();
    f.session.inputSources.push(f.source);
    f.select('selectstart');
    expect(f.sample().hands.right?.justPinched).toBe(true);
  });

  it('does not expose an aim ray when target tracking is unavailable', () => {
    const f = xrFixture();
    f.state.rayTracked = false;
    f.select('selectstart');
    expect(f.sample().hands.right).toBeUndefined();
    f.state.rayTracked = true;
    expect(f.sample().hands.right?.pinching).toBe(false);
  });

  it('drops missing joint poses instead of reusing stale pinch positions', () => {
    const f = xrFixture(true);
    f.setJoint('thumb-tip', new Vector3(0.2, 1.2, -0.3));
    f.setJoint('index-finger-tip', new Vector3(0.21, 1.2, -0.3));
    f.sample();
    expect(f.sample().hands.right?.pinching).toBe(true);
    f.setJoint('index-finger-tip', null);
    expect(f.sample().hands.right?.joints['index-finger-tip']).toBeUndefined();
    expect(f.sample().hands.right).toMatchObject({ pinching: false, justReleased: true });
  });

  it('reuses frame, hand, ray and joint storage across render frames', () => {
    const f = xrFixture(true);
    f.setJoint('thumb-tip', new Vector3(0.2, 1.2, -0.3));
    const first = f.sample();
    const hand = first.hands.right!;
    const joint = hand.joints['thumb-tip'];
    const next = f.sample();
    expect(next).toBe(first);
    expect(next.hands.right).toBe(hand);
    expect(next.hands.right?.joints['thumb-tip']).toBe(joint);
  });

  it('keeps emulator clicks working after the pointer leaves while pressed', () => {
    const sampler = new InputSampler();
    const camera = new PerspectiveCamera(60, 1, 0.1, 10);
    camera.updateMatrixWorld();
    sampler.pointer.inside = sampler.pointer.down = true;
    expect(sampler.sample(16, camera).hands.right?.justPinched).toBe(true);
    sampler.pointer.inside = sampler.pointer.down = false;
    expect(sampler.sample(32, camera).hands.right).toBeUndefined();
    sampler.pointer.inside = sampler.pointer.latched = true;
    expect(sampler.sample(48, camera).hands.right?.justPinched).toBe(true);
    expect(sampler.sample(64, camera).hands.right?.justReleased).toBe(true);
  });

  it('uses the mono XR view projection for off-center emulator clicks', () => {
    const sampler = new InputSampler();
    const view = new PerspectiveCamera(90, 1, 0.1, 10);
    view.position.set(0.1, 1.6, 0);
    const camera = new ArrayCamera([view]);
    // WebXR updates the wrapper projection but its inverse may still be the constructor default.
    camera.projectionMatrix.copy(view.projectionMatrix);
    sampler.pointer.inside = true;
    sampler.pointer.ndc.set(1, 0);
    const hand = sampler.sample(16, camera).hands.right!;
    expect(hand.ray.origin.toArray()).toEqual([0.1, 1.6, 0]);
    expect(hand.ray.dir.x).toBeCloseTo(Math.SQRT1_2);
    expect(hand.ray.dir.z).toBeCloseTo(-Math.SQRT1_2);
  });
});
