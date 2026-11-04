import { Group, Matrix4, Mesh, MeshBasicMaterial, Quaternion, RingGeometry, ShaderMaterial, Vector3, type Object3D } from 'three';
import { Container, Text } from '@pmndrs/uikit';
import { arcFraction } from './control-shape';
import { FONT, FlatMaterial, isBrowser } from './look';
import { ScreenRing, type RingMode } from './setup-ring';
import { LOOK } from './theme';

/**
 * Spatial controls on the selected screen: two large arc dials hugging its left and right edges, like "( screen )",
 * plus the ring around it. Pinch-drag along an arc (ray), poke it (touch) or pinch and twist the wrist; during
 * Perform the arcs follow the live hand value. Input is pmndrs pointer-events (from @iwsdk/xr-input or the
 * desktop mouse): pointerdown + setPointerCapture, so a drag keeps its dial even when the ray leaves the band.
 */
export type DialSide = 'left' | 'right';
export interface DialModel { id: string; label: string; fraction: number; display: string }
export type DialPhase = 'start' | 'move' | 'end';
export type DialMode = 'hidden' | 'setup' | 'waiting' | 'armed' | 'perform';

interface PointerLike {
  pointerId: number; pointerType?: string; point?: Vector3; pointerQuaternion?: Quaternion;
  stopPropagation?: () => void; target?: Object3D;
}
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const TWIST_DEAD = 10 * Math.PI / 180, TWIST_FULL = 120 * Math.PI / 180;

/** One arc: one shader draw for track + fill + knob, one invisible (non-drawing) hit band. */
export class ArcDial extends Group {
  readonly hit: Mesh<RingGeometry, MeshBasicMaterial>;
  readonly arc: Mesh<RingGeometry, ShaderMaterial>;
  /** Arc centre in the rig's plane and the angles of value 0 (bottom) and 1 (top). */
  readonly center = { x: 0, y: 0 };
  from = 0;
  to = 0;
  radius = 0.1;
  model: DialModel | null = null;
  shown = 0;
  target = 0;
  interactive = false;
  dragging = false;
  private hover = 0;
  private hovered = 0;
  private live = 0;
  private pointerId: number | null = null;
  private twistRef: number | null = null;
  private lastEmit = 0;
  private clock = 0;
  private readonly local = new Vector3();
  private readonly right = new Vector3();
  private readonly inverse = new Quaternion();
  private readonly world = new Quaternion();
  onChange?: (id: string, fraction: number, phase: DialPhase) => void;

  constructor(readonly side: DialSide) {
    super();
    this.name = `dial-${side}`;
    this.arc = new Mesh(new RingGeometry(0.09, 0.11, 48, 1), new ShaderMaterial({
      transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
      uniforms: {
        radius: { value: 0.1 }, thick: { value: LOOK.dial.track }, knobR: { value: LOOK.dial.knob }, from: { value: 0 }, sweep: { value: 1 },
        value: { value: 0 }, hover: { value: 0 }, live: { value: 0 }, fade: { value: 0 }, trackAlpha: { value: LOOK.dial.trackAlpha },
      },
      vertexShader: 'varying vec2 vP; void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        varying vec2 vP;
        uniform float radius, thick, knobR, from, sweep, value, hover, live, fade, trackAlpha;
        float wrapA(float a) { return atan(sin(a), cos(a)); }
        void main() {
          float t = wrapA(atan(vP.y, vP.x) - from) / sweep;
          float tc = clamp(t, 0.0, 1.0);
          float ac = from + sweep * tc;
          float d = length(vP - radius * vec2(cos(ac), sin(ac))) - thick * 0.5;
          float aa = max(fwidth(d), 1e-5);
          float band = 1.0 - smoothstep(-aa, aa, d);
          float te = aa / (radius * abs(sweep));
          float filled = 1.0 - smoothstep(value - te, value + te, tc);
          // Premultiplied layers: dark contact shadow (reads over a bright wall) < track/fill < halo < knob.
          float shadow = (1.0 - smoothstep(-aa, aa, d - 0.0035)) * 0.34;
          float trackA = band * mix(trackAlpha + hover * 0.12, 0.96, filled);
          float alpha = trackA + shadow * (1.0 - trackA);
          vec3 color = vec3(trackA);
          float halo = (1.0 - smoothstep(0.0, thick * 0.9, max(d, 0.0))) * (1.0 - band) * (hover * 0.28 + live * 0.22);
          color = color * (1.0 - halo) + vec3(halo); alpha = halo + alpha * (1.0 - halo);
          // Knob: dark disk in a white ring (inspiration f017/f021).
          float av = from + sweep * value;
          float dk = length(vP - radius * vec2(cos(av), sin(av)));
          float kr = knobR * (1.0 + hover * 0.15);
          float outer = 1.0 - smoothstep(kr - aa, kr + aa, dk);
          float inner = 1.0 - smoothstep(kr * 0.64 - aa, kr * 0.64 + aa, dk);
          color = color * (1.0 - outer) + vec3(outer); alpha = outer + alpha * (1.0 - outer);
          color = mix(color, vec3(0.07, 0.07, 0.09), inner);
          color /= max(alpha, 1e-4);
          gl_FragColor = vec4(color, alpha * fade);
          #include <colorspace_fragment>
        }`,
    }));
    this.arc.name = `dial-arc-${side}`;
    this.arc.renderOrder = LOOK.render.dials;
    this.arc.frustumCulled = false;
    this.arc.raycast = () => {};
    // Never drawn (material.visible = false) but raycast by pointer-events; generous ±2.6 cm band.
    this.hit = new Mesh(new RingGeometry(0.07, 0.13, 24, 1), new MeshBasicMaterial({ visible: false }));
    this.hit.name = `dial-hit-${side}`;
    (this.hit as unknown as { pointerEvents: string }).pointerEvents = 'none';
    this.add(this.arc, this.hit);
    this.hit.addEventListener('pointerdown' as never, ((e: PointerLike) => this.press(e)) as never);
    this.hit.addEventListener('pointermove' as never, ((e: PointerLike) => this.drag(e)) as never);
    this.hit.addEventListener('pointerup' as never, ((e: PointerLike) => this.release(e)) as never);
    this.hit.addEventListener('pointercancel' as never, ((e: PointerLike) => this.release(e)) as never);
    this.hit.addEventListener('pointerenter' as never, (() => { this.hovered++; }) as never);
    this.hit.addEventListener('pointerleave' as never, (() => { this.hovered = Math.max(0, this.hovered - 1); }) as never);
  }

  /** Lay the arc along one edge of a w × h screen centred at the rig origin. */
  layout(w: number, h: number): void {
    const { sweepDeg, gap, track, knob } = LOOK.dial;
    const half = sweepDeg / 2 * Math.PI / 180;
    const radius = Math.max(0.06, (h / 2) * 0.92 / Math.sin(half));
    const edge = w / 2 + gap + track / 2;
    const cx = (-edge + radius * Math.cos(half)) * (this.side === 'left' ? 1 : -1);
    const mid = this.side === 'left' ? Math.PI : 0;
    // Value 0 at the bottom end, 1 at the top end.
    this.from = this.side === 'left' ? mid + half : mid - half;
    this.to = this.side === 'left' ? mid - half : mid + half;
    const changed = Math.abs(radius - this.radius) > 0.002 || Math.abs(cx - this.center.x) > 0.002;
    this.center.x = cx; this.center.y = 0; this.radius = radius;
    this.arc.position.set(cx, 0, 0.002); this.hit.position.set(cx, 0, 0.002);
    const u = this.arc.material.uniforms;
    u.radius!.value = radius; u.from!.value = this.from; u.sweep!.value = wrap(this.to - this.from);
    if (!changed && this.arc.geometry.parameters.innerRadius > 0.0001) return;
    const margin = (knob + 0.006) / radius, start = Math.min(this.from, this.to) - margin, length = half * 2 + margin * 2;
    this.arc.geometry.dispose();
    this.arc.geometry = new RingGeometry(radius - knob - 0.004, radius + knob + 0.004, 48, 1, start, length);
    this.hit.geometry.dispose();
    this.hit.geometry = new RingGeometry(radius - track / 2 - 0.026, radius + track / 2 + 0.026, 24, 1, start, length);
  }

  /** Top end of the arc in rig coordinates (where its label pill sits). */
  topEnd(out: { x: number; y: number }): { x: number; y: number } {
    out.x = this.center.x + this.radius * Math.cos(this.to); out.y = this.radius * Math.sin(this.to);
    return out;
  }

  setModel(model: DialModel | null): void {
    this.model = model;
    if (model && !this.dragging) this.target = Math.max(0, Math.min(1, model.fraction));
    this.setInteractive(this.interactive);
  }

  setInteractive(on: boolean): void {
    this.interactive = on && !!this.model;
    (this.hit as unknown as { pointerEvents: string }).pointerEvents = this.interactive && this.visible ? 'auto' : 'none';
    if (!this.interactive && this.dragging) this.finish();
  }

  setLive(live: boolean): void { this.live = live ? 1 : 0; }

  private press(e: PointerLike): void {
    if (!this.interactive || !this.model || this.dragging) return;
    e.stopPropagation?.();
    this.pointerId = e.pointerId; this.dragging = true; this.twistRef = null;
    try { (e.target ?? this.hit).setPointerCapture?.(e.pointerId); } catch { /* pointer already released */ }
    this.apply(e, 'start');
  }
  private drag(e: PointerLike): void {
    if (!this.dragging || e.pointerId !== this.pointerId) return;
    this.apply(e, 'move');
  }
  private release(e: PointerLike): void {
    if (!this.dragging || e.pointerId !== this.pointerId) return;
    this.apply(e, 'end');
    this.finish(false);
  }
  private finish(emit = true): void {
    const id = this.model?.id, value = this.target;
    this.dragging = false; this.pointerId = null; this.twistRef = null;
    if (emit && id) this.onChange?.(id, value, 'end');
  }

  private apply(e: PointerLike, phase: DialPhase): void {
    if (!this.model) return;
    let fraction = this.target;
    if (e.point) {
      this.local.copy(e.point); this.worldToLocal(this.local);
      fraction = arcFraction(this.local, this.center, this.from, this.to, this.target, this.radius * 0.3);
    }
    // Pinch-and-twist: wrist roll (the pointer's right axis, seen in the dial plane) adds to the arc position.
    if (e.pointerQuaternion && e.pointerType !== 'touch' && e.pointerType !== 'mouse') {
      this.getWorldQuaternion(this.world); this.inverse.copy(this.world).invert();
      this.right.set(1, 0, 0).applyQuaternion(e.pointerQuaternion).applyQuaternion(this.inverse);
      const roll = Math.atan2(this.right.y, this.right.x);
      if (this.twistRef === null) this.twistRef = roll;
      const delta = wrap(roll - this.twistRef);
      // Clockwise (as the wearer sees it) turns the value up, like a real knob.
      if (Math.abs(delta) > TWIST_DEAD) fraction = fraction + -(delta - Math.sign(delta) * TWIST_DEAD) / TWIST_FULL;
    }
    this.target = Math.max(0, Math.min(1, fraction));
    if (phase === 'move' && this.clock - this.lastEmit < 1 / 15) return;
    this.lastEmit = this.clock;
    this.onChange?.(this.model.id, this.target, phase);
  }

  /** Critically damped follow of the target value (drag or live hand value), plus hover easing. */
  update(dt: number, opacity: number): void {
    this.clock += dt;
    const k = 1 - Math.exp(-LOOK.dial.smoothing * Math.min(0.1, dt));
    this.shown += (this.target - this.shown) * (this.dragging ? 1 : k);
    this.hover += ((this.hovered > 0 || this.dragging ? 1 : 0) - this.hover) * Math.min(1, dt * 12);
    const u = this.arc.material.uniforms;
    u.value!.value = this.shown; u.hover!.value = this.hover; u.live!.value = this.live; u.fade!.value = opacity;
    this.userData.fraction = this.shown;
  }

  override dispose(): void { this.arc.geometry.dispose(); this.arc.material.dispose(); this.hit.geometry.dispose(); this.hit.material.dispose(); }
}

/** The ring + two dials + one uikit label root (white pills: one panel batch, one glyph batch). */
export class DialRig extends Group {
  readonly ring = new ScreenRing();
  readonly left = new ArcDial('left');
  readonly right = new ArcDial('right');
  private readonly labels?: Container;
  private readonly pills: { box: Container; text: Text; shown: string }[] = [];
  private readonly orientation = new Quaternion();
  private readonly desired = new Quaternion();
  private readonly frame = new Matrix4();
  private readonly end = { x: 0, y: 0 };
  private readonly position0 = new Vector3();
  private mode: DialMode = 'hidden';
  private opacity = 0;
  private placed = false;
  private w = 0;
  private h = 0;
  private labelClock = 0;

  constructor() {
    super();
    this.name = 'spatial-controls';
    this.visible = false;
    this.add(this.ring, this.left, this.right);
    if (!isBrowser) return;
    this.labels = new Container({
      sizeX: 0.6, sizeY: 0.05, pixelSize: LOOK.pixelSize, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
      renderOrder: LOOK.render.labels, depthTest: false, depthWrite: false, pointerEvents: 'none', ...FONT,
    } as never);
    this.labels.name = 'dial-labels';
    for (let i = 0; i < 2; i++) {
      const slot = new Container({ width: 200, flexDirection: 'row', justifyContent: 'center' });
      // Far labels (the device is ~1 m away) are 1.4× the card's pill size.
      const box = new Container({ height: 42, paddingX: 16, borderRadius: 1000, alignItems: 'center', flexDirection: 'row',
        backgroundColor: LOOK.pill.light, panelMaterialClass: FlatMaterial });
      const text = new Text({ text: '', fontSize: 20, fontWeight: 'medium', color: LOOK.text.onLight, whiteSpace: 'nowrap' } as never);
      box.add(text); slot.add(box); this.labels.add(slot);
      this.pills.push({ box, text, shown: '' });
    }
    this.add(this.labels);
  }

  get uiRoot(): { update(dtMs: number): void } | undefined { return this.labels; }
  get dials(): ArcDial[] { return [this.left, this.right]; }

  setMode(mode: DialMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.userData.mode = mode;
    const ring: RingMode = mode === 'hidden' ? 'hidden' : mode === 'setup' ? 'setup' : mode === 'perform' ? 'live' : 'quiet';
    this.ring.setMode(ring);
    for (const dial of this.dials) {
      dial.visible = mode === 'waiting' || mode === 'armed' || mode === 'perform';
      dial.setLive(mode === 'perform');
      // Hands perform freely: the dials only display during Perform.
      dial.setInteractive(mode === 'armed');
    }
    this.labels?.setProperties({ visibility: mode === 'waiting' || mode === 'armed' || mode === 'perform' ? 'visible' : 'hidden' });
    if (mode === 'hidden') this.placed = false;
  }

  setDials(left: DialModel | null, right: DialModel | null): void {
    this.left.setModel(left); this.right.setModel(right);
    this.left.visible = !!left && (this.mode === 'waiting' || this.mode === 'armed' || this.mode === 'perform');
    this.right.visible = !!right && (this.mode === 'waiting' || this.mode === 'armed' || this.mode === 'perform');
    this.left.setInteractive(this.mode === 'armed'); this.right.setInteractive(this.mode === 'armed');
  }

  /** Follow the device box; orientation is re-aimed only when the view changes by > 25° (no swimming). */
  place(center: Vector3, w: number, h: number, facing: Quaternion, dt: number): void {
    const W = Math.max(LOOK.dial.minW, Math.min(LOOK.dial.maxW, w)), H = Math.max(LOOK.dial.minH, Math.min(LOOK.dial.maxH, h));
    if (Math.abs(W - this.w) > 0.004 || Math.abs(H - this.h) > 0.004) {
      this.w = W; this.h = H;
      this.ring.setSize(W, H); this.left.layout(W, H); this.right.layout(W, H);
      if (this.labels) {
        this.left.topEnd(this.end);
        const span = Math.abs(this.end.x) * 2 + 0.2;
        this.labels.setProperties({ sizeX: span });
        this.labels.position.set(0, this.end.y + LOOK.dial.knob + 0.036, 0.004);
      }
    }
    this.desired.copy(facing);
    if (!this.placed || this.orientation.angleTo(this.desired) > 25 * Math.PI / 180) { this.orientation.copy(this.desired); this.placed = true; }
    if (this.position0.distanceToSquared(center) > 1e-8) this.position0.copy(center);
    this.position.copy(this.position0);
    this.quaternion.slerp(this.orientation, this.placed && dt > 0 ? Math.min(1, dt * 8) : 1);
    this.frame.identity();
  }

  update(dt: number, visible: boolean, updateRoot = true): void {
    this.opacity += ((visible && this.mode !== 'hidden' ? 1 : 0) - this.opacity) * Math.min(1, dt / LOOK.motion.appearS * 3);
    this.visible = this.opacity > 0.01;
    for (const dial of this.dials) {
      dial.update(dt, this.opacity);
      (dial.hit as unknown as { pointerEvents: string }).pointerEvents = dial.interactive && this.visible && visible ? 'auto' : 'none';
    }
    this.ring.visible = this.mode !== 'hidden';
    this.ring.update(dt, this.opacity);
    this.labelClock += dt;
    if (this.labels && this.labelClock >= 0.1) {
      this.labelClock = 0;
      [this.left, this.right].forEach((dial, i) => {
        const pill = this.pills[i]!;
        const text = dial.model ? `${dial.model.label}  ${dial.model.display}` : '';
        if (text !== pill.shown) { pill.shown = text; pill.text.setProperties({ text }); pill.box.setProperties({ display: text ? 'flex' : 'none' }); }
      });
    }
    if (this.labels && updateRoot) this.labels.update(Math.min(100, dt * 1000));
  }

  override dispose(): void { this.ring.dispose(); this.left.dispose(); this.right.dispose(); this.labels?.dispose(); }
}
