import { Matrix4, Object3D, Quaternion, Vector3 } from 'three';

interface HeadPose { position: Vector3; quaternion: Quaternion }
interface PanelOffset { distance?: number; height?: number; lateral?: number; follow?: boolean }

const UP = new Vector3(0, 1, 0);
const CONE_COS = Math.cos(35 * Math.PI / 180);
/** Looking at the panel itself is never "looking away", however far below or beside the anchor it sits. */
const PANEL_COS = Math.cos(25 * Math.PI / 180);
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
  private readonly lookPoint = new Vector3();
  private readonly toPanel = new Vector3();
  private readonly fromPosition = new Vector3();
  private readonly toPosition = new Vector3();
  private readonly fromRotation = new Quaternion();
  private readonly toRotation = new Quaternion();
  private readonly gaze = new Vector3();
  private readonly direction = new Vector3();
  private readonly distance: number;
  private readonly height: number;
  private readonly lateral: number;
  private readonly follows: boolean;

  constructor({ distance = 0.6, height = -0.14, lateral = 0, follow = true }: PanelOffset = {}) {
    this.distance = distance;
    this.height = height;
    this.lateral = lateral;
    this.follows = follow;
  }

  /** The next update anchors at its current head pose, for example when selecting another device. */
  reset(): void {
    this.placed = false;
    this.outsideSince = this.movingSince = this.previousTime = null;
  }

  /** Adopt an existing world placement, such as a card opened beside a nearby object. */
  anchor(panel: Object3D, head: HeadPose, timeMs: number): void {
    this.reset();
    this.placed = true;
    this.previousTime = timeMs;
    this.anchorHead.copy(head.position);
    this.direction.set(0, 0, -1).applyQuaternion(head.quaternion).setY(0).normalize();
    this.lookPoint.copy(head.position).add(this.direction);
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

    if (!this.follows) return;

    if (this.movingSince === null) {
      this.gaze.set(0, 0, -1).applyQuaternion(head.quaternion);
      // Judge the look-away angle around the anchor, not its deliberate below-eye offset.
      this.direction.subVectors(this.lookPoint, head.position).normalize();
      const lookingAtPanel = this.toPanel.subVectors(panel.position, head.position).normalize().dot(this.gaze) > PANEL_COS;
      if (!lookingAtPanel && this.direction.dot(this.gaze) < CONE_COS) this.outsideSince ??= timeMs;
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
    this.lookPoint.copy(this.toPosition);
    // Keep lazy follow centred on the gaze anchor, even for a menu placed off to the side.
    this.toPosition.x -= this.direction.z * this.lateral;
    this.toPosition.z += this.direction.x * this.lateral;
    this.toPosition.y += this.height;
    this.toRotation.setFromAxisAngle(UP, Math.atan2(-this.direction.x, -this.direction.z));
  }
}

/** Keep the fallback dock below the card, moving it only when their rectangles collide. */
export class PanelSeparation {
  private readonly cardMatrix = new Matrix4();
  private readonly barMatrix = new Matrix4();
  private readonly inverse = new Quaternion();
  private readonly point = new Vector3();
  private readonly down = new Vector3();
  private readonly upper = { left: 0, right: 0, top: 0, bottom: 0, depth: 0 };
  private readonly lower = { left: 0, right: 0, top: 0, bottom: 0, depth: 0 };

  update(card: Object3D, bar: Object3D, head: HeadPose, cardWidth: number, cardHeight: number, barWidth: number, barHeight: number): void {
    card.updateMatrix(); bar.updateMatrix();
    // Looking around must not reposition a settled layout. Check again only when a panel moves or unfolds.
    if (this.cardMatrix.equals(card.matrix) && this.barMatrix.equals(bar.matrix)) return;
    this.cardMatrix.copy(card.matrix); this.barMatrix.copy(bar.matrix);
    this.inverse.copy(head.quaternion).invert();
    this.bounds(card, head, cardWidth, cardHeight, this.upper);
    this.bounds(bar, head, barWidth, barHeight, this.lower);
    // Leave enough projected space for a 20 degree look around without another correction.
    const a = this.upper, b = this.lower, gap = 0.18;
    if (a.depth <= 0 || b.depth <= 0 || a.right < b.left || b.right < a.left || b.top + gap <= a.bottom || b.bottom > a.top) return;
    // Translation along view-down leaves every corner's view depth unchanged.
    this.down.set(0, -1, 0).applyQuaternion(head.quaternion);
    bar.position.addScaledVector(this.down, (b.top - a.bottom + gap) * b.depth);
    bar.updateMatrix(); this.barMatrix.copy(bar.matrix);
  }

  private bounds(panel: Object3D, head: HeadPose, width: number, height: number, out: typeof this.upper): void {
    out.left = out.bottom = Infinity; out.right = out.top = -Infinity; out.depth = 0;
    for (let x = -1; x <= 1; x += 2) for (let y = -1; y <= 1; y += 2) {
      const p = this.point.set(x * width * panel.scale.x / 2, y * height * panel.scale.y / 2, 0)
        .applyQuaternion(panel.quaternion).add(panel.position).sub(head.position).applyQuaternion(this.inverse);
      if (p.z >= -0.01) { out.depth = -1; return; }
      out.left = Math.min(out.left, p.x / -p.z); out.right = Math.max(out.right, p.x / -p.z);
      out.bottom = Math.min(out.bottom, p.y / -p.z); out.top = Math.max(out.top, p.y / -p.z);
      out.depth = Math.max(out.depth, -p.z);
    }
  }
}
