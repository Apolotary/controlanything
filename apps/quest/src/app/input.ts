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
    const want = force ?? (distance === null ? false : this.on ? distance < this.offDist : distance < this.onDist);
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
  pinch: PinchDetector;
  palmUpSince: number;
  selectDown: boolean;
}

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
    left: { pinch: new PinchDetector(), palmUpSince: 0, selectDown: false },
    right: { pinch: new PinchDetector(), palmUpSince: 0, selectDown: false },
  };
  private readonly desktopPinch = new PinchDetector();
  private readonly raycaster = new Raycaster();
  private lastTime = 0;
  /** desktop / emulator: mouse ray + click as the right hand */
  readonly pointer: DesktopPointer = { ndc: new Vector2(), down: false, latched: false, inside: false };
  /** emulator: route the mouse as the right hand even inside an emulated XR session */
  mouseAsHand = false;
  private session?: XRSession;
  private readonly onSelectStart = (e: XRInputSourceEvent) => this.setSelect(e.inputSource, true);
  private readonly onSelectEnd = (e: XRInputSourceEvent) => this.setSelect(e.inputSource, false);

  attach(session: XRSession): void {
    this.detach();
    this.session = session;
    session.addEventListener('selectstart', this.onSelectStart);
    session.addEventListener('selectend', this.onSelectEnd);
  }

  detach(): void {
    this.session?.removeEventListener('selectstart', this.onSelectStart);
    this.session?.removeEventListener('selectend', this.onSelectEnd);
    this.session = undefined;
    for (const t of Object.values(this.tracks)) {
      t.pinch.reset();
      t.selectDown = false;
    }
  }

  private setSelect(src: XRInputSource, down: boolean): void {
    if (src.handedness === 'left' || src.handedness === 'right') this.tracks[src.handedness].selectDown = down;
  }

  /** Sample everything for this frame. `camera` is the rendering camera (desktop) or the XR camera. */
  sample(time: number, camera: Camera, frame?: XRFrame, refSpace?: XRReferenceSpace): ShellFrame {
    const dt = this.lastTime ? Math.min(0.1, (time - this.lastTime) / 1000) : 1 / 72;
    this.lastTime = time;
    const head = { position: new Vector3(), quaternion: new Quaternion(), ray: { origin: new Vector3(), dir: new Vector3(0, 0, -1) } };
    const hands: ShellFrame['hands'] = {};
    if (frame && refSpace) {
      const vp = frame.getViewerPose(refSpace);
      if (vp) {
        const p = vp.transform.position;
        const o = vp.transform.orientation;
        head.position.set(p.x, p.y, p.z);
        head.quaternion.set(o.x, o.y, o.z, o.w);
      }
      for (const src of frame.session.inputSources) {
        if (src.handedness !== 'left' && src.handedness !== 'right') continue;
        const hs = this.sampleSource(src, frame, refSpace, time);
        if (hs) hands[src.handedness] = hs;
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
    const track = this.tracks[src.handedness as Handedness];
    const rayPose = frame.getPose(src.targetRaySpace, ref);
    const ray = { origin: new Vector3(), dir: new Vector3(0, 0, -1) };
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
    if (src.hand && frame.getJointPose) {
      for (const name of JOINTS) {
        const space = src.hand.get(name);
        const jp = space ? frame.getJointPose(space, ref) : undefined;
        if (!jp) continue;
        const p = jp.transform.position;
        const o = jp.transform.orientation;
        joints[name] = { position: new Vector3(p.x, p.y, p.z), quaternion: new Quaternion(o.x, o.y, o.z, o.w), radius: jp.radius ?? 0.008 };
      }
      const thumb = joints['thumb-tip'];
      const index = joints['index-finger-tip'];
      if (thumb && index) {
        distance = thumb.position.distanceTo(index.position);
        pinchPoint.addVectors(thumb.position, index.position).multiplyScalar(0.5);
      }
      const wrist = joints.wrist;
      if (wrist) {
        // the palm faces the wrist frame's -Y (WebXR: +Y out of the back of the hand)
        const palm = new Vector3(0, -1, 0).applyQuaternion(wrist.quaternion);
        palmUp = palm.y > 0.75;
      }
    } else {
      const grip = src.gripSpace ? frame.getPose(src.gripSpace, ref) : undefined;
      if (grip) pinchPoint.set(grip.transform.position.x, grip.transform.position.y, grip.transform.position.z);
    }
    const controller = !src.hand;
    // hands: joint distance, OR the platform's own select (it is the pinch on Quest); controllers: select only
    const force = controller ? track.selectDown : track.selectDown ? true : undefined;
    const pinch = track.pinch.update(distance, force);
    if (palmUp) {
      if (!track.palmUpSince) track.palmUpSince = time;
    } else track.palmUpSince = 0;
    return {
      joints,
      pinching: pinch.pinching,
      justPinched: pinch.justStarted,
      justReleased: pinch.justEnded,
      pinchPoint,
      ray,
      palmUp,
      palmUpMs: palmUp ? time - track.palmUpSince : 0,
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
