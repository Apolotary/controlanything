/**
 * Where the buddy may float: never in front of (or beside, within a margin) the selected device's card, setup ring
 * or dials, as the user sees them.
 *
 * Keep-out boxes come from the visible meshes of a few named HUD groups (world AABBs, visible children only). Both
 * they and the buddy's footprint (mascot + bubble + quest card, in its own head-facing frame) are turned into
 * angular rectangles in the user's view (azimuth/elevation from the head), and a spot is valid when the gap between
 * them is ≥ 8°. Candidates sit at desk height around the user (both sides, two distances, three heights, quest card
 * on either side of the mascot, or tucked away while a device is being played); the valid one closest to the
 * default spot (right of centre, 55 cm, 20 cm below the eyes) wins, else the one with the most clearance.
 * It runs a few times per second, never per frame, and allocates nothing after construction.
 */
import { Box3, type InstancedMesh, type Mesh, type Object3D, Quaternion, type Scene, Vector3 } from 'three';

export type CardSide = 'left' | 'right' | 'tucked';

/** HUD groups the buddy must keep clear of (the selected device's UI). */
export const KEEP_OUT_NAMES = ['device-card', 'device-card-v3', 'spatial-controls', 'setup-ring', 'confirmation-panel', 'visual-synth-selection'] as const;
/** a new spot keeps this much empty view around the device UI */
export const CLEAR_DEG = 8;
/** an existing spot is only abandoned when it gets this close (hysteresis against head-motion parallax) */
export const MOVE_DEG = 3;
const RAD = Math.PI / 180;

/** The buddy's footprint in its own frame (+x = the user's right, +z = toward the user), metres. */
export function footprint(side: CardSide, out: Box3): Box3 {
  // mascot ±0.1 · bubble above (up to 3 lines, offset toward the card) · quest card 34 cm on one side
  if (side === 'left') out.min.set(-0.46, -0.1, -0.08), out.max.set(0.1, 0.22, 0.08);
  else if (side === 'right') out.min.set(-0.1, -0.1, -0.08), out.max.set(0.46, 0.22, 0.08);
  else out.min.set(-0.17, -0.1, -0.08), out.max.set(0.17, 0.22, 0.08);
  return out;
}

interface Rect { a0: number; a1: number; e0: number; e1: number }
const rect = (): Rect => ({ a0: 0, a1: 0, e0: 0, e1: 0 });

/** Angular gap between two view rectangles, radians (0 when they overlap). */
export function rectGap(r: Rect, s: Rect): number {
  const da = Math.max(0, r.a0 - s.a1, s.a0 - r.a1);
  const de = Math.max(0, r.e0 - s.e1, s.e0 - r.e1);
  return Math.hypot(da, de);
}

const LATERAL = [0.15, -0.15, 0.3, -0.3, 0.45, -0.45, 0.6, -0.6];
const DIST = [0.55, 0.45];
const HEIGHT = [-0.2, -0.32, -0.08];
const SIDES: CardSide[] = ['left', 'right', 'tucked'];

export interface Placement {
  position: Vector3;
  side: CardSide;
  /** smallest view gap to any keep-out box, degrees (Infinity without any) */
  clearanceDeg: number;
}

export class BuddyPlacer {
  readonly boxes: Box3[] = Array.from({ length: 8 }, () => new Box3());
  private readonly rects: Rect[] = Array.from({ length: 8 }, rect);
  count = 0;
  private readonly fpRect = rect();
  private readonly meshBox = new Box3();
  private readonly fp = new Box3();
  private readonly corner = new Vector3();
  private readonly v = new Vector3();
  private readonly fwd = new Vector3();
  private readonly right = new Vector3();
  private readonly head = new Vector3();
  private readonly cand = new Vector3();
  private readonly q = new Quaternion();
  private readonly up = new Vector3(0, 1, 0);
  private readonly cache = new Map<string, Object3D | null>();
  private cacheAt = -Infinity;
  readonly best: Placement = { position: new Vector3(), side: 'left', clearanceDeg: Infinity };

  /** Refresh the keep-out boxes from the scene (visible meshes of the named HUD groups only). */
  collect(scene: Scene, now: number): number {
    if (now - this.cacheAt > 2) {
      this.cacheAt = now;
      for (const name of KEEP_OUT_NAMES) this.cache.set(name, scene.getObjectByName(name) ?? null);
    }
    this.count = 0;
    for (const name of KEEP_OUT_NAMES) {
      const o = this.cache.get(name);
      if (!o || !shown(o) || this.count >= this.boxes.length) continue;
      const box = this.boxes[this.count].makeEmpty();
      this.expandVisible(o, box);
      if (box.isEmpty()) continue;
      const size = box.max.x - box.min.x + box.max.y - box.min.y + box.max.z - box.min.z;
      if (!Number.isFinite(size) || size > 6) continue; // a stray huge mesh would push the buddy away forever
      this.count++;
    }
    return this.count;
  }

  private expandVisible(o: Object3D, box: Box3): void {
    if (!o.visible) return;
    const m = o as Mesh;
    if (m.isMesh && m.geometry) {
      const inst = (o as InstancedMesh).isInstancedMesh ? (o as InstancedMesh) : null;
      let local: Box3 | null;
      if (inst) {
        if (!inst.boundingBox) inst.computeBoundingBox();
        local = inst.boundingBox;
      } else {
        if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
        local = m.geometry.boundingBox;
      }
      if (local && !local.isEmpty()) {
        o.updateWorldMatrix(true, false);
        box.union(this.meshBox.copy(local).applyMatrix4(o.matrixWorld));
      }
    }
    for (const c of o.children) this.expandVisible(c, box);
  }

  /** Set the viewpoint (head position + its yaw) for the angular tests. */
  private view(headPos: Vector3, headQuat: Quaternion): void {
    this.head.copy(headPos);
    this.fwd.set(0, 0, -1).applyQuaternion(headQuat);
    this.fwd.y = 0;
    if (this.fwd.lengthSq() < 1e-6) this.fwd.set(0, 0, -1);
    this.fwd.normalize();
    this.right.set(-this.fwd.z, 0, this.fwd.x);
    for (let i = 0; i < this.count; i++) this.toRect(this.boxes[i], this.rects[i]);
  }

  private toRect(b: Box3, out: Rect): Rect {
    out.a0 = out.e0 = Infinity;
    out.a1 = out.e1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      this.v.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).sub(this.head);
      const z = Math.max(0.05, this.v.dot(this.fwd));
      const x = this.v.dot(this.right);
      const a = Math.atan2(x, z);
      const e = Math.atan2(this.v.y, Math.hypot(x, z));
      out.a0 = Math.min(out.a0, a); out.a1 = Math.max(out.a1, a);
      out.e0 = Math.min(out.e0, e); out.e1 = Math.max(out.e1, e);
    }
    return out;
  }

  /** View rectangle of the buddy's footprint at `pos` (facing the head), with the card on `side`. */
  private footprintRect(pos: Vector3, side: CardSide): Rect {
    const yaw = Math.atan2(this.head.x - pos.x, this.head.z - pos.z);
    this.q.setFromAxisAngle(this.up, yaw);
    footprint(side, this.fp);
    const r = this.fpRect;
    r.a0 = r.e0 = Infinity;
    r.a1 = r.e1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      this.corner.set(i & 1 ? this.fp.max.x : this.fp.min.x, i & 2 ? this.fp.max.y : this.fp.min.y, i & 4 ? this.fp.max.z : this.fp.min.z);
      this.v.copy(this.corner.applyQuaternion(this.q).add(pos)).sub(this.head);
      const z = Math.max(0.05, this.v.dot(this.fwd));
      const x = this.v.dot(this.right);
      const a = Math.atan2(x, z);
      const e = Math.atan2(this.v.y, Math.hypot(x, z));
      r.a0 = Math.min(r.a0, a); r.a1 = Math.max(r.a1, a);
      r.e0 = Math.min(r.e0, e); r.e1 = Math.max(r.e1, e);
    }
    return r;
  }

  private gapDeg(pos: Vector3, side: CardSide): number {
    if (!this.count) return Infinity;
    const fr = this.footprintRect(pos, side);
    let min = Infinity;
    for (let i = 0; i < this.count; i++) min = Math.min(min, rectGap(fr, this.rects[i]));
    return min / RAD;
  }

  /** View gap (degrees) between the buddy at `pos` and the device UI, seen from the head now. */
  clearanceAt(pos: Vector3, side: CardSide, headPos: Vector3, headQuat: Quaternion): number {
    this.view(headPos, headQuat);
    return this.gapDeg(pos, side);
  }

  /** The best spot around the user right now (written into `this.best`). */
  choose(headPos: Vector3, headQuat: Quaternion): Placement {
    this.view(headPos, headQuat);
    let bestCost = Infinity;
    let fallback = -1;
    const b = this.best;
    for (const d of DIST) for (const h of HEIGHT) for (const x of LATERAL) for (const side of SIDES) {
      if (!this.count && side === 'tucked') continue;
      this.cand.copy(headPos).addScaledVector(this.fwd, d).addScaledVector(this.right, x);
      this.cand.y += h;
      const clear = this.gapDeg(this.cand, side);
      // the quest card goes on the side facing the middle of the view by default; tucking it away is the last resort
      const inward: CardSide = x >= 0 ? 'left' : 'right';
      // …and a spot that pushes part of the buddy past ±40° (out of comfortable view) pays for it
      const fr = this.footprintRect(this.cand, side);
      const out = Math.max(0, fr.a1 - 40 * RAD) + Math.max(0, -40 * RAD - fr.a0);
      const cost = Math.abs(x - 0.15) + Math.abs(d - 0.55) * 0.5 + Math.abs(h + 0.2) * 0.8 + (side === inward ? 0 : side === 'tucked' ? 0.35 : 0.1) + out * 2;
      if (clear >= CLEAR_DEG) {
        if (cost < bestCost) {
          bestCost = cost;
          b.position.copy(this.cand); b.side = side; b.clearanceDeg = clear;
        }
      } else if (bestCost === Infinity && clear > fallback) {
        fallback = clear;
        b.position.copy(this.cand); b.side = side; b.clearanceDeg = clear;
      }
    }
    return b;
  }
}

function shown(o: Object3D): boolean {
  for (let p: Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}
