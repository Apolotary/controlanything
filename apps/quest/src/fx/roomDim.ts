/**
 * SCAN dims the room: a void quad in front of the eyes at alpha ≤ 0.5. Rendered layer only, so the camera
 * frames the oracle measures are untouched. Fades out when a target locks.
 */
import { Camera, DoubleSide, Mesh, MeshBasicMaterial, PlaneGeometry, Vector3 } from 'three';
import { NEON } from '@ce/gen3d';
import { damp } from '../gen3d/anim';

export class RoomDim extends Mesh<PlaneGeometry, MeshBasicMaterial> {
  target = 0;
  private readonly fwd = new Vector3();
  constructor() {
    super(new PlaneGeometry(3, 3), new MeshBasicMaterial({ color: NEON.void, transparent: true, opacity: 0, depthWrite: false, depthTest: false, side: DoubleSide, toneMapped: false }));
    this.renderOrder = -100;
    this.frustumCulled = false;
    this.visible = false;
    this.name = 'roomDim';
  }
  update(camera: Camera, dt: number): void {
    this.material.opacity = damp(this.material.opacity, this.target, 0.25, dt);
    this.visible = this.material.opacity > 0.01;
    if (!this.visible) return;
    camera.getWorldPosition(this.position);
    camera.getWorldDirection(this.fwd);
    this.position.addScaledVector(this.fwd, 0.3);
    this.quaternion.copy(camera.getWorldQuaternion(this.quaternion));
  }
}
