/**
 * One camera frame → a `scan.frame` payload carrying the head pose and camera parameters AT CAPTURE TIME,
 * plus a local record (frameId → poses, intrinsics, hand joints) so a scan.result that arrives 1–3.5 s
 * later is lifted to 3D with the pose the frame was taken at, not the current one.
 */
import { newId } from '@ce/protocol';
import { Quaternion, Vector3 } from 'three';
import type { CameraSourceKind, FramePurpose, Intrinsics, Pose, ScanFramePayload } from '../io/v1';
import type { CameraSource } from './camera';
import type { JpegEncoder } from './encode';
import type { PoseRing } from './poses';
import { cameraPoseFromHead, fovYDeg, type PoseLike, questIntrinsics, scaleIntrinsics } from './projection';
import { regionCrop, type ScanRegion } from './region';

export interface FrameRecord {
  frameId: string;
  purpose: FramePurpose;
  source: CameraSourceKind;
  /** epoch ms */
  capturedAt: number;
  /** performance.now() ms */
  tCapture: number;
  /** encoded JPEG size, and intrinsics for that size */
  width: number;
  height: number;
  intrinsics: Intrinsics;
  head: PoseLike;
  cam: PoseLike;
  /** head angular speed at capture, deg/s */
  speedDeg: number;
  /** world positions of tracked hand joints at capture (for the "never tag a hand" guard) */
  handJoints: Vector3[];
  bytes: number;
  /** Explicit selected area in the original camera image, when this is a cropped scan. */
  region?: ScanRegion;
}

export interface CaptureResult {
  payload: ScanFramePayload;
  record: FrameRecord;
}

export interface CaptureDeps {
  camera: CameraSource;
  poses: PoseRing;
  encoder: JpegEncoder;
  /** world positions of tracked hand joints right now */
  handJoints: () => Vector3[];
}

const toPose = (p: PoseLike): Pose => ({
  position: { x: p.position.x, y: p.position.y, z: p.position.z },
  orientation: { x: p.quaternion.x, y: p.quaternion.y, z: p.quaternion.z, w: p.quaternion.w },
});

export class FrameCapture {
  private readonly records = new Map<string, FrameRecord>();
  busy = false;
  captured = 0;

  constructor(
    private readonly d: CaptureDeps,
    private readonly opts: { maxWidth?: number; quality?: number; keep?: number } = {},
  ) {}

  get(frameId: string): FrameRecord | undefined {
    return this.records.get(frameId);
  }

  /** the most recent record */
  get last(): FrameRecord | undefined {
    let r: FrameRecord | undefined;
    for (const v of this.records.values()) r = v;
    return r;
  }

  /** Remember a record made elsewhere (replay). */
  remember(rec: FrameRecord): void {
    this.records.set(rec.frameId, rec);
    this.trim();
  }

  /** Grab + stamp + encode. Returns null when the camera has no frame or a capture is already running. */
  async capture(purpose: FramePurpose, senseId?: string, region?: ScanRegion): Promise<CaptureResult | null> {
    if (this.busy) return null;
    this.busy = true;
    try {
      const g = await this.d.camera.grab();
      if (!g) return null;
      // head pose at exposure: from the source (synthetic/replay) or the ring
      let head: PoseLike;
      let speedDeg = 0;
      if (g.headPose) {
        head = {
          position: new Vector3(g.headPose.position.x, g.headPose.position.y, g.headPose.position.z),
          quaternion: new Quaternion(g.headPose.orientation.x, g.headPose.orientation.y, g.headPose.orientation.z, g.headPose.orientation.w),
        };
        speedDeg = this.d.poses.latest()?.speedDeg ?? 0;
      } else {
        const p = this.d.poses.lookup(g.tCapture);
        if (!p) {
          g.bitmap.close();
          return null; // no pose yet (not in XR and no desktop camera): nothing meaningful to send
        }
        head = { position: p.position, quaternion: p.quaternion };
        speedDeg = p.speedDeg;
      }
      const cam = cameraPoseFromHead(head, this.d.camera.eye);
      let sourceK = g.intrinsics ?? questIntrinsics(g.width, g.height);
      const handJoints = this.d.handJoints().map((v) => v.clone());
      let bitmap = g.bitmap;
      if (region) {
        try {
          const crop = regionCrop(sourceK, region);
          bitmap = await createImageBitmap(g.bitmap, crop.x, crop.y, crop.width, crop.height);
          sourceK = crop.intrinsics;
        } finally { g.bitmap.close(); }
      }
      const enc = await this.d.encoder.encode(bitmap, { maxWidth: this.opts.maxWidth ?? 1280, quality: this.opts.quality ?? 0.8 });
      const k = scaleIntrinsics(sourceK, enc.width, enc.height);
      const frameId = newId('f');
      const capturedAt = Date.now() - (performance.now() - g.tCapture);
      const record: FrameRecord = {
        frameId,
        purpose,
        source: this.d.camera.kind,
        capturedAt,
        tCapture: g.tCapture,
        width: enc.width,
        height: enc.height,
        intrinsics: k,
        head,
        cam,
        speedDeg,
        handJoints,
        bytes: enc.bytes,
        ...(region ? { region } : {}),
      };
      const payload: ScanFramePayload = {
        frameId,
        jpeg: enc.base64,
        width: enc.width,
        height: enc.height,
        capturedAt,
        space: 'local-floor',
        pose: toPose(head),
        camera: {
          intrinsics: k,
          width: enc.width,
          height: enc.height,
          fovY: Math.round(fovYDeg(k) * 100) / 100,
          eye: this.d.camera.eye,
          source: this.d.camera.kind,
          cameraPose: toPose(cam),
        },
        purpose,
      };
      if (senseId) payload.senseId = senseId;
      this.records.set(frameId, record);
      this.trim();
      this.captured++;
      return { payload, record };
    } finally {
      this.busy = false;
    }
  }

  private trim(): void {
    const keep = this.opts.keep ?? 48;
    while (this.records.size > keep) {
      const first = this.records.keys().next().value as string;
      this.records.delete(first);
    }
  }
}
