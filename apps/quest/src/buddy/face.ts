/**
 * The buddy's face: ONE curved plane with an SDF shader that draws a dark glossy visor, two glowing eyes, a mouth
 * and blush (one draw call). Expressions are a handful of floats, so every emotion morphs smoothly into the next:
 * capsule eyes ⇄ happy arcs (^ ^) ⇄ hearts, blinks, half-lids, gaze shifts, smile ⇄ frown ⇄ "o" ⇄ laugh.
 */
import { Color, DoubleSide, ShaderMaterial, Vector2 } from 'three';

export interface FaceParams {
  /** 0 closed .. 1 open (1.3 = wide) */
  open: number;
  /** 0 capsule eyes .. 1 happy arcs (^ ^) */
  happy: number;
  /** 0 .. 1 heart eyes */
  heart: number;
  /** per-eye size multipliers */
  scaleL: number;
  scaleR: number;
  /** 0 .. 1 flat top lid ("unimpressed") */
  lid: number;
  /** -1 frown .. 1 smile */
  smile: number;
  /** 0 .. 1 open mouth */
  mouth: number;
  /** 0 .. 1 cheek blush */
  blush: number;
  /** -0.5 .. 0.5 eye tilt (confused brows) */
  tilt: number;
}

export const NEUTRAL_FACE: FaceParams = { open: 1, happy: 0, heart: 0, scaleL: 1, scaleR: 1, lid: 0, smile: 0.35, mouth: 0, blush: 0.15, tilt: 0 };

const vertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const fragment = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec2 uAspect;
uniform vec2 uLook;
uniform float uOpen, uHappy, uHeart, uScaleL, uScaleR, uLid, uSmile, uMouth, uBlush, uTilt, uOpacity;
uniform vec3 uEye, uBlushColor, uVisorTop, uVisorBottom;

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float dot2(vec2 v) { return dot(v, v); }
// Inigo Quilez, heart (MIT)
float sdHeart(vec2 p) {
  p.x = abs(p.x);
  if (p.y + p.x > 1.0) return sqrt(dot2(p - vec2(0.25, 0.75))) - sqrt(2.0) / 4.0;
  return sqrt(min(dot2(p - vec2(0.00, 1.00)), dot2(p - 0.5 * max(p.x + p.y, 0.0)))) * sign(p.x - p.y);
}

float eye(vec2 p, vec2 c, float s, float side) {
  vec2 q = p - c;
  // tilt each eye inward/outward (confused / worried)
  float a = uTilt * side;
  q = mat2(cos(a), -sin(a), sin(a), cos(a)) * q;
  float hy = max(0.012, 0.125 * s * uOpen);
  float hx = 0.078 * s;
  float d = sdRoundBox(q, vec2(hx, hy), min(hx, hy));
  // half-lidded: cut the top flat
  d = max(d, q.y - hy * (1.0 - 1.4 * uLid));
  // happy arc: upper half of a ring, rounded ends
  float r = 0.085 * s;
  vec2 qa = q + vec2(0.0, 0.035 * s);
  float arc = qa.y > 0.0 ? abs(length(qa) - r) - 0.03 * s : length(vec2(abs(qa.x) - r, qa.y)) - 0.03 * s;
  d = mix(d, arc, uHappy);
  float hs = 0.24 * s;
  float h = sdHeart((q + vec2(0.0, 0.11 * s)) / hs) * hs;
  return mix(d, h, uHeart);
}

void main() {
  vec2 p = (vUv - 0.5) * uAspect;
  float aa = fwidth(p.y) * 1.2;
  // the visor
  float dv = sdRoundBox(p, uAspect * 0.5 - 0.02, 0.2);
  float visor = 1.0 - smoothstep(-aa, aa, dv);
  if (visor <= 0.001) discard;
  vec3 col = mix(uVisorBottom, uVisorTop, smoothstep(-0.5, 0.5, p.y));
  // glossy highlight top-left
  col += 0.07 * (1.0 - smoothstep(0.0, 0.22, length((p - vec2(-0.32, 0.3)) * vec2(0.7, 1.6))));
  // rim
  col += 0.05 * smoothstep(-0.05, 0.0, dv);

  vec2 look = uLook * vec2(0.13, 0.08);
  float dl = eye(p, vec2(-0.235, 0.05) + look, uScaleL, 1.0);
  float dr = eye(p, vec2(0.235, 0.05) + look, uScaleR, -1.0);
  float de = min(dl, dr);

  // mouth: a short curve (smile/frown) that opens into an "o" / laugh
  vec2 m = p - (vec2(0.0, -0.215) + look * 0.5);
  float w = 0.085;
  float k = uSmile * 7.0;
  float xm = clamp(m.x, -w, w);
  float curve = abs(m.y - k * xm * xm) / sqrt(1.0 + 4.0 * k * k * xm * xm);
  float dLine = length(vec2(m.x - xm, 0.0)) + curve - 0.018;
  vec2 rr = vec2(0.05 + 0.02 * max(uSmile, 0.0), 0.012 + 0.07 * uMouth);
  float dO = (length(m / rr) - 1.0) * min(rr.x, rr.y);
  // laughing: flatten the top of the open mouth into a D
  dO = max(dO, m.y - rr.y * (1.0 - 0.75 * clamp(uSmile, 0.0, 1.0)));
  float dm = mix(dLine, dO, smoothstep(0.06, 0.3, uMouth));

  float d = min(de, dm);
  float fill = 1.0 - smoothstep(-aa, aa, d);
  float glow = exp(-max(d, 0.0) * 28.0) * 0.32;
  // blush
  float b = 0.0;
  b += 1.0 - smoothstep(0.0, 0.1, length((p - vec2(-0.43, -0.13) - look * 0.4) * vec2(1.0, 1.7)));
  b += 1.0 - smoothstep(0.0, 0.1, length((p - vec2(0.43, -0.13) - look * 0.4) * vec2(1.0, 1.7)));
  col = mix(col, uBlushColor, clamp(b * uBlush * 0.8, 0.0, 1.0));
  col += uEye * glow;
  col = mix(col, uEye, fill);
  gl_FragColor = vec4(col, visor * uOpacity);
}`;

export class FaceMaterial extends ShaderMaterial {
  constructor(widthM: number, heightM: number) {
    super({
      vertexShader: vertex,
      fragmentShader: fragment,
      transparent: true,
      depthWrite: true,
      side: DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
      uniforms: {
        uAspect: { value: new Vector2(widthM / heightM, 1) },
        uLook: { value: new Vector2() },
        uOpen: { value: 1 },
        uHappy: { value: 0 },
        uHeart: { value: 0 },
        uScaleL: { value: 1 },
        uScaleR: { value: 1 },
        uLid: { value: 0 },
        uSmile: { value: 0.35 },
        uMouth: { value: 0 },
        uBlush: { value: 0.15 },
        uTilt: { value: 0 },
        uOpacity: { value: 1 },
        uEye: { value: new Color('#FFF1DE') },
        uBlushColor: { value: new Color('#FF7A9A') },
        uVisorTop: { value: new Color('#24212E') },
        uVisorBottom: { value: new Color('#0C0B12') },
      },
    });
  }

  apply(f: FaceParams, lookX: number, lookY: number, eye: Color): void {
    const u = this.uniforms;
    u.uOpen.value = f.open;
    u.uHappy.value = f.happy;
    u.uHeart.value = f.heart;
    u.uScaleL.value = f.scaleL;
    u.uScaleR.value = f.scaleR;
    u.uLid.value = f.lid;
    u.uSmile.value = f.smile;
    u.uMouth.value = f.mouth;
    u.uBlush.value = f.blush;
    u.uTilt.value = f.tilt;
    (u.uLook.value as Vector2).set(lookX, lookY);
    (u.uEye.value as Color).copy(eye);
  }
}
