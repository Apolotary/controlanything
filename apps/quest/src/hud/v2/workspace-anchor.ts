import { Group, Object3D, Quaternion, Vector3 } from 'three';
import { WorldPanel } from './world-panel';

/** One world pose for the whole task. Content transitions never place another panel. */
export class WorkspaceAnchor {
  private readonly pose = new Group();
  private readonly placement = new WorldPanel({ distance: 0.65, height: -0.06, follow: false });
  private readonly offset = new Vector3();

  update(head: { position: Vector3; quaternion: Quaternion }, time: number): void {
    this.placement.update(this.pose, head, time);
  }

  place(panel: Object3D, y = 0): void {
    panel.position.copy(this.pose.position).add(this.offset.set(0, y, 0).applyQuaternion(this.pose.quaternion));
    panel.quaternion.copy(this.pose.quaternion);
  }

  /** Dragging any title moves the task, including the temporarily hidden content. */
  adopt(panel: Object3D, head: { position: Vector3; quaternion: Quaternion }, time: number, y = 0): void {
    this.pose.quaternion.copy(panel.quaternion);
    this.pose.position.copy(panel.position).sub(this.offset.set(0, y, 0).applyQuaternion(panel.quaternion));
    this.placement.anchor(this.pose, head, time);
  }

  reset(): void { this.placement.reset(); }
}
