/**
 * The "I'm looking at it" viewfinder around the held object: four corner brackets, a border that fills clockwise
 * while you hold still (dwell progress), and one soft shutter flash on capture. One plane, one draw call, drawn over
 * the passthrough (depthTest off). The flash is a single 0.35 s fade, never a repeating strobe.
 */
import { Mesh, PlaneGeometry, ShaderMaterial } from 'three';

const fragment = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uProgress, uFlash, uOpacity;
float sdRoundBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
void main() {
  vec2 p = vUv - 0.5;
  float aa = fwidth(p.x) * 1.5;
  float d = sdRoundBox(p, vec2(0.46), 0.1);
  float line = 1.0 - smoothstep(0.006 - aa, 0.006 + aa, abs(d));
  // corner brackets: the border, thicker, only near the corners
  vec2 a = abs(p);
  float bracket = (1.0 - smoothstep(0.012 - aa, 0.012 + aa, abs(d))) * step(0.26, min(a.x, a.y));
  // clockwise wipe from the top centre
  float ang = atan(p.x, p.y) / 6.2831853;
  ang = ang < 0.0 ? ang + 1.0 : ang;
  float wipe = line * step(ang, uProgress) * 0.75;
  float fill = (1.0 - smoothstep(-aa, aa, d)) * uFlash * 0.35;
  float alpha = max(max(bracket, wipe), fill) * uOpacity;
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(vec3(1.0), alpha);
}`;

export class Viewfinder extends Mesh<PlaneGeometry, ShaderMaterial> {
  progress = 0;
  private flashT = -1;
  private opacity = 0;
  wanted = false;

  constructor() {
    super(
      new PlaneGeometry(1, 1),
      new ShaderMaterial({
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: fragment,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        uniforms: { uProgress: { value: 0 }, uFlash: { value: 0 }, uOpacity: { value: 0 } },
      }),
    );
    this.name = 'buddy-viewfinder';
    this.renderOrder = 34;
    this.visible = false;
    this.frustumCulled = false;
  }

  flash(): void {
    this.flashT = 0;
  }

  update(dt: number): void {
    this.opacity += ((this.wanted ? 1 : 0) - this.opacity) * (1 - Math.exp(-12 * dt));
    let flash = 0;
    if (this.flashT >= 0) {
      this.flashT += dt;
      flash = Math.max(0, 1 - this.flashT / 0.35);
      if (flash <= 0) this.flashT = -1;
    }
    const u = this.material.uniforms;
    u.uProgress.value = this.progress;
    u.uFlash.value = flash;
    u.uOpacity.value = Math.max(this.opacity, flash);
    this.visible = this.opacity > 0.02 || flash > 0;
  }
}
