/** Every tracked outline shares one triangle geometry and one material. */
import { BufferAttribute, BufferGeometry, Color, DoubleSide, Matrix4, Mesh, MeshBasicMaterial, Quaternion, Vector3 } from 'three';
import { THEME } from './theme';

export interface BoxState {
  id: string;
  center: Vector3;
  w: number;
  h: number;
  color: Color;
  scale: number;
  tCenter: Vector3;
  tw: number;
  th: number;
  tColor: Color;
  tScale: number;
  pulse: number;
  removing: boolean;
  facing?: Vector3;
}
const SEGMENTS = 4 * (THEME.box.cornerSteps + 1);
const VERTICES = SEGMENTS * 2;
const INDICES = SEGMENTS * 6;
const forward = new Vector3(0, 0, 1);
const worldUp = new Vector3(0, 1, 0);

export class BoxField extends Mesh<BufferGeometry, MeshBasicMaterial> {
  readonly boxes = new Map<string, BoxState>();
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly right = new Vector3(1, 0, 0);
  private readonly direction = new Vector3();
  private readonly faceUp = new Vector3();
  private readonly relative = new Vector3();
  private readonly frame = new Matrix4();
  private readonly colorScratch = new Color();
  private readonly activeColor = new Color(THEME.color.accent);
  private active: string | null = null;

  constructor(private readonly max = THEME.box.max as number) {
    const geo = new BufferGeometry();
    const pos = new Float32Array(max * VERTICES * 3);
    const col = new Float32Array(max * VERTICES * 3);
    const indices = new Uint16Array(max * INDICES);
    for (let box = 0; box < max; box++) for (let segment = 0; segment < SEGMENTS; segment++) {
      const a = box * VERTICES + segment * 2, b = box * VERTICES + (segment + 1) % SEGMENTS * 2;
      indices.set([a, b, a + 1, b, b + 1, a + 1], box * INDICES + segment * 6);
    }
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setAttribute('color', new BufferAttribute(col, 3));
    geo.setIndex(new BufferAttribute(indices, 1));
    geo.setDrawRange(0, 0);
    super(geo, new MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: THEME.opacity.line, side: DoubleSide, forceSinglePass: true, depthWrite: false, toneMapped: false }));
    this.pos = pos;
    this.col = col;
    this.frustumCulled = false;
    this.renderOrder = THEME.render.boxes;
    this.name = 'boxField';
  }
  set(id: string, center: Vector3, w: number, h: number, color: string | Color, immediate = false): BoxState | undefined {
    let b = this.boxes.get(id);
    const c = this.colorScratch.set(color);
    if (!b) {
      if (this.boxes.size >= this.max) {
        for (const old of this.boxes.values()) if (old.removing) { this.boxes.delete(old.id); break; }
        if (this.boxes.size >= this.max) return;
      }
      b = { id, center: center.clone(), w, h, color: c.clone(), scale: 1, tCenter: center.clone(), tw: w, th: h, tColor: c.clone(), tScale: 1, pulse: 0, removing: false };
      this.boxes.set(id, b);
    }
    b.tCenter.copy(center);
    b.tw = Math.max(THEME.box.minSize, w);
    b.th = Math.max(THEME.box.minSize, h);
    b.tColor.copy(c);
    b.removing = false;
    if (immediate) { b.center.copy(center); b.w = b.tw; b.h = b.th; b.color.copy(c); }
    return b;
  }
  override remove(...objects: import('three').Object3D[]): this;
  override remove(id: string): this;
  override remove(...objects: (import('three').Object3D | string)[]): this {
    if (typeof objects[0] === 'string') {
      this.boxes.delete(objects[0]);
      if (this.active === objects[0]) this.active = null;
    } else super.remove(...objects as import('three').Object3D[]);
    return this;
  }
  has(id: string): boolean { return this.boxes.has(id); }
  pulse(id: string, color: string): void { this.boxes.get(id)?.tColor.set(color); }
  setActive(id: string | null): void { this.active = id; }
  update(dt: number, head: Vector3): void {
    const mix = 1 - Math.exp(-Math.max(0, dt) / 0.06);
    let index = 0;
    for (const b of this.boxes.values()) {
      b.center.lerp(b.tCenter, mix);
      b.w += (b.tw - b.w) * mix;
      b.h += (b.th - b.h) * mix;
      b.color.lerp(b.tColor, mix);
      this.writeBox(index++, b, head);
    }
    this.geometry.setDrawRange(0, index * INDICES);
    (this.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('color') as BufferAttribute).needsUpdate = true;
  }
  setFacing(id: string, normal: [number, number, number] | undefined): void {
    const box = this.boxes.get(id);
    if (box && normal) (box.facing ??= new Vector3()).fromArray(normal).normalize();
  }
  private basis(center: Vector3, head: Vector3, normal?: Vector3): void {
    if (normal) this.direction.copy(normal); else this.direction.subVectors(head, center);
    if (this.direction.lengthSq() < 1e-6) this.direction.copy(forward);
    this.direction.normalize();
    this.right.crossVectors(worldUp, this.direction);
    if (this.right.lengthSq() < 1e-6) this.right.set(1, 0, 0);
    else this.right.normalize();
    this.faceUp.crossVectors(this.direction, this.right).normalize();
  }
  private vertex(offset: number, x: number, y: number, b: BoxState, color: Color): void {
    this.pos[offset] = b.center.x + this.right.x * x + this.faceUp.x * y;
    this.pos[offset + 1] = b.center.y + this.right.y * x + this.faceUp.y * y;
    this.pos[offset + 2] = b.center.z + this.right.z * x + this.faceUp.z * y;
    this.col[offset] = color.r;
    this.col[offset + 1] = color.g;
    this.col[offset + 2] = color.b;
  }
  private writeBox(index: number, b: BoxState, head: Vector3): void {
    this.basis(b.center, head, b.facing);
    const hw = b.w / 2, hh = b.h / 2;
    const radius = Math.min(THEME.box.corner, hw / 2, hh / 2);
    const active = b.id === this.active, halfStroke = (active ? THEME.box.activeStroke : THEME.box.stroke) / 2;
    const color = active ? this.activeColor : b.color;
    // Two offset contours give the stroke a real width on WebGL, including its rounded corners.
    for (let sample = 0; sample < SEGMENTS; sample++) {
      const corner = Math.floor(sample / (THEME.box.cornerSteps + 1));
      const part = sample % (THEME.box.cornerSteps + 1);
      const angle = (corner + part / THEME.box.cornerSteps) * Math.PI / 2;
      const cx = corner === 0 || corner === 3 ? hw - radius : -hw + radius;
      const cy = corner < 2 ? hh - radius : -hh + radius;
      for (let edge = 0; edge < 2; edge++) {
        const r = radius + (edge ? -halfStroke : halfStroke);
        this.vertex((index * VERTICES + sample * 2 + edge) * 3, cx + r * Math.cos(angle), cy + r * Math.sin(angle), b, color);
      }
    }
  }
  labelAnchor(b: BoxState, head: Vector3, out: Vector3): Vector3 {
    this.basis(b.center, head, b.facing);
    return out.copy(b.center).addScaledVector(this.right, -b.w / 2).addScaledVector(this.faceUp, b.h / 2 + THEME.box.labelGap);
  }
  facingQuaternion(head: Vector3, center: Vector3, out: Quaternion, normal?: Vector3): Quaternion {
    this.basis(center, head, normal);
    return out.setFromRotationMatrix(this.frame.makeBasis(this.right, this.faceUp, this.direction));
  }
  intersectRay(ray: { origin: Vector3; dir: Vector3 }, head: Vector3): { box: BoxState; point: Vector3 } | null {
    let nearest: BoxState | null = null, distance = THEME.control.rayDistance as number;
    for (const b of this.boxes.values()) {
      this.basis(b.center, head, b.facing);
      const denominator = ray.dir.dot(this.direction);
      if (Math.abs(denominator) < 1e-6) continue;
      const t = this.relative.subVectors(b.center, ray.origin).dot(this.direction) / denominator;
      if (t < 0 || t > distance) continue;
      this.relative.copy(ray.origin).addScaledVector(ray.dir, t).sub(b.center);
      const x = Math.abs(this.relative.dot(this.right)), y = Math.abs(this.relative.dot(this.faceUp));
      const hw = b.w / 2, hh = b.h / 2, radius = Math.min(THEME.box.corner, hw / 2, hh / 2);
      const dx = Math.max(0, x - hw + radius), dy = Math.max(0, y - hh + radius);
      if (x <= hw && y <= hh && dx * dx + dy * dy <= radius * radius) { nearest = b; distance = t; }
    }
    return nearest ? { box: nearest, point: ray.origin.clone().addScaledVector(ray.dir, distance) } : null;
  }
  nearestBorder(id: string, point: Vector3, head: Vector3, out: Vector3): Vector3 | null {
    const b = this.boxes.get(id); if (!b) return null;
    this.basis(b.center, head, b.facing);
    this.relative.subVectors(point, b.center);
    const px = this.relative.dot(this.right), py = this.relative.dot(this.faceUp);
    const x = Math.abs(px), y = Math.abs(py), hw = b.w / 2, hh = b.h / 2;
    const radius = Math.min(THEME.box.corner, hw / 2, hh / 2), cx = hw - radius, cy = hh - radius;
    let bx: number, by: number;
    if (x > cx && y > cy) {
      const length = Math.hypot(x - cx, y - cy);
      bx = cx + (x - cx) / length * radius; by = cy + (y - cy) / length * radius;
    } else {
      const topX = Math.min(x, cx), rightY = Math.min(y, cy);
      if ((topX - x) ** 2 + (hh - y) ** 2 < (hw - x) ** 2 + (rightY - y) ** 2) { bx = topX; by = hh; }
      else { bx = hw; by = rightY; }
    }
    return out.copy(b.center).addScaledVector(this.right, bx * (px < 0 ? -1 : 1)).addScaledVector(this.faceUp, by * (py < 0 ? -1 : 1));
  }
  nearest(p: Vector3, radius: number): BoxState | null {
    let result: BoxState | null = null, distance = radius;
    for (const b of this.boxes.values()) {
      const d = p.distanceTo(b.center) - Math.max(b.w, b.h) / 2;
      if (d < distance) { result = b; distance = d; }
    }
    return result;
  }
  override dispose(): void { this.geometry.dispose(); this.material.dispose(); }
}
