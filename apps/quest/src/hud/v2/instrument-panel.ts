/** Muse's bounded instrument, using the existing gen3d renderer and input runtime. */
import { Box3, BufferAttribute, BufferGeometry, Camera, Color, DynamicDrawUsage, Group, InstancedMesh, LineBasicMaterial, LineSegments, Matrix4, MeshBasicMaterial, RingGeometry, SphereGeometry, Vector3 } from 'three';
import type { Gen3dSpec, ControlEvent } from '@ce/gen3d';
import type { WireReadyPayload } from '@ce/protocol';
import { SpecObject } from '../../gen3d/build';
import { MaterialClock } from '../../gen3d/materials';
import { UiAudio } from '../../gen3d/audio';
import { handCursor, newCursor, type Cursor } from '../../gen3d/interact';
import type { HudFrame, WireOutputStream } from '../contract';

const CAPACITY = 256, LIFE = 4;
/** Fixed pools: two instanced draws + one line draw, no animation-loop geometry allocation. */
class InstrumentTrace extends Group {
  private readonly rings = new InstancedMesh(new RingGeometry(.88, 1, 24), new MeshBasicMaterial({ transparent: true, opacity: .75, depthWrite: false, toneMapped: false }), CAPACITY);
  private readonly notes = new InstancedMesh(new SphereGeometry(1, 8, 5), new MeshBasicMaterial({ transparent: true, opacity: .9, depthWrite: false, toneMapped: false }), CAPACITY);
  private readonly lines = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: '#8ad8ff', transparent: true, opacity: .5, depthWrite: false, toneMapped: false }));
  private readonly vertices = new Float32Array(CAPACITY * 6);
  private readonly instanceTransform = new Matrix4();
  private readonly color = new Color();
  private readonly times = new Float64Array(CAPACITY).fill(-Infinity);
  private readonly xs = new Float32Array(CAPACITY);
  private readonly ys = new Float32Array(CAPACITY);
  private readonly kinds = new Uint8Array(CAPACITY);
  private readonly levels = new Float32Array(CAPACITY);
  private readonly previous = new Int16Array(CAPACITY).fill(-1);
  private readonly actionIds = Array<string>(CAPACITY).fill('');
  private readonly lastPoint = new Map<string, number>();
  private eventCount = 0;
  private cursor = 0;
  private readonly lastContinuousAt = new Map<string, number>();
  private sampleGapMs = 40;
  private actionEvents: Record<string, number> = Object.create(null);
  private seq = 0;
  private readonly point = new Vector3();
  private readonly values = new Map<string, number>();
  private allowed: Set<string> | undefined;
  private kind = 'pulse';
  private spec?: Gen3dSpec;
  /** Local y of the outgoing-stream ribbon: under the instrument, so nothing rises in front of the device. */
  ribbonY = -0.2;
  constructor() {
    super();
    this.rings.instanceMatrix.setUsage(DynamicDrawUsage); this.notes.instanceMatrix.setUsage(DynamicDrawUsage);
    this.rings.frustumCulled = this.notes.frustumCulled = false;
    this.lines.geometry.setAttribute('position', new BufferAttribute(this.vertices, 3).setUsage(DynamicDrawUsage));
    this.lines.frustumCulled = false;
    this.rings.raycast = this.notes.raycast = this.lines.raycast = () => {};
    for (const object of [this.rings, this.notes, this.lines]) { object.renderOrder = 90; object.material.depthTest = false; }
    this.add(this.rings, this.notes, this.lines);
  }
  configure(spec: Gen3dSpec, visualizer?: WireReadyPayload['visualizer']): void {
    this.spec = spec; this.kind = visualizer?.kind ?? 'pulse'; this.allowed = visualizer ? new Set(visualizer.actions) : undefined;
    this.seq = 0; this.eventCount = 0; this.cursor = 0; this.times.fill(-Infinity); this.values.clear(); this.lastPoint.clear(); this.lastContinuousAt.clear();
    const actions = new Set(visualizer?.actions ?? spec.controls.flatMap(c => c.yBinding ? [c.binding.action, c.yBinding.action] : [c.binding.action]));
    this.actionEvents = Object.create(null);
    for (const action of actions) { this.lastContinuousAt.set(action, -Infinity); this.actionEvents[action] = 0; }
    // Reserve 64 particles for notes; the remaining slots cover about four seconds per action.
    this.sampleGapMs = Math.max(40, Math.ceil(4000 * Math.max(1, actions.size) / (CAPACITY - 64)));
    this.userData.actionEvents = this.actionEvents;
  }
  private receive(action: string, value: number | boolean, at: number, visibleAt: number): void {
    if (this.allowed && !this.allowed.has(action)) return;
    this.values.set(action, Number(value));
    const c = this.spec?.controls.find(c => c.binding.action === action || c.yBinding?.action === action)
      ?? (this.kind === 'ripple' ? this.spec?.controls.find(c => c.kind === 'xy') : undefined);
    const p = c && this.spec?.parts.find(p => p.controlId === c.id);
    this.eventCount++;
    if (c?.kind !== 'stepped' && at - (this.lastContinuousAt.get(action) ?? -Infinity) < this.sampleGapMs) return;
    if (c?.kind !== 'stepped') this.lastContinuousAt.set(action, at);
    this.actionEvents[action] = (this.actionEvents[action] ?? 0) + 1;
    const base = p?.transform?.position;
    let x = base?.[0] ?? 0, y = base?.[1] ?? .08;
    if (c?.kind === 'xy') {
      const xr = c.range ?? { min: 0, max: 1 }, yr = c.yRange ?? { min: 0, max: 1 };
      x += (((this.values.get(c.binding.action) ?? (xr.min + xr.max) / 2) - xr.min) / (xr.max - xr.min) - .5) * .156;
      y += (((this.values.get(c.yBinding?.action ?? '') ?? (yr.min + yr.max) / 2) - yr.min) / (yr.max - yr.min) - .5) * .156;
    } else if (c?.kind === 'stepped') {
      const r = c.range ?? { min: 0, max: 11 };
      x += ((Number(value) - r.min) / (r.max - r.min) - .5) * .48;
      y += .06;
    }
    const i = this.cursor++ % CAPACITY;
    this.times[i] = visibleAt; this.xs[i] = x; this.ys[i] = y;
    this.kinds[i] = c?.kind === 'xy' ? 2 : c?.kind === 'stepped' || this.kind === 'notes' && /note|pitch|key|pad/i.test(c?.label ?? action) ? 1 : 0;
    const range = c?.yBinding?.action === action ? c.yRange : c?.range;
    this.levels[i] = Math.max(0, Math.min(1, range ? (Number(value) - range.min) / (range.max - range.min) : Number(value)));
    this.previous[i] = this.lastPoint.get(action) ?? -1; this.actionIds[i] = action; this.lastPoint.set(action, i);
  }
  update(time: number, stream?: WireOutputStream): void {
    if (stream) {
      // Slots are reused by the sender. Read in sequence order after pauses/bursts.
      for (let seq = Math.max(this.seq + 1, stream.seq - stream.slots.length + 1); seq <= stream.seq; seq++) {
        const e = stream.slots[(seq - 1) % stream.slots.length];
        if (e?.seq === seq) this.receive(e.actionId, e.value, e.at, time);
      }
      this.seq = stream.seq;
    }
    let active = 0;
    for (let i = 0; i < CAPACITY; i++) {
      const age = time - this.times[i]!, historyLive = age >= 0 && age < LIFE;
      const note = this.kinds[i] === 1, xy = this.kinds[i] === 2;
      const effectLife = note ? LIFE : .9, live = historyLive && age < effectLife;
      const r = live ? note ? .008 * Math.max(0, 1 - age / LIFE) : xy ? Math.min(.08, .016 + age * .065) : Math.min(.05, .018 + age * .032) : 0;
      this.point.set(this.xs[i]!, this.ys[i]! + (note && live ? age * .06 : 0), .075);
      this.instanceTransform.makeScale(note ? 0 : r, note ? 0 : r, note ? 0 : r).setPosition(this.point); this.rings.setMatrixAt(i, this.instanceTransform);
      this.instanceTransform.makeScale(note ? r : 0, note ? r * 1.7 : 0, note ? r : 0).setPosition(this.point); this.notes.setMatrixAt(i, this.instanceTransform);
      this.color.setHSL(note ? .52 + (i % 4) * .035 : .54, .62, live ? .55 * (1 - age / effectLife) : 0);
      this.rings.setColorAt(i, this.color); this.notes.setColorAt(i, this.color);
      // A four-second ribbon of the actual outgoing stream, above the instrument.
      const j = i * 6, px = historyLive ? .31 - age * .155 : 0, py = historyLive ? this.ribbonY + this.levels[i]! * .05 : 0;
      const prior = this.previous[i]!, priorAge = prior < 0 ? Infinity : time - this.times[prior]!;
      const connected = historyLive && prior !== i && priorAge >= age && priorAge < LIFE && this.actionIds[prior] === this.actionIds[i];
      this.vertices[j] = px; this.vertices[j + 1] = py; this.vertices[j + 2] = .02;
      this.vertices[j + 3] = connected ? .31 - priorAge * .155 : historyLive ? px + .006 : 0; this.vertices[j + 4] = connected ? this.ribbonY + this.levels[prior]! * .05 : historyLive ? py + .006 : 0; this.vertices[j + 5] = historyLive ? .02 : 0;
      if (live) active++;
    }
    this.rings.count = this.notes.count = Math.min(CAPACITY, this.cursor);
    this.rings.instanceMatrix.needsUpdate = this.notes.instanceMatrix.needsUpdate = true;
    if (this.rings.instanceColor) this.rings.instanceColor.needsUpdate = true;
    if (this.notes.instanceColor) this.notes.instanceColor.needsUpdate = true;
    this.lines.geometry.getAttribute('position').needsUpdate = true;
    this.lines.geometry.setDrawRange(0, Math.min(CAPACITY, this.cursor) * 2);
    this.userData.active = active; this.userData.events = this.eventCount;
  }
  override dispose(): void { for (const m of [this.rings, this.notes, this.lines]) { m.geometry.dispose(); m.material.dispose(); } }
}

export class InstrumentPanel extends Group {
  private readonly clock = new MaterialClock();
  private readonly audio = new UiAudio();
  private readonly trace = new InstrumentTrace();
  private object?: SpecObject;
  private key = '';
  private debugSnapshot?: Record<string, unknown>;
  private readonly cursors = [newCursor('left', 'left'), newCursor('right', 'right')];
  private readonly local = new Vector3();
  private readonly direction = new Vector3();
  private readonly look = new Vector3();
  private active = false;
  private directTouch = false;
  /** Local extent of the built instrument (metres, before the HUD's scale): placement keeps it clear of the device. */
  extent = { top: 0.15, bottom: -0.15, half: 0.3 };
  /** Faders/XY pads poked this frame and last frame, with the last value sent: the finger leaving sends one `end`. */
  private poked = new Map<string, import('@ce/gen3d').ControlValue>();
  private pokedBefore = new Map<string, import('@ce/gen3d').ControlValue>();
  onControl?: (actionId: string, value: number | boolean, phase: 'start' | 'move' | 'end') => void;
  onConsumed?: (hand: string) => void;
  constructor() { super(); this.name = 'muse-instrument'; this.visible = false; this.add(this.trace); (this as unknown as { pointerEvents: string }).pointerEvents = 'none'; }
  get interacting(): boolean { return this.active && (this.directTouch || !!this.object?.interacting); }
  set(spec: Gen3dSpec | null, visualizer?: WireReadyPayload['visualizer']): void {
    this.active = this.visible = !!spec;
    const key = spec ? `${spec.specId}:${spec.rev}` : '';
    if (key === this.key) return;
    this.key = key;
    this.object?.removeFromParent(); this.object?.dispose(); this.object = undefined;
    if (!spec) return;
    this.object = new SpecObject(spec, { compact: true, clock: this.clock, audio: this.audio, sink: { control: e => this.control(e) } });
    this.object.emitter.on('consumed', e => this.onConsumed?.(e.hand));
    // Measured before it is parented, so the bounds are in this panel's own frame.
    this.object.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(this.object);
    if (!bounds.isEmpty()) this.extent = { top: Math.min(0.4, bounds.max.y), bottom: Math.max(-0.4, bounds.min.y), half: Math.min(0.6, Math.max(-bounds.min.x, bounds.max.x)) };
    this.add(this.object); this.trace.configure(spec, visualizer);
    this.trace.ribbonY = this.extent.bottom - 0.07;
    this.debugSnapshot = { controls: spec.controls.map(c => ({ id: c.id, actionId: c.binding.action, kind: c.kind, label: c.label })), visualizerEvents: 0, visualizerActions: this.trace.userData.actionEvents, activeEffects: 0, drawCalls: 3 };
    this.trace.renderOrder = 90;
  }
  private control(e: ControlEvent): void {
    const c = this.object?.spec.controls.find(c => c.id === e.controlId);
    if (!c) return;
    // Press banks emit once on the down edge, even when the same note is played twice.
    if (c.kind === 'stepped' || c.kind === 'trigger' || c.kind === 'toggle') {
      if (e.phase !== 'start') return;
      this.onControl?.(c.binding.action, e.value as number | boolean, 'move');
    } else if (typeof e.value === 'object') {
      this.onControl?.(c.binding.action, e.value.x, e.phase);
      if (c.yBinding) this.onControl?.(c.yBinding.action, e.value.y, e.phase);
    } else this.onControl?.(c.binding.action, e.value, e.phase);
  }
  place(anchor: Vector3, head: Vector3): void {
    if (this.interacting) return;
    this.position.copy(anchor); this.look.copy(head); this.lookAt(this.look);
  }
  private prepare(cursor: Cursor): void {
    if (!cursor.tracked || !this.object) return;
    // Desktop and far-ray pinches use the same visible instrument plane.
    if (cursor.ray) {
      this.local.copy(cursor.ray.origin); this.worldToLocal(this.local);
      this.direction.copy(cursor.ray.origin).add(cursor.ray.dir); this.worldToLocal(this.direction); this.direction.sub(this.local);
      if (Math.abs(this.direction.z) > 1e-6) {
        const t = .03 - this.local.z;
        const distance = t / this.direction.z;
        if (distance >= 0) {
          this.local.addScaledVector(this.direction, distance);
          if (Math.abs(this.local.x) < .6 && Math.abs(this.local.y) < .35) {
            this.localToWorld(this.local);
            cursor.position.copy(this.local);
            if (!cursor.canPoke) cursor.tip.copy(this.local);
          }
        }
      }
    }
    // Touch an XY surface directly; pinching and dragging is optional.
    if (cursor.canPoke) for (const c of this.object.spec.controls) {
      const p = this.object.spec.parts.find(p => p.controlId === c.id);
      if (c.kind !== 'xy' && p?.archetype !== 'fader') continue;
      if (!p) continue;
      this.local.copy(cursor.tip); this.worldToLocal(this.local);
      const pos = p.transform?.position;
      const x = this.local.x - (pos?.[0] ?? 0), y = this.local.y - (pos?.[1] ?? 0);
      if (p.archetype === 'fader') {
        const length = p.params?.length ?? p.params?.size ?? .16;
        if (Math.abs(x) < .04 && Math.abs(y) < length / 2 + .01 && this.local.z >= -.02 && this.local.z <= .05) {
          const range = c.range ?? { min: 0, max: 1 };
          const value = range.min + Math.max(0, Math.min(1, y / length + .5)) * (range.max - range.min);
          this.object.setValue(c.id, value, { phase: 'move' }); this.poked.set(c.id, value);
          this.directTouch = true; this.onConsumed?.(cursor.hand);
        }
        continue;
      }
      if (Math.abs(x) > .09 || Math.abs(y) > .09 || this.local.z < -.03 || this.local.z > .04) continue;
      const xr = c.range ?? { min: 0, max: 1 }, yr = c.yRange ?? { min: 0, max: 1 };
      const value = { x: xr.min + Math.max(0, Math.min(1, x / .156 + .5)) * (xr.max - xr.min), y: yr.min + Math.max(0, Math.min(1, y / .156 + .5)) * (yr.max - yr.min) };
      this.object.setValue(c.id, value, { phase: 'move' }); this.poked.set(c.id, value);
      this.directTouch = true; this.onConsumed?.(cursor.hand);
    }
  }
  update(frame: HudFrame, camera: Camera, stream?: WireOutputStream): void {
    if (!this.object || !this.active) return;
    this.updateMatrixWorld(true);
    this.directTouch = false;
    handCursor('left', frame.hands.left, this.cursors[0]!); handCursor('right', frame.hands.right, this.cursors[1]!);
    [this.pokedBefore, this.poked] = [this.poked, this.pokedBefore]; this.poked.clear();
    for (const c of this.cursors) this.prepare(c);
    // A fingertip that left a fader/XY pad ends that gesture once (e.g. releases a theremin note).
    for (const [id, value] of this.pokedBefore) if (!this.poked.has(id)) this.object.setValue(id, value, { phase: 'end' });
    this.clock.tick(frame.time / 1000);
    this.object.update(frame.dt, frame.time / 1000, this.cursors, camera);
    this.trace.update(frame.time / 1000, stream);
  }
  snapshot(): Record<string, unknown> | undefined {
    if (!this.visible || !this.object) return;
    const snapshot = this.debugSnapshot!;
    snapshot.visualizerEvents = this.trace.userData.events ?? 0; snapshot.activeEffects = this.trace.userData.active ?? 0;
    return snapshot;
  }
  override dispose(): void { this.object?.dispose(); this.trace.dispose(); }
}
