/** Phone/webcam capture: the complete unmirrored preview is exactly the photo reviewed before upload. */
export class ReviewerCamera {
  private stream?: MediaStream;
  private generation = 0;
  private facing: 'user' | 'environment' = matchMedia('(pointer: coarse)').matches ? 'environment' : 'user';
  constructor(readonly video: HTMLVideoElement, readonly canvas: HTMLCanvasElement, private changed: (on: boolean, text: string) => void) {}
  get active(): boolean { return !!this.stream; }
  async start(): Promise<void> {
    this.stop(); const generation = ++this.generation;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this.changed(false, 'Camera needs HTTPS (or localhost on a laptop). Use Virtual object while you set up a trusted HTTPS connection.'); return;
    }
    this.changed(false, 'Allow camera access in your browser. Audio is not requested.');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: this.facing }, width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
      if (generation !== this.generation) { stream.getTracks().forEach(t => t.stop()); return; }
      this.stream = stream; this.video.srcObject = stream; this.video.hidden = false; this.canvas.hidden = true;
      await this.video.play();
      if (generation !== this.generation) return;
      stream.getVideoTracks()[0]?.addEventListener('ended', () => { if (this.stream === stream) this.stop('Camera disconnected. Choose Use camera to retry.'); });
      this.changed(true, 'Aim your phone or hold an object up to the webcam. Capture freezes the whole visible image; nothing is sent yet.');
    } catch (e) {
      if (generation !== this.generation) return;
      this.stream?.getTracks().forEach(t => t.stop()); this.stream = undefined; this.video.hidden = true;
      const name = (e as DOMException).name;
      this.changed(false, name === 'NotAllowedError' ? 'Camera permission was denied. Allow it in the browser’s site settings, then choose Use camera again. Virtual objects still work.' : name === 'NotReadableError' ? 'Camera is busy. Close the app or tab using it, then choose Use camera again.' : 'No camera is available. Connect a webcam and retry, or choose a virtual object.');
    }
  }
  stop(text = 'Camera is off. Choose Use camera when you are ready.'): void {
    this.generation++; this.stream?.getTracks().forEach(t => t.stop()); this.stream = undefined;
    this.video.srcObject = null; this.video.hidden = true; this.changed(false, text);
  }
  async flip(): Promise<void> { this.facing = this.facing === 'user' ? 'environment' : 'user'; await this.start(); }
  capture(): string | undefined {
    if (!this.stream || !this.video.videoWidth) return;
    const scale = Math.min(1, 960 / this.video.videoWidth);
    this.canvas.width = Math.round(this.video.videoWidth * scale); this.canvas.height = Math.round(this.video.videoHeight * scale);
    this.canvas.getContext('2d')!.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
    this.canvas.hidden = false; this.video.hidden = true;
    return this.canvas.toDataURL('image/jpeg', .85).split(',')[1];
  }
  retake(): void { this.canvas.hidden = true; if (this.stream) this.video.hidden = false; }
  setVirtual(image: HTMLCanvasElement): string {
    this.canvas.width = image.width; this.canvas.height = image.height;
    this.canvas.getContext('2d')!.drawImage(image, 0, 0); this.canvas.hidden = false; this.video.hidden = true;
    return image.toDataURL('image/jpeg', .85).split(',')[1]!;
  }
}
