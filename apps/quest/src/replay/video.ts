/** Video-only recording of an already permitted camera stream. Never owns/stops the shared tracks. */
import type { RecordedVideo } from './take';

export const VIDEO_BYTE_LIMIT = 16 * 1024 * 1024;
export interface RecordedVideoFile { metadata: RecordedVideo; bytes: Uint8Array }

export class TakeVideoRecorder {
  private recorder?: MediaRecorder;
  private chunks: Blob[] = [];
  private bytes = 0;
  private startedAt = 0;
  private stoppedAt?: number;
  private acceptedUntil?: number;
  private truncated = false;
  private finish?: Promise<RecordedVideoFile | null>;
  private resolve?: (result: RecordedVideoFile | null) => void;
  private metadata?: RecordedVideo;
  private warning?: (message: string) => void;
  private ended?: () => void;
  private tracks: MediaStreamTrack[] = [];
  private stopTimer?: ReturnType<typeof setTimeout>;
  private readonly onTrackEnded = () => {
    this.warning?.('Camera stream ended; video recording stopped.');
    this.ended?.();
    void this.stop();
  };

  /** Returns a useful reason when only telemetry can be captured. */
  start(element: HTMLVideoElement | HTMLCanvasElement | undefined, offsetMs: number, warning: (message: string) => void, ended: () => void): string | null {
    const callAt = performance.now();
    if (this.recorder) return 'A video recording is already active.';
    this.finish = undefined; this.resolve = undefined; this.metadata = undefined;
    this.warning = warning; this.ended = ended;
    if (typeof MediaRecorder === 'undefined' || typeof MediaStream === 'undefined') return 'Video recording is unavailable in this browser; recording tracking data only.';
    const source = element && 'srcObject' in element ? element.srcObject : null;
    if (!(source instanceof MediaStream)) return 'No live passthrough camera stream; recording tracking data only.';
    const tracks = source.getVideoTracks().filter((track) => track.readyState === 'live');
    if (!tracks.length) return 'The camera is not streaming; recording tracking data only.';
    const mimeType = ['video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) return 'This browser has no supported video recorder; recording tracking data only.';
    try {
      const settings = tracks[0].getSettings();
      const width = settings.width || (element && 'videoWidth' in element ? element.videoWidth : 0);
      const height = settings.height || (element && 'videoHeight' in element ? element.videoHeight : 0);
      if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) return 'Camera video dimensions are not ready; recording tracking data only.';
      // New stream, same VIDEO tracks. Exclude microphone tracks even if the caller's stream has them.
      const recorder = new MediaRecorder(new MediaStream(tracks), { mimeType, videoBitsPerSecond: 1_500_000 });
      this.recorder = recorder;
      this.chunks = []; this.bytes = 0; this.stoppedAt = undefined; this.acceptedUntil = undefined; this.truncated = false;
      this.warning = warning; this.ended = ended; this.tracks = tracks;
      this.metadata = {
        file: mimeType.startsWith('video/mp4') ? 'video.mp4' : 'video.webm', mimeType,
        width, height,
        startOffsetMs: offsetMs, durationMs: 0, clock: 'performance', alignment: 'approximate', cameraExtrinsics: 'uncalibrated',
      };
      this.finish = new Promise((resolve) => { this.resolve = resolve; });
      recorder.ondataavailable = (event) => {
        if (!event.data.size) return;
        if (this.bytes + event.data.size > VIDEO_BYTE_LIMIT) {
          this.truncated = true;
          this.warning?.('Video reached its 16 MB limit; the final oversized chunk was omitted.');
          this.ended?.(); void this.stop(); return;
        }
        this.chunks.push(event.data); this.bytes += event.data.size; this.acceptedUntil = performance.now();
      };
      recorder.onerror = () => {
        this.warning?.('The browser video recorder failed; available tracking data is preserved.');
        this.ended?.(); void this.stop();
      };
      recorder.onstop = () => { void this.complete(); };
      this.startedAt = performance.now();
      this.metadata.startOffsetMs += this.startedAt - callAt;
      recorder.start(1000);
      tracks.forEach((track) => track.addEventListener('ended', this.onTrackEnded));
      return null;
    } catch (error) {
      this.failedStart();
      return `Video could not start: ${(error as Error).message}. Recording tracking data only.`;
    }
  }

  async stop(): Promise<RecordedVideoFile | null> {
    const result = this.finish;
    if (!result) return null;
    this.stoppedAt ??= performance.now();
    // Set the watchdog before stop(): a synchronous test implementation may deliver onstop immediately.
    if (this.resolve) this.stopTimer ??= setTimeout(() => {
      this.warning?.('Video finalization timed out; preserving received video chunks.');
      void this.complete();
    }, 5000);
    if (this.recorder && this.recorder.state !== 'inactive') {
      try { this.recorder.stop(); } catch { void this.complete(); }
    }
    return result;
  }

  private async complete(): Promise<void> {
    const resolve = this.resolve;
    if (!resolve || !this.metadata) return;
    this.resolve = undefined;
    const endedAt = this.truncated ? this.acceptedUntil ?? this.startedAt : this.stoppedAt ?? performance.now();
    const metadata = { ...this.metadata, durationMs: Math.max(0, Math.round(endedAt - this.startedAt)) };
    const chunks = this.chunks;
    this.cleanup();
    try {
      const bytes = new Uint8Array(await new Blob(chunks, { type: metadata.mimeType }).arrayBuffer());
      resolve(bytes.length ? { metadata, bytes } : null);
    } catch { resolve(null); }
  }

  private failedStart(): void {
    this.resolve?.(null); this.resolve = undefined; this.finish = undefined;
    this.cleanup();
  }

  private cleanup(): void {
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = undefined;
    this.tracks.forEach((track) => track.removeEventListener('ended', this.onTrackEnded));
    this.tracks = []; this.chunks = [];
    if (this.recorder) { this.recorder.ondataavailable = null; this.recorder.onstop = null; this.recorder.onerror = null; }
    this.recorder = undefined;
  }
}
