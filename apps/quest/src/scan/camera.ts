/**
 * Camera sources. The real one is the Quest passthrough camera through getUserMedia (research/04 §2):
 *   - always ask for facingMode {exact: 'environment'}: plain {video: true} may return the avatar selfie camera;
 *   - Browser 150 may never show the HEADSET_CAMERA prompt, so only the avatar camera enumerates and the
 *     exact constraint fails with OverconstrainedError: run scripts/quest-grant-camera.sh, restart the browser;
 *   - ask before entering XR so no prompt interrupts the session; frames keep flowing inside immersive-ar.
 * Synthetic (desktop emulator) and replay sources implement the same interface.
 */
import type { CameraSourceKind, Intrinsics, Pose } from '../io/v1';
import { questIntrinsics, scaleIntrinsics } from './projection';

export interface GrabbedFrame {
  /** the caller owns it and must close() it */
  bitmap: ImageBitmap;
  width: number;
  height: number;
  /** best estimate of the exposure time, performance.now() timebase */
  tCapture: number;
  /** a source that knows its own pose (synthetic, replay) supplies it; otherwise the pose ring is used */
  headPose?: Pose;
  /** a source that knows its exact intrinsics supplies them */
  intrinsics?: Intrinsics;
}

/** Optional downscale at grab time (the live detector wants ~416 px, not the full 1280×960 frame). */
export interface GrabOptions {
  /** resize so the width is at most this (aspect kept); intrinsics are scaled to match */
  maxWidth?: number;
}

export interface CameraInfo {
  width: number;
  height: number;
  label: string;
  deviceId?: string;
  frameRate?: number;
  /** every video input after permission, for the spike report */
  devices?: { label: string; deviceId: string }[];
  warning?: string;
  /** MediaTrackCapabilities summary (exposure/white balance/focus modes), for the spike report */
  capabilities?: string;
  /** exposureMode 'manual' is available: verify frames can be taken at a fixed exposure */
  canLockExposure?: boolean;
}

export interface CameraStats {
  frames: number;
  /** frames per second over the last second */
  fps: number;
  lastFrameAt: number;
  /** requestVideoFrameCallback metadata carried captureTime */
  captureTime: boolean;
  /** new video frames seen by polling currentTime from the XR loop (when rVFC is throttled in a session) */
  polledFps?: number;
}

export interface CameraSource {
  readonly kind: CameraSourceKind;
  readonly eye: 'left' | 'right' | 'mono';
  info?: CameraInfo;
  readonly stats: CameraStats;
  /** live element for previews (the spike's camera plane) */
  readonly element?: HTMLVideoElement | HTMLCanvasElement;
  start(): Promise<CameraInfo>;
  stop(): void;
  /** the most recent frame, or null when none is available yet */
  grab(opts?: GrabOptions): Promise<GrabbedFrame | null>;
  /** The live track ended on its own (another tab or app took the camera): the app restarts it. */
  onEnded?: (reason: string) => void;
}

/** busy: another tab/app holds the camera (NotReadableError "Could not start video source"); retrying helps. */
export type CameraErrorCode = 'busy' | 'denied' | 'missing' | 'insecure';

export class CameraError extends Error {
  constructor(
    message: string,
    readonly hint: string,
    cause?: unknown,
    readonly code: CameraErrorCode = 'missing',
  ) {
    super(message, { cause });
  }
}

export const BUSY_HINT = 'Another Quest Browser tab or app is holding the passthrough camera. Close other tabs of this page; this tab keeps retrying.';

/** NotReadableError / AbortError / TrackStartError: the device exists but is in use. */
export function isCameraBusy(e: unknown): boolean {
  if (e instanceof CameraError) return e.code === 'busy';
  const name = (e as { name?: string } | null)?.name ?? '';
  const message = (e as { message?: string } | null)?.message ?? '';
  return name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError' || /could not start video source|device in use|in use by another/i.test(message);
}

export const GRANT_HINT =
  'Only the avatar camera is visible, or the browser never asked for the headset camera. On the Mac run scripts/quest-grant-camera.sh ' +
  '(adb shell pm grant com.oculus.browser horizonos.permission.HEADSET_CAMERA), then restart Quest Browser and reload.';

const AVATAR = /avatar|selfie|front|user|virtual/i;

interface FrameMeta {
  captureTime?: number;
  presentationTime: number;
  expectedDisplayTime: number;
  width: number;
  height: number;
  mediaTime: number;
}

/** Quest passthrough camera via getUserMedia. */
export class LiveCamera implements CameraSource {
  readonly kind = 'passthrough' as const;
  readonly eye: 'left' | 'right' | 'mono';
  info?: CameraInfo;
  readonly stats: CameraStats = { frames: 0, fps: 0, lastFrameAt: 0, captureTime: false };
  readonly element: HTMLVideoElement;
  /** used when the frame metadata has no captureTime; calibrate in spike S2 */
  latencyMs = 80;
  private stream?: MediaStream;
  private meta?: FrameMeta;
  private fpsWindow: number[] = [];
  private running = false;

  private readonly ideal: { width: number; height: number };
  onEnded?: (reason: string) => void;

  constructor(opts: { eye?: 'left' | 'right'; width?: number; height?: number } = {}) {
    this.eye = opts.eye ?? 'left';
    this.ideal = { width: opts.width ?? 1280, height: opts.height ?? 960 };
    this.element = document.createElement('video');
    this.element.muted = true;
    this.element.playsInline = true;
    this.element.autoplay = true;
  }

  async start(): Promise<CameraInfo> {
    if (this.running && this.info) return this.info;
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) {
      throw new CameraError('getUserMedia is unavailable', 'The page needs a secure context: open it via adb reverse on http://localhost or over https.', undefined, 'insecure');
    }
    const base: MediaTrackConstraints = { width: { ideal: this.ideal.width }, height: { ideal: this.ideal.height }, frameRate: { ideal: 30 } };
    let stream: MediaStream | undefined;
    let warning: string | undefined;
    try {
      stream = await md.getUserMedia({ video: { ...base, facingMode: { exact: 'environment' } }, audio: false });
    } catch (e) {
      const name = (e as DOMException)?.name ?? '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw new CameraError(`Camera permission denied (${name})`, 'Allow the camera for this page in Quest Browser, or run scripts/quest-grant-camera.sh.', e, 'denied');
      }
      if (isCameraBusy(e)) throw new CameraError(`Camera is busy (${name || 'Could not start video source'})`, BUSY_HINT, e, 'busy');
      // OverconstrainedError / NotFoundError: try any non-avatar camera by deviceId
      const devices = await this.listVideoInputs();
      const candidate = devices.find((d) => d.label && !AVATAR.test(d.label));
      if (candidate) {
        try {
          stream = await md.getUserMedia({ video: { ...base, deviceId: { exact: candidate.deviceId } }, audio: false });
        } catch (e2) {
          if (isCameraBusy(e2)) throw new CameraError(`Camera is busy (${(e2 as DOMException)?.name || 'Could not start video source'})`, BUSY_HINT, e2, 'busy');
          throw e2;
        }
        warning = `facingMode environment failed (${name}); using "${candidate.label}"`;
      } else {
        throw new CameraError(`No passthrough camera (${name || 'unknown error'})`, GRANT_HINT, e);
      }
    }
    let track = stream.getVideoTracks()[0];
    // a stream labelled like the avatar camera means the permission trap: report it loudly
    if (track && AVATAR.test(track.label)) {
      const devices = await this.listVideoInputs();
      const other = devices.find((d) => d.label && !AVATAR.test(d.label));
      if (other) {
        stream.getTracks().forEach((t) => t.stop());
        stream = await md.getUserMedia({ video: { ...base, deviceId: { exact: other.deviceId } }, audio: false });
        track = stream.getVideoTracks()[0];
      } else {
        warning = `Got "${track.label}", which looks like the avatar camera. ${GRANT_HINT}`;
      }
    }
    this.stream = stream;
    const live = stream;
    // Another tab or app taking the camera ends this track: report it once so the app can restart with backoff.
    track?.addEventListener('ended', () => {
      if (this.stream !== live || !this.running) return;
      this.running = false;
      this.onEnded?.('the camera track ended');
    }, { once: true });
    this.element.srcObject = stream;
    await this.element.play().catch(() => undefined);
    await this.waitForFirstFrame();
    const settings = track.getSettings();
    const caps = (track.getCapabilities?.() ?? {}) as Record<string, unknown>;
    const capSummary = ['exposureMode', 'exposureTime', 'whiteBalanceMode', 'focusMode', 'frameRate', 'width', 'height']
      .filter((k) => caps[k] !== undefined)
      .map((k) => `${k}=${JSON.stringify(caps[k])}`)
      .join(' ');
    this.info = {
      width: settings.width ?? this.element.videoWidth,
      height: settings.height ?? this.element.videoHeight,
      label: track.label,
      deviceId: settings.deviceId,
      frameRate: settings.frameRate,
      devices: await this.listVideoInputs(),
      warning,
      capabilities: capSummary || 'none reported',
      canLockExposure: Array.isArray(caps.exposureMode) && (caps.exposureMode as string[]).includes('manual'),
    };
    this.running = true;
    this.watchFrames();
    return this.info;
  }

  /**
   * Freeze auto-exposure for before/after verify frames (the camera oracle then compares absolute luma).
   * Returns true when the track accepted it; Quest Browser support is unknown until spike S2.
   */
  async setExposureLock(lock: boolean): Promise<boolean> {
    const track = this.stream?.getVideoTracks()[0];
    if (!track || !this.info?.canLockExposure) return false;
    try {
      await track.applyConstraints({ advanced: [{ exposureMode: lock ? 'manual' : 'continuous' } as MediaTrackConstraintSet] });
      return true;
    } catch {
      return false;
    }
  }

  stop(): void {
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    this.element.srcObject = null;
  }

  private lastCt = -1;
  private polled: number[] = [];

  /** Call from the XR frame loop: counts new video frames even when requestVideoFrameCallback is throttled. */
  pollFromXr(now: number): void {
    const ct = this.element.currentTime;
    if (ct === this.lastCt) return;
    this.lastCt = ct;
    this.polled.push(now);
    while (this.polled.length && now - this.polled[0] > 1000) this.polled.shift();
    this.stats.polledFps = this.polled.length;
  }

  async grab(opts: GrabOptions = {}): Promise<GrabbedFrame | null> {
    const v = this.element;
    if (!this.running || v.readyState < 2 || !v.videoWidth) return null;
    const resize = resizeFor(v.videoWidth, v.videoHeight, opts.maxWidth);
    const m = this.meta;
    const now = performance.now();
    // Chromium exposes captureTime for camera tracks; otherwise presentation time minus the measured latency.
    // Metadata older than 200 ms means rVFC stalled (e.g. throttled in XR): estimate from now instead.
    const fresh = m && now - this.stats.lastFrameAt < 200;
    const tCapture = fresh ? (m.captureTime ?? m.presentationTime - this.latencyMs) : now - this.latencyMs;
    const bitmap = resize ? await createImageBitmap(v, resize) : await createImageBitmap(v);
    const g: GrabbedFrame = { bitmap, width: bitmap.width, height: bitmap.height, tCapture };
    // a downscaled grab keeps the full-size camera model, scaled (not re-derived from the small size)
    if (resize) g.intrinsics = scaleIntrinsics(questIntrinsics(v.videoWidth, v.videoHeight), bitmap.width, bitmap.height);
    return g;
  }

  private async listVideoInputs(): Promise<{ label: string; deviceId: string }[]> {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      return all.filter((d) => d.kind === 'videoinput').map((d) => ({ label: d.label, deviceId: d.deviceId }));
    } catch {
      return [];
    }
  }

  private waitForFirstFrame(): Promise<void> {
    const v = this.element;
    if (v.readyState >= 2 && v.videoWidth) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => resolve();
      v.addEventListener('loadeddata', done, { once: true });
      setTimeout(done, 3000);
    });
  }

  private watchFrames(): void {
    const v = this.element as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, meta: FrameMeta) => void) => number;
    };
    const onFrame = (now: number, meta?: FrameMeta) => {
      if (!this.running) return;
      this.stats.frames++;
      this.stats.lastFrameAt = now;
      if (meta) {
        this.meta = meta;
        if (meta.captureTime !== undefined) this.stats.captureTime = true;
      }
      this.fpsWindow.push(now);
      while (this.fpsWindow.length && now - this.fpsWindow[0] > 1000) this.fpsWindow.shift();
      this.stats.fps = this.fpsWindow.length;
    };
    if (v.requestVideoFrameCallback) {
      const loop = (now: number, meta: FrameMeta) => {
        onFrame(now, meta);
        if (this.running) v.requestVideoFrameCallback!(loop);
      };
      v.requestVideoFrameCallback(loop);
    } else {
      // no rVFC: poll currentTime
      let last = -1;
      const poll = () => {
        if (!this.running) return;
        if (v.currentTime !== last) {
          last = v.currentTime;
          onFrame(performance.now());
        }
        setTimeout(poll, 15);
      };
      poll();
    }
  }
}

/** createImageBitmap resize options for a max width, or null when no resize is needed. */
export function resizeFor(width: number, height: number, maxWidth?: number): ImageBitmapOptions | null {
  if (!maxWidth || width <= maxWidth || !width || !height) return null;
  return { resizeWidth: Math.round(maxWidth), resizeHeight: Math.max(1, Math.round((height * maxWidth) / width)), resizeQuality: 'low' };
}
