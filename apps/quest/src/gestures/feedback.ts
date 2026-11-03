import { Color, DynamicDrawUsage, Group, InstancedMesh, Matrix4, MeshBasicMaterial, PlaneGeometry, Quaternion, Vector3, type Scene } from 'three';
import type { ShellFrame, ShellHand } from '../app/hud-contract';
import { makeText, setText } from '../hud/v2/text';
import { THEME } from '../hud/v2/theme';

export interface GestureFeedbackState {
  engaged: boolean;
  trackingLost?: boolean;
  axes: readonly { axis: string; actionId: string; label: string; value: number; normalized: number }[];
}

const MAX_AXES = 4, WIDTH = 0.22, ROW = 0.05, TEXT_HZ = 5;

/** Two labels and one instanced ribbon mesh, shared by every performance axis. */
export class GestureFeedback {
  readonly root = new Group();
  private readonly ribbons = new Group();
  private readonly geometry = new PlaneGeometry(1, 1);
  private readonly material = new MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false });
  private readonly bars = new InstancedMesh(this.geometry, this.material, MAX_AXES * 3);
  private readonly labels = makeText({ text: '', size: 0.0135, anchorY: 'top', maxWidth: WIDTH - 0.018, singleLine: true, tabular: true });
  private readonly status = makeText({ text: 'Hold left fist', size: 0.015, anchorX: 'center', singleLine: true, maxWidth: 0.23, weight: 600 });
  private readonly matrix = new Matrix4();
  private readonly position = new Vector3();
  private readonly scale = new Vector3();
  private readonly identity = new Quaternion();
  private readonly plateColor = new Color(THEME.color.plate);
  private readonly trackColor = new Color('#344455');
  private readonly liveColor = new Color(THEME.color.accent);
  private readonly frozenColor = new Color(THEME.color.muted);
  private lastText = -Infinity;
  private wasLive = false;
  private engaged = false;
  private trackingLost = false;

  constructor(scene: Scene) {
    this.root.name = 'gesture-feedback';
    this.root.visible = false;
    this.ribbons.name = 'gesture-ribbons';
    this.labels.name = 'gesture-axis-labels';
    this.labels.position.set(-WIDTH / 2 + 0.009, 0.016, 0.003);
    this.labels.lineHeight = ROW / this.labels.fontSize;
    this.labels.whiteSpace = 'nowrap';
    this.labels.sync();
    this.status.name = 'gesture-live';
    this.bars.name = 'gesture-meters';
    this.bars.instanceMatrix.setUsage(DynamicDrawUsage);
    this.bars.frustumCulled = false;
    this.bars.raycast = () => {};
    this.bars.renderOrder = THEME.render.plates;
    for (let i = 0; i < MAX_AXES; i++) {
      this.bars.setColorAt(i * 3, this.plateColor);
      this.bars.setColorAt(i * 3 + 1, this.trackColor);
      this.bars.setColorAt(i * 3 + 2, this.frozenColor);
    }
    this.ribbons.add(this.bars, this.labels);
    this.root.add(this.ribbons, this.status);
    scene.add(this.root);
  }

  update(frame: ShellFrame, state: GestureFeedbackState | null): void {
    this.root.visible = state !== null;
    if (!state) { this.wasLive = false; this.lastText = -Infinity; return; }
    this.anchor(this.ribbons, frame.hands.right, frame, 0.13, 0.075);
    this.anchor(this.status, frame.hands.left, frame, -0.05, 0.07);
    const changed = this.engaged !== state.engaged || this.trackingLost !== !!state.trackingLost;
    this.engaged = state.engaged;
    this.trackingLost = !!state.trackingLost;
    this.wasLive ||= state.engaged;
    if (changed || this.lastText === -Infinity) setText(this.status, this.trackingLost ? 'Tracking lost · Show hands' : state.engaged ? 'LIVE' : this.wasLive ? 'Paused · Hold left fist' : 'Hold left fist', state.engaged && !this.trackingLost ? THEME.color.accent : THEME.color.muted);
    const count = Math.min(MAX_AXES, state.axes.length);
    this.ribbons.visible = count > 0;
    this.bars.count = count * 3;
    for (let i = 0; i < count; i++) {
      const value = state.axes[i]!.normalized;
      const normalized = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
      const width = (WIDTH - 0.018) * normalized, y = -i * ROW;
      this.rect(i * 3, 0, y, 0, WIDTH, ROW - 0.004);
      this.rect(i * 3 + 1, 0, y - 0.011, 0.001, WIDTH - 0.018, 0.004);
      this.rect(i * 3 + 2, (width - WIDTH + 0.018) / 2, y - 0.011, 0.002, width, 0.004);
      if (changed) this.bars.setColorAt(i * 3 + 2, state.engaged ? this.liveColor : this.frozenColor);
    }
    this.bars.instanceMatrix.needsUpdate = true;
    if (changed && this.bars.instanceColor) this.bars.instanceColor.needsUpdate = true;
    if (frame.time < this.lastText) this.lastText = -Infinity;
    if (changed || frame.time - this.lastText >= 1000 / TEXT_HZ) {
      this.lastText = frame.time;
      let text = '';
      for (let i = 0; i < count; i++) {
        const axis = state.axes[i]!;
        if (i) text += '\n';
        text += `${(axis.label || axis.actionId).slice(0, 19)}  ${Number.isFinite(axis.value) ? Math.round(axis.value * 10) / 10 : '—'}`;
      }
      setText(this.labels, text);
    }
  }

  private anchor(object: Group | typeof this.status, hand: ShellHand | undefined, frame: ShellFrame, x: number, y: number): void {
    const wrist = hand?.joints.wrist?.position ?? hand?.grip?.position;
    object.quaternion.copy(frame.head.quaternion);
    object.position.set(x, y, 0).applyQuaternion(frame.head.quaternion);
    if (wrist) object.position.add(wrist);
    else object.position.set(x > 0 ? 0.16 : -0.16, -0.23, -0.55).applyQuaternion(frame.head.quaternion).add(frame.head.position);
  }

  private rect(index: number, x: number, y: number, z: number, width: number, height: number): void {
    this.position.set(x, y, z);
    this.scale.set(width, height, 1);
    this.matrix.compose(this.position, this.identity, this.scale);
    this.bars.setMatrixAt(index, this.matrix);
  }

  dispose(): void {
    this.labels.dispose(); this.status.dispose();
    this.geometry.dispose(); this.material.dispose(); this.bars.dispose();
    this.root.removeFromParent(); this.root.clear();
  }
}
