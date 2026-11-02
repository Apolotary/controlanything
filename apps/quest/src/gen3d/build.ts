/**
 * SpecObject: a ce.gen3d/1 spec as an interactive three.js object.
 *
 * - builds the archetype expansion into meshes, labels and paths (one code path for everything)
 * - runs the behaviours (rotate / slide / press / toggle / pull / xy / grab) against cursors
 * - drives feedback (arc fills, readouts, glow, ticks, pops), damping, detents
 * - renders the armed / disarmed states and the streaming build-up
 * - emits ControlEvents to a sink; never talks to a socket itself
 */
import { Box3, Camera, CircleGeometry, Color, DoubleSide, EdgesGeometry, Euler, Group, LineSegments, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, PlaneGeometry, Quaternion, RingGeometry, SRGBColorSpace, Texture, TextureLoader, Vector3, type Material as ThreeMaterial } from 'three';
import type { Behavior, Control, ControlEvent, ControlValue, Feedback, Gen3dSpec, Part, PartialSpec, Skin } from '@ce/gen3d';
import { NEON, expandSpec, repairSpec, validateSpec, type ExpandedSpec } from '@ce/gen3d';
import { OneEuro3, Tweens, damp, ease } from './anim';
import type { UiAudio } from './audio';
import { ConsoleSink, Emitter, type EventSink } from './events';
import { buildGeometry, roughRadius } from './geometry';
import { AXIS_VEC, angleAround, clamp, toLocal, wrapDeg, type Cursor } from './interact';
import { HoloMaterial, MaterialClock, ROLE_ORDER, buildMaterial, ghostEdgeMaterial, ghostMaterial } from './materials';
import { PathObject } from './path';
import { Label } from './text';

export interface GenEvents {
  control: ControlEvent;
  /** the user re-placed the whole object */
  grab: { specId: string; position: [number, number, number]; yawDeg: number };
  /** a pinch or poke landed on a widget: the app shell must not treat it as a selection */
  consumed: { hand: string; widget: 'control' | 'hack' | 'deck' | 'handle'; specId: string; controlId?: string };
  hover: { specId: string; controlId?: string; on: boolean };
}

export interface SpecObjectOptions {
  clock: MaterialClock;
  audio?: UiAudio;
  sink?: EventSink;
  emitter?: Emitter<GenEvents>;
}

interface ControlState {
  control: Control;
  value: ControlValue;
  /** normalised 0..1 (x for xy) */
  t: number;
  ty: number;
  visualT: number;
  visualTy: number;
  armed: boolean;
  lastTick: number;
}

interface BRun {
  b: Behavior;
  node: Object3D;
  parent: Object3D;
  ctrl?: ControlState;
  /** archetype group this behaviour belongs to (for hover visibility) */
  archetypeId?: string;
  restPos: Vector3;
  restQuat: Quaternion;
  radius: number;
  owner: string | null;
  pressedBy: string | null;
  pressAmt: number;
  pull: number;
  pokeArmed: Set<string>;
  lastPress: number;
  hover: number;
  hoverBy: Set<string>;
  toggleDragged: boolean;
}

interface Grab {
  run: BRun;
  cursorId: string;
  startLocal: Vector3;
  lastLocal: Vector3;
  lastAngle: number;
  mode: 'none' | 'drag' | 'twist';
  accDrag: number;
  accTwist: number;
  t0: number;
  filter: OneEuro3;
  offset: number;
  offsetY: number;
  objectOffset: Vector3;
  committedT: number;
  committedTy: number;
}

interface FRun {
  f: Feedback;
  node?: Object3D;
  mat?: ThreeMaterial;
  baseGlow: number;
  baseEmissive: number;
  baseColor?: Color;
  part?: Part;
}

const DEG = Math.PI / 180;
const _box = new Box3();
const _v = new Vector3();
const _v2 = new Vector3();
const _q = new Quaternion();
const _e = new Euler();

export class SpecObject extends Group {
  spec!: Gen3dSpec;
  expanded!: ExpandedSpec;
  readonly nodes = new Map<string, Object3D>();
  readonly labels = new Map<string, Label>();
  readonly paths = new Map<string, PathObject>();
  readonly meshes: Mesh[] = [];
  readonly controls = new Map<string, ControlState>();
  readonly emitter: Emitter<GenEvents>;
  private runs: BRun[] = [];
  private fruns: FRun[] = [];
  private grabs = new Map<string, Grab>();
  private births = new Map<string, number>();
  private baseScale = new Map<string, Vector3>();
  private parts = new Map<string, Part>();
  private tweens = new Tweens();
  private clock: MaterialClock;
  private audio?: UiAudio;
  private sink: EventSink;
  private armedAll = true;
  private reasonLabel?: Label;
  private ghosted = new Map<Mesh, { material: ThreeMaterial | ThreeMaterial[]; edges?: LineSegments }>();
  private hoverArchetype = new Map<string, number>();
  private now = 0;
  private skinLayers: Mesh<PlaneGeometry | CircleGeometry, MeshBasicMaterial>[] = [];
  private skinTexture?: Texture;
  private skinUrl?: string;
  /** fired once the skin layer has finished fading in */
  onSkinReady?: (skin: Skin) => void;
  /** while a hand holds a control, the shell should not re-anchor or re-face the object */
  get interacting(): boolean {
    return this.grabs.size > 0 || this.runs.some((r) => r.pressedBy);
  }

  constructor(spec: Gen3dSpec, opts: SpecObjectOptions) {
    super();
    this.clock = opts.clock;
    this.audio = opts.audio;
    this.sink = opts.sink ?? new ConsoleSink();
    this.emitter = opts.emitter ?? new Emitter<GenEvents>();
    this.name = `spec:${spec.specId}`;
    this.applySpec(spec, 'none');
  }

  // --- building -------------------------------------------------------------------------------------

  /** Replace the content. 'buildup' animates every part in, 'diff' only parts whose id is new. */
  applySpec(spec: Gen3dSpec, animate: 'none' | 'buildup' | 'diff' = 'diff'): void {
    const prevIds = new Set(this.nodes.keys());
    const prevValues = new Map<string, ControlValue>();
    for (const [id, c] of this.controls) prevValues.set(id, c.value);
    this.clearContent();
    this.spec = spec;
    this.expanded = expandSpec(spec);
    this.armedAll = spec.state?.armed ?? true;
    for (const p of this.expanded.parts) this.parts.set(p.id, p);

    // controls
    for (const c of spec.controls) {
      const value = prevValues.get(c.id) ?? c.default ?? defaultValue(c);
      const { t, ty } = normalize(c, value);
      this.controls.set(c.id, { control: c, value, t, ty, visualT: t, visualTy: ty, armed: c.armed ?? this.armedAll, lastTick: t });
    }

    // nodes: create, then parent (any order in the list is allowed)
    for (const p of this.expanded.parts) this.nodes.set(p.id, this.makeNode(p));
    for (const p of this.expanded.parts) {
      const node = this.nodes.get(p.id)!;
      const parent = p.parentId ? this.nodes.get(p.parentId) : undefined;
      (parent ?? this).add(node);
    }
    this.updateMatrixWorld(true);

    // behaviours
    for (const b of this.expanded.behaviors) {
      const node = this.nodes.get(b.partId);
      if (!node) continue;
      const ctrl = b.controlId ? this.controls.get(b.controlId) : undefined;
      if (b.type !== 'grab' && !ctrl) continue;
      const part = this.parts.get(b.partId)!;
      const archetypeId = this.expanded.origin.get(b.partId) ?? (part.kind === 'group' ? part.id : undefined);
      const radius = b.grabRadius ?? Math.max(0.03, this.subtreeRadius(node) + 0.02);
      this.runs.push({ b, node, parent: node.parent ?? this, ctrl, archetypeId, restPos: node.position.clone(), restQuat: node.quaternion.clone(), radius, owner: null, pressedBy: null, pressAmt: 0, pull: 0, pokeArmed: new Set(), lastPress: 0, hover: 0, hoverBy: new Set(), toggleDragged: false });
    }

    // feedback
    for (const f of this.expanded.feedback) {
      if (!this.controls.has(f.controlId)) continue;
      const node = f.partId ? this.nodes.get(f.partId) : undefined;
      const mesh = node instanceof Mesh ? node : (node?.children.find((c) => c instanceof Mesh) as Mesh | undefined);
      const mat = mesh?.material as ThreeMaterial | undefined;
      const fr: FRun = { f, node, mat, baseGlow: 0, baseEmissive: 1, part: f.partId ? this.parts.get(f.partId) : undefined };
      if (mat instanceof HoloMaterial) fr.baseGlow = mat.u.uGlow.value;
      if (mat instanceof MeshStandardMaterial) {
        fr.baseEmissive = mat.emissiveIntensity;
        fr.baseColor = mat.emissive.clone();
      }
      this.fruns.push(fr);
    }

    // initial visuals
    for (const c of this.controls.values()) this.refreshReadouts(c);
    this.applyVisuals(0);
    this.applyArmed();

    // build-up: 40 ms stagger per part, but the whole object materialises within ~1.6 s however many parts
    let buildS = 0;
    if (animate !== 'none') {
      const fresh = this.expanded.parts.filter((p) => !(animate === 'diff' && prevIds.has(p.id)));
      const stagger = Math.min(0.04, 1.6 / Math.max(1, fresh.length));
      const t0 = this.now;
      fresh.forEach((p, i) => this.births.set(p.id, t0 + i * stagger));
      if (fresh.length) this.audio?.play('step');
      buildS = fresh.length * stagger + 0.3;
    }
    // skin (Muse Image): fades in after the controls have built (browser only)
    if (spec.skin && typeof document !== 'undefined') this.applySkin(spec.skin, buildS + 0.4);
  }

  /** Paint the skin onto eligible plates / knob faces as a textured layer under the text plates. */
  private applySkin(skin: Skin, delayS: number): void {
    const targets: { node: Mesh; part: Part; kind: 'panel' | 'knob-face' }[] = [];
    for (const mesh of this.meshes) {
      const part = this.parts.get(mesh.userData.partId as string);
      if (!part || part.kind !== 'primitive') continue;
      const owner = this.parts.get(this.expanded.origin.get(part.id) ?? '');
      if (skin.partIds.length && !skin.partIds.includes(part.id) && !(owner && skin.partIds.includes(owner.id))) continue;
      // plates: boxes of plate size whose role is base/body or unset (hand-written specs rarely set roles)
      const isPanel = part.shape === 'box' && (part.role === undefined || part.role === 'base' || part.role === 'body') && (part.dims?.w ?? 0) >= 0.06 && (part.dims?.h ?? 0) >= 0.025 && (part.dims?.d ?? 0.004) <= 0.02;
      const isKnobFace = owner?.archetype === 'knob' && part.id.endsWith('.capface');
      if ((skin.kind === 'panel' || skin.kind === 'both') && isPanel) targets.push({ node: mesh, part, kind: 'panel' });
      else if ((skin.kind === 'knob-face' || skin.kind === 'both') && isKnobFace) targets.push({ node: mesh, part, kind: 'knob-face' });
    }
    if (!targets.length) return;
    const fade = skin.fadeS ?? 2.5;
    const place = (tex: Texture) => {
      tex.colorSpace = SRGBColorSpace;
      tex.anisotropy = 4;
      const image = tex.image as { width: number; height: number } | undefined;
      for (const t of targets) {
        const map = tex.clone();
        map.needsUpdate = true;
        let geo: PlaneGeometry | CircleGeometry;
        let z: number;
        if (t.kind === 'panel') {
          const w = (t.part.dims?.w ?? 0.1) - 0.004;
          const h = (t.part.dims?.h ?? 0.05) - 0.004;
          geo = new PlaneGeometry(w, h);
          z = (t.part.dims?.d ?? 0.004) / 2 + 0.0006;
          fitTexture(map, skin.fit, w / h, image);
        } else {
          const r = (t.part.dims?.rTop ?? t.part.dims?.r ?? 0.025) - 0.001;
          geo = new CircleGeometry(r, 48);
          z = (t.part.dims?.h ?? 0.008) / 2 + 0.0006;
          fitTexture(map, 'cover', 1, image);
        }
        const mat = new MeshBasicMaterial({ map, transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
        const layer = new Mesh(geo, mat);
        if (t.kind === 'knob-face') {
          // cylinder caps face +y in the mesh's own frame
          layer.position.set(0, z, 0);
          layer.rotation.x = -Math.PI / 2;
        } else layer.position.set(0, 0, z);
        layer.renderOrder = t.node.renderOrder + 1;
        layer.name = '_skin';
        t.node.add(layer);
        this.skinLayers.push(layer);
        this.tweens.add(fade, (k) => (mat.opacity = skin.opacity * ease.inOutCubic(k)), undefined, delayS);
      }
      this.tweens.add(0.01, () => {}, () => this.onSkinReady?.(skin), delayS + fade);
    };
    if (this.skinTexture && this.skinUrl === skin.url) place(this.skinTexture);
    else {
      this.skinUrl = skin.url;
      new TextureLoader().setCrossOrigin('anonymous').load(
        skin.url,
        (tex) => {
          this.skinTexture = tex;
          place(tex);
        },
        undefined,
        (err) => console.warn('[gen3d] skin failed to load', err),
      );
    }
  }

  /** Streaming: show what has arrived so far (controls and parts whose references already exist). */
  applyPartial(partial: PartialSpec, base: Gen3dSpec): void {
    const draft: Gen3dSpec = { ...base, controls: partial.controls.length ? partial.controls : base.controls, parts: partial.parts.length ? partial.parts : [{ id: 'placeholder', kind: 'group' }], behaviors: partial.behaviors, feedback: partial.feedback, title: partial.title ?? base.title };
    const { spec } = repairSpec(draft);
    const v = validateSpec(spec);
    if (v.spec) this.applySpec(v.spec, 'diff');
  }

  private clearContent(): void {
    for (const n of [...this.children]) this.remove(n);
    for (const l of this.labels.values()) l.dispose();
    for (const p of this.paths.values()) p.dispose();
    for (const m of this.meshes) {
      m.geometry.dispose();
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        if (mat instanceof HoloMaterial) this.clock.unregister(mat);
        mat.dispose();
      }
    }
    this.nodes.clear();
    this.labels.clear();
    this.paths.clear();
    this.meshes.length = 0;
    this.controls.clear();
    this.runs.length = 0;
    this.fruns.length = 0;
    this.grabs.clear();
    this.births.clear();
    this.baseScale.clear();
    this.parts.clear();
    this.ghosted.clear();
    this.hoverArchetype.clear();
    this.reasonLabel = undefined;
    this.tweens.clear();
    for (const l of this.skinLayers) {
      l.geometry.dispose();
      l.material.map?.dispose();
      l.material.dispose();
    }
    this.skinLayers.length = 0;
  }

  private makeNode(p: Part): Object3D {
    let node: Object3D;
    switch (p.kind) {
      case 'primitive': {
        const geo = buildGeometry(p);
        const built = buildMaterial(p.material, this.clock, { style: 'holo' });
        const mesh = new Mesh(geo, built.material);
        mesh.renderOrder = ROLE_ORDER[p.role ?? 'default'];
        if (p.shape === 'plane' || p.shape === 'ring') (mesh.material as { side: number }).side = DoubleSide;
        if (built.edgeMaterial) {
          const edges = new LineSegments(new EdgesGeometry(geo, p.dims?.radius ? 50 : 20), built.edgeMaterial);
          edges.renderOrder = mesh.renderOrder + 1;
          mesh.add(edges);
        }
        if (built.glowMaterial) {
          // layered additive copies stand in for a bloom pass (no post-processing at 72 Hz)
          const inner = new Mesh(geo, built.glowMaterial);
          inner.scale.setScalar(1.07);
          inner.renderOrder = mesh.renderOrder - 1;
          const outerMat = (built.glowMaterial as MeshBasicMaterial).clone();
          outerMat.opacity = 0.12;
          const outer = new Mesh(geo, outerMat);
          outer.scale.setScalar(1.22);
          outer.renderOrder = mesh.renderOrder - 2;
          mesh.add(inner, outer);
        }
        this.meshes.push(mesh);
        node = mesh;
        break;
      }
      case 'text': {
        const label = new Label(p.text ?? { value: '' });
        label.renderOrder = ROLE_ORDER[p.role ?? 'text'];
        label.userData.billboard = p.text?.billboard ?? false;
        this.labels.set(p.id, label);
        node = label;
        break;
      }
      case 'path': {
        const po = new PathObject(p.path ?? { from: [0, 0, 0], to: [0.1, 0, 0] });
        this.paths.set(p.id, po);
        node = po;
        break;
      }
      case 'group':
      case 'archetype':
      default:
        node = new Group();
    }
    node.name = p.id;
    node.userData.partId = p.id;
    node.userData.role = p.role;
    node.userData.visibleWhen = p.visibleWhen ?? 'always';
    const t = p.transform;
    if (t?.position) node.position.set(t.position[0]!, t.position[1]!, t.position[2]!);
    if (t?.rotationDeg) node.rotation.set(t.rotationDeg[0]! * DEG, t.rotationDeg[1]! * DEG, t.rotationDeg[2]! * DEG);
    if (t?.scale !== undefined) typeof t.scale === 'number' ? node.scale.setScalar(t.scale) : node.scale.set(t.scale[0]!, t.scale[1]!, t.scale[2]!);
    this.baseScale.set(p.id, node.scale.clone());
    return node;
  }

  private subtreeRadius(node: Object3D): number {
    let r = 0;
    node.traverse((o) => {
      const p = o.userData.partId ? this.parts.get(o.userData.partId as string) : undefined;
      if (p?.kind === 'primitive') r = Math.max(r, roughRadius(p) + o.position.length());
    });
    return r;
  }

  // --- values ----------------------------------------------------------------------------------------

  getValue(controlId: string): ControlValue | undefined {
    return this.controls.get(controlId)?.value;
  }

  /** Set a control value. emit=false for device echoes / replay (moves the control silently). */
  setValue(controlId: string, value: ControlValue, opts: { emit?: boolean; phase?: ControlEvent['phase']; index?: number; immediate?: boolean } = {}): void {
    const c = this.controls.get(controlId);
    if (!c) return;
    const q = quantize(c.control, value);
    const changed = !sameValue(q, c.value);
    c.value = q;
    const { t, ty } = normalize(c.control, q);
    c.t = t;
    c.ty = ty;
    if (opts.immediate) {
      c.visualT = t;
      c.visualTy = ty;
    }
    if (changed || opts.phase === 'start' || opts.phase === 'end') {
      this.refreshReadouts(c);
      if (changed) this.tickFor(c);
      if (opts.emit !== false && opts.phase) {
        if (c.armed && this.armedAll) {
          const e: ControlEvent = { controlId, value: q, phase: opts.phase, ts: Date.now(), specId: this.spec.specId };
          if (opts.index !== undefined) e.index = opts.index;
          this.sink.control(e);
          this.emitter.emit('control', e);
        }
      }
    }
  }

  private setT(c: ControlState, t: number, ty: number | undefined, phase: ControlEvent['phase'], index?: number): void {
    t = clamp(t, 0, 1);
    const v = fromT(c.control, t, ty === undefined ? c.ty : clamp(ty, 0, 1));
    this.setValue(c.control.id, v, { emit: true, phase, index });
  }

  private tickFor(c: ControlState): void {
    const fr = this.fruns.find((f) => f.f.controlId === c.control.id && f.f.type === 'tick' && (f.f.on ?? 'change') === 'change');
    if (!fr) return;
    const every = fr.f.every ?? 0.05;
    if (Math.floor(c.t / every + 1e-6) !== Math.floor(c.lastTick / every + 1e-6)) {
      this.audio?.play(fr.f.sound === 'click' ? 'click' : 'tick', this.worldPosOf(fr.node));
      c.lastTick = c.t;
    }
  }

  private refreshReadouts(c: ControlState): void {
    for (const fr of this.fruns) {
      if (fr.f.controlId !== c.control.id || fr.f.type !== 'readout') continue;
      const label = fr.node instanceof Label ? fr.node : undefined;
      label?.setText(formatValue(c.control, c.value, fr.f.format));
    }
  }

  // --- arming -----------------------------------------------------------------------------------------

  setArmed(armed: boolean, reason?: string, controlIds?: string[]): void {
    const was = this.armedAll && [...this.controls.values()].every((c) => c.armed);
    if (controlIds) for (const id of controlIds) {
      const c = this.controls.get(id);
      if (c) c.armed = armed;
    }
    else {
      this.armedAll = armed;
      for (const c of this.controls.values()) c.armed = armed;
    }
    this.spec.state = { armed: this.armedAll, ...(reason ? { reason } : {}) };
    this.applyArmed();
    const isNow = this.armedAll && [...this.controls.values()].every((c) => c.armed);
    if (!was && isNow) {
      // solidify: 120 ms pop + stamp sound
      this.audio?.play('ok', this.getWorldPosition(_v));
      this.tweens.add(0.24, (t) => {
        const s = 1 + 0.04 * Math.sin(t * Math.PI);
        this.scale.setScalar(s);
      }, () => this.scale.setScalar(1));
    } else if (was && !isNow) this.audio?.play('knock', this.getWorldPosition(_v));
  }

  private applyArmed(): void {
    // which archetype groups / parts are disarmed
    const disarmedParts = new Set<string>();
    for (const p of this.spec.parts) {
      const cid = p.controlId;
      const c = cid ? this.controls.get(cid) : undefined;
      const disarmed = !this.armedAll || (c ? !c.armed : false);
      if (disarmed && (p.kind === 'archetype' || c)) disarmedParts.add(p.id);
    }
    for (const mesh of this.meshes) {
      const partId = mesh.userData.partId as string;
      const owner = this.expanded.origin.get(partId) ?? partId;
      // a disarmed object ghosts everything but its tag/plate chrome; a disarmed control ghosts its archetype;
      // a HUD-only object (no controls) is never ghosted: its state is information, not a lock
      const ghostAll = !this.armedAll && this.controls.size > 0;
      const shouldGhost = ghostAll ? !isChrome(this.parts.get(owner)) : disarmedParts.has(owner) || disarmedParts.has(partId);
      const g = this.ghosted.get(mesh);
      if (shouldGhost && !g) {
        const edges = new LineSegments(new EdgesGeometry(mesh.geometry, 30), ghostEdgeMaterial());
        edges.renderOrder = mesh.renderOrder + 1;
        edges.name = '_ghostEdges';
        mesh.add(edges);
        this.ghosted.set(mesh, { material: mesh.material, edges });
        mesh.material = ghostMaterial();
        for (const child of mesh.children) if (child.name !== '_ghostEdges' && child.name !== '_skin') child.visible = false;
      } else if (!shouldGhost && g) {
        mesh.material = g.material;
        if (g.edges) mesh.remove(g.edges);
        for (const child of mesh.children) child.visible = true;
        this.ghosted.delete(mesh);
      }
    }
    for (const [id, label] of this.labels) {
      const owner = this.expanded.origin.get(id) ?? id;
      const ghost = !this.armedAll && this.controls.size > 0 ? !isChrome(this.parts.get(owner)) : disarmedParts.has(owner);
      label.material.opacity = ghost ? 0.45 : 1;
    }
    // reason plate above the object, facing the user
    const reason = !this.armedAll && this.controls.size > 0 ? (this.spec.state?.reason ?? 'not yet verified on the real device') : undefined;
    if (reason) {
      if (!this.reasonLabel) {
        this.reasonLabel = new Label({ value: `⌁ NOT VERIFIED · ${reason}`, heightM: 0.0065, color: NEON.cyan, background: NEON.void, uppercase: true, font: 'mono' });
        this.reasonLabel.renderOrder = 70;
        this.reasonLabel.userData.billboard = true;
        this.add(this.reasonLabel);
      } else this.reasonLabel.setText(`⌁ NOT VERIFIED · ${reason}`);
      this.reasonLabel.position.set(0, this.highestY() + 0.035, 0.02);
    } else if (this.reasonLabel) {
      this.remove(this.reasonLabel);
      this.reasonLabel.dispose();
      this.reasonLabel = undefined;
    }
  }

  private highestY(): number {
    let y = 0;
    for (const p of this.expanded.parts) {
      if (p.kind === 'group' || p.id.startsWith('_')) continue;
      const node = this.nodes.get(p.id);
      if (!node) continue;
      const top = node.getWorldPosition(_v2);
      this.worldToLocal(top);
      y = Math.max(y, top.y + (p.kind === 'primitive' ? roughRadius(p) : 0.01));
    }
    return y;
  }

  // --- per frame ------------------------------------------------------------------------------------------

  update(dt: number, time: number, cursors: Cursor[], camera: Camera, wheel = 0): void {
    this.now = time;
    this.tweens.update(time);
    this.updateMatrixWorld(true);

    // interaction
    for (const c of cursors) {
      const grab = this.grabs.get(c.id);
      if (grab) {
        if (!c.pinching || c.justReleased || !c.tracked) {
          this.userData.lastRelease = { pinching: c.pinching, justReleased: c.justReleased, tracked: c.tracked, time };
          this.release(grab, c);
        } else this.updateGrab(grab, c, dt);
        continue;
      }
      if (!c.tracked) continue;
      // nearest candidate for pinch-style gestures (distance to the part's centre, or to its bounds for wide parts)
      let best: BRun | null = null;
      let bestD = Infinity;
      for (const r of this.runs) {
        if (r.owner) continue;
        const gestures = r.b.gestures ?? ['pinch-drag'];
        const pokeOnly = gestures.every((g) => g === 'poke');
        if (pokeOnly && c.canPoke) continue;
        const d = this.candidateDistance(r, c.position);
        if (d < bestD) {
          bestD = d;
          best = r;
        }
      }
      // hover bookkeeping
      for (const r of this.runs) {
        if (best === r) r.hoverBy.add(c.id);
        else r.hoverBy.delete(c.id);
      }
      if (best && c.justPinched) this.acquire(best, c);
      // pokes
      if (c.canPoke) for (const r of this.runs) this.updatePoke(r, c);
      if (c.hand === 'mouse' && best && wheel !== 0 && best.ctrl && best.b.type === 'rotate') {
        this.setT(best.ctrl, best.ctrl.t - wheel / 2400, undefined, 'move');
      }
    }
    // release presses held by pinch when the pinch ends
    for (const r of this.runs) {
      if (r.pressedBy && !r.pressedBy.startsWith('poke:')) {
        const c = cursors.find((x) => x.id === r.pressedBy);
        if (!c || !c.pinching) this.releasePress(r, c);
      }
    }

    // smoothing of control visuals
    for (const c of this.controls.values()) {
      c.visualT = damp(c.visualT, c.t, 0.05, dt);
      c.visualTy = damp(c.visualTy, c.ty, 0.05, dt);
    }
    for (const r of this.runs) {
      r.pressAmt = damp(r.pressAmt, r.pressedBy ? 1 : 0, 0.04, dt);
      const hovering = r.hoverBy.size > 0 || r.owner !== null;
      r.hover = damp(r.hover, hovering ? 1 : 0, 0.08, dt);
      if (r.archetypeId) this.hoverArchetype.set(r.archetypeId, Math.max(this.hoverArchetype.get(r.archetypeId) ?? 0, r.hover));
      if (r.b.type === 'pull' && !r.owner) r.pull = damp(r.pull, 0, 0.08, dt);
    }
    this.applyVisuals(dt);
    this.applyFeedback(dt);
    this.applyBirths(time);
    this.applyVisibility();
    for (const p of this.paths.values()) p.update(time);
    // billboards (yaw only)
    camera.getWorldPosition(_v);
    for (const l of this.labels.values()) if (l.userData.billboard) yawToward(l, _v);
    if (this.reasonLabel) yawToward(this.reasonLabel, _v);
    // decay archetype hover map for next frame
    for (const [k, v] of this.hoverArchetype) this.hoverArchetype.set(k, v * 0.5);
  }

  /** Distance of the nearest acquirable behaviour to a cursor's pinch point (Infinity when none), for arbitration across objects. */
  nearestCandidate(c: Cursor): number {
    let best = Infinity;
    for (const r of this.runs) {
      if (r.owner) continue;
      const gestures = r.b.gestures ?? ['pinch-drag'];
      if (gestures.every((g) => g === 'poke') && c.canPoke) continue;
      best = Math.min(best, this.candidateDistance(r, c.position));
    }
    return best;
  }

  /** How far a cursor is from a behaviour's part: within grabRadius of its centre, or within 2 cm of its bounds. */
  private candidateDistance(r: BRun, p: Vector3): number {
    r.node.getWorldPosition(_v);
    const dc = _v.distanceTo(p);
    if (dc <= r.radius) return dc;
    _box.setFromObject(r.node);
    if (_box.isEmpty()) return Infinity;
    const db = _box.distanceToPoint(p);
    return db <= 0.02 ? r.radius + db : Infinity;
  }

  private acquire(r: BRun, c: Cursor): void {
    this.audio?.unlock();
    const widget = r.b.type === 'grab' ? 'handle' : 'control';
    this.emitter.emit('consumed', { hand: c.hand, widget, specId: this.spec.specId, controlId: r.b.controlId });
    if (r.b.type === 'press' || r.b.type === 'toggle') {
      if (r.b.type === 'toggle' && r.b.travel) {
        // a toggle with travel can also be dragged across
        r.toggleDragged = false;
      }
      this.press(r, c.id);
      return;
    }
    r.owner = c.id;
    const local = toLocal(r.parent, c.position, new Vector3()).sub(r.restPos);
    const grab: Grab = {
      run: r,
      cursorId: c.id,
      startLocal: local.clone(),
      lastLocal: local.clone(),
      lastAngle: angleAround(local, r.b.axis ?? 'z'),
      mode: c.hand === 'mouse' ? 'drag' : 'none',
      accDrag: 0,
      accTwist: 0,
      t0: this.now,
      filter: new OneEuro3(1.2, 0.03),
      offset: 0,
      offsetY: 0,
      objectOffset: new Vector3(),
      committedT: r.ctrl?.t ?? 0,
      committedTy: r.ctrl?.ty ?? 0,
    };
    const axis = r.b.axis ?? (r.b.type === 'slide' ? 'y' : 'z');
    if (r.b.type === 'slide' || r.b.type === 'pull') {
      const travel = r.b.travel ?? [0, 0.16];
      const s = local[axis];
      const t = r.ctrl?.t ?? 0;
      grab.offset = s - (travel[0]! + t * (travel[1]! - travel[0]!));
    } else if (r.b.type === 'xy') {
      const travel = r.b.travel ?? [-0.07, 0.07];
      const len = travel[1]! - travel[0]!;
      grab.offset = local.x - (travel[0]! + (r.ctrl?.t ?? 0.5) * len);
      grab.offsetY = local.y - (travel[0]! + (r.ctrl?.ty ?? 0.5) * len);
    } else if (r.b.type === 'grab') {
      const parentLocal = this.parent ? this.parent.worldToLocal(c.position.clone()) : c.position.clone();
      grab.objectOffset.copy(this.position).sub(parentLocal);
    }
    this.grabs.set(c.id, grab);
    if (r.ctrl) this.setT(r.ctrl, r.ctrl.t, undefined, 'start');
    this.audio?.play('click', c.position);
    const glow = this.fruns.find((f) => f.f.controlId === r.b.controlId && f.f.type === 'glow' && f.f.on === 'grab');
    if (glow) this.flashGlow(glow);
  }

  private updateGrab(g: Grab, c: Cursor, dt: number): void {
    const r = g.run;
    const filtered = g.filter.filter(c.position, dt, _v2);
    if (r.b.type === 'grab') {
      const parentLocal = this.parent ? this.parent.worldToLocal(filtered.clone()) : filtered.clone();
      this.position.copy(parentLocal).add(g.objectOffset);
      return;
    }
    const local = toLocal(r.parent, filtered, new Vector3()).sub(r.restPos);
    const ctrl = r.ctrl!;
    const axis = r.b.axis ?? (r.b.type === 'slide' ? 'y' : 'z');
    switch (r.b.type) {
      case 'rotate': {
        const sweep = r.b.sweepDeg ?? [-135, 135];
        const sweepLen = sweep[1]! - sweep[0]!;
        const dragCoord = axis === 'z' ? local.y : axis === 'x' ? local.z : local.x;
        const lastDrag = axis === 'z' ? g.lastLocal.y : axis === 'x' ? g.lastLocal.z : g.lastLocal.x;
        const dDrag = dragCoord - lastDrag;
        const angle = angleAround(local, axis);
        let dTwist = wrapDeg(angle - g.lastAngle);
        if (Math.abs(dTwist) > 25) dTwist = 0; // tracking glitch guard
        g.lastAngle = angle;
        g.lastLocal.copy(local);
        // lock the modality after deliberate initial movement (reviewers: per-frame arbitration flaps)
        if (g.mode === 'none') {
          g.accDrag += Math.abs(dDrag);
          g.accTwist += Math.abs(dTwist);
          if (g.accDrag > 0.012) g.mode = 'drag';
          else if (g.accTwist > 15 && r.b.gestures?.includes('pinch-twist')) g.mode = 'twist';
          else if (this.now - g.t0 > 0.25) g.mode = 'drag';
          if (g.mode === 'none') return;
        }
        const gain = r.b.dragGain ?? 0.1;
        const sign = r.b.invert ? -1 : 1;
        let dT = g.mode === 'drag' ? (dDrag / gain) * sign : (dTwist / sweepLen) * sign;
        if (r.b.detents && r.b.detents > 0) dT *= 1; // detents are applied by quantisation below
        const nextT = clamp(g.committedT + dT, 0, 1);
        g.committedT = nextT;
        this.setT(ctrl, this.detent(r, nextT), undefined, 'move');
        break;
      }
      case 'slide': {
        const travel = r.b.travel ?? [0, 0.16];
        const len = travel[1]! - travel[0]!;
        const s = local[axis] - g.offset;
        const t = clamp((s - travel[0]!) / len, 0, 1);
        this.setT(ctrl, this.detent(r, r.b.invert ? 1 - t : t), undefined, 'move');
        break;
      }
      case 'pull': {
        const travel = r.b.travel ?? [0, -0.08];
        const len = travel[1]! - travel[0]!;
        const s = local[axis] - g.offset;
        r.pull = clamp((s - travel[0]!) / len, 0, 1);
        break;
      }
      case 'xy': {
        const travel = r.b.travel ?? [-0.07, 0.07];
        const len = travel[1]! - travel[0]!;
        const tx = clamp((local.x - g.offset - travel[0]!) / len, 0, 1);
        const ty = clamp((local.y - g.offsetY - travel[0]!) / len, 0, 1);
        this.setT(ctrl, tx, ty, 'move');
        break;
      }
      default:
        break;
    }
  }

  private detent(r: BRun, t: number): number {
    const n = r.b.detents ?? 0;
    if (!n) return t;
    const step = 1 / n;
    const k = Math.round(t / step);
    const snapped = k * step;
    // sticky: snap within 35 % of the gap
    return Math.abs(t - snapped) < step * 0.35 ? snapped : t;
  }

  private release(g: Grab, c: Cursor): void {
    const r = g.run;
    this.grabs.delete(c.id);
    r.owner = null;
    if (r.b.type === 'grab') {
      this.getWorldPosition(_v);
      const yaw = (_e.setFromQuaternion(this.getWorldQuaternion(_q), 'YXZ').y * 180) / Math.PI;
      this.emitter.emit('grab', { specId: this.spec.specId, position: [_v.x, _v.y, _v.z], yawDeg: yaw });
      this.audio?.play('click', c.position);
      return;
    }
    const ctrl = r.ctrl!;
    if (r.b.type === 'pull') {
      if (r.pull >= 0.6) this.firePull(r, ctrl);
      r.pull = 0;
      return;
    }
    // release jump guard: the committed value is what the hand held before the fingers opened
    this.setT(ctrl, ctrl.t, undefined, 'end');
    this.audio?.play('click', c.position);
  }

  private firePull(r: BRun, ctrl: ControlState): void {
    const c = ctrl.control;
    const pos = this.worldPosOf(r.node);
    if (c.kind === 'trigger') {
      this.setValue(c.id, true, { phase: 'start' });
      this.setValue(c.id, false, { phase: 'end' });
    } else if (c.kind === 'toggle') {
      this.setValue(c.id, !(ctrl.value as boolean), { phase: 'start' });
    } else if (c.kind === 'stepped') {
      const rg = range(c);
      const step = rg.step ?? 1;
      const n = Math.round((rg.max - rg.min) / step);
      const cur = Math.round(((ctrl.value as number) - rg.min) / step);
      this.setValue(c.id, rg.min + ((cur + 1) % (n + 1)) * step, { phase: 'start' });
    }
    this.audio?.play('chirp', pos);
    const fr = this.fruns.find((f) => f.f.controlId === c.id && f.f.type === 'glow');
    if (fr) this.flashGlow(fr);
  }

  private updatePoke(r: BRun, c: Cursor): void {
    if (r.b.type !== 'press' && r.b.type !== 'toggle') return;
    if (!(r.b.gestures ?? []).includes('poke')) return;
    const axis = r.b.axis ?? 'z';
    const depth = r.b.depth ?? 0.007;
    const local = toLocal(r.parent, c.tip, _v).sub(r.restPos);
    const front = local[axis];
    const lateral = axis === 'z' ? Math.hypot(local.x, local.y) : axis === 'y' ? Math.hypot(local.x, local.z) : Math.hypot(local.y, local.z);
    const inside = lateral <= r.radius || (_box.setFromObject(r.node), !_box.isEmpty() && _box.expandByScalar(0.01).containsPoint(c.tip));
    const pokeId = `poke:${c.id}`;
    if (r.pressedBy === pokeId) {
      if (front > depth + 0.004 || lateral > r.radius * 1.5) this.releasePress(r, c);
      return;
    }
    if (inside && front > depth + 0.004 && front < depth + 0.08) r.pokeArmed.add(c.id);
    else if (!inside) r.pokeArmed.delete(c.id);
    if (r.pokeArmed.has(c.id) && inside && front < depth * 0.4 && front > -0.04 && this.now - r.lastPress > 0.12) {
      r.pokeArmed.delete(c.id);
      this.emitter.emit('consumed', { hand: c.hand, widget: 'control', specId: this.spec.specId, controlId: r.b.controlId });
      this.press(r, pokeId);
    }
  }

  private press(r: BRun, by: string): void {
    if (r.pressedBy || !r.ctrl) return;
    r.pressedBy = by;
    r.lastPress = this.now;
    const c = r.ctrl.control;
    const pos = this.worldPosOf(r.node);
    if (c.kind === 'trigger') this.setValue(c.id, true, { phase: 'start', index: r.b.index });
    else if (c.kind === 'toggle') this.setValue(c.id, !(r.ctrl.value as boolean), { phase: 'start', index: r.b.index });
    else if (c.kind === 'stepped' && r.b.index !== undefined) {
      const rg = range(c);
      this.setValue(c.id, rg.min + r.b.index * (rg.step ?? 1), { phase: 'start', index: r.b.index });
    }
    const snd = this.fruns.find((f) => f.f.controlId === c.id && f.f.type === 'tick' && f.f.on === 'trigger');
    this.audio?.play(snd?.f.sound === 'chirp' ? 'chirp' : snd?.f.sound === 'pluck' ? 'pluck' : 'click', pos);
    for (const fr of this.fruns) {
      if (fr.f.controlId !== c.id) continue;
      if (fr.f.type === 'scale-pop' && fr.node) this.pop(fr.node);
      if (fr.f.type === 'glow' && fr.f.on === 'trigger' && fr.part && (fr.part.id === r.b.partId || fr.part.parentId === r.b.partId)) this.flashGlow(fr);
      if (fr.f.type === 'glitch' && fr.mat instanceof HoloMaterial) {
        fr.mat.u.uGlitch.value = 1;
        this.tweens.add(0.24, () => {}, () => ((fr.mat as HoloMaterial).u.uGlitch.value = 0));
      }
    }
  }

  private releasePress(r: BRun, c?: Cursor): void {
    if (!r.pressedBy || !r.ctrl) return;
    r.pressedBy = null;
    const ctrl = r.ctrl.control;
    if (ctrl.kind === 'trigger') this.setValue(ctrl.id, false, { phase: 'end', index: r.b.index });
    else this.setValue(ctrl.id, r.ctrl.value, { phase: 'end', index: r.b.index });
    void c;
  }

  private pop(node: Object3D): void {
    const base = this.baseScale.get(node.userData.partId as string) ?? new Vector3(1, 1, 1);
    this.tweens.add(0.16, (t) => {
      const s = t < 0.5 ? 1 - 0.06 * (t / 0.5) : 0.94 + 0.06 * ease.outBack((t - 0.5) / 0.5);
      node.scale.copy(base).multiplyScalar(s);
    }, () => node.scale.copy(base));
  }

  private flashGlow(fr: FRun): void {
    const mat = fr.mat;
    if (!mat) return;
    this.tweens.add(0.25, (t) => {
      const k = 1 - t;
      if (mat instanceof HoloMaterial) mat.u.uGlow.value = fr.baseGlow + 1.5 * k;
      else if (mat instanceof MeshStandardMaterial) mat.emissiveIntensity = fr.baseEmissive * (1 + 1.5 * k);
    });
  }

  // --- visuals --------------------------------------------------------------------------------------------

  private applyVisuals(_dt: number): void {
    for (const r of this.runs) {
      const t = r.ctrl?.visualT ?? 0;
      const axisName = r.b.axis ?? (r.b.type === 'slide' ? 'y' : 'z');
      const axis = AXIS_VEC[axisName];
      switch (r.b.type) {
        case 'rotate': {
          const sweep = r.b.sweepDeg ?? [-135, 135];
          const deg = sweep[0]! + t * (sweep[1]! - sweep[0]!);
          // z: clockwise as seen by the user = negative rotation about +z; x/y: right-hand rule
          const rad = (axisName === 'z' ? -deg : deg) * DEG;
          r.node.quaternion.copy(r.restQuat).multiply(_q.setFromAxisAngle(axis, rad));
          break;
        }
        case 'slide': {
          const travel = r.b.travel ?? [0, 0.16];
          const s = travel[0]! + t * (travel[1]! - travel[0]!);
          r.node.position.copy(r.restPos).addScaledVector(axis, s);
          break;
        }
        case 'toggle': {
          if (r.b.travel) {
            const on = r.ctrl ? (r.ctrl.value as boolean) : false;
            const target = on ? r.b.travel[1]! : r.b.travel[0]!;
            const cur = r.node.position.clone().sub(r.restPos).dot(axis);
            const next = damp(cur, target, 0.06, _dt);
            r.node.position.copy(r.restPos).addScaledVector(axis, next);
          } else r.node.position.copy(r.restPos).addScaledVector(axis, -(r.b.depth ?? 0.007) * r.pressAmt);
          break;
        }
        case 'press':
          r.node.position.copy(r.restPos).addScaledVector(axis, -(r.b.depth ?? 0.007) * r.pressAmt);
          break;
        case 'pull': {
          const travel = r.b.travel ?? [0, -0.08];
          const s = travel[0]! + r.pull * (travel[1]! - travel[0]!);
          r.node.position.copy(r.restPos).addScaledVector(axis, s);
          break;
        }
        case 'xy': {
          const travel = r.b.travel ?? [-0.07, 0.07];
          const len = travel[1]! - travel[0]!;
          r.node.position.set(r.restPos.x + travel[0]! + t * len, r.restPos.y + travel[0]! + (r.ctrl?.visualTy ?? 0.5) * len, r.restPos.z);
          break;
        }
        default:
          break;
      }
    }
  }

  private applyFeedback(_dt: number): void {
    for (const fr of this.fruns) {
      const c = this.controls.get(fr.f.controlId);
      if (!c) continue;
      switch (fr.f.type) {
        case 'arc-fill': {
          const mesh = fr.node instanceof Mesh ? fr.node : undefined;
          if (!mesh || !fr.part) break;
          const run = this.runs.find((r) => r.b.controlId === c.control.id && (r.b.type === 'rotate' || r.b.type === 'slide'));
          const t = c.visualT;
          if (fr.part.shape === 'ring') {
            const sweep = run?.b.sweepDeg ?? [-135, 135];
            const a = sweep[0]!;
            const cur = a + t * (sweep[1]! - a);
            const key = Math.round(cur * 4);
            if (mesh.userData.arcKey === key) break;
            mesh.userData.arcKey = key;
            const d = fr.part.dims ?? {};
            mesh.geometry.dispose();
            mesh.geometry = new RingGeometry(d.rInner ?? 0.03, d.rOuter ?? d.r ?? 0.04, 64, 1, (90 - cur) * DEG, Math.max(0.5, cur - a) * DEG);
          } else if (fr.part.shape === 'box') {
            const travel = run?.b.travel ?? [-0.08, 0.08];
            const len = travel[1]! - travel[0]!;
            const axis = run?.b.axis ?? 'y';
            const base = this.baseScale.get(fr.part.id) ?? new Vector3(1, 1, 1);
            const fill = Math.max(0.01, t);
            const s = base.clone();
            s[axis] = base[axis] * fill;
            mesh.scale.copy(s);
            const rest = fr.part.transform?.position ?? [0, 0, 0];
            const dimAlong = axis === 'y' ? (fr.part.dims?.h ?? 0.002) : axis === 'x' ? (fr.part.dims?.w ?? 0.002) : (fr.part.dims?.d ?? 0.002);
            mesh.position.set(rest[0]!, rest[1]!, rest[2]!);
            mesh.position[axis] = travel[0]! + (t * len) / 2 - (dimAlong * (1 - fill)) / 2;
          }
          break;
        }
        case 'glow': {
          if (!fr.mat) break;
          const on = fr.f.on ?? 'hover';
          if (on !== 'hover') break;
          const run = this.runs.find((r) => r.b.controlId === c.control.id);
          const h = run?.hover ?? 0;
          if (fr.mat instanceof HoloMaterial) {
            fr.mat.u.uGlow.value = fr.baseGlow + 1.4 * h;
            if (fr.f.color && h > 0.01) (fr.mat.u.uRim.value as Color).set(fr.f.color);
          } else if (fr.mat instanceof MeshStandardMaterial) {
            fr.mat.emissiveIntensity = fr.baseEmissive * (1 + 1.2 * h);
            if (fr.f.color && fr.baseColor) fr.mat.emissive.copy(fr.baseColor).lerp(new Color(fr.f.color), h);
          } else if (fr.mat instanceof MeshBasicMaterial && !(fr.mat.name === 'ghost')) {
            fr.mat.opacity = Math.min(1, 0.12 + 0.5 * h);
          }
          break;
        }
        case 'color-shift': {
          const mesh = fr.node instanceof Mesh ? fr.node : undefined;
          if (!mesh) break;
          const mat = mesh.material as MeshStandardMaterial | HoloMaterial;
          const col = colorForValue(c);
          if (mat instanceof MeshStandardMaterial) {
            mat.color.set(col);
            mat.emissive.set(col);
          } else if (mat instanceof HoloMaterial) (mat.u.uColor.value as Color).set(col);
          break;
        }
        default:
          break;
      }
    }
  }

  private applyBirths(time: number): void {
    if (!this.births.size) return;
    for (const [id, birth] of this.births) {
      const node = this.nodes.get(id);
      if (!node) {
        this.births.delete(id);
        continue;
      }
      const age = time - birth;
      const f = age < 0 ? 0 : Math.min(1, age / 0.3);
      const e = ease.outCubic(f);
      const base = this.baseScale.get(id) ?? new Vector3(1, 1, 1);
      node.visible = age >= 0;
      node.scale.copy(base).multiplyScalar(0.9 + 0.1 * e);
      // position-only glitch while curing (no luminance flashing)
      const part = this.parts.get(id);
      const rest = part?.transform?.position ?? [0, 0, 0];
      const jitter = (1 - e) * 0.004 * Math.sin(time * 37 + id.length);
      if (part?.kind !== 'path') node.position.x = rest[0]! + jitter;
      if (node instanceof Mesh && node.material instanceof HoloMaterial) node.material.u.uBirth.value = e;
      else if (node instanceof Label) node.material.opacity = e;
      else if (node instanceof PathObject) node.setBirth(e);
      if (f >= 1) {
        this.births.delete(id);
        node.position.x = rest[0]!;
      }
    }
  }

  private applyVisibility(): void {
    for (const node of this.nodes.values()) {
      const when = node.userData.visibleWhen as Part['visibleWhen'];
      if (!when || when === 'always') continue;
      if (this.births.has(node.userData.partId as string)) {
        node.visible = false;
        continue;
      }
      const partId = node.userData.partId as string;
      const owner = this.expanded.origin.get(partId) ?? partId;
      const ownerPart = this.parts.get(owner);
      const ctrl = ownerPart?.controlId ? this.controls.get(ownerPart.controlId) : undefined;
      const armed = this.armedAll && (ctrl ? ctrl.armed : true);
      const hover = (this.hoverArchetype.get(owner) ?? 0) > 0.3;
      const grabbed = this.runs.some((r) => r.archetypeId === owner && r.owner);
      node.visible = when === 'armed' ? armed : when === 'disarmed' ? !armed : when === 'hover' ? hover || grabbed : when === 'grabbed' ? grabbed : when === 'never' ? false : true;
    }
  }

  private worldPosOf(node: Object3D | undefined): Vector3 | undefined {
    return node ? node.getWorldPosition(new Vector3()) : undefined;
  }

  /** Meshes a raycaster may hit for mouse interaction. */
  interactiveMeshes(): Object3D[] {
    return this.meshes.filter((m) => !(m.userData.role === 'label'));
  }

  override dispose(): void {
    this.clearContent();
    this.reasonLabel?.dispose();
  }
}

// --- value helpers ---------------------------------------------------------------------------------------------

export function range(c: Control): { min: number; max: number; step?: number } {
  const r = c.range ?? { min: 0, max: 1 };
  return r.step !== undefined ? { min: r.min, max: r.max, step: r.step } : { min: r.min, max: r.max };
}

export function defaultValue(c: Control): ControlValue {
  switch (c.kind) {
    case 'toggle':
    case 'trigger':
      return false;
    case 'xy':
      return { x: (range(c).min + range(c).max) / 2, y: ((c.yRange?.min ?? 0) + (c.yRange?.max ?? 1)) / 2 };
    default:
      return range(c).min;
  }
}

export function normalize(c: Control, v: ControlValue): { t: number; ty: number } {
  if (typeof v === 'boolean') return { t: v ? 1 : 0, ty: 0 };
  const r = range(c);
  if (typeof v === 'number') return { t: clamp((v - r.min) / (r.max - r.min || 1), 0, 1), ty: 0 };
  const yr = c.yRange ?? { min: 0, max: 1 };
  return { t: clamp((v.x - r.min) / (r.max - r.min || 1), 0, 1), ty: clamp((v.y - yr.min) / (yr.max - yr.min || 1), 0, 1) };
}

export function fromT(c: Control, t: number, ty: number): ControlValue {
  const r = range(c);
  if (c.kind === 'toggle' || c.kind === 'trigger') return t >= 0.5;
  const x = r.min + t * (r.max - r.min);
  if (c.kind === 'xy') {
    const yr = c.yRange ?? { min: 0, max: 1 };
    return { x, y: yr.min + ty * (yr.max - yr.min) };
  }
  return x;
}

export function quantize(c: Control, v: ControlValue): ControlValue {
  const r = range(c);
  const q = (x: number, rg: { min: number; max: number; step?: number }) => {
    const cl = clamp(x, rg.min, rg.max);
    if (!rg.step) return Math.round(cl * 1e6) / 1e6;
    return Math.round((Math.round((cl - rg.min) / rg.step) * rg.step + rg.min) * 1e6) / 1e6;
  };
  if (typeof v === 'number') return q(v, r);
  if (typeof v === 'boolean') return v;
  return { x: q(v.x, r), y: q(v.y, c.yRange ?? { min: 0, max: 1 }) };
}

function sameValue(a: ControlValue, b: ControlValue): boolean {
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object' && typeof b === 'object') return a.x === b.x && a.y === b.y;
  return a === b;
}

export function formatValue(c: Control, v: ControlValue, format = '{value}'): string {
  const r = range(c);
  const num = (x: number) => (r.step && r.step >= 1 ? Math.round(x).toString() : Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2).replace(/\.?0+$/, ''));
  let value = '';
  let percent = '';
  let label = '';
  let xs = '';
  let ys = '';
  if (typeof v === 'boolean') {
    value = v ? 'ON' : 'OFF';
    label = value;
  } else if (typeof v === 'number') {
    value = num(v);
    percent = Math.round(((v - r.min) / (r.max - r.min || 1)) * 100).toString();
    if (c.stepLabels?.length) label = c.stepLabels[Math.round((v - r.min) / (r.step ?? 1))] ?? value;
    else label = value;
  } else {
    xs = num(v.x);
    ys = num(v.y);
    value = `${xs},${ys}`;
    label = value;
  }
  if (c.stepLabels?.length && format === '{value}{unit}') format = '{label}';
  return format.replace('{value}', value).replace('{unit}', c.unit ?? '').replace('{percent}', percent).replace('{label}', label).replace('{name}', c.label).replace('{x}', xs).replace('{y}', ys);
}

function colorForValue(c: ControlState): string {
  const ctrl = c.control;
  if (ctrl.kind === 'toggle') return (c.value as boolean) ? NEON.magenta : NEON.dim;
  // hue by normalised value (wheel)
  const h = Math.round(c.t * 360) % 360;
  return `hsl(${h}, 90%, 55%)`;
}

/** Map an image onto a plate: cover crops, contain letterboxes (transparent edges), tile repeats. */
function fitTexture(tex: Texture, fit: Skin['fit'], plateAspect: number, image: { width: number; height: number } | undefined): void {
  const imgAspect = image && image.height ? image.width / image.height : plateAspect;
  tex.wrapS = tex.wrapT = fit === 'tile' ? 1000 : 1001; // RepeatWrapping : ClampToEdgeWrapping
  if (fit === 'tile') {
    tex.repeat.set(Math.max(1, Math.round(plateAspect / imgAspect)), 1);
    return;
  }
  const ratio = plateAspect / imgAspect;
  if (fit === 'cover') {
    if (ratio > 1) tex.repeat.set(1, 1 / ratio), tex.offset.set(0, (1 - 1 / ratio) / 2);
    else tex.repeat.set(ratio, 1), tex.offset.set((1 - ratio) / 2, 0);
  } else {
    if (ratio > 1) tex.repeat.set(ratio, 1), tex.offset.set((1 - ratio) / 2, 0);
    else tex.repeat.set(1, 1 / ratio), tex.offset.set(0, (1 - 1 / ratio) / 2);
  }
}

/** Tags, model chips and handles stay solid while the controls are ghosts: they are the HUD, not the device's controls. */
function isChrome(p: Part | undefined): boolean {
  return !!p && p.kind === 'archetype' && (p.archetype === 'tag' || p.archetype === 'model-chips' || p.archetype === 'handle' || p.archetype === 'worklog' || p.archetype === 'reticle');
}

function yawToward(obj: Object3D, worldTarget: Vector3): void {
  const parent = obj.parent;
  if (!parent) return;
  const local = parent.worldToLocal(worldTarget.clone());
  const dx = local.x - obj.position.x;
  const dz = local.z - obj.position.z;
  obj.rotation.set(0, Math.atan2(dx, dz), 0);
}
