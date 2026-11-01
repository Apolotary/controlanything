/**
 * Camera sources. The real one is the Quest passthrough camera through getUserMedia (research/04 §2):
 *   - always ask for facingMode {exact: 'environment'}: plain {video: true} may return the avatar selfie camera;
 *   - Browser 150 may never show the HEADSET_CAMERA prompt, so only the avatar camera enumerates and the
 *     exact constraint fails with OverconstrainedError: run scripts/quest-grant-camera.sh, restart the browser;
 *   - ask before entering XR so no prompt interrupts the session; frames keep flowing inside immersive-ar.
 * Synthetic (desktop emulator) and replay sources implement the same interface.
 */
import type { CameraSourceKind, Intrinsics, Pose } from '../io/v1';

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

export interface CameraInfo {
  width: number;
  height: number;
  label: string;
  deviceId?: string;
  frameRate?: number;
  /** every video input after permission, for the spike report */
  devices?: { label: string; deviceId: string }[];
  warning?: string;
}

export interface CameraStats {
  frames: number;
  /** frames per second over the last second */
  fps: number;
  lastFrameAt: number;
  /** requestVideoFrameCallback metadata carried captureTime */
  captureTime: boolean;
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
  grab(): Promise<GrabbedFrame | null>;
}

export class CameraError extends Error {
  constructor(
    message: string,
    readonly hint: string,
    cause?: unknown,
  ) {
    super(message, { cause });
  }
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
      throw new CameraError('getUserMedia is unavailable', 'The page needs a secure context: open it via adb reverse on http://localhost or over https.');
    }
    const base: MediaTrackConstraints = { width: { ideal: this.ideal.width }, height: { ideal: this.ideal.height }, frameRate: { ideal: 30 } };
    let stream: MediaStream | undefined;
    let warning: string | undefined;
    try {
      stream = await md.getUserMedia({ video: { ...base, facingMode: { exact: 'environment' } }, audio: false });
    } catch (e) {
      const name = (e as DOMException)?.name ?? '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw new CameraError(`Camera permission denied (${name})`, 'Allow the camera for this page in Quest Browser, or run scripts/quest-grant-camera.sh.', e);
      }
      // OverconstrainedError / NotFoundError: try any non-avatar camera by deviceId
      const devices = await this.listVideoInputs();
      const candidate = devices.find((d) => d.label && !AVATAR.test(d.label));
      if (candidate) {
        stream = await md.getUserMedia({ video: { ...base, deviceId: { exact: candidate.deviceId } }, audio: false });
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
    this.element.srcObject = stream;
    await this.element.play().catch(() => undefined);
    await this.waitForFirstFrame();
    const settings = track.getSettings();
    this.info = {
      width: settings.width ?? this.element.videoWidth,
      height: settings.height ?? this.element.videoHeight,
      label: track.label,
      deviceId: settings.deviceId,
      frameRate: settings.frameRate,
      devices: await this.listVideoInputs(),
      warning,
    };
    this.running = true;
    this.watchFrames();
    return this.info;
  }

  stop(): void {
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    this.element.srcObject = null;
  }

  async grab(): Promise<GrabbedFrame | null> {
    const v = this.element;
    if (!this.running || v.readyState < 2 || !v.videoWidth) return null;
    const bitmap = await createImageBitmap(v);
    const m = this.meta;
    const now = performance.now();
    // Chromium exposes captureTime for camera tracks; otherwise presentation time minus the measured latency
    const tCapture = m?.captureTime ?? (m ? m.presentationTime - this.latencyMs : now - this.latencyMs);
    return { bitmap, width: bitmap.width, height: bitmap.height, tCapture };
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
