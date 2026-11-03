import { Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, RingGeometry, SphereGeometry } from 'three';
import type { ProjectSpatialScene } from '@ce/protocol';
import { THEME } from './theme';

/** Small, fixed-budget native preview. Model output is data, never executable Three.js code. */
export class SpatialScene extends Group {
  private readonly sphereGeometry = new SphereGeometry(0.047, 20, 12);
  private readonly ringGeometry = new RingGeometry(0.009, 0.0105, 48);
  private readonly sphereMaterial = new MeshStandardMaterial({ roughness: 0.3, metalness: 0.1, transparent: true, opacity: 0.86, depthTest: false, depthWrite: false, toneMapped: false });
  private readonly orb = new Mesh(this.sphereGeometry, this.sphereMaterial);
  private readonly rings = Array.from({ length: 5 }, () => new Mesh(this.ringGeometry,
    new MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, toneMapped: false })));
  constructor() {
    super(); this.name = 'project-spatial-preview'; this.visible = false;
    this.orb.name = 'spatial-orb'; this.orb.renderOrder = THEME.render.text;
    this.add(this.orb);
    this.rings.forEach((ring, index) => { ring.name = `spatial-ring-${index}`; ring.renderOrder = THEME.render.text; this.add(ring); });
  }
  setState(recipe: ProjectSpatialScene | undefined, normalized: number, running: boolean): void {
    this.visible = !!recipe && running;
    const amount = Number.isFinite(normalized) ? Math.max(0, Math.min(1, normalized)) : 0;
    this.userData = { kind: recipe?.kind, normalized: amount, rendered: this.visible, radius: recipe?.kind === 'orb' ? .047 * (.45 + amount * .8) : .0105 * (3 + amount * 2.5) };
    if (!recipe) return;
    this.orb.visible = recipe.kind === 'orb'; this.orb.scale.setScalar(.45 + amount * .8); this.sphereMaterial.color.set(recipe.color);
    for (const [index, ring] of this.rings.entries()) {
      ring.visible = recipe.kind === 'ripples';
      ring.scale.setScalar((index + 1) / 5 * (3 + amount * 2.5));
      ring.material.color.set(recipe.color); ring.material.opacity = .9 - index * .11;
    }
  }
  override dispose(): void {
    this.sphereGeometry.dispose(); this.ringGeometry.dispose(); this.sphereMaterial.dispose();
    for (const ring of this.rings) ring.material.dispose();
    this.removeFromParent();
  }
}
