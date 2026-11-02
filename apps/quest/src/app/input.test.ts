import { ArrayCamera, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { InputSampler } from './input';
import type { Handedness } from './hud-contract';

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
  const sample = (elapsed = 16) => sampler.sample(time += elapsed, camera, frame, refSpace);
  const select = (type: 'selectstart' | 'selectend') => session.dispatchEvent(Object.assign(new Event(type), { inputSource: source, frame: { session } }));
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
    expect(f.sample().hands.right).toMatchObject({ pinching: true, justPinched: false });
    f.select('selectend');
    expect(f.sample().hands.right).toMatchObject({ pinching: false, justReleased: true });
    f.select('selectstart');
    expect(f.sample().hands.right).toMatchObject({ pinching: true, justPinched: true });
  });

  it('drops missing joint poses immediately and releases the pinch after the joint-loss grace', () => {
    const f = xrFixture(true);
    f.setJoint('thumb-tip', new Vector3(0.2, 1.2, -0.3));
    f.setJoint('index-finger-tip', new Vector3(0.21, 1.2, -0.3));
    f.sample();
    expect(f.sample().hands.right?.pinching).toBe(true);
    f.setJoint('index-finger-tip', null);
    const missing = f.sample().hands.right!;
    expect(missing.joints['index-finger-tip']).toBeUndefined();
    expect(missing).toMatchObject({ pinching: true, justReleased: false });
    expect(f.sample(134).hands.right).toMatchObject({ pinching: true, justReleased: false });
    expect(f.sample(1).hands.right).toMatchObject({ pinching: false, justReleased: true });
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

function source(handedness: Handedness = 'right', withHand = true): XRInputSource {
  const joints = new Map<XRHandJoint, XRJointSpace>();
  for (const jointName of ['wrist', 'thumb-tip', 'index-finger-tip'] as const) {
    joints.set(jointName, { jointName } as XRJointSpace);
  }
  return {
    handedness,
    hand: withHand ? joints as unknown as XRHand : undefined,
    targetRaySpace: {} as XRSpace,
    targetRayMode: 'tracked-pointer',
    profiles: withHand ? ['oculus-hand', 'generic-hand', 'generic-hand-select', 'generic-trigger'] : ['generic-trigger'],
  } as XRInputSource;
}

function sessionWith(...sources: XRInputSource[]) {
  const session = Object.assign(new EventTarget(), { inputSources: sources }) as unknown as XRSession;
  const add = vi.spyOn(session, 'addEventListener');
  const remove = vi.spyOn(session, 'removeEventListener');
  return {
    session, sources, add, remove,
    select(type: 'selectstart' | 'selectend', inputSource = sources[0]!) {
      session.dispatchEvent(Object.assign(new Event(type), { inputSource, frame: { session } }));
    },
    end() { session.dispatchEvent(Object.assign(new Event('end'), { session })); },
    removeSource(inputSource = sources[0]!) {
      sources.splice(sources.indexOf(inputSource), 1);
      session.dispatchEvent(Object.assign(new Event('inputsourceschange'), { session, added: [], removed: [inputSource] }));
    },
  };
}

function pose(x: number, y: number, z: number, orientation = new Quaternion()): XRJointPose {
  return { transform: { position: { x, y, z }, orientation }, radius: 0.008 } as unknown as XRJointPose;
}

function fixture(handedness: Handedness = 'right', withHand = true) {
  const src = source(handedness, withHand);
  const session = sessionWith(src);
  const sampler = new InputSampler();
  const camera = new PerspectiveCamera();
  const ref = {} as XRReferenceSpace;
  const state = {
    distance: 0.05,
    joints: true,
    ray: true,
    active: false,
    wrist: new Quaternion(),
  };
  const assertFrame = (space: XRReferenceSpace) => {
    expect(state.active).toBe(true);
    expect(space).toBe(ref);
  };
  const getViewerPose = vi.fn((space: XRReferenceSpace) => {
    assertFrame(space);
    return pose(0, 1.6, 0);
  });
  const getPose = vi.fn((_space: XRSpace, reference: XRReferenceSpace) => {
    assertFrame(reference);
    return state.ray ? pose(0.1, 1.2, -0.2) : null;
  });
  const getJointPose = vi.fn((joint: XRJointSpace, reference: XRReferenceSpace) => {
    assertFrame(reference);
    if (!state.joints) return null;
    if (joint.jointName === 'wrist') return pose(0, 1, -0.4, state.wrist);
    return pose(joint.jointName === 'index-finger-tip' ? state.distance : 0, 1, -0.5);
  });
  const frame = { session: session.session, getViewerPose, getPose, getJointPose } as unknown as XRFrame;
  const sample = (time: number) => {
    state.active = true;
    try { return sampler.sample(time, camera, frame, ref).hands[handedness]; }
    finally { state.active = false; }
  };
  return { src, session, sampler, camera, ref, state, frame, sample, getViewerPose, getPose, getJointPose };
}

describe('InputSampler hand joints', () => {
  it('samples joints in the supplied active frame/reference space and applies distance hysteresis', () => {
    const f = fixture();
    expect(f.sample(0)?.pinching).toBe(false);
    f.state.distance = 0.019;
    expect(f.sample(10)?.pinching).toBe(false);
    expect(f.sample(20)).toMatchObject({ pinching: true, justPinched: true });
    f.state.distance = 0.03;
    expect(f.sample(30)).toMatchObject({ pinching: true, justPinched: false });
    f.state.distance = 0.035;
    expect(f.sample(40)?.pinching).toBe(true);
    expect(f.sample(50)?.pinching).toBe(true);
    f.state.distance = 0.036;
    expect(f.sample(60)?.pinching).toBe(true);
    expect(f.sample(70)).toMatchObject({ pinching: false, justReleased: true });
    f.state.distance = 0.03;
    expect(f.sample(80)).toMatchObject({ pinching: false, justReleased: false });
    expect(f.getViewerPose).toHaveBeenCalledTimes(9);
    expect(f.getJointPose).toHaveBeenCalledTimes(27);
    expect(f.sampler.diagnostics.right).toEqual({
      tracked: true, jointCount: 3, pinchDistanceCm: 3, selectEvents: 0, selectDown: false,
    });
    expect(f.sample(90)?.pinchPoint).toEqual(new Vector3(0.015, 1, -0.5));
  });

  it('requires consecutive close samples and does not start exactly at 2 cm', () => {
    const f = fixture();
    f.state.distance = 0.02;
    expect(f.sample(0)?.pinching).toBe(false);
    expect(f.sample(10)?.pinching).toBe(false);
    f.state.distance = 0.01;
    expect(f.sample(20)?.pinching).toBe(false);
    f.state.joints = false;
    expect(f.sample(30)?.pinching).toBe(false);
    f.state.joints = true;
    expect(f.sample(40)?.pinching).toBe(false);
    expect(f.sample(50)?.pinching).toBe(true);
  });

  it('holds a distance pinch across brief tracking loss, then releases instead of sticking', () => {
    const f = fixture();
    f.state.distance = 0.01;
    f.sample(0);
    f.sample(10);
    f.state.joints = false;
    expect(f.sample(100)).toMatchObject({ pinching: true, justReleased: false });
    expect(f.sample(110)?.pinchPoint).toEqual(new Vector3(0.005, 1, -0.5));
    expect(f.sampler.diagnostics.right).toMatchObject({ tracked: false, jointCount: 0, pinchDistanceCm: null });
    expect(f.sample(161)).toMatchObject({ pinching: false, justReleased: true });
    f.state.joints = true;
    expect(f.sample(170)?.pinching).toBe(false);
    expect(f.sample(180)).toMatchObject({ pinching: true, justPinched: true });
  });

  it('returns no hand when neither ray nor joints are located', () => {
    const f = fixture();
    f.state.ray = false;
    f.state.joints = false;
    expect(f.sample(0)).toBeUndefined();
    expect(f.sampler.diagnostics.right.tracked).toBe(false);
  });

  it('does not invent a world-origin ray when only joints are located', () => {
    const f = fixture();
    f.state.ray = false;
    const hand = f.sample(0)!;
    expect(hand.ray.dir.lengthSq()).toBe(0);
    expect(hand.pinchPoint).toEqual(new Vector3(0.025, 1, -0.5));
    expect(f.sampler.diagnostics.right.tracked).toBe(true);
  });

  it('uses controller select without requiring hand joints', () => {
    const f = fixture('right', false);
    f.sample(0);
    f.session.select('selectstart');
    expect(f.sample(10)).toMatchObject({ controller: true, pinching: true, justPinched: true });
    f.session.select('selectend');
    expect(f.sample(20)).toMatchObject({ pinching: false, justReleased: true });
    expect(f.getJointPose).not.toHaveBeenCalled();
  });
});

describe('InputSampler system pinch', () => {
  it('starts, holds and releases from native select when every joint pose is null', () => {
    const f = fixture();
    f.state.joints = false;
    f.sample(0);
    f.session.select('selectstart');
    expect(f.sample(10)).toMatchObject({ pinching: true, justPinched: true });
    expect(f.sample(500)).toMatchObject({ pinching: true, justPinched: false });
    expect(f.sampler.diagnostics.right).toEqual({
      tracked: false, jointCount: 0, pinchDistanceCm: null, selectEvents: 1, selectDown: true,
    });
    f.session.select('selectend');
    expect(f.sample(510)).toMatchObject({ pinching: false, justReleased: true });
    expect(f.sampler.diagnostics.right).toMatchObject({ selectEvents: 2, selectDown: false });
  });

  it('keeps joint hysteresis independent from system select', () => {
    const f = fixture();
    f.state.distance = 0.03;
    f.sample(0);
    f.session.select('selectstart');
    expect(f.sample(10)?.pinching).toBe(true);
    f.session.select('selectend');
    // The distance never crossed the on threshold; select must not seed geometric hysteresis.
    expect(f.sample(20)).toMatchObject({ pinching: false, justReleased: true });
    f.state.distance = 0.01;
    f.sample(30);
    expect(f.sample(40)?.pinching).toBe(true);
    f.session.select('selectstart');
    f.sample(50);
    f.session.select('selectend');
    expect(f.sample(60)).toMatchObject({ pinching: true, justReleased: false });
  });

  it('latches a native pinch completed between two frames', () => {
    const f = fixture();
    f.state.joints = false;
    f.sample(0);
    f.session.select('selectstart');
    f.session.select('selectend');
    expect(f.sample(10)).toMatchObject({ pinching: true, justPinched: true });
    expect(f.sample(20)).toMatchObject({ pinching: false, justReleased: true });
    expect(f.sample(30)).toMatchObject({ pinching: false, justReleased: false });
  });

  it('freezes the last measured pinch point during native select tracking loss and resumes on recovery', () => {
    const f = fixture();
    f.state.distance = 0.01;
    f.sample(0);
    f.session.select('selectstart');
    const point = f.sample(10)!.pinchPoint.clone();
    f.state.joints = false;
    expect(f.sample(500)?.pinchPoint).toEqual(point);
    f.state.joints = true;
    f.state.distance = 0.02;
    expect(f.sample(510)?.pinchPoint).toEqual(new Vector3(0.01, 1, -0.5));
  });

  it('does not repeat a held select when its pose recovers after total tracking loss', () => {
    const f = fixture();
    f.state.joints = false;
    f.sample(0);
    f.session.select('selectstart');
    expect(f.sample(10)).toMatchObject({ pinching: true, justPinched: true });
    f.state.ray = false;
    expect(f.sample(20)).toBeUndefined();
    f.state.ray = true;
    expect(f.sample(30)).toMatchObject({ pinching: true, justPinched: false });
    expect(f.sample(40)).toMatchObject({ pinching: true, justPinched: false });
    f.session.select('selectend');
    expect(f.sample(50)).toMatchObject({ pinching: false, justReleased: true });
    f.session.select('selectstart');
    expect(f.sample(60)).toMatchObject({ pinching: true, justPinched: true });
  });

  it('does not reuse an old midpoint for a new native select after tracking loss', () => {
    const f = fixture();
    f.sample(0);
    f.state.joints = false;
    f.session.select('selectstart');
    expect(f.sample(500)?.pinchPoint).toEqual(new Vector3(0.1, 1.2, -0.2));
    expect(f.sample(510)?.pinchPoint).toEqual(new Vector3(0.1, 1.2, -0.2));
  });

  it('isolates left/right select events and ignores unhanded sources', () => {
    const f = fixture('left');
    const right = source('right');
    const none = { ...source(), handedness: 'none' } as XRInputSource;
    f.session.sources.push(right, none);
    f.sample(0);
    f.session.select('selectstart', right);
    f.session.select('selectstart', none);
    expect(f.sample(10)?.pinching).toBe(false);
    expect(f.sampler.diagnostics.left.selectEvents).toBe(0);
    expect(f.sampler.diagnostics.right).toMatchObject({ selectDown: true, selectEvents: 1 });
  });
});

describe('InputSampler session lifetime', () => {
  it('automatically binds the live frame session and does not rebind/reset the same session', () => {
    const f = fixture();
    f.sample(0);
    expect(f.session.add.mock.calls.map(([type]) => type)).toEqual(['selectstart', 'selectend', 'end', 'inputsourceschange']);
    f.session.select('selectstart');
    f.sampler.attach(f.session.session);
    expect(f.sample(10)?.pinching).toBe(true);
    expect(f.session.add).toHaveBeenCalledTimes(4);
    expect(f.session.remove).not.toHaveBeenCalled();
  });

  it('rebinds on session re-entry, clears old state and ignores old-session events', () => {
    const f = fixture();
    f.sample(0);
    f.session.select('selectstart');
    expect(f.sample(10)?.pinching).toBe(true);
    const next = fixture();
    f.sampler.attach(next.session.session);
    expect(f.session.remove).toHaveBeenCalledTimes(4);
    expect(next.session.add).toHaveBeenCalledTimes(4);
    expect(f.sampler.diagnostics.right.selectEvents).toBe(0);
    f.session.select('selectstart');
    expect(f.sampler.diagnostics.right.selectEvents).toBe(0);
    next.session.session.dispatchEvent(Object.assign(new Event('selectstart'), {
      inputSource: next.src, frame: { session: f.session.session },
    }));
    expect(f.sampler.diagnostics.right.selectEvents).toBe(0);
    next.session.select('selectstart');
    next.state.active = true;
    const hand = f.sampler.sample(20, next.camera, next.frame, next.ref).hands.right;
    next.state.active = false;
    expect(hand).toMatchObject({ pinching: true, justPinched: true });
    expect(f.sampler.diagnostics.right.selectEvents).toBe(1);
  });

  it('switches to a new frame session even without an explicit attach call', () => {
    const f = fixture();
    f.sample(0);
    const next = fixture();
    next.state.active = true;
    f.sampler.sample(10, next.camera, next.frame, next.ref);
    next.state.active = false;
    expect(f.session.remove).toHaveBeenCalledTimes(4);
    expect(next.session.add).toHaveBeenCalledTimes(4);
  });

  it('clears palm dwell, native select, diagnostics and desktop presses at session end', () => {
    const f = fixture();
    f.state.wrist.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI);
    f.sample(0);
    f.session.select('selectstart');
    f.sample(500);
    f.sampler.pointer.down = true;
    f.sampler.pointer.latched = true;
    f.session.end();
    expect(f.session.remove).toHaveBeenCalledTimes(4);
    expect(f.sampler.diagnostics.right).toEqual({
      tracked: false, jointCount: 0, pinchDistanceCm: null, selectEvents: 0, selectDown: false,
    });
    expect(f.sampler.pointer).toMatchObject({ down: false, latched: false });
    f.sampler.attach(f.session.session);
    expect(f.sample(1000)).toMatchObject({ pinching: false, palmUp: true, palmUpMs: 0 });
  });

  it('clears removed sources immediately, including missing selectend', () => {
    const f = fixture();
    f.sample(0);
    f.session.select('selectstart');
    expect(f.sample(10)?.pinching).toBe(true);
    f.session.removeSource();
    expect(f.sampler.diagnostics.right).toMatchObject({ tracked: false, jointCount: 0, selectDown: false });
    expect(f.sample(20)).toBeUndefined();
    f.session.sources.push(source());
    expect(f.sample(30)?.pinching).toBe(false);
    f.session.select('selectstart', f.src);
    expect(f.sample(40)?.pinching).toBe(false);
  });

  it('clears vanished or replaced sources even if inputsourceschange was missed', () => {
    const f = fixture();
    f.state.distance = 0.01;
    f.sample(0);
    expect(f.sample(10)?.pinching).toBe(true);
    f.session.sources.splice(0);
    expect(f.sample(20)).toBeUndefined();
    f.session.sources.push(source());
    expect(f.sample(30)?.pinching).toBe(false);
    expect(f.sample(40)?.pinching).toBe(true);
    f.session.sources[0] = source();
    expect(f.sample(50)?.pinching).toBe(false);
  });
});

describe('InputSampler palm orientation', () => {
  it.each(['left', 'right'] as const)('uses the wrist -Y axis for %s palm-up and starts dwell at timestamp zero', (hand) => {
    const f = fixture(hand);
    f.state.wrist.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI);
    expect(f.sample(0)).toMatchObject({ palmUp: true, palmUpMs: 0 });
    expect(f.sample(500)).toMatchObject({ palmUp: true, palmUpMs: 500 });
    f.state.wrist.identity();
    expect(f.sample(600)).toMatchObject({ palmUp: false, palmUpMs: 0 });
    f.state.wrist.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI);
    expect(f.sample(700)).toMatchObject({ palmUp: true, palmUpMs: 0 });
    f.state.joints = false;
    expect(f.sample(800)).toMatchObject({ palmUp: false, palmUpMs: 0 });
    f.state.joints = true;
    expect(f.sample(900)).toMatchObject({ palmUp: true, palmUpMs: 0 });
  });

  it('rejects a sideways palm even with fingers pointing upward', () => {
    const f = fixture();
    f.state.wrist.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
    expect(f.sample(0)).toMatchObject({ palmUp: false, palmUpMs: 0 });
  });
});
