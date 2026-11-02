import { Object3D, Quaternion, Vector3 } from 'three';

interface HeadPose { position: Vector3; quaternion: Quaternion }
interface PanelOffset { distance?: number; height?: number }

const UP = new Vector3(0, 1, 0);
const CONE_COS = Math.cos(35 * Math.PI / 180);
const FOLLOW_DELAY_MS = 1500;
const FOLLOW_DURATION_MS = 300;
const MOVE_DISTANCE_SQ = 0.75 ** 2;

/** A reachable world anchor that follows only after a sustained look away or a large step. */
export class WorldPanel {
  private placed = false;
  private outsideSince: number | null = null;
  private movingSince: number | null = null;
  private previousTime: number | null = null;
  private readonly anchorHead = new Vector3();
  private readonly fromPosition = new Vector3();
  private readonly toPosition = new Vector3();
  private readonly fromRotation = new Quaternion();
  private readonly toRotation = new Quaternion();
  private readonly gaze = new Vector3();
  private readonly direction = new Vector3();
  private readonly distance: number;
  private readonly height: number;

  constructor({ distance = 0.6, height = -0.14 }: PanelOffset = {}) {
    this.distance = distance;
    this.height = height;
  }

  /** The next update anchors at its current head pose, for example when selecting another device. */
  reset(): void {
    this.placed = false;
    this.outsideSince = this.movingSince = this.previousTime = null;
  }

  update(panel: Object3D, head: HeadPose, timeMs: number): void {
    if (this.previousTime !== null && timeMs < this.previousTime) this.reset();
    this.previousTime = timeMs;
    if (!this.placed) {
      this.destination(head);
      panel.position.copy(this.toPosition);
      panel.quaternion.copy(this.toRotation);
      this.placed = true;
      return;
    }

    if (this.movingSince === null) {
      this.gaze.set(0, 0, -1).applyQuaternion(head.quaternion);
      this.direction.subVectors(panel.position, head.position).normalize();
      if (this.direction.dot(this.gaze) < CONE_COS) this.outsideSince ??= timeMs;
      else this.outsideSince = null;
      const lookedAway = this.outsideSince !== null && timeMs - this.outsideSince > FOLLOW_DELAY_MS;
      if (lookedAway || head.position.distanceToSquared(this.anchorHead) > MOVE_DISTANCE_SQ) {
        this.fromPosition.copy(panel.position);
        this.fromRotation.copy(panel.quaternion);
        // Capture once: moving the head during the transition must not drag the panel around.
        this.destination(head);
        this.movingSince = timeMs;
        this.outsideSince = null;
      }
    }

    if (this.movingSince === null) return;
    const progress = Math.min(1, Math.max(0, (timeMs - this.movingSince) / FOLLOW_DURATION_MS));
    const eased = progress * progress * (3 - 2 * progress);
    panel.position.lerpVectors(this.fromPosition, this.toPosition, eased);
    panel.quaternion.slerpQuaternions(this.fromRotation, this.toRotation, eased);
    if (progress === 1) this.movingSince = null;
  }

  private destination(head: HeadPose): void {
    this.anchorHead.copy(head.position);
    this.direction.set(0, 0, -1).applyQuaternion(head.quaternion);
    this.direction.y = 0;
    if (this.direction.lengthSq() < 1e-6) {
      // Looking straight up/down still has a horizontal right axis to derive yaw from.
      this.direction.set(1, 0, 0).applyQuaternion(head.quaternion);
      this.direction.y = 0;
      this.direction.crossVectors(UP, this.direction);
    }
    this.direction.normalize();
    this.toPosition.copy(head.position).addScaledVector(this.direction, this.distance);
    this.toPosition.y += this.height;
    this.toRotation.setFromAxisAngle(UP, Math.atan2(-this.direction.x, -this.direction.z));
  }
}
