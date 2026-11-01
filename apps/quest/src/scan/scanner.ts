/**
 * SCAN mode: one frame per second at most (SAM 3.1 takes 1–3.5 s per frame, so at most two batches are in
 * flight), only while the head is fairly still, each frame stamped with its capture pose. Results come back as
 * scan.result and are lifted to 3D with THAT frame's pose, guarded (no people, no hands, no walls), merged into
 * world-anchored targets and handed to the HUD.
 */
import { Emitter } from '../app/emitter';
import type { Hud } from '../app/hud-contract';
import { type Det, normalizeDetections, type ScanResultPayload } from '../io/v1';
import type { WsClient } from '../io/ws';
import type { FrameCapture, FrameRecord } from './capture';
import { projectFixture, type SamFixture } from './fixture';
import { type DepthProvider, placeDetection, rejectReason } from './placement';
import type { PoseRing } from './poses';
import type { VirtualRoom } from './synthetic';
import { type Target, type TargetStore, toHudTarget } from './targets';

export interface ScannerDeps {
  /** a getter: replay swaps the camera (and with it the capture) at runtime */
  capture: () => FrameCapture;
  ws: WsClient;
  hud: () => Hud;
  targets: TargetStore;
  poses: PoseRing;
  depth: () => DepthProvider[];
  log: (msg: string, level?: 'info' | 'warn' | 'error') => void;
  /** local fixture detector (desktop emulator + test photo) */
  fixture?: () => { fix: SamFixture; room: VirtualRoom } | null;
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
  periodMs = 1000;
  maxInFlight = 2;
  /** frames taken while the head turns faster than this are blurry and badly stamped (research/04 §3) */
  maxSpeedDeg = 15;
  timeoutMs = 12_000;
  readonly stats: ScannerStats = { sent: 0, results: 0, detections: 0, rejected: 0, lastLatencyMs: 0, lastModelId: '', lastSource: '', inFlight: 0 };
  private readonly inFlight = new Map<string, number>();
  private lastSentAt = 0;
  private waitingSince = 0;
  private ticking = false;
  private startedAt = 0;

  constructor(private readonly d: ScannerDeps) {
    super();
  }

  start(purpose: 'scan' | 'pair' = 'scan'): void {
    if (this.active && this.purpose === purpose) return;
    this.active = true;
    this.purpose = purpose;
    this.startedAt = Date.now();
    this.lastSentAt = 0;
    this.d.hud().setScanning(true, { startedAt: this.startedAt, pending: this.inFlight.size, modelId: 'sam-3.1' });
    this.emit('state', { on: true });
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.d.hud().setScanning(false);
    this.emit('state', { on: false });
  }

  toggle(): boolean {
    if (this.active) this.stop();
    else this.start();
    return this.active;
  }

  /** Call every frame (cheap when idle). */
  tick(now: number): void {
    for (const [id, at] of this.inFlight) {
      if (now - at > this.timeoutMs) {
        this.inFlight.delete(id);
        this.d.log(`scan frame ${id.slice(-6)} got no result in ${Math.round(this.timeoutMs / 1000)} s`, 'warn');
      }
    }
    if (!this.active || this.ticking || this.d.capture().busy) return;
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
    const r = await this.d.capture().capture(this.purpose);
    if (!r) return;
    this.emit('frame', { frameId: r.payload.frameId, jpeg: r.payload.jpeg, width: r.payload.width, height: r.payload.height });
    const fx = this.d.fixture?.();
    if (fx) {
      // desktop fixture: recorded SAM boxes re-projected into this synthetic frame, delivered after a real-ish delay
      this.inFlight.set(r.payload.frameId, now);
      this.stats.sent++;
      const dets = projectFixture(fx.fix, fx.room, r.record);
      const latency = Math.min(fx.fix.wallMs, 1800);
      setTimeout(() => {
        void this.onResult({
          frameId: r.payload.frameId,
          width: r.payload.width,
          height: r.payload.height,
          detections: dets.map((d) => ({ detId: d.detId, label: d.label, prompt: d.prompt ?? d.label, score: d.score, box: d.box })),
          modelId: fx.fix.modelId,
          source: 'fixture',
          latencyMs: latency,
        });
      }, latency);
    } else {
      const id = this.d.ws.send('scan.frame', r.payload, { to: 'server', droppable: true });
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
  async onResult(p: ScanResultPayload): Promise<void> {
    const rec = this.d.capture().get(p.frameId);
    this.inFlight.delete(p.frameId);
    this.stats.inFlight = this.inFlight.size;
    if (!rec) return;
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
    for (const det of dets) {
      const why = rejectReason(det, rec);
      if (why) {
        rejected.push({ det, reason: why });
        continue;
      }
      const pl = await placeDetection(det, rec, this.d.depth());
      const { target } = this.d.targets.upsert(det, pl, rec.frameId, p.modelId);
      placed.push(target);
      this.d.hud().upsertTarget(toHudTarget(target));
    }
    this.stats.detections += placed.length;
    this.stats.rejected += rejected.length;
    if (this.active) this.d.hud().setScanning(true, { startedAt: this.startedAt, pending: this.inFlight.size, modelId: p.modelId });
    this.emit('result', { frameId: p.frameId, placed, rejected, dets });
  }

  frameRecord(frameId: string): FrameRecord | undefined {
    return this.d.capture().get(frameId);
  }
}
