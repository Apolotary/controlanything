/**
 * The HUD: everything the app shell shows in the room, built from gen3d specs so the agent's HUD and the
 * generated controls are one system (one validator, one budget, one interaction runtime).
 *
 *   targets   outline + brackets + tag (+ twin) per detection, world-anchored where the shell placed them
 *   pings     ping-line per route (hypothesis grey dashed → requested volt → verified)
 *   worklog   agent steps with evidence words and the Meta model ids, lazily following the head
 *   hack menu / upload bar / evidence strip / confirm key beside the locked target
 *   deck      palm panel: SCAN · PING · HACKS · DAEMONS · UNDO · PANIC
 *   reticle   head-ray cursor; specs: generated 3D controls (renderSpec / patchSpec / setArmed / setControlValue)
 */
import { Camera, Group, Object3D, Quaternion, Scene, Vector3, WebGLRenderer } from 'three';
import type { ControlEvent, Gen3dSpec, HackItem, HudStatus, LogRow, ModelChip, Part, Patch } from '@ce/gen3d';
import { EXAMPLES, NEON, SpecHistory, applyPatch, validateSpec } from '@ce/gen3d';
import { SpecObject, type GenEvents } from '../gen3d/build';
import { UiAudio } from '../gen3d/audio';
import { Emitter, type EventSink } from '../gen3d/events';
import { handCursor, newCursor, type Cursor } from '../gen3d/interact';
import { MaterialClock } from '../gen3d/materials';
import { RoomDim } from '../fx/roomDim';
import { ScanSweep } from '../fx/sweep';
import { damp } from '../gen3d/anim';
import type { AgentStepLike, ConfirmRequest, EvidenceState, Hud, HudEvents, HudFrame, HudTarget, PingLine, UploadState } from './contract';
import '../gen3d/index';

export * from './contract';

const _v = new Vector3();
const _q = new Quaternion();

interface Mounted {
  obj: SpecObject;
  /** which spec this object shows (for diffs) */
  spec: Gen3dSpec;
  history?: SpecHistory;
  targetId?: string;
}

export function createHud(ctx: { scene: Scene; camera: Camera; renderer: WebGLRenderer }): Hud {
  return new HudImpl(ctx);
}

class HudImpl implements Hud {
  readonly root = new Group();
  private readonly clock = new MaterialClock();
  private readonly audio = new UiAudio();
  private readonly events = new Emitter<HudEvents>();
  private readonly objects = new Map<string, Mounted>();
  private readonly targets = new Map<string, HudTarget>();
  private readonly cursors: Cursor[] = [newCursor('left', 'left'), newCursor('right', 'right')];
  private readonly roomDim = new RoomDim();
  private readonly sweep = new ScanSweep();
  private candidate: string | null = null;
  private locked: string | null = null;
  private steps = new Map<string, AgentStepLike>();
  private chips: ModelChip[] = [];
  private pings: PingLine[] = [];
  private scanning = false;
  /** declutter state: menus by target, which collapsed menus the user expanded, armed → ticker, verifying → focus */
  private menus = new Map<string, { title: string; subtitle?: string; items: HackItem[] }>();
  private expandedMenus = new Set<string>();
  private armedAny = false;
  private logExpanded = false;
  private verifying = false;
  private evidenceTimer: ReturnType<typeof setTimeout> | null = null;
  private worklogPose = { position: new Vector3(), yaw: 0, placed: false };
  private deckOpen = false;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private time = 0;
  private readonly camera: Camera;
  private readonly sink: EventSink;

  constructor(ctx: { scene: Scene; camera: Camera; renderer: WebGLRenderer }) {
    this.camera = ctx.camera;
    this.root.name = 'hud';
    this.root.add(this.roomDim, this.sweep);
    // full-screen effects must never catch the desktop mouse ray (the dim plane sits 0.3 m in front of the camera
    // and three's Raycaster does not skip invisible meshes): without this no widget could be clicked in the emulator
    for (const fx of [this.roomDim, this.sweep]) fx.traverse((o) => void (o.raycast = () => {}));
    ctx.scene.add(this.root);
    this.sink = { control: (e) => this.events.emit('control', e) };
    ctx.renderer.domElement.addEventListener('pointerdown', () => this.audio.unlock(), { once: true });
  }

  on<K extends keyof HudEvents>(k: K, fn: (e: HudEvents[K]) => void): () => void {
    return this.events.on(k, fn);
  }

  /** Dev hook (gallery, IWER): extra cursors (mouse, emulated controllers) that operate HUD widgets. */
  setDevCursors(cursors: Cursor[]): void {
    this.devCursors = cursors;
  }
  private devCursors: Cursor[] = [];

  // --- mounting -------------------------------------------------------------------------------------

  private mount(key: string, spec: Gen3dSpec, place?: { position?: Vector3; yaw?: number; faceHead?: boolean }, animate: 'none' | 'buildup' | 'diff' = 'diff', targetId?: string, forwardControls = false): Mounted | undefined {
    const v = validateSpec(spec);
    if (!v.spec) {
      console.warn('[hud] invalid spec', key, v.errors);
      return this.objects.get(key);
    }
    spec = v.spec;
    let m = this.objects.get(key);
    if (!m) {
      // only generated specs (renderSpec) forward `control`; HUD chrome reports through hack/deck/confirm/approve
      const obj = new SpecObject(spec, { clock: this.clock, audio: this.audio, sink: forwardControls ? this.sink : { control: () => {} } });
      if (animate === 'buildup') obj.applySpec(spec, 'buildup');
      obj.emitter.on('consumed', (e) => this.events.emit('consumed', { hand: e.hand, widget: e.widget }));
      obj.emitter.on('grab', (g) => this.events.emit('grab', g));
      this.root.add(obj);
      m = { obj, spec, ...(targetId ? { targetId } : {}) };
      this.objects.set(key, m);
    } else {
      m.obj.applySpec(spec, animate);
      m.spec = spec;
    }
    if (place?.position) m.obj.position.copy(place.position);
    if (place?.yaw !== undefined) m.obj.rotation.set(0, (place.yaw * Math.PI) / 180, 0);
    else if (place?.faceHead ?? true) this.faceHead(m.obj);
    return m;
  }

  private unmount(key: string): void {
    const m = this.objects.get(key);
    if (!m) return;
    this.root.remove(m.obj);
    m.obj.dispose();
    this.objects.delete(key);
  }

  private faceHead(obj: Object3D): void {
    this.camera.getWorldPosition(_v);
    obj.lookAt(_v.x, obj.position.y, _v.z);
  }

  private headForward(out: Vector3): Vector3 {
    this.camera.getWorldDirection(out);
    out.y = 0;
    return out.normalize();
  }

  private rightOfHead(out: Vector3): Vector3 {
    return this.headForward(out).cross(new Vector3(0, 1, 0)).normalize();
  }

  /** Nudge a floating menu down until it is >= 25 cm from every other mounted menu (max 4 steps). */
  private separateFrom(pos: Vector3, key: string): Vector3 {
    const others = [...this.objects.entries()].filter(([k]) => k.startsWith('hack_') && k !== key).map(([, m]) => m.obj.position);
    for (let i = 0; i < 4 && others.some((o) => o.distanceTo(pos) < 0.25); i++) pos.y -= 0.26;
    return pos;
  }

  private floatingSlots = new Map<string, number>();
  /** Stable slot index for a floating object: the lowest index not used by another mounted floating object. */
  private floatingSlot(key: string): number {
    const have = this.floatingSlots.get(key);
    if (have !== undefined && this.objects.has(key)) return have;
    const used = new Set([...this.floatingSlots.entries()].filter(([k]) => this.objects.has(k) && k !== key).map(([, v]) => v));
    let slot = 0;
    while (used.has(slot)) slot++;
    this.floatingSlots.set(key, slot);
    return slot;
  }

  /** A target beyond comfortable reach (a ceiling light at 2.3 m): its menus and controls come to arm's length. */
  private isFar(t: HudTarget): boolean {
    this.camera.getWorldPosition(_v);
    return _v.distanceTo(new Vector3(...t.position)) > 1.2;
  }

  /** 0.65 m along the line of sight toward the target, pitch clamped to ±25°, shifted sideways by `dx` (user's right). */
  private armsLength(t: HudTarget | undefined, dx: number): Vector3 {
    const head = this.camera.getWorldPosition(new Vector3());
    const dir = t ? new Vector3(...t.position).sub(head).normalize() : this.headForward(new Vector3());
    const flat = Math.hypot(dir.x, dir.z) || 1e-6;
    const pitch = Math.max(-25, Math.min(25, (Math.atan2(dir.y, flat) * 180) / Math.PI)) * (Math.PI / 180);
    const yaw = Math.atan2(dir.x, dir.z);
    const out = new Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(0.65).add(head);
    return out.addScaledVector(this.rightOfHead(new Vector3()), dx);
  }

  private hudSpec(id: string, title: string, parts: Part[], extra: Partial<Gen3dSpec> = {}): Gen3dSpec {
    return { spec: 'ce.gen3d/1', specId: id, rev: 1, title, anchor: { mode: 'world', position: [0, 0, 0], grabbable: false }, controls: [], parts, ...extra };
  }

  // --- SCAN -------------------------------------------------------------------------------------------

  setScanning(on: boolean, info?: { prompts?: number; pending?: number; startedAt?: number; modelId?: string }): void {
    if (on && !this.scanning) {
      this.sweep.start(this.time);
      this.audio.unlock();
      this.audio.play('sweep');
      this.roomDim.target = 0.5;
      if (info?.modelId) this.setModelChips(this.chips.map((c) => (c.id === info.modelId ? { ...c, state: 'live' } : c)));
    }
    if (!on && this.scanning) {
      this.roomDim.target = this.locked ? 0 : 0.25;
      this.setModelChips(this.chips.map((c) => (c.state === 'live' ? { ...c, state: 'done' } : c)));
    }
    this.scanning = on;
  }

  upsertTarget(t: HudTarget): void {
    this.targets.set(t.id, t);
    this.renderTarget(t);
  }

  private renderTarget(t: HudTarget): void {
    const size = t.sizeM ?? [0.25, 0.1, 0.2];
    const status: HudStatus = this.locked === t.id ? (t.status === 'scanned' || t.status === 'candidate' ? 'locked' : t.status) : this.candidate === t.id ? 'candidate' : t.status;
    const outlineStatus: HudStatus = !t.confirmed && status === 'scanned' ? 'scanned' : status;
    const facing = t.facing ?? [0, 0, 1];
    const parts: Part[] = [
      // the contour lies in the facing plane: a group whose +z is the facing vector
      { id: 'plane', kind: 'group', transform: { rotationDeg: facingToEuler(facing) } },
      { id: 'outline', parentId: 'plane', kind: 'archetype', archetype: 'outline', params: { status: outlineStatus, ...(t.contour ? { contour: t.contour } : { boxSize: size }) } },
      ...(status === 'candidate' || status === 'locked' || status === 'linking' || status === 'linked' || status === 'controlled' || status === 'verified'
        ? [{ id: 'brackets', kind: 'archetype', archetype: 'brackets', params: { boxSize: size, status: status === 'candidate' ? 'candidate' : 'locked' } } as Part]
        : []),
      { id: 'tag', kind: 'archetype', archetype: 'tag', params: { title: t.label, subtitle: t.subtitle ?? statusWord(status, t.confirmed), status, ...(t.channel ? { channel: t.channel } : {}) }, transform: { position: [0, size[1] / 2 + 0.07, 0] } },
      { id: 'lead', kind: 'path', path: { from: [0, size[1] / 2 + 0.01, 0], to: [0, size[1] / 2 + 0.052, 0], width: 0.0015, color: statusHex(status), keyline: true } },
    ];
    if (status === 'locked' || status === 'controlled' || status === 'verified') {
      parts.push({ id: 'twin', parentId: 'plane', kind: 'archetype', archetype: 'twin', params: { status, depth: Math.min(0.06, size[2]), ...(t.contour ? { contour: t.contour } : { boxSize: size }) }, transform: { position: [0, 0, 0] } });
    }
    const spec = this.hudSpec(`tgt_${t.id}`, t.label, parts, { modelId: t.modelId ?? 'sam-3.1' });
    const existed = this.objects.has(`tgt_${t.id}`);
    const m = this.mount(`tgt_${t.id}`, spec, { position: new Vector3(...t.position), faceHead: false }, existed ? 'diff' : 'buildup', t.id);
    if (!m) return;
    // tag faces the user; the contour plane is world-fixed
    m.obj.rotation.set(0, 0, 0);
    const tag = m.obj.nodes.get('tag');
    if (tag) {
      this.camera.getWorldPosition(_v);
      const local = m.obj.worldToLocal(_v.clone());
      tag.rotation.set(0, Math.atan2(local.x - tag.position.x, local.z - tag.position.z), 0);
    }
    if (!existed) this.audio.play('step', new Vector3(...t.position));
  }

  removeTarget(id: string): void {
    this.targets.delete(id);
    this.unmount(`tgt_${id}`);
    this.unmount(`hack_${id}`);
    if (this.candidate === id) this.candidate = null;
    if (this.locked === id) this.locked = null;
  }

  clearTargets(): void {
    for (const id of [...this.targets.keys()]) this.removeTarget(id);
  }

  setCandidate(id: string | null): void {
    if (this.candidate === id) return;
    const prev = this.candidate;
    this.candidate = id;
    if (prev) this.refreshTarget(prev);
    if (id) {
      this.refreshTarget(id);
      this.audio.play('tick');
    }
  }

  setLocked(id: string | null): void {
    if (this.locked === id) return;
    const prev = this.locked;
    this.locked = id;
    if (prev) this.refreshTarget(prev);
    if (id) {
      this.refreshTarget(id);
      this.audio.play('lock');
      this.roomDim.target = 0;
    }
    // focus: only the locked device keeps a full menu; everything else collapses to a chip
    this.expandedMenus.clear();
    for (const t of this.menus.keys()) this.renderMenu(t);
  }

  private refreshTarget(id: string): void {
    const t = this.targets.get(id);
    if (t) this.renderTarget(t);
  }

  // --- PING -------------------------------------------------------------------------------------------

  setPing(lines: PingLine[]): void {
    this.pings = lines;
    if (!lines.length) {
      this.unmount('pings');
      return;
    }
    const head = this.camera.getWorldPosition(new Vector3());
    const parts: Part[] = [];
    for (const l of lines) {
      const t = this.targets.get(l.targetId);
      if (!t) continue;
      const from = l.from ?? [head.x, head.y - 0.25, head.z];
      const status: HudStatus = l.status ?? (!l.proven ? 'hypothesis' : l.inFlight ? 'requested' : 'verified');
      parts.push({ id: `ping_${l.id}`, kind: 'archetype', archetype: 'ping-line', params: { channel: l.channel, status, from, to: t.position, particles: l.inFlight ? 14 : l.proven ? 4 : 0, speed: l.inFlight ? 0.9 : 0.3, ...(l.label ? { title: l.label } : {}) } });
    }
    this.mount('pings', this.hudSpec('pings', 'Ping', parts.length ? parts : [{ id: 'none', kind: 'group' }]), { position: new Vector3(), faceHead: false });
  }

  // --- agent presence ----------------------------------------------------------------------------------

  logStep(step: AgentStepLike): void {
    this.steps.set(step.stepId, step);
    if (step.model) {
      const live = step.status === 'running';
      const has = this.chips.some((c) => c.id === step.model);
      this.chips = has ? this.chips.map((c) => (c.id === step.model ? { ...c, state: live ? 'live' : c.state === 'live' ? 'done' : c.state } : c)) : [...this.chips, { id: step.model, state: live ? 'live' : 'done' }];
    }
    this.renderWorklog();
    if (step.status === 'ok') this.audio.play('step');
    if (step.status === 'fail') this.audio.play('fail');
  }

  setModelChips(chips: ModelChip[]): void {
    this.chips = chips;
    this.renderWorklog();
  }

  private renderWorklog(): void {
    const ticker = this.armedAny && !this.logExpanded;
    const all = [...this.steps.values()];
    const rows: LogRow[] = (ticker ? all.slice(-3) : all.slice(-8)).map((s) => ({ title: s.title.slice(0, 28), status: s.status, ...(s.evidence || s.detail ? { evidence: (s.evidence ?? s.detail ?? '').slice(0, 64) } : {}), ...(s.kind ? { kind: s.kind } : {}) }));
    const width = ticker ? 0.3 : 0.36;
    const chips = this.chips.slice(0, 6);
    const h = 0.036 + rows.length * 0.034 + (chips.length ? 0.03 : 0) + 0.016;
    const parts: Part[] = [
      { id: 'log', kind: 'archetype', archetype: 'worklog', params: { title: ticker ? 'AGENT · PINCH FOR LOG' : 'AGENT', width, logRows: rows, models: chips } },
      // a pinch anywhere on the plate toggles ticker ↔ full log
      { id: 'hit', kind: 'primitive', shape: 'box', dims: { w: width, h, d: 0.002 }, transform: { position: [0, 0, 0.006] }, material: { style: 'holo', color: NEON.void, opacity: 0.05, glow: 0, fresnel: 0 }, role: 'cap' },
    ];
    const spec: Gen3dSpec = {
      ...this.hudSpec('worklog', 'Agent', parts),
      controls: [{ id: 'toggle', kind: 'trigger', label: 'LOG', binding: { action: 'hud.log.toggle' } }],
      behaviors: [{ id: 'b_toggle', partId: 'hit', controlId: 'toggle', type: 'press', axis: 'z', depth: 0.002, gestures: ['poke', 'pinch'], grabRadius: 0.02 }],
    };
    const existed = this.objects.has('worklog');
    const m = this.mount('worklog', spec, { position: this.worklogPose.placed ? this.worklogPose.position : this.worklogTarget(new Vector3()), faceHead: true });
    if (!m) return;
    if (!existed) {
      m.obj.emitter.on('control', (e: ControlEvent) => {
        if (e.phase !== 'start') return;
        this.logExpanded = !this.logExpanded;
        this.renderWorklog();
        this.events.emit('consumed', { hand: 'right', widget: 'hack' });
      });
    }
    if (!this.worklogPose.placed) {
      this.worklogPose.position.copy(m.obj.position);
      this.worklogPose.placed = true;
    }
  }

  /** Lazy follower: 0.9 m ahead, ~4° below the line of sight (Meta MR guideline), re-seats only when far off. */
  private worklogTarget(out: Vector3): Vector3 {
    this.camera.getWorldPosition(out);
    const f = this.headForward(new Vector3());
    out.addScaledVector(f, 0.9);
    out.y -= 0.06;
    return out;
  }

  // --- HACKS ---------------------------------------------------------------------------------------------

  showHackMenu(targetId: string, menu: { title: string; subtitle?: string; items: HackItem[] }): void {
    this.menus.set(targetId, menu);
    this.renderMenu(targetId);
    // exactly one hack list per device: a spec's embedded list yields to the HUD menu
    for (const m of this.objects.values()) if (m.targetId === targetId && m.history) this.hideEmbeddedLists(m.obj);
  }

  /** Full list for the locked device (or when nothing is locked); a small chip for every other menu until pinched. */
  private renderMenu(targetId: string): void {
    const menu = this.menus.get(targetId);
    if (!menu) return;
    const t = this.targets.get(targetId);
    const key = `hack_${targetId}`;
    const collapsed = this.locked !== null && targetId !== this.locked && !this.expandedMenus.has(targetId);
    const items = menu.items.slice(0, 12).map((it) => ({ ...it, label: it.label.slice(0, 24), ...(it.detail ? { detail: it.detail.slice(0, 32) } : {}), ...(it.subtitle ? { subtitle: it.subtitle.slice(0, 20) } : {}), controlId: `hack_${it.id}` }));
    const title = menu.title.slice(0, 32);
    const subtitle = menu.subtitle?.slice(0, 40);
    let spec: Gen3dSpec;
    if (collapsed) {
      const w = 0.17;
      spec = {
        ...this.hudSpec(key, title.slice(0, 40), [
          { id: 'plate', kind: 'primitive', shape: 'box', dims: { w, h: 0.036, d: 0.003, radius: 0.004 }, transform: { position: [0, 0, 0] }, material: { style: 'holo', color: NEON.plate, opacity: 0.92, edges: true, edgeColor: NEON.dim, scanlines: true }, role: 'cap' },
          { id: 'title', kind: 'text', text: { value: title, heightM: 0.0085, color: NEON.bone, align: 'left' }, transform: { position: [-w / 2 + 0.01, 0.005, 0.002] } },
          { id: 'count', kind: 'text', text: { value: `${menu.items.length} HACKS · PINCH TO OPEN`, heightM: 0.005, color: NEON.dim, align: 'left' }, transform: { position: [-w / 2 + 0.01, -0.009, 0.002] } },
        ]),
        controls: [{ id: 'open', kind: 'trigger', label: 'OPEN', binding: { action: 'hud.menu.open', args: { targetId } } }],
        behaviors: [{ id: 'b_open', partId: 'plate', controlId: 'open', type: 'press', axis: 'z', depth: 0.003, gestures: ['poke', 'pinch'], grabRadius: 0.03 }],
      };
    } else {
      const controls = items.map((it) => ({ id: it.controlId, kind: 'trigger' as const, label: it.label.slice(0, 16), binding: { action: 'hud.hack', args: { itemId: it.id, targetId } } }));
      spec = { ...this.hudSpec(key, title.slice(0, 40), [{ id: 'list', kind: 'archetype', archetype: 'hack-list', params: { title, ...(subtitle ? { subtitle } : {}), items, width: 0.24 } }]), controls };
    }
    let pos: Vector3;
    if (t && !this.isFar(t)) {
      pos = new Vector3(...t.position).addScaledVector(this.rightOfHead(new Vector3()), -((t.sizeM?.[0] ?? 0.25) / 2 + 0.19));
      pos.y += 0.1;
    } else {
      // floating menus: far targets (the ceiling light) centre-left on the line of sight, room / unplaced menus to the
      // right; chips sit low; a final pass guarantees >= 25 cm from every other mounted menu
      const slot = this.floatingSlot(key);
      pos = t ? this.armsLength(t, -0.26) : this.armsLength(undefined, 0.24);
      pos.y -= collapsed ? 0.3 + (slot % 3) * 0.06 : (slot % 3) * 0.26;
      pos = this.separateFrom(pos, key);
    }
    const existed = this.objects.get(key);
    if (existed) this.unmount(key); // a chip and a list are different objects: rebuild rather than diff
    const m = this.mount(key, spec, { position: pos, faceHead: true }, 'buildup', targetId);
    if (!m) return;
    m.obj.visible = !this.verifying;
    if (collapsed) {
      m.obj.emitter.on('control', (e: ControlEvent) => {
        if (e.phase !== 'start') return;
        this.expandedMenus.add(targetId);
        this.renderMenu(targetId);
        this.events.emit('consumed', { hand: 'right', widget: 'hack' });
      });
      return;
    }
    m.obj.emitter.on('control', (e: ControlEvent) => {
      if (e.phase !== 'start') return;
      const item = menu.items[e.index ?? -1] ?? menu.items.find((it) => `hack_${it.id}` === e.controlId);
      if (item) this.events.emit('hack', { targetId, itemId: item.id, controlId: item.controlId, index: e.index ?? menu.items.indexOf(item) });
    });
  }

  /** A spec's own hack-list archetypes are hidden when the HUD shows a menu for the same target (one list per device). */
  private hideEmbeddedLists(obj: SpecObject): void {
    for (const p of obj.spec.parts) if (p.kind === 'archetype' && p.archetype === 'hack-list') obj.setPartHidden(p.id, true);
  }

  /** Height of a mounted menu (list or chip), for stacking things under it. */
  private menuHeight(targetId: string): number {
    const menu = this.menus.get(targetId);
    if (!menu) return 0.04;
    const collapsed = this.locked !== null && targetId !== this.locked && !this.expandedMenus.has(targetId);
    return collapsed ? 0.036 : 0.032 + Math.max(1, Math.min(6, menu.items.length) + (menu.items.length > 6 ? 1 : 0)) * 0.046 + 0.012;
  }

  hideHackMenu(): void {
    this.menus.clear();
    this.expandedMenus.clear();
    for (const key of [...this.objects.keys()]) if (key.startsWith('hack_')) this.unmount(key);
    for (const m of this.objects.values()) if (m.history) for (const p of m.spec.parts) if (p.archetype === 'hack-list') m.obj.setPartHidden(p.id, false);
  }

  setUpload(u: UploadState | null): void {
    if (!u) {
      this.unmount('upload');
      return;
    }
    const parts: Part[] = [{ id: 'bar', kind: 'archetype', archetype: 'upload-bar', params: { title: u.label.slice(0, 32), steps: (u.steps ?? ['GEN', 'CHECK', 'SEND', 'SEEN']).slice(0, 6).map((x) => x.slice(0, 8)), stepsDone: Math.min(6, u.stepsDone), width: 0.24, ...(u.verdict === 'fail' ? { status: 'failed' as const } : {}) } }];
    this.mount('upload', this.hudSpec('upload', 'Upload', parts, u.modelId ? { modelId: u.modelId } : {}), { position: this.belowHackMenu(0.0), faceHead: true });
    if (u.verdict === 'ok') this.audio.play('ok');
    if (u.verdict === 'fail') this.audio.play('fail');
  }

  showEvidence(e: EvidenceState | null): void {
    if (this.evidenceTimer) clearTimeout(this.evidenceTimer);
    this.evidenceTimer = null;
    if (!e) {
      this.unmount('evidence');
      this.setVerifying(false);
      return;
    }
    const parts: Part[] = [{ id: 'strip', kind: 'archetype', archetype: 'oracle-strip', params: { sent: e.sent.slice(0, 24), expect: e.expect.slice(0, 24), seen: e.seen.slice(0, 24), verdict: e.verdict, width: 0.3 } }];
    const t = e.targetId ? this.targets.get(e.targetId) : undefined;
    // VERIFY is the focal point: the strip comes to arm's length for far targets and the menus step back
    const pos = t ? (this.isFar(t) ? this.armsLength(t, 0).add(new Vector3(0, 0.06, 0)) : new Vector3(...t.position).add(new Vector3(0, (t.sizeM?.[1] ?? 0.1) / 2 + 0.115, 0))) : this.belowHackMenu(-0.05);
    this.mount('evidence', this.hudSpec('evidence', 'Evidence', parts), { position: pos, faceHead: true });
    this.setVerifying(e.verdict === 'pending');
    if (e.verdict === 'ok') this.audio.play('ok');
    if (e.verdict === 'fail') this.audio.play('fail');
    // a verdict is read in 3 s; then the controls are the focal point again
    if (e.verdict !== 'pending') this.evidenceTimer = setTimeout(() => this.unmount('evidence'), 3000);
  }

  private setVerifying(on: boolean): void {
    this.verifying = on;
    for (const [key, m] of this.objects) if (key.startsWith('hack_')) m.obj.visible = !on;
  }

  private belowHackMenu(dy: number): Vector3 {
    const entry = [...this.objects.entries()].find(([k]) => k.startsWith('hack_') && (this.locked ? k === `hack_${this.locked}` : true)) ?? [...this.objects.entries()].find(([k]) => k.startsWith('hack_'));
    if (entry) {
      const [key, menu] = entry;
      const h = this.menuHeight(key.slice(5));
      return menu.obj.position.clone().add(new Vector3(0, -(h / 2 + 0.045) + dy, 0));
    }
    return this.camera.getWorldPosition(new Vector3()).addScaledVector(this.headForward(new Vector3()), 0.6).add(new Vector3(0, -0.18 + dy, 0));
  }

  showConfirm(c: ConfirmRequest | null): void {
    if (!c) {
      this.unmount('confirm');
      return;
    }
    const spec: Gen3dSpec = {
      ...this.hudSpec('confirm', c.title, [
        { id: 'plate', kind: 'primitive', shape: 'box', dims: { w: 0.26, h: 0.11, d: 0.004, radius: 0.006 }, transform: { position: [0, 0, -0.003] }, material: { style: 'holo', color: NEON.plate, opacity: 0.92, edges: true, edgeColor: NEON.volt, scanlines: true } },
        { id: 'title', kind: 'text', text: { value: c.title.slice(0, 40), heightM: 0.008, color: NEON.bone, align: 'left' }, transform: { position: [-0.12, 0.035, 0.001] } },
        ...(c.summary ? [{ id: 'summary', kind: 'text', text: { value: c.summary.slice(0, 48), heightM: 0.0055, color: NEON.dim, align: 'left', uppercase: false, wrap: 34 }, transform: { position: [-0.12, 0.012, 0.001] } } as Part] : []),
        { id: 'yes', kind: 'archetype', archetype: 'button', controlId: 'approve', params: { size: 0.044, accent: NEON.volt, title: c.hold ? 'HOLD' : 'ARM' }, transform: { position: [0.085, -0.028, 0.002] } },
        { id: 'no', kind: 'archetype', archetype: 'button', controlId: 'deny', params: { size: 0.044, accent: NEON.dim, shape: 'square', title: 'NO' }, transform: { position: [0.03, -0.028, 0.002] } },
      ]),
      controls: [
        { id: 'approve', kind: 'trigger', label: c.hold ? 'HOLD' : 'ARM', binding: { action: 'hud.confirm', args: { id: c.id } } },
        { id: 'deny', kind: 'trigger', label: 'NO', binding: { action: 'hud.deny', args: { id: c.id } } },
      ],
    };
    const t = c.targetId ? this.targets.get(c.targetId) : undefined;
    // above a desk device; a far target (the ceiling light, overhead) would put the key out of view and out of reach, so it comes to arm's length like its menus
    const pos = t
      ? this.isFar(t)
        ? this.armsLength(t, 0).add(new Vector3(0, -0.12, 0))
        : new Vector3(...t.position).add(new Vector3(0, (t.sizeM?.[1] ?? 0.1) / 2 + 0.2, 0))
      : this.camera.getWorldPosition(new Vector3()).addScaledVector(this.headForward(new Vector3()), 0.55).add(new Vector3(0, -0.05, 0));
    const m = this.mount('confirm', spec, { position: pos, faceHead: true }, 'buildup');
    if (!m) return;
    let holdStart = 0;
    m.obj.emitter.on('control', (e: ControlEvent) => {
      if (e.controlId === 'deny' && e.phase === 'start') this.events.emit('confirm', { id: c.id, approve: false });
      if (e.controlId === 'approve') {
        if (e.phase === 'start') holdStart = performance.now();
        if (e.phase === 'end') {
          const held = performance.now() - holdStart;
          if (!c.hold || held > 600) this.events.emit('confirm', { id: c.id, approve: true, hold: !!c.hold });
        }
      }
    });
    m.obj.emitter.on('consumed', () => this.events.emit('consumed', { hand: 'right', widget: 'confirm' }));
  }

  // --- generated controls -----------------------------------------------------------------------------------

  renderSpec(spec: Gen3dSpec, at: { targetId?: string; position?: [number, number, number]; yawDeg?: number }): void {
    const key = `spec_${spec.specId}`;
    const existed = this.objects.get(key);
    let position: Vector3;
    if (at.position) position = new Vector3(...at.position);
    else if (at.targetId && this.targets.has(at.targetId)) {
      const t = this.targets.get(at.targetId)!;
      if (this.isFar(t)) position = this.armsLength(t, 0.24);
      else {
        const side = spec.anchor.side === 'left' ? -1 : 1;
        position = new Vector3(...t.position).addScaledVector(this.rightOfHead(new Vector3()), side * ((t.sizeM?.[0] ?? 0.25) / 2 + (spec.anchor.offset?.[0] ?? 0.2)));
        position.y += spec.anchor.offset?.[1] ?? 0.06;
      }
    } else if (existed) position = existed.obj.position.clone();
    else {
      const d = spec.anchor.distance ?? 0.6;
      const pitch = ((spec.anchor.pitchDeg ?? -12) * Math.PI) / 180;
      position = this.camera.getWorldPosition(new Vector3()).addScaledVector(this.headForward(new Vector3()), Math.cos(pitch) * d);
      position.y += Math.sin(pitch) * d;
    }
    const m = this.mount(key, spec, { position, ...(at.yawDeg !== undefined ? { yaw: at.yawDeg } : { faceHead: spec.anchor.faceUser ?? true }) }, existed ? 'diff' : 'buildup', at.targetId, true);
    if (!m) return;
    if (!m.history) m.history = new SpecHistory(m.spec);
    else m.history.push(m.spec);
    if (at.targetId && this.menus.has(at.targetId)) this.hideEmbeddedLists(m.obj);
    // a Muse Image skin lights its model chip while it fades in, then marks it done
    if (spec.skin && spec.skin.source !== 'hand') {
      const model = spec.skin.source;
      this.setModelChips(this.chips.some((c) => c.id === model) ? this.chips.map((c) => (c.id === model ? { ...c, state: 'live' } : c)) : [...this.chips, { id: model, state: 'live' }]);
      m.obj.onSkinReady = () => this.setModelChips(this.chips.map((c) => (c.id === model ? { ...c, state: 'done' } : c)));
    }
  }

  patchSpec(specId: string, patch: Patch): { ok: boolean; errors?: string[] } {
    const m = this.objects.get(`spec_${specId}`);
    if (!m) return { ok: false, errors: [`no spec ${specId}`] };
    const r = applyPatch(m.spec, patch);
    if (!r.ok) return { ok: false, errors: r.errors.map((e) => `${e.path}: ${e.message}`) };
    m.spec = r.spec;
    m.history?.push(r.spec);
    m.obj.applySpec(r.spec, 'diff');
    this.audio.play('step', m.obj.position);
    return { ok: true };
  }

  removeSpec(specId: string): void {
    this.unmount(`spec_${specId}`);
  }

  setArmed(specId: string, armed: boolean, reason?: string, controlIds?: string[]): void {
    this.objects.get(`spec_${specId}`)?.obj.setArmed(armed, reason, controlIds);
    if (armed && !this.armedAny) {
      // ARMED: the controls are the focal point; the work log shrinks to a 3-line ticker (pinch for the full log)
      this.armedAny = true;
      this.logExpanded = false;
      this.renderWorklog();
    }
  }

  setControlValue(specId: string, controlId: string, value: ControlEvent['value']): void {
    this.objects.get(`spec_${specId}`)?.obj.setValue(controlId, value, { emit: false });
  }

  // --- pairing, voice, deck, toasts ---------------------------------------------------------------------------

  showPairing(p: { display: string; qr: string; message?: string } | null): void {
    if (!p) {
      this.unmount('pairing');
      return;
    }
    const parts: Part[] = [
      { id: 'plate', kind: 'primitive', shape: 'box', dims: { w: 0.24, h: 0.1, d: 0.004, radius: 0.006 }, transform: { position: [0, 0, -0.003] }, material: { style: 'holo', color: NEON.plate, opacity: 0.92, edges: true, edgeColor: NEON.cyan, scanlines: true } },
      { id: 'title', kind: 'text', text: { value: 'PAIR THIS HEADSET', heightM: 0.0075, color: NEON.cyan } , transform: { position: [0, 0.03, 0.001] } },
      { id: 'code', kind: 'text', text: { value: p.display, heightM: 0.018, color: NEON.volt, font: 'mono' }, transform: { position: [0, -0.002, 0.001] } },
      { id: 'msg', kind: 'text', text: { value: (p.message ?? 'type this code on the Mac').slice(0, 44), heightM: 0.0055, color: NEON.dim, uppercase: false }, transform: { position: [0, -0.032, 0.001] } },
    ];
    const pos = this.camera.getWorldPosition(new Vector3()).addScaledVector(this.headForward(new Vector3()), 0.6).add(new Vector3(0, -0.02, 0));
    this.mount('pairing', this.hudSpec('pairing', 'Pairing', parts), { position: pos, faceHead: true });
  }

  showApprovals(list: { pairingId: string; name: string; kind: string; display: string }[]): void {
    for (const key of [...this.objects.keys()]) if (key.startsWith('approval_') && !list.some((a) => key === `approval_${a.pairingId}`)) this.unmount(key);
    list.forEach((a, i) => {
      const key = `approval_${a.pairingId}`;
      if (this.objects.has(key)) return;
      const spec: Gen3dSpec = {
        ...this.hudSpec(key, 'Approve', [
          { id: 'plate', kind: 'primitive', shape: 'box', dims: { w: 0.26, h: 0.09, d: 0.004, radius: 0.006 }, transform: { position: [0, 0, -0.003] }, material: { style: 'holo', color: NEON.plate, opacity: 0.92, edges: true, edgeColor: NEON.volt, scanlines: true } },
          { id: 'title', kind: 'text', text: { value: `${a.name} wants to join`.slice(0, 40), heightM: 0.0075, color: NEON.bone, align: 'left', uppercase: false }, transform: { position: [-0.12, 0.025, 0.001] } },
          { id: 'code', kind: 'text', text: { value: `${a.kind} · ${a.display}`, heightM: 0.0065, color: NEON.volt, align: 'left', font: 'mono' }, transform: { position: [-0.12, 0.004, 0.001] } },
          { id: 'yes', kind: 'archetype', archetype: 'button', controlId: 'approve', params: { size: 0.044, accent: NEON.ok, title: 'OK' }, transform: { position: [0.09, -0.02, 0.002] } },
          { id: 'no', kind: 'archetype', archetype: 'button', controlId: 'deny', params: { size: 0.044, accent: NEON.dim, shape: 'square', title: 'NO' }, transform: { position: [0.035, -0.02, 0.002] } },
        ]),
        controls: [
          { id: 'approve', kind: 'trigger', label: 'OK', binding: { action: 'hud.approve', args: { pairingId: a.pairingId } } },
          { id: 'deny', kind: 'trigger', label: 'NO', binding: { action: 'hud.deny', args: { pairingId: a.pairingId } } },
        ],
      };
      const pos = this.camera.getWorldPosition(new Vector3()).addScaledVector(this.headForward(new Vector3()), 0.6).add(new Vector3(0, 0.1 - i * 0.11, 0));
      const m = this.mount(key, spec, { position: pos, faceHead: true }, 'buildup');
      if (!m) return;
      m.obj.emitter.on('control', (e: ControlEvent) => {
        if (e.phase !== 'start') return;
        this.events.emit('approve', { pairingId: a.pairingId, approve: e.controlId === 'approve' });
        this.events.emit('consumed', { hand: 'right', widget: 'approval' });
      });
    });
  }

  setVoice(v: { listening: boolean; level?: number; partial?: string; final?: string }): void {
    if (!v.listening && !v.final) {
      if (this.objects.has('voice')) this.audio.play('voiceOff');
      this.unmount('voice');
      return;
    }
    if (!this.objects.has('voice') && v.listening) this.audio.play('voiceOn');
    const text = (v.final ?? v.partial ?? (v.listening ? 'listening…' : '')).slice(0, 48);
    const parts: Part[] = [
      { id: 'chip', kind: 'text', text: { value: text, heightM: 0.0075, color: v.final ? NEON.bone : NEON.cyan, background: NEON.void, uppercase: false }, transform: { position: [0, 0, 0] } },
      { id: 'level', kind: 'primitive', shape: 'box', dims: { w: Math.max(0.004, 0.12 * Math.min(1, v.level ?? 0)), h: 0.003, d: 0.001 }, transform: { position: [0, -0.014, 0] }, material: { style: 'solid', color: NEON.volt, emissive: NEON.volt, emissiveIntensity: 1 } },
    ];
    const pos = this.camera.getWorldPosition(new Vector3()).addScaledVector(this.headForward(new Vector3()), 0.55).add(new Vector3(0, -0.14, 0));
    this.mount('voice', this.hudSpec('voice', 'Voice', parts, { modelId: 'muse-voice-transcribe-1.0' }), { position: pos, faceHead: true });
  }

  setDeck(d: { open?: boolean; scanning?: boolean; daemons?: boolean; at?: [number, number, number] }): void {
    if (d.open === false) {
      this.deckOpen = false;
      this.unmount('deck');
      return;
    }
    if (d.open) this.deckOpen = true;
    if (!this.deckOpen) return;
    const items = [
      { id: 'scan', label: 'SCAN', status: d.scanning ? ('uploading' as const) : undefined },
      { id: 'ping', label: 'PING' },
      { id: 'hacks', label: 'HACKS', subtitle: 'your devices' },
      { id: 'daemons', label: 'DAEMONS', subtitle: 'automations', kind: 'daemon' as const, status: d.daemons ? ('verified' as const) : undefined },
      { id: 'undo', label: 'UNDO' },
      { id: 'panic', label: 'PANIC' },
    ].map((it) => ({ ...it, controlId: `deck_${it.id}` }));
    const spec: Gen3dSpec = {
      ...this.hudSpec('deck', 'Deck', [{ id: 'deck', kind: 'archetype', archetype: 'deck', params: { title: 'DECK', items } }]),
      controls: items.map((it) => ({ id: `deck_${it.id}`, kind: 'trigger' as const, label: it.label, binding: { action: `hud.${it.id}` } })),
    };
    const base = EXAMPLES.deck?.anchor;
    void base;
    const pos = d.at ? new Vector3(...d.at) : this.objects.get('deck')?.obj.position.clone() ?? this.camera.getWorldPosition(new Vector3()).addScaledVector(this.headForward(new Vector3()), 0.45).add(new Vector3(-0.15, -0.2, 0));
    const existed = this.objects.has('deck');
    const m = this.mount('deck', spec, { position: pos, faceHead: true }, existed ? 'diff' : 'buildup');
    if (!m) return;
    if (!existed) {
      m.obj.emitter.on('control', (e: ControlEvent) => {
        const key = e.controlId.replace('deck_', '') as HudEvents['deck']['key'];
        this.events.emit('deck', { key, phase: e.phase === 'start' ? 'press' : 'release' });
        if (e.phase === 'start') this.events.emit('consumed', { hand: 'right', widget: 'deck' });
      });
    }
  }

  toast(text: string, level: 'info' | 'ok' | 'warn' | 'error' = 'info'): void {
    const color = level === 'ok' ? NEON.ok : level === 'warn' ? NEON.volt : level === 'error' ? NEON.fail : NEON.cyan;
    const parts: Part[] = [{ id: 't', kind: 'text', text: { value: text.slice(0, 48), heightM: 0.0085, color, background: NEON.void, uppercase: false } }];
    const pos = this.camera.getWorldPosition(new Vector3()).addScaledVector(this.headForward(new Vector3()), 0.5).add(new Vector3(0, -0.09, 0));
    this.mount('toast', this.hudSpec('toast', 'Toast', parts), { position: pos, faceHead: true }, 'buildup');
    if (level === 'ok') this.audio.play('ok');
    if (level === 'error') this.audio.play('fail');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.unmount('toast'), 1600);
  }

  // --- per frame ----------------------------------------------------------------------------------------------

  update(f: HudFrame): void {
    this.time = f.time;
    this.clock.tick(f.time);
    handCursor('left', f.hands.left, this.cursors[0]!);
    handCursor('right', f.hands.right, this.cursors[1]!);
    this.roomDim.update(this.camera, f.dt);
    this.sweep.update(this.camera, f.time);
    // audio listener
    this.camera.getWorldPosition(_v);
    const fwd = this.camera.getWorldDirection(new Vector3());
    const up = new Vector3(0, 1, 0).applyQuaternion(this.camera.getWorldQuaternion(_q));
    this.audio.setListener(_v, fwd, up);
    // reticle at the head ray (0.9 m) unless a candidate is in view
    this.updateReticle(f);
    // lazy follower for the work log
    const wl = this.objects.get('worklog');
    if (wl && !wl.obj.interacting) {
      const target = this.worklogTarget(new Vector3());
      if (target.distanceTo(this.worklogPose.position) > 0.45) this.worklogPose.position.lerp(target, 1 - Math.exp(-f.dt / 0.6));
      wl.obj.position.x = damp(wl.obj.position.x, this.worklogPose.position.x, 0.3, f.dt);
      wl.obj.position.y = damp(wl.obj.position.y, this.worklogPose.position.y, 0.3, f.dt);
      wl.obj.position.z = damp(wl.obj.position.z, this.worklogPose.position.z, 0.3, f.dt);
      this.faceHead(wl.obj);
    }
    const cursors = this.devCursors.length ? [...this.cursors, ...this.devCursors] : this.cursors;
    // one pinch acquires in ONE object: the one whose nearest candidate is closest; the others see no press edge
    const winners = new Map<string, Mounted | null>();
    for (const c of cursors) {
      if (!c.justPinched || !c.tracked) continue;
      let best: Mounted | null = null;
      let bestD = Infinity;
      for (const m of this.objects.values()) {
        const d = m.obj.nearestCandidate(c);
        if (d < bestD) {
          bestD = d;
          best = m;
        }
      }
      winners.set(c.id, best);
    }
    for (const m of this.objects.values()) {
      const view = cursors.map((c) => (c.justPinched && winners.has(c.id) && winners.get(c.id) !== m ? { ...c, justPinched: false } : c));
      m.obj.update(f.dt, f.time, view, this.camera);
    }
  }

  private updateReticle(f: HudFrame): void {
    const state = this.locked ? 'locked' : this.candidate ? 'candidate' : this.scanning ? 'working' : 'idle';
    const key = 'reticle';
    const spec = this.hudSpec(key, 'Reticle', [{ id: 'r', kind: 'archetype', archetype: 'reticle', params: { reticleState: state } }]);
    const existing = this.objects.get(key);
    if (!existing || (existing.spec.parts[0]!.params?.reticleState ?? 'idle') !== state) this.mount(key, spec, { faceHead: true }, 'none');
    const m = this.objects.get(key)!;
    const ray = f.head.ray ?? { origin: f.head.position, dir: new Vector3(0, 0, -1).applyQuaternion(f.head.quaternion) };
    const cand = this.candidate ? this.targets.get(this.candidate) : undefined;
    const target = cand ? new Vector3(...cand.position) : ray.origin.clone().addScaledVector(ray.dir, 0.9);
    m.obj.position.lerp(target, 1 - Math.exp(-f.dt / 0.08));
    m.obj.visible = !this.locked;
    this.faceHead(m.obj);
  }

  dispose(): void {
    for (const key of [...this.objects.keys()]) this.unmount(key);
    this.root.parent?.remove(this.root);
  }
}

function statusWord(s: HudStatus, confirmed: boolean): string {
  if (!confirmed && s === 'scanned') return 'seen · place unconfirmed';
  switch (s) {
    case 'scanned':
      return 'seen by camera';
    case 'candidate':
      return 'pinch to lock';
    case 'locked':
      return 'locked';
    case 'linking':
      return 'linking · awaiting evidence';
    case 'linked':
      return 'linked';
    case 'verified':
      return 'verified · device reacted';
    case 'controlled':
      return 'controlled';
    case 'refused':
      return 'wrong device · refused';
    case 'no-reaction':
      return 'no reaction';
    default:
      return s;
  }
}

function statusHex(s: HudStatus): string {
  switch (s) {
    case 'candidate':
    case 'locked':
    case 'requested':
    case 'awaiting':
    case 'uploading':
      return NEON.volt;
    case 'linking':
    case 'linked':
      return NEON.magenta;
    case 'verified':
    case 'controlled':
      return NEON.ok;
    case 'failed':
    case 'offline':
    case 'refused':
    case 'no-reaction':
      return NEON.fail;
    default:
      return NEON.cyan;
  }
}

/** Euler (degrees) that turns local +z onto the given unit vector. */
function facingToEuler(facing: [number, number, number]): [number, number, number] {
  const [x, y, z] = facing;
  const yaw = Math.atan2(x, z);
  const pitch = -Math.asin(Math.max(-1, Math.min(1, y)));
  return [(pitch * 180) / Math.PI, (yaw * 180) / Math.PI, 0];
}
