/**
 * Draws Muse's XR scene (wiring/scene-runtime.ts) in the room: one fixed pool per primitive kind, additive light that
 * glows over passthrough, no depth writes. The display list arrives as one Float32Array whose regions are copied
 * straight into interleaved GPU buffers (a memcpy per kind), so a frame costs five draw calls plus a few labels and no
 * allocation. Built on the first scene, disposed when the HUD goes away; hidden whenever no scene runs.
 */
import {
  AdditiveBlending, BoxGeometry, BufferGeometry, DoubleSide, DynamicDrawUsage, Group, IcosahedronGeometry, InstancedBufferGeometry,
  InstancedInterleavedBuffer, InterleavedBuffer, InterleavedBufferAttribute, LineSegments, Mesh, Points, RingGeometry, ShaderMaterial,
  Vector3, Vector4, type Camera, type Object3D, type WebGLRenderer,
} from 'three';
import type { SceneFrameView } from '../contract';
import { SCENE_LAYOUT, SCENE_LIMITS } from '../../wiring/scene-runtime';
import { makeText, type SdfText } from './text';

const L = SCENE_LAYOUT;
const RENDER_ORDER = 85;

const POINT_VS = /* glsl */ `
attribute float aSize; attribute vec4 aColor;
uniform float uHalfH;
varying vec4 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float px = aSize * uHalfH * projectionMatrix[1][1] / max(0.05, -mv.z);
  gl_PointSize = clamp(px, 1.5, 180.0);
  vColor = vec4(aColor.rgb, aColor.a * min(1.0, px / 1.5));
}`;
const POINT_FS = /* glsl */ `
varying vec4 vColor;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0; float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  float core = exp(-r2 * 7.0), halo = (1.0 - r2) * (1.0 - r2) * 0.45;
  gl_FragColor = vec4(mix(vColor.rgb, vec3(1.0), core * 0.45), vColor.a * (core + halo));
}`;
// Orbs and blocks: a rim-lit glass look (bright edges, see-through centre) that reads as 3D over passthrough.
const SHELL_FS = /* glsl */ `
varying vec4 vColor; varying vec3 vN; varying vec3 vV;
void main() {
  float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);
  vec3 c = mix(vColor.rgb * 0.6, mix(vColor.rgb, vec3(1.0), 0.35), rim);
  gl_FragColor = vec4(c, vColor.a * (0.28 + 0.72 * rim));
}`;
const SPHERE_VS = /* glsl */ `
attribute vec4 aPosR; attribute vec4 aColor;
varying vec4 vColor; varying vec3 vN; varying vec3 vV;
void main() {
  vec4 mv = modelViewMatrix * vec4(position * aPosR.w + aPosR.xyz, 1.0);
  vN = normalize(normalMatrix * normal); vV = -mv.xyz; vColor = aColor;
  gl_Position = projectionMatrix * mv;
}`;
const BOX_VS = /* glsl */ `
attribute vec3 aPos; attribute vec3 aScale; attribute float aRot; attribute vec4 aColor;
varying vec4 vColor; varying vec3 vN; varying vec3 vV;
void main() {
  float c = cos(aRot), s = sin(aRot);
  vec3 p = position * aScale;
  p = vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z) + aPos;
  vec3 n = vec3(c * normal.x + s * normal.z, normal.y, -s * normal.x + c * normal.z);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vN = normalize(normalMatrix * n); vV = -mv.xyz; vColor = aColor;
  gl_Position = projectionMatrix * mv;
}`;
const RING_VS = /* glsl */ `
attribute vec4 aPosR; attribute float aFlat; attribute vec4 aColor;
varying vec4 vColor;
void main() {
  vec3 q = position * aPosR.w;
  if (aFlat > 0.5) q = vec3(q.x, 0.0, -q.y);
  vColor = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(q + aPosR.xyz, 1.0);
}`;
const FLAT_FS = /* glsl */ `
varying vec4 vColor;
void main() { gl_FragColor = vColor; }`;
const LINE_VS = /* glsl */ `
attribute vec4 aColor; varying vec4 vColor;
void main() { vColor = aColor; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const glow = (vertexShader: string, fragmentShader: string, uniforms: Record<string, { value: unknown }> = {}, side = DoubleSide) =>
  new ShaderMaterial({ vertexShader, fragmentShader, uniforms, transparent: true, depthWrite: false, depthTest: true, blending: AdditiveBlending, side });

/** An instanced pool whose per-instance data is one interleaved region of the display list. */
function instanced(base: BufferGeometry, stride: number, cap: number, attrs: [string, number, number][]): { geometry: InstancedBufferGeometry; buffer: InstancedInterleavedBuffer } {
  const geometry = new InstancedBufferGeometry();
  geometry.index = base.index;
  for (const name of ['position', 'normal']) { const a = base.getAttribute(name); if (a) geometry.setAttribute(name, a); }
  const buffer = new InstancedInterleavedBuffer(new Float32Array(stride * cap), stride, 1).setUsage(DynamicDrawUsage);
  for (const [name, size, offset] of attrs) geometry.setAttribute(name, new InterleavedBufferAttribute(buffer, size, offset));
  geometry.instanceCount = 0;
  return { geometry, buffer };
}

interface Pools {
  points: Points; pointBuf: InterleavedBuffer;
  spheres: Mesh; sphereBuf: InstancedInterleavedBuffer; sphereGeo: InstancedBufferGeometry;
  boxes: Mesh; boxBuf: InstancedInterleavedBuffer; boxGeo: InstancedBufferGeometry;
  rings: Mesh; ringBuf: InstancedInterleavedBuffer; ringGeo: InstancedBufferGeometry;
  lines: LineSegments; lineBuf: InterleavedBuffer;
  bases: BufferGeometry[];
  halfH: { value: number };
}

export class SceneLayer extends Group {
  private pools?: Pools;
  private readonly labels: SdfText[] = [];
  private readonly labelText: string[] = [];
  private seq = -1;
  private readonly viewport = new Vector4();
  private readonly headWorld = new Vector3();
  private lastCounts = { points: 0, spheres: 0, boxes: 0, rings: 0, lines: 0, texts: 0 };

  constructor() {
    super();
    this.name = 'muse-scene';
    this.visible = false;
  }

  private build(): Pools {
    const halfH = { value: 900 };
    // points: position, size, colour interleaved exactly as the display list stores them
    const pointGeo = new BufferGeometry();
    const pointBuf = new InterleavedBuffer(new Float32Array(L.pt.stride * L.pt.cap), L.pt.stride).setUsage(DynamicDrawUsage);
    pointGeo.setAttribute('position', new InterleavedBufferAttribute(pointBuf, 3, 0));
    pointGeo.setAttribute('aSize', new InterleavedBufferAttribute(pointBuf, 1, 3));
    pointGeo.setAttribute('aColor', new InterleavedBufferAttribute(pointBuf, 4, 4));
    pointGeo.setDrawRange(0, 0);
    const points = new Points(pointGeo, glow(POINT_VS, POINT_FS, { uHalfH: halfH }));
    // Size points by the eye being drawn: its viewport height and projection.
    points.onBeforeRender = (renderer: WebGLRenderer, _scene: unknown, camera: Camera) => {
      const vp = (camera as Camera & { viewport?: Vector4 }).viewport;
      halfH.value = (vp && vp.w > 0 ? vp.w : renderer.getCurrentViewport(this.viewport).w || renderer.domElement.height) / 2;
    };
    const sphereBase = new IcosahedronGeometry(1, 2), boxBase = new BoxGeometry(1, 1, 1), ringBase = new RingGeometry(0.9, 1, 48);
    const sp = instanced(sphereBase, L.sp.stride, L.sp.cap, [['aPosR', 4, 0], ['aColor', 4, 4]]);
    const bx = instanced(boxBase, L.bx.stride, L.bx.cap, [['aPos', 3, 0], ['aScale', 3, 3], ['aRot', 1, 6], ['aColor', 4, 7]]);
    const rg = instanced(ringBase, L.rg.stride, L.rg.cap, [['aPosR', 4, 0], ['aFlat', 1, 4], ['aColor', 4, 5]]);
    const spheres = new Mesh(sp.geometry, glow(SPHERE_VS, SHELL_FS));
    const boxes = new Mesh(bx.geometry, glow(BOX_VS, SHELL_FS));
    const rings = new Mesh(rg.geometry, glow(RING_VS, FLAT_FS));
    const lineGeo = new BufferGeometry();
    const lineBuf = new InterleavedBuffer(new Float32Array(L.ln.stride * L.ln.cap), 7).setUsage(DynamicDrawUsage);
    lineGeo.setAttribute('position', new InterleavedBufferAttribute(lineBuf, 3, 0));
    lineGeo.setAttribute('aColor', new InterleavedBufferAttribute(lineBuf, 4, 3));
    lineGeo.setDrawRange(0, 0);
    const lines = new LineSegments(lineGeo, glow(LINE_VS, FLAT_FS));
    for (const o of [points, spheres, boxes, rings, lines] as Object3D[]) {
      o.frustumCulled = false; o.renderOrder = RENDER_ORDER; o.raycast = () => {};
      this.add(o);
    }
    return { points, pointBuf, spheres, sphereBuf: sp.buffer, sphereGeo: sp.geometry, boxes, boxBuf: bx.buffer, boxGeo: bx.geometry,
      rings, ringBuf: rg.buffer, ringGeo: rg.geometry, lines, lineBuf, bases: [sphereBase, boxBase, ringBase], halfH };
  }

  /** Each frame: show the latest display list (only re-uploads when the sandbox returned a new one). */
  update(view: SceneFrameView | null | undefined, head: Vector3): void {
    const on = !!view?.active && view.placed && !!view.data;
    if (!on) {
      if (this.visible) { this.visible = false; this.seq = -1; for (const l of this.labels) l.visible = false; }
      return;
    }
    const v = view!;
    this.position.set(v.anchor[0], v.anchor[1], v.anchor[2]);
    this.rotation.set(0, v.yaw, 0);
    this.visible = true;
    // labels turn to the wearer
    this.updateMatrixWorld();
    this.headWorld.copy(head);
    for (const l of this.labels) if (l.visible) l.lookAt(this.headWorld);
    if (v.seq === this.seq) return;
    this.seq = v.seq;
    const p = this.pools ??= this.build();
    const data = v.data!, c = v.counts;
    const copy = (buf: InterleavedBuffer, off: number, count: number, stride: number) => {
      const n = count * stride;
      if (n > 0) {
        (buf.array as Float32Array).set(data.subarray(off, off + n));
        buf.clearUpdateRanges(); buf.addUpdateRange(0, n); buf.needsUpdate = true;
      }
    };
    copy(p.pointBuf, L.pt.off, c.points, L.pt.stride); p.points.geometry.setDrawRange(0, c.points);
    copy(p.sphereBuf, L.sp.off, c.spheres, L.sp.stride); p.sphereGeo.instanceCount = c.spheres; p.spheres.visible = c.spheres > 0;
    copy(p.boxBuf, L.bx.off, c.boxes, L.bx.stride); p.boxGeo.instanceCount = c.boxes; p.boxes.visible = c.boxes > 0;
    copy(p.ringBuf, L.rg.off, c.rings, L.rg.stride); p.ringGeo.instanceCount = c.rings; p.rings.visible = c.rings > 0;
    copy(p.lineBuf, L.ln.off, c.lines, L.ln.stride); p.lines.geometry.setDrawRange(0, c.lines * 2);
    this.updateLabels(v.texts);
    this.lastCounts = { ...c, texts: v.texts.length };
  }

  private updateLabels(texts: SceneFrameView['texts']): void {
    for (let i = 0; i < SCENE_LIMITS.texts; i++) {
      const t = texts[i];
      let label = this.labels[i];
      if (!t) { if (label) label.visible = false; continue; }
      if (!label) {
        label = makeText({ text: '', size: 0.02, anchorX: 'center', anchorY: 'middle', singleLine: true });
        label.renderOrder = RENDER_ORDER + 1; label.raycast = () => {};
        this.labels[i] = label; this.labelText[i] = ''; this.add(label);
      }
      label.visible = true;
      label.position.set(t.x, t.y, t.z);
      const key = `${t.text}|${t.color}|${t.size}`;
      if (this.labelText[i] !== key) {
        this.labelText[i] = key;
        label.text = t.text; label.color = t.color; label.fontSize = t.size;
        label.sync();
      }
    }
  }

  /** For tests and the e2e check: what is drawn and where the first few points are (scene metres). */
  snapshot(): { visible: boolean; counts: SceneLayer['lastCounts']; firstPoints: number[]; anchor: number[] } | undefined {
    if (!this.visible || !this.pools) return undefined;
    const a = this.pools.pointBuf.array as Float32Array, first: number[] = [];
    for (let i = 0; i < Math.min(4, this.lastCounts.points); i++) first.push(a[i * 8]!, a[i * 8 + 1]!, a[i * 8 + 2]!);
    return { visible: this.visible, counts: this.lastCounts, firstPoints: first, anchor: this.position.toArray() };
  }

  override dispose(): void {
    const p = this.pools;
    if (p) {
      for (const o of [p.points, p.spheres, p.boxes, p.rings, p.lines]) { o.geometry.dispose(); (o.material as ShaderMaterial).dispose(); }
      for (const b of p.bases) b.dispose();
    }
    for (const l of this.labels) l.dispose();
    this.pools = undefined; this.labels.length = 0;
    this.removeFromParent();
  }
}
