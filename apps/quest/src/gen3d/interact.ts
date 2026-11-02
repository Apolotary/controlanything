/**
 * Cursors: one abstraction for XR hands, XR controllers and the mouse, so the behaviour runtime in build.ts
 * runs identically on the headset, in IWER and on a laptop.
 *
 * A cursor has a pinch point (thumb-index midpoint, or the ray hit), an index tip (for pokes), pinch state
 * with hysteresis already applied by the input layer, and an optional wrist orientation.
 */
import { Camera, Matrix4, Object3D, Plane, Quaternion, Raycaster, Vector2, Vector3 } from 'three';
import type { Axis } from '@ce/gen3d';

export type CursorHand = 'left' | 'right' | 'mouse' | 'controller';

export interface Cursor {
  id: string;
  hand: CursorHand;
  /** pinch point in world space (or the ray hit for mouse/controller) */
  position: Vector3;
  /** index fingertip in world space (same as position for mouse/controller) */
  tip: Vector3;
  pinching: boolean;
  justPinched: boolean;
  justReleased: boolean;
  wristQuat?: Quaternion;
  ray?: { origin: Vector3; dir: Vector3 };
  /** true when the cursor is tracked this frame */
  tracked: boolean;
  /** pokes only make sense for real fingers */
  canPoke: boolean;
}

export const AXIS_VEC: Record<Axis, Vector3> = {
  x: new Vector3(1, 0, 0),
  y: new Vector3(0, 1, 0),
  z: new Vector3(0, 0, 1),
};

/** Angle (degrees) of a local point around an axis, clockwise as seen from +axis for z (knob convention). */
export function angleAround(local: Vector3, axis: Axis): number {
  switch (axis) {
    case 'z':
      return (Math.atan2(local.x, local.y) * 180) / Math.PI; // clockwise from 12 o'clock as the user sees it
    case 'x':
      return (Math.atan2(local.z, local.y) * 180) / Math.PI; // +y toward +z = positive (pull toward the user)
    case 'y':
      return (Math.atan2(local.x, -local.z) * 180) / Math.PI;
  }
}

export const wrapDeg = (d: number): number => ((((d + 180) % 360) + 360) % 360) - 180;
export const clamp = (x: number, a: number, b: number): number => Math.min(b, Math.max(a, x));

/**
 * Mouse → cursor for the desktop stage. The pinch point is the ray hit on the interactive meshes; while a grab
 * is held the mouse keeps moving the cursor on a camera-facing plane through the grab point, so dragging
 * continues after the pointer leaves the mesh. Wheel = twist.
 */
export class MouseCursor {
  readonly cursor: Cursor;
  private ndc = new Vector2(-10, -10);
  private down = false;
  private wasDown = false;
  /** edges latched between frames so a press shorter than one frame still produces a start and an end */
  private pendingDown = false;
  private pendingUp = false;
  /** where the press happened and whether the pointer moved since the last frame: a down+move+up that all
   *  arrive between two frames is replayed as press (at the down point) → move → release on successive frames */
  private downNdc = new Vector2();
  private movePending = false;
  private raycaster = new Raycaster();
  private plane = new Plane();
  private dragging = false;
  private readonly tmp = new Vector3();
  wheelDelta = 0;
  private targets: Object3D[] = [];

  constructor(private el: HTMLElement, private camera: Camera) {
    this.cursor = { id: 'mouse', hand: 'mouse', position: new Vector3(), tip: new Vector3(), pinching: false, justPinched: false, justReleased: false, tracked: false, canPoke: false };
    // three's defaults treat any Line/Points within ONE METRE of the ray as a hit (edge keylines, particles)
    this.raycaster.params.Line.threshold = 0.004;
    this.raycaster.params.Points.threshold = 0.004;
    el.addEventListener('pointermove', (e) => this.onMove(e));
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.onMove(e);
      this.downNdc.copy(this.ndc);
      this.movePending = false;
      this.down = true;
      this.pendingDown = true;
    });
    const up = () => {
      this.down = false;
      this.pendingUp = true;
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    }
    el.addEventListener('wheel', (e) => {
      this.wheelDelta += e.deltaY;
      e.preventDefault();
    }, { passive: false });
    el.addEventListener('pointerleave', () => {
      if (!this.down) this.ndc.set(-10, -10);
    });
  }

  private onMove(e: PointerEvent): void {
    const r = this.el.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    if (this.wasDown || this.pendingDown) this.movePending = true;
  }

  setTargets(objects: Object3D[]): void {
    this.targets = objects;
  }

  /** True while the mouse holds a grab (the stage can disable orbit controls). */
  get busy(): boolean {
    return this.dragging;
  }

  /** Call once per frame before the objects update. */
  update(): Cursor {
    const c = this.cursor;
    // deliver latched edges one per frame: down+move+up between two frames becomes press (at the down point),
    // then move, then release on three successive frames, so synthetic or very fast drags still turn knobs
    let rayNdc = this.ndc;
    if (this.pendingDown && !this.wasDown) {
      c.justPinched = true;
      c.justReleased = false;
      c.pinching = true;
      this.pendingDown = false;
      this.wasDown = true;
      rayNdc = this.downNdc;
      if (!this.down) this.pendingUp = true;
    } else if (this.wasDown && this.movePending) {
      c.justPinched = false;
      c.justReleased = false;
      c.pinching = true;
      this.movePending = false;
    } else if (this.pendingUp && this.wasDown) {
      c.justPinched = false;
      c.justReleased = true;
      c.pinching = false;
      this.pendingUp = false;
      this.wasDown = false;
    } else {
      c.justPinched = false;
      c.justReleased = false;
      c.pinching = this.wasDown;
      this.pendingDown = false;
      this.pendingUp = false;
    }
    c.tracked = rayNdc.x > -5;
    if (!c.tracked) return c;
    this.raycaster.setFromCamera(rayNdc, this.camera);
    c.ray = { origin: this.raycaster.ray.origin.clone(), dir: this.raycaster.ray.direction.clone() };
    if (this.dragging && c.pinching) {
      // keep moving on the drag plane
      const hit = this.raycaster.ray.intersectPlane(this.plane, this.tmp);
      if (hit) c.position.copy(hit);
    } else {
      // hidden parts (hints, a dim plane) are still raycast by three: only what the user can see may take the cursor
      const shown = (o: Object3D | null): boolean => (o ? o.visible && shown(o.parent) : true);
      const hits = this.raycaster.intersectObjects(this.targets, true).filter((h) => shown(h.object));
      if (hits.length) {
        c.position.copy(hits[0]!.point);
        if (c.justPinched) {
          this.dragging = true;
          const n = this.camera.getWorldDirection(new Vector3()).negate();
          this.plane.setFromNormalAndCoplanarPoint(n, c.position);
        }
      } else if (!this.dragging) {
        // hover in empty space: put the cursor far away so nothing is "near"
        c.position.copy(this.raycaster.ray.origin).addScaledVector(this.raycaster.ray.direction, 100);
      }
    }
    if (!c.pinching) this.dragging = false;
    c.tip.copy(c.position);
    return c;
  }

  /** Consume the accumulated wheel delta (pixels). */
  takeWheel(): number {
    const d = this.wheelDelta;
    this.wheelDelta = 0;
    return d;
  }
}

/** Minimal joint pose shape (matches quest-io's HandState.joints entries). */
export interface JointPose {
  position: Vector3;
  quaternion: Quaternion;
  radius?: number;
}
export interface HandInput {
  joints: Partial<Record<string, JointPose>>;
  pinching: boolean;
  justPinched: boolean;
  justReleased: boolean;
  pinchPoint: Vector3;
  ray?: { origin: Vector3; dir: Vector3 };
}

/** Hand state (sampled by the app shell) → cursor. */
export function handCursor(hand: 'left' | 'right', h: HandInput | undefined, out: Cursor): Cursor {
  out.id = hand;
  out.hand = hand;
  out.canPoke = true;
  if (!h) {
    out.tracked = false;
    out.pinching = false;
    out.justPinched = false;
    out.justReleased = false;
    return out;
  }
  out.tracked = true;
  out.position.copy(h.pinchPoint);
  const tip = h.joints['index-finger-tip'];
  out.tip.copy(tip ? tip.position : h.pinchPoint);
  out.pinching = h.pinching;
  out.justPinched = h.justPinched;
  out.justReleased = h.justReleased;
  const wrist = h.joints['wrist'];
  if (wrist) out.wristQuat = (out.wristQuat ?? new Quaternion()).copy(wrist.quaternion);
  if (h.ray) out.ray = h.ray;
  return out;
}

export function newCursor(id: string, hand: CursorHand): Cursor {
  return { id, hand, position: new Vector3(), tip: new Vector3(), pinching: false, justPinched: false, justReleased: false, tracked: false, canPoke: hand === 'left' || hand === 'right' };
}

const _m = new Matrix4();
/** World point → local coordinates of `parent` (the frame a moving part is expressed in). */
export function toLocal(parent: Object3D, world: Vector3, out = new Vector3()): Vector3 {
  _m.copy(parent.matrixWorld).invert();
  return out.copy(world).applyMatrix4(_m);
}
