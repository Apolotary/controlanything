/**
 * Paths: neon tubes with a void keyline underneath (two passes, so the stroke survives light and dark walls),
 * dash patterns in the shader, IR cones, flowing data particles and a ≤ 1 Hz pulse.
 * Tubes instead of fat lines: no resolution uniforms, correct in stereo, cheap at these lengths.
 */
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, CurvePath, Group, LineCurve3, Mesh, NormalBlending, Points, PointsMaterial, QuadraticBezierCurve3, ShaderMaterial, TubeGeometry, Vector3, type Curve } from 'three';
import type { PathStyle } from '@ce/gen3d';
import { NEON } from '@ce/gen3d';
import { voidKeylineMaterial } from './materials';

const vert = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const frag = /* glsl */ `
  uniform vec3 uColor;
  uniform float uLen;      // curve length in metres
  uniform int uStyle;      // 0 solid 1 dashed 2 dotted 3 dash-dot 4 cone
  uniform float uPulse;    // 0..1 brightness breath
  uniform float uBirth;
  varying vec2 vUv;
  void main() {
    float d = vUv.x * uLen;
    float a = 1.0;
    if (uStyle == 1) a = step(0.5, fract(d / 0.024));
    else if (uStyle == 2) a = step(0.65, fract(d / 0.012));
    else if (uStyle == 3) { float f = fract(d / 0.036); a = (f < 0.45 || (f > 0.62 && f < 0.72)) ? 1.0 : 0.0; }
    else if (uStyle == 4) a = 0.25 + 0.75 * vUv.x;
    if (a < 0.01) discard;
    vec3 col = uColor * (0.85 + 0.35 * uPulse);
    gl_FragColor = vec4(col, a * uBirth * (uStyle == 4 ? 0.55 : 1.0));
  }
`;

export class PathObject extends Group {
  private neon: Mesh<TubeGeometry, ShaderMaterial>;
  private key?: Mesh<TubeGeometry>;
  private particles?: Points<BufferGeometry, PointsMaterial>;
  private offsets: Float32Array = new Float32Array(0);
  private curve: Curve<Vector3>;
  private length: number;
  private readonly speed: number;
  private readonly animate: PathStyle['animate'];
  private readonly tmp = new Vector3();

  constructor(style: PathStyle) {
    super();
    this.name = 'path';
    this.curve = makeCurve(style);
    this.length = Math.max(0.001, this.curve.getLength());
    const width = style.width ?? 0.002;
    const cone = style.lineStyle === 'cone';
    const segments = Math.max(8, Math.min(160, Math.round(this.length * 200)));
    const r = cone ? width * 3 : width / 2;
    const styleIdx = style.lineStyle === 'dashed' ? 1 : style.lineStyle === 'dotted' ? 2 : style.lineStyle === 'dash-dot' ? 3 : cone ? 4 : 0;
    const mat = new ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: { uColor: { value: new Color(style.color ?? NEON.cyan) }, uLen: { value: this.length }, uStyle: { value: styleIdx }, uPulse: { value: 0 }, uBirth: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: cone ? AdditiveBlending : NormalBlending,
    });
    this.neon = new Mesh(new TubeGeometry(this.curve, segments, r, 6, !!style.closed), mat);
    this.neon.renderOrder = 46;
    if ((style.keyline ?? true) && !cone) {
      this.key = new Mesh(new TubeGeometry(this.curve, segments, r + 0.001, 6, !!style.closed), voidKeylineMaterial());
      this.key.renderOrder = 44;
      this.add(this.key);
    }
    this.add(this.neon);
    this.speed = style.speed ?? 0.6;
    this.animate = style.animate ?? 'none';
    const n = this.animate === 'flow' ? (style.particles ?? 8) : 0;
    if (n > 0) {
      const geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(new Float32Array(n * 3), 3));
      this.offsets = new Float32Array(n);
      for (let i = 0; i < n; i++) this.offsets[i] = i / n;
      const pm = new PointsMaterial({ color: style.color ?? NEON.cyan, size: 0.008, sizeAttenuation: true, transparent: true, opacity: 0.95, blending: AdditiveBlending, depthWrite: false, toneMapped: false });
      this.particles = new Points(geo, pm);
      this.particles.renderOrder = 47;
      this.particles.frustumCulled = false;
      this.add(this.particles);
    }
  }

  setBirth(b: number): void {
    this.neon.material.uniforms.uBirth!.value = b;
    if (this.key) (this.key.material as { opacity: number }).opacity = 0.9 * b;
    if (this.particles) this.particles.material.opacity = 0.95 * b;
  }

  setColor(hex: string): void {
    (this.neon.material.uniforms.uColor!.value as Color).set(hex);
    if (this.particles) this.particles.material.color.set(hex);
  }

  update(time: number): void {
    if (this.animate === 'pulse') this.neon.material.uniforms.uPulse!.value = 0.5 + 0.5 * Math.sin(time * Math.PI * 1.6); // 0.8 Hz
    if (this.particles) {
      const pos = this.particles.geometry.getAttribute('position') as BufferAttribute;
      const n = this.offsets.length;
      for (let i = 0; i < n; i++) {
        const t = (this.offsets[i]! + (time * this.speed) / this.length) % 1;
        this.curve.getPointAt(t, this.tmp);
        pos.setXYZ(i, this.tmp.x, this.tmp.y, this.tmp.z);
      }
      pos.needsUpdate = true;
    }
  }

  override dispose(): void {
    this.neon.geometry.dispose();
    this.neon.material.dispose();
    this.key?.geometry.dispose();
    (this.key?.material as { dispose?: () => void } | undefined)?.dispose?.();
    this.particles?.geometry.dispose();
    this.particles?.material.dispose();
  }
}

function makeCurve(style: PathStyle): Curve<Vector3> {
  if (style.points && style.points.length >= 2) {
    const pts = style.points.map((p) => new Vector3(p[0], p[1], p[2]));
    if (style.closed) pts.push(pts[0]!.clone());
    const path = new CurvePath<Vector3>();
    for (let i = 0; i < pts.length - 1; i++) path.add(new LineCurve3(pts[i]!, pts[i + 1]!));
    return path;
  }
  const a = new Vector3(...(style.from ?? [0, 0, 0]));
  const b = new Vector3(...(style.to ?? [0.1, 0, 0]));
  const arc = style.arcHeight ?? 0;
  const mid = a.clone().add(b).multiplyScalar(0.5);
  if (arc > 0) {
    const dir = b.clone().sub(a).normalize();
    let up = new Vector3(0, 1, 0);
    if (Math.abs(dir.dot(up)) > 0.9) up = new Vector3(1, 0, 0);
    const side = up.clone().sub(dir.clone().multiplyScalar(dir.dot(up))).normalize();
    mid.add(side.multiplyScalar(arc * 2)); // quadratic control point sits 2x above the apex
    return new QuadraticBezierCurve3(a, mid, b);
  }
  return new LineCurve3(a, b);
}
