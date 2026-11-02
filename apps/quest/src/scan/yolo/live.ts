/**
 * LIVE BOXES: the fast half of the annotation layer. While SCAN is on, camera frames (downscaled to 416 px at
 * grab time) go to an on-device YOLOX-nano worker; its device boxes are tracked (tracker.ts), lifted to 3D with
 * the pose the frame was captured at (like the SAM tags), and drawn through the HUD API as `source: 'yolo'`
 * targets: thin brackets and a small class tag. SAM 3.1 (server, ~1 Hz) stays the source of truth: the moment a
 * SAM outline covers the same object, the live box is removed (the HUD fades it) and stays suppressed.
 *
 * Responsiveness only: live boxes are never identified, never selectable, never sent to the server, and never
 * drawn on people (the worker drops "person"; boxes that are really a tracked hand are dropped here).
 *
 * Cadence is adaptive: one frame in flight, at most ~15 Hz, and the interval backs off when the render loop's
 * frame time rises above its baseline (the XR frame rate always wins over detection).
 */
import { Quaternion, Vector3 } from 'three';
import type { Hud, HudTarget } from '../../app/hud-contract';
import type { Intrinsics } from '../../io/v1';
import type { CameraSource } from '../camera';
import type { DepthProvider } from '../placement';
import type { PoseRing } from '../poses';
import { cameraPoseFromHead, pixelToRay, type PoseLike, questIntrinsics, scaleIntrinsics, worldToPixel } from '../projection';
import type { Target } from '../targets';
import { allowedClasses, type Category, CATEGORIES, deviceClass } from './classes';
import { containment, iou } from './post';
import type { Box } from './prep';
import type { WorkerDet, WorkerIn, WorkerOut, YoloEp } from './protocol';
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
  /** world positions of tracked hand joints right now */
  handJoints: () => Vector3[];
  log: (msg: string, level?: 'info' | 'ok' | 'warn' | 'error') => void;
  modelUrl: string;
  ep?: YoloEp | 'auto';
  /** the box the user pinched is now covered by this SAM target (the shell locks it) */
  onPickClaimed?: (samTargetId: string) => void;
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
  sent?: { position: Vector3; sizeM: [number, number, number]; label: string; score: number; picked: boolean };
}

const HELD = /remote|phone/i;
const MIN_INTERVAL = 66;
const MAX_INTERVAL = 1000;
const MAX_HEAD_SPEED = 120; // deg/s: faster than this, frames are blurred and boxes would only lag

export class LiveDetector {
  readonly stats: LiveStats = { state: 'off', inferMs: 0, latencyMs: 0, fps: 0, intervalMs: 100, frameMs: 0, baselineMs: 0, tracks: 0, shown: 0, handedOver: 0, frames: 0, skipped: 0, errors: 0 };
  readonly tracker = new BoxTracker();
  category: Category = 'everything';
  scoreThreshold = 0.3;
  running = false;
  private worker?: Worker;
  private readyPromise?: Promise<void>;
  private readonly pending = new Map<number, PendingFrame>();
  private readonly anchors = new Map<number, Anchor>();
  private nextFrameId = 1;
  private inFlight = false;
  private lastSentAt = 0;
  private lastAdaptAt = 0;
  private readonly results: number[] = [];
  /** the camera of the latest detector frame (SAM handover is checked in it) */
  private lastFrame?: Pick<PendingFrame, 'cam' | 'k'>;
  /** the track the user pinched, waiting for SAM 3.1 to cover it */
  private picked?: number;

  constructor(private readonly d: LiveDetectorDeps) {}

  /** Load the model (idempotent); resolves when the worker is warm. */
  load(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.stats.state = 'loading';
    this.readyPromise = new Promise<void>((resolve, reject) => {
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
        const m = e.data;
        if (m.type === 'ready') {
          Object.assign(this.stats, { state: 'ready', ep: m.ep, threads: m.threads, isolated: m.isolated, loadMs: m.loadMs, warmMs: m.warmMs });
          this.d.log(`live boxes: ${LIVE_MODEL_ID} on ${m.ep}${m.ep === 'wasm' ? ` (${m.threads} thread${m.threads > 1 ? 's' : ''}${m.isolated ? '' : ', page not cross-origin isolated'})` : ''} · loaded in ${m.loadMs} ms · warm run ${m.warmMs} ms${m.fallback ? ` · fell back: ${m.fallback}` : ''}`, 'ok');
          resolve();
        } else if (m.type === 'result') this.onResult(m);
        else if (m.type === 'error') {
          if (m.id !== undefined) this.release(m.id);
          this.stats.errors++;
          this.stats.lastError = m.message;
          if (m.fatal) {
            this.fail(m.message);
            reject(new Error(m.message));
          } else if (this.stats.errors <= 3) this.d.log(`live boxes: ${m.message}`, 'warn');
        }
      };
      w.onerror = (e) => {
        this.fail(`worker crashed: ${e.message || 'unknown error'}`);
        reject(new Error(e.message));
      };
      const init: WorkerIn = { type: 'init', modelUrl: this.d.modelUrl, inputSize: INPUT_SIZE, ep: this.d.ep ?? 'auto' };
      w.postMessage(init);
    });
    this.readyPromise.catch(() => undefined);
    return this.readyPromise;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastSentAt = 0;
    void this.load().catch(() => undefined);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.picked = undefined;
    this.clearShown();
  }

  /** Live boxes on screen, for aiming and pinching (ids are the HUD ids). */
  aimables(): { id: string; position: Vector3; size: number }[] {
    const out: { id: string; position: Vector3; size: number }[] = [];
    for (const [id, a] of this.anchors) if (a.shown) out.push({ id: hudId(id), position: a.position, size: Math.max(0.06, a.sizeM[0], a.sizeM[1]) });
    return out;
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
    } else if (!t) this.anchors.delete(n);
  }

  get pickedId(): string | undefined {
    return this.picked === undefined ? undefined : hudId(this.picked);
  }

  setCategory(c: Category): void {
    if (c === this.category) return;
    this.category = c;
    // boxes of classes the chip excludes go at once
    const allowed = allowedClasses(c);
    for (const t of this.tracker.list()) if (!allowed.has(t.cls)) this.hide(t.id);
    this.d.log(`live boxes: tracking ${CATEGORIES.find((x) => x.id === c)?.label ?? c}${allowed.size ? '' : ' (no live class: lights come from the SAM scan)'}`);
  }

  /** Call every render frame. `dtMs` is the frame time. */
  tick(now: number, dtMs: number): void {
    this.adapt(now, dtMs);
    if (!this.running || this.stats.state !== 'ready' || this.inFlight) return;
    if (now - this.lastSentAt < this.stats.intervalMs) return;
    if (this.d.poses.peakSpeed(now, 120) > MAX_HEAD_SPEED) {
      this.stats.skipped++;
      return;
    }
    const allowed = allowedClasses(this.category);
    if (!allowed.size) {
      if (this.anchors.size) this.clearShown();
      return;
    }
    this.lastSentAt = now;
    this.inFlight = true;
    void this.shoot([...allowed]).catch((e) => {
      this.inFlight = false;
      this.stats.errors++;
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
    const floor = Math.max(MIN_INTERVAL, s.inferMs * 1.1);
    if (s.frameMs > s.baselineMs * 1.2) s.intervalMs = Math.min(MAX_INTERVAL, s.intervalMs * 1.4);
    else if (s.frameMs < s.baselineMs * 1.08) s.intervalMs = Math.max(floor, s.intervalMs * 0.85);
    s.intervalMs = Math.round(Math.max(MIN_INTERVAL, s.intervalMs));
  }

  private async shoot(allowed: number[]): Promise<void> {
    const cam = this.d.camera();
    const g = await cam.grab({ maxWidth: INPUT_SIZE });
    if (!g) {
      this.inFlight = false;
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
    if (!head || !this.worker || !this.running) {
      g.bitmap.close();
      this.inFlight = false;
      return;
    }
    const k = g.intrinsics ? scaleIntrinsics(g.intrinsics, g.width, g.height) : questIntrinsics(g.width, g.height);
    const id = this.nextFrameId++;
    this.pending.set(id, { id, t0: performance.now(), cam: cameraPoseFromHead(head, cam.eye), k, handJoints: this.d.handJoints().map((v) => v.clone()) });
    const msg: WorkerIn = { type: 'frame', id, bitmap: g.bitmap, allowed, scoreThreshold: this.scoreThreshold };
    this.worker.postMessage(msg, [g.bitmap]);
    this.stats.frames++;
  }

  private release(id: number): PendingFrame | undefined {
    const p = this.pending.get(id);
    this.pending.delete(id);
    this.inFlight = false;
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
    this.results.push(now);
    while (this.results.length && now - this.results[0]! > 1000) this.results.shift();
    s.fps = this.results.length;
    if (!this.running) return;
    this.apply(m.dets, fr, now);
  }

  /** Tracker update + 3D placement + SAM handover + HUD calls for one detector result. Public for tests. */
  apply(dets: WorkerDet[], fr: Pick<PendingFrame, 'cam' | 'k' | 'handJoints'>, now: number): void {
    const allowed = allowedClasses(this.category);
    const kept = dets.filter((d) => allowed.has(d.cls) && !this.isHand(d, fr));
    this.lastFrame = { cam: fr.cam, k: fr.k };
    const upd = this.tracker.update(kept, now, (t) => this.predict(t, fr));
    // a picked box that drops out of view keeps its anchor: SAM may still find it there
    for (const t of upd.removed) this.hide(t.id, t.id !== this.picked);
    const sam = this.d.samTargets();
    let shown = 0;
    for (const t of upd.tracks) {
      if (!t.live || !allowed.has(t.cls)) continue;
      const a = this.place(t, fr, now);
      const claim = this.claimedBy(t.box, fr, sam);
      if (claim) {
        if (!a.claimedBy) this.stats.handedOver++;
        a.claimedBy = claim;
        this.hide(t.id);
        if (t.id === this.picked) {
          this.picked = undefined;
          this.d.onPickClaimed?.(claim);
          if (!this.running) return; // the shell locked it and stopped the scan
        }
        continue;
      }
      a.claimedBy = undefined;
      this.show(t, a);
      shown++;
    }
    this.stats.tracks = this.tracker.list().length;
    this.stats.shown = shown;
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
      const box = this.tracker.get(id)?.box ?? this.predict({ id } as Track, fr);
      if (!box) continue;
      const claim = this.claimedBy(box, fr, sam);
      if (!claim) continue;
      if (!a.claimedBy) this.stats.handedOver++;
      a.claimedBy = claim;
      this.hide(id);
      if (id === this.picked) pickedBy = claim;
    }
    if (pickedBy) {
      this.picked = undefined;
      this.d.onPickClaimed?.(pickedBy);
    }
    return pickedBy;
  }

  /** Never box a hand: most of a hand's joints inside a non-held device box means the box is the hand. */
  private isHand(d: WorkerDet, fr: Pick<PendingFrame, 'cam' | 'k' | 'handJoints'>): boolean {
    if (!fr.handJoints.length || HELD.test(deviceClass(d.cls)?.label ?? '')) return false;
    const [x, y, w, h] = d.box;
    let inside = 0;
    for (const j of fr.handJoints) {
      const px = worldToPixel(j, fr.k, fr.cam);
      if (px && px.u >= x + w * 0.1 && px.u <= x + w * 0.9 && px.v >= y + h * 0.1 && px.v <= y + h * 0.9) inside++;
    }
    return inside >= 12;
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
    const prior = Math.min(4.5, Math.max(0.3, (k.fx * (deviceClass(t.cls)?.sizeM ?? 0.3)) / Math.max(w, h, 1)));
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
      a = { position, sizeM, facing: ray.origin.clone().sub(position).normalize(), hitPending: false, lastHitAt: 0, shown: false };
      this.anchors.set(t.id, a);
    } else {
      // world-space smoothing on top of the image-space one; a big jump (new depth) snaps
      if (a.position.distanceTo(position) > 0.4) a.position.copy(position);
      else a.position.lerp(position, 0.5);
      a.sizeM = sizeM;
      a.facing.copy(ray.origin).sub(a.position).normalize();
    }
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
  private claimedBy(box: Box, fr: Pick<PendingFrame, 'cam' | 'k'>, sam: Target[]): string | undefined {
    for (const s of sam) {
      const px = worldToPixel(s.position, fr.k, fr.cam);
      if (!px) continue;
      const sw = (Math.max(0.03, s.sizeM[0]) * fr.k.fx) / px.depth;
      const sh = (Math.max(0.03, s.sizeM[1]) * fr.k.fy) / px.depth;
      const sbox: Box = [px.u - sw / 2, px.v - sh / 2, sw, sh];
      if (iou(sbox, box) >= 0.25 || containment(box, sbox) >= 0.6 || containment(sbox, box) >= 0.6) return s.id;
    }
    return undefined;
  }

  private show(t: Track, a: Anchor): void {
    const info = deviceClass(t.cls);
    const label = info?.label ?? 'Device';
    const score = Math.round(t.score * 100) / 100;
    const picked = t.id === this.picked;
    const s = a.sent;
    if (a.shown && s && s.picked === picked && s.label === label && Math.abs(s.score - score) < 0.05 && s.position.distanceTo(a.position) < 0.008 && Math.abs(s.sizeM[0] - a.sizeM[0]) < 0.08 * s.sizeM[0] + 0.004 && Math.abs(s.sizeM[1] - a.sizeM[1]) < 0.08 * s.sizeM[1] + 0.004) return;
    const v = (p: Vector3): [number, number, number] => [r3(p.x), r3(p.y), r3(p.z)];
    const ht: HudTarget = {
      id: hudId(t.id),
      label,
      subtitle: picked ? 'identifying…' : 'live',
      status: picked ? 'locked' : 'scanned',
      position: v(a.position),
      facing: v(a.facing),
      confirmed: Boolean(a.hit),
      sizeM: a.sizeM,
      score,
      modelId: LIVE_MODEL_ID,
      source: 'yolo',
    };
    this.d.hud().upsertTarget(ht);
    a.shown = true;
    a.sent = { position: a.position.clone(), sizeM: [...a.sizeM], label, score, picked };
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
    this.stats.state = 'error';
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
  }
}

export const hudId = (trackId: number) => `yolo_${trackId}`;
export const isLiveId = (id: string | null | undefined): id is string => Boolean(id?.startsWith('yolo_'));
function trackIdOf(id: string): number | undefined {
  const m = /^yolo_(\d+)$/.exec(id);
  return m ? Number(m[1]) : undefined;
}
const r3 = (n: number) => Math.round(n * 1000) / 1000;
