/** Every tracked rectangle shares one line geometry and one material. */
import { BufferAttribute, BufferGeometry, Color, LineBasicMaterial, LineSegments, Matrix4, Quaternion, Vector3 } from 'three';
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
const forward = new Vector3(0, 0, 1);
const worldUp = new Vector3(0, 1, 0);

export class BoxField extends LineSegments<BufferGeometry, LineBasicMaterial> {
  readonly boxes = new Map<string, BoxState>();
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly right = new Vector3(1, 0, 0);
  private readonly direction = new Vector3();
  private readonly faceUp = new Vector3();
  private readonly frame = new Matrix4();
  private readonly colorScratch = new Color();

  constructor(private readonly max = THEME.box.max as number) {
    const geo = new BufferGeometry();
    const pos = new Float32Array(max * VERTICES * 3);
    const col = new Float32Array(max * VERTICES * 3);
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setAttribute('color', new BufferAttribute(col, 3));
    geo.setDrawRange(0, 0);
    super(geo, new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: THEME.opacity.line, depthWrite: false, toneMapped: false }));
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
    if (typeof objects[0] === 'string') this.boxes.delete(objects[0]);
    else super.remove(...objects as import('three').Object3D[]);
    return this;
  }
  has(id: string): boolean { return this.boxes.has(id); }
  pulse(id: string, color: string): void { this.boxes.get(id)?.tColor.set(color); }
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
    this.geometry.setDrawRange(0, index * VERTICES);
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
  private vertex(offset: number, x: number, y: number, b: BoxState): void {
    this.pos[offset] = b.center.x + this.right.x * x + this.faceUp.x * y;
    this.pos[offset + 1] = b.center.y + this.right.y * x + this.faceUp.y * y;
    this.pos[offset + 2] = b.center.z + this.right.z * x + this.faceUp.z * y;
    this.col[offset] = b.color.r;
    this.col[offset + 1] = b.color.g;
    this.col[offset + 2] = b.color.b;
  }
  private writeBox(index: number, b: BoxState, head: Vector3): void {
    this.basis(b.center, head, b.facing);
    const hw = b.w / 2, hh = b.h / 2;
    const radius = Math.min(THEME.box.corner, hw / 2, hh / 2);
    const count = SEGMENTS;
    // Rounded corners are joined by full sides; never separate decorative corner marks.
    for (let i = 0; i < count; i++) {
      const next = (i + 1) % count;
      for (let endpoint = 0; endpoint < 2; endpoint++) {
        const sample = endpoint ? next : i;
        const corner = Math.floor(sample / (THEME.box.cornerSteps + 1));
        const part = sample % (THEME.box.cornerSteps + 1);
        const angle = (corner + part / THEME.box.cornerSteps) * Math.PI / 2;
        const cx = corner === 0 || corner === 3 ? hw - radius : -hw + radius;
        const cy = corner < 2 ? hh - radius : -hh + radius;
        this.vertex((index * VERTICES + i * 2 + endpoint) * 3, cx + radius * Math.cos(angle), cy + radius * Math.sin(angle), b);
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
