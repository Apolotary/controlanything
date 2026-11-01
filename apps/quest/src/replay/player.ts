/**
 * Replays a take inside the Quest app (desktop emulator or headset):
 *   playback  recorded head poses drive the view, recorded server messages are re-dispatched at their times
 *             (no server needed), recorded frames are registered so scan.results place exactly as they did live;
 *   pipeline  recorded frames become the camera and recorded poses the head, against the LIVE server: the
 *             whole discovery loop (SAM, Spark, ...) re-runs on the recorded footage.
 * (The sim lane's player re-sends the 'out' messages headlessly; same take format.)
 */
import { Quaternion, Vector3 } from 'three';
import { Emitter } from '../app/emitter';
import type { Intrinsics, Pose, ScanFramePayload } from '../io/v1';
import type { Envelope } from '../io/ws';
import type { CameraInfo, CameraSource, CameraStats, GrabbedFrame } from '../scan/camera';
import type { FrameRecord } from '../scan/capture';
import { cameraPoseFromHead } from '../scan/projection';
import { frameBytes, type InputLine, isInput, isMsg, isPose, type MsgLine, type PoseLine, type Take } from './take';

export type ReplayMode = 'playback' | 'pipeline';

export interface PlayerEvents extends Record<string, unknown> {
  pose: PoseLine['head'];
  in: Envelope;
  out: Envelope;
  input: InputLine['input'];
  frame: { record: FrameRecord; file?: string };
  progress: { t: number; duration: number };
  end: { t: number };
}

/** FrameRecord for a recorded scan.frame payload (so a replayed scan.result lifts with the recorded pose). */
export function recordFromPayload(p: ScanFramePayload): FrameRecord | null {
  if (!p.pose) return null;
  const head = {
    position: new Vector3(p.pose.position.x, p.pose.position.y, p.pose.position.z),
    quaternion: new Quaternion(p.pose.orientation.x, p.pose.orientation.y, p.pose.orientation.z, p.pose.orientation.w),
  };
  const eye = p.camera?.eye ?? 'left';
  const cp = p.camera?.cameraPose;
  const cam = cp
    ? { position: new Vector3(cp.position.x, cp.position.y, cp.position.z), quaternion: new Quaternion(cp.orientation.x, cp.orientation.y, cp.orientation.z, cp.orientation.w) }
    : cameraPoseFromHead(head, eye);
  const k = p.camera?.intrinsics;
  const intrinsics: Intrinsics = k
    ? { fx: k.fx, fy: k.fy, cx: k.cx, cy: k.cy, width: p.width, height: p.height }
    : { fx: p.width * 0.678, fy: p.width * 0.678, cx: p.width / 2, cy: p.height / 2, width: p.width, height: p.height };
  return {
    frameId: p.frameId,
    purpose: p.purpose,
    source: 'replay',
    capturedAt: p.capturedAt,
    tCapture: performance.now(),
    width: p.width,
    height: p.height,
    intrinsics,
    head,
    cam,
    speedDeg: 0,
    handJoints: [],
    bytes: 0,
  };
}

export class TakePlayer extends Emitter<PlayerEvents> {
  private timers: ReturnType<typeof setTimeout>[] = [];
  private startedAt = 0;
  playing = false;
  speed = 1;
  readonly duration: number;

  constructor(
    readonly take: Take,
    readonly mode: ReplayMode,
    readonly baseUrl?: string,
  ) {
    super();
    this.duration = take.lines.length ? take.lines[take.lines.length - 1].t : 0;
  }

  /** ms into the take */
  clock(): number {
    return this.playing ? (performance.now() - this.startedAt) * this.speed : 0;
  }

  play(): void {
    this.stop();
    this.playing = true;
    this.startedAt = performance.now();
    for (const line of this.take.lines) {
      const due = line.t / this.speed;
      this.timers.push(setTimeout(() => this.fire(line as MsgLine | PoseLine | InputLine), due));
    }
    this.timers.push(setTimeout(() => this.finish(), this.duration / this.speed + 50));
    const tick = setInterval(() => {
      if (!this.playing) {
        clearInterval(tick);
        return;
      }
      this.emit('progress', { t: this.clock(), duration: this.duration });
    }, 500);
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.playing = false;
  }

  private finish(): void {
    this.playing = false;
    this.emit('end', { t: this.duration });
  }

  private fire(line: MsgLine | PoseLine | InputLine): void {
    if (isPose(line)) {
      this.emit('pose', line.head);
      return;
    }
    if (isInput(line)) {
      this.emit('input', line.input);
      return;
    }
    if (!isMsg(line)) return;
    if (line.dir === 'out') {
      const p = line.msg.payload as ScanFramePayload & { jpegFile?: string };
      const frame = line.msg.type === 'scan.frame' ? p : line.msg.type === 'sense.result' ? ((line.msg.payload as { frame?: ScanFramePayload & { jpegFile?: string } }).frame ?? null) : null;
      if (frame) {
        const record = recordFromPayload(frame);
        if (record) this.emit('frame', { record, file: frame.jpegFile });
      }
      this.emit('out', line.msg);
      return;
    }
    // 'in': only playback re-dispatches what the server said; pipeline gets live answers instead
    if (this.mode === 'playback') this.emit('in', line.msg);
  }
}

/** Recorded frames as a camera, following the player's clock (pipeline mode). */
export class ReplayCamera implements CameraSource {
  readonly kind = 'replay' as const;
  readonly eye = 'left' as const;
  info?: CameraInfo;
  readonly stats: CameraStats = { frames: 0, fps: 0, lastFrameAt: 0, captureTime: true };
  private readonly frames: { t: number; p: ScanFramePayload & { jpegFile?: string } }[] = [];

  constructor(
    private readonly player: TakePlayer,
    private readonly base?: string,
  ) {
    for (const l of player.take.lines) {
      if (isMsg(l) && l.dir === 'out' && l.msg.type === 'scan.frame') this.frames.push({ t: l.t, p: l.msg.payload as ScanFramePayload & { jpegFile?: string } });
    }
  }

  async start(): Promise<CameraInfo> {
    const first = this.frames[0]?.p;
    this.info = { width: first?.width ?? 1280, height: first?.height ?? 960, label: `replay · ${this.player.take.meta.take} · ${this.frames.length} frames` };
    return this.info;
  }

  stop(): void {}

  async grab(): Promise<GrabbedFrame | null> {
    const now = this.player.clock();
    let pick: (typeof this.frames)[number] | undefined;
    for (const f of this.frames) {
      if (f.t <= now) pick = f;
      else break;
    }
    if (!pick?.p.jpegFile) return null;
    const bytes = await frameBytes(this.player.take, pick.p.jpegFile, this.base);
    if (!bytes) return null;
    const bitmap = await createImageBitmap(new Blob([bytes as unknown as BlobPart], { type: 'image/jpeg' }));
    this.stats.frames++;
    const k = pick.p.camera?.intrinsics;
    const g: GrabbedFrame = { bitmap, width: bitmap.width, height: bitmap.height, tCapture: performance.now() };
    if (pick.p.pose) g.headPose = pick.p.pose as Pose;
    if (k) g.intrinsics = { ...k, width: pick.p.width, height: pick.p.height };
    return g;
  }
}
