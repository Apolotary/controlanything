/** Every tracked outline shares one triangle geometry and one material. */
import { BufferAttribute, BufferGeometry, Color, DoubleSide, Matrix4, Mesh, MeshBasicMaterial, Quaternion, ShaderMaterial, Vector3 } from 'three';
import type { Object3D } from 'three';
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
  opacity: number;
  facing?: Vector3;
}
export type BoxRay = { origin: Vector3 } & ({ direction: Vector3 } | { dir: Vector3 });
export interface BoxHit { box: BoxState; point: Vector3; distance: number }
interface LabelLayout { anchor: Vector3; left: number; right: number; bottom: number; top: number; depth: number }
const SEGMENTS = 4 * (THEME.box.cornerSteps + 1);
const VERTICES = SEGMENTS * 2;
const INDICES = SEGMENTS * 6;
const forward = new Vector3(0, 0, 1);
const worldUp = new Vector3(0, 1, 0);

export class BoxField extends Mesh<BufferGeometry, MeshBasicMaterial> {
  readonly boxes = new Map<string, BoxState>();
  private pos: Float32Array;
  private col: Float32Array;
  private alpha: Float32Array;
  private readonly right = new Vector3(1, 0, 0);
  private readonly direction = new Vector3();
  private readonly faceUp = new Vector3();
  private readonly relative = new Vector3();
  private readonly frame = new Matrix4();
  private readonly colorScratch = new Color();
  private readonly activeColor = new Color(THEME.color.accent);
  private active: string | null = null;
  private hovered: string | null = null;
  private selected: string | null = null;
  private readonly lastHead = new Vector3();
  private readonly labelHead = new Vector3();
  private readonly viewDirection = new Vector3();
  private readonly viewRight = new Vector3();
  private readonly viewUp = new Vector3();
  private readonly labelLayouts = new Map<string, LabelLayout>();
  private readonly labelGroups = new Map<string, Object3D>();
  private readonly fadedSurfaces = new WeakSet<Object3D>();
  private labelsDirty = true;
  private renderedBoxes = 0;
  private limit = Infinity;
  private capacity: number;
  private readonly placedLabels: LabelLayout[] = [];

  constructor(max = THEME.box.max as number) {
    const geo = new BufferGeometry();
    const pos = new Float32Array(max * VERTICES * 3);
    const col = new Float32Array(max * VERTICES * 3);
    const alpha = new Float32Array(max * VERTICES);
    const indices = new Uint16Array(max * INDICES);
    for (let box = 0; box < max; box++) for (let segment = 0; segment < SEGMENTS; segment++) {
      const a = box * VERTICES + segment * 2, b = box * VERTICES + (segment + 1) % SEGMENTS * 2;
      indices.set([a, b, a + 1, b, b + 1, a + 1], box * INDICES + segment * 6);
    }
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setAttribute('color', new BufferAttribute(col, 3));
    geo.setAttribute('boxOpacity', new BufferAttribute(alpha, 1));
    geo.setIndex(new BufferAttribute(indices, 1));
    geo.setDrawRange(0, 0);
    super(geo, new MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: THEME.opacity.line, side: DoubleSide, forceSinglePass: true, depthWrite: false, toneMapped: false }));
    this.pos = pos;
    this.col = col;
    this.alpha = alpha;
    this.capacity = max;
    this.material.onBeforeCompile = (shader) => {
      shader.vertexShader = 'attribute float boxOpacity; varying float vBoxOpacity;\n' + shader.vertexShader.replace('#include <color_vertex>', '#include <color_vertex>\nvBoxOpacity = boxOpacity;');
      shader.fragmentShader = 'varying float vBoxOpacity;\n' + shader.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vBoxOpacity;');
    };
    this.material.customProgramCacheKey = () => 'ce-box-opacity';
    this.frustumCulled = false;
    this.renderOrder = THEME.render.boxes;
    this.name = 'boxField';
  }
  set(id: string, center: Vector3, w: number, h: number, color: string | Color, immediate = false): BoxState | undefined {
    let b = this.boxes.get(id);
    const c = this.colorScratch.set(color);
    if (!b) {
      if (this.boxes.size >= this.limit) {
        for (const old of this.boxes.values()) if (old.removing) { this.remove(old.id); break; }
        if (this.boxes.size >= this.limit) return;
      }
      if (this.boxes.size >= this.capacity) this.grow();
      b = { id, center: center.clone(), w, h, color: c.clone(), scale: 1, tCenter: center.clone(), tw: w, th: h, tColor: c.clone(), tScale: 1, pulse: 0, removing: false, opacity: 1 };
      this.boxes.set(id, b);
    }
    b.tCenter.copy(center);
    b.tw = Math.max(THEME.box.minSize, w);
    b.th = Math.max(THEME.box.minSize, h);
    b.tColor.copy(c);
    b.removing = false;
    this.labelsDirty = true;
    if (immediate) { b.center.copy(center); b.w = b.tw; b.h = b.th; b.color.copy(c); }
    return b;
  }
  private grow(): void {
    this.capacity *= 2;
    this.pos = new Float32Array(this.capacity * VERTICES * 3);
    this.col = new Float32Array(this.capacity * VERTICES * 3);
    this.alpha = new Float32Array(this.capacity * VERTICES);
    const indices = new Uint32Array(this.capacity * INDICES);
    for (let box = 0; box < this.capacity; box++) for (let segment = 0; segment < SEGMENTS; segment++) {
      const a = box * VERTICES + segment * 2, b = box * VERTICES + (segment + 1) % SEGMENTS * 2;
      indices.set([a, b, a + 1, b, b + 1, a + 1], box * INDICES + segment * 6);
    }
    // Release replaced GPU buffers while retaining the public geometry object.
    this.geometry.dispose();
    this.geometry.setAttribute('position', new BufferAttribute(this.pos, 3));
    this.geometry.setAttribute('color', new BufferAttribute(this.col, 3));
    this.geometry.setAttribute('boxOpacity', new BufferAttribute(this.alpha, 1));
    this.geometry.setIndex(new BufferAttribute(indices, 1));
  }
  override remove(...objects: import('three').Object3D[]): this;
  override remove(id: string): this;
  override remove(...objects: (import('three').Object3D | string)[]): this {
    if (typeof objects[0] === 'string') {
      const label = this.labelGroup(objects[0]); if (label) label.visible = false;
      this.boxes.delete(objects[0]);
      this.labelLayouts.delete(objects[0]);
      this.labelGroups.delete(objects[0]);
      this.labelsDirty = true;
      if (this.active === objects[0]) this.active = null;
      if (this.hovered === objects[0]) this.hovered = null;
      if (this.selected === objects[0]) this.selected = null;
      if (!this.boxes.size) this.setDrawCount(0);
    } else super.remove(...objects as import('three').Object3D[]);
    return this;
  }
  has(id: string): boolean { return this.boxes.has(id); }
  /** A scanning policy can explicitly cap observations without limiting persisted tags by default. */
  setLimit(limit: number): void {
    this.limit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : Infinity;
    const overflow = this.boxes.size - this.limit;
    if (overflow <= 0) return;
    const priority = (box: BoxState) => Number(box.id === this.selected) * 4 + Number(box.id === this.active) * 2 + Number(box.id === this.hovered);
    const removable = [...this.boxes.values()].sort((a, b) => priority(a) - priority(b));
    for (let i = 0; i < overflow; i++) this.remove(removable[i].id);
    this.update(0, this.lastHead);
  }
  pulse(id: string, color: string): void { this.boxes.get(id)?.tColor.set(color); }
  setActive(id: string | null): void { this.active = id; }
  setHovered(id: string | null): void { this.hovered = id; }
  setSelected(id: string | null): void { this.selected = id; }
  setOpacity(id: string, opacity: number): void {
    const box = this.boxes.get(id);
    if (box) box.opacity = Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 0;
  }
  update(dt: number, head: Vector3): void {
    this.lastHead.copy(head);
    this.labelsDirty = true;
    const mix = 1 - Math.exp(-Math.max(0, dt) / 0.06);
    let index = 0;
    for (const b of this.boxes.values()) {
      b.center.lerp(b.tCenter, mix);
      b.w += (b.tw - b.w) * mix;
      b.h += (b.th - b.h) * mix;
      b.color.lerp(b.tColor, mix);
      this.writeBox(index++, b, head);
    }
    this.setDrawCount(index);
    (this.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('color') as BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('boxOpacity') as BufferAttribute).needsUpdate = true;
  }
  private setDrawCount(count: number): void {
    if (count < this.renderedBoxes) {
      this.pos.fill(0, count * VERTICES * 3, this.renderedBoxes * VERTICES * 3);
      this.col.fill(0, count * VERTICES * 3, this.renderedBoxes * VERTICES * 3);
      this.alpha.fill(0, count * VERTICES, this.renderedBoxes * VERTICES);
      (this.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
      (this.geometry.getAttribute('color') as BufferAttribute).needsUpdate = true;
      (this.geometry.getAttribute('boxOpacity') as BufferAttribute).needsUpdate = true;
    }
    this.renderedBoxes = count;
    this.geometry.setDrawRange(0, count * INDICES);
  }
  setFacing(id: string, normal: [number, number, number] | undefined): void {
    const box = this.boxes.get(id);
    if (box && normal) (box.facing ??= new Vector3()).fromArray(normal).normalize();
    this.labelsDirty = true;
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
    this.alpha[offset / 3] = b.opacity;
  }
  private writeBox(index: number, b: BoxState, head: Vector3): void {
    this.basis(b.center, head, b.facing);
    const hw = b.w / 2, hh = b.h / 2;
    const radius = Math.min(THEME.box.corner, hw / 2, hh / 2);
    const active = b.id === this.active || b.id === this.hovered || b.id === this.selected;
    const halfStroke = (active ? THEME.box.activeStroke : THEME.box.stroke) * this.labelScale(b, head) / 2;
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
    if (this.labelsDirty || !head.equals(this.labelHead)) this.layoutLabels(head);
    this.syncLabel(b, head);
    return out.copy(this.labelLayouts.get(b.id)?.anchor ?? b.center);
  }
  /** Keep the same angular text size from one to three metres. */
  labelScale(b: BoxState, head: Vector3 = this.lastHead): number { return Math.max(1, Math.min(3, b.center.distanceTo(head))); }
  private labelGroup(id: string): Object3D | undefined {
    const existing = this.labelGroups.get(id);
    if (existing && existing.parent === this.parent) return existing;
    const label = this.parent?.getObjectByName(`target-label:${id}`);
    if (label) this.labelGroups.set(id, label);
    return label;
  }
  private layoutLabels(head: Vector3): void {
    this.labelHead.copy(head); this.labelsDirty = false;
    this.viewDirection.set(0, 0, 0);
    for (const b of this.boxes.values()) this.viewDirection.add(this.relative.subVectors(b.center, head).normalize());
    if (this.viewDirection.lengthSq() < 1e-6) this.viewDirection.set(0, 0, -1);
    this.viewDirection.normalize();
    this.viewRight.crossVectors(this.viewDirection, worldUp).normalize();
    if (this.viewRight.lengthSq() < 1e-6) this.viewRight.set(1, 0, 0);
    this.viewUp.crossVectors(this.viewRight, this.viewDirection).normalize();
    const placed = this.placedLabels; placed.length = 0;
    for (const b of this.boxes.values()) {
      let layout = this.labelLayouts.get(b.id);
      if (!layout) { layout = { anchor: new Vector3(), left: 0, right: 0, bottom: 0, top: 0, depth: 0 }; this.labelLayouts.set(b.id, layout); }
      const scale = this.labelScale(b, head);
      let pill: Object3D | undefined;
      const label = this.labelGroup(b.id);
      if (label) for (const child of label.children) if (child instanceof Mesh && child.material instanceof ShaderMaterial) { pill = child; break; }
      const width = (pill?.scale.x ?? (22 * THEME.font.label * 0.56 + THEME.box.labelPadding * 3)) * scale;
      const height = (THEME.box.labelHeight + 0.006) * scale;
      this.basis(b.center, head, b.facing);
      layout.anchor.copy(b.center).addScaledVector(this.right, -b.w / 2).addScaledVector(this.faceUp, b.h / 2 + THEME.box.labelGap * scale);
      this.labelBounds(layout, width, height, head);
      // Stable insertion order keeps the same label in its row as detections move slightly.
      for (let pass = 0; pass < placed.length; pass++) {
        let shift = 0;
        for (const other of placed) if (layout.left < other.right && layout.right > other.left && layout.bottom < other.top && layout.top > other.bottom) shift = Math.max(shift, other.top - layout.bottom + 0.004);
        if (!shift) break;
        layout.anchor.addScaledVector(this.viewUp, shift * layout.depth);
        this.labelBounds(layout, width, height, head);
      }
      placed.push(layout);
    }
  }
  private labelBounds(layout: LabelLayout, width: number, height: number, head: Vector3): void {
    layout.left = layout.bottom = Infinity; layout.right = layout.top = -Infinity; layout.depth = 0;
    for (let corner = 0; corner < 4; corner++) {
      const x = corner < 2 ? 0 : width, y = corner % 2 ? height / 2 : -height / 2;
      this.relative.copy(layout.anchor).addScaledVector(this.right, x).addScaledVector(this.faceUp, y).sub(head);
      const depth = Math.max(0.05, this.relative.dot(this.viewDirection));
      const px = this.relative.dot(this.viewRight) / depth, py = this.relative.dot(this.viewUp) / depth;
      layout.left = Math.min(layout.left, px); layout.right = Math.max(layout.right, px);
      layout.bottom = Math.min(layout.bottom, py); layout.top = Math.max(layout.top, py);
      layout.depth = Math.max(layout.depth, depth);
    }
  }
  private syncLabel(b: BoxState, head: Vector3): void {
    const label = this.labelGroup(b.id); if (!label) return;
    label.scale.setScalar(this.labelScale(b, head));
    label.visible = b.opacity > 0.001;
    for (const child of label.children) {
      if ('fillOpacity' in child) child.fillOpacity = b.opacity;
      if (!(child instanceof Mesh) || !(child.material instanceof ShaderMaterial) || this.fadedSurfaces.has(child)) continue;
      const material = child.material, fill = material.uniforms.fillAlpha, edge = material.uniforms.edgeAlpha;
      if (!fill || !edge) continue;
      this.fadedSurfaces.add(child);
      const before = child.onBeforeRender, after = child.onAfterRender;
      let fillAlpha = 0, edgeAlpha = 0;
      child.onBeforeRender = (...args) => {
        before.apply(child, args); fillAlpha = fill.value; edgeAlpha = edge.value;
        fill.value *= b.opacity; edge.value *= b.opacity; material.uniformsNeedUpdate = true;
      };
      child.onAfterRender = (...args) => {
        fill.value = fillAlpha; edge.value = edgeAlpha; material.uniformsNeedUpdate = true;
        after.apply(child, args);
      };
    }
  }
  facingQuaternion(head: Vector3, center: Vector3, out: Quaternion, normal?: Vector3): Quaternion {
    this.basis(center, head, normal);
    return out.setFromRotationMatrix(this.frame.makeBasis(this.right, this.faceUp, this.direction));
  }
  hitTest(ray: BoxRay, head: Vector3 = this.lastHead, out?: BoxHit): BoxHit | null {
    const direction = 'direction' in ray ? ray.direction : ray.dir;
    const rayLength = direction.length();
    if (!Number.isFinite(rayLength) || rayLength < 1e-6) return null;
    let nearest: BoxState | null = null, distance = THEME.control.rayDistance as number;
    for (const b of this.boxes.values()) {
      if (b.opacity <= 0.001) continue;
      this.basis(b.center, head, b.facing);
      const denominator = direction.dot(this.direction);
      if (Math.abs(denominator) < 1e-6) continue;
      const t = this.relative.subVectors(b.center, ray.origin).dot(this.direction) / denominator;
      if (t < 0 || t * rayLength > distance) continue;
      this.relative.copy(ray.origin).addScaledVector(direction, t).sub(b.center);
      if (this.containsLocal(b)) { nearest = b; distance = t * rayLength; }
    }
    if (!nearest) return null;
    const result = out ?? { box: nearest, point: new Vector3(), distance };
    result.box = nearest; result.distance = distance; result.point.copy(ray.origin).addScaledVector(direction, distance / rayLength);
    return result;
  }
  intersectRay(ray: BoxRay, head: Vector3 = this.lastHead, out?: BoxHit): BoxHit | null { return this.hitTest(ray, head, out); }
  hitTestPoint(point: Vector3, head: Vector3 = this.lastHead, tolerance: number = THEME.control.near): BoxHit | null {
    let nearest: BoxState | null = null, distance = Math.max(0, tolerance);
    const projected = new Vector3();
    for (const b of this.boxes.values()) {
      if (b.opacity <= 0.001) continue;
      this.basis(b.center, head, b.facing);
      this.relative.subVectors(point, b.center);
      const planeDistance = this.relative.dot(this.direction);
      if (Math.abs(planeDistance) <= distance && this.containsLocal(b)) {
        nearest = b; distance = Math.abs(planeDistance);
        projected.copy(point).addScaledVector(this.direction, -planeDistance);
      }
    }
    return nearest ? { box: nearest, point: projected, distance } : null;
  }
  private containsLocal(b: BoxState): boolean {
    const x = Math.abs(this.relative.dot(this.right)), y = Math.abs(this.relative.dot(this.faceUp));
    const hw = b.w / 2, hh = b.h / 2, radius = Math.min(THEME.box.corner, hw / 2, hh / 2);
    const dx = Math.max(0, x - hw + radius), dy = Math.max(0, y - hh + radius);
    return x <= hw && y <= hh && dx * dx + dy * dy <= radius * radius;
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
