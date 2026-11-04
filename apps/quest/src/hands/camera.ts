/** Front camera (laptop webcam or phone selfie camera) for hand tracking. Off until the person chooses it. */
export class HandCamera {
  private stream?: MediaStream;
  private generation = 0;
  facing: 'user' | 'environment' = 'user';
  constructor(readonly video: HTMLVideoElement, private readonly changed: (on: boolean, text: string, error?: boolean) => void) {}
  get active(): boolean { return !!this.stream; }
  /** The front camera is shown mirrored, like a mirror; the rear one is not. */
  get mirror(): boolean { return this.facing === 'user'; }

  async start(): Promise<boolean> {
    this.stop(undefined, true);
    const generation = ++this.generation;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this.changed(false, 'The camera needs HTTPS (or localhost on this computer). Touch control still works.', true);
      return false;
    }
    this.changed(false, 'Allow camera access in your browser. No microphone is requested.');
    const phone = matchMedia('(pointer: coarse)').matches;
    // `?cam=1280x960` asks for an exact size (checks with a fake camera); otherwise the camera's usual 16:9 or 4:3
    const [cw, ch] = (new URLSearchParams(location.search).get('cam') ?? '').split('x').map(Number);
    const size = cw && ch ? { width: { ideal: cw }, height: { ideal: ch } } : { width: { ideal: phone ? 640 : 1280 }, height: { ideal: phone ? 480 : 720 } };
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: this.facing }, ...size, frameRate: { ideal: 30, max: 60 } },
        audio: false,
      });
      if (generation !== this.generation) { stream.getTracks().forEach(t => t.stop()); return false; }
      this.stream = stream;
      const track = stream.getVideoTracks()[0];
      const reported = track?.getSettings().facingMode;
      if (reported === 'user' || reported === 'environment') this.facing = reported;
      this.video.srcObject = stream; this.video.muted = true; this.video.playsInline = true;
      await this.video.play();
      if (generation !== this.generation) return false;
      track?.addEventListener('ended', () => { if (this.stream === stream) this.stop('The camera disconnected. Choose Start camera to retry.'); });
      this.changed(true, 'Camera on. Hold your hands up in front of it.');
      return true;
    } catch (e) {
      if (generation !== this.generation) return false;
      this.stream?.getTracks().forEach(t => t.stop()); this.stream = undefined;
      const name = (e as DOMException).name;
      this.changed(false, name === 'NotAllowedError' ? 'Camera permission was denied. Allow it in the site settings and try again, or use touch.'
        : name === 'NotReadableError' ? 'The camera is busy in another app or tab. Close it and try again, or use touch.'
        : 'No camera is available. Connect one and try again, or use touch.', true);
      return false;
    }
  }

  stop(text = 'Camera off. Touch control still works.', silent = false): void {
    this.generation++;
    this.stream?.getTracks().forEach(t => t.stop()); this.stream = undefined;
    this.video.srcObject = null;
    if (!silent) this.changed(false, text);
  }

  async flip(): Promise<boolean> { this.facing = this.facing === 'user' ? 'environment' : 'user'; return this.start(); }
}
