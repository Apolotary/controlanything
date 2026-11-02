import { PerspectiveCamera, Quaternion, Scene, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { FrameCapture } from '../scan/capture';
import { PoseRing } from '../scan/poses';
import { Scanner } from '../scan/scanner';
import { TargetStore } from '../scan/targets';
import type { WsClient } from '../io/ws';
import { QuestApp } from './app';
import type { Hud, ShellFrame } from './hud-contract';
import { InputSampler } from './input';

async function setup() {
  // Use the real HUD wiring and render-frame ordering, without opening media, WebGL, or a socket.
  const app = Object.create(QuestApp.prototype) as {
    setupHud(): Promise<void>;
    frameInner(time: number, frame: XRFrame): void;
    hud: Hud;
    lastFrame: ShellFrame;
    consumed: { left: boolean; right: boolean };
  };
  const camera = new PerspectiveCamera();
  camera.position.set(0, 1.4, 0);
  camera.updateMatrixWorld();
  const input = new InputSampler(), targets = new TargetStore(), poses = new PoseRing();
  const index = new Vector3(0.1, 1.1, -0.15), thumb = index.clone().add(new Vector3(0.06, 0, 0));
  const rayOrigin = new Vector3(0.1, 1.2, -0.1), rayRotation = new Quaternion();
  const jointSpaces = new Map<XRHandJoint, XRJointSpace>([
    ['index-finger-tip', {} as XRJointSpace], ['thumb-tip', {} as XRJointSpace],
  ]);
  const source = { handedness: 'right', hand: jointSpaces, targetRaySpace: {}, profiles: ['oculus-hand'] } as unknown as XRInputSource;
  const session = Object.assign(new EventTarget(), { inputSources: [source] }) as unknown as XRSession;
  const refSpace = {} as XRReferenceSpace;
  let jointsVisible = true;
  const pose = (position: Vector3, orientation = new Quaternion()) => ({ transform: { position, orientation }, radius: 0.008 });
  const xrFrame = {
    session,
    getViewerPose: () => pose(camera.position, camera.quaternion),
    getPose: (space: XRSpace) => space === source.targetRaySpace ? pose(rayOrigin, rayRotation) : null,
    getJointPose: (space: XRJointSpace) => jointsVisible ? pose(space === jointSpaces.get('index-finger-tip') ? index : thumb) : null,
  } as unknown as XRFrame;
  const recorder = { input: vi.fn(), pose: vi.fn() };
  const lock = vi.fn();
  Object.assign(app, {
    params: new URLSearchParams('hud=v2'), scene: new Scene(), desktopCam: camera,
    renderer: {
      xr: { getSession: () => session, getReferenceSpace: () => refSpace, getCamera: () => camera },
      info: { render: { calls: 0 } }, render: vi.fn(),
    },
    page: { log: vi.fn() }, camera: {}, cameraState: 'on', input, targets, poses, recorder,
    handFeedback: { setAppearance: vi.fn(), setHover: vi.fn(), update: vi.fn() },
    xrHit: { attach: vi.fn(), detach: vi.fn(), onFrame: vi.fn() },
    handheld: { update: () => [] }, wristPoses: {}, heldMoves: [],
    nonDominant: 'left', candidate: { id: null, since: 0, shown: null },
    consumed: { left: false, right: false }, lockedId: null, lock,
    aimTargets: new Map(), aimBuffer: [],
    gazeHit: { id: '', angleDeg: 0, distance: 0 },
    handHit: { id: '', angleDeg: 0, distance: 0 },
    touchHit: { id: '', angleDeg: 0, distance: 0 },
    lastStatusAt: 0, updateStatus: vi.fn(),
  });
  await app.setupHud();
  const scanner = new Scanner({
    capture: () => ({ busy: true }) as FrameCapture,
    ws: {} as WsClient, hud: () => app.hud, targets, poses, depth: () => [], log: vi.fn(),
  });
  Object.assign(app, { scanner });
  const states: boolean[] = [];
  scanner.on('state', ({ on }) => states.push(on));
  let time = 0;
  const step = (elapsed = 16) => app.frameInner(time += elapsed, xrFrame);
  step(200);
  const button = () => app.hud.root.getObjectByName('scan-toggle')!;
  const point = button().getWorldPosition(new Vector3());
  rayRotation.setFromUnitVectors(new Vector3(0, 0, -1), point.clone().sub(rayOrigin).normalize());
  const behind = targets.upsert(
    { detId: 'behind-scan', label: 'Laptop', score: 1, box: [0, 0, 100, 100] },
    { position: point.clone().sub(rayOrigin).multiplyScalar(3).add(rayOrigin), facing: new Vector3(0, 0, 1), confirmed: true, method: 'fixture', depth: 2, sizeM: [0.2, 0.2, 0.1] },
    'scan-frame',
  ).target;
  behind.status = 'verified';
  return {
    app, scanner, states, step, button, index, thumb, lock, recorder,
    setJointsVisible: (on: boolean) => { jointsVisible = on; },
    select: (type: 'selectstart' | 'selectend') => session.dispatchEvent(Object.assign(new Event(type), { inputSource: source, frame: xrFrame })),
    pointTip: (z: number) => {
      button().localToWorld(index.set(0, 0, z));
      thumb.copy(index).add(new Vector3(0.08, 0, 0));
      rayRotation.setFromUnitVectors(new Vector3(0, 0, -1), new Vector3(1, 0, 0));
    },
    dispose: () => { app.hud.dispose(); input.detach(); },
  };
}

describe('HUD v2 Scan through the Quest frame loop', () => {
  it.each(['system select', 'joint pinch'] as const)('starts and stops scanning once per %s using the hand target ray', async (kind) => {
    const f = await setup();
    try {
      if (kind === 'system select') f.setJointsVisible(false);
      f.step();
      const pinch = (down: boolean) => {
        if (kind === 'system select') f.select(down ? 'selectstart' : 'selectend');
        else f.thumb.copy(f.index).add(new Vector3(down ? 0.01 : 0.06, 0, 0));
        f.step();
        f.step();
      };
      pinch(true);
      expect(f.app.lastFrame.hands.right?.controller).toBe(false);
      expect(f.scanner.active).toBe(true);
      expect(f.states).toEqual([true]);
      expect(f.lock).not.toHaveBeenCalled();
      if (kind === 'joint pinch') {
        f.select('selectstart'); f.step();
        f.select('selectend'); f.step();
      }
      for (let i = 0; i < 6; i++) f.step();
      expect(f.states).toEqual([true]);
      expect(f.button()).toBeTruthy();
      expect(f.app.hud.root.getObjectByName('device-card')!.visible).toBe(true);
      pinch(false);
      expect(f.scanner.active).toBe(true);
      pinch(true);
      expect(f.scanner.active).toBe(false);
      expect(f.states).toEqual([true, false]);
      expect(f.lock).not.toHaveBeenCalled();
      const presses = f.recorder.input.mock.calls.filter(([kind, event]) => kind === 'deck' && event.phase === 'press');
      expect(presses).toEqual([['deck', { key: 'scan', phase: 'press' }], ['deck', { key: 'scan', phase: 'press' }]]);
    } finally { f.dispose(); }
  });

  it('starts and stops scanning by crossing the button plane with an open index finger', async () => {
    const f = await setup();
    try {
      f.pointTip(0.03); f.step();
      expect(f.scanner.active).toBe(false);
      f.pointTip(-0.005); f.step();
      expect(f.app.lastFrame.hands.right?.pinching).toBe(false);
      expect(f.scanner.active).toBe(true);
      expect(f.app.consumed.right).toBe(true);
      for (let i = 0; i < 6; i++) f.step();
      expect(f.states).toEqual([true]);
      f.pointTip(0.03); f.step();
      expect(f.scanner.active).toBe(true);
      f.pointTip(-0.005); f.step();
      expect(f.scanner.active).toBe(false);
      expect(f.states).toEqual([true, false]);
      expect(f.lock).not.toHaveBeenCalled();
    } finally { f.dispose(); }
  });
});
