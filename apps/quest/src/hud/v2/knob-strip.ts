import { CircleGeometry, Group, Mesh, MeshBasicMaterial, Quaternion, ShaderMaterial, Vector3, type Object3D } from 'three';
import type { WireControl } from '@ce/protocol';
import { makeText, setText, type SdfText } from './text';
import { LOOK } from './theme';

/**
 * The AR controls Muse generated for the selected device: a row of large knobs (and buttons/toggles) that float
 * beside it, facing the wearer. Pinch a knob and twist the wrist like a real knob, or pinch and drag up/down;
 * poking it with a fingertip works too. Every change goes out as a `wire:<actionId>` control event, the same route
 * as a hand program, to the connector Muse deployed on the Mac.
 */
interface PointerLike {
  pointerId: number; pointerType?: string; point?: Vector3; pointerQuaternion?: Quaternion;
  stopPropagation?: () => void; target?: Object3D;
}
export type KnobPhase = 'start' | 'move' | 'end';
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const KNOB_R = 0.042;
const PITCH = 0.118;
const SWEEP = 1.5 * Math.PI;
const DRAG_FULL_M = 0.16;
const TWIST_FULL = 200 * Math.PI / 180;
const TWIST_DEAD = 6 * Math.PI / 180;

function display(c: WireControl, fraction: number): string {
  if (c.kind === 'button') return 'press';
  if (c.kind === 'toggle') return fraction >= 0.5 ? 'on' : 'off';
  const min = c.min ?? 0, max = c.max ?? 1, v = min + fraction * (max - min);
  return max - min > 10 ? String(Math.round(v)) : `${Math.round(fraction * 100)}%`;
}

/** One knob / button / toggle. */
class Knob extends Group {
  readonly face: Mesh<CircleGeometry, ShaderMaterial>;
  readonly hit: Mesh<CircleGeometry, MeshBasicMaterial>;
  private readonly label: SdfText;
  private readonly value: SdfText;
  fraction = 0;
  shown = 0;
  dragging = false;
  private hover = 0;
  private hovered = 0;
  private flash = 0;
  private pointerId: number | null = null;
  private startFraction = 0;
  private startY = 0;
  private twistRef: number | null = null;
  private lastEmit = 0;
  /** HUD clock of the last pointer event while dragging (a lost pointerup must not leave the knob stuck). */
  private lastPointerAt = 0;
  private clock = 0;
  private readonly local = new Vector3();
  private readonly right = new Vector3();
  private readonly inverse = new Quaternion();
  private readonly world = new Quaternion();
  onChange?: (c: WireControl, fraction: number, phase: KnobPhase) => void;

  constructor(readonly control: WireControl) {
    super();
    this.name = `knob-${control.id}`;
    const min = control.min ?? 0, max = control.max ?? 1;
    this.fraction = this.shown = control.kind === 'button' ? 0 : Math.max(0, Math.min(1, ((control.value ?? (min + max) / 2) - min) / (max - min || 1)));
    this.face = new Mesh(new CircleGeometry(KNOB_R * 1.32, 64), new ShaderMaterial({
      transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
      uniforms: { r: { value: KNOB_R }, value: { value: this.fraction }, hover: { value: 0 }, flash: { value: 0 }, kind: { value: control.kind === 'button' ? 1 : control.kind === 'toggle' ? 2 : 0 }, fade: { value: 1 } },
      vertexShader: 'varying vec2 vP; void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        varying vec2 vP;
        uniform float r, value, hover, flash, kind, fade;
        const float PI = 3.14159265;
        void main() {
          float d = length(vP);
          float aa = max(fwidth(d), 1e-5);
          // body: dark glass disc with a soft rim
          float body = 1.0 - smoothstep(r - aa, r + aa, d);
          vec3 col = mix(vec3(0.07, 0.075, 0.09), vec3(0.16, 0.17, 0.2), hover * 0.6 + flash);
          float alpha = body * 0.92;
          // track ring outside the body, 270 degrees, gap at the bottom
          float ringR = r * 1.18, th = r * 0.13;
          float a = atan(vP.x, -vP.y); // 0 at the bottom, increasing clockwise as seen
          float t = (a + PI) / (2.0 * PI); // 0..1 around from the bottom
          float sweep = clamp((t - 0.125) / 0.75, 0.0, 1.0);
          float onArc = step(0.125, t) * step(t, 0.875);
          float band = (1.0 - smoothstep(th * 0.5 - aa, th * 0.5 + aa, abs(d - ringR))) * onArc;
          float filled = kind < 0.5 ? step(sweep, value) : kind > 1.5 ? step(0.5, value) : flash;
          vec3 accent = vec3(0.55, 0.85, 1.0);
          vec3 ringCol = mix(vec3(1.0), accent, filled);
          float ringA = band * mix(0.22 + hover * 0.15, 1.0, filled);
          col = mix(col, ringCol, ringA); alpha = max(alpha, ringA);
          // indicator: a line from the centre toward the value angle (knobs only)
          if (kind < 0.5) {
            float va = -PI + (0.125 + value * 0.75) * 2.0 * PI;
            vec2 dir = vec2(sin(va), -cos(va));
            float along = dot(vP, dir);
            float off = abs(dot(vP, vec2(-dir.y, dir.x)));
            float ind = (1.0 - smoothstep(r * 0.05 - aa, r * 0.05 + aa, off)) * step(r * 0.45, along) * step(along, r * 0.88);
            col = mix(col, vec3(1.0), ind); alpha = max(alpha, ind);
          } else {
            float dot0 = 1.0 - smoothstep(r * 0.3 - aa, r * 0.3 + aa, d);
            float lit = kind > 1.5 ? step(0.5, value) : flash;
            col = mix(col, mix(vec3(0.35), accent, lit), dot0); alpha = max(alpha, dot0);
          }
          gl_FragColor = vec4(col, alpha * fade);
          #include <colorspace_fragment>
        }`,
    }));
    this.face.renderOrder = LOOK.render.dials;
    this.face.frustumCulled = false;
    this.face.raycast = () => {};
    // Invisible, generous hit disc (pmndrs pointer-events: ray, poke, mouse).
    this.hit = new Mesh(new CircleGeometry(KNOB_R * 1.5, 24), new MeshBasicMaterial({ visible: false }));
    this.hit.name = `knob-hit-${control.id}`;
    this.label = makeText({ text: control.label, size: 0.0125, anchorX: 'center', anchorY: 'top', weight: 600, singleLine: true, maxWidth: PITCH - 0.01 });
    this.label.position.set(0, -KNOB_R * 1.42, 0.001);
    this.value = makeText({ text: display(control, this.fraction), size: 0.011, anchorX: 'center', anchorY: 'middle', tabular: true, color: '#cfd6e4' });
    this.value.position.set(0, 0, 0.002);
    // Text draws after the knob face (both skip the depth test).
    this.label.renderOrder = this.value.renderOrder = LOOK.render.dials + 2;
    this.add(this.face, this.hit, this.label, this.value);
    this.hit.addEventListener('pointerdown' as never, ((e: PointerLike) => this.press(e)) as never);
    this.hit.addEventListener('pointermove' as never, ((e: PointerLike) => this.drag(e)) as never);
    this.hit.addEventListener('pointerup' as never, ((e: PointerLike) => this.release(e)) as never);
    this.hit.addEventListener('pointercancel' as never, ((e: PointerLike) => this.release(e)) as never);
    this.hit.addEventListener('pointerenter' as never, (() => { this.hovered++; }) as never);
    this.hit.addEventListener('pointerleave' as never, (() => { this.hovered = Math.max(0, this.hovered - 1); }) as never);
  }

  private press(e: PointerLike): void {
    if (this.dragging) return;
    e.stopPropagation?.();
    if (this.control.kind === 'button') { this.flash = 1; this.onChange?.(this.control, 1, 'end'); return; }
    if (this.control.kind === 'toggle') { this.fraction = this.fraction >= 0.5 ? 0 : 1; this.flash = 0.6; this.onChange?.(this.control, this.fraction, 'end'); return; }
    this.pointerId = e.pointerId; this.dragging = true; this.twistRef = null; this.startFraction = this.fraction; this.lastPointerAt = this.clock;
    this.startY = e.point ? this.worldToLocal(this.local.copy(e.point)).y : 0;
    try { (e.target ?? this.hit as Object3D as never as { setPointerCapture?: (id: number) => void }).setPointerCapture?.(e.pointerId); } catch { /* released */ }
    this.onChange?.(this.control, this.fraction, 'start');
  }
  private drag(e: PointerLike): void {
    if (!this.dragging || e.pointerId !== this.pointerId) return;
    this.lastPointerAt = this.clock;
    this.apply(e, 'move');
  }
  private release(e: PointerLike): void {
    if (!this.dragging || e.pointerId !== this.pointerId) return;
    this.apply(e, 'end');
    this.dragging = false; this.pointerId = null; this.twistRef = null;
  }
  private apply(e: PointerLike, phase: KnobPhase): void {
    let f = this.startFraction;
    // Drag up/down: 16 cm of travel is the whole range.
    if (e.point) f += (this.worldToLocal(this.local.copy(e.point)).y - this.startY) / DRAG_FULL_M;
    // Pinch and twist: wrist roll turns it like a real knob (clockwise = up).
    if (e.pointerQuaternion && e.pointerType !== 'touch' && e.pointerType !== 'mouse') {
      this.getWorldQuaternion(this.world); this.inverse.copy(this.world).invert();
      this.right.set(1, 0, 0).applyQuaternion(e.pointerQuaternion).applyQuaternion(this.inverse);
      const roll = Math.atan2(this.right.y, this.right.x);
      if (this.twistRef === null) this.twistRef = roll;
      const delta = wrap(roll - this.twistRef);
      if (Math.abs(delta) > TWIST_DEAD) f += -(delta - Math.sign(delta) * TWIST_DEAD) / TWIST_FULL;
    }
    this.fraction = Math.max(0, Math.min(1, f));
    if (phase === 'move' && this.clock - this.lastEmit < 1 / 30) return;
    this.lastEmit = this.clock;
    this.onChange?.(this.control, this.fraction, phase);
  }

  /** End a drag whose pointerup never arrived (hand tracking lost mid-pinch). */
  cancel(): void {
    if (!this.dragging) return;
    this.dragging = false; this.pointerId = null; this.twistRef = null;
    this.onChange?.(this.control, this.fraction, 'end');
  }

  update(dt: number, opacity: number): void {
    if (this.dragging && this.clock - this.lastPointerAt > 3) this.cancel();
    this.clock += dt;
    const k = 1 - Math.exp(-18 * Math.min(0.1, dt));
    this.shown += (this.fraction - this.shown) * (this.dragging ? 1 : k);
    this.hover += ((this.hovered > 0 || this.dragging ? 1 : 0) - this.hover) * Math.min(1, dt * 12);
    this.flash = Math.max(0, this.flash - dt * 2.5);
    const u = this.face.material.uniforms;
    u.value!.value = this.control.kind === 'button' ? 0 : this.shown; u.hover!.value = this.hover; u.flash!.value = this.flash; u.fade!.value = opacity;
    (this.hit as unknown as { pointerEvents: string }).pointerEvents = opacity > 0.5 ? 'auto' : 'none';
    setText(this.value, display(this.control, this.shown));
    this.label.visible = this.value.visible = opacity > 0.3;
  }

  override clear(): this { this.face.geometry.dispose(); this.face.material.dispose(); this.hit.geometry.dispose(); this.label.dispose(); this.value.dispose(); return super.clear(); }
}

/** A row of generated controls. `set()` replaces them; `place()` keeps the row beside the device, facing the head. */
export class KnobStrip extends Group {
  private knobs: Knob[] = [];
  private key = '';
  private opacity = 0;
  private shown = false;
  private readonly desired = new Vector3();
  private readonly look = new Vector3();
  private placed = false;
  onChange?: (c: WireControl, value: number, phase: KnobPhase) => void;

  constructor() {
    super();
    this.name = 'generated-controls';
    this.visible = false;
  }

  /** Controls to show (null hides them). Same ids keep their current values. */
  set(controls: WireControl[] | null): void {
    const key = controls ? controls.map((c) => `${c.id}:${c.kind}:${c.label}`).join('|') : '';
    this.shown = !!controls?.length;
    if (key === this.key) return;
    this.key = key;
    for (const k of this.knobs) { this.remove(k); k.clear(); }
    this.knobs = (controls ?? []).slice(0, 8).map((c, i, all) => {
      const k = new Knob(c);
      k.position.set((i - (all.length - 1) / 2) * PITCH, 0, 0);
      k.onChange = (control, fraction, phase) => {
        const min = control.min ?? 0, max = control.max ?? 1;
        const value = control.kind === 'button' ? 1 : control.kind === 'toggle' ? fraction : min + fraction * (max - min);
        this.onChange?.(control, value, phase);
      };
      this.add(k);
      return k;
    });
    this.placed = false;
  }

  /** Values in use (for automation and the debug snapshot). */
  snapshot(): { id: string; actionId: string; label: string; fraction: number }[] {
    return this.knobs.map((k) => ({ id: k.control.id, actionId: k.control.actionId, label: k.control.label, fraction: Math.round(k.fraction * 1000) / 1000 }));
  }

  /** A knob is being turned right now (the wrist menu and both-palms Stop stay out of the way). */
  get interacting(): boolean { return this.knobs.some((k) => k.dragging); }

  /** End every drag (input surface changed, session hidden). */
  cancel(): void { for (const k of this.knobs) k.cancel(); }

  /** Beside/below the device: `anchor` is where the row should be centred, `head` is the wearer's eye position. */
  place(anchor: Vector3, head: Vector3, dt: number): void {
    // Hold still while a knob is turned: moving the row under the hand would turn the drag into a jump.
    if (this.interacting && this.placed) return;
    this.desired.copy(anchor);
    if (!this.placed) { this.position.copy(this.desired); this.placed = true; }
    else this.position.lerp(this.desired, 1 - Math.exp(-6 * Math.min(0.1, dt)));
    this.look.set(head.x, this.position.y, head.z);
    this.lookAt(this.look);
  }

  update(dt: number): void {
    this.opacity += ((this.shown ? 1 : 0) - this.opacity) * Math.min(1, dt * 8);
    this.visible = this.opacity > 0.01;
    for (const k of this.knobs) k.update(dt, this.opacity);
  }
}
