/**
 * Single-object tracker for tangible control. Its own YOLOX-nano worker (the live layer's worker and protocol,
 * scan/yolo/yolo.worker.ts) runs at ~10 Hz with one frame in flight, so inference never touches the render
 * loop. Each box is lifted to world space with the pose the frame was captured at, the depth follows the box
 * size from a seeded reference, and the position is One Euro filtered. Between detections the render loop
 * eases a display position toward the filtered one (allocation-free).
 *
 * Unlike the annotation layer, a box that overlaps a hand is KEPT (the object is in your hand). When the
 * detector loses it while a wrist was holding it, the object follows the wrist for a few seconds.
 *
 * Modes: 'pick' shows candidate objects (everyday classes only); 'follow' tracks one. A scripted path
 * (`setSim`) replaces the camera + detector in the desktop emulator so the whole chain can be exercised.
 */
import { Quaternion, Vector3 } from 'three';
import type { HandState } from '../hud/contract';
import type { Intrinsics } from '../io/v1';
import type { CameraSource } from '../scan/camera';
import type { PoseRing } from '../scan/poses';
import { cameraPoseFromHead, type PoseLike, questIntrinsics, scaleIntrinsics } from '../scan/projection';
import type { Box } from '../scan/yolo/prep';
import type { WorkerDet, WorkerIn, WorkerOut, YoloEp } from '../scan/yolo/protocol';
import { BoxTracker } from '../scan/yolo/tracker';
import { sameFamily, TANGIBLE_CLASSES, tangibleKind } from './objects';
import { OneEuro, OneEuro3 } from './one-euro';

export type TrackMode = 'off' | 'pick' | 'follow';
export type FollowState = 'searching' | 'tracking' | 'held' | 'lost';

export interface TrackDeps {
  camera: () => CameraSource | undefined;
  poses: PoseRing;
  /** current head pose (render time) */
  head: () => PoseLike | undefined;
  hands: () => { left?: HandState; right?: HandState } | undefined;
  modelUrl: string;
  ep?: YoloEp | 'auto';
  log: (msg: string, level?: 'info' | 'ok' | 'warn' | 'error') => void;
  createWorker?: () => Worker;
}

export interface Candidate {
  id: number;
  cls: number;
  label: string;
  position: Vector3;
  sizeM: number;
  score: number;
  seenAt: number;
}

export interface FollowSeed {
  position: Vector3;
  /** largest dimension, metres */
  sizeM: number;
  label: string;
  cls: number;
}

export type SimPath = 'demo' | 'lift' | 'slide' | 'still';

interface Pending { id: number; cam: PoseLike; k: Intrinsics; t: number }

const INPUT = 416;
const FOLLOW_MS = 95;
const PICK_MS = 140;
const COAST_MS = 450;
const LOST_MS = 750;
const HOLD_MS = 4000;
const HOLD_REACH = 0.17;
const MAX_HEAD_SPEED = 140;
const MAX_CANDIDATES = 4;

export class ObjectTracker {
  mode: TrackMode = 'off';
  state: FollowState = 'searching';
  /** filtered world position at the latest measurement (or wrist follow) */
  readonly position = new Vector3();
  /** eased per render frame: draw here */
  readonly display = new Vector3();
  sizeM = 0.12;
  label = 'Object';
  cls = 41;
  score = 0;
  lastSeenAt = -Infinity;
  /** latest matched box in its frame's pixels, and that frame's size */
  readonly box: Box = [0, 0, 0, 0];
  frameW = 0;
  frameH = 0;
  readonly candidates: Candidate[] = [];
  readonly stats = { state: 'off' as 'off' | 'loading' | 'ready' | 'error', ep: '' as string, hz: 0, inferMs: 0, frames: 0, matched: 0, sim: '' as SimPath | '' };

  private worker?: Worker;
  private ready?: Promise<void>;
  private inFlight = false;
  private lastShotAt = -Infinity;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly picker = new BoxTracker({ minHits: 2, minAgeMs: 120, maxTracks: 6, alpha: 0.5 });
  private readonly pool: Candidate[] = [];
  private readonly filter = new OneEuro3(1.0, 4, 1);
  private readonly depthFilter = new OneEuro(0.8, 1.5, 1);
  private depthRef = 0;
  private sizeRefPx = 0;
  private seeded = false;
  private hold: { hand: 'left' | 'right'; offset: Vector3 } | null = null;
  private resultTimes: number[] = [];
  private sim: { path: SimPath; t0: number; center: Vector3; right: Vector3 } | null = null;
  // scratch (no per-frame allocations)
  private readonly v = new Vector3();
  private readonly dir = new Vector3();
  private readonly q = new Quaternion();
  private readonly qi = new Quaternion();
  private readonly camScratch: PoseLike = { position: new Vector3(), quaternion: new Quaternion() };

  constructor(private readonly d: TrackDeps) {}

  /** Load the detector (idempotent). */
  load(): Promise<void> {
    if (this.ready) return this.ready;
    this.stats.state = 'loading';
    this.ready = new Promise<void>((resolve, reject) => {
      let w: Worker;
      try { w = this.d.createWorker ? this.d.createWorker() : new Worker(new URL('../scan/yolo/yolo.worker.ts', import.meta.url), { type: 'module', name: 'tangible-yolo' }); }
      catch (e) { this.stats.state = 'error'; reject(e as Error); return; }
      this.worker = w;
      w.onmessage = (e: MessageEvent<WorkerOut>) => {
        const m = e.data;
        if (m.type === 'ready') { this.stats.state = 'ready'; this.stats.ep = m.ep; this.d.log(`tangible: tracker ready on ${m.ep} (${m.loadMs} ms)`, 'ok'); resolve(); }
        else if (m.type === 'backend') this.stats.ep = m.ep;
        else if (m.type === 'result') this.onWorkerResult(m);
        else if (m.type === 'error') {
          if (m.id !== undefined) { this.pending.delete(m.id); this.inFlight = false; }
          if (m.fatal) { this.stats.state = 'error'; this.d.log(`tangible: tracker unavailable · ${m.message}`, 'error'); reject(new Error(m.message)); }
        }
      };
      w.onerror = (e) => { this.stats.state = 'error'; this.inFlight = false; reject(new Error(e.message)); };
      const init: WorkerIn = { type: 'init', modelUrl: this.d.modelUrl, inputSize: INPUT, ep: this.d.ep ?? 'auto' };
      w.postMessage(init);
    });
    void this.ready.catch(() => { this.ready = undefined; this.worker?.terminate(); this.worker = undefined; });
    return this.ready;
  }

  startPick(): void {
    this.mode = 'pick';
    this.picker.clear();
    this.candidates.length = 0;
    if (!this.sim) void this.load().catch(() => undefined);
  }

  /** Track one object, seeded from where it was seen (annotation target or a picked candidate). */
  follow(seed: FollowSeed, now = performance.now()): void {
    this.mode = 'follow';
    this.state = 'searching';
    this.cls = seed.cls;
    this.label = seed.label;
    this.sizeM = seed.sizeM;
    this.position.copy(seed.position);
    this.display.copy(seed.position);
    this.filter.reset(seed.position, now);
    this.depthFilter.reset();
    this.seeded = false;
    this.depthRef = 0;
    this.lastSeenAt = now;
    this.hold = null;
    this.candidates.length = 0;
    if (!this.sim) void this.load().catch(() => undefined);
  }

  pickCandidate(id: number): FollowSeed | null {
    const c = this.candidates.find((x) => x.id === id);
    if (!c) return null;
    return { position: c.position.clone(), sizeM: c.sizeM, label: c.label, cls: c.cls };
  }

  stop(): void {
    this.mode = 'off';
    this.candidates.length = 0;
    this.picker.clear();
    this.hold = null;
    this.pending.clear();
    this.inFlight = false;
  }

  dispose(): void { this.stop(); this.worker?.terminate(); this.worker = undefined; this.ready = undefined; }

  /** Replace camera + detector with a scripted object path in front of the head (emulator). */
  setSim(path: SimPath | null, now = performance.now()): void {
    if (!path) { this.sim = null; this.stats.sim = ''; return; }
    const head = this.d.head();
    const center = new Vector3(0, 1.1, -0.65), right = new Vector3(1, 0, 0);
    if (head) {
      right.set(1, 0, 0).applyQuaternion(head.quaternion); right.y = 0;
      if (right.lengthSq() < 1e-4) right.set(1, 0, 0);
      right.normalize();
      this.dir.set(0, 0, -1).applyQuaternion(head.quaternion); this.dir.y = 0;
      if (this.dir.lengthSq() < 1e-4) this.dir.set(0, 0, -1);
      this.dir.normalize();
      // on the desk, a little to the right of where the device card spawns
      center.copy(head.position).addScaledVector(this.dir, 0.72).addScaledVector(right, 0.26); center.y = head.position.y - 0.42;
    }
    this.sim = { path, t0: now, center, right };
    this.stats.sim = path;
  }

  get simCenter(): Vector3 | undefined { return this.sim?.center; }
  get simT0(): number { return this.sim?.t0 ?? 0; }

  /** Per render frame: schedule a detection, age the state, ease the display position. */
  tick(now: number, dtMs: number): void {
    if (this.mode === 'off') return;
    this.schedule(now);
    if (this.mode === 'pick') {
      for (let i = this.candidates.length - 1; i >= 0; i--) if (now - this.candidates[i]!.seenAt > 900) this.candidates.splice(i, 1);
      return;
    }
    const since = now - this.lastSeenAt;
    if (this.state === 'tracking' && since > COAST_MS) {
      const wrist = this.hold ? this.wrist(this.hold.hand) : undefined;
      this.state = wrist ? 'held' : since > LOST_MS ? 'lost' : 'tracking';
    }
    if (this.state === 'held') {
      const wrist = this.hold ? this.wrist(this.hold.hand) : undefined;
      if (!wrist || !this.hold || since > HOLD_MS) { this.state = 'lost'; this.hold = null; }
      else {
        this.v.copy(this.hold.offset).applyQuaternion(wrist.quaternion).add(wrist.position);
        this.position.copy(this.filter.filter(this.v, now));
      }
    }
    // ~45 ms time constant: smooth between 10 Hz measurements without visible lag
    const a = 1 - Math.exp(-Math.max(0, dtMs) / 45);
    this.display.lerp(this.position, a);
  }

  /** For a crop hint (buddy): the followed object's world pose while it is tracked. */
  visible(): boolean { return this.mode === 'follow' && (this.state === 'tracking' || this.state === 'held'); }

  private wrist(hand: 'left' | 'right'): { position: Vector3; quaternion: Quaternion } | undefined {
    const h = this.d.hands()?.[hand];
    if (!h || h.controller) return undefined;
    return h.joints['wrist'];
  }

  private schedule(now: number): void {
    const interval = this.mode === 'follow' ? FOLLOW_MS : PICK_MS;
    if (this.inFlight || now - this.lastShotAt < interval) return;
    this.lastShotAt = now;
    if (this.sim) { this.simulate(now); return; }
    if (this.stats.state !== 'ready' || !this.worker) return;
    if (this.d.poses.peakSpeed(now, 120) > MAX_HEAD_SPEED) return;
    this.inFlight = true;
    void this.shoot().catch(() => { this.inFlight = false; });
  }

  private async shoot(): Promise<void> {
    const cam = this.d.camera();
    const g = cam ? await cam.grab({ maxWidth: INPUT }) : null;
    if (!g || !cam) { this.inFlight = false; return; }
    let head: PoseLike | null = null;
    if (g.headPose) {
      head = { position: new Vector3(g.headPose.position.x, g.headPose.position.y, g.headPose.position.z),
        quaternion: new Quaternion(g.headPose.orientation.x, g.headPose.orientation.y, g.headPose.orientation.z, g.headPose.orientation.w) };
    } else {
      const p = this.d.poses.lookup(g.tCapture);
      if (p) head = { position: p.position.clone(), quaternion: p.quaternion.clone() };
    }
    if (!head || !this.worker || this.mode === 'off') { g.bitmap.close(); this.inFlight = false; return; }
    const k = g.intrinsics ? scaleIntrinsics(g.intrinsics, g.width, g.height) : questIntrinsics(g.width, g.height);
    const id = this.nextId++;
    this.pending.set(id, { id, cam: cameraPoseFromHead(head, cam.eye), k, t: performance.now() });
    const msg: WorkerIn = { type: 'frame', id, bitmap: g.bitmap, allowed: TANGIBLE_CLASSES, scoreThreshold: 0.3 };
    try { this.worker.postMessage(msg, [g.bitmap]); this.stats.frames++; }
    catch { g.bitmap.close(); this.pending.delete(id); this.inFlight = false; }
  }

  private onWorkerResult(m: Extract<WorkerOut, { type: 'result' }>): void {
    const fr = this.pending.get(m.id);
    this.pending.delete(m.id);
    this.inFlight = false;
    if (!fr || this.mode === 'off') return;
    this.stats.inferMs = this.stats.inferMs ? this.stats.inferMs * 0.8 + m.inferMs * 0.2 : m.inferMs;
    this.frameW = m.width; this.frameH = m.height;
    this.apply(m.dets, fr.cam, fr.k, performance.now());
  }

  /** One detector result (real or scripted). */
  apply(dets: WorkerDet[], cam: PoseLike, k: Intrinsics, now: number): void {
    const times = this.resultTimes;
    times.push(now);
    while (times.length && now - times[0]! > 1000) times.shift();
    this.stats.hz = times.length;
    if (this.mode === 'pick') this.applyPick(dets, cam, k, now);
    else if (this.mode === 'follow') this.applyFollow(dets, cam, k, now);
  }

  private priorDepth(cls: number, w: number, h: number, fx: number): number {
    return Math.max(0.25, Math.min(3, (fx * (tangibleKind(cls)?.sizeM ?? 0.15)) / Math.max(w, h, 1)));
  }

  private rayDir(u: number, v: number, k: Intrinsics, cam: PoseLike, out: Vector3): Vector3 {
    return out.set((u - k.cx) / k.fx, -(v - k.cy) / k.fy, -1).normalize().applyQuaternion(cam.quaternion);
  }

  private applyPick(dets: WorkerDet[], cam: PoseLike, k: Intrinsics, now: number): void {
    const upd = this.picker.update(dets.filter((d) => tangibleKind(d.cls)), now);
    this.candidates.length = 0;
    for (const t of upd.tracks) {
      if (!t.live || t.misses > 2) continue;
      const kind = tangibleKind(t.cls);
      if (!kind) continue;
      const [x, y, w, h] = t.box;
      const depth = this.priorDepth(t.cls, w, h, k.fx);
      let c = this.pool.find((p) => p.id === t.id);
      if (!c) {
        c = { id: t.id, cls: t.cls, label: kind.label, position: new Vector3(), sizeM: kind.sizeM, score: t.score, seenAt: now };
        this.pool.push(c);
        if (this.pool.length > 16) this.pool.shift();
        this.rayDir(x + w / 2, y + h / 2, k, cam, this.dir);
        c.position.copy(cam.position).addScaledVector(this.dir, depth);
      } else {
        this.rayDir(x + w / 2, y + h / 2, k, cam, this.dir);
        this.v.copy(cam.position).addScaledVector(this.dir, depth);
        c.position.lerp(this.v, 0.5);
      }
      c.cls = t.cls; c.label = kind.label; c.score = t.score; c.seenAt = now;
      c.sizeM = Math.max(0.06, Math.max(w, h) * depth / k.fx);
      this.candidates.push(c);
      if (this.candidates.length >= MAX_CANDIDATES) break;
    }
  }

  private applyFollow(dets: WorkerDet[], cam: PoseLike, k: Intrinsics, now: number): void {
    // where the object should be in this frame
    this.qi.copy(cam.quaternion).invert();
    const p = this.v.copy(this.position).sub(cam.position).applyQuaternion(this.qi);
    const ahead = p.z < -0.05;
    const depthNow = ahead ? -p.z : 0.6;
    const pu = ahead ? k.cx + k.fx * p.x / depthNow : k.cx, pv = ahead ? k.cy - k.fy * p.y / depthNow : k.cy;
    const expected = Math.max(18, k.fx * this.sizeM / Math.max(0.2, depthNow));
    const since = now - this.lastSeenAt;
    const gate = this.state === 'tracking' && since < 400 ? 2.2 : this.state === 'searching' ? 3.5 : 4.5;
    let best = -1, bestCost = Infinity;
    for (let i = 0; i < dets.length; i++) {
      const det = dets[i]!;
      if (!tangibleKind(det.cls)) continue;
      const [x, y, w, h] = det.box;
      const n = Math.hypot(x + w / 2 - pu, y + h / 2 - pv) / Math.max(expected, Math.max(w, h));
      const cost = n + (sameFamily(det.cls, this.cls) ? 0 : 1.2) - det.score * 0.3;
      if (n < gate && cost < bestCost) { bestCost = cost; best = i; }
    }
    if (best < 0) return;
    const det = dets[best]!;
    const [x, y, w, h] = det.box;
    const sizePx = Math.sqrt(Math.max(1, w * h));
    this.rayDir(x + w / 2, y + h / 2, k, cam, this.dir);
    if (!this.seeded) {
      // the seed's distance along this ray is the depth reference; else the class size prior
      const along = this.v.copy(this.position).sub(cam.position).dot(this.dir);
      this.depthRef = along > 0.2 && along < 3 ? along : this.priorDepth(det.cls, w, h, k.fx);
      this.sizeRefPx = sizePx;
      this.seeded = true;
      this.depthFilter.reset(this.depthRef, now);
    }
    const raw = Math.min(this.depthRef * 2, Math.max(this.depthRef * 0.5, this.depthRef * this.sizeRefPx / sizePx));
    const depth = Math.min(3, Math.max(0.2, this.depthFilter.filter(raw, now)));
    this.v.copy(cam.position).addScaledVector(this.dir, depth);
    if (this.state !== 'tracking' && this.state !== 'searching') this.filter.reset(this.v, now);
    this.position.copy(this.filter.filter(this.v, now));
    if (this.state === 'lost' || this.state === 'searching') this.display.copy(this.position);
    this.sizeM = Math.max(0.05, Math.min(0.5, Math.max(w, h) * depth / k.fx));
    this.box[0] = x; this.box[1] = y; this.box[2] = w; this.box[3] = h;
    this.score = det.score;
    if (sameFamily(det.cls, this.cls) || det.score > 0.6) { this.cls = det.cls; this.label = tangibleKind(det.cls)?.label ?? this.label; }
    this.lastSeenAt = now;
    this.state = 'tracking';
    this.stats.matched++;
    this.updateHold();
  }

  /** Remember which wrist holds the object, in that wrist's frame, for occlusion fallback. */
  private updateHold(): void {
    let bestHand: 'left' | 'right' | null = null, bestD = HOLD_REACH;
    for (const hand of ['left', 'right'] as const) {
      const w = this.wrist(hand);
      if (!w) continue;
      const dist = w.position.distanceTo(this.position);
      if (dist < bestD) { bestD = dist; bestHand = hand; }
    }
    if (!bestHand) { this.hold = null; return; }
    const w = this.wrist(bestHand)!;
    this.q.copy(w.quaternion).invert();
    if (!this.hold || this.hold.hand !== bestHand) this.hold = { hand: bestHand, offset: new Vector3() };
    this.hold.offset.copy(this.position).sub(w.position).applyQuaternion(this.q);
  }

  /** Scripted detections: an object moving on a path, projected into the current camera. */
  private simulate(now: number): void {
    const sim = this.sim!, head = this.d.head();
    if (!head) return;
    const cam = cameraPoseFromHead(head, 'left', this.camScratch);
    const k = questIntrinsics(INPUT, 312);
    const t = (now - sim.t0) / 1000;
    const world = this.simPosition(t, sim.path, this.v);
    this.qi.copy(cam.quaternion).invert();
    const c = this.dir.copy(world).sub(cam.position).applyQuaternion(this.qi);
    this.frameW = INPUT; this.frameH = 312;
    if (c.z >= -0.05) { this.apply([], cam, k, now); return; }
    const depth = -c.z, u = k.cx + k.fx * c.x / depth, v = k.cy - k.fy * c.y / depth;
    const w = k.fx * 0.085 / depth, h = k.fy * 0.11 / depth;
    const inView = u > 0 && u < INPUT && v > 0 && v < 312;
    // a short dropout every ~9 s shows coasting / re-acquire
    const dropout = sim.path === 'demo' && t % 9 > 8.4;
    this.apply(inView && !dropout ? [{ box: [u - w / 2, v - h / 2, w, h], score: 0.82, cls: 41 }] : [], cam, k, now);
  }

  simPosition(t: number, path: SimPath, out: Vector3): Vector3 {
    const c = this.sim?.center ?? this.position;
    const lift = path === 'slide' || path === 'still' ? 0 : path === 'lift' ? 0.11 * (1 - Math.cos(t * 1.3)) : 0.1 * (1 - Math.cos(t * 1.05));
    const slide = path === 'lift' || path === 'still' ? 0 : path === 'slide' ? 0.14 * Math.sin(t * 1.1) : 0.13 * Math.sin(t * 0.62);
    // slide along the head's right at sim start (= the binding's slide axis)
    const r = this.sim?.right;
    const rx = r?.x ?? 1, rz = r?.z ?? 0;
    return out.set(c.x + rx * slide, c.y + lift, c.z + rz * slide);
  }
}
