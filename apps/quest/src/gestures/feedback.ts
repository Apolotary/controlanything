import { Group, Mesh, PlaneGeometry, ShaderMaterial, Vector3, type Scene } from 'three';
import type { ShellFrame, ShellHand } from '../app/hud-contract';
import { makeText, setText } from '../hud/v2/text';
import { LOOK } from '../hud/v2/theme';

export interface GestureFeedbackState {
  engaged: boolean;
  trackingLost?: boolean;
  /** 'zone' = hands-first play zone (no clutch ring); 'clutch' = the left-fist clutch. */
  mode?: 'clutch' | 'zone';
  axes: readonly { axis: string; actionId: string; label: string; value: number; normalized: number }[];
}

/**
 * Live Perform values at frame rate, keyed by action id (e.g. 'cc71'). The spatial arc dials read this so the
 * "AR knobs" move with the hand in real time instead of the 5 Hz HUD mirror.
 */
export const liveGesture = { engaged: false, active: false, at: 0, values: new Map<string, number>() };

const TEXT_HZ = 4;
const HEAD_UP = new Vector3();
const HINT_SIZE = 0.0105;
/** First-use hint timing (ms): shown when hands start, then once more on the first idle. */
export const HINT = { showMs: 6000, idleMs: 5000, againMs: 3500, fadeMs: 450, flashMs: 1400 } as const;

/** Words for each performance axis in the hint ("↑↓ Warp · push/pull Ripples"). */
const AXIS_WORDS: Record<string, string> = {
  right_height: '↑↓', right_depth: 'push / pull', right_roll: 'twist', right_pinch_aperture: 'open / close', two_hand_distance: 'spread',
};
function shortLabel(label: string): string { return /ripple/i.test(label) ? 'Ripples' : label.replace(/\s+/g, ' ').trim().slice(0, 14); }

/** The compact first-use hint, built from the live map (Horizon tone: short lines, no jargon). */
export function gestureHintText(axes: readonly { axis: string; label: string }[], patterns: boolean): string {
  const moves = axes.slice(0, 2).map((axis) => `${AXIS_WORDS[axis.axis] ?? axis.axis} ${shortLabel(axis.label)}`).join('  ·  ');
  return ['Raise your right hand to play', moves, `${patterns ? 'Pinch: next pattern  ·  ' : ''}Fist: hold`, 'Both palms out: stop'].filter(Boolean).join('\n');
}

/**
 * Hand feedback while hands control a device (fingertip dots stay in app/hand-feedback.ts):
 * - a small value ring beside the right hand: one concentric arc per performance axis (Warp outer, Ripples inner);
 *   bright while the hand is playing, dim while it holds;
 * - zone mode: a short first-use hint near the right hand (or low in front when it is not tracked), and a brief
 *   pattern name after a pinch-tap;
 * - clutch mode: a clutch ring around the left hand with one short hint under it ("Hold left fist").
 * Five draws at most; text refreshes at 4 Hz.
 */
export class GestureFeedback {
  readonly root = new Group();
  private readonly geometry = new PlaneGeometry(1, 1);
  private readonly clutch: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly meter: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly hintPlate: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly status = makeText({ text: 'Hold fist', size: 0.0135, anchorX: 'center', singleLine: true, maxWidth: 0.2, weight: 600 });
  private readonly hint = makeText({ text: ' ', size: HINT_SIZE, anchorX: 'center', anchorY: 'middle', align: 'center', weight: 500 });
  private readonly palm = new Vector3();
  private readonly hintAt = new Vector3();
  private readonly hintGoal = new Vector3();
  private hintPlaced = false;
  private lastText = -Infinity;
  private wasLive = false;
  private engaged = false;
  private trackingLost = false;
  private grip = 0;
  // Hint schedule (frame time, ms).
  private hintText = '';
  private hintFrom = -Infinity;
  private hintUntil = -Infinity;
  private hintAgain = false;
  private idleSince = -Infinity;
  private hintAlpha = 0;
  private flashText = '';
  private flashUntil = -Infinity;
  private shownStatus = '';

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
    // Hint backdrop: a dark rounded plate (LOOK.plate), sized to the text block.
    this.hintPlate = ring(`
      uniform float alpha; uniform vec2 size;
      void main() {
        vec2 p = (vUv - 0.5) * size; vec2 q = abs(p) - size * 0.5 + 0.012;
        float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.012;
        float aa = max(fwidth(d), 1e-5);
        gl_FragColor = vec4(vec3(0.086, 0.086, 0.106), (1.0 - smoothstep(-aa, aa, d)) * ${LOOK.plate.alpha.toFixed(2)} * alpha);
        #include <colorspace_fragment>
      }`, { alpha: { value: 0 }, size: { value: [0.2, 0.08] } });
    this.hintPlate.name = 'gesture-hint-plate';
    this.hintPlate.renderOrder = LOOK.render.hands + 1;
    this.hint.name = 'gesture-hint';
    this.hint.renderOrder = LOOK.render.hands + 2;
    this.status.name = 'gesture-live';
    this.status.renderOrder = LOOK.render.hands + 2;
    this.root.add(this.clutch, this.meter, this.hintPlate, this.hint, this.status);
    scene.add(this.root);
  }

  /** Show the first-use hint now (hands just started). `text` is from gestureHintText. */
  showHint(text: string, nowMs: number): void {
    this.hintText = text;
    this.hintFrom = nowMs; this.hintUntil = nowMs + HINT.showMs;
    this.hintAgain = false; this.idleSince = -Infinity;
    setText(this.hint, text);
    this.sizePlate();
  }

  /** A brief label beside the right hand, e.g. the pattern a pinch-tap chose ("Rings"). */
  flash(text: string, nowMs: number): void {
    this.flashText = text; this.flashUntil = nowMs + HINT.flashMs;
    this.lastText = -Infinity;
  }

  /** Read by tests and the e2e judge. */
  get hintVisible(): boolean { return this.root.visible && this.hint.visible && this.hintAlpha > 0.05; }

  update(frame: ShellFrame, state: GestureFeedbackState | null): void {
    this.root.visible = state !== null;
    liveGesture.active = state !== null;
    if (!state) {
      this.wasLive = false; this.lastText = -Infinity; liveGesture.engaged = false;
      this.hintUntil = -Infinity; this.hintAlpha = 0; this.hintPlaced = false; this.flashUntil = -Infinity;
      return;
    }
    const zone = state.mode === 'zone';
    const dt = Math.min(0.1, Math.max(0, frame.dt));
    const changed = this.engaged !== state.engaged || this.trackingLost !== !!state.trackingLost;
    this.engaged = state.engaged; this.trackingLost = !!state.trackingLost;
    this.wasLive ||= state.engaged;
    liveGesture.engaged = state.engaged; liveGesture.at = frame.time;
    for (const axis of state.axes) if (Number.isFinite(axis.normalized)) liveGesture.values.set(axis.actionId, Math.max(0, Math.min(1, axis.normalized)));

    this.grip += ((state.engaged ? 1 : 0) - this.grip) * Math.min(1, dt * 14);
    const left = frame.hands.left, right = frame.hands.right;
    this.clutch.visible = !zone && this.anchor(this.clutch, left, frame, 0, 0);
    this.clutch.material.uniforms.grip!.value = this.grip;
    this.clutch.material.uniforms.lost!.value = this.trackingLost ? 1 : 0;
    this.clutch.scale.setScalar(LOOK.hand.clutchRadius * 2.6 * (1 + 0.08 * this.grip));
    const count = Math.min(2, state.axes.length);
    this.meter.visible = count > 0 && this.anchor(this.meter, right, frame, 0.075, 0.06);
    const u = this.meter.material.uniforms;
    const norm = (i: number) => { const v = state.axes[i]?.normalized ?? 0; return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0; };
    u.v0!.value = norm(0); u.v1!.value = norm(1); u.count!.value = count; u.live!.value = state.engaged ? 1 : 0;

    if (frame.time < this.lastText) this.lastText = -Infinity;
    if (zone) this.updateZone(frame, state, right, changed, dt);
    else {
      const hint = this.trackingLost ? 'Show hands' : state.engaged ? '' : this.wasLive ? 'Paused · hold fist' : 'Hold left fist';
      this.hint.visible = this.hintPlate.visible = false;
      this.status.visible = !!hint && this.clutch.visible;
      if (this.status.visible) {
        this.status.position.copy(this.clutch.position).addScaledVector(HEAD_UP.set(0, 1, 0).applyQuaternion(frame.head.quaternion), -LOOK.hand.clutchRadius - 0.02);
        this.status.quaternion.copy(frame.head.quaternion);
      }
      if (changed || frame.time - this.lastText >= 1000 / TEXT_HZ) { this.lastText = frame.time; setText(this.status, hint || ' '); }
    }
  }

  private updateZone(frame: ShellFrame, state: GestureFeedbackState, right: ShellHand | undefined, changed: boolean, dt: number): void {
    const now = frame.time;
    // First idle after the first hint: the hand has not played for HINT.idleMs → show it once more, briefly.
    if (state.engaged) this.idleSince = -Infinity;
    else if (!Number.isFinite(this.idleSince)) this.idleSince = now;
    if (this.hintText && !this.hintAgain && now > this.hintUntil + 500 && !state.engaged && now - this.idleSince >= HINT.idleMs) {
      this.hintAgain = true; this.hintFrom = now; this.hintUntil = now + HINT.againMs;
    }
    const showing = !!this.hintText && now >= this.hintFrom && now < this.hintUntil;
    const target = showing ? Math.min(1, (this.hintUntil - now) / HINT.fadeMs) : 0;
    this.hintAlpha += (target - this.hintAlpha) * Math.min(1, dt / (LOOK.motion.appearS / 3));
    const hintOn = this.hintAlpha > 0.02;
    this.hint.visible = this.hintPlate.visible = hintOn;
    // Beside the right hand while it is tracked, otherwise low in front of the view; eased so it never jitters.
    const wrist = right?.joints.wrist?.position;
    if (wrist && this.meter.visible) {
      this.hintGoal.set(0, 0.13, 0).applyQuaternion(frame.head.quaternion).add(this.meter.position);
    } else {
      this.hintGoal.set(0.06, -0.2, -0.55).applyQuaternion(frame.head.quaternion).add(frame.head.position);
    }
    if (!this.hintPlaced || !hintOn) { this.hintAt.copy(this.hintGoal); this.hintPlaced = hintOn; }
    else this.hintAt.lerp(this.hintGoal, Math.min(1, dt * 10));
    if (hintOn) {
      this.hint.position.copy(this.hintAt); this.hint.quaternion.copy(frame.head.quaternion);
      this.hintPlate.position.copy(this.hintAt).addScaledVector(HEAD_UP.set(0, 0, -1).applyQuaternion(frame.head.quaternion), 0.0005);
      this.hintPlate.quaternion.copy(frame.head.quaternion);
      (this.hint as unknown as { fillOpacity: number }).fillOpacity = this.hintAlpha;
      this.hintPlate.material.uniforms.alpha!.value = this.hintAlpha;
    }
    // Status: the pattern name for a moment after a pinch-tap (the hint covers everything else).
    const status = now < this.flashUntil ? this.flashText : '';
    this.status.visible = !!status && this.meter.visible;
    if (this.status.visible) {
      this.status.position.copy(this.meter.position).addScaledVector(HEAD_UP.set(0, 1, 0).applyQuaternion(frame.head.quaternion), LOOK.hand.valueRadius * 1.25 + 0.016);
      this.status.quaternion.copy(frame.head.quaternion);
    }
    if (status !== this.shownStatus) { this.lastText = now; this.shownStatus = status; setText(this.status, status || ' '); }
    void changed;
  }

  private sizePlate(): void {
    const apply = () => {
      const bounds = this.hint.textRenderInfo?.blockBounds;
      const w = bounds ? bounds[2] - bounds[0] : 0.2, h = bounds ? bounds[3] - bounds[1] : 0.06;
      const pad = 0.012;
      this.hintPlate.scale.set(w + pad * 2, h + pad * 2, 1);
      this.hintPlate.material.uniforms.size!.value = [w + pad * 2, h + pad * 2];
    };
    apply();
    this.hint.sync?.(apply);
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
    this.status.dispose(); this.hint.dispose();
    this.geometry.dispose(); this.clutch.material.dispose(); this.meter.material.dispose(); this.hintPlate.material.dispose();
    this.root.removeFromParent(); this.root.clear();
  }
}
