/**
 * Per-frame input sampling for the HUD and the shell: the viewer pose, hand joints with a hysteresis pinch
 * (on < 2.0 cm, off > 3.5 cm, two frames to change: research/04 §5), the palm-up deck gesture, controllers
 * (select button = pinch), and on the desktop a mouse/keyboard stand-in (click = pinch along the mouse ray).
 */
import { type Camera, Quaternion, Raycaster, Vector2, Vector3 } from 'three';
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
  update(distance: number | null, force?: boolean): { pinching: boolean; justStarted: boolean; justEnded: boolean } {
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
    return { pinching: this.on, justStarted: this.on && !was, justEnded: !this.on && was };
  }
  reset(): void {
    this.on = false;
    this.count = 0;
  }
}

interface HandTrack {
  source?: XRInputSource;
  pinch: PinchDetector;
  jointPinching: boolean;
  pinching: boolean;
  lastJointTime: number | null;
  lastPinchPoint: Vector3 | null;
  palmUpSince: number | null;
  selectDown: boolean;
  selectLatched: boolean;
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
const newTrack = (): HandTrack => ({
  pinch: new PinchDetector(), jointPinching: false, pinching: false, lastJointTime: null, lastPinchPoint: null,
  palmUpSince: null, selectDown: false, selectLatched: false,
});
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
  private readonly tracks: Record<Handedness, HandTrack> = {
    left: newTrack(),
    right: newTrack(),
  };
  readonly diagnostics: InputDiagnostics = { left: newDiagnostics(), right: newDiagnostics() };
  private readonly desktopPinch = new PinchDetector();
  private readonly raycaster = new Raycaster();
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
      if (src.handedness === 'left' || src.handedness === 'right') {
        if (this.tracks[src.handedness].source === src) this.resetHand(src.handedness);
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
    this.resetHand('left', true);
    this.resetHand('right', true);
    this.desktopPinch.reset();
    this.pointer.down = false;
    this.pointer.latched = false;
  }

  private resetHand(hand: Handedness, resetEvents = false): void {
    this.tracks[hand] = newTrack();
    const selectEvents = resetEvents ? 0 : this.diagnostics[hand].selectEvents;
    Object.assign(this.diagnostics[hand], newDiagnostics(), { selectEvents });
  }

  private trackSource(src: XRInputSource, hand: Handedness): HandTrack {
    if (this.tracks[hand].source !== src) {
      this.resetHand(hand);
      this.tracks[hand].source = src;
    }
    return this.tracks[hand];
  }

  private setSelect(src: XRInputSource, down: boolean): void {
    if (src.handedness !== 'left' && src.handedness !== 'right') return;
    if (!Array.from(this.session?.inputSources ?? []).includes(src)) return;
    const track = this.trackSource(src, src.handedness);
    track.selectDown = down;
    // A short system pinch can start and end between animation frames.
    if (down) track.selectLatched = true;
    const diagnostic = this.diagnostics[src.handedness];
    diagnostic.selectEvents++;
    diagnostic.selectDown = down;
  }

  /** Sample everything for this frame. `camera` is the rendering camera (desktop) or the XR camera. */
  sample(time: number, camera: Camera, frame?: XRFrame, refSpace?: XRReferenceSpace): ShellFrame {
    const dt = this.lastTime ? Math.min(0.1, (time - this.lastTime) / 1000) : 1 / 72;
    this.lastTime = time;
    const head = { position: new Vector3(), quaternion: new Quaternion(), ray: { origin: new Vector3(), dir: new Vector3(0, 0, -1) } };
    const hands: ShellFrame['hands'] = {};
    // The renderer supplies this live frame inside its XR animation callback. Re-entry creates a
    // different session; binding here also covers a missed application-level session-start callback.
    if (frame) this.attach(frame.session);
    for (const diagnostic of Object.values(this.diagnostics)) {
      diagnostic.tracked = false;
      diagnostic.jointCount = 0;
      diagnostic.pinchDistanceCm = null;
    }
    if (frame && refSpace) {
      const vp = frame.getViewerPose(refSpace);
      if (vp) {
        const p = vp.transform.position;
        const o = vp.transform.orientation;
        head.position.set(p.x, p.y, p.z);
        head.quaternion.set(o.x, o.y, o.z, o.w);
      }
      const present = new Set<Handedness>();
      for (const src of frame.session.inputSources) {
        if (src.handedness !== 'left' && src.handedness !== 'right') continue;
        present.add(src.handedness);
        const hs = this.sampleSource(src, frame, refSpace, time);
        if (hs) hands[src.handedness] = hs;
      }
      for (const hand of ['left', 'right'] as const) {
        if (!present.has(hand) && this.tracks[hand].source) this.resetHand(hand);
      }
    } else {
      camera.getWorldPosition(head.position);
      camera.getWorldQuaternion(head.quaternion);
    }
    head.ray.origin.copy(head.position);
    head.ray.dir.set(0, 0, -1).applyQuaternion(head.quaternion);
    if (!frame || this.mouseAsHand) {
      const mouse = this.sampleMouse(camera, head);
      if (mouse) hands.right = mouse;
    }
    const f: ShellFrame = { time, dt, head, hands };
    if (frame && refSpace) {
      f.frame = frame;
      f.refSpace = refSpace;
    }
    return f;
  }

  private sampleSource(src: XRInputSource, frame: XRFrame, ref: XRReferenceSpace, time: number): ShellHand | null {
    const hand = src.handedness as Handedness;
    const track = this.trackSource(src, hand);
    const rayPose = frame.getPose(src.targetRaySpace, ref);
    // A missing target ray is not a ray from the world origin. Consumers can reject this zero vector.
    const ray = { origin: new Vector3(), dir: new Vector3() };
    if (rayPose) {
      const p = rayPose.transform.position;
      const o = rayPose.transform.orientation;
      ray.origin.set(p.x, p.y, p.z);
      ray.dir.set(0, 0, -1).applyQuaternion(new Quaternion(o.x, o.y, o.z, o.w));
    }
    const joints: Partial<Record<XRHandJoint, JointSample>> = {};
    let distance: number | null = null;
    const pinchPoint = ray.origin.clone();
    let palmUp = false;
    let hasSpatialPose = !!rayPose;
    let jointCount = 0;
    if (src.hand && frame.getJointPose) {
      for (const name of JOINTS) {
        const space = src.hand.get(name);
        const jp = space ? frame.getJointPose(space, ref) : undefined;
        if (!jp) continue;
        jointCount++;
        const p = jp.transform.position;
        const o = jp.transform.orientation;
        joints[name] = { position: new Vector3(p.x, p.y, p.z), quaternion: new Quaternion(o.x, o.y, o.z, o.w), radius: jp.radius ?? 0.008 };
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
        (track.lastPinchPoint ??= new Vector3()).copy(pinchPoint);
      }
      const wrist = joints.wrist;
      if (wrist) {
        // WebXR joint space: -Y points perpendicular out of the palm, -Z along the bone.
        // https://www.w3.org/TR/webxr-hand-input-1/#xrjointspace (same axes for both hands).
        const palm = new Vector3(0, -1, 0).applyQuaternion(wrist.quaternion);
        palmUp = palm.y > 0.75;
      }
    } else {
      const grip = src.gripSpace ? frame.getPose(src.gripSpace, ref) : undefined;
      if (grip) {
        pinchPoint.set(grip.transform.position.x, grip.transform.position.y, grip.transform.position.z);
        hasSpatialPose = true;
      }
    }
    const controller = !src.hand;
    if (distance !== null) {
      track.lastJointTime = time;
      track.jointPinching = track.pinch.update(distance).pinching;
    } else if (track.lastJointTime !== null && time - track.lastJointTime <= JOINT_LOSS_GRACE_MS) {
      // Brief occlusion must not split an existing drag; missing samples never start a new pinch.
      track.pinch.update(null, track.jointPinching);
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
      if (track.pinching && track.lastPinchPoint) pinchPoint.copy(track.lastPinchPoint);
      else track.lastPinchPoint = null;
    }
    const justPinched = pinching && !track.pinching;
    const justReleased = !pinching && track.pinching;
    track.pinching = pinching;
    track.selectLatched = false;
    Object.assign(this.diagnostics[hand], {
      tracked: jointCount > 0,
      jointCount,
      pinchDistanceCm: distance === null ? null : distance * 100,
      selectDown: track.selectDown,
    });
    if (palmUp) {
      if (track.palmUpSince === null) track.palmUpSince = time;
    } else track.palmUpSince = null;
    if (!hasSpatialPose && jointCount === 0) {
      // Hide the cursor without inventing a new press when a still-held pinch becomes located again.
      return null;
    }
    return {
      joints,
      pinching,
      justPinched,
      justReleased,
      pinchPoint,
      ray,
      palmUp,
      palmUpMs: track.palmUpSince === null ? 0 : time - track.palmUpSince,
      controller,
    };
  }

  private sampleMouse(camera: Camera, head: ShellFrame['head']): ShellHand | null {
    if (!this.pointer.inside && !this.pointer.down && !this.pointer.latched) return null;
    this.raycaster.setFromCamera(this.pointer.ndc, camera);
    const ray = { origin: this.raycaster.ray.origin.clone(), dir: this.raycaster.ray.direction.clone() };
    if (!Number.isFinite(ray.dir.x)) {
      ray.origin.copy(head.position);
      ray.dir.copy(head.ray.dir);
    }
    const pinch = this.desktopPinch.update(null, this.pointer.down || this.pointer.latched);
    this.pointer.latched = false;
    return {
      joints: {},
      pinching: pinch.pinching,
      justPinched: pinch.justStarted,
      justReleased: pinch.justEnded,
      pinchPoint: ray.origin.clone().addScaledVector(ray.dir, 0.6),
      ray,
      palmUp: false,
      palmUpMs: 0,
      controller: true,
    };
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
