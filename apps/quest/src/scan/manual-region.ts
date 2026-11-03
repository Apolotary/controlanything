import { BufferGeometry, Float32BufferAttribute, Group, LineBasicMaterial, LineLoop, Vector3 } from 'three';
import type { Handedness, ShellFrame } from '../app/hud-contract';
import { makeText, setText } from '../hud/v2/text';
import { cameraPoseFromHead, questIntrinsics } from './projection';
import { scanRegion, type ScanRegion } from './region';

/** Two deliberate pinches bound a camera-image area; selecting never tags or sends a command. */
export class ManualRegionSelector {
  readonly root = new Group();
  active = false;
  private anchor?: [number, number];
  private owner?: Handedness;
  private readonly wasDown = { left: true, right: true };
  private geometry = new BufferGeometry();
  private readonly vertices = new Float32BufferAttribute(new Float32Array(12), 3);
  private readonly label = makeText({ text: '', size: 0.022, anchorX: 'center', maxWidth: 0.8 });
  private k = questIntrinsics(1280, 960);
  private readonly origin = new Vector3();
  private readonly direction = new Vector3();
  constructor() {
    this.geometry.setAttribute('position', this.vertices);
    const line = new LineLoop(this.geometry, new LineBasicMaterial({ color: '#54edc7', depthTest: false, depthWrite: false, transparent: true }));
    line.renderOrder = 180; line.frustumCulled = false;
    this.root.name = 'manual-scan-region'; this.root.visible = false;
    this.label.position.set(0, 0.43, -1); this.label.renderOrder = 181;
    this.root.add(line, this.label);
  }
  begin(): void {
    this.active = true; this.anchor = undefined; this.owner = undefined;
    this.wasDown.left = this.wasDown.right = true; this.root.visible = true;
  }
  cancel(): void { this.active = false; this.root.visible = false; this.anchor = undefined; this.owner = undefined; }
  update(frame: ShellFrame, eye: 'left' | 'right' | 'mono', size?: { width: number; height: number }): ScanRegion | undefined {
    if (!this.active) return;
    if (size && (size.width !== this.k.width || size.height !== this.k.height)) this.k = questIntrinsics(size.width, size.height);
    const cam = cameraPoseFromHead(frame.head, eye);
    this.root.position.copy(cam.position); this.root.quaternion.copy(cam.quaternion);
    // Each hand must release its activation pinch. The first deliberate corner owns
    // the selection; another hand cannot finish it if that hand leaves tracking.
    const pressedLeft = !!frame.hands.left?.pinching && !this.wasDown.left;
    const pressedRight = !!frame.hands.right?.pinching && !this.wasDown.right;
    this.wasDown.left = frame.hands.left ? !!frame.hands.left.pinching : true;
    this.wasDown.right = frame.hands.right ? !!frame.hands.right.pinching : true;
    const side = this.owner ?? (pressedLeft && !pressedRight ? 'left' : frame.hands.right ? 'right' : 'left');
    const hand = frame.hands[side];
    if (!hand) { setText(this.label, 'Bring your hand into view · Menu cancels'); return; }
    const pressed = side === 'left' ? pressedLeft : pressedRight;
    const inverse = cam.quaternion.clone().invert();
    const ray = hand?.ray ?? frame.head.ray;
    this.origin.copy(ray.origin).sub(cam.position).applyQuaternion(inverse);
    this.direction.copy(ray.dir).applyQuaternion(inverse);
    if (this.direction.z >= -0.05) return;
    const distance = (-1 - this.origin.z) / this.direction.z;
    if (distance <= 0) return;
    const x = (this.k.cx + this.k.fx * (this.origin.x + distance * this.direction.x)) / this.k.width;
    const y = (this.k.cy - this.k.fy * (this.origin.y + distance * this.direction.y)) / this.k.height;
    const pointer: [number, number] = [Math.max(0.02, Math.min(0.98, x)), Math.max(0.02, Math.min(0.98, y))];
    const a = this.anchor ?? [pointer[0] - 0.025, pointer[1] - 0.025];
    const b = this.anchor ? pointer : [pointer[0] + 0.025, pointer[1] + 0.025];
    const points = [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]]
      .flatMap(([u, v]) => [(u * this.k.width - this.k.cx) / this.k.fx, -(v * this.k.height - this.k.cy) / this.k.fy, -1]);
    this.vertices.array.set(points); this.vertices.needsUpdate = true;
    setText(this.label, this.anchor ? 'Pinch the opposite corner · Menu cancels' : 'Point, then pinch the first corner · Menu cancels');
    if (!pressed) return;
    if (!this.anchor) { this.anchor = pointer; this.owner = side; return; }
    const region = scanRegion(this.anchor, pointer);
    if (!region) { setText(this.label, 'Choose a larger area · Pinch the opposite corner'); return; }
    this.cancel(); return region;
  }
}
