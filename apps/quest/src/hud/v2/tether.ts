import { BufferAttribute, BufferGeometry, DoubleSide, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import { THEME } from './theme';

/** A single camera-facing ribbon; an idle tether submits no vertices. */
export class TargetTether extends Mesh<BufferGeometry, MeshBasicMaterial> {
  private readonly positions = new Float32Array(12);
  private readonly along = new Vector3();
  private readonly view = new Vector3();
  private readonly side = new Vector3();

  constructor() {
    const geometry = new BufferGeometry();
    geometry.setIndex([0, 1, 2, 2, 1, 3]);
    geometry.setDrawRange(0, 0);
    super(geometry, new MeshBasicMaterial({ color: THEME.color.accent, transparent: true, opacity: THEME.opacity.line, side: DoubleSide, forceSinglePass: true, depthWrite: false, toneMapped: false }));
    geometry.setAttribute('position', new BufferAttribute(this.positions, 3));
    this.name = 'target-tether';
    this.renderOrder = THEME.render.boxes;
    this.frustumCulled = false;
    this.visible = false;
  }

  hide(): void {
    this.visible = false;
    this.geometry.setDrawRange(0, 0);
    this.positions.fill(0);
    this.geometry.getAttribute('position').needsUpdate = true;
  }

  update(start: Vector3, end: Vector3, head: Vector3): void {
    this.along.subVectors(end, start);
    this.view.addVectors(start, end).multiplyScalar(0.5).sub(head);
    this.side.crossVectors(this.along, this.view);
    if (this.side.lengthSq() < 1e-12) { this.hide(); return; }
    this.side.normalize();
    for (let i = 0; i < 4; i++) {
      const point = i < 2 ? start : end;
      // The theme stroke is 1.5 px at one metre; scale with depth to retain its angular width.
      const offset = (i % 2 ? -0.5 : 0.5) * THEME.box.stroke * point.distanceTo(head);
      this.positions[i * 3] = point.x + this.side.x * offset;
      this.positions[i * 3 + 1] = point.y + this.side.y * offset;
      this.positions[i * 3 + 2] = point.z + this.side.z * offset;
    }
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.setDrawRange(0, 6);
    this.visible = true;
  }

  override dispose(): void { this.geometry.dispose(); this.material.dispose(); }
}
