/**
 * BoxField: every scan box (YOLO or SAM) in ONE LineSegments draw call. Each box is a front-facing rectangle drawn
 * as four corner brackets (8 segments, 16 vertices) with a per-box vertex colour. Positions and sizes glide toward
 * their targets with a 60 ms damp so tracked boxes move smoothly; removed boxes shrink away over 250 ms.
 */
import { BufferAttribute, BufferGeometry, Color, LineBasicMaterial, LineSegments, Quaternion, Vector3 } from 'three';
import { damp } from '../../gen3d/anim';

export interface BoxState {
  id: string;
  center: Vector3;
  /** width, height of the face in metres */
  w: number;
  h: number;
  color: Color;
  /** 0..1 draw scale (0 = gone) */
  scale: number;
  // targets
  tCenter: Vector3;
  tw: number;
  th: number;
  tColor: Color;
  tScale: number;
  /** pulse 0..1 (a verdict), decays */
  pulse: number;
  removing: boolean;
}

const SEG_PER_BOX = 8;
const VERT_PER_BOX = SEG_PER_BOX * 2;

export class BoxField extends LineSegments<BufferGeometry, LineBasicMaterial> {
  readonly boxes = new Map<string, BoxState>();
  private readonly max: number;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly right = new Vector3(1, 0, 0);
  private readonly up = new Vector3(0, 1, 0);
  private readonly tmp = new Vector3();

  constructor(max = 24) {
    const geo = new BufferGeometry();
    const pos = new Float32Array(max * VERT_PER_BOX * 3);
    const col = new Float32Array(max * VERT_PER_BOX * 3);
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setAttribute('color', new BufferAttribute(col, 3));
    geo.setDrawRange(0, 0);
    super(geo, new LineBasicMaterial({ vertexColors: true, toneMapped: false }));
    this.max = max;
    this.pos = pos;
    this.col = col;
    this.frustumCulled = false;
    this.renderOrder = 10;
    this.name = 'boxField';
  }

  /** Create or retarget a box. `color` is the full brightness colour for the box's status. */
  set(id: string, center: Vector3, w: number, h: number, color: string | Color, immediate = false): BoxState {
    let b = this.boxes.get(id);
    const c = color instanceof Color ? color : new Color(color);
    if (!b) {
      if (this.boxes.size >= this.max) {
        // drop the oldest removing box, else refuse silently
        const victim = [...this.boxes.values()].find((x) => x.removing);
        if (victim) this.boxes.delete(victim.id);
        else return { id, center: center.clone(), w, h, color: c, scale: 0, tCenter: center.clone(), tw: w, th: h, tColor: c, tScale: 0, pulse: 0, removing: true };
      }
      b = { id, center: center.clone(), w: immediate ? w : w * 1.3, h: immediate ? h : h * 1.3, color: c.clone(), scale: immediate ? 1 : 0.2, tCenter: center.clone(), tw: w, th: h, tColor: c.clone(), tScale: 1, pulse: 0, removing: false };
      this.boxes.set(id, b);
      return b;
    }
    b.tCenter.copy(center);
    b.tw = w;
    b.th = h;
    b.tColor.copy(c);
    b.tScale = 1;
    b.removing = false;
    return b;
  }

  /** Shrink the box away (250 ms), then forget it. */
  remove(id: string): void {
    const b = this.boxes.get(id);
    if (!b) return;
    b.removing = true;
    b.tScale = 0;
  }

  /** A verdict on the device: a 240 ms pulse in the given colour (green = seen, red = miss). */
  pulse(id: string, color: string): void {
    const b = this.boxes.get(id);
    if (!b) return;
    b.pulse = 1;
    b.color.set(color);
  }

  has(id: string): boolean {
    const b = this.boxes.get(id);
    return !!b && !b.removing;
  }

  /** Smooth, rebuild, upload. `head` sets the facing frame (boxes always face the user, yaw only). */
  update(dt: number, head: Vector3): void {
    let i = 0;
    for (const b of [...this.boxes.values()]) {
      if (b.removing && b.scale < 0.03) {
        this.boxes.delete(b.id);
        continue;
      }
      b.center.x = damp(b.center.x, b.tCenter.x, 0.06, dt);
      b.center.y = damp(b.center.y, b.tCenter.y, 0.06, dt);
      b.center.z = damp(b.center.z, b.tCenter.z, 0.06, dt);
      b.w = damp(b.w, b.tw, 0.08, dt);
      b.h = damp(b.h, b.th, 0.08, dt);
      b.scale = damp(b.scale, b.tScale, b.removing ? 0.08 : 0.1, dt);
      b.color.lerp(b.tColor, 1 - Math.exp(-dt / 0.2));
      b.pulse = Math.max(0, b.pulse - dt / 0.24);
      if (i >= this.max) break;
      this.writeBox(i++, b, head);
    }
    this.geometry.setDrawRange(0, i * VERT_PER_BOX);
    (this.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('color') as BufferAttribute).needsUpdate = true;
  }

  private writeBox(i: number, b: BoxState, head: Vector3): void {
    // frame: right = perpendicular to the head→box direction in the floor plane, up = world up
    const dir = this.tmp.subVectors(head, b.center);
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();
    this.right.set(dir.z, 0, -dir.x);
    const s = b.scale * (1 + 0.08 * Math.sin(b.pulse * Math.PI));
    const hw = (b.w / 2) * s;
    const hh = (b.h / 2) * s;
    const arm = Math.min(0.03, Math.min(hw, hh) * 0.5);
    const base = i * VERT_PER_BOX * 3;
    let k = 0;
    const put = (x: number, y: number) => {
      const p = this.tmp.copy(b.center).addScaledVector(this.right, x).addScaledVector(this.up, y);
      this.pos[base + k * 3] = p.x;
      this.pos[base + k * 3 + 1] = p.y;
      this.pos[base + k * 3 + 2] = p.z;
      this.col[base + k * 3] = b.color.r;
      this.col[base + k * 3 + 1] = b.color.g;
      this.col[base + k * 3 + 2] = b.color.b;
      k++;
    };
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      const cx = sx * hw, cy = sy * hh;
      put(cx, cy); put(cx - sx * arm, cy); // horizontal arm
      put(cx, cy); put(cx, cy - sy * arm); // vertical arm
    }
  }

  /** World position of a box's top-left corner (for its label). */
  labelAnchor(b: BoxState, head: Vector3, out: Vector3): Vector3 {
    const dir = this.tmp.subVectors(head, b.center);
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();
    const right = new Vector3(dir.z, 0, -dir.x);
    return out.copy(b.center).addScaledVector(right, -(b.w / 2) * b.scale).addScaledVector(this.up, (b.h / 2) * b.scale + 0.012);
  }

  /** Nearest box to a world point, within `radius` of its face. */
  nearest(p: Vector3, radius: number): BoxState | null {
    let best: BoxState | null = null;
    let bestD = radius;
    for (const b of this.boxes.values()) {
      if (b.removing) continue;
      const d = p.distanceTo(b.center) - Math.max(b.w, b.h) / 2;
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  facingQuaternion(head: Vector3, center: Vector3, out: Quaternion): Quaternion {
    const dir = new Vector3().subVectors(head, center);
    dir.y = 0;
    return out.setFromUnitVectors(new Vector3(0, 0, 1), dir.lengthSq() < 1e-6 ? new Vector3(0, 0, 1) : dir.normalize());
  }
}
