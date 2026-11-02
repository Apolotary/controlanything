/**
 * Per-frame input sampling for the HUD and the shell: the viewer pose, hand joints with a hysteresis pinch
 * (on < 2.0 cm, off > 3.5 cm, two frames to change: research/04 §5), the palm-up deck gesture, controllers
 * (select button = pinch), and on the desktop a mouse/keyboard stand-in (click = pinch along the mouse ray).
 */
import { ArrayCamera, type Camera, Quaternion, Raycaster, Vector2, Vector3 } from 'three';
import type { Handedness, JointSample, ShellFrame, ShellHand } from './hud-contract';

const JOINTS: XRHandJoint[] = [
  'wrist',
  'thumb-metacarpal',
  'thumb-phalanx-proximal',
  'thumb-phalanx-distal',
  'thumb-tip',
  'index-finger-metacarpal',
  'index-finger-phalanx-proximal',
  'index-finger-phalanx-intermediate',
  'index-finger-phalanx-distal',
  'index-finger-tip',
  'middle-finger-metacarpal',
  'middle-finger-phalanx-proximal',
  'middle-finger-phalanx-intermediate',
  'middle-finger-phalanx-distal',
  'middle-finger-tip',
  'ring-finger-metacarpal',
  'ring-finger-phalanx-proximal',
  'ring-finger-phalanx-intermediate',
  'ring-finger-phalanx-distal',
  'ring-finger-tip',
  'pinky-finger-metacarpal',
  'pinky-finger-phalanx-proximal',
  'pinky-finger-phalanx-intermediate',
  'pinky-finger-phalanx-distal',
  'pinky-finger-tip',
];

export class PinchDetector {
  private on = false;
  private count = 0;
  constructor(
    private readonly onDist = 0.02,
    private readonly offDist = 0.035,
    private readonly framesToChange = 2,
  ) {}
  /** returns the stable pinch state; `force` (select button / emulator) overrides the distance */
  update(distance: number | null, force?: boolean, out: PinchState = { pinching: false, justStarted: false, justEnded: false }): PinchState {
    const want = force ?? (distance === null ? false : this.on ? distance <= this.offDist : distance < this.onDist);
    const was = this.on;
    if (force !== undefined) {
      this.on = force;
      this.count = 0;
    } else {
      this.count = want !== this.on ? this.count + 1 : 0;
      if (this.count >= this.framesToChange) {
        this.on = want;
        this.count = 0;
      }
    }
    out.pinching = this.on;
    out.justStarted = this.on && !was;
    out.justEnded = !this.on && was;
    return out;
  }
  reset(): void {
    this.on = false;
    this.count = 0;
  }
}

interface PinchState {
  pinching: boolean;
  justStarted: boolean;
  justEnded: boolean;
}

interface HandTrack {
  pinch: PinchDetector;
  state: PinchState;
  jointPinching: boolean;
  pinching: boolean;
  lastJointTime: number | null;
  lastPinchPoint: Vector3;
  hasPinchPoint: boolean;
  palmUpSince: number | null;
  selectDown: boolean;
  selectLatched: boolean;
  jointCount: number;
  pinchDistanceCm: number | null;
  hand: ShellHand;
  jointPool: Record<XRHandJoint, JointSample>;
}

export interface HandDiagnostics {
  tracked: boolean;
  jointCount: number;
  pinchDistanceCm: number | null;
  selectEvents: number;
  selectDown: boolean;
}

export type InputDiagnostics = Record<Handedness, HandDiagnostics>;

const JOINT_LOSS_GRACE_MS = 150;
const HANDEDNESSES: readonly Handedness[] = ['left', 'right'];

function makeHand(): ShellHand {
  return {
    joints: {}, pinching: false, justPinched: false, justReleased: false,
    pinchPoint: new Vector3(), ray: { origin: new Vector3(), dir: new Vector3(0, 0, -1) },
    palmUp: false, palmUpMs: 0, controller: false,
  };
}

function makeTrack(): HandTrack {
  const jointPool = {} as Record<XRHandJoint, JointSample>;
  for (const name of JOINTS) jointPool[name] = { position: new Vector3(), quaternion: new Quaternion(), radius: 0.008 };
  return {
    pinch: new PinchDetector(), state: { pinching: false, justStarted: false, justEnded: false },
    jointPinching: false, pinching: false, lastJointTime: null, lastPinchPoint: new Vector3(), hasPinchPoint: false,
    palmUpSince: null, selectDown: false, selectLatched: false, jointCount: 0, pinchDistanceCm: null,
    hand: makeHand(), jointPool,
  };
}
const newDiagnostics = (): HandDiagnostics => ({
  tracked: false, jointCount: 0, pinchDistanceCm: null, selectEvents: 0, selectDown: false,
});

export interface DesktopPointer {
  /** normalised device coordinates of the mouse */
  ndc: Vector2;
  down: boolean;
  /** a press not yet seen by a frame (a click can go down and up within one frame) */
  latched: boolean;
  /** true while the pointer is over the 3D canvas */
  inside: boolean;
}

export class InputSampler {
  // Quest can expose a hand and an idle controller for the same side at once.
  // Keep gestures with their source so sampling or select events cannot reset the other one.
  private readonly tracks = new Map<XRInputSource, HandTrack>();
  private readonly activeSources: Partial<Record<Handedness, XRInputSource>> = {};
  readonly diagnostics: InputDiagnostics = { left: newDiagnostics(), right: newDiagnostics() };
  private readonly desktopPinch = new PinchDetector();
  private readonly desktopState: PinchState = { pinching: false, justStarted: false, justEnded: false };
  private readonly desktopHand = makeHand();
  private readonly raycaster = new Raycaster();
  private readonly rayQuaternion = new Quaternion();
  private readonly palm = new Vector3();
  private readonly output: ShellFrame = {
    time: 0, dt: 1 / 72,
    head: { position: new Vector3(), quaternion: new Quaternion(), ray: { origin: new Vector3(), dir: new Vector3(0, 0, -1) } },
    hands: {},
  };
  private lastTime = 0;
  /** desktop / emulator: mouse ray + click as the right hand */
  readonly pointer: DesktopPointer = { ndc: new Vector2(), down: false, latched: false, inside: false };
  /** emulator: route the mouse as the right hand even inside an emulated XR session */
  mouseAsHand = false;
  private session?: XRSession;
  private readonly onSelectStart = (e: XRInputSourceEvent) => {
    if (e.frame.session === this.session) this.setSelect(e.inputSource, true);
  };
  private readonly onSelectEnd = (e: XRInputSourceEvent) => {
    if (e.frame.session === this.session) this.setSelect(e.inputSource, false);
  };
  private readonly onSessionEnd = (e: XRSessionEvent) => {
    if (e.session === this.session) this.detach();
  };
  private readonly onSourcesChange = (e: XRInputSourcesChangeEvent) => {
    if (e.session !== this.session) return;
    for (const src of e.removed) {
      this.tracks.delete(src);
      if (src.handedness === 'left' || src.handedness === 'right') {
        if (this.activeSources[src.handedness] === src) this.clearHand(src.handedness);
      }
    }
  };

  attach(session: XRSession): void {
    if (this.session === session) return;
    this.detach();
    this.session = session;
    session.addEventListener('selectstart', this.onSelectStart);
    session.addEventListener('selectend', this.onSelectEnd);
    session.addEventListener('end', this.onSessionEnd);
    session.addEventListener('inputsourceschange', this.onSourcesChange);
  }

  detach(): void {
    this.session?.removeEventListener('selectstart', this.onSelectStart);
    this.session?.removeEventListener('selectend', this.onSelectEnd);
    this.session?.removeEventListener('end', this.onSessionEnd);
    this.session?.removeEventListener('inputsourceschange', this.onSourcesChange);
    this.session = undefined;
    this.tracks.clear();
    this.clearHand('left', true);
    this.clearHand('right', true);
    this.desktopPinch.reset();
    this.pointer.down = false;
    this.pointer.latched = false;
    this.lastTime = 0;
  }

  private clearHand(hand: Handedness, resetEvents = false): void {
    delete this.activeSources[hand];
    const diagnostic = this.diagnostics[hand];
    diagnostic.tracked = false;
    diagnostic.jointCount = 0;
    diagnostic.pinchDistanceCm = null;
    diagnostic.selectDown = false;
    if (resetEvents) diagnostic.selectEvents = 0;
  }

  private trackSource(src: XRInputSource): HandTrack {
    let track = this.tracks.get(src);
    if (!track) {
      track = makeTrack();
      this.tracks.set(src, track);
    }
    return track;
  }

  private hasSource(src: XRInputSource): boolean {
    for (const current of this.session?.inputSources ?? []) if (current === src) return true;
    return false;
  }

  private setSelect(src: XRInputSource, down: boolean): void {
    if (src.handedness !== 'left' && src.handedness !== 'right') return;
    if (!this.hasSource(src)) return;
    const track = this.trackSource(src);
    track.selectDown = down;
    // A short system pinch can start and end between animation frames.
    if (down) track.selectLatched = true;
    const diagnostic = this.diagnostics[src.handedness];
    diagnostic.selectEvents++;
    if (this.activeSources[src.handedness] === src) diagnostic.selectDown = down;
  }

  /** Sample this frame into reusable storage; consumers retaining poses must copy them. */
  sample(time: number, camera: Camera, frame?: XRFrame, refSpace?: XRReferenceSpace): ShellFrame {
    // The renderer supplies this live frame inside its XR animation callback. Re-entry creates a
    // different session; binding here also covers a missed application-level session-start callback.
    if (frame) this.attach(frame.session);
    const dt = this.lastTime ? Math.min(0.1, (time - this.lastTime) / 1000) : 1 / 72;
    this.lastTime = time;
    const f = this.output;
    const { head, hands } = f;
    delete hands.left;
    delete hands.right;
    camera.getWorldPosition(head.position);
    camera.getWorldQuaternion(head.quaternion);
    for (const handedness of HANDEDNESSES) {
      this.clearHand(handedness);
    }
    if (frame && refSpace) {
      const vp = frame.getViewerPose(refSpace);
      if (vp) {
        const p = vp.transform.position;
        const o = vp.transform.orientation;
        head.position.set(p.x, p.y, p.z);
        head.quaternion.set(o.x, o.y, o.z, o.w);
      }
      for (const src of this.tracks.keys()) {
        if (!this.hasSource(src)) this.tracks.delete(src);
      }
      for (const src of frame.session.inputSources) {
        if (src.handedness !== 'left' && src.handedness !== 'right') continue;
        const hs = this.sampleSource(src, frame, refSpace, time);
        const current = hands[src.handedness];
        // A located hand wins in either inputSources order. An unlocated hand still advances
        // its gesture state, so recovering a held select cannot invent a second press.
        if (hs && (!current || (current.controller && !hs.controller))) {
          hands[src.handedness] = hs;
          this.activeSources[src.handedness] = src;
          const track = this.tracks.get(src)!;
          const diagnostic = this.diagnostics[src.handedness];
          diagnostic.tracked = track.jointCount > 0;
          diagnostic.jointCount = track.jointCount;
          diagnostic.pinchDistanceCm = track.pinchDistanceCm;
          diagnostic.selectDown = track.selectDown;
        }
      }
    }
    head.ray.origin.copy(head.position);
    head.ray.dir.set(0, 0, -1).applyQuaternion(head.quaternion);
    if (!frame || this.mouseAsHand) {
      const mouse = this.sampleMouse(camera, head);
      if (mouse) hands.right = mouse;
    }
    f.time = time;
    f.dt = dt;
    if (frame && refSpace) {
      f.frame = frame;
      f.refSpace = refSpace;
    } else {
      delete f.frame;
      delete f.refSpace;
    }
    return f;
  }

  private sampleSource(src: XRInputSource, frame: XRFrame, ref: XRReferenceSpace, time: number): ShellHand | null {
    const track = this.trackSource(src);
    const hand = track.hand;
    const { ray, joints, pinchPoint } = hand;
    const rayPose = frame.getPose(src.targetRaySpace, ref);
    // A missing target ray is not a ray from the world origin. Consumers can reject this zero vector.
    ray.origin.set(0, 0, 0);
    ray.dir.set(0, 0, 0);
    if (rayPose) {
      const p = rayPose.transform.position;
      const o = rayPose.transform.orientation;
      ray.origin.set(p.x, p.y, p.z);
      ray.dir.set(0, 0, -1).applyQuaternion(this.rayQuaternion.set(o.x, o.y, o.z, o.w));
    }
    let distance: number | null = null;
    pinchPoint.copy(ray.origin);
    let palmUp = false;
    let hasSpatialPose = !!rayPose;
    let jointCount = 0;
    if (src.hand && frame.getJointPose) {
      for (const name of JOINTS) {
        const space = src.hand.get(name);
        const jp = space ? frame.getJointPose(space, ref) : undefined;
        if (!jp) {
          delete joints[name];
          continue;
        }
        jointCount++;
        const p = jp.transform.position;
        const o = jp.transform.orientation;
        const joint = track.jointPool[name];
        joint.position.set(p.x, p.y, p.z);
        joint.quaternion.set(o.x, o.y, o.z, o.w);
        joint.radius = jp.radius ?? 0.008;
        joints[name] = joint;
      }
      const thumb = joints['thumb-tip'];
      const index = joints['index-finger-tip'];
      if (!rayPose) {
        const position = (index ?? thumb ?? joints.wrist ?? Object.values(joints)[0])?.position;
        if (position) pinchPoint.copy(position);
      }
      if (thumb && index) {
        distance = thumb.position.distanceTo(index.position);
        pinchPoint.addVectors(thumb.position, index.position).multiplyScalar(0.5);
        track.lastPinchPoint.copy(pinchPoint);
        track.hasPinchPoint = true;
      }
      const wrist = joints.wrist;
      if (wrist) {
        // WebXR joint space: -Y points perpendicular out of the palm, -Z along the bone.
        // https://www.w3.org/TR/webxr-hand-input-1/#xrjointspace (same axes for both hands).
        this.palm.set(0, -1, 0).applyQuaternion(wrist.quaternion);
        palmUp = this.palm.y > 0.75;
      }
    } else {
      for (const name of JOINTS) delete joints[name];
      const grip = src.gripSpace ? frame.getPose(src.gripSpace, ref) : undefined;
      if (grip) {
        pinchPoint.set(grip.transform.position.x, grip.transform.position.y, grip.transform.position.z);
        hasSpatialPose = true;
      }
    }
    const controller = !src.hand;
    if (distance !== null) {
      track.lastJointTime = time;
      track.jointPinching = track.pinch.update(distance, undefined, track.state).pinching;
    } else if (track.lastJointTime !== null && time - track.lastJointTime <= JOINT_LOSS_GRACE_MS) {
      // Brief occlusion must not split an existing drag; missing samples never start a new pinch.
      track.pinch.update(null, track.jointPinching, track.state);
    } else {
      track.pinch.reset();
      track.jointPinching = false;
    }
    // Keep these independent: a system select must not seed the distance detector's hysteresis.
    // Quest's system select is its pinch, including when joint poses are unavailable.
    const pinching = track.jointPinching || track.selectDown || track.selectLatched;
    if (distance === null) {
      // Freeze an ongoing gesture through occlusion, including its release frame. A new system
      // pinch must not acquire a control at an old midpoint left over from a previous gesture.
      if (track.pinching && track.hasPinchPoint) pinchPoint.copy(track.lastPinchPoint);
      else track.hasPinchPoint = false;
    }
    const justPinched = pinching && !track.pinching;
    const justReleased = !pinching && track.pinching;
    track.pinching = pinching;
    track.selectLatched = false;
    track.jointCount = jointCount;
    track.pinchDistanceCm = distance === null ? null : distance * 100;
    if (palmUp) {
      if (track.palmUpSince === null) track.palmUpSince = time;
    } else track.palmUpSince = null;
    if (!hasSpatialPose && jointCount === 0) {
      // Hide the cursor without inventing a new press when a still-held pinch becomes located again.
      return null;
    }
    hand.pinching = pinching;
    hand.justPinched = justPinched;
    hand.justReleased = justReleased;
    hand.palmUp = palmUp;
    hand.palmUpMs = track.palmUpSince === null ? 0 : time - track.palmUpSince;
    hand.controller = controller;
    return hand;
  }

  private sampleMouse(camera: Camera, head: ShellFrame['head']): ShellHand | null {
    if (!this.pointer.inside && !this.pointer.down && !this.pointer.latched) {
      this.desktopPinch.reset();
      return null;
    }
    // A mono XR view carries the authoritative inverse projection for emulator clicks.
    const rayCamera = camera instanceof ArrayCamera && camera.cameras.length === 1 ? camera.cameras[0] : camera;
    rayCamera.updateWorldMatrix(true, false);
    this.raycaster.setFromCamera(this.pointer.ndc, rayCamera);
    const hand = this.desktopHand;
    const { ray } = hand;
    ray.origin.copy(this.raycaster.ray.origin);
    ray.dir.copy(this.raycaster.ray.direction);
    if (!Number.isFinite(ray.dir.x)) {
      ray.origin.copy(head.position);
      ray.dir.copy(head.ray.dir);
    }
    const pinch = this.desktopPinch.update(null, this.pointer.down || this.pointer.latched, this.desktopState);
    this.pointer.latched = false;
    hand.pinching = pinch.pinching;
    hand.justPinched = pinch.justStarted;
    hand.justReleased = pinch.justEnded;
    hand.pinchPoint.copy(ray.origin).addScaledVector(ray.dir, 0.6);
    hand.controller = true;
    return hand;
  }
}

/** Every tracked joint position of both hands (for the scan guard that never tags a hand). */
export function handJointPositions(f: ShellFrame | undefined): Vector3[] {
  if (!f) return [];
  const out: Vector3[] = [];
  for (const h of [f.hands.left, f.hands.right]) {
    if (!h) continue;
    for (const j of Object.values(h.joints)) if (j) out.push(j.position);
  }
  return out;
}
