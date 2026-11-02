import { describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { QuestApp } from './app';
import type { ShellFrame, ShellHand } from './hud-contract';
import { InputSampler } from './input';

function hand(overrides: Partial<ShellHand> = {}): ShellHand {
  return {
    joints: {}, pinching: false, justPinched: false, justReleased: false,
    pinchPoint: new Vector3(), ray: { origin: new Vector3(), dir: new Vector3(0, 0, -1) },
    palmUp: false, palmUpMs: 0, controller: false, ...overrides,
  };
}

function frame(right?: ShellHand): ShellFrame {
  return {
    time: 0, dt: 1 / 72,
    head: { position: new Vector3(), quaternion: new Quaternion(), ray: { origin: new Vector3(), dir: new Vector3(0, 0, -1) } },
    hands: right ? { right } : {},
  };
}

function target(id: string, position: Vector3) {
  return { id, position, sizeM: [0.1, 0.1, 0.1], facing: new Vector3(0, 0, 1) };
}

function appHarness(targets: ReturnType<typeof target>[] = []) {
  // Exercise shell methods without booting a page, camera, microphone, renderer, or connection.
  const app = Object.create(QuestApp.prototype) as {
    interact(f: ShellFrame, time: number): void;
    frameInner(time: number, xrFrame?: XRFrame): void;
    refSpace?: XRReferenceSpace;
  };
  const input = new InputSampler();
  const setHover = vi.fn();
  const refine = vi.fn();
  const lock = vi.fn();
  const xrHit = { attach: vi.fn(), detach: vi.fn(), onFrame: vi.fn() };
  Object.assign(app, {
    input, handFeedback: { setHover, update: vi.fn() },
    targets: { list: () => targets, get: (id: string) => targets.find((t) => t.id === id), refine },
    candidate: { id: null, since: 0, shown: null }, consumed: { left: false, right: false },
    hud: { setCandidate: vi.fn(), upsertTarget: vi.fn(), update: vi.fn() },
    lock, release: vi.fn(), lockedId: null,
    desktopCam: new PerspectiveCamera(), camera: {}, xrHit,
    poses: { push: vi.fn() }, recorder: { pose: vi.fn() },
    handheld: { update: () => [] }, scanner: { tick: vi.fn() }, lastStatusAt: 0,
  });
  return { app, input, setHover, refine, lock, xrHit };
}

function xrSession(sources: XRInputSource[] = []): XRSession {
  return Object.assign(new EventTarget(), { inputSources: sources }) as unknown as XRSession;
}

describe('shell hand input integration', () => {
  it('highlights and selects the same hand-ray target even when gaze points at another target', () => {
    const gazeTarget = target('gaze', new Vector3(0, 0, -2));
    const pointedTarget = target('pointed', new Vector3(1, 0, -2));
    const { app, setHover, lock } = appHarness([gazeTarget, pointedTarget]);
    const right = hand({ ray: { origin: new Vector3(), dir: pointedTarget.position.clone().normalize() } });
    const f = frame(right);
    app.interact(f, 0);
    app.interact(f, 300);
    expect(setHover).toHaveBeenLastCalledWith('right', pointedTarget);
    expect(lock).not.toHaveBeenCalled();

    right.justPinched = right.pinching = true;
    app.interact(f, 320);

    expect(setHover).toHaveBeenLastCalledWith('right', pointedTarget);
    expect(lock).toHaveBeenCalledExactlyOnceWith('pointed', 'ray');
  });

  it('uses system select with null joints to pick along the ray without refining at its origin', () => {
    const originTarget = target('near-origin', new Vector3(0, 0, -0.01));
    const pointedTarget = target('pointed', new Vector3(0, 0, -2));
    const { app, input, refine, lock, setHover } = appHarness([originTarget, pointedTarget]);
    const source = { handedness: 'right', targetRaySpace: {}, hand: new Map() } as unknown as XRInputSource;
    const session = xrSession([source]);
    const transform = { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } };
    const xrFrame = { session, getViewerPose: () => ({ transform }), getPose: () => ({ transform }), getJointPose: () => null } as unknown as XRFrame;
    input.attach(session);
    session.dispatchEvent(Object.assign(new Event('selectstart'), { inputSource: source, frame: xrFrame }));
    const f = input.sample(16, new PerspectiveCamera(), xrFrame, {} as XRReferenceSpace);
    expect(f.hands.right).toMatchObject({ justPinched: true, joints: {} });

    app.interact(f, 16);

    expect(refine).not.toHaveBeenCalled();
    expect(lock).toHaveBeenCalledExactlyOnceWith('pointed', 'ray');
    expect(setHover).toHaveBeenLastCalledWith('right', pointedTarget);
  });

  it('still refines a real thumb-index midpoint touching a nearby target', () => {
    const near = target('near', new Vector3(0, 0, -0.2));
    const { app, refine, lock } = appHarness([near]);
    const joint = (x: number) => ({ position: new Vector3(x, 0, -0.2), quaternion: new Quaternion(), radius: 0.008 });
    const right = hand({
      joints: { 'thumb-tip': joint(-0.005), 'index-finger-tip': joint(0.005) },
      pinchPoint: near.position.clone(), pinching: true, justPinched: true,
    });

    app.interact(frame(right), 16);

    expect(refine).toHaveBeenCalledExactlyOnceWith('near', right.pinchPoint);
    expect(lock).toHaveBeenCalledExactlyOnceWith('near', 'touch');
  });

  it('samples the live frame synchronously using the renderer current space instead of the startup space', () => {
    const { app, input, xrHit } = appHarness();
    const session = xrSession();
    const current = {} as XRReferenceSpace;
    const old = {} as XRReferenceSpace;
    const xrCamera = new PerspectiveCamera();
    let active = false;
    const getViewerPose = vi.fn((space: XRReferenceSpace) => {
      expect(active).toBe(true);
      expect(space).toBe(current);
      return null;
    });
    const xrFrame = { session, getViewerPose } as unknown as XRFrame;
    const sample = vi.spyOn(input, 'sample');
    Object.assign(app, {
      refSpace: old,
      renderer: {
        xr: { getSession: () => session, getReferenceSpace: () => current, getCamera: () => xrCamera },
        info: { render: { calls: 12 } }, render: vi.fn(),
      },
    });

    active = true;
    app.frameInner(16, xrFrame);
    active = false;

    expect(sample).toHaveBeenCalledExactlyOnceWith(16, xrCamera, xrFrame, current);
    expect(getViewerPose).toHaveBeenCalledOnce();
    expect(app.refSpace).toBe(current);
    expect(xrHit.detach).toHaveBeenCalledOnce();
    expect(xrHit.attach).toHaveBeenCalledExactlyOnceWith(session, current);
    expect(xrHit.onFrame).toHaveBeenCalledExactlyOnceWith(xrFrame);
  });

  it('does not sample a frame from the previous renderer session', () => {
    const { app, input } = appHarness();
    const sample = vi.spyOn(input, 'sample');
    const current = xrSession();
    Object.assign(app, { renderer: { xr: { getSession: () => current, getReferenceSpace: () => ({}) } } });

    app.frameInner(16, { session: xrSession() } as XRFrame);

    expect(sample).not.toHaveBeenCalled();
  });
});
