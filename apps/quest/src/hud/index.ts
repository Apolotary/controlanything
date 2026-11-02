/**
 * The HUD: one focal object at a time, anchored to the device.
 *
 *   status pill   one plain sentence above the device ("Ready: pinch to control."), the model id only while it works
 *   cluster       the generated controls (ring / knobs) below the sentence, ≤ 4 big hack buttons under them
 *   details       a small chip; a pinch opens the work log, the evidence history and the model ids
 *   motion        only answers events: a hand→device beam when a command is sent, a verdict pulse on the device,
 *                 controls that reveal from the outline when they arm, momentum and ticks on the knobs
 *
 * Everything is built from gen3d specs, so the HUD and the generated controls share one validator, one budget and
 * one interaction runtime. The API (contract.ts) is unchanged for the app shell.
 */
import { Camera, Group, Object3D, Quaternion, Scene, Vector3, WebGLRenderer } from 'three';
import type { ControlEvent, Gen3dSpec, HackItem, HudStatus, LogRow, ModelChip, Part, Patch } from '@ce/gen3d';
import { NEON, SpecHistory, applyPatch, validateSpec } from '@ce/gen3d';
import { SpecObject } from '../gen3d/build';
import { UiAudio } from '../gen3d/audio';
import { Emitter, type EventSink } from '../gen3d/events';
import { handCursor, newCursor, type Cursor } from '../gen3d/interact';
import { MaterialClock } from '../gen3d/materials';
import { RoomDim } from '../fx/roomDim';
import { ScanSweep } from '../fx/sweep';
import { Tweens, damp, ease } from '../gen3d/anim';
import type { AgentStepLike, ConfirmRequest, EvidenceState, Hud, HudEvents, HudFrame, HudTarget, PingLine, UploadState } from './contract';
import '../gen3d/index';

export * from './contract';

const _v = new Vector3();
const _q = new Quaternion();

interface Mounted {
  obj: SpecObject;
  spec: Gen3dSpec;
  history?: SpecHistory;
  targetId?: string;
}

export function createHud(ctx: { scene: Scene; camera: Camera; renderer: WebGLRenderer }): Hud {
  return new HudImpl(ctx);
}

/** The places a device's HUD lives, in world space. */
interface Frame {
  /** status sentence */
  pill: Vector3;
  /** generated controls */
  cluster: Vector3;
  /** hack buttons */
  buttons: Vector3;
  /** details chip */
  details: Vector3;
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
  private readonly tweens = new Tweens();
  private candidate: string | null = null;
  private locked: string | null = null;
  private steps = new Map<string, AgentStepLike>();
  private chips: ModelChip[] = [];
  private pings: PingLine[] = [];
  private scanning = false;
  private scanModel: string | undefined;
  private menus = new Map<string, { title: string; subtitle?: string; items: HackItem[] }>();
  private expandedMenus = new Set<string>();
  private upload: UploadState | null = null;
  private evidence: EvidenceState | null = null;
  private evidenceLog: EvidenceState[] = [];
  private evidenceTimer: ReturnType<typeof setTimeout> | null = null;
  private detailsOpen = false;
  private detailsPose = { position: new Vector3(), placed: false };
  private deckOpen = false;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private beamSeq = 0;
  private lastPinch = new Vector3();
  private hintShown = false;
  private time = 0;
  private devCursors: Cursor[] = [];
  private readonly camera: Camera;
  private readonly sink: EventSink;

  constructor(ctx: { scene: Scene; camera: Camera; renderer: WebGLRenderer }) {
    this.camera = ctx.camera;
    this.root.name = 'hud';
    for (const fx of [this.roomDim, this.sweep]) fx.traverse((o) => (o.raycast = () => {}));
    this.root.add(this.roomDim, this.sweep);
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

  // --- mounting ----------------------------------------------------------------------------------------

  private mount(key: string, spec: Gen3dSpec, place?: { position?: Vector3; yaw?: number; faceHead?: boolean }, animate: 'none' | 'buildup' | 'diff' = 'diff', targetId?: string, forwardControls = false): Mounted | undefined {
    const v = validateSpec(spec);
    if (!v.spec) {
      console.warn('[hud] invalid spec', key, v.errors);
      return this.objects.get(key);
    }
    spec = v.spec;
    let m = this.objects.get(key);
    if (!m) {
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

  private head(): Vector3 {
    return this.camera.getWorldPosition(new Vector3());
  }

  private headForward(out: Vector3): Vector3 {
    this.camera.getWorldDirection(out);
    out.y = 0;
    return out.normalize();
  }

  private rightOfHead(out: Vector3): Vector3 {
    return this.headForward(out).cross(new Vector3(0, 1, 0)).normalize();
  }

  private hudSpec(id: string, title: string, parts: Part[], extra: Partial<Gen3dSpec> = {}): Gen3dSpec {
    return { spec: 'ce.gen3d/1', specId: id, rev: 1, title, anchor: { mode: 'world', position: [0, 0, 0], grabbable: false }, controls: [], parts, ...extra };
  }

  /** A target beyond comfortable reach (a ceiling light at 2.3 m): its HUD comes to arm's length. */
  private isFar(t: HudTarget): boolean {
    return this.head().distanceTo(new Vector3(...t.position)) > 1.2;
  }

  /** 0.65 m along the line of sight toward the target (pitch clamped to ±25°), shifted sideways by dx. */
  private armsLength(t: HudTarget | undefined, dx: number): Vector3 {
    const head = this.head();
    const dir = t ? new Vector3(...t.position).sub(head).normalize() : this.headForward(new Vector3());
    const flat = Math.hypot(dir.x, dir.z) || 1e-6;
    const pitch = Math.max(-25, Math.min(25, (Math.atan2(dir.y, flat) * 180) / Math.PI)) * (Math.PI / 180);
    const yaw = Math.atan2(dir.x, dir.z);
    const out = new Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(0.65).add(head);
    return out.addScaledVector(this.rightOfHead(new Vector3()), dx);
  }

  /** Where a device's sentence, controls, buttons and details chip go. Status above, controls below, details tucked right. */
  private frameFor(t: HudTarget | undefined): Frame {
    if (t && !this.isFar(t)) {
      const p = new Vector3(...t.position);
      const size = t.sizeM ?? [0.25, 0.1, 0.2];
      const toward = this.head().sub(p);
      toward.y = 0;
      toward.normalize();
      const right = this.rightOfHead(new Vector3());
      const cluster = p.clone().addScaledVector(toward, size[2] / 2 + 0.2).add(new Vector3(0, 0.07, 0));
      return {
        pill: p.clone().add(new Vector3(0, size[1] / 2 + 0.1, 0)),
        cluster,
        buttons: cluster.clone().add(new Vector3(0, -0.2, 0)).addScaledVector(toward, 0.04),
        details: cluster.clone().add(new Vector3(0, -0.2, 0)).addScaledVector(right, 0.27),
      };
    }
    const base = this.armsLength(t, 0);
    const right = this.rightOfHead(new Vector3());
    return {
      pill: base.clone().add(new Vector3(0, 0.19, 0)),
      cluster: base.clone(),
      buttons: base.clone().add(new Vector3(0, -0.25, 0)),
      details: base.clone().add(new Vector3(0, -0.25, 0)).addScaledVector(right, 0.27),
    };
  }

  private deviceWord(t: HudTarget | undefined): { thing: string; sense: string } {
    const label = (t?.label ?? '').toLowerCase();
    if (t?.channel === 'ir' || /light|lamp/.test(label)) return { thing: 'the light', sense: 'change' };
    if (t?.channel === 'midi' || t?.channel === 'usb' || /synth|op-1|ep-133|move|keyboard/.test(label)) return { thing: 'the sound', sense: 'change' };
    return { thing: 'the device', sense: 'react' };
  }

  // --- the status sentence --------------------------------------------------------------------------------

  /** One plain sentence for the current phase, and the Meta model that is working on it (if any). */
  private sentenceFor(targetId: string | null): { text: string; model?: string; color: string } {
    const t = targetId ? this.targets.get(targetId) : undefined;
    const { thing } = this.deviceWord(t);
    const running = [...this.steps.values()].reverse().find((s) => s.status === 'running');
    if (this.evidence && (!this.evidence.targetId || this.evidence.targetId === targetId)) {
      const e = this.evidence;
      if (e.verdict === 'pending') return { text: `Testing: did ${thing} change?`, color: NEON.volt };
      if (e.verdict === 'ok') return { text: `Seen: ${thing} changed.`, color: NEON.ok };
      return { text: `No change: trying another way.`, color: NEON.fail };
    }
    if (this.upload && (!targetId || this.upload.hackId)) {
      const n = this.upload.steps?.length ?? 4;
      if (this.upload.verdict === 'fail') return { text: `Upload failed: trying again.`, color: NEON.fail };
      if (this.upload.stepsDone >= n) return { text: `Uploaded: ready to control.`, color: NEON.ok };
      return { text: `Uploading, step ${Math.min(this.upload.stepsDone + 1, n)} of ${n}.`, model: this.upload.modelId, color: NEON.volt };
    }
    if (running) {
      const title = running.title.toLowerCase();
      const model = running.model;
      if (/scan/.test(title)) return { text: 'Looking for devices…', model, color: NEON.cyan };
      if (/identif|what is/.test(title)) return { text: 'Working out what this is…', model, color: NEON.cyan };
      if (/learn/.test(title)) return { text: 'Learning your remote: press each button once.', model, color: NEON.volt };
      if (/link|verify|test/.test(title)) return { text: `Testing: did ${thing} change?`, model, color: NEON.volt };
      if (/hack|forge|build|driver|control/.test(title)) return { text: 'Building your controls…', model, color: NEON.volt };
      if (/upload|arm/.test(title)) return { text: 'Uploading…', model, color: NEON.volt };
      if (/room|daemon/.test(title)) return { text: 'Setting up the room…', model, color: NEON.magenta };
      return { text: `${running.title.charAt(0)}${running.title.slice(1).toLowerCase()}…`, model, color: NEON.volt };
    }
    switch (t?.status) {
      case 'candidate':
      case 'scanned':
        return { text: 'Pinch to control this.', color: NEON.volt };
      case 'locked':
        return { text: 'Working out what this is…', color: NEON.cyan };
      case 'pinging':
      case 'linking':
      case 'requested':
      case 'awaiting':
        return { text: `Testing: did ${thing} change?`, color: NEON.volt };
      case 'linked':
      case 'verified':
      case 'controlled':
        return { text: 'Ready: pinch to control.', color: NEON.ok };
      case 'uploading':
        return { text: 'Uploading…', color: NEON.volt };
      case 'refused':
        return { text: 'Wrong device: nothing was sent.', color: NEON.fail };
      case 'no-reaction':
        return { text: 'No change: trying another way.', color: NEON.fail };
      case 'failed':
      case 'offline':
        return { text: `Lost ${thing}: scan again.`, color: NEON.fail };
      default:
        break;
    }
    if (this.scanning) return { text: 'Looking for devices…', model: this.scanModel ?? 'sam-3.1', color: NEON.cyan };
    if (!this.hasSamTargets()) return { text: 'Palm up to scan, then pinch a glowing device.', color: NEON.dim };
    return { text: 'Pinch a glowing device.', color: NEON.dim };
  }

  private hasSamTargets(): boolean {
    for (const t of this.targets.values()) if (t.source !== 'yolo') return true;
    return false;
  }

  private pillSpec(id: string, sentence: { text: string; model?: string; color: string }): Gen3dSpec {
    const text = sentence.text.slice(0, 48);
    const w = Math.min(0.42, Math.max(0.2, text.length * 0.0075 + 0.05 + (sentence.model ? 0.1 : 0)));
    const parts: Part[] = [
      { id: 'plate', kind: 'primitive', shape: 'box', dims: { w, h: 0.05, d: 0.004, radius: 0.012 }, transform: { position: [0, 0, 0] }, material: { style: 'holo', color: NEON.plate, opacity: 0.94, edges: true, edgeColor: sentence.color, scanlines: false, fresnel: 1.5, glow: 0.6 }, role: 'base' },
      { id: 'pip', kind: 'primitive', shape: 'sphere', dims: { r: 0.005, segments: 16 }, transform: { position: [-w / 2 + 0.018, 0, 0.004] }, material: { style: 'solid', color: sentence.color, emissive: sentence.color, emissiveIntensity: 1.8, glow: 1 }, role: 'indicator' },
      { id: 'text', kind: 'text', text: { value: text, heightM: 0.0105, color: NEON.bone, align: 'left', uppercase: false }, transform: { position: [-w / 2 + 0.032, 0, 0.004] } },
    ];
    if (sentence.model) {
      parts.push({ id: 'model', kind: 'primitive', shape: 'box', dims: { w: 0.096, h: 0.018, d: 0.002, radius: 0.004 }, transform: { position: [w / 2 - 0.056, -0.0005, 0.004] }, material: { style: 'holo', color: NEON.void, opacity: 0.95, edges: true, edgeColor: NEON.volt, glow: 1, fresnel: 2 } });
      parts.push({ id: 'modelText', kind: 'text', text: { value: sentence.model.slice(0, 24), heightM: 0.0052, color: NEON.volt, font: 'mono', uppercase: false }, transform: { position: [w / 2 - 0.056, -0.0005, 0.0055] } });
    }
    return this.hudSpec(id, 'Status', parts, sentence.model ? { modelId: sentence.model } : {});
  }

  /** The sentence for the focal device (locked, else candidate), or a floating one while nothing is placed yet. */
  private renderStatus(): void {
    const focus = this.locked ?? this.candidate;
    const t = focus ? this.targets.get(focus) : undefined;
    const sentence = this.sentenceFor(focus);
    const spec = this.pillSpec('status', sentence);
    let pos: Vector3;
    if (t) pos = this.frameFor(t).pill;
    else pos = this.head().addScaledVector(this.headForward(new Vector3()), 0.7).add(new Vector3(0, -0.08, 0));
    const existed = this.objects.get('status');
    const changed = !existed || existed.spec.parts.find((p) => p.id === 'text')?.text?.value !== spec.parts.find((p) => p.id === 'text')?.text?.value;
    if (existed && !changed) {
      existed.obj.position.lerp(pos, 0.5);
      this.faceHead(existed.obj);
      return;
    }
    if (existed) this.unmount('status');
    this.mount('status', spec, { position: pos, faceHead: true }, 'buildup');
    if (changed && sentence.model) this.audio.play('step');
  }

  // --- SCAN ------------------------------------------------------------------------------------------------

  setScanning(on: boolean, info?: { prompts?: number; pending?: number; startedAt?: number; modelId?: string }): void {
    if (on && !this.scanning) {
      this.sweep.start(this.time);
      this.audio.unlock();
      this.audio.play('sweep');
      this.roomDim.target = 0.5;
      this.scanModel = info?.modelId;
      if (info?.modelId) this.markModel(info.modelId, 'live');
    }
    if (!on && this.scanning) {
      this.roomDim.target = this.locked ? 0 : 0.25;
      if (this.scanModel) this.markModel(this.scanModel, 'done');
    }
    this.scanning = on;
    this.renderStatus();
  }

  private markModel(id: string, state: ModelChip['state']): void {
    this.chips = this.chips.some((c) => c.id === id) ? this.chips.map((c) => (c.id === id ? { ...c, state } : c)) : [...this.chips, { id, state }];
    if (this.detailsOpen) this.renderDetails();
  }

  upsertTarget(t: HudTarget): void {
    const prev = this.targets.get(t.id);
    this.targets.set(t.id, t);
    if (t.source === 'yolo') this.renderYolo(t, prev);
    else {
      this.renderTarget(t);
      this.hintShown = true;
      this.unmount('hint');
    }
    if (this.locked === t.id || this.candidate === t.id) this.renderStatus();
  }

  private renderTarget(t: HudTarget): void {
    const size = t.sizeM ?? [0.25, 0.1, 0.2];
    const focused = this.locked === t.id;
    const status: HudStatus = focused ? (t.status === 'scanned' || t.status === 'candidate' ? 'locked' : t.status) : this.candidate === t.id ? 'candidate' : t.status;
    const facing = t.facing ?? [0, 0, 1];
    const parts: Part[] = [
      { id: 'plane', kind: 'group', transform: { rotationDeg: facingToEuler(facing) } },
      { id: 'outline', parentId: 'plane', kind: 'archetype', archetype: 'outline', params: { status: !t.confirmed && status === 'scanned' ? 'scanned' : status, ...(t.contour ? { contour: t.contour } : { boxSize: size }) } },
    ];
    if (status === 'candidate' || focused) parts.push({ id: 'brackets', kind: 'archetype', archetype: 'brackets', params: { boxSize: size, status: status === 'candidate' ? 'candidate' : 'locked' } });
    // the small name tag only while the device is not the focal one (the status sentence takes over)
    if (!focused) {
      parts.push({ id: 'tag', kind: 'archetype', archetype: 'tag', params: { title: t.label, subtitle: t.subtitle ?? (status === 'candidate' ? 'pinch to control' : 'seen by camera'), status, ...(t.channel ? { channel: t.channel } : {}) }, transform: { position: [0, size[1] / 2 + 0.07, 0] } });
      parts.push({ id: 'lead', kind: 'path', path: { from: [0, size[1] / 2 + 0.01, 0], to: [0, size[1] / 2 + 0.052, 0], width: 0.0015, color: statusHex(status), keyline: true } });
    }
    if (focused && (status === 'locked' || status === 'controlled' || status === 'verified' || status === 'linked')) {
      parts.push({ id: 'twin', parentId: 'plane', kind: 'archetype', archetype: 'twin', params: { status, depth: Math.min(0.06, size[2]), ...(t.contour ? { contour: t.contour } : { boxSize: size }) } });
    }
    const spec = this.hudSpec(`tgt_${t.id}`, t.label, parts, { modelId: t.modelId ?? 'sam-3.1' });
    const existed = this.objects.has(`tgt_${t.id}`);
    const m = this.mount(`tgt_${t.id}`, spec, { position: new Vector3(...t.position), faceHead: false }, existed ? 'diff' : 'buildup', t.id);
    if (!m) return;
    m.obj.rotation.set(0, 0, 0);
    const tag = m.obj.nodes.get('tag');
    if (tag) {
      const local = m.obj.worldToLocal(this.head());
      tag.rotation.set(0, Math.atan2(local.x - tag.position.x, local.z - tag.position.z), 0);
    }
    if (!existed) this.audio.play('step', new Vector3(...t.position));
  }

  /** Live detector boxes: thin dashed brackets + "LABEL 82", moved in place at up to 10 Hz, never a focal object. */
  private renderYolo(t: HudTarget, prev: HudTarget | undefined): void {
    const key = `yolo_${t.id}`;
    const size = t.sizeM ?? [0.25, 0.1, 0.2];
    const title = `${t.label} ${t.score !== undefined ? Math.round(t.score * 100) : ''}`.trim().slice(0, 24);
    const existing = this.objects.get(key);
    const sameSize = prev?.sizeM && t.sizeM && prev.sizeM.every((v, i) => Math.abs(v - t.sizeM![i]!) < 0.1 * Math.max(0.05, v));
    if (existing && sameSize) {
      // cheap path: move, re-face, retitle
      existing.obj.position.set(...t.position);
      const label = existing.obj.labels.get('tag.title');
      if (label) label.setText(title);
      return;
    }
    const parts: Part[] = [
      { id: 'box', kind: 'archetype', archetype: 'brackets', params: { boxSize: size, status: 'scanned', accent: NEON.cyan } },
      { id: 'tag', kind: 'text', text: { value: title, heightM: 0.007, color: NEON.cyan, background: NEON.void, font: 'mono' }, transform: { position: [0, size[1] / 2 + 0.03, 0] } },
    ];
    const spec = this.hudSpec(key, title, parts, { modelId: t.modelId ?? 'yolo' });
    if (existing) this.unmount(key);
    const m = this.mount(key, spec, { position: new Vector3(...t.position), faceHead: false }, 'none', t.id);
    if (!m) return;
    m.obj.rotation.set(0, 0, 0);
    for (const n of m.obj.nodes.values()) if (n.userData.partId === 'tag') n.userData.billboard = true;
  }

  removeTarget(id: string): void {
    const t = this.targets.get(id);
    this.targets.delete(id);
    if (t?.source === 'yolo') {
      const m = this.objects.get(`yolo_${id}`);
      if (m) {
        // hand-over to the SAM outline: fade out over 250 ms
        this.tweens.add(0.25, (k) => m.obj.scale.setScalar(1 - 0.9 * k), () => this.unmount(`yolo_${id}`));
      }
      return;
    }
    this.unmount(`tgt_${id}`);
    this.unmount(`hack_${id}`);
    this.menus.delete(id);
    if (this.candidate === id) this.candidate = null;
    if (this.locked === id) this.locked = null;
    this.renderStatus();
  }

  clearTargets(): void {
    for (const id of [...this.targets.keys()]) this.removeTarget(id);
  }

  setCandidate(id: string | null): void {
    if (id && this.targets.get(id)?.source === 'yolo') return;
    if (this.candidate === id) return;
    const prev = this.candidate;
    this.candidate = id;
    if (prev) this.refreshTarget(prev);
    if (id) {
      this.refreshTarget(id);
      this.audio.play('tick');
    }
    this.renderStatus();
  }

  setLocked(id: string | null): void {
    if (id && this.targets.get(id)?.source === 'yolo') return;
    if (this.locked === id) return;
    const prev = this.locked;
    this.locked = id;
    if (prev) this.refreshTarget(prev);
    if (id) {
      this.refreshTarget(id);
      this.audio.play('lock');
      this.roomDim.target = 0;
    }
    this.expandedMenus.clear();
    for (const t of this.menus.keys()) this.renderMenu(t);
    this.renderStatus();
    if (this.detailsOpen || this.steps.size) this.renderDetails();
  }

  private refreshTarget(id: string): void {
    const t = this.targets.get(id);
    if (t) t.source === 'yolo' ? this.renderYolo(t, undefined) : this.renderTarget(t);
  }

  /** Verdict on the device itself: a green pulse for "seen", a soft shake and red for an honest miss. */
  private pulseTarget(targetId: string | undefined, ok: boolean): void {
    const m = targetId ? this.objects.get(`tgt_${targetId}`) : undefined;
    if (!m) return;
    const obj = m.obj;
    const base = obj.position.clone();
    if (ok) {
      this.tweens.add(0.24, (k) => obj.scale.setScalar(1 + 0.06 * Math.sin(k * Math.PI)), () => obj.scale.setScalar(1));
    } else {
      this.tweens.add(0.24, (k) => obj.position.set(base.x + 0.004 * Math.sin(k * Math.PI * 6), base.y, base.z), () => obj.position.copy(base));
    }
    const t = this.targets.get(targetId!);
    if (t) {
      const shown: HudTarget = { ...t, status: ok ? 'verified' : 'no-reaction' };
      this.targets.set(t.id, shown);
      this.renderTarget(shown);
      setTimeout(() => {
        const cur = this.targets.get(t.id);
        if (cur && cur.status === shown.status) {
          this.targets.set(t.id, t);
          this.renderTarget(t);
        }
      }, 1200);
    }
  }

  // --- PING --------------------------------------------------------------------------------------------------

  setPing(lines: PingLine[]): void {
    this.pings = lines;
    if (!lines.length) {
      this.unmount('pings');
      return;
    }
    const head = this.head();
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

  /** A hand → device beam with a particle burst when a command leaves the headset. */
  private fireBeam(from: Vector3, targetId: string | undefined): void {
    const t = targetId ? this.targets.get(targetId) : undefined;
    if (!t) return;
    const key = `beam_${this.beamSeq++}`;
    const to = new Vector3(...t.position);
    const parts: Part[] = [{ id: 'b', kind: 'archetype', archetype: 'ping-line', params: { channel: t.channel ?? 'usb', status: 'requested', from: [from.x, from.y, from.z], to: [to.x, to.y, to.z], particles: 16, speed: 2.5 } }];
    this.mount(key, this.hudSpec(key, 'Beam', parts), { position: new Vector3(), faceHead: false }, 'none');
    setTimeout(() => this.unmount(key), 700);
  }

  // --- agent presence (details) -----------------------------------------------------------------------------

  logStep(step: AgentStepLike): void {
    this.steps.set(step.stepId, step);
    if (step.model) this.markModel(step.model, step.status === 'running' ? 'live' : 'done');
    this.renderDetails();
    this.renderStatus();
    if (step.status === 'ok') this.audio.play('step');
    if (step.status === 'fail') this.audio.play('fail');
  }

  setModelChips(chips: ModelChip[]): void {
    this.chips = chips;
    if (this.detailsOpen) this.renderDetails();
  }

  /** A small "Details" chip by default; a pinch opens the work log, evidence history and model ids. */
  private renderDetails(): void {
    const focus = this.locked ?? this.candidate;
    const t = focus ? this.targets.get(focus) : undefined;
    const key = 'details';
    let spec: Gen3dSpec;
    if (!this.detailsOpen) {
      const w = 0.13;
      const n = this.steps.size + this.evidenceLog.length;
      spec = {
        ...this.hudSpec(key, 'Details', [
          { id: 'plate', kind: 'primitive', shape: 'box', dims: { w, h: 0.034, d: 0.003, radius: 0.01 }, transform: { position: [0, 0, 0] }, material: { style: 'holo', color: NEON.plate, opacity: 0.92, edges: true, edgeColor: NEON.dim, scanlines: false, fresnel: 1.5 }, role: 'cap' },
          { id: 'title', kind: 'text', text: { value: n ? `Details · ${n}` : 'Details', heightM: 0.0075, color: NEON.bone, uppercase: false }, transform: { position: [-0.006, 0, 0.002] } },
          { id: 'arrow', kind: 'text', text: { value: '▸', heightM: 0.007, color: NEON.dim, font: 'mono', uppercase: false }, transform: { position: [w / 2 - 0.012, 0, 0.002] } },
        ]),
        controls: [{ id: 'open', kind: 'trigger', label: 'DETAILS', binding: { action: 'hud.details' } }],
        behaviors: [{ id: 'b_open', partId: 'plate', controlId: 'open', type: 'press', axis: 'z', depth: 0.003, gestures: ['poke', 'pinch'], grabRadius: 0.03 }],
      };
    } else {
      const rows: LogRow[] = [...this.steps.values()].slice(-6).map((s) => ({ title: s.title.slice(0, 28), status: s.status, ...(s.evidence || s.detail ? { evidence: (s.evidence ?? s.detail ?? '').slice(0, 64) } : {}), ...(s.kind ? { kind: s.kind } : {}) }));
      for (const e of this.evidenceLog.slice(-2)) rows.push({ title: `Sent ${e.sent}`.slice(0, 28), status: e.verdict === 'ok' ? 'ok' : e.verdict === 'fail' ? 'fail' : 'running', evidence: `expected ${e.expect} → seen ${e.seen}`.slice(0, 64), kind: 'proof' });
      const width = 0.36;
      const h = 0.036 + Math.min(8, rows.length) * 0.034 + (this.chips.length ? 0.03 : 0) + 0.016;
      spec = {
        ...this.hudSpec(key, 'Details', [
          { id: 'log', kind: 'archetype', archetype: 'worklog', params: { title: 'What the agent did', width, logRows: rows.slice(-8), models: this.chips.slice(0, 6) } },
          { id: 'hit', kind: 'primitive', shape: 'box', dims: { w: width, h, d: 0.002 }, transform: { position: [0, 0, 0.006] }, material: { style: 'holo', color: NEON.void, opacity: 0.05, glow: 0, fresnel: 0 }, role: 'cap' },
        ]),
        controls: [{ id: 'open', kind: 'trigger', label: 'CLOSE', binding: { action: 'hud.details' } }],
        behaviors: [{ id: 'b_open', partId: 'hit', controlId: 'open', type: 'press', axis: 'z', depth: 0.002, gestures: ['poke', 'pinch'], grabRadius: 0.02 }],
      };
    }
    const pos = this.detailsOpen ? this.armsLength(undefined, 0.08).add(new Vector3(0, 0.02, 0)) : this.frameFor(t).details;
    const existed = this.objects.get(key);
    const wasOpen = existed ? existed.spec.parts.some((p) => p.id === 'log') : false;
    if (existed && wasOpen !== this.detailsOpen) this.unmount(key);
    const m = this.mount(key, spec, { position: pos, faceHead: true }, existed && wasOpen === this.detailsOpen ? 'diff' : 'buildup');
    if (!m) return;
    if (!existed || wasOpen !== this.detailsOpen) {
      m.obj.emitter.on('control', (e: ControlEvent) => {
        if (e.phase !== 'start') return;
        this.detailsOpen = !this.detailsOpen;
        this.renderDetails();
        this.events.emit('consumed', { hand: 'right', widget: 'hack' });
      });
    }
  }

  // --- HACKS -----------------------------------------------------------------------------------------------------

  showHackMenu(targetId: string, menu: { title: string; subtitle?: string; items: HackItem[] }): void {
    this.menus.set(targetId, menu);
    this.renderMenu(targetId);
    for (const m of this.objects.values()) if (m.targetId === targetId && m.history) this.hideEmbeddedLists(m.obj);
  }

  /**
   * The focal device gets ≤ 4 big hack buttons (icon + word) under its controls, "+N" opens the full list;
   * every other device's menu is a small chip until pinched; nothing is locked → full lists.
   */
  private renderMenu(targetId: string): void {
    const menu = this.menus.get(targetId);
    if (!menu) return;
    const t = this.targets.get(targetId);
    const key = `hack_${targetId}`;
    const focal = this.locked === targetId;
    const collapsed = this.locked !== null && !focal && !this.expandedMenus.has(targetId);
    const expanded = this.expandedMenus.has(targetId);
    const clean = menu.items.slice(0, 12).map((it) => ({ ...it, label: it.label.slice(0, 24), ...(it.detail ? { detail: it.detail.slice(0, 32) } : {}), ...(it.subtitle ? { subtitle: it.subtitle.slice(0, 20) } : {}), controlId: `hack_${it.id}` }));
    const title = menu.title.slice(0, 32);
    const subtitle = menu.subtitle?.slice(0, 40);
    const frame = this.frameFor(t);
    let spec: Gen3dSpec;
    let pos: Vector3;
    if (collapsed) {
      const w = 0.17;
      spec = {
        ...this.hudSpec(key, title.slice(0, 40), [
          { id: 'plate', kind: 'primitive', shape: 'box', dims: { w, h: 0.036, d: 0.003, radius: 0.01 }, transform: { position: [0, 0, 0] }, material: { style: 'holo', color: NEON.plate, opacity: 0.92, edges: true, edgeColor: NEON.dim, scanlines: false }, role: 'cap' },
          { id: 'title', kind: 'text', text: { value: title, heightM: 0.0085, color: NEON.bone, align: 'left', uppercase: false }, transform: { position: [-w / 2 + 0.01, 0.005, 0.002] } },
          { id: 'count', kind: 'text', text: { value: `${menu.items.length} hacks · pinch to open`, heightM: 0.005, color: NEON.dim, align: 'left', uppercase: false }, transform: { position: [-w / 2 + 0.01, -0.009, 0.002] } },
        ]),
        controls: [{ id: 'open', kind: 'trigger', label: 'OPEN', binding: { action: 'hud.menu.open', args: { targetId } } }],
        behaviors: [{ id: 'b_open', partId: 'plate', controlId: 'open', type: 'press', axis: 'z', depth: 0.003, gestures: ['poke', 'pinch'], grabRadius: 0.03 }],
      };
      const slot = this.floatingSlot(key);
      pos = this.armsLength(undefined, 0.3).add(new Vector3(0, -0.3 - (slot % 3) * 0.06, 0));
      pos = this.separateFrom(pos, key);
    } else if (focal && !expanded) {
      // ≤ 4 big buttons for one-shot hacks; controls (kind "control") are the cluster itself
      const actions = clean.filter((it) => it.kind !== 'control');
      const shown = actions.slice(0, 4);
      const more = actions.length - shown.length;
      const n = shown.length + (more > 0 ? 1 : 0);
      const pitch = 0.07;
      const w = n * pitch;
      const parts: Part[] = [];
      const controls: Gen3dSpec['controls'] = [];
      shown.forEach((it, i) => {
        const x = -w / 2 + pitch / 2 + i * pitch;
        const glyph = it.kind === 'daemon' ? '∞' : '▸';
        const col = it.status === 'verified' ? NEON.ok : it.status === 'failed' ? NEON.fail : it.kind === 'daemon' ? NEON.magenta : NEON.volt;
        parts.push({ id: `b${i}`, kind: 'archetype', archetype: 'button', controlId: it.controlId, params: { size: 0.05, accent: col, shape: 'round', title: glyph, momentary: true }, transform: { position: [x, 0, 0] } });
        parts.push({ id: `l${i}`, kind: 'text', text: { value: shortWord(it.label), heightM: 0.0062, color: NEON.bone, background: NEON.void, wrap: 9, uppercase: false }, transform: { position: [x, -0.042, 0.002] } });
        controls.push({ id: it.controlId, kind: 'trigger', label: it.label.slice(0, 16), binding: { action: 'hud.hack', args: { itemId: it.id, targetId } } });
      });
      if (more > 0) {
        const x = -w / 2 + pitch / 2 + shown.length * pitch;
        parts.push({ id: 'more', kind: 'archetype', archetype: 'button', controlId: 'more', params: { size: 0.05, accent: NEON.dim, shape: 'square', title: `+${more}`, momentary: true }, transform: { position: [x, 0, 0] } });
        parts.push({ id: 'lmore', kind: 'text', text: { value: 'More', heightM: 0.0062, color: NEON.dim, background: NEON.void, uppercase: false }, transform: { position: [x, -0.042, 0.002] } });
        controls.push({ id: 'more', kind: 'trigger', label: 'MORE', binding: { action: 'hud.menu.open', args: { targetId } } });
      }
      if (!parts.length) parts.push({ id: 'none', kind: 'group' });
      spec = { ...this.hudSpec(key, title.slice(0, 40), parts), controls };
      pos = frame.buttons;
    } else {
      const controls = clean.map((it) => ({ id: it.controlId, kind: 'trigger' as const, label: it.label.slice(0, 16), binding: { action: 'hud.hack', args: { itemId: it.id, targetId } } }));
      spec = { ...this.hudSpec(key, title.slice(0, 40), [{ id: 'list', kind: 'archetype', archetype: 'hack-list', params: { title, ...(subtitle ? { subtitle } : {}), items: clean, width: 0.24 } }]), controls };
      pos = focal ? frame.buttons.clone().add(new Vector3(0, -0.06, 0)) : t && !this.isFar(t) ? new Vector3(...t.position).addScaledVector(this.rightOfHead(new Vector3()), -((t.sizeM?.[0] ?? 0.25) / 2 + 0.19)).add(new Vector3(0, 0.1, 0)) : this.separateFrom(this.armsLength(t, t ? -0.26 : 0.24), key);
    }
    if (this.objects.has(key)) this.unmount(key); // chip / buttons / list are different objects: rebuild
    const m = this.mount(key, spec, { position: pos, faceHead: true }, 'buildup', targetId);
    if (!m) return;
    m.obj.emitter.on('control', (e: ControlEvent) => {
      if (e.phase !== 'start') return;
      if (e.controlId === 'open' || e.controlId === 'more') {
        this.expandedMenus.add(targetId);
        this.renderMenu(targetId);
        this.events.emit('consumed', { hand: 'right', widget: 'hack' });
        return;
      }
      const item = menu.items.find((it) => `hack_${it.id}` === e.controlId) ?? menu.items[e.index ?? -1];
      if (item) {
        this.events.emit('hack', { targetId, itemId: item.id, controlId: item.controlId, index: menu.items.indexOf(item) });
        this.fireBeam(this.lastPinch.clone(), targetId);
      }
    });
  }

  /**
   * One status line per device: a spec's own hack list, tag and model chips hide behind the HUD's pill and buttons,
   * and a device-anchored object needs no grab handle (its place is the device).
   */
  private hideEmbeddedLists(obj: SpecObject): void {
    for (const p of obj.spec.parts) if (p.kind === 'archetype' && (p.archetype === 'hack-list' || p.archetype === 'tag' || p.archetype === 'model-chips')) obj.setPartHidden(p.id, true);
    obj.setPartHidden('_handle', true);
  }

  hideHackMenu(): void {
    this.menus.clear();
    this.expandedMenus.clear();
    for (const key of [...this.objects.keys()]) if (key.startsWith('hack_')) this.unmount(key);
    for (const m of this.objects.values()) if (m.history) for (const p of m.spec.parts) if (p.archetype === 'hack-list' || p.archetype === 'tag' || p.archetype === 'model-chips') m.obj.setPartHidden(p.id, false);
    // (the grab handle stays hidden for device-anchored objects)
  }

  private floatingSlots = new Map<string, number>();
  private floatingSlot(key: string): number {
    const have = this.floatingSlots.get(key);
    if (have !== undefined && this.objects.has(key)) return have;
    const used = new Set([...this.floatingSlots.entries()].filter(([k]) => this.objects.has(k) && k !== key).map(([, v]) => v));
    let slot = 0;
    while (used.has(slot)) slot++;
    this.floatingSlots.set(key, slot);
    return slot;
  }

  private separateFrom(pos: Vector3, key: string): Vector3 {
    const others = [...this.objects.entries()].filter(([k]) => k.startsWith('hack_') && k !== key).map(([, m]) => m.obj.position);
    for (let i = 0; i < 4 && others.some((o) => o.distanceTo(pos) < 0.25); i++) pos.y -= 0.26;
    return pos;
  }

  setUpload(u: UploadState | null): void {
    this.upload = u;
    if (u?.modelId) this.markModel(u.modelId, u.verdict === 'pending' || u.stepsDone < (u.steps?.length ?? 4) ? 'live' : 'done');
    this.renderStatus();
    if (u?.verdict === 'ok') this.audio.play('ok');
    if (u?.verdict === 'fail') this.audio.play('fail');
    if (u && u.verdict !== 'pending' && u.stepsDone >= (u.steps?.length ?? 4)) setTimeout(() => {
      if (this.upload === u) {
        this.upload = null;
        this.renderStatus();
      }
    }, 2500);
  }

  showEvidence(e: EvidenceState | null): void {
    if (this.evidenceTimer) clearTimeout(this.evidenceTimer);
    this.evidenceTimer = null;
    this.evidence = e;
    if (e && e.verdict !== 'pending') {
      this.evidenceLog.push(e);
      if (this.evidenceLog.length > 6) this.evidenceLog.shift();
      this.pulseTarget(e.targetId ?? this.locked ?? undefined, e.verdict === 'ok');
      this.audio.play(e.verdict === 'ok' ? 'ok' : 'fail');
      // the verdict reads for 3 s on the sentence, then the controls are the focal point again
      this.evidenceTimer = setTimeout(() => {
        if (this.evidence === e) {
          this.evidence = null;
          this.renderStatus();
        }
      }, 3000);
    }
    this.renderStatus();
    if (this.detailsOpen) this.renderDetails();
  }

  showConfirm(c: ConfirmRequest | null): void {
    if (!c) {
      this.unmount('confirm');
      return;
    }
    const t = c.targetId ? this.targets.get(c.targetId) : undefined;
    const spec: Gen3dSpec = {
      ...this.hudSpec('confirm', c.title, [
        { id: 'plate', kind: 'primitive', shape: 'box', dims: { w: 0.26, h: 0.11, d: 0.004, radius: 0.012 }, transform: { position: [0, 0, -0.003] }, material: { style: 'holo', color: NEON.plate, opacity: 0.94, edges: true, edgeColor: NEON.volt, scanlines: false } },
        { id: 'title', kind: 'text', text: { value: c.title.slice(0, 40), heightM: 0.0085, color: NEON.bone, align: 'left', uppercase: false }, transform: { position: [-0.12, 0.035, 0.001] } },
        ...(c.summary ? [{ id: 'summary', kind: 'text', text: { value: c.summary.slice(0, 48), heightM: 0.0055, color: NEON.dim, align: 'left', uppercase: false, wrap: 34 }, transform: { position: [-0.12, 0.012, 0.001] } } as Part] : []),
        { id: 'yes', kind: 'archetype', archetype: 'button', controlId: 'approve', params: { size: 0.044, accent: NEON.volt, title: c.hold ? 'HOLD' : 'YES' }, transform: { position: [0.085, -0.028, 0.002] } },
        { id: 'no', kind: 'archetype', archetype: 'button', controlId: 'deny', params: { size: 0.044, accent: NEON.dim, shape: 'square', title: 'NO' }, transform: { position: [0.03, -0.028, 0.002] } },
      ]),
      controls: [
        { id: 'approve', kind: 'trigger', label: c.hold ? 'HOLD' : 'YES', binding: { action: 'hud.confirm', args: { id: c.id } } },
        { id: 'deny', kind: 'trigger', label: 'NO', binding: { action: 'hud.deny', args: { id: c.id } } },
      ],
    };
    const pos = this.frameFor(t).pill.clone().add(new Vector3(0, 0.1, 0));
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

  // --- generated controls ----------------------------------------------------------------------------------------

  renderSpec(spec: Gen3dSpec, at: { targetId?: string; position?: [number, number, number]; yawDeg?: number }): void {
    const key = `spec_${spec.specId}`;
    const existed = this.objects.get(key);
    const t = at.targetId ? this.targets.get(at.targetId) : undefined;
    let position: Vector3;
    if (at.position) position = new Vector3(...at.position);
    else if (t) position = this.frameFor(t).cluster;
    else if (existed) position = existed.obj.position.clone();
    else {
      const d = spec.anchor.distance ?? 0.6;
      const pitch = ((spec.anchor.pitchDeg ?? -12) * Math.PI) / 180;
      position = this.head().addScaledVector(this.headForward(new Vector3()), Math.cos(pitch) * d);
      position.y += Math.sin(pitch) * d;
    }
    const m = this.mount(key, spec, { position, ...(at.yawDeg !== undefined ? { yaw: at.yawDeg } : { faceHead: spec.anchor.faceUser ?? true }) }, existed ? 'diff' : 'buildup', at.targetId, true);
    if (!m) return;
    if (!m.history) {
      m.history = new SpecHistory(m.spec);
      m.obj.emitter.on('control', (e: ControlEvent) => {
        const c = m.spec.controls.find((x) => x.id === e.controlId);
        const sent = c && (c.kind === 'trigger' || c.kind === 'toggle') ? e.phase === 'start' : e.phase === 'end';
        if (sent) this.fireBeam(this.lastPinch.clone(), m.targetId);
      });
    } else m.history.push(m.spec);
    if (at.targetId) this.hideEmbeddedLists(m.obj);
    if (spec.skin && spec.skin.source !== 'hand') {
      const model = spec.skin.source;
      this.markModel(model, 'live');
      m.obj.onSkinReady = () => this.markModel(model, 'done');
    }
    this.renderStatus();
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

  /** Arming is the reveal: the controls grow out of the device's outline into their place. */
  setArmed(specId: string, armed: boolean, reason?: string, controlIds?: string[]): void {
    const m = this.objects.get(`spec_${specId}`);
    if (!m) return;
    const wasArmed = m.obj.spec.state?.armed ?? true;
    m.obj.setArmed(armed, reason, controlIds);
    const t = m.targetId ? this.targets.get(m.targetId) : undefined;
    if (armed && !wasArmed && t && !controlIds) {
      const final = m.obj.position.clone();
      const start = new Vector3(...t.position);
      m.obj.position.copy(start);
      m.obj.scale.setScalar(0.15);
      m.obj.applySpec(m.spec, 'buildup');
      this.tweens.add(0.5, (k) => {
        const e = ease.outBack(k);
        m.obj.position.lerpVectors(start, final, e);
        m.obj.scale.setScalar(0.15 + 0.85 * e);
      }, () => {
        m.obj.position.copy(final);
        m.obj.scale.setScalar(1);
      });
      this.pulseTarget(t.id, true);
    }
    this.renderStatus();
  }

  setControlValue(specId: string, controlId: string, value: ControlEvent['value']): void {
    this.objects.get(`spec_${specId}`)?.obj.setValue(controlId, value, { emit: false });
  }

  // --- pairing, voice, deck, toasts ----------------------------------------------------------------------------------

  showPairing(p: { display: string; qr: string; message?: string } | null): void {
    if (!p) {
      this.unmount('pairing');
      return;
    }
    const parts: Part[] = [
      { id: 'plate', kind: 'primitive', shape: 'box', dims: { w: 0.24, h: 0.1, d: 0.004, radius: 0.012 }, transform: { position: [0, 0, -0.003] }, material: { style: 'holo', color: NEON.plate, opacity: 0.94, edges: true, edgeColor: NEON.cyan, scanlines: false } },
      { id: 'title', kind: 'text', text: { value: 'Pair this headset', heightM: 0.0085, color: NEON.cyan, uppercase: false }, transform: { position: [0, 0.03, 0.001] } },
      { id: 'code', kind: 'text', text: { value: p.display, heightM: 0.018, color: NEON.volt, font: 'mono' }, transform: { position: [0, -0.002, 0.001] } },
      { id: 'msg', kind: 'text', text: { value: (p.message ?? 'Type this code on the Mac').slice(0, 44), heightM: 0.0055, color: NEON.dim, uppercase: false }, transform: { position: [0, -0.032, 0.001] } },
    ];
    const pos = this.head().addScaledVector(this.headForward(new Vector3()), 0.6).add(new Vector3(0, -0.02, 0));
    this.mount('pairing', this.hudSpec('pairing', 'Pairing', parts), { position: pos, faceHead: true });
  }

  showApprovals(list: { pairingId: string; name: string; kind: string; display: string }[]): void {
    for (const key of [...this.objects.keys()]) if (key.startsWith('approval_') && !list.some((a) => key === `approval_${a.pairingId}`)) this.unmount(key);
    list.forEach((a, i) => {
      const key = `approval_${a.pairingId}`;
      if (this.objects.has(key)) return;
      const spec: Gen3dSpec = {
        ...this.hudSpec(key, 'Approve', [
          { id: 'plate', kind: 'primitive', shape: 'box', dims: { w: 0.26, h: 0.09, d: 0.004, radius: 0.012 }, transform: { position: [0, 0, -0.003] }, material: { style: 'holo', color: NEON.plate, opacity: 0.94, edges: true, edgeColor: NEON.volt, scanlines: false } },
          { id: 'title', kind: 'text', text: { value: `${a.name} wants to join`.slice(0, 40), heightM: 0.0075, color: NEON.bone, align: 'left', uppercase: false }, transform: { position: [-0.12, 0.025, 0.001] } },
          { id: 'code', kind: 'text', text: { value: `${a.kind} · ${a.display}`, heightM: 0.0065, color: NEON.volt, align: 'left', font: 'mono' }, transform: { position: [-0.12, 0.004, 0.001] } },
          { id: 'yes', kind: 'archetype', archetype: 'button', controlId: 'approve', params: { size: 0.044, accent: NEON.ok, title: 'YES' }, transform: { position: [0.09, -0.02, 0.002] } },
          { id: 'no', kind: 'archetype', archetype: 'button', controlId: 'deny', params: { size: 0.044, accent: NEON.dim, shape: 'square', title: 'NO' }, transform: { position: [0.035, -0.02, 0.002] } },
        ]),
        controls: [
          { id: 'approve', kind: 'trigger', label: 'YES', binding: { action: 'hud.approve', args: { pairingId: a.pairingId } } },
          { id: 'deny', kind: 'trigger', label: 'NO', binding: { action: 'hud.deny', args: { pairingId: a.pairingId } } },
        ],
      };
      const pos = this.head().addScaledVector(this.headForward(new Vector3()), 0.6).add(new Vector3(0, 0.1 - i * 0.11, 0));
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
    const text = (v.final ?? v.partial ?? (v.listening ? 'Listening…' : '')).slice(0, 48);
    const parts: Part[] = [
      { id: 'chip', kind: 'text', text: { value: text, heightM: 0.0075, color: v.final ? NEON.bone : NEON.cyan, background: NEON.void, uppercase: false }, transform: { position: [0, 0, 0] } },
      { id: 'level', kind: 'primitive', shape: 'box', dims: { w: Math.max(0.004, 0.12 * Math.min(1, v.level ?? 0)), h: 0.003, d: 0.001 }, transform: { position: [0, -0.014, 0] }, material: { style: 'solid', color: NEON.volt, emissive: NEON.volt, emissiveIntensity: 1 } },
    ];
    const pos = this.head().addScaledVector(this.headForward(new Vector3()), 0.55).add(new Vector3(0, -0.14, 0));
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
    const pos = d.at ? new Vector3(...d.at) : this.objects.get('deck')?.obj.position.clone() ?? this.head().addScaledVector(this.headForward(new Vector3()), 0.45).add(new Vector3(-0.15, -0.2, 0));
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
    const pos = this.head().addScaledVector(this.headForward(new Vector3()), 0.5).add(new Vector3(0, -0.12, 0));
    this.mount('toast', this.hudSpec('toast', 'Toast', parts), { position: pos, faceHead: true }, 'buildup');
    if (level === 'ok') this.audio.play('ok');
    if (level === 'error') this.audio.play('fail');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.unmount('toast'), 1600);
  }

  // --- per frame -----------------------------------------------------------------------------------------------------

  update(f: HudFrame): void {
    this.time = f.time;
    this.clock.tick(f.time);
    this.tweens.update(f.time);
    handCursor('left', f.hands.left, this.cursors[0]!);
    handCursor('right', f.hands.right, this.cursors[1]!);
    this.roomDim.update(this.camera, f.dt);
    this.sweep.update(this.camera, f.time);
    this.camera.getWorldPosition(_v);
    const fwd = this.camera.getWorldDirection(new Vector3());
    const up = new Vector3(0, 1, 0).applyQuaternion(this.camera.getWorldQuaternion(_q));
    this.audio.setListener(_v, fwd, up);
    this.updateReticle(f);
    // first-run hint and the floating sentence live in the status pill when nothing is focused yet
    if (!this.objects.has('status') && (this.hasSamTargets() || this.scanning || !this.hintShown)) {
      this.renderStatus();
      if (!this.hasSamTargets() && !this.scanning) this.hintShown = true;
    }
    // details follow the head lazily while open
    const det = this.objects.get('details');
    if (det && this.detailsOpen && !det.obj.interacting) {
      const target = this.armsLength(undefined, 0.08).add(new Vector3(0, 0.02, 0));
      if (target.distanceTo(det.obj.position) > 0.4) det.obj.position.lerp(target, 1 - Math.exp(-f.dt / 0.5));
      this.faceHead(det.obj);
    }
    const cursors = this.devCursors.length ? [...this.cursors, ...this.devCursors] : this.cursors;
    for (const c of cursors) if (c.pinching && c.tracked) this.lastPinch.copy(c.position);
    // one pinch acquires in ONE object: the one whose nearest candidate is closest
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
      if (best) this.lastPinch.copy(c.position);
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
    const m = this.objects.get(key);
    if (!m) return;
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

/** "TURN FULL ON" → "Full on": the verb is implied by the button, the word is what the device does. */
function shortWord(label: string): string {
  const words = label.replace(/^(turn|set|switch|make|play|strike|run)\s+/i, '').trim().split(/\s+/).slice(0, 2);
  const s = words.join(' ').toLowerCase();
  return (s.charAt(0).toUpperCase() + s.slice(1)).slice(0, 16) || label.slice(0, 16);
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

export { damp };
