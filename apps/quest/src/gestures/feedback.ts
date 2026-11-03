import { Group, Mesh, PlaneGeometry, ShaderMaterial, Vector3, type Scene } from 'three';
import type { ShellFrame, ShellHand } from '../app/hud-contract';
import { makeText, setText } from '../hud/v2/text';
import { LOOK } from '../hud/v2/theme';

export interface GestureFeedbackState {
  engaged: boolean;
  trackingLost?: boolean;
  axes: readonly { axis: string; actionId: string; label: string; value: number; normalized: number }[];
}

/**
 * Live Perform values at frame rate, keyed by action id (e.g. 'cc71'). The spatial arc dials read this so the
 * "AR knobs" move with the hand in real time instead of the 5 Hz HUD mirror.
 */
export const liveGesture = { engaged: false, active: false, at: 0, values: new Map<string, number>() };

const TEXT_HZ = 4;
const HEAD_UP = new Vector3();

/**
 * Hand feedback during Perform (fingertip dots stay in app/hand-feedback.ts):
 * - a clutch ring around the left hand: thin when released, solid white while the fist is held (engaged);
 * - a small value ring beside the right hand: one concentric arc per performance axis (Warp outer, Ripples inner);
 * - one short hint under the clutch only when it is needed ("Hold fist", "Paused", "Show hands").
 * Three draws at most; nothing is text-heavy.
 */
export class GestureFeedback {
  readonly root = new Group();
  private readonly geometry = new PlaneGeometry(1, 1);
  private readonly clutch: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly meter: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly status = makeText({ text: 'Hold fist', size: 0.0135, anchorX: 'center', singleLine: true, maxWidth: 0.2, weight: 600 });
  private readonly palm = new Vector3();
  private lastText = -Infinity;
  private wasLive = false;
  private engaged = false;
  private trackingLost = false;
  private grip = 0;

  constructor(scene: Scene) {
    this.root.name = 'gesture-feedback';
    this.root.visible = false;
    const ring = (fragment: string, uniforms: Record<string, { value: unknown }>) => {
      const mesh = new Mesh(this.geometry, new ShaderMaterial({
        transparent: true, depthTest: false, depthWrite: false, toneMapped: false, uniforms,
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `varying vec2 vUv;\n${fragment}`,
      }));
      mesh.renderOrder = LOOK.render.hands; mesh.frustumCulled = false; mesh.raycast = () => {};
      return mesh;
    };
    // Clutch: radius in uv units (quad spans 1 = 2.6 × ring radius).
    this.clutch = ring(`
      uniform float grip, lost;
      void main() {
        vec2 p = vUv - 0.5; float r = length(p);
        float width = mix(0.012, 0.045, grip);
        float d = abs(r - 0.38) - width * 0.5;
        float aa = max(fwidth(d), 1e-4);
        float a = (1.0 - smoothstep(-aa, aa, d)) * mix(0.5, 1.0, grip) * (1.0 - lost * 0.7);
        gl_FragColor = vec4(vec3(1.0), a);
        #include <colorspace_fragment>
      }`, { grip: { value: 0 }, lost: { value: 0 } });
    this.clutch.name = 'gesture-clutch';
    this.clutch.scale.setScalar(LOOK.hand.clutchRadius * 2.6);
    this.meter = ring(`
      uniform float v0, v1, count, live;
      float arc(vec2 p, float radius, float value) {
        float a = atan(p.x, p.y);                    // 0 at top, clockwise positive
        float t = clamp((a + 2.356) / 4.712, 0.0, 1.0); // 270° sweep, gap at the bottom
        float inSweep = step(abs(a), 2.356);
        float d = abs(length(p) - radius) - 0.035;
        float aa = max(fwidth(d), 1e-4);
        float band = (1.0 - smoothstep(-aa, aa, d)) * inSweep;
        float fill = 1.0 - smoothstep(value - 0.01, value + 0.01, t);
        return band * mix(0.28, mix(0.7, 1.0, live), fill);
      }
      void main() {
        vec2 p = vUv - 0.5;
        float a = arc(p, 0.4, v0);
        if (count > 1.5) a = max(a, arc(p, 0.27, v1));
        gl_FragColor = vec4(vec3(1.0), a);
        #include <colorspace_fragment>
      }`, { v0: { value: 0 }, v1: { value: 0 }, count: { value: 1 }, live: { value: 0 } });
    this.meter.name = 'gesture-value-ring';
    this.meter.scale.setScalar(LOOK.hand.valueRadius * 2.5);
    this.status.name = 'gesture-live';
    this.status.renderOrder = LOOK.render.hands + 1;
    this.root.add(this.clutch, this.meter, this.status);
    scene.add(this.root);
  }

  update(frame: ShellFrame, state: GestureFeedbackState | null): void {
    this.root.visible = state !== null;
    liveGesture.active = state !== null;
    if (!state) { this.wasLive = false; this.lastText = -Infinity; liveGesture.engaged = false; return; }
    const dt = Math.min(0.1, Math.max(0, frame.dt / 1000));
    const changed = this.engaged !== state.engaged || this.trackingLost !== !!state.trackingLost;
    this.engaged = state.engaged; this.trackingLost = !!state.trackingLost;
    this.wasLive ||= state.engaged;
    liveGesture.engaged = state.engaged; liveGesture.at = frame.time;
    for (const axis of state.axes) if (Number.isFinite(axis.normalized)) liveGesture.values.set(axis.actionId, Math.max(0, Math.min(1, axis.normalized)));

    this.grip += ((state.engaged ? 1 : 0) - this.grip) * Math.min(1, dt * 14);
    const left = frame.hands.left, right = frame.hands.right;
    this.clutch.visible = this.anchor(this.clutch, left, frame, 0, 0);
    this.clutch.material.uniforms.grip!.value = this.grip;
    this.clutch.material.uniforms.lost!.value = this.trackingLost ? 1 : 0;
    this.clutch.scale.setScalar(LOOK.hand.clutchRadius * 2.6 * (1 + 0.08 * this.grip));
    const count = Math.min(2, state.axes.length);
    this.meter.visible = count > 0 && this.anchor(this.meter, right, frame, 0.075, 0.06);
    const u = this.meter.material.uniforms;
    const norm = (i: number) => { const v = state.axes[i]?.normalized ?? 0; return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0; };
    u.v0!.value = norm(0); u.v1!.value = norm(1); u.count!.value = count; u.live!.value = state.engaged ? 1 : 0;

    const hint = this.trackingLost ? 'Show hands' : state.engaged ? '' : this.wasLive ? 'Paused · hold fist' : 'Hold left fist';
    this.status.visible = !!hint && this.clutch.visible;
    if (this.status.visible) {
      this.status.position.copy(this.clutch.position).addScaledVector(HEAD_UP.set(0, 1, 0).applyQuaternion(frame.head.quaternion), -LOOK.hand.clutchRadius - 0.02);
      this.status.quaternion.copy(frame.head.quaternion);
    }
    if (frame.time < this.lastText) this.lastText = -Infinity;
    if (changed || frame.time - this.lastText >= 1000 / TEXT_HZ) { this.lastText = frame.time; setText(this.status, hint || ' '); }
  }

  /** Palm centre (wrist → middle knuckle), offset in head space; returns false when the hand is not tracked. */
  private anchor(object: Mesh, hand: ShellHand | undefined, frame: ShellFrame, x: number, y: number): boolean {
    const wrist = hand?.joints.wrist?.position ?? hand?.grip?.position;
    if (!wrist) return false;
    const knuckle = hand?.joints['middle-finger-metacarpal']?.position;
    this.palm.copy(wrist);
    if (knuckle) this.palm.lerp(knuckle, 0.6);
    object.quaternion.copy(frame.head.quaternion);
    object.position.set(x, y, 0).applyQuaternion(frame.head.quaternion).add(this.palm);
    return true;
  }

  dispose(): void {
    this.status.dispose();
    this.geometry.dispose(); this.clutch.material.dispose(); this.meter.material.dispose();
    this.root.removeFromParent(); this.root.clear();
  }
}
