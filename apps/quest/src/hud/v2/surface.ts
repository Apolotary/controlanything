import { Color, Mesh, PlaneGeometry, ShaderMaterial, Vector2 } from 'three';
import { LOOK, THEME } from './theme';

export type SurfaceStyle = 'plate' | 'button' | 'primary' | 'selected' | 'hover' | 'selected-hover' | 'pressed' | 'on-pressed' | 'sending' | 'failed';

/** Horizon tokens (look.ts / LOOK, the same values the uikit device card and Buddy use), in sRGB 0–255. */
const hex = (value: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16)) as [number, number, number];
const TOP = hex(LOOK.plate.top), BOTTOM = hex(LOOK.plate.bottom);
const MID = TOP.map((v, i) => (v + BOTTOM[i]!) / 2);
/** The glass plate's middle tone with `white` of white mixed in: Horizon's secondary button on a glass card. */
const glass = (white: number): Color => new Color(`rgb(${MID.map((v) => Math.round(v * (1 - white) + 255 * white)).join(',')})`);
const PLATE_RADIUS = LOOK.plate.radius * LOOK.pixelSize;
/** Whether a style is the white "on" pill (dark label); LeanHud paints labels from this. */
export function isOnStyle(style: string | undefined): boolean {
  return style === 'primary' || style === 'selected' || style === 'selected-hover' || style === 'on-pressed';
}

interface Look { fill: Color; fill2?: Color; fillAlpha: number; edge: Color; edgeAlpha: number; stroke: number }
const WHITE = '#FFFFFF';
function look(style: SurfaceStyle, pill: boolean): Look {
  const flat = (fill: Color | string, fillAlpha: number, edgeAlpha = 0.1, edge: string = WHITE, stroke: number = THEME.surface.stroke): Look =>
    ({ fill: new Color(fill), fillAlpha, edge: new Color(edge), edgeAlpha, stroke });
  switch (style) {
    // Google XR Blocks grayGlass: top → bottom gradient, 1.5 mm white rim at 18 %.
    // A small glass pill (a tag over the room) reads flat: a gradient over 3 cm looks like a bevel.
    case 'plate': if (pill) return flat(glass(0.04), LOOK.plate.alpha, LOOK.plate.rimAlpha, LOOK.plate.rim, 0.001);
      return { fill: new Color(LOOK.plate.top), fill2: new Color(LOOK.plate.bottom), fillAlpha: LOOK.plate.alpha, edge: new Color(LOOK.plate.rim), edgeAlpha: LOOK.plate.rimAlpha, stroke: 0.0015 };
    // Glass (off): Horizon secondary = white 8 / 16 / 24 % over the plate.
    case 'button': return flat(glass(0.08), 0.94);
    case 'hover': return flat(glass(0.16), 0.95, 0.16);
    case 'pressed': return flat(glass(0.24), 0.96, 0.2);
    case 'sending': return flat(glass(0.16), 0.95, 0.16);
    case 'failed': return flat(glass(0.08), 0.94, 1, '#FBBF24', THEME.surface.stroke * 2);
    // White = on (inspiration §6): white 92 %, hover #d9d9d9, pressed #c0c0c0.
    case 'primary': case 'selected': return flat(WHITE, 0.92, 0);
    case 'selected-hover': return flat('#D9D9D9', 0.95, 0);
    case 'on-pressed': return flat('#C0C0C0', 0.96, 0);
  }
}

/** Rounded fill and an antialiased inner stroke share two triangles and one draw. */
export class GlassSurfaces {
  private readonly geometry = new PlaneGeometry(1, 1);
  private readonly materials = new Map<string, ShaderMaterial>();

  material(w: number, h: number, style: SurfaceStyle, pill = false): ShaderMaterial {
    const key = `${style}/${pill}`;
    let material = this.materials.get(key);
    if (material) return material;
    const l = look(style, pill);
    material = new ShaderMaterial({
      transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
      uniforms: {
        time: { value: 0 },
        shimmer: { value: style === 'sending' ? 1 : 0 },
        size: { value: new Vector2(w, h) },
        radius: { value: pill ? h / 2 : Math.min(PLATE_RADIUS, Math.min(w, h) / 2) },
        stroke: { value: l.stroke },
        fill: { value: l.fill },
        fill2: { value: l.fill2 ?? l.fill.clone() },
        fillAlpha: { value: l.fillAlpha },
        edge: { value: l.edge },
        edgeAlpha: { value: l.edgeAlpha },
      },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        varying vec2 vUv;
        uniform vec2 size;
        uniform float radius, stroke, fillAlpha, edgeAlpha, time, shimmer;
        uniform vec3 fill, fill2, edge;
        void main() {
          vec2 q = abs((vUv - 0.5) * size) - size * 0.5 + radius;
          float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
          float aa = max(fwidth(d), 0.00001);
          float cover = 1.0 - smoothstep(-aa, 0.0, d);
          float border = smoothstep(-stroke - aa, -stroke, d) * edgeAlpha;
          float alpha = fillAlpha + border * (1.0 - fillAlpha);
          vec3 base = mix(fill2, fill, clamp(vUv.y, 0.0, 1.0));
          vec3 color = (base * fillAlpha * (1.0 - border) + edge * border) / max(alpha, 0.00001);
          float sweep = pow(max(0.0, 1.0 - abs(vUv.x - fract(time * 0.55)) * 7.0), 2.0) * shimmer;
          gl_FragColor = vec4(color + sweep * 0.16, (alpha + sweep * 0.12) * cover);
          #include <colorspace_fragment>
        }`,
    });
    this.materials.set(key, material);
    return material;
  }

  create(w: number, h: number, style: SurfaceStyle = 'plate', pill = false): Mesh<PlaneGeometry, ShaderMaterial> {
    const mesh = new Mesh(this.geometry, this.material(w, h, style, pill));
    mesh.scale.set(w, h, 1);
    const radius = pill ? h / 2 : Math.min(PLATE_RADIUS, Math.min(w, h) / 2);
    mesh.onBeforeRender = () => {
      mesh.material.uniforms.size!.value.set(w, h);
      mesh.material.uniforms.radius!.value = radius;
      mesh.material.uniformsNeedUpdate = true;
    };
    // Explicit layers prevent a large transparent panel from sorting in front of its buttons
    // when the wearer turns their head. Depth is not an occlusion signal for this HUD.
    mesh.renderOrder = style === 'plate' ? THEME.render.plates : THEME.render.buttons;
    return mesh;
  }

  tick(time: number): void {
    const material = this.materials.get('sending/true');
    if (material) material.uniforms.time!.value = time;
  }

  dispose(): void {
    this.geometry.dispose();
    for (const material of this.materials.values()) material.dispose();
  }
}
