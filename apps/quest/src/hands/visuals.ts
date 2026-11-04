/**
 * The hand visuals: a GPU particle field (positions and velocities live in float textures, simulated on the GPU),
 * feedback trails (each frame fades the last one a little, smoke-like), light ribbons behind each hand, and a
 * compositor that draws the dimmed camera, the visual synth (when Muse wires it) and the debug mask underneath.
 *
 * Simulation space: x 0..aspect, y 0..1 (y up). Hands come in display coordinates (0..1, y down).
 * The particles are this page's own feedback layer: they show what the tracker sees. Instruments only respond
 * through a hand program Muse wrote.
 */
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, CanvasTexture, Color, DataTexture, FloatType, HalfFloatType, LinearFilter,
  Mesh, NearestFilter, NoBlending, OrthographicCamera, PlaneGeometry, Points, RedFormat, RGBAFormat, Scene, ShaderMaterial,
  SRGBColorSpace, UnsignedByteType, VideoTexture, WebGLRenderer, WebGLRenderTarget, type Texture, type TextureDataType,
} from 'three';
import { GPUComputationRenderer, type Variable } from 'three/examples/jsm/misc/GPUComputationRenderer.js';
import type { TrackedHand } from './tracker';

export type Quality = 'high' | 'medium' | 'low';
export interface VisualHand { x: number; y: number; radius: number; closed: number; vx: number; vy: number; side: 'left' | 'right'; seen: boolean }
export interface Look {
  /** 0..1 palette rotation */
  hue: number;
  /** 0..1 how busy the ambient flow is */
  flow: number;
  /** 0..1 how strongly particles orbit a hand */
  swirl: number;
  /** 0..1 overall glow */
  glow: number;
}

const QUALITY = {
  high: { size: 256, pixel: 1.5, trail: 0.85, point: 1.6 },
  medium: { size: 176, pixel: 1.25, trail: 0.75, point: 1.9 },
  low: { size: 112, pixel: 1, trail: 0.6, point: 2.4 },
} as const;
const RIBBON = 40;
const PULSES = 6;

const NOISE = /* glsl */`
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz; x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m; m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g; g.x = a0.x * x0.x + h.x * x0.y; g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
vec2 curl(vec2 p) {
  const float e = 0.01;
  float n1 = snoise(p + vec2(0.0, e)), n2 = snoise(p - vec2(0.0, e));
  float n3 = snoise(p + vec2(e, 0.0)), n4 = snoise(p - vec2(e, 0.0));
  return vec2(n1 - n2, -(n3 - n4)) / (2.0 * e);
}
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
`;

const HANDS = /* glsl */`
uniform vec4 uHandA; uniform vec4 uHandB;    // x, y (sim), radius, presence
uniform vec4 uHandAV; uniform vec4 uHandBV;  // vx, vy (sim / s), closed, burst
uniform vec4 uPulse[${PULSES}];              // x, y, age (s), strength
`;

const VELOCITY = /* glsl */`
uniform float uTime; uniform float uDt; uniform float uAspect;
uniform sampler2D uFlow; uniform vec2 uCover; uniform float uMirror;
uniform float uCurl; uniform float uSwirl; uniform float uFlowGain;
${HANDS}
${NOISE}
vec2 handForce(vec2 pos, vec4 h, vec4 hv, float seed) {
  if (h.w < 0.01) return vec2(0.0);
  vec2 d = h.xy - pos; float r = length(d) + 1e-4; vec2 n = d / r;
  float R = h.z;
  float closed = hv.z;
  // open: particles orbit in a ring around the palm; closed: they are pulled into a tight core
  float ring = R * mix(1.35, 0.35, closed);
  float fall = exp(-r / (R * mix(3.5, 5.0, closed)));
  vec2 f = n * (r - ring) * mix(7.0, 16.0, closed) * fall;
  float dir = seed > 0.5 ? 1.0 : -0.6;
  f += vec2(-n.y, n.x) * dir * uSwirl * mix(2.2, 5.0, closed) * fall;
  // wake: the hand drags nearby particles along
  f += hv.xy * 7.0 * exp(-r / (R * 2.2));
  // opening a closed hand throws everything out
  f -= n * hv.w * 42.0 * exp(-r / (R * 3.0));
  return f * h.w;
}
void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 p = texture2D(texturePosition, uv);
  vec4 v = texture2D(textureVelocity, uv);
  vec2 pos = p.xy; vec2 vel = v.xy; float seed = fract(p.w);
  if (p.z < 0.0) {
    // just born: a small random drift
    float a = hash(uv + uTime) * 6.2831;
    gl_FragColor = vec4(vec2(cos(a), sin(a)) * 0.05, 0.05, v.w);
    return;
  }
  vec2 acc = curl(pos * 1.6 + vec2(uTime * 0.03, -uTime * 0.05)) * uCurl;
  // camera motion (coarse optical flow), sampled in camera-image space
  vec2 disp = vec2(pos.x / uAspect, 1.0 - pos.y);
  vec2 img = (disp - 0.5) * uCover + 0.5;
  if (uMirror > 0.5) img.x = 1.0 - img.x;
  vec4 fl = texture2D(uFlow, img);
  acc += fl.xy * uFlowGain;
  acc += (vec2(hash(uv + uTime * 1.1), hash(uv - uTime * 0.7)) - 0.5) * fl.z * 6.0;
  acc += handForce(pos, uHandA, uHandAV, seed) + handForce(pos, uHandB, uHandBV, seed);
  for (int i = 0; i < ${PULSES}; i++) {
    vec4 q = uPulse[i];
    if (q.w <= 0.0) continue;
    vec2 d = pos - q.xy; float r = length(d) + 1e-4;
    float front = q.z * 0.9;
    acc += d / r * q.w * 18.0 * exp(-abs(r - front) * 14.0) * exp(-q.z * 2.0);
  }
  vel += acc * uDt;
  vel *= exp(-1.6 * uDt);
  float sp = length(vel);
  if (sp > 2.5) { vel *= 2.5 / sp; sp = 2.5; }
  gl_FragColor = vec4(vel, sp, v.w);
}`;

const POSITION = /* glsl */`
uniform float uTime; uniform float uDt; uniform float uAspect; uniform float uEmit;
${HANDS}
${NOISE}
void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 p = texture2D(texturePosition, uv);
  vec4 v = texture2D(textureVelocity, uv);
  float life = abs(p.z);
  vec2 pos = p.z < 0.0 ? p.xy : p.xy + v.xy * uDt;
  life -= uDt * (0.22 + 0.4 * hash(uv + 3.1));
  bool gone = pos.x < -0.15 || pos.x > uAspect + 0.15 || pos.y < -0.15 || pos.y > 1.15;
  if (life <= 0.0 || gone) {
    float r1 = hash(uv + fract(uTime * 0.37)), r2 = hash(uv * 1.7 + fract(uTime * 0.53)), r3 = hash(uv * 2.3 - fract(uTime * 0.29));
    bool useA = r3 < 0.5;
    if (useA && uHandA.w < 0.5) useA = false;
    if (!useA && uHandB.w < 0.5) useA = true;
    vec4 h = useA ? uHandA : uHandB;
    float owner = 0.0;
    if (h.w > 0.5 && r1 < uEmit) {
      float a = r2 * 6.2831; float rr = h.z * (0.3 + 1.1 * hash(uv + 9.0 + uTime));
      pos = h.xy + vec2(cos(a), sin(a)) * rr;
      owner = useA ? 1.0 : 2.0;
    } else pos = vec2(r1 * uAspect, r2);
    life = -(0.7 + hash(uv + uTime * 0.5) * 1.6);
    gl_FragColor = vec4(pos, life, owner + fract(p.w));
    return;
  }
  gl_FragColor = vec4(pos, life, p.w);
}`;

const POINTS_VERT = /* glsl */`
attribute vec2 ref;
uniform sampler2D tPos; uniform sampler2D tVel;
uniform float uAspect; uniform float uSize; uniform float uHue; uniform float uGlow;
varying vec3 vColor; varying float vAlpha;
vec3 hueRotate(vec3 c, float h) {
  // rotate around the grey axis (YIQ)
  float a = h * 6.28318;
  mat3 toYIQ = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
  mat3 toRGB = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
  vec3 yiq = toYIQ * c; float cs = cos(a), sn = sin(a);
  yiq.yz = vec2(yiq.y * cs - yiq.z * sn, yiq.y * sn + yiq.z * cs);
  return max(toRGB * yiq, 0.0);
}
void main() {
  vec4 p = texture2D(tPos, ref); vec4 v = texture2D(tVel, ref);
  vec2 ndc = vec2(p.x / uAspect, p.y) * 2.0 - 1.0;
  gl_Position = vec4(ndc, 0.0, 1.0);
  float sp = clamp(v.z * 0.8, 0.0, 1.0);
  float owner = floor(p.w + 0.001);
  float life = abs(p.z);
  vec3 c;
  // left hand: deep blue -> cyan; right hand: magenta -> amber; free particles: dim indigo
  if (owner > 1.5) c = mix(vec3(0.85, 0.12, 0.62), vec3(1.0, 0.62, 0.28), sp);
  else if (owner > 0.5) c = mix(vec3(0.12, 0.32, 1.0), vec3(0.3, 1.0, 0.92), sp);
  else c = mix(vec3(0.32, 0.3, 0.75), vec3(0.6, 0.75, 1.0), sp);
  c = mix(hueRotate(c, uHue), vec3(1.0), smoothstep(0.8, 1.0, sp) * 0.55);
  vColor = c;
  float base = owner > 0.5 ? 0.14 : 0.035;
  // particles fade out over their last second, so drifting dust never builds up into a haze
  vAlpha = smoothstep(0.0, 1.1, life) * (p.z < 0.0 ? 0.0 : 1.0) * (base + (1.0 - base) * sp) * uGlow;
  gl_PointSize = uSize * (0.7 + sp * 1.3);
}`;

const POINTS_FRAG = /* glsl */`
varying vec3 vColor; varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c);
  if (d > 0.25) discard;
  float a = exp(-d * 14.0) * vAlpha;
  gl_FragColor = vec4(vColor * a, a);
}`;

const QUAD_VERT = /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/** Neon outline of the tracked hands (the vision mask, linearly filtered): bright at the edge, faint inside. */
const OUTLINE = /* glsl */`
uniform sampler2D tHand; uniform vec2 uCover; uniform float uMirror; uniform float uAspect; uniform float uOutline;
vec3 handOutline(vec2 uv, vec4 a, vec4 b) {
  if (uOutline <= 0.0) return vec3(0.0);
  vec2 img = (uv - 0.5) * uCover + 0.5;
  if (uMirror > 0.5) img.x = 1.0 - img.x;
  if (img.x < 0.0 || img.x > 1.0 || img.y < 0.0 || img.y > 1.0) return vec3(0.0);
  float m = texture2D(tHand, vec2(img.x, 1.0 - img.y)).r;
  float edge = 1.0 - smoothstep(0.0, 0.32, abs(m - 0.5));
  vec2 p = vec2(uv.x * uAspect, uv.y);
  // colour by the nearer hand: left cyan, right magenta
  float da = a.w > 0.01 ? length(p - a.xy) : 9.0, db = b.w > 0.01 ? length(p - b.xy) : 9.0;
  vec3 col = da < db ? vec3(0.3, 0.9, 1.0) : vec3(1.0, 0.4, 0.9);
  return col * (edge * 0.9 + smoothstep(0.5, 1.0, m) * 0.06) * uOutline;
}`;

const FADE_FRAG = /* glsl */`
uniform sampler2D tPrev; uniform float uFade; uniform vec2 uTexel; uniform float uTime;
uniform vec4 uHandA; uniform vec4 uHandB;
varying vec2 vUv;
${NOISE}
${OUTLINE}
void main() {
  // the old frame drifts a little (smoke) and fades
  vec2 drift = curl(vUv * 3.0 + uTime * 0.05) * uTexel * 0.6;
  vec3 c = texture2D(tPrev, vUv + drift).rgb;
  c = max(c * uFade - 0.6 / 255.0, 0.0);
  // moving hands leave echoing outlines in the trails
  c += handOutline(vUv, uHandA, uHandB) * 0.12;
  gl_FragColor = vec4(c, 1.0);
}`;

const RIBBON_VERT = /* glsl */`
attribute float aT; attribute float aSide;
uniform float uAspect;
varying float vT; varying float vSide;
void main() { vT = aT; vSide = aSide; gl_Position = vec4(vec2(position.x / uAspect, position.y) * 2.0 - 1.0, 0.0, 1.0); }`;
const RIBBON_FRAG = /* glsl */`
uniform vec3 uColor; uniform float uAlpha;
varying float vT; varying float vSide;
void main() {
  float edge = 1.0 - abs(vSide);
  float a = pow(edge, 1.6) * vT * vT * uAlpha;
  gl_FragColor = vec4(uColor * a * 1.4 + vec3(1.0) * pow(edge, 8.0) * vT * a * 0.6, a);
}`;

const COMPOSITE_FRAG = /* glsl */`
uniform sampler2D tVideo; uniform sampler2D tTrail; uniform sampler2D tSynth; uniform sampler2D tMask;
uniform float uVideo; uniform float uSynth; uniform float uMask; uniform float uTime; uniform float uPassthrough;
uniform float uHue; uniform float uHasVideo;
${HANDS}
${OUTLINE}
varying vec2 vUv;
vec3 handColor(float side, float hue) {
  return side < 0.5 ? vec3(0.25, 0.85, 1.0) : vec3(1.0, 0.35, 0.85);
}
float ringAt(vec2 p, vec4 h, vec4 hv) {
  if (h.w < 0.01) return 0.0;
  float d = length(p - h.xy);
  float R = h.z * mix(1.05, 0.7, hv.z);
  float ring = smoothstep(0.009, 0.0, abs(d - R)) * 0.42;
  float core = smoothstep(R * 0.5, 0.0, d) * hv.z * 0.35;
  float halo = exp(-d / (h.z * 0.9)) * 0.12;
  return (ring + core + halo) * h.w;
}
void main() {
  vec2 uv = vUv;
  vec2 vuv = (uv - 0.5) * uCover + 0.5;
  if (uMirror > 0.5) vuv.x = 1.0 - vuv.x;
  vec3 cam = texture2D(tVideo, vuv).rgb * uHasVideo;
  float l = dot(cam, vec3(0.299, 0.587, 0.114));
  // passthrough: the camera as it is; the stylized (dim, cool) look only under a wired visual synth
  vec3 stylized = mix(vec3(l), cam, 0.45) * vec3(0.72, 0.84, 1.1);
  stylized *= stylized * 1.6;
  vec3 col = mix(stylized, cam, uPassthrough) * uVideo;
  vec3 syn = texture2D(tSynth, uv).rgb * uSynth;
  col = 1.0 - (1.0 - col) * (1.0 - syn);
  col += texture2D(tTrail, uv).rgb;
  col += handOutline(uv, uHandA, uHandB) * 0.55;
  vec2 p = vec2(uv.x * uAspect, uv.y);
  col += handColor(0.0, uHue) * ringAt(p, uHandA, uHandAV);
  col += handColor(1.0, uHue) * ringAt(p, uHandB, uHandBV);
  // a beam between two hands
  if (uHandA.w > 0.5 && uHandB.w > 0.5) {
    vec2 a = uHandA.xy, b = uHandB.xy, ab = b - a;
    float k = clamp(dot(p - a, ab) / max(1e-4, dot(ab, ab)), 0.0, 1.0);
    float d = length(p - a - ab * k);
    float wobble = 0.5 + 0.5 * sin(k * 40.0 - uTime * 9.0);
    float beam = exp(-d * 90.0) * (0.25 + 0.35 * wobble) + exp(-d * 18.0) * 0.06;
    col += mix(handColor(0.0, uHue), handColor(1.0, uHue), k) * beam * min(uHandA.w, uHandB.w);
  }
  for (int i = 0; i < ${PULSES}; i++) {
    vec4 q = uPulse[i];
    if (q.w <= 0.0) continue;
    float d = length(p - q.xy);
    col += vec3(0.7, 0.9, 1.0) * q.w * exp(-abs(d - q.z * 0.9) * 60.0) * exp(-q.z * 2.5) * 0.7;
  }
  if (uMask > 0.0) {
    float m = texture2D(tMask, vec2(vuv.x, 1.0 - vuv.y)).r * 255.0;
    vec3 mc = m > 2.5 ? vec3(1.0, 0.85, 0.2) : m > 1.5 ? vec3(0.2, 1.0, 0.55) : m > 0.5 ? vec3(0.9, 0.3, 0.9) : vec3(0.0);
    col = mix(col, mc, (m > 0.5 ? 0.45 : 0.0) * uMask);
  }
  vec2 q = uv - 0.5;
  col *= 1.0 - mix(0.45, 0.15, uPassthrough) * dot(q, q) * 1.6;
  col = col / (1.0 + max(col - 1.0, 0.0) * 0.5);
  gl_FragColor = vec4(col, 1.0);
}`;

export interface VisualStats { fps: number; frameMs: number; particles: number; quality: Quality; calls: number }

export class HandVisuals {
  readonly renderer: WebGLRenderer;
  private gpu: GPUComputationRenderer;
  private posVar: Variable; private velVar: Variable;
  private points: Points<BufferGeometry, ShaderMaterial>;
  private readonly pointScene = new Scene();
  private readonly quadCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly fade: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly fadeScene = new Scene();
  private readonly composite: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly compositeScene = new Scene();
  private trailA: WebGLRenderTarget; private trailB: WebGLRenderTarget;
  private readonly ribbons: { mesh: Mesh<BufferGeometry, ShaderMaterial>; pts: { x: number; y: number; w: number }[] }[] = [];
  private flowTex: DataTexture;
  private flowFilter: typeof LinearFilter | typeof NearestFilter = LinearFilter;
  private flowData = new Float32Array(4);
  private maskTex: DataTexture;
  private handTex: DataTexture;
  private blurA = new Float32Array(0);
  private blurB = new Float32Array(0);
  /** 0..1 strength of the hand outline */
  outline = 1;
  private videoTex?: VideoTexture;
  private synthTex?: CanvasTexture;
  private synthCanvas?: HTMLCanvasElement;
  private readonly blank: DataTexture;
  private readonly hands = { A: [0, 0, 0.08, 0], B: [0, 0, 0.08, 0], AV: [0, 0, 0, 0], BV: [0, 0, 0, 0] };
  private readonly closedPrev = { left: 0, right: 0 };
  private readonly pulses: { x: number; y: number; age: number; s: number }[] = [];
  private readonly pulseU = new Float32Array(PULSES * 4);
  private time = 0;
  private handSeenAt = -Infinity;
  private last = performance.now();
  private frames: number[] = [];
  private slow = 0;
  aspect = 1;
  quality: Quality;
  mirror = true;
  cover = { sx: 1, sy: 1 };
  look: Look = { hue: 0, flow: 0.5, swirl: 0.6, glow: 1 };
  videoMix = 0.55;
  /** 1 = the camera as it is (AR passthrough), 0 = dimmed and cool under the visuals */
  passthrough = 0;
  synthMix = 0;
  maskMix = 0;
  /** paused while the page is hidden */
  paused = false;
  readonly stats: VisualStats = { fps: 0, frameMs: 0, particles: 0, quality: 'high', calls: 0 };

  constructor(private readonly host: HTMLElement, quality: Quality) {
    this.quality = quality;
    this.renderer = new WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    this.renderer.setClearColor(0x05060b, 1);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.autoClear = false;
    host.append(this.renderer.domElement);
    this.renderer.domElement.className = 'hands-canvas';
    this.blank = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, RGBAFormat); this.blank.needsUpdate = true;
    this.flowFilter = this.renderer.extensions.has('OES_texture_float_linear') ? LinearFilter : NearestFilter;
    this.flowTex = new DataTexture(this.flowData, 1, 1, RGBAFormat, FloatType); this.flowTex.magFilter = this.flowFilter; this.flowTex.minFilter = this.flowFilter; this.flowTex.needsUpdate = true;
    this.maskTex = new DataTexture(new Uint8Array(1), 1, 1, RedFormat, UnsignedByteType); this.maskTex.magFilter = NearestFilter; this.maskTex.needsUpdate = true;
    this.handTex = new DataTexture(new Uint8Array(1), 1, 1, RedFormat, UnsignedByteType); this.handTex.magFilter = LinearFilter; this.handTex.minFilter = LinearFilter; this.handTex.needsUpdate = true;
    const { gpu, posVar, velVar } = this.makeSim(QUALITY[quality].size);
    this.gpu = gpu; this.posVar = posVar; this.velVar = velVar;
    this.points = this.makePoints(QUALITY[quality].size);
    this.pointScene.add(this.points);
    const trailType = this.trailType();
    this.trailA = new WebGLRenderTarget(4, 4, { type: trailType, depthBuffer: false });
    this.trailB = new WebGLRenderTarget(4, 4, { type: trailType, depthBuffer: false });
    this.fade = new Mesh(new PlaneGeometry(2, 2), new ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader: FADE_FRAG, depthTest: false, depthWrite: false, blending: NoBlending,
      uniforms: { tPrev: { value: this.trailA.texture }, uFade: { value: 0.9 }, uTexel: { value: [1 / 1024, 1 / 1024] }, uTime: { value: 0 }, ...this.outlineUniforms(), uHandA: { value: this.hands.A }, uHandB: { value: this.hands.B } },
    }));
    this.fade.frustumCulled = false; this.fadeScene.add(this.fade);
    for (const side of ['left', 'right'] as const) {
      const geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(new Float32Array(RIBBON * 2 * 3), 3));
      const t = new Float32Array(RIBBON * 2), s = new Float32Array(RIBBON * 2);
      for (let i = 0; i < RIBBON; i++) { t[i * 2] = t[i * 2 + 1] = i / (RIBBON - 1); s[i * 2] = -1; s[i * 2 + 1] = 1; }
      geo.setAttribute('aT', new BufferAttribute(t, 1)); geo.setAttribute('aSide', new BufferAttribute(s, 1));
      const index: number[] = [];
      for (let i = 0; i < RIBBON - 1; i++) { const a = i * 2; index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      geo.setIndex(index); geo.setDrawRange(0, 0);
      const mesh = new Mesh(geo, new ShaderMaterial({
        vertexShader: RIBBON_VERT, fragmentShader: RIBBON_FRAG, transparent: true, depthTest: false, depthWrite: false, blending: AdditiveBlending,
        uniforms: { uAspect: { value: 1 }, uColor: { value: new Color(side === 'left' ? 0x40d8ff : 0xff5ad8) }, uAlpha: { value: 0.9 } },
      }));
      mesh.frustumCulled = false;
      this.pointScene.add(mesh);
      this.ribbons.push({ mesh, pts: [] });
    }
    this.composite = new Mesh(new PlaneGeometry(2, 2), new ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader: COMPOSITE_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        tVideo: { value: this.blank }, tTrail: { value: this.trailB.texture }, tSynth: { value: this.blank }, tMask: { value: this.maskTex },
        ...this.outlineUniforms(), uVideo: { value: 0.55 }, uSynth: { value: 0 }, uMask: { value: 0 }, uTime: { value: 0 }, uPassthrough: { value: 0 },
        uHue: { value: 0 }, uHasVideo: { value: 0 }, ...this.handUniforms(),
      },
    }));
    this.composite.frustumCulled = false; this.compositeScene.add(this.composite);
    this.resize();
    this.stats.particles = QUALITY[quality].size ** 2; this.stats.quality = quality;
  }

  private trailType(): TextureDataType {
    const ext = this.renderer.extensions;
    return ext.has('EXT_color_buffer_half_float') || ext.has('EXT_color_buffer_float') ? HalfFloatType : UnsignedByteType;
  }

  /** shared uniform objects: the fade pass and the compositor read the same values */
  private readonly outlineU = { tHand: { value: null as DataTexture | null }, uCover: { value: [1, 1] }, uMirror: { value: 1 }, uAspect: { value: 1 }, uOutline: { value: 1 } };
  private outlineUniforms() { this.outlineU.tHand.value = this.handTex; return this.outlineU; }

  private handUniforms() {
    return {
      uHandA: { value: this.hands.A }, uHandB: { value: this.hands.B }, uHandAV: { value: this.hands.AV }, uHandBV: { value: this.hands.BV },
      uPulse: { value: this.pulseU },
    };
  }

  private makeSim(size: number): { gpu: GPUComputationRenderer; posVar: Variable; velVar: Variable } {
    const gpu = new GPUComputationRenderer(size, size, this.renderer);
    if (!this.renderer.extensions.has('EXT_color_buffer_float')) gpu.setDataType(HalfFloatType);
    const pos0 = gpu.createTexture(), vel0 = gpu.createTexture();
    const p = pos0.image.data as Float32Array, v = vel0.image.data as Float32Array;
    for (let i = 0; i < p.length; i += 4) {
      p[i] = Math.random() * Math.max(1, this.aspect); p[i + 1] = Math.random(); p[i + 2] = 0.2 + Math.random() * 1.5; p[i + 3] = Math.random();
      v[i] = v[i + 1] = v[i + 2] = 0; v[i + 3] = 1;
    }
    const velVar = gpu.addVariable('textureVelocity', VELOCITY, vel0);
    const posVar = gpu.addVariable('texturePosition', POSITION, pos0);
    gpu.setVariableDependencies(velVar, [velVar, posVar]);
    gpu.setVariableDependencies(posVar, [velVar, posVar]);
    const shared = { uTime: { value: 0 }, uDt: { value: 1 / 60 }, uAspect: { value: 1 }, ...this.handUniforms() };
    Object.assign(velVar.material.uniforms, shared, {
      uFlow: { value: this.flowTex ?? null }, uCover: { value: [1, 1] }, uMirror: { value: 1 }, uCurl: { value: 0.25 }, uSwirl: { value: 0.6 }, uFlowGain: { value: 1.2 },
    });
    Object.assign(posVar.material.uniforms, shared, { uEmit: { value: 0.55 } });
    const error = gpu.init();
    if (error) throw new Error(`GPU particles unavailable: ${error}`);
    return { gpu, posVar, velVar };
  }

  private makePoints(size: number): Points<BufferGeometry, ShaderMaterial> {
    const n = size * size;
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(n * 3), 3));
    const ref = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { ref[i * 2] = ((i % size) + 0.5) / size; ref[i * 2 + 1] = (Math.floor(i / size) + 0.5) / size; }
    geo.setAttribute('ref', new BufferAttribute(ref, 2));
    const mat = new ShaderMaterial({
      vertexShader: POINTS_VERT, fragmentShader: POINTS_FRAG, transparent: true, depthTest: false, depthWrite: false, blending: AdditiveBlending,
      uniforms: { tPos: { value: null }, tVel: { value: null }, uAspect: { value: 1 }, uSize: { value: 2 }, uHue: { value: 0 }, uGlow: { value: 1 } },
    });
    const pts = new Points(geo, mat);
    pts.frustumCulled = false;
    return pts;
  }

  resize(): void {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    const q = QUALITY[this.quality];
    const ratio = Math.min(window.devicePixelRatio || 1, q.pixel);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.aspect = w / h;
    const tw = Math.max(64, Math.round(w * ratio * q.trail)), th = Math.max(64, Math.round(h * ratio * q.trail));
    this.trailA.setSize(tw, th); this.trailB.setSize(tw, th);
    this.fade.material.uniforms.uTexel!.value = [1 / tw, 1 / th];
    this.points.material.uniforms.uSize!.value = q.point * ratio * q.trail * Math.max(0.8, Math.min(1.4, h / 800));
    for (const r of this.ribbons) r.pts.length = 0;
    if (this.synthCanvas) {
      const sw = Math.round(Math.min(960, w * Math.min(1, ratio)) * 0.75), sh = Math.round(sw / this.aspect);
      if (this.synthCanvas.width !== sw || this.synthCanvas.height !== sh) { this.synthCanvas.width = sw; this.synthCanvas.height = sh; }
    }
  }

  setVideo(video: HTMLVideoElement | null): void {
    this.videoTex?.dispose(); this.videoTex = undefined;
    if (video) { this.videoTex = new VideoTexture(video); this.videoTex.colorSpace = SRGBColorSpace; }
    const u = this.composite.material.uniforms;
    u.tVideo!.value = this.videoTex ?? this.blank; u.uHasVideo!.value = video ? 1 : 0;
  }

  /** The visual synth's own canvas (its renderer draws there); shown under the particles while it is active. */
  setSynthCanvas(canvas: HTMLCanvasElement | null): void {
    this.synthTex?.dispose(); this.synthTex = undefined; this.synthCanvas = canvas ?? undefined;
    if (canvas) { this.synthTex = new CanvasTexture(canvas); this.synthTex.colorSpace = SRGBColorSpace; this.resize(); }
    this.composite.material.uniforms.tSynth!.value = this.synthTex ?? this.blank;
  }

  /** Coarse camera motion: gw x gh x (flow x, flow y in image fractions per frame, energy). */
  setFlow(flow: Float32Array, gw: number, gh: number): void {
    if (this.flowData.length !== gw * gh * 4) {
      this.flowData = new Float32Array(gw * gh * 4);
      this.flowTex.dispose();
      this.flowTex = new DataTexture(this.flowData, gw, gh, RGBAFormat, FloatType); this.flowTex.magFilter = this.flowFilter; this.flowTex.minFilter = this.flowFilter;
      this.velVar.material.uniforms.uFlow!.value = this.flowTex;
    }
    const m = this.mirror ? -1 : 1;
    const kx = (30 / this.cover.sx) * this.aspect, ky = 30 / this.cover.sy;
    for (let i = 0, j = 0; i < gw * gh; i++, j += 3) {
      this.flowData[i * 4] = m * flow[j]! * kx; this.flowData[i * 4 + 1] = -flow[j + 1]! * ky; this.flowData[i * 4 + 2] = flow[j + 2]!; this.flowData[i * 4 + 3] = 1;
    }
    this.flowTex.needsUpdate = true;
  }

  setMask(mask: Uint8Array | undefined, w: number, h: number): void {
    if (!mask) return;
    if (this.maskTex.image.width !== w || this.maskTex.image.height !== h) {
      this.maskTex.dispose();
      this.maskTex = new DataTexture(new Uint8Array(w * h), w, h, RedFormat, UnsignedByteType); this.maskTex.magFilter = NearestFilter;
      this.composite.material.uniforms.tMask!.value = this.maskTex;
    }
    (this.maskTex.image.data as Uint8Array).set(mask);
    this.maskTex.needsUpdate = true;
    if (this.handTex.image.width !== w || this.handTex.image.height !== h) {
      this.handTex.dispose();
      this.handTex = new DataTexture(new Uint8Array(w * h), w, h, RedFormat, UnsignedByteType); this.handTex.magFilter = LinearFilter; this.handTex.minFilter = LinearFilter;
      this.outlineU.tHand.value = this.handTex;
    }
    // two 3x3 box blurs round off the low-resolution staircase, so the outline reads as a smooth contour
    const n = w * h;
    if (this.blurA.length !== n) { this.blurA = new Float32Array(n); this.blurB = new Float32Array(n); }
    const a = this.blurA, b = this.blurB;
    for (let i = 0; i < n; i++) a[i] = mask[i] === 2 ? 255 : 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; b[i] = (a[x > 0 ? i - 1 : i]! + a[i]! + a[x < w - 1 ? i + 1 : i]!) / 3; }
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; a[i] = (b[y > 0 ? i - w : i]! + b[i]! + b[y < h - 1 ? i + w : i]!) / 3; }
    }
    const hand = this.handTex.image.data as Uint8Array;
    for (let i = 0; i < n; i++) hand[i] = a[i]!;
    this.handTex.needsUpdate = true;
    this.handSeenAt = performance.now();
  }

  /** A burst ring at a display point (a control event Muse's program sent, a tap). */
  pulse(x: number, y: number, strength = 1): void {
    this.pulses.push({ x: x * this.aspect, y: 1 - y, age: 0, s: Math.max(0.1, Math.min(1.5, strength)) });
    while (this.pulses.length > PULSES) this.pulses.shift();
  }

  private setHands(hands: TrackedHand[], dt: number): void {
    const bySide = { left: hands.find((h) => h.side === 'left'), right: hands.find((h) => h.side === 'right') };
    const write = (h: TrackedHand | undefined, P: number[], V: number[], side: 'left' | 'right', ribbon: number) => {
      const target = h ? 1 : 0;
      P[3] = P[3]! + (target - P[3]!) * Math.min(1, dt * 8);
      if (h) {
        P[0] = h.x * this.aspect; P[1] = 1 - h.y; P[2] = Math.max(0.035, Math.min(0.3, h.radius));
        V[0] = h.vx * this.aspect; V[1] = -h.vy; V[2] = h.closed;
      }
      // opening a closed hand is a burst
      const prev = this.closedPrev[side];
      const opening = h ? Math.max(0, prev - h.closed) : 0;
      V[3] = Math.max(V[3]! * Math.exp(-dt * 6), opening > 0.02 ? Math.min(1, opening * 6) : 0);
      this.closedPrev[side] = h?.closed ?? 0;
      const r = this.ribbons[ribbon]!;
      if (h && h.seen) r.pts.push({ x: P[0]!, y: P[1]!, w: Math.min(0.03, 0.006 + h.speed * 0.012) });
      else if (r.pts.length) r.pts.shift();
      while (r.pts.length > RIBBON) r.pts.shift();
    };
    write(bySide.left, this.hands.A, this.hands.AV, 'left', 0);
    write(bySide.right, this.hands.B, this.hands.BV, 'right', 1);
  }

  private updateRibbons(): void {
    for (const r of this.ribbons) {
      const geo = r.mesh.geometry, pos = geo.getAttribute('position') as BufferAttribute, arr = pos.array as Float32Array;
      const n = r.pts.length;
      if (n < 3) { geo.setDrawRange(0, 0); continue; }
      const offset = RIBBON - n;
      for (let i = 0; i < RIBBON; i++) {
        const k = Math.max(0, i - offset), p = r.pts[k]!, q = r.pts[Math.min(n - 1, k + 1)]!, o = r.pts[Math.max(0, k - 1)]!;
        let tx = q.x - o.x, ty = q.y - o.y; const len = Math.hypot(tx, ty) || 1; tx /= len; ty /= len;
        const w = p.w * (i / (RIBBON - 1));
        arr[i * 6] = p.x - ty * w; arr[i * 6 + 1] = p.y + tx * w; arr[i * 6 + 2] = 0;
        arr[i * 6 + 3] = p.x + ty * w; arr[i * 6 + 4] = p.y - tx * w; arr[i * 6 + 5] = 0;
      }
      pos.needsUpdate = true;
      geo.setDrawRange(offset * 6, (RIBBON - 1 - offset) * 6);
      r.mesh.material.uniforms.uAspect!.value = this.aspect;
    }
  }

  render(hands: TrackedHand[]): void {
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0.001, (now - this.last) / 1000));
    this.last = now;
    if (this.paused) return;
    this.time += dt;
    this.frames.push(now); while (this.frames.length && now - this.frames[0]! > 1000) this.frames.shift();
    this.stats.fps = this.frames.length; this.stats.frameMs = this.stats.frameMs * 0.95 + dt * 1000 * 0.05;
    this.adapt(dt);
    this.setHands(hands, dt);
    for (const p of this.pulses) p.age += dt;
    for (let i = 0; i < PULSES; i++) {
      const p = this.pulses[i], u = this.pulseU, k = i * 4;
      if (p && p.age < 1.6) { u[k] = p.x; u[k + 1] = p.y; u[k + 2] = p.age; u[k + 3] = p.s; } else u[k + 3] = 0;
    }
    const L = this.look;
    for (const v of [this.velVar, this.posVar]) {
      const u = v.material.uniforms;
      u.uTime!.value = this.time; u.uDt!.value = dt; u.uAspect!.value = this.aspect;
    }
    const vu = this.velVar.material.uniforms;
    vu.uCover!.value = [this.cover.sx, this.cover.sy]; vu.uMirror!.value = this.mirror ? 1 : 0;
    vu.uCurl!.value = 0.12 + L.flow * 0.45; vu.uSwirl!.value = 0.25 + L.swirl * 0.9;
    this.gpu.compute();
    const pm = this.points.material.uniforms;
    pm.tPos!.value = this.gpu.getCurrentRenderTarget(this.posVar).texture;
    pm.tVel!.value = this.gpu.getCurrentRenderTarget(this.velVar).texture;
    pm.uAspect!.value = this.aspect; pm.uHue!.value = L.hue; pm.uGlow!.value = 0.55 + L.glow * 0.6;
    this.updateRibbons();
    // the outline follows the camera mask; it fades out if the camera stops sending masks
    const o = this.outlineU;
    o.uCover.value = [this.cover.sx, this.cover.sy]; o.uMirror.value = this.mirror ? 1 : 0; o.uAspect.value = this.aspect;
    o.uOutline.value = this.outline * Math.max(0, 1 - (now - this.handSeenAt) / 400);
    // trails: fade the old frame into B, draw the new points on top, swap
    const r = this.renderer;
    this.fade.material.uniforms.tPrev!.value = this.trailA.texture;
    this.fade.material.uniforms.uFade!.value = 0.86 + L.glow * 0.06;
    this.fade.material.uniforms.uTime!.value = this.time;
    r.setRenderTarget(this.trailB);
    r.render(this.fadeScene, this.quadCam);
    r.render(this.pointScene, this.quadCam);
    r.setRenderTarget(null);
    if (this.synthTex) this.synthTex.needsUpdate = this.synthMix > 0.01;
    const cu = this.composite.material.uniforms;
    cu.tTrail!.value = this.trailB.texture;
    cu.uVideo!.value = this.videoMix; cu.uSynth!.value = this.synthMix; cu.uMask!.value = this.maskMix; cu.uPassthrough!.value = this.passthrough;
    cu.uTime!.value = this.time; cu.uHue!.value = L.hue;
    r.clear();
    r.render(this.compositeScene, this.quadCam);
    this.stats.calls = r.info.render.calls;
    [this.trailA, this.trailB] = [this.trailB, this.trailA];
  }

  /** Slow machines get a lower resolution, then fewer particles. */
  private adapt(dt: number): void {
    if (this.quality === 'low') return;
    this.slow = dt > 1 / 38 ? this.slow + 1 : Math.max(0, this.slow - 2);
    if (this.slow < 120) return;
    this.slow = 0;
    this.setQuality(this.quality === 'high' ? 'medium' : 'low');
  }

  setQuality(q: Quality): void {
    if (q === this.quality) return;
    this.quality = q;
    const size = QUALITY[q].size;
    this.gpu.dispose();
    const { gpu, posVar, velVar } = this.makeSim(size);
    this.gpu = gpu; this.posVar = posVar; this.velVar = velVar;
    this.pointScene.remove(this.points);
    this.points.geometry.dispose();
    const fresh = this.makePoints(size);
    this.points = fresh;
    this.pointScene.add(fresh);
    this.stats.particles = size * size; this.stats.quality = q;
    this.resize();
  }

  /** The particle textures, for the WebXR view. */
  particleTextures(): { pos: Texture; vel: Texture; size: number } {
    return { pos: this.gpu.getCurrentRenderTarget(this.posVar).texture, vel: this.gpu.getCurrentRenderTarget(this.velVar).texture, size: QUALITY[this.quality].size };
  }
  /** Step the simulation without drawing to the screen (the WebXR view draws the points itself). */
  step(hands: TrackedHand[], dt: number): void {
    this.time += dt;
    this.setHands(hands, dt);
    for (const v of [this.velVar, this.posVar]) { const u = v.material.uniforms; u.uTime!.value = this.time; u.uDt!.value = dt; u.uAspect!.value = this.aspect; }
    this.gpu.compute();
  }

  dispose(): void {
    this.gpu.dispose(); this.trailA.dispose(); this.trailB.dispose(); this.videoTex?.dispose(); this.synthTex?.dispose();
    this.renderer.dispose(); this.renderer.domElement.remove();
  }
}
