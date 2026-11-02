/**
 * LIVE BOXES: the fast half of the annotation layer. While SCAN is on, camera frames (downscaled to 416 px at
 * grab time) go to an on-device YOLOX-nano worker; its device boxes are tracked (tracker.ts), lifted to 3D with
 * the pose the frame was captured at (like the SAM tags), and drawn through the HUD API as `source: 'yolo'`
 * targets: one clean box and a short class tag. SAM 3.1 (server, ~1 Hz) stays the source of truth: the moment a
 * SAM target covers the same object, it takes over from the live box.
 *
 * A live box can be tagged immediately. SAM later refines the identity while the live track follows its
 * position. People are excluded; boxes that are really a tracked hand are dropped here.
 *
 * Cadence is adaptive: one frame in flight, at most ~15 Hz, and the interval backs off when the render loop's
 * frame time rises above its baseline (the XR frame rate always wins over detection).
 */
import { Quaternion, Vector3 } from 'three';
import type { Hud, HudTarget } from '../../app/hud-contract';
import type { BoxField } from '../../hud/v2/boxes';
import type { Intrinsics } from '../../io/v1';
import type { CameraSource } from '../camera';
import type { DepthProvider } from '../placement';
import type { PoseRing } from '../poses';
import { ANNOTATION_MIN_SCORE, ANNOTATION_RANGE_M, inAnnotationRange } from '../policy';
import { cameraPoseFromHead, pixelToRay, type PoseLike, questIntrinsics, scaleIntrinsics, worldToPixel } from '../projection';
import { toHudTarget, type Target } from '../targets';
import { allowedClasses, type Category, CATEGORIES, deviceClass } from './classes';
import type { Box } from './prep';
import type { WorkerDet, WorkerIn, WorkerOut, YoloEp } from './protocol';
import { claimSamTarget, overlapsHand, type ProjectedJoint } from './quality';
import { YoloTelemetry } from './stats';
import { BoxTracker, type Track } from './tracker';

export const LIVE_MODEL_ID = 'yolox-nano';
export const INPUT_SIZE = 416;

export interface LiveDetectorDeps {
  camera: () => CameraSource;
  poses: PoseRing;
  hud: () => Hud;
  /** SAM 3.1 targets the shell has placed (they take over from live boxes) */
  samTargets: () => Target[];
  depth: () => DepthProvider[];
  headPosition?: () => Vector3;
  /** world positions of tracked hand joints right now */
  handJoints: () => Vector3[];
  log: (msg: string, level?: 'info' | 'ok' | 'warn' | 'error') => void;
  modelUrl: string;
  ep?: YoloEp | 'auto';
  /** the box the user pinched is now covered by this SAM target (the shell locks it) */
  onPickClaimed?: (samTargetId: string) => void;
  /** A tagged/SAM outline followed its matching live object. */
  onTargetTracked?: (target: Target) => void;
  /** worker factory (tests inject a fake) */
  createWorker?: () => Worker;
}

export interface LiveStats {
  state: 'off' | 'loading' | 'ready' | 'error';
  ep?: YoloEp;
  threads?: number;
  isolated?: boolean;
  loadMs?: number;
  warmMs?: number;
  /** EMAs, ms */
  inferMs: number;
  /** grab → boxes on screen */
  latencyMs: number;
  /** detector results in the last second */
  fps: number;
  intervalMs: number;
  /** render loop frame time EMA and its baseline, ms */
  frameMs: number;
  baselineMs: number;
  tracks: number;
  shown: number;
  handedOver: number;
  frames: number;
  skipped: number;
  errors: number;
  lastError?: string;
}

interface PendingFrame {
  id: number;
  generation: number;
  t0: number;
  cam: PoseLike;
  k: Intrinsics;
  handJoints: Vector3[];
}

interface Anchor {
  position: Vector3;
  sizeM: [number, number, number];
  facing: Vector3;
  /** a hit-test point on the object (world), once one came back */
  hit?: Vector3;
  hitPending: boolean;
  lastHitAt: number;
  /** id of the SAM target that took over */
  claimedBy?: string;
  shown: boolean;
  aimable: { id: string; position: Vector3; size: number };
  sent?: { position: Vector3; sizeM: [number, number, number]; label: string; score: number; picked: boolean; seenAt: number };
}

export const MIN_INTERVAL = 1000 / 15;
const MAX_INTERVAL = 1000;
const MAX_HEAD_SPEED = 120; // deg/s: faster than this, frames are blurred and boxes would only lag

export class LiveDetector {
  readonly stats: LiveStats = { state: 'off', inferMs: 0, latencyMs: 0, fps: 0, intervalMs: 100, frameMs: 0, baselineMs: 0, tracks: 0, shown: 0, handedOver: 0, frames: 0, skipped: 0, errors: 0 };
  readonly tracker = new BoxTracker();
  readonly telemetry = new YoloTelemetry();
  category: Category = 'electronics';
  scoreThreshold = ANNOTATION_MIN_SCORE;
  rangeM = ANNOTATION_RANGE_M;
  running = false;
  private worker?: Worker;
  private readyPromise?: Promise<void>;
  private rejectReady?: (error: Error) => void;
  private readonly pending = new Map<number, PendingFrame>();
  private readonly anchors = new Map<number, Anchor>();
  private nextFrameId = 1;
  private inFlight = false;
  private captureTicket = 0;
  private lastOpportunityAt = -Infinity;
  private lastAdaptAt = 0;
  /** the camera of the latest detector frame (SAM handover is checked in it) */
  private lastFrame?: Pick<PendingFrame, 'cam' | 'k'>;
  /** the track the user pinched, waiting for SAM 3.1 to cover it */
  private picked?: number;
  private generation = 0;
  private readonly projectedHands: ProjectedJoint[] = [];
  private readonly jointPool: ProjectedJoint[] = [];
  private readonly projectPoint = new Vector3();
  private readonly projectInverse = new Quaternion();

  constructor(private readonly d: LiveDetectorDeps) {
    this.publishStats();
  }

  /** The shell owns __ce; augment its existing object without replacing it. */
  private publishStats(): void {
    const s = this.telemetry.value;
    s.backend = this.stats.state === 'ready' ? this.stats.ep ?? 'wasm' : this.stats.state;
    s.boxes = this.boxField()?.boxes.size ?? this.stats.shown;
    if (typeof window !== 'undefined') {
      const app = (window as unknown as { __ce?: { yoloStats?: typeof s } }).__ce;
      if (app) app.yoloStats = s;
    }
  }

  private boxField(): BoxField | undefined {
    return this.d.hud().root?.getObjectByName('boxField') as BoxField | undefined;
  }

  /** Load the model (idempotent); resolves when the worker is warm. */
  load(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.stats.state = 'loading';
    this.publishStats();
    const loading = new Promise<void>((resolve, reject) => {
      this.rejectReady = reject;
      let w: Worker;
      try {
        w = this.d.createWorker ? this.d.createWorker() : new Worker(new URL('./yolo.worker.ts', import.meta.url), { type: 'module' });
      } catch (e) {
        this.fail(`worker: ${(e as Error).message}`);
        reject(e as Error);
        return;
      }
      this.worker = w;
      w.onmessage = (e: MessageEvent<WorkerOut>) => {
        if (this.worker !== w) return;
        const m = e.data;
        if (m.type === 'ready') {
          Object.assign(this.stats, { state: 'ready', ep: m.ep, threads: m.threads, isolated: m.isolated, loadMs: m.loadMs, warmMs: m.warmMs });
          this.publishStats();
          this.d.log(`live boxes: ${LIVE_MODEL_ID} on ${m.ep}${m.ep === 'wasm' ? ` (${m.threads} thread${m.threads > 1 ? 's' : ''}${m.isolated ? '' : ', page not cross-origin isolated'})` : ''} · loaded in ${m.loadMs} ms · warm run ${m.warmMs} ms${m.fallback ? ` · fell back: ${m.fallback}` : ''}`, 'ok');
          resolve();
          this.rejectReady = undefined;
        } else if (m.type === 'backend') {
          Object.assign(this.stats, { ep: m.ep, threads: m.threads });
          this.publishStats();
          this.d.log(`live boxes: recovered on ${m.ep} · ${m.fallback}`, 'warn');
        } else if (m.type === 'result') this.onResult(m);
        else if (m.type === 'error') {
          if (m.id !== undefined) this.release(m.id);
          this.telemetry.value.dropped++;
          this.stats.errors++;
          this.stats.lastError = m.message;
          if (m.fatal) {
            this.fail(m.message);
            reject(new Error(m.message));
          } else if (this.stats.errors <= 3) this.d.log(`live boxes: ${m.message}`, 'warn');
        }
      };
      w.onerror = (e) => {
        if (this.worker !== w) return;
        this.fail(`worker crashed: ${e.message || 'unknown error'}`);
        reject(new Error(e.message));
      };
      const init: WorkerIn = { type: 'init', modelUrl: this.d.modelUrl, inputSize: INPUT_SIZE, ep: this.d.ep ?? 'auto' };
      try { w.postMessage(init); }
      catch (e) { this.fail(`worker: ${(e as Error).message}`); }
    });
    this.readyPromise = loading;
    void loading.catch(() => {
      if (this.readyPromise === loading) this.readyPromise = undefined;
    });
    return loading;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastOpportunityAt = -Infinity;
    void this.load().catch(() => undefined);
  }

  stop(): void {
    this.running = false;
    this.generation++;
    this.picked = undefined;
    this.lastFrame = undefined;
    this.clearShown();
    this.publishStats();
  }

  /** Live boxes on screen, for aiming and pinching (ids are the HUD ids). */
  aimables(): { id: string; position: Vector3; size: number }[] {
    const out: { id: string; position: Vector3; size: number }[] = [];
    this.appendAimables(out);
    return out;
  }

  /** Appends cached aim objects into the shell's reusable frame list. */
  appendAimables(out: { id: string; position: Vector3; size: number }[]): void {
    for (const a of this.anchors.values()) if (a.shown) out.push(a.aimable);
  }

  /** Reuse the visible box's pose for hand hover feedback. */
  hoverTarget(id: string): Pick<Anchor, 'position' | 'facing' | 'sizeM'> | undefined {
    const n = trackIdOf(id);
    const anchor = n === undefined ? undefined : this.anchors.get(n);
    return anchor?.shown ? anchor : undefined;
  }

  /** Snapshot a visible box immediately so tagging never waits for a server segmentation result. */
  targetSnapshot(id: string): HudTarget | undefined {
    const n = trackIdOf(id);
    const anchor = n === undefined ? undefined : this.anchors.get(n);
    const track = n === undefined ? undefined : this.tracker.get(n);
    return anchor?.shown && track ? this.toTarget(track, anchor) : undefined;
  }

  /** The SAM target that has taken over this live box, if any. */
  claimOf(id: string): string | undefined {
    const n = trackIdOf(id);
    return n === undefined ? undefined : this.anchors.get(n)?.claimedBy;
  }

  /** The user pinched a live box: show it locked ("identifying…") until SAM covers it. False when unknown. */
  pick(id: string): boolean {
    const n = trackIdOf(id);
    const a = n === undefined ? undefined : this.anchors.get(n);
    if (n === undefined || !a) return false;
    this.picked = n;
    const t = this.tracker.get(n);
    if (t && a.shown) {
      a.sent = undefined;
      this.show(t, a);
    }
    return true;
  }

  unpick(): void {
    const n = this.picked;
    this.picked = undefined;
    if (n === undefined) return;
    const t = this.tracker.get(n);
    const a = this.anchors.get(n);
    if (t && a?.shown) {
      a.sent = undefined;
      this.show(t, a);
    } else if (!t) this.hide(n, true);
  }

  get pickedId(): string | undefined {
    return this.picked === undefined ? undefined : hudId(this.picked);
  }

  setCategory(c: Category): void {
    if (c === this.category) return;
    this.unpick();
    this.category = c;
    // boxes of classes the chip excludes go at once
    const allowed = allowedClasses(c);
    for (const t of this.tracker.list()) if (!allowed.has(t.cls)) this.hide(t.id);
    this.d.log(`live boxes: tracking ${CATEGORIES.find((x) => x.id === c)?.label ?? c}${allowed.size ? '' : ' (no live class: lights come from the SAM scan)'}`);
  }

  /** Call every render frame. `dtMs` is the frame time. */
  tick(now: number, dtMs: number): void {
    this.telemetry.tick(now);
    this.stats.fps = this.telemetry.value.hz;
    if (this.running) this.age(now);
    this.publishStats();
    this.adapt(now, dtMs);
    if (!this.running || this.stats.state !== 'ready') return;
    if (now - this.lastOpportunityAt < Math.max(MIN_INTERVAL, this.stats.intervalMs)) return;
    this.lastOpportunityAt = now;
    if (this.inFlight) { this.telemetry.value.dropped++; return; }
    if (this.d.poses.peakSpeed(now, 120) > MAX_HEAD_SPEED) {
      this.stats.skipped++;
      this.telemetry.value.dropped++;
      return;
    }
    const allowed = allowedClasses(this.category);
    if (!allowed.size) {
      if (this.anchors.size) this.clearShown();
      return;
    }
    this.inFlight = true;
    const ticket = ++this.captureTicket;
    void this.shoot([...allowed], ticket).catch((e) => {
      if (ticket !== this.captureTicket) return;
      this.inFlight = false;
      this.stats.errors++;
      this.telemetry.value.dropped++;
      this.stats.lastError = (e as Error).message;
    });
  }

  /** The render loop's frame time decides how often we may run (never more than one frame in flight). */
  private adapt(now: number, dtMs: number): void {
    if (!(dtMs > 0) || dtMs > 250) return;
    const s = this.stats;
    s.frameMs = s.frameMs ? s.frameMs * 0.9 + dtMs * 0.1 : dtMs;
    // baseline: the best sustained frame time seen recently (slowly forgets, so a new refresh rate is learnt)
    s.baselineMs = s.baselineMs ? Math.min(s.baselineMs * 1.0005, Math.max(s.frameMs, 5)) : s.frameMs;
    if (now - this.lastAdaptAt < 500) return;
    this.lastAdaptAt = now;
    const floor = Math.max(MIN_INTERVAL, s.inferMs > 60 ? s.inferMs * 1.35 : 0);
    if (s.frameMs > s.baselineMs * 1.2) s.intervalMs = Math.min(MAX_INTERVAL, s.intervalMs * 1.4);
    else if (s.frameMs < s.baselineMs * 1.08) s.intervalMs = Math.max(floor, s.intervalMs * 0.85);
    s.intervalMs = Math.ceil(Math.min(MAX_INTERVAL, Math.max(floor, s.intervalMs)));
  }

  private async shoot(allowed: number[], ticket: number): Promise<void> {
    const generation = this.generation;
    const t0 = performance.now();
    const cam = this.d.camera();
    // Snapshot joints before the asynchronous bitmap copy, alongside its exposure pose.
    const handJoints = this.d.handJoints().map((v) => v.clone());
    const g = await cam.grab({ maxWidth: INPUT_SIZE });
    if (!g) {
      this.telemetry.value.dropped++;
      if (ticket === this.captureTicket) this.inFlight = false;
      return;
    }
    let head: PoseLike | null = null;
    if (g.headPose) {
      head = {
        position: new Vector3(g.headPose.position.x, g.headPose.position.y, g.headPose.position.z),
        quaternion: new Quaternion(g.headPose.orientation.x, g.headPose.orientation.y, g.headPose.orientation.z, g.headPose.orientation.w),
      };
    } else {
      const p = this.d.poses.lookup(g.tCapture);
      if (p) head = { position: p.position, quaternion: p.quaternion };
    }
    if (!head || !this.worker || !this.running || generation !== this.generation) {
      this.telemetry.value.dropped++;
      g.bitmap.close();
      if (ticket === this.captureTicket) this.inFlight = false;
      return;
    }
    const k = g.intrinsics ? scaleIntrinsics(g.intrinsics, g.width, g.height) : questIntrinsics(g.width, g.height);
    const id = this.nextFrameId++;
    this.pending.set(id, { id, generation, t0, cam: cameraPoseFromHead(head, cam.eye), k, handJoints });
    const msg: WorkerIn = { type: 'frame', id, bitmap: g.bitmap, allowed, scoreThreshold: this.scoreThreshold };
    try { this.worker.postMessage(msg, [g.bitmap]); }
    catch (e) {
      g.bitmap.close();
      this.release(id);
      throw e;
    }
    this.stats.frames++;
  }

  private release(id: number): PendingFrame | undefined {
    const p = this.pending.get(id);
    this.pending.delete(id);
    if (p) this.inFlight = false;
    return p;
  }

  private onResult(m: Extract<WorkerOut, { type: 'result' }>): void {
    const fr = this.release(m.id);
    if (!fr) return;
    const now = performance.now();
    const s = this.stats;
    s.inferMs = s.inferMs ? s.inferMs * 0.8 + m.inferMs * 0.2 : m.inferMs;
    const latency = now - fr.t0;
    s.latencyMs = s.latencyMs ? s.latencyMs * 0.8 + latency * 0.2 : latency;
    this.telemetry.result(now, m.inferMs);
    s.fps = this.telemetry.value.hz;
    // Back off immediately, including when a single long inference exceeds the EMA.
    if (m.inferMs > 60) s.intervalMs = Math.min(MAX_INTERVAL, Math.max(s.intervalMs, Math.ceil(m.inferMs * 1.35)));
    if (!this.running || fr.generation !== this.generation) { this.telemetry.value.dropped++; return; }
    this.apply(m.dets, fr, now);
    this.publishStats();
  }

  /** Tracker update + 3D placement + SAM handover + HUD calls for one detector result. Public for tests. */
  apply(dets: WorkerDet[], fr: Pick<PendingFrame, 'cam' | 'k' | 'handJoints'>, now: number): void {
    const allowed = allowedClasses(this.category);
    const hands = this.projectHands(fr, fr.handJoints);
    const kept = dets.filter((d) => allowed.has(d.cls) && d.score >= Math.max(ANNOTATION_MIN_SCORE, this.scoreThreshold)
      && this.candidateInRange(d, fr) && !overlapsHand(d.box, hands));
    this.lastFrame = { cam: fr.cam, k: fr.k };
    const upd = this.tracker.update(kept, now, (t) => this.predict(t, fr), this.picked, this.retentionMs());
    // a picked box that drops out of view keeps its anchor: SAM may still find it there
    for (const t of upd.removed) if (t.id !== this.picked) this.hide(t.id, true);
    const sam = this.d.samTargets();
    for (const t of upd.tracks) {
      if (!t.live || !allowed.has(t.cls)) continue;
      // A coasted box keeps its world anchor, including when head motion takes it out of view.
      const previous = this.anchors.get(t.id);
      const a = t.misses && previous ? previous : this.place(t, fr, now);
      if (t.opacity <= 0 || !inAnnotationRange(a.position, this.d.headPosition?.() ?? fr.cam.position, this.rangeM)
        || overlapsHand(t.box, hands)) { this.hide(t.id); continue; }
      const claim = this.claimedBy(t.box, fr, sam, a);
      if (claim) {
        if (!a.claimedBy) this.stats.handedOver++;
        a.claimedBy = claim;
        this.hide(t.id);
        this.trackSam(claim, sam, a, t.misses === 0);
        this.showSam(claim, sam);
        if (t.id === this.picked) {
          this.picked = undefined;
          this.d.onPickClaimed?.(claim);
          if (!this.running) return; // the shell locked it and stopped the scan
        }
        continue;
      }
      a.claimedBy = undefined;
      this.show(t, a);
    }
    this.stats.tracks = this.tracker.list().length;
    this.countShown();
    this.publishStats();
  }

  /**
   * A SAM result just arrived: hand over at once instead of at the next live frame. Checked in the image of the
   * latest detector frame (both depths may be guesses; the directions are not). Returns the SAM target that now
   * covers the picked box, if any.
   */
  onSamTargets(): string | undefined {
    const sam = this.d.samTargets();
    const fr = this.lastFrame;
    if (!sam.length || !fr) return undefined;
    let pickedBy: string | undefined;
    for (const [id, a] of this.anchors) {
      if (!a.shown && id !== this.picked) continue;
      const box = this.tracker.get(id)?.box ?? this.predict({ id }, fr);
      if (!box) continue;
      const claim = this.claimedBy(box, fr, sam, a);
      if (!claim) continue;
      if (!a.claimedBy) this.stats.handedOver++;
      a.claimedBy = claim;
      this.hide(id);
      this.showSam(claim, sam);
      if (id === this.picked) pickedBy = claim;
    }
    // Authoritative classes absent from YOLO (such as lights) also need room at the scan limit.
    const field = this.boxField();
    if (field) for (const target of sam) {
      if (field.has(target.id)) continue;
      this.showSam(target.id, sam);
      if (field.has(target.id)) continue;
      const replace = this.tracker.list().filter((t) => t.id !== this.picked && this.anchors.get(t.id)?.shown)
        .sort((a, b) => a.score - b.score)[0];
      if (replace) {
        this.hide(replace.id);
        this.showSam(target.id, sam);
      }
    }
    if (pickedBy) {
      this.picked = undefined;
      this.d.onPickClaimed?.(pickedBy);
    }
    this.countShown();
    this.publishStats();
    return pickedBy;
  }

  private projectHands(fr: Pick<PendingFrame, 'cam' | 'k'>, joints: Vector3[]): ProjectedJoint[] {
    const out = this.projectedHands;
    this.projectInverse.copy(fr.cam.quaternion).invert();
    let count = 0;
    for (const joint of joints) {
      const p = this.projectPoint.copy(joint).sub(fr.cam.position).applyQuaternion(this.projectInverse);
      if (p.z >= -0.05) continue;
      const projected = this.jointPool[count] ?? (this.jointPool[count] = { u: 0, v: 0, radius: 0 });
      projected.u = fr.k.cx + fr.k.fx * p.x / -p.z;
      projected.v = fr.k.cy - fr.k.fy * p.y / -p.z;
      projected.radius = Math.max(2, fr.k.fx * 0.018 / -p.z);
      out[count++] = projected;
    }
    out.length = count;
    return out;
  }

  private retentionMs(): number {
    // Keep invisible identities through intentional backoff; visibility still expires at 400 ms.
    return Math.max(this.tracker.opts.maxMissMs, this.stats.intervalMs * 2 + this.stats.inferMs + 100);
  }

  /** Lifetime and fade use render time, even while inference is stalled. */
  private age(now: number): void {
    for (const t of this.tracker.age(now, this.picked, this.retentionMs())) this.hide(t.id, true);
    const field = this.boxField();
    const fr = this.lastFrame;
    // Project each joint once per render frame, shared by every candidate box.
    const hands = fr && this.anchors.size ? this.projectHands(fr, this.d.handJoints()) : undefined;
    for (const t of this.tracker.values()) {
      const a = this.anchors.get(t.id);
      if (!a?.shown) continue;
      if (t.opacity <= 0 || fr && hands?.length && overlapsHand(this.predict(t, fr) ?? t.box, hands)) {
        this.hide(t.id);
        continue;
      }
      field?.setOpacity(hudId(t.id), t.opacity);
    }
    this.countShown();
  }

  private countShown(): void {
    let shown = 0, tracks = 0;
    for (const a of this.anchors.values()) if (a.shown) shown++;
    for (const _ of this.tracker.values()) tracks++;
    this.stats.shown = shown;
    this.stats.tracks = tracks;
  }

  private trackSam(id: string, targets: Target[], anchor: Anchor, observed: boolean): void {
    if (!observed) return;
    const target = targets.find((t) => t.id === id);
    if (!target) return;
    target.position.lerp(anchor.position, 0.35);
    target.facing.lerp(anchor.facing, 0.35).normalize();
    target.sizeM = anchor.sizeM;
    target.lastSeenAt = Date.now();
    this.d.onTargetTracked?.(target);
  }

  private candidateInRange(det: WorkerDet, fr: Pick<PendingFrame, 'cam' | 'k'>): boolean {
    const [x, y, w, h] = det.box;
    const ray = pixelToRay(x + w / 2, y + h / 2, fr.k, fr.cam);
    const depth = this.priorDepth(det.cls, w, h, fr.k.fx);
    return inAnnotationRange(ray.origin.addScaledVector(ray.dir, depth), this.d.headPosition?.() ?? fr.cam.position, this.rangeM);
  }

  private priorDepth(cls: number, w: number, h: number, fx: number): number {
    return Math.max(0.3, (fx * (deviceClass(cls)?.sizeM ?? 0.3)) / Math.max(w, h, 1));
  }

  private showSam(id: string, targets: Target[]): void {
    const target = targets.find((t) => t.id === id);
    // At capacity, the scanner's first upsert could not allocate an outline. The live slot is free now.
    if (target) this.d.hud().upsertTarget(toHudTarget(target));
  }

  /** Where a track's world anchor lands in this frame (so head motion between frames does not break matching). */
  private predict(t: Pick<Track, 'id'>, fr: Pick<PendingFrame, 'cam' | 'k'>): Box | null {
    const a = this.anchors.get(t.id);
    if (!a) return null;
    const px = worldToPixel(a.position, fr.k, fr.cam);
    if (!px) return null;
    const w = (a.sizeM[0] * fr.k.fx) / px.depth;
    const h = (a.sizeM[1] * fr.k.fy) / px.depth;
    return [px.u - w / 2, px.v - h / 2, w, h];
  }

  /** Box → world: a ray from the capture camera through the box centre, at the hit-test depth or a size prior. */
  private place(t: Track, fr: Pick<PendingFrame, 'cam' | 'k'>, now: number): Anchor {
    const k = fr.k;
    const [x, y, w, h] = t.box;
    const ray = pixelToRay(x + w / 2, y + h / 2, k, fr.cam);
    let a = this.anchors.get(t.id);
    const prior = this.priorDepth(t.cls, w, h, k.fx);
    let depth = prior;
    if (a?.hit) {
      const along = a.hit.clone().sub(ray.origin).dot(ray.dir);
      if (along > 0.15 && along < 6) depth = along;
    }
    const position = ray.origin.clone().addScaledVector(ray.dir, depth);
    const camFwd = new Vector3(0, 0, -1).applyQuaternion(fr.cam.quaternion);
    const zCam = Math.max(0.05, depth * Math.max(0.2, ray.dir.dot(camFwd)));
    const sizeM: [number, number, number] = [r3((w * zCam) / k.fx), r3((h * zCam) / k.fy), r3(Math.min(w / k.fx, h / k.fy) * zCam * 0.5)];
    if (!a) {
      a = { position, sizeM, facing: ray.origin.clone().sub(position).normalize(), hitPending: false, lastHitAt: 0, shown: false, aimable: { id: hudId(t.id), position, size: Math.max(0.06, sizeM[0], sizeM[1]) } };
      this.anchors.set(t.id, a);
    } else {
      a.position.lerp(position, 0.35);
      a.sizeM = sizeM;
      a.facing.copy(ray.origin).sub(a.position).normalize();
    }
    a.aimable.size = Math.max(0.06, sizeM[0], sizeM[1]);
    // a hit test along the box centre at most once a second per box (async; used from the next frame on)
    const providers = this.d.depth();
    if (providers.length && !a.hitPending && now - a.lastHitAt > 1000) {
      a.hitPending = true;
      a.lastHitAt = now;
      const anchor = a;
      void (async () => {
        for (const p of providers) {
          const hit = await p.hit(ray).catch(() => null);
          if (hit) {
            const dist = hit.point.distanceTo(ray.origin);
            if (dist > 0.15 && dist < 6) anchor.hit = hit.point.clone();
            break;
          }
        }
        anchor.hitPending = false;
      })();
    }
    return a;
  }

  /** The SAM target (if any) that covers this live box in this frame. */
  private claimedBy(box: Box, fr: Pick<PendingFrame, 'cam' | 'k'>, sam: Target[], anchor: Anchor): string | undefined {
    return claimSamTarget(box, sam.map((s) => {
      const px = worldToPixel(s.position, fr.k, fr.cam);
      if (!px) return { id: s.id, position: s.position, sizeM: s.sizeM };
      const sw = (Math.max(0.03, s.sizeM[0]) * fr.k.fx) / px.depth;
      const sh = (Math.max(0.03, s.sizeM[1]) * fr.k.fy) / px.depth;
      const sbox: Box = [px.u - sw / 2, px.v - sh / 2, sw, sh];
      return { id: s.id, box: sbox, position: s.position, sizeM: s.sizeM };
    }), anchor.position, anchor.sizeM);
  }

  private show(t: Track, a: Anchor): void {
    const info = deviceClass(t.cls);
    const label = info?.label ?? 'Device';
    const score = Math.round(t.score * 100) / 100;
    const picked = t.id === this.picked;
    this.boxField()?.setOpacity(hudId(t.id), t.opacity);
    const s = a.sent;
    // Keep the shell's observation timestamp fresh even when a device stays perfectly still.
    if (a.shown && s && t.lastSeenAt - s.seenAt < 200 && s.picked === picked && s.label === label && Math.abs(s.score - score) < 0.05 && s.position.distanceTo(a.position) < 0.008 && Math.abs(s.sizeM[0] - a.sizeM[0]) < 0.08 * s.sizeM[0] + 0.004 && Math.abs(s.sizeM[1] - a.sizeM[1]) < 0.08 * s.sizeM[1] + 0.004) return;
    const ht = this.toTarget(t, a);
    this.d.hud().upsertTarget(ht);
    const field = this.boxField();
    if (field && !field.has(ht.id)) {
      this.d.hud().removeTarget(ht.id);
      return;
    }
    field?.setOpacity(ht.id, t.opacity);
    a.shown = true;
    a.sent = { position: a.position.clone(), sizeM: [...a.sizeM], label, score, picked, seenAt: t.lastSeenAt };
  }

  private toTarget(t: Track, a: Anchor): HudTarget {
    const v = (p: Vector3): [number, number, number] => [r3(p.x), r3(p.y), r3(p.z)];
    const picked = t.id === this.picked;
    return {
      id: hudId(t.id),
      label: deviceClass(t.cls)?.label ?? 'Device',
      subtitle: picked ? 'identifying…' : 'live',
      status: picked ? 'locked' : 'scanned',
      position: v(a.position),
      facing: v(a.facing),
      confirmed: Boolean(a.hit),
      sizeM: a.sizeM,
      score: Math.round(t.score * 100) / 100,
      modelId: LIVE_MODEL_ID,
      source: 'yolo',
    };
  }

  private hide(trackId: number, forget = false): void {
    const a = this.anchors.get(trackId);
    if (a?.shown) {
      this.d.hud().removeTarget(hudId(trackId));
      a.shown = false;
      a.sent = undefined;
    }
    if (forget) this.anchors.delete(trackId);
  }

  private clearShown(): void {
    for (const t of this.tracker.clear()) this.hide(t.id, true);
    for (const id of [...this.anchors.keys()]) this.hide(id, true);
    this.stats.tracks = 0;
    this.stats.shown = 0;
  }

  private fail(message: string): void {
    this.stop();
    this.worker?.terminate();
    this.worker = undefined;
    this.pending.clear();
    this.captureTicket++;
    this.inFlight = false;
    this.rejectReady?.(new Error(message));
    this.rejectReady = undefined;
    this.readyPromise = undefined;
    this.stats.state = 'error';
    this.publishStats();
    this.stats.lastError = message;
    this.d.log(`live boxes unavailable: ${message}`, 'error');
  }

  /** One line for the page status and the debug readout. */
  summary(): string {
    const s = this.stats;
    if (s.state !== 'ready') return `${LIVE_MODEL_ID} · ${s.state}${s.lastError ? ` · ${s.lastError}` : ''}`;
    return `${LIVE_MODEL_ID} · ${s.ep}${s.ep === 'wasm' ? `×${s.threads}` : ''} · ${this.running ? `${s.fps} fps` : 'idle'} · infer ${Math.round(s.inferMs)} ms · latency ${Math.round(s.latencyMs)} ms · every ${s.intervalMs} ms · frame ${s.frameMs.toFixed(1)} ms · ${s.shown} box${s.shown === 1 ? '' : 'es'}${s.handedOver ? ` · ${s.handedOver} to SAM` : ''} · ${this.category}`;
  }

  dispose(): void {
    this.stop();
    this.worker?.terminate();
    this.worker = undefined;
    this.pending.clear();
    this.captureTicket++;
    this.inFlight = false;
    this.rejectReady?.(new Error('detector disposed'));
    this.rejectReady = undefined;
    this.readyPromise = undefined;
    this.stats.state = 'off';
    this.publishStats();
  }
}

export const hudId = (trackId: number) => `yolo_${trackId}`;
export const isLiveId = (id: string | null | undefined): id is string => Boolean(id?.startsWith('yolo_'));
function trackIdOf(id: string): number | undefined {
  const m = /^yolo_(\d+)$/.exec(id);
  return m ? Number(m[1]) : undefined;
}
const r3 = (n: number) => Math.round(n * 1000) / 1000;
