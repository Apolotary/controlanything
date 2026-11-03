/**
 * SCAN: every scan.frame gets the SAM 3.1 device prompts in parallel (device categories only, never people),
 * masks become <=64-point outlines, detections are deduplicated across prompts and matched to known targets,
 * and a pairing QR code in view approves the pending request on the sender's behalf. Results go back as
 * scan.result to the sender and the other HUD clients. Verify frames (senseId) feed the dispatcher instead.
 */
import type { ScanDetection, ScanFramePayload, ScanResultPayload, SeenQr } from '@ce/protocol';
import { type DecodedImage, decodeJpeg } from '../oracle/image';
import type { PairingManager } from '../pairing/manager';
import type { Hub } from '../hub';
import { iou, polygonFor } from '../scan/polygon';
import { findQr } from '../scan/qr';
import { decodeMask, type Sam, type SamRecord } from '../scan/sam';
import type { Dispatcher } from './dispatch';
import type { StepLog } from './steps';
import type { TargetStore } from './targets';
import type { TargetDetection } from './types';

export const DEFAULT_SCAN_PROMPTS = ['electronic device', 'ceiling light', 'synthesizer', 'book'];
export const MIN_SCORE = 0.55;
/** labels that must never be reported (the prompts never ask for them; this is the belt to those braces) */
const FORBIDDEN = /person|people|face|hand|body|man|woman|child|human/i;

export function scanPrompts(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.CE_SCAN_PROMPTS?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
  const list = raw.length ? raw : DEFAULT_SCAN_PROMPTS;
  return list.filter((p) => !FORBIDDEN.test(p));
}

export interface StoredFrame {
  frame: ScanFramePayload;
  deviceId: string;
  detections: ScanDetection[];
  /** decoded lazily */
  image?: DecodedImage;
  masks: Map<string, { data: Uint8Array; width: number; height: number; x0: number; y0: number } | null>;
}

export interface ScanDeps {
  sam: Sam;
  hub: Pick<Hub, 'broadcast'>;
  pairing: Pick<PairingManager, 'approve' | 'listPending'>;
  targets: TargetStore;
  steps: StepLog;
  dispatcher: Dispatcher;
  log?: (line: string) => void;
  prompts?: string[];
  maxInFlight?: number;
  /** Pairing and verification still work while discovery is paused. */
  enabled?: () => boolean;
}

export interface FrameSender {
  deviceId: string;
  canApprove: boolean;
  local?: boolean;
}

/** Specific prompts win over the catch-all when their boxes overlap. */
function specificity(prompt: string): number {
  return prompt === 'electronic device' || prompt === 'electronics' ? 0 : 1;
}

/** Screen overlap is meaningful only across nearby captures in the same camera pose. */
function continuous(previous: ScanFramePayload, current: ScanFramePayload): boolean {
  const age = current.capturedAt - previous.capturedAt;
  if (age <= 0 || age > 2_000 || previous.space !== current.space || previous.width !== current.width || previous.height !== current.height) return false;
  const a = previous.camera?.cameraPose ?? previous.pose;
  const b = current.camera?.cameraPose ?? current.pose;
  if (!a || !b) return false;
  const distance = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y, a.position.z - b.position.z);
  const dot = Math.abs(a.orientation.x * b.orientation.x + a.orientation.y * b.orientation.y + a.orientation.z * b.orientation.z + a.orientation.w * b.orientation.w);
  return distance < 0.25 && dot > Math.cos(15 * Math.PI / 360);
}

export class ScanService {
  private readonly inFlight = new Map<string, number>();
  private readonly frames = new Map<string, StoredFrame>();
  private readonly lastBySender = new Map<string, StoredFrame>();
  private readonly log: (line: string) => void;
  readonly prompts: string[];
  /** frames handled / dropped (stats) */
  handled = 0;
  dropped = 0;

  constructor(private readonly d: ScanDeps) {
    this.log = d.log ?? (() => {});
    this.prompts = d.prompts ?? scanPrompts();
  }

  frame(frameId: string): StoredFrame | undefined {
    return this.frames.get(frameId);
  }

  /** The detection the user picked, with the frame bytes, or undefined. */
  detection(frameId: string, detId: string): TargetDetection | undefined {
    const f = this.frames.get(frameId);
    const det = f?.detections.find((x) => x.detId === detId);
    if (!f || !det) return undefined;
    return { frameId, detId, trackId: det.trackId, sensorDeviceId: f.deviceId, label: det.label, prompt: det.prompt, score: det.score, box: det.box as [number, number, number, number], polygon: det.polygon, width: f.frame.width, height: f.frame.height, jpeg: f.frame.jpeg, capturedAt: f.frame.capturedAt };
  }

  /** The newest frame from a sender (for a select by deviceId without a frame). */
  latest(deviceId: string): StoredFrame | undefined {
    return this.lastBySender.get(deviceId);
  }

  /** A local detector may use its own id; use its label against the referenced frame. */
  tagDetection(frameId: string, detId: string | undefined, label: string): TargetDetection | undefined {
    const f = this.frames.get(frameId);
    if (!f || FORBIDDEN.test(label)) return undefined;
    const byLabel = f.detections.filter((d) => d.label.toLowerCase() === label.toLowerCase());
    const det = (detId ? f.detections.find((d) => d.detId === detId || d.trackId === detId || d.cardId === detId) : undefined)
      ?? (byLabel.length === 1 ? byLabel[0] : undefined);
    if (det) return this.detection(frameId, det.detId);
    return { frameId, detId: detId ?? frameId, sensorDeviceId: f.deviceId, label, prompt: label, score: 1,
      box: [0, 0, f.frame.width, f.frame.height], width: f.frame.width, height: f.frame.height,
      jpeg: f.frame.jpeg, capturedAt: f.frame.capturedAt };
  }

  async onFrame(frame: ScanFramePayload, from: FrameSender): Promise<ScanResultPayload | undefined> {
    // an answer to sense.request {kind: 'frame'} that arrived as a bare scan.frame
    if (frame.senseId && this.d.dispatcher.onSense({ senseId: frame.senseId, kind: 'frame', frame, at: frame.capturedAt })) return undefined;
    if (frame.purpose === 'verify' && !frame.senseId) return undefined;
    if (frame.purpose !== 'pair' && this.d.enabled?.() === false) return undefined;
    const busy = this.inFlight.get(from.deviceId) ?? 0;
    if (busy >= (this.d.maxInFlight ?? 2)) {
      this.dropped++;
      return undefined;
    }
    this.inFlight.set(from.deviceId, busy + 1);
    const started = Date.now();
    try {
      const stored: StoredFrame = { frame, deviceId: from.deviceId, detections: [], masks: new Map() };
      // The on-device detector can tag this frame while SAM is still working.
      this.rememberFrame(stored);
      const qr = this.lookForQr(stored, from);
      let result: ScanResultPayload;
      if (frame.purpose === 'pair') {
        result = { frameId: frame.frameId, width: frame.width, height: frame.height, detections: [], modelId: 'none', source: this.d.sam.mode, latencyMs: Date.now() - started, prompts: [] };
      } else if (frame.fixtureDetections && this.d.sam.mode === 'fixture' && frame.camera?.source === 'synthetic' && (from.canApprove || from.local)) {
        const detections: ScanDetection[] = frame.fixtureDetections
          .filter((d) => !FORBIDDEN.test(d.label) && !FORBIDDEN.test(d.prompt) && d.score >= MIN_SCORE)
          .filter((d) => d.box.every(Number.isFinite) && d.box[0] >= 0 && d.box[1] >= 0 && d.box[2] > 0 && d.box[3] > 0 && d.box[0] + d.box[2] <= frame.width && d.box[1] + d.box[3] <= frame.height)
          .map(({ detId, label, prompt, score, box, polygon }) => ({ detId, label, prompt, score, box, polygon }));
        this.track(stored, detections, from.deviceId);
        this.matchTargets(stored, detections);
        stored.detections = detections;
        result = { frameId: frame.frameId, width: frame.width, height: frame.height, detections, modelId: 'fixture-layout', source: 'fixture', latencyMs: 0 };
      } else {
        const runs = await this.d.sam.segmentAll(this.prompts, frame.jpeg, { width: frame.width, height: frame.height, pose: frame.camera?.cameraPose ?? frame.pose, label: 'scan' });
        if (this.d.enabled?.() === false) return undefined;
        const latest = this.lastBySender.get(from.deviceId);
        if (latest && latest.frame.capturedAt >= frame.capturedAt) return undefined;
        const detections = this.toDetections(stored, runs.flatMap((r) => r.records.map((rec) => ({ rec, prompt: r.prompt }))));
        this.track(stored, detections, from.deviceId);
        this.matchTargets(stored, detections);
        stored.detections = detections;
        const model = runs.find((r) => r.records.length)?.recordedFrom ?? runs[0]?.recordedFrom ?? runs[0]?.model ?? this.d.sam.mode;
        result = { frameId: frame.frameId, width: frame.width, height: frame.height, detections, modelId: model, source: this.d.sam.mode, latencyMs: Date.now() - started, prompts: this.prompts };
        const errors = runs.filter((r) => r.error).map((r) => `${r.prompt}: ${r.error}`);
        if (errors.length) this.log(`[scan] ${errors.join('; ')}`);
      }
      if (qr.length) result.qr = qr;
      this.remember(stored);
      this.handled++;
      this.d.hub.broadcast('scan.result', result);
      return result;
    } catch (e) {
      this.log(`[scan] frame ${frame.frameId} failed: ${(e as Error).message}`);
      return undefined;
    } finally {
      this.inFlight.set(from.deviceId, (this.inFlight.get(from.deviceId) ?? 1) - 1);
    }
  }

  private image(s: StoredFrame): DecodedImage {
    if (!s.image) s.image = decodeJpeg(s.frame.jpeg);
    return s.image;
  }

  /** Decode a pairing QR when a request is pending (or the frame is a pair frame) and approve it for an approver. */
  private lookForQr(s: StoredFrame, from: FrameSender): SeenQr[] {
    if (s.frame.purpose !== 'pair' && !this.d.pairing.listPending().length) return [];
    const seen = findQr(this.image(s));
    if (!seen) return [];
    const out: SeenQr = { text: seen.text.slice(0, 512) };
    if (seen.box) out.box = seen.box;
    if (seen.pairingId) out.pairingId = seen.pairingId;
    if (seen.code && (from.canApprove || from.local)) {
      try {
        const r = this.d.pairing.approve({ code: seen.code, pairingId: seen.pairingId }, from.local && !from.canApprove ? { type: 'local' } : { type: 'device', deviceId: from.deviceId });
        out.approved = true;
        this.d.steps.note('scan', `paired ${r.device.name} by looking at its QR code`, { kind: 'proof', evidence: `${r.device.kind} · ${seen.code}` });
      } catch (e) {
        out.approved = false;
        this.log(`[scan] QR seen but not approved: ${(e as Error).message}`);
      }
    }
    return [out];
  }

  private toDetections(s: StoredFrame, found: { rec: SamRecord; prompt: string }[]): ScanDetection[] {
    const kept: { det: ScanDetection; spec: number }[] = [];
    const sorted = found
      .filter((f) => (f.rec.confidence ?? 1) >= MIN_SCORE && !FORBIDDEN.test(f.prompt) && !FORBIDDEN.test(f.rec.fixtureLabel ?? ''))
      .sort((a, b) => specificity(b.prompt) - specificity(a.prompt) || (b.rec.confidence ?? 0) - (a.rec.confidence ?? 0));
    let n = 0;
    for (const { rec, prompt } of sorted) {
      const box: [number, number, number, number] = [rec.x1, rec.y1, Math.max(1, rec.x2 - rec.x1 + 1), Math.max(1, rec.y2 - rec.y1 + 1)];
      const dup = kept.find((k) => iou(k.det.box as [number, number, number, number], box) > 0.5);
      if (dup) continue;
      const detId = `${s.frame.frameId}:${n++}`;
      const raster = decodeMask(rec);
      const mask = raster && rec.mask ? { data: raster, width: rec.mask.width, height: rec.mask.height, x0: rec.x1, y0: rec.y1 } : null;
      s.masks.set(detId, mask);
      const label = this.d.sam.mode === 'fixture' ? rec.fixtureLabel ?? prompt : prompt;
      const det: ScanDetection = { detId, label, prompt: label, score: Math.round((rec.confidence ?? 1) * 1000) / 1000, box, polygon: rec.polygon ?? polygonFor(mask, box) };
      kept.push({ det, spec: specificity(prompt) });
    }
    return kept.map((k) => k.det).slice(0, 64);
  }

  /** Stable trackIds across consecutive frames from the same sender. */
  private track(s: StoredFrame, detections: ScanDetection[], deviceId: string): void {
    const prev = this.lastBySender.get(deviceId);
    const used = new Set<string>();
    for (const det of detections) {
      const match = prev && continuous(prev.frame, s.frame)
        ? prev.detections.find((p) => !used.has(p.detId) && p.label === det.label && iou(p.box as [number, number, number, number], det.box as [number, number, number, number]) > 0.3) : undefined;
      if (match) used.add(match.detId);
      det.trackId = match?.trackId ?? `t-${deviceId.slice(-4)}-${det.detId}`;
    }
  }

  /** Attach cardIds of known targets seen by the same sensor, and refresh their stored detection. */
  private matchTargets(s: StoredFrame, detections: ScanDetection[]): void {
    for (const t of this.d.targets.list()) {
      const td = t.detection;
      if (!td || td.sensorDeviceId !== s.deviceId) continue;
      const previous = this.frames.get(td.frameId);
      if (!previous || !continuous(previous.frame, s.frame) || !td.trackId) continue;
      let best: ScanDetection | undefined;
      let bestIou = 0.3;
      for (const det of detections) {
        if (det.cardId || det.label !== td.label || det.trackId !== td.trackId) continue;
        const o = iou(td.box, det.box as [number, number, number, number]);
        if (o > bestIou) {
          bestIou = o;
          best = det;
        }
      }
      if (!best) continue;
      best.cardId = t.cardId;
      t.detection = { ...td, frameId: s.frame.frameId, detId: best.detId, trackId: best.trackId, box: best.box as [number, number, number, number], polygon: best.polygon, width: s.frame.width, height: s.frame.height, jpeg: s.frame.jpeg, capturedAt: s.frame.capturedAt };
    }
  }

  private remember(s: StoredFrame): void {
    this.rememberFrame(s);
    this.lastBySender.set(s.deviceId, s);
  }

  private rememberFrame(s: StoredFrame): void {
    this.frames.set(s.frame.frameId, s);
    if (this.frames.size > 12) {
      const oldest = this.frames.keys().next().value;
      if (oldest !== undefined) this.frames.delete(oldest);
    }
  }
}
