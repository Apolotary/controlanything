import { Color, Mesh, PlaneGeometry, ShaderMaterial, Vector2 } from 'three';
import { THEME } from './theme';

export type SurfaceStyle = 'plate' | 'button' | 'primary' | 'selected' | 'hover' | 'selected-hover' | 'pressed';

/** Rounded fill and an antialiased inner stroke share two triangles and one draw. */
export class GlassSurfaces {
  private readonly geometry = new PlaneGeometry(1, 1);
  private readonly materials = new Map<string, ShaderMaterial>();

  material(w: number, h: number, style: SurfaceStyle, pill = false): ShaderMaterial {
    const key = `${style}/${pill}`;
    let material = this.materials.get(key);
    if (material) return material;
    const primary = style === 'primary';
    const selected = primary || style === 'selected' || style === 'selected-hover' || style === 'pressed';
    const outlined = style === 'hover' || style === 'selected-hover' || style === 'pressed';
    material = new ShaderMaterial({
      transparent: true, depthWrite: false, toneMapped: false,
      uniforms: {
        size: { value: new Vector2(w, h) },
        radius: { value: pill ? h / 2 : THEME.card.radius },
        stroke: { value: THEME.surface.stroke * (primary ? 1.5 : outlined ? 2 : 1) },
        fill: { value: new Color(selected ? THEME.color.accent : style === 'plate' ? THEME.color.plate : THEME.color.stroke) },
        fillAlpha: { value: style === 'pressed' ? 0.48 : primary ? 0.28 : selected ? THEME.opacity.accentSoft : style === 'plate' ? THEME.opacity.plate : 0.06 },
        edge: { value: new Color(selected || outlined ? THEME.color.accent : THEME.color.stroke) },
        edgeAlpha: { value: primary || outlined ? 1 : style === 'button' ? 0.18 : THEME.opacity.stroke },
      },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        varying vec2 vUv;
        uniform vec2 size;
        uniform float radius, stroke, fillAlpha, edgeAlpha;
        uniform vec3 fill, edge;
        void main() {
          vec2 q = abs((vUv - 0.5) * size) - size * 0.5 + radius;
          float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
          float aa = max(fwidth(d), 0.00001);
          float cover = 1.0 - smoothstep(-aa, 0.0, d);
          float border = smoothstep(-stroke - aa, -stroke, d) * edgeAlpha;
          float alpha = fillAlpha + border * (1.0 - fillAlpha);
          vec3 color = (fill * fillAlpha * (1.0 - border) + edge * border) / max(alpha, 0.00001);
          gl_FragColor = vec4(color, alpha * cover);
          #include <colorspace_fragment>
        }`,
    });
    this.materials.set(key, material);
    return material;
  }

  create(w: number, h: number, style: SurfaceStyle = 'plate', pill = false): Mesh<PlaneGeometry, ShaderMaterial> {
    const mesh = new Mesh(this.geometry, this.material(w, h, style, pill));
    mesh.scale.set(w, h, 1);
    mesh.onBeforeRender = () => {
      mesh.material.uniforms.size!.value.set(w, h);
      mesh.material.uniforms.radius!.value = pill ? h / 2 : THEME.card.radius;
      mesh.material.uniformsNeedUpdate = true;
    };
    mesh.renderOrder = THEME.render.plates;
    return mesh;
  }

  dispose(): void {
    this.geometry.dispose();
    for (const material of this.materials.values()) material.dispose();
  }
}
