/**
 * Tangible-control visuals, in the shared look (hud/v2/theme LOOK: white = on, dark glass = off, no neon).
 *  - Bound object: ONE shader quad draws the tracking ring plus two value arcs (right arc = lift control,
 *    bottom arc = slide control) with knobs; a pill above names the object and its live values.
 *  - Pick mode: a thin ring + "Cup · pinch" tag on each candidate, with an invisible hit disc for
 *    pmndrs pointer-events (ray pinch, poke, or the emulator mouse).
 * Everything is pooled and updated in place each frame; text is re-laid out at most 5 Hz.
 * Slow motion only (≤ 0.5 Hz sweeps), nothing flashes.
 */
import { CircleGeometry, CylinderGeometry, Group, Mesh, MeshBasicMaterial, type Object3D, PlaneGeometry, type Quaternion, ShaderMaterial, TorusGeometry, Vector3 } from 'three';
import { makeText, setText, type SdfText } from '../hud/v2/text';
import { LOOK } from '../hud/v2/theme';

const RENDER = 32;
const ringVertex = 'varying vec2 vP; void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
const ringFragment = `
  varying vec2 vP;
  uniform float half_, radius, stroke, lift, slide, arcs, fade, sweep, hover, searching;
  float wrapA(float a) { return atan(sin(a), cos(a)); }
  float band(float d, float w, float aa) { return 1.0 - smoothstep(w * 0.5 - aa, w * 0.5 + aa, abs(d)); }
  vec2 arc(vec2 p, float r, float from, float span, float value, float aa, out float knob) {
    float a = atan(p.y, p.x);
    float t = wrapA(a - from) / span;
    float tc = clamp(t, 0.0, 1.0);
    float ac = from + span * tc;
    float d = length(p - r * vec2(cos(ac), sin(ac)));
    float b = 1.0 - smoothstep(0.0045 - aa, 0.0045 + aa, d);
    float filled = 1.0 - smoothstep(value - 0.004, value + 0.004, tc);
    float av = from + span * value;
    float dk = length(p - r * vec2(cos(av), sin(av)));
    knob = 1.0 - smoothstep(0.0085 - aa, 0.0085 + aa, dk);
    float inner = 1.0 - smoothstep(0.0048 - aa, 0.0048 + aa, dk);
    return vec2(b * mix(0.26, 0.96, filled), inner);
  }
  void main() {
    vec2 p = vP * half_ * 2.0;
    float aa = max(fwidth(p.x), 1e-5) * 1.2;
    float d = length(p);
    float ring = band(d - radius, stroke * (1.0 + hover * 0.6), aa);
    // searching: a soft highlight travels round the ring (slow, no flashing)
    float ang = atan(p.y, p.x);
    float trail = 0.5 + 0.5 * cos(ang - sweep);
    float ringA = ring * mix(0.9, 0.25 + 0.75 * trail * trail, searching) * (0.55 + 0.45 * max(arcs, hover));
    float alpha = ringA;
    vec3 color = vec3(1.0);
    if (arcs > 0.0) {
      float ra = radius + 0.022;
      float k1, k2;
      vec2 a1 = arc(p, ra, radians(-48.0), radians(96.0), lift, aa, k1);
      vec2 a2 = arc(p, ra, radians(228.0), radians(84.0), slide, aa, k2);
      float arcA = max(a1.x, a2.x) * arcs;
      alpha = max(alpha, arcA);
      float knobA = max(k1, k2) * arcs;
      alpha = max(alpha, knobA);
      color = mix(color, vec3(0.07, 0.07, 0.09), max(a1.y, a2.y) * arcs);
    }
    gl_FragColor = vec4(color, alpha * fade);
    #include <colorspace_fragment>
  }`;

function ringMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
    uniforms: {
      half_: { value: 0.1 }, radius: { value: 0.06 }, stroke: { value: LOOK.ring.stroke }, lift: { value: 0 }, slide: { value: 0 },
      arcs: { value: 0 }, fade: { value: 0 }, sweep: { value: 0 }, hover: { value: 0 }, searching: { value: 0 },
    },
    vertexShader: ringVertex, fragmentShader: ringFragment,
  });
}

const pillFragment = `
  varying vec2 vP;
  uniform vec2 size; uniform float light, fade;
  void main() {
    vec2 p = vP * size;
    vec2 q = abs(p) - (size * 0.5 - vec2(size.y * 0.5));
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - size.y * 0.5;
    float aa = max(fwidth(p.x), 1e-5);
    float a = 1.0 - smoothstep(-aa, aa, d);
    float rim = (1.0 - smoothstep(-aa, aa, abs(d + 0.0006) - 0.0006)) * (1.0 - light) * 0.22;
    vec3 c = mix(vec3(0.12, 0.12, 0.15), vec3(1.0), light);
    gl_FragColor = vec4(c + rim, (mix(0.86, 0.97, light) * a + rim) * fade);
    #include <colorspace_fragment>
  }`;

class Pill extends Group {
  readonly plate: Mesh<PlaneGeometry, ShaderMaterial>;
  readonly text: SdfText;
  private shownText = '';
  private textAt = -Infinity;
  private light = -1;
  width = 0.1;
  constructor(geometry: PlaneGeometry, size = 0.015) {
    super();
    this.plate = new Mesh(geometry, new ShaderMaterial({
      transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
      uniforms: { size: { value: [0.1, 0.03] }, light: { value: 1 }, fade: { value: 1 } },
      vertexShader: ringVertex, fragmentShader: pillFragment,
    }));
    this.plate.renderOrder = RENDER + 1;
    this.plate.raycast = () => {};
    this.text = makeText({ text: '', size, weight: 600, anchorX: 'center', singleLine: true });
    this.text.renderOrder = RENDER + 2;
    this.text.position.z = 0.001;
    (this.text as unknown as { raycast: () => void }).raycast = () => {};
    this.add(this.plate, this.text);
  }
  /** Rate-limited text update (troika re-layout is not free). */
  set(text: string, light: boolean, now: number, force = false): void {
    if (this.light !== (light ? 1 : 0)) {
      this.light = light ? 1 : 0;
      this.plate.material.uniforms.light!.value = this.light;
      this.text.color = light ? LOOK.text.onLight : LOOK.text.primary;
      force = true;
    }
    if (text === this.shownText || !force && now - this.textAt < 200) return;
    this.shownText = text; this.textAt = now;
    setText(this.text, text);
    this.width = Math.max(0.06, text.length * this.text.fontSize * 0.56 + 0.026);
    const s = this.plate.material.uniforms.size!.value as number[];
    s[0] = this.width; s[1] = this.text.fontSize * 2.1;
    this.plate.scale.set(s[0]!, s[1]!, 1);
  }
  setFade(f: number): void { this.plate.material.uniforms.fade!.value = f; (this.text as SdfText & { fillOpacity: number }).fillOpacity = f; this.visible = f > 0.01; }
}

export interface CandidateView { id: number; label: string; position: Vector3; sizeM: number }

class CandidateRing extends Group {
  readonly ring: Mesh<PlaneGeometry, ShaderMaterial>;
  readonly hit: Mesh<CircleGeometry, MeshBasicMaterial>;
  readonly tag: Pill;
  trackId = -1;
  label = '';
  hovered = new Set<number>();
  fade = 0;
  live = false;
  constructor(plane: PlaneGeometry, disc: CircleGeometry, hitMat: MeshBasicMaterial, onPick: (id: number) => void) {
    super();
    this.ring = new Mesh(plane, ringMaterial());
    this.ring.renderOrder = RENDER;
    this.ring.raycast = () => {};
    this.ring.frustumCulled = false;
    this.hit = new Mesh(disc, hitMat);
    this.hit.name = 'tangible-candidate-hit';
    const o = this.hit as unknown as { pointerEventsOrder: number; addEventListener(t: string, f: (e: { pointerId: number; stopPropagation?: () => void }) => void): void };
    o.pointerEventsOrder = 1;
    o.addEventListener('pointerover', (e) => this.hovered.add(e.pointerId));
    o.addEventListener('pointerout', (e) => this.hovered.delete(e.pointerId));
    o.addEventListener('click', (e) => { e.stopPropagation?.(); if (this.live) onPick(this.trackId); });
    this.tag = new Pill(plane, 0.013);
    this.add(this.ring, this.hit, this.tag);
    this.visible = false;
  }
}

export interface BoundView {
  position: Vector3;
  sizeM: number;
  /** 'searching' | 'tracking' | 'held' | 'lost' | 'waiting' (device not ready yet) */
  state: string;
  title: string;
  detail: string;
  lift: number;
  slide: number;
  liftLabel: string;
  slideLabel: string;
  hasSlide: boolean;
}

export class TangibleVisuals extends Group {
  private readonly plane = new PlaneGeometry(1, 1);
  private readonly disc = new CircleGeometry(1, 24);
  private readonly hitMat = new MeshBasicMaterial({ visible: false });
  private readonly ring: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly badge: Pill;
  private readonly liftTag: SdfText;
  private readonly slideTag: SdfText;
  private readonly candidates: CandidateRing[] = [];
  private readonly boundGroup = new Group();
  private boundFade = 0;
  private shownLift = 0;
  private shownSlide = 0;
  private sweep = 0;
  private labelsAt = -Infinity;
  private liftText = '';
  private slideText = '';
  /** emulator stand-in for the scripted object (a small mug) */
  readonly proxy = new Group();
  private readonly tmp = new Vector3();

  constructor(onPick: (id: number) => void) {
    super();
    this.name = 'tangible';
    this.ring = new Mesh(this.plane, ringMaterial());
    this.ring.name = 'tangible-ring';
    this.ring.renderOrder = RENDER;
    this.ring.frustumCulled = false;
    this.ring.raycast = () => {};
    this.badge = new Pill(this.plane, 0.015);
    this.badge.name = 'tangible-badge';
    this.liftTag = makeText({ text: '', size: 0.0105, weight: 600, anchorX: 'left', singleLine: true });
    this.slideTag = makeText({ text: '', size: 0.0105, weight: 600, anchorX: 'center', singleLine: true });
    for (const t of [this.liftTag, this.slideTag]) { t.renderOrder = RENDER + 2; (t as unknown as { raycast: () => void }).raycast = () => {}; }
    this.boundGroup.add(this.ring, this.badge, this.liftTag, this.slideTag);
    this.boundGroup.visible = false;
    for (let i = 0; i < 4; i++) this.candidates.push(new CandidateRing(this.plane, this.disc, this.hitMat, onPick));
    // mug stand-in: drawn only in the emulator's scripted mode
    const mat = new MeshBasicMaterial({ color: 0xe8e4dc, transparent: true, opacity: 0.92, depthWrite: false });
    const body = new Mesh(new CylinderGeometry(0.04, 0.036, 0.095, 24), mat);
    const handle = new Mesh(new TorusGeometry(0.024, 0.007, 8, 16, Math.PI), mat);
    handle.rotation.z = -Math.PI / 2; handle.position.x = 0.04;
    this.proxy.add(body, handle);
    this.proxy.visible = false;
    this.proxy.renderOrder = RENDER - 1;
    this.add(this.boundGroup, ...this.candidates, this.proxy);
  }

  /** Bound object (or null). `head` orients the billboard. */
  updateBound(v: BoundView | null, head: { position: Vector3; quaternion: Quaternion }, now: number, dtMs: number): void {
    const target = v ? (v.state === 'lost' || v.state === 'waiting' ? 0.5 : 1) : 0;
    const k = 1 - Math.exp(-dtMs / 120);
    this.boundFade += (target - this.boundFade) * k;
    if (!v && this.boundFade < 0.01) { this.boundGroup.visible = false; this.boundFade = 0; return; }
    this.boundGroup.visible = true;
    if (!v) { this.ring.material.uniforms.fade!.value = this.boundFade; this.badge.setFade(this.boundFade); this.liftTag.visible = this.slideTag.visible = false; return; }
    const r = Math.min(0.2, Math.max(0.055, v.sizeM * 0.62 + 0.022));
    const half = r + 0.04;
    this.boundGroup.position.copy(v.position);
    this.boundGroup.quaternion.copy(head.quaternion);
    this.ring.scale.set(half * 2, half * 2, 1);
    const u = this.ring.material.uniforms;
    this.sweep = (this.sweep + dtMs / 1000 * Math.PI * 0.9) % (Math.PI * 2);
    const active = v.state === 'tracking' || v.state === 'held';
    // value arcs ease toward the live values (smooth even at 10 Hz tracking)
    const kv = 1 - Math.exp(-dtMs / 70);
    this.shownLift += (v.lift - this.shownLift) * kv;
    this.shownSlide += (v.slide - this.shownSlide) * kv;
    u.half_!.value = half; u.radius!.value = r; u.lift!.value = this.shownLift; u.slide!.value = v.hasSlide ? this.shownSlide : 0;
    u.arcs!.value = v.state === 'waiting' ? 0.4 : 1; u.fade!.value = this.boundFade; u.sweep!.value = this.sweep;
    u.searching!.value = active ? 0 : 1; u.hover!.value = 0;
    this.badge.position.set(0, r + 0.05, 0.001);
    this.badge.set(v.detail ? `${v.title} · ${v.detail}` : v.title, active, now);
    this.badge.setFade(this.boundFade);
    const ra = r + 0.022;
    this.liftTag.visible = this.slideTag.visible = this.boundFade > 0.05;
    this.liftTag.position.set(ra * Math.cos(0.5) + 0.016, ra * Math.sin(0.5), 0.001);
    this.slideTag.position.set(0, -ra - 0.024, 0.001);
    this.slideTag.visible = this.slideTag.visible && v.hasSlide;
    if (now - this.labelsAt > 200) {
      this.labelsAt = now;
      const lt = v.liftLabel ? `↑ ${v.liftLabel}` : '', st = v.slideLabel ? `‹ ${v.slideLabel} ›` : '';
      if (lt !== this.liftText) { this.liftText = lt; setText(this.liftTag, lt); }
      if (st !== this.slideText) { this.slideText = st; setText(this.slideTag, st); }
    }
  }

  /** Pick-mode candidates (null/empty hides them). */
  updateCandidates(list: readonly CandidateView[] | null, head: { position: Vector3; quaternion: Quaternion }, now: number, dtMs: number): void {
    const k = 1 - Math.exp(-dtMs / 100);
    for (let i = 0; i < this.candidates.length; i++) {
      const c = this.candidates[i]!;
      const v = list?.[i];
      c.live = !!v;
      if (v) {
        if (c.trackId !== v.id) { c.trackId = v.id; c.hovered.clear(); }
        c.position.copy(v.position);
        c.quaternion.copy(head.quaternion);
        const r = Math.min(0.2, Math.max(0.05, v.sizeM * 0.62 + 0.02));
        const half = r + 0.03;
        c.ring.scale.set(half * 2, half * 2, 1);
        c.hit.scale.setScalar(r + 0.02);
        c.hit.visible = true;
        const u = c.ring.material.uniforms;
        const hover = c.hovered.size > 0 ? 1 : 0;
        u.half_!.value = half; u.radius!.value = r; u.arcs!.value = 0; u.searching!.value = 0;
        u.hover!.value += (hover - (u.hover!.value as number)) * k;
        c.tag.position.set(0, r + 0.032, 0.001);
        c.tag.set(`${v.label} · pinch to use`, hover > 0, now);
      } else c.hit.visible = false;
      c.fade += ((v ? 1 : 0) - c.fade) * k;
      c.visible = c.fade > 0.01;
      c.ring.material.uniforms.fade!.value = c.fade;
      c.tag.setFade(c.fade);
    }
  }

  /** Emulator stand-in object at `p` (null hides it). */
  updateProxy(p: Vector3 | null, head: { position: Vector3 }): void {
    this.proxy.visible = !!p;
    if (!p) return;
    this.proxy.position.copy(p);
    // face the handle sideways relative to the viewer
    this.tmp.copy(head.position).sub(p); this.tmp.y = 0;
    this.proxy.rotation.y = Math.atan2(this.tmp.x, this.tmp.z) + Math.PI / 2;
  }

  override dispose(): void {
    this.removeFromParent();
    this.plane.dispose(); this.disc.dispose(); this.hitMat.dispose();
  }

  static attach(parent: Object3D, onPick: (id: number) => void): TangibleVisuals {
    const v = new TangibleVisuals(onPick);
    parent.add(v);
    return v;
  }
}
