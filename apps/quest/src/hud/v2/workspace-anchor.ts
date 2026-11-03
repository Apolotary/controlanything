import { Group, Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import { WorldPanel } from './world-panel';

const UP = new Vector3(0, 1, 0);

/** One world pose for the whole task. Content transitions never place another panel. */
export class WorkspaceAnchor {
  private readonly pose = new Group();
  // Spawned once, ~0.6 m ahead and 15° below the eye line (tan 15° × 0.6 ≈ 0.16 m), facing the wearer.
  private readonly placement = new WorldPanel({ distance: 0.6, height: -0.16, follow: false });
  private readonly offset = new Vector3();
  private readonly right = new Vector3();
  private readonly matrix = new Matrix4();
  private placed = false;

  update(head: { position: Vector3; quaternion: Quaternion }, time: number): void {
    this.placement.update(this.pose, head, time);
    this.placed = true;
  }

  /** Spawn beside a selected device (right of it, at its height), never between the eyes and the device. */
  spawnBeside(center: Vector3, halfWidth: number, head: { position: Vector3; quaternion: Quaternion }, time: number): void {
    if (this.placed) return;
    this.right.set(1, 0, 0).applyQuaternion(head.quaternion).setY(0);
    if (this.right.lengthSq() < 1e-6) this.right.set(1, 0, 0);
    this.right.normalize();
    this.pose.position.copy(center).addScaledVector(this.right, halfWidth + 0.29);
    // Pull 10 % toward the head so it reads as nearer than the device and stays reachable.
    this.pose.position.lerp(head.position, 0.1);
    this.matrix.lookAt(head.position.clone().setY(this.pose.position.y), this.pose.position, UP);
    this.pose.quaternion.setFromRotationMatrix(this.matrix);
    this.placement.anchor(this.pose, head, time);
    this.placed = true;
  }

  get isPlaced(): boolean { return this.placed; }

  place(panel: Object3D, y = 0): void {
    panel.position.copy(this.pose.position).add(this.offset.set(0, y, 0).applyQuaternion(this.pose.quaternion));
    panel.quaternion.copy(this.pose.quaternion);
  }

  /** Dragging any title moves the task, including the temporarily hidden content. */
  adopt(panel: Object3D, head: { position: Vector3; quaternion: Quaternion }, time: number, y = 0): void {
    this.pose.quaternion.copy(panel.quaternion);
    this.pose.position.copy(panel.position).sub(this.offset.set(0, y, 0).applyQuaternion(panel.quaternion));
    this.placement.anchor(this.pose, head, time);
    this.placed = true;
  }

  reset(): void { this.placement.reset(); this.placed = false; }
}
