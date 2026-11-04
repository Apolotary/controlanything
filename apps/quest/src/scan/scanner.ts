/**
 * SCAN mode (SAM 3.1 is the only detector): a frame as soon as Annotate starts, then whenever the head settles,
 * at least 1.2 s apart with one frame in flight (SAM 3.1 takes 1–3.5 s), each frame stamped with its capture pose
 * and carrying the annotation filter (the server picks the SAM text prompts from it). Results come back as
 * scan.result and are lifted to 3D with THAT frame's pose, guarded (no people, no hands, no walls), merged into
 * world-anchored targets and handed to the HUD.
 */
import { Emitter } from '../app/emitter';
import type { Vector3 } from 'three';
import type { Hud } from '../app/hud-contract';
import { type Det, normalizeDetections, type ScanResultPayload } from '../io/v1';
import type { WsClient } from '../io/ws';
import type { FrameCapture, FrameRecord } from './capture';
import { projectFixture, type SamFixture } from './fixture';
import { type DepthProvider, placeDetection, rejectReason } from './placement';
import type { PoseRing } from './poses';
import type { VirtualRoom } from './synthetic';
import { type Target, type TargetStore, toHudTarget } from './targets';
import { ANNOTATION_MAX_BOXES, ANNOTATION_MIN_SCORE, ANNOTATION_RANGE_M, inAnnotationRange, matchesAnnotationFilter } from './policy';
import { type Category, scanFilter } from './categories';
import { deduplicateDetections } from './detections';
import type { ScanRegion } from './region';

export interface ScannerDeps {
  /** a getter: replay swaps the camera (and with it the capture) at runtime */
  capture: () => FrameCapture;
  ws: WsClient;
  hud: () => Hud;
  targets: TargetStore;
  poses: PoseRing;
  depth: () => DepthProvider[];
  /** Current head position, for the nearby-object limit when a delayed result arrives. */
  headPosition?: () => Vector3;
  log: (msg: string, level?: 'info' | 'warn' | 'error') => void;
  /** local fixture detector (desktop emulator + test photo) */
  fixture?: () => { fix: SamFixture; room: VirtualRoom } | null;
  /** messages that never cross the socket (fixture mode), so the recorder still sees them */
  local?: (dir: 'in' | 'out', type: string, payload: unknown) => void;
}

export interface ScannerStats {
  sent: number;
  results: number;
  detections: number;
  rejected: number;
  lastLatencyMs: number;
  lastModelId: string;
  lastSource: string;
  inFlight: number;
}

export interface ScannerEvents extends Record<string, unknown> {
  frame: { frameId: string; jpeg: string; width: number; height: number };
  result: { frameId: string; placed: Target[]; rejected: { det: Det; reason: string }[]; dets: Det[] };
  state: { on: boolean };
}

export class Scanner extends Emitter<ScannerEvents> {
  active = false;
  purpose: 'scan' | 'pair' = 'scan';
  category: Category = 'everything';
  rangeM = ANNOTATION_RANGE_M;
  periodMs = 1200;
  maxInFlight = 1;
  /** frames taken while the head turns faster than this are blurry and badly stamped (research/04 §3) */
  maxSpeedDeg = 15;
  timeoutMs = 12_000;
  readonly stats: ScannerStats = { sent: 0, results: 0, detections: 0, rejected: 0, lastLatencyMs: 0, lastModelId: '', lastSource: '', inFlight: 0 };
  private readonly inFlight = new Map<string, number>();
  private readonly frameGenerations = new Map<string, number>();
  private lastSentAt = 0;
  private waitingSince = 0;
  private ticking = false;
  private startedAt = 0;
  private generation = 0;
  private latestCapture = -Infinity;
  private readonly fixtureFrames = new Set<string>();
  private region?: ScanRegion;
  private singleShot = false;

  constructor(private readonly d: ScannerDeps) {
    super();
  }

  start(purpose: 'scan' | 'pair' = 'scan'): void {
    if (this.active && this.purpose === purpose) return;
    this.active = true;
    this.region = undefined;
    this.singleShot = false;
    this.generation++;
    this.latestCapture = -Infinity;
    this.purpose = purpose;
    this.startedAt = Date.now();
    this.lastSentAt = -Infinity;
    this.d.hud().setScanning(true, { startedAt: this.startedAt, pending: this.inFlight.size, modelId: 'sam-3.1' });
    this.emit('state', { on: true });
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.generation++;
    this.inFlight.clear();
    this.stats.inFlight = 0;
    this.d.hud().setScanning(false);
    this.emit('state', { on: false });
  }

  toggle(): boolean {
    if (this.active) this.stop();
    else this.start();
    return this.active;
  }

  setCategory(category: Category): void {
    this.category = category;
  }

  /** Take the next frame as soon as nothing is in flight (a new filter, or a fresh start). */
  scanSoon(): void {
    this.lastSentAt = -Infinity;
  }

  /** When the oldest in-flight frame was sent (performance.now()), or 0. */
  inFlightSince(): number {
    let oldest = 0;
    for (const at of this.inFlight.values()) if (!oldest || at < oldest) oldest = at;
    return oldest;
  }

  /** One deliberate cropped scan. No background whole-view scans resume afterward. */
  async scanRegion(region: ScanRegion, now: number): Promise<boolean> {
    this.stop(); this.start();
    const generation = this.generation;
    this.region = region; this.singleShot = true;
    this.ticking = true;
    try { await this.shoot(now); } finally { this.ticking = false; }
    if (generation !== this.generation) return false;
    if (!this.inFlight.size) { this.stop(); return false; }
    return true;
  }

  /** Call every frame (cheap when idle). */
  tick(now: number): void {
    for (const [id, at] of this.inFlight) {
      if (now - at > this.timeoutMs) {
        this.inFlight.delete(id);
        this.d.log(`scan frame ${id.slice(-6)} got no result in ${Math.round(this.timeoutMs / 1000)} s`, 'warn');
      }
    }
    if (!this.active || this.singleShot || this.ticking || this.d.capture().busy) return;
    if (this.inFlight.size >= this.maxInFlight || now - this.lastSentAt < this.periodMs) return;
    if (this.d.poses.peakSpeed(now, 150) > this.maxSpeedDeg) {
      if (!this.waitingSince) this.waitingSince = now;
      if (now - this.waitingSince < 1500) return; // hold still a moment; after 1.5 s take it anyway
    }
    this.waitingSince = 0;
    this.lastSentAt = now;
    this.ticking = true;
    void this.shoot(now).finally(() => {
      this.ticking = false;
    });
  }

  private async shoot(now: number): Promise<void> {
    const generation = this.generation;
    const r = await this.d.capture().capture(this.purpose, undefined, this.region);
    if (!r || !this.active || generation !== this.generation) return;
    this.frameGenerations.set(r.payload.frameId, generation);
    if (this.frameGenerations.size > 64) this.frameGenerations.delete(this.frameGenerations.keys().next().value!);
    this.emit('frame', { frameId: r.payload.frameId, jpeg: r.payload.jpeg, width: r.payload.width, height: r.payload.height });
    const fx = this.d.fixture?.();
    if (fx) {
      // desktop fixture: recorded SAM boxes re-projected into this synthetic frame, delivered after a real-ish delay
      // Register the exact fixture IDs and crops before exposing selectable outlines.
      const dets = projectFixture(fx.fix, fx.room, r.record);
      const frame = { ...r.payload, filter: scanFilter(this.category), fixtureDetections: dets.map((d) => ({ detId: d.detId, label: d.label, prompt: d.prompt ?? d.label, score: d.score, box: d.box })) };
      if (!this.d.ws.send('scan.frame', frame, { to: 'server', droppable: true })) return;
      this.fixtureFrames.add(r.payload.frameId);
      if (this.fixtureFrames.size > 64) this.fixtureFrames.delete(this.fixtureFrames.values().next().value!);
      this.inFlight.set(r.payload.frameId, now);
      this.stats.sent++;
      const latency = Math.min(fx.fix.wallMs, 1800);
      this.d.local?.('out', 'scan.frame', frame);
      setTimeout(() => {
        const result: ScanResultPayload = {
          frameId: r.payload.frameId,
          width: r.payload.width,
          height: r.payload.height,
          detections: dets.map((d) => ({ detId: d.detId, label: d.label, prompt: d.prompt ?? d.label, score: d.score, box: d.box })),
          modelId: fx.fix.modelId,
          source: 'fixture',
          latencyMs: latency,
        };
        this.d.local?.('in', 'scan.result', result);
        void this.onResult(result, true);
      }, latency);
    } else {
      const id = this.d.ws.send('scan.frame', this.purpose === 'scan' ? { ...r.payload, filter: scanFilter(this.category) } : r.payload, { to: 'server', droppable: true });
      if (!id) {
        this.d.log('scan frame not sent: not connected', 'warn');
        return;
      }
      this.inFlight.set(r.payload.frameId, now);
      this.stats.sent++;
    }
    this.stats.inFlight = this.inFlight.size;
    if (this.active) this.d.hud().setScanning(true, { startedAt: this.startedAt, pending: this.inFlight.size, modelId: 'sam-3.1' });
  }

  /** Handle a scan.result (ours, by frameId; results for other senders' frames are ignored). */
  async onResult(p: ScanResultPayload, localFixture = false): Promise<void> {
    if (this.fixtureFrames.has(p.frameId) && !localFixture) return;
    const rec = this.d.capture().get(p.frameId);
    this.inFlight.delete(p.frameId);
    this.stats.inFlight = this.inFlight.size;
    if (!rec || !this.active || this.purpose !== 'scan') return;
    const capturedGeneration = this.frameGenerations.get(p.frameId);
    if (capturedGeneration !== undefined && capturedGeneration !== this.generation) return;
    if (rec.tCapture < this.latestCapture) return;
    this.latestCapture = rec.tCapture;
    const generation = this.generation;
    this.stats.results++;
    this.stats.lastLatencyMs = p.latencyMs;
    this.stats.lastModelId = p.modelId;
    this.stats.lastSource = p.source;
    const dets = normalizeDetections(p.detections, p.width || rec.width, p.height || rec.height);
    // detections are in pixels of the JPEG we sent; if the server reports another size, rescale
    if (p.width && p.width !== rec.width) {
      const s = rec.width / p.width;
      for (const d of dets) {
        d.box = [d.box[0] * s, d.box[1] * s, d.box[2] * s, d.box[3] * s];
        d.polygon = d.polygon?.map(([x, y]) => [x * s, y * s]);
      }
    }
    const placed: Target[] = [];
    const rejected: { det: Det; reason: string }[] = [];
    const eligible: Det[] = [];
    for (const det of dets) {
      const why = rejectReason(det, rec)
        ?? (det.score < ANNOTATION_MIN_SCORE ? 'low confidence' : null)
        ?? (!matchesAnnotationFilter(det.label, this.category) ? 'outside object filter' : null);
      if (why) {
        rejected.push({ det, reason: why });
        continue;
      }
      eligible.push(det);
    }
    const { kept, suppressed } = deduplicateDetections(eligible);
    for (const det of suppressed) rejected.push({ det, reason: 'overlaps a more specific or repeated detection' });
    for (const det of kept) {
      const pl = await placeDetection(det, rec, this.d.depth());
      if (!this.active || generation !== this.generation || rec.tCapture < this.latestCapture) return;
      if (!matchesAnnotationFilter(det.label, this.category)) continue;
      if (!inAnnotationRange(pl.position, this.d.headPosition?.() ?? rec.head.position, this.rangeM)) {
        rejected.push({ det, reason: 'outside nearby range' });
        continue;
      }
      if (placed.length >= ANNOTATION_MAX_BOXES) {
        rejected.push({ det, reason: 'annotation limit' });
        continue;
      }
      const { target } = this.d.targets.upsert(det, pl, rec.frameId, p.modelId);
      placed.push(target);
      this.d.hud().upsertTarget(toHudTarget(target));
    }
    this.stats.detections += placed.length;
    this.stats.rejected += rejected.length;
    if (this.active) this.d.hud().setScanning(true, { startedAt: this.startedAt, pending: this.inFlight.size, modelId: p.modelId });
    this.emit('result', { frameId: p.frameId, placed, rejected, dets });
    if (this.singleShot) this.stop();
  }

  frameRecord(frameId: string): FrameRecord | undefined {
    return this.d.capture().get(frameId);
  }
}
