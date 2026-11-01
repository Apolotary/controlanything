/**
 * Materials for the holographic HUD, tuned for passthrough on Quest 3 at 72 Hz.
 *
 * Rules (from the design reviews): anything that carries meaning (plates, arc fills, readouts, keylines) is
 * alpha-blended, near-opaque and writes depth so real hands occlude it; additive blending is reserved for
 * decor (rims, beams, particles). Scanlines are computed in object-local space (never screen space, which
 * shimmers in stereo). Glitch is position jitter only; luminance never flashes above 3 Hz. No bloom pass.
 */
import { AdditiveBlending, Color, DoubleSide, FrontSide, LineBasicMaterial, MeshBasicMaterial, MeshStandardMaterial, NormalBlending, ShaderMaterial, type Material as ThreeMaterial, type Side } from 'three';
import type { Material as SpecMaterial, PartRole } from '@ce/gen3d';
import { NEON } from '@ce/gen3d';

/** Draw order by role so transparent layers never sort-pop as the head moves. */
export const ROLE_ORDER: Record<PartRole | 'text' | 'path' | 'default', number> = {
  base: 10,
  track: 20,
  body: 25,
  arc: 30,
  cap: 40,
  handle: 40,
  indicator: 50,
  beam: 45,
  decor: 35,
  label: 60,
  readout: 60,
  text: 60,
  path: 45,
  default: 30,
};

const holoVertex = /* glsl */ `
  uniform float uTime;
  uniform float uGlitch;
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  varying vec3 vLocal;
  float hash(float n) { return fract(sin(n) * 43758.5453); }
  void main() {
    vLocal = position;
    vec3 p = position;
    if (uGlitch > 0.0) {
      // horizontal slice offsets that change at 2 Hz, position only (no luminance flashing)
      float slice = floor(position.y * 60.0);
      float t = floor(uTime * 2.0);
      float r = hash(slice * 7.1 + t * 13.7);
      p.x += (r - 0.5) * 0.008 * uGlitch * step(0.6, r);
    }
    vec4 worldPos = modelMatrix * vec4(p, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - worldPos.xyz);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const holoFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uRim;
  uniform float uOpacity;
  uniform float uFresnel;
  uniform float uGlow;
  uniform float uScan;
  uniform float uTime;
  uniform float uFlicker;
  uniform float uBirth;
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  varying vec3 vLocal;
  void main() {
    float ndv = abs(dot(normalize(vNormalW), normalize(vViewDir)));
    float rim = pow(clamp(1.0 - ndv, 0.0, 1.0), max(uFresnel, 0.5));
    vec3 col = uColor * (0.6 + 0.5 * rim) + uRim * rim * uGlow * 1.1;
    // object-local scanlines, slow drift (0.3 Hz), 15 % depth; fade out when lines get dense on screen
    float lines = fract(vLocal.y * 180.0 - uTime * 0.3);
    float sl = step(0.5, lines) * 0.15 * uScan;
    float fw = fwidth(vLocal.y * 180.0);
    sl *= clamp(1.0 - fw * 0.5, 0.0, 1.0);
    col *= 1.0 - sl;
    // slow brightness noise, capped well under 3 Hz by using a 1 Hz sine
    col *= 1.0 - uFlicker * 0.08 * (0.5 + 0.5 * sin(uTime * 6.283));
    // birth: uBirth 0..1 fades the surface in (build-up animation)
    float a = uOpacity * uBirth + rim * 0.25 * uGlow * uBirth;
    gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
  }
`;

export interface HoloUniforms {
  uColor: { value: Color };
  uRim: { value: Color };
  uOpacity: { value: number };
  uFresnel: { value: number };
  uGlow: { value: number };
  uScan: { value: number };
  uTime: { value: number };
  uFlicker: { value: number };
  uGlitch: { value: number };
  uBirth: { value: number };
}

export class HoloMaterial extends ShaderMaterial {
  /** typed view of `uniforms` */
  get u(): HoloUniforms {
    return this.uniforms as unknown as HoloUniforms;
  }
  constructor(opts: { color: string; rim?: string; opacity?: number; fresnel?: number; glow?: number; scanlines?: boolean; flicker?: number; glitch?: number; side?: Side }) {
    const opacity = opts.opacity ?? 0.85;
    super({
      vertexShader: holoVertex,
      fragmentShader: holoFragment,
      uniforms: {
        uColor: { value: new Color(opts.color) },
        uRim: { value: new Color(opts.rim ?? opts.color) },
        uOpacity: { value: opacity },
        uFresnel: { value: opts.fresnel ?? 2 },
        uGlow: { value: opts.glow ?? 0.6 },
        uScan: { value: opts.scanlines ? 1 : 0 },
        uTime: { value: 0 },
        uFlicker: { value: opts.flicker ?? 0 },
        uGlitch: { value: opts.glitch ?? 0 },
        uBirth: { value: 1 },
      },
      transparent: true,
      depthWrite: opacity >= 0.5,
      blending: NormalBlending,
      side: opts.side ?? FrontSide,
    });
  }
}

/** Every material the renderer creates is registered here so one call advances time / glitch for all. */
export class MaterialClock {
  private holos = new Set<HoloMaterial>();
  register(m: HoloMaterial): HoloMaterial {
    this.holos.add(m);
    return m;
  }
  unregister(m: HoloMaterial): void {
    this.holos.delete(m);
  }
  tick(time: number): void {
    for (const m of this.holos) m.u.uTime.value = time;
  }
}

export interface BuiltMaterial {
  material: ThreeMaterial;
  /** a wider, faint additive copy drawn around the mesh (fake glow without bloom) */
  glowMaterial?: ThreeMaterial;
  /** draw neon edges on top */
  edgeMaterial?: LineBasicMaterial;
  holo?: HoloMaterial;
}

/** Build a three.js material from a spec material, with the defaults of its style. */
export function buildMaterial(spec: SpecMaterial | undefined, clock: MaterialClock, defaults: { color?: string; style?: SpecMaterial['style'] } = {}): BuiltMaterial {
  const style = spec?.style ?? defaults.style ?? 'solid';
  const color = spec?.color ?? defaults.color ?? NEON.holo;
  const out: BuiltMaterial = { material: new MeshBasicMaterial({ color }) };
  switch (style) {
    case 'holo':
    case 'glitch':
    case 'glass': {
      const holo = clock.register(
        new HoloMaterial({
          color,
          rim: spec?.emissive ?? spec?.edgeColor ?? color,
          opacity: spec?.opacity ?? (style === 'glass' ? 0.35 : 0.85),
          fresnel: spec?.fresnel ?? (style === 'glass' ? 3 : 2),
          glow: spec?.glow ?? 0.6,
          scanlines: spec?.scanlines ?? style !== 'glass',
          flicker: spec?.flicker ?? 0,
          glitch: style === 'glitch' ? 1 : 0,
          side: DoubleSide,
        }),
      );
      out.material = holo;
      out.holo = holo;
      break;
    }
    case 'wire': {
      out.material = new MeshBasicMaterial({ color, transparent: true, opacity: 0.08, depthWrite: false, side: DoubleSide });
      out.edgeMaterial = new LineBasicMaterial({ color: spec?.edgeColor ?? color, transparent: true, opacity: 0.95 });
      break;
    }
    case 'solid':
    default: {
      const m = new MeshStandardMaterial({
        color,
        roughness: spec?.roughness ?? 0.45,
        metalness: spec?.metalness ?? 0.1,
        emissive: new Color(spec?.emissive ?? '#000000'),
        emissiveIntensity: spec?.emissiveIntensity ?? 1,
        transparent: (spec?.opacity ?? 1) < 1,
        opacity: spec?.opacity ?? 1,
        side: FrontSide,
      });
      out.material = m;
      if ((spec?.glow ?? 0) >= 0.8) {
        // fake bloom: the renderer draws two enlarged additive copies with this material
        out.glowMaterial = new MeshBasicMaterial({ color: spec?.emissive ?? color, transparent: true, opacity: 0.28, blending: AdditiveBlending, depthWrite: false, side: DoubleSide, toneMapped: false });
      }
      break;
    }
  }
  if (spec?.edges) out.edgeMaterial = new LineBasicMaterial({ color: spec.edgeColor ?? spec.color ?? NEON.cyan, transparent: true, opacity: 0.95, depthWrite: false });
  return out;
}

/** The disarmed look: a dim cyan wire ghost. Applied over any part while its control is unverified. */
export function ghostMaterial(): MeshBasicMaterial {
  return new MeshBasicMaterial({ color: NEON.cyan, transparent: true, opacity: 0.12, depthWrite: false, side: DoubleSide });
}
export function ghostEdgeMaterial(): LineBasicMaterial {
  return new LineBasicMaterial({ color: NEON.cyan, transparent: true, opacity: 0.6, depthWrite: false });
}

export function voidKeylineMaterial(): MeshBasicMaterial {
  return new MeshBasicMaterial({ color: NEON.void, transparent: true, opacity: 0.9, depthWrite: true, toneMapped: false });
}
