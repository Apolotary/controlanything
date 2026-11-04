/**
 * The show-me frame: a soft rounded viewfinder ~42 cm in front of the eyes, beside the buddy, that says what to do
 * ("Hold it here"). It is the contract for the camera crop: whatever is inside it is what the buddy sees.
 *
 *   idle      white rounded border + corner brackets, dim, a slow breath (≤ 0.5 Hz), label "Hold it here"
 *   lit       a hand is inside: full white, a soft inner tint, label "Hold still…"
 *   progress  a gold ring fills clockwise along the border while you hold still (1 s), then one soft flash
 *   attention one slow pulse (the buddy asks you to bring it closer)
 *
 * One shader plane (one draw call, a dark halo under the line so it reads on bright walls) plus one small uikit
 * pill for the label (above the frame, clear of the quest card). Drawn over the passthrough (depthTest off). The flash is a single 0.35 s fade, never a strobe.
 */
import { Group, Mesh, PlaneGeometry, ShaderMaterial, Vector3 } from 'three';
import { Text } from '@pmndrs/uikit';
import type { Panel } from '@pmndrs/uikit-horizon';
import { glassPanel, isBrowser, LOOK } from '../hud/v2/look';

/** side of the square frame, metres */
export const FRAME_SIZE = 0.18;
/** metres from the eyes */
export const FRAME_DIST = 0.42;

const fragment = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uProgress, uFlash, uOpacity, uLit, uBreath, uAttn;
float sdRoundBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
void main() {
  vec2 p = vUv - 0.5;
  float aa = fwidth(p.x) * 1.2;
  float d = sdRoundBox(p, vec2(0.465), 0.12);
  float w = mix(0.006, 0.009, uLit) + uAttn * 0.004;
  float line = 1.0 - smoothstep(w - aa, w + aa, abs(d));
  // corner brackets: thicker border near the corners
  vec2 a = abs(p);
  float bracket = (1.0 - smoothstep(w * 2.2 - aa, w * 2.2 + aa, abs(d))) * step(0.3, min(a.x, a.y));
  // dark halo under the line, for contrast on white walls
  float halo = (1.0 - smoothstep(0.0, 0.03, abs(d))) * 0.28;
  // clockwise progress ring from the top centre, on the border
  float ang = atan(p.x, p.y) / 6.2831853;
  ang = ang < 0.0 ? ang + 1.0 : ang;
  float ringW = 0.016;
  float ring = (1.0 - smoothstep(ringW - aa, ringW + aa, abs(d))) * step(ang, uProgress) * step(0.001, uProgress);
  // soft tint inside while lit, and the shutter flash
  float inside = 1.0 - smoothstep(-aa, aa, d);
  float tint = inside * (uLit * 0.07 + uFlash * 0.35);
  float base = max(line, bracket) * mix(0.62 + 0.12 * uBreath, 1.0, max(uLit, uAttn));
  vec3 col = vec3(1.0);
  float alpha = max(base, tint);
  col = mix(col, vec3(1.0, 0.835, 0.31), ring);
  alpha = max(alpha, ring);
  // halo is black: composite it under everything
  float outA = alpha + halo * (1.0 - alpha);
  col = col * alpha / max(outA, 1e-4);
  outA *= uOpacity;
  if (outA < 0.01) discard;
  gl_FragColor = vec4(col, outA);
}`;

export type FrameMode = 'idle' | 'lit' | 'busy';

export class Viewfinder extends Group {
  /** ring progress 0..1 (hold still) */
  progress = 0;
  /** shown at all (Buddy open) */
  wanted = false;
  /** idle: waiting · lit: a hand is inside · busy: captured, the buddy is looking (dimmed) */
  mode: FrameMode = 'idle';
  readonly frame: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly label?: Panel;
  private readonly labelText?: Text;
  private labelNow = '';
  private flashT = -1;
  private attnT = -1;
  private opacity = 0;
  private lit = 0;
  private time = 0;

  constructor() {
    super();
    this.name = 'buddy-viewfinder';
    this.visible = false;
    this.frame = new Mesh(
      new PlaneGeometry(1, 1),
      new ShaderMaterial({
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: fragment,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        uniforms: { uProgress: { value: 0 }, uFlash: { value: 0 }, uOpacity: { value: 0 }, uLit: { value: 0 }, uBreath: { value: 0 }, uAttn: { value: 0 } },
      }),
    );
    this.frame.name = 'buddy-frame';
    this.frame.scale.setScalar(FRAME_SIZE);
    this.frame.renderOrder = 34;
    this.frame.frustumCulled = false;
    this.add(this.frame);
    if (isBrowser) {
      this.label = glassPanel({ width: 0.15, renderOrder: 35, padding: 8, gap: 0, anchorY: 'bottom', alignItems: 'center', borderRadius: 1000 } as never);
      this.labelText = new Text({ text: '', fontSize: 14, fontWeight: 'semi-bold', color: LOOK.text.primary, whiteSpace: 'nowrap' } as never);
      this.label.add(this.labelText);
      // above the frame: below it, the label would sit on the buddy's quest card and the shelf the sticker lands on
      this.label.position.set(0, FRAME_SIZE / 2 + 0.014, 0);
      this.label.name = 'buddy-frame-label';
      this.add(this.label);
    }
    this.setLabel('Hold it here');
  }

  /** the line under the frame ("Hold it here", "Hold still…", "Got it!") */
  setLabel(text: string): void {
    if (text === this.labelNow) return;
    this.labelNow = text;
    this.userData.label = text;
    this.labelText?.setProperties({ text });
    this.label?.setProperties({ visibility: text ? 'visible' : 'hidden' } as never);
  }

  get labelTextNow(): string { return this.labelNow; }

  flash(): void {
    this.flashT = 0;
  }

  /** one slow pulse: "bring it closer, inside the frame" */
  attention(): void {
    this.attnT = 0;
  }

  /** World corners of the frame (top-left, top-right, bottom-right, bottom-left), written into `out`. */
  corners(out: Vector3[], pad = 1): Vector3[] {
    this.updateWorldMatrix(true, false);
    const h = (FRAME_SIZE / 2) * pad;
    const xy = [[-h, h], [h, h], [h, -h], [-h, -h]];
    for (let i = 0; i < 4; i++) (out[i] ??= new Vector3()).set(xy[i][0], xy[i][1], 0).applyMatrix4(this.matrixWorld);
    return out;
  }

  update(dt: number): void {
    this.time += dt;
    this.opacity += ((this.wanted ? (this.mode === 'busy' ? 0.45 : 1) : 0) - this.opacity) * (1 - Math.exp(-10 * dt));
    this.lit += ((this.mode === 'lit' ? 1 : 0) - this.lit) * (1 - Math.exp(-14 * dt));
    let flash = 0;
    if (this.flashT >= 0) {
      this.flashT += dt;
      flash = Math.max(0, 1 - this.flashT / 0.35);
      if (flash <= 0) this.flashT = -1;
    }
    let attn = 0;
    if (this.attnT >= 0) {
      this.attnT += dt;
      // one 1.6 s swell (0.6 Hz), never a strobe
      attn = Math.sin(Math.min(1, this.attnT / 1.6) * Math.PI);
      if (this.attnT >= 1.6) this.attnT = -1;
    }
    const u = this.frame.material.uniforms;
    u.uProgress.value = this.progress;
    u.uFlash.value = flash;
    u.uOpacity.value = Math.max(this.opacity, flash);
    u.uLit.value = this.lit;
    u.uAttn.value = attn;
    u.uBreath.value = 0.5 + 0.5 * Math.sin(this.time * Math.PI * 2 * 0.4);
    // the frame swells a touch while lit, so "it noticed" reads even in the corner of the eye
    this.frame.scale.setScalar(FRAME_SIZE * (1 + 0.03 * this.lit + 0.04 * attn));
    this.visible = this.opacity > 0.02 || flash > 0;
    if (this.label) {
      this.label.setProperties({ opacity: Math.min(1, this.opacity * 1.2) } as never);
      this.label.update(Math.min(100, dt * 1000));
    }
  }
}
