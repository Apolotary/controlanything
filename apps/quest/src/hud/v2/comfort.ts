import { Quaternion, Vector3 } from 'three';

const UP = new Vector3(0, 1, 0);
const ANGLE = 4 * Math.PI / 180;
export function angularScale(distance: number, height: number): number {
  return Math.max(1, 2 * distance * Math.tan(ANGLE / 2) / height);
}

/** Rules 5/7: leave the device visible and bring its card into comfortable reach. */
export class CardPlacement {
  private readonly direction = new Vector3();
  private readonly right = new Vector3();
  place(head: Vector3, device: Vector3, width: number, out: Vector3, rotation: Quaternion): void {
    this.direction.subVectors(device, head);
    const distance = Math.max(0.55, Math.min(0.9, this.direction.length()));
    const objectDistance = Math.max(0.1, this.direction.length());
    this.direction.normalize();
    this.right.crossVectors(this.direction, UP);
    if (this.right.lengthSq() < 1e-6) this.right.set(1, 0, 0);
    else this.right.normalize();
    const clearance = Math.min(0.5, width / objectDistance * distance / 2 + 0.24);
    out.copy(this.direction).multiplyScalar(distance).addScaledVector(this.right, clearance);
    out.y = Math.max(-0.3, Math.min(0.22, out.y + 0.12));
    out.normalize().multiplyScalar(distance).add(head);
    rotation.setFromAxisAngle(UP, Math.atan2(head.x - out.x, head.z - out.z));
  }
}

/** A single reusable view-space result; arrows also point correctly to targets behind the head. */
export class EdgePlacement {
  readonly position = new Vector3();
  angle = 0;
  visible = false;
  private readonly inverse = new Quaternion();
  private readonly local = new Vector3();
  update(head: Vector3, rotation: Quaternion, device: Vector3): boolean {
    this.inverse.copy(rotation).invert();
    const p = this.local.subVectors(device, head).applyQuaternion(this.inverse);
    const depth = Math.max(0.001, -p.z);
    this.visible = p.z >= 0 || Math.abs(p.x) / depth > 0.72 || Math.abs(p.y) / depth > 0.52;
    if (!this.visible) return false;
    let x = p.x, y = p.y;
    if (Math.abs(x) + Math.abs(y) < 0.001) x = 1;
    const factor = Math.max(Math.abs(x) / 0.32, Math.abs(y) / 0.23);
    x /= factor; y /= factor;
    this.angle = Math.atan2(y, x);
    this.position.set(x, y, -0.65).applyQuaternion(rotation).add(head);
    return true;
  }
}
