/**
 * Records a session for the judge path: every message the headset sent and received (JPEGs moved to
 * frames/), the head pose at 10 Hz and the user's inputs. Exports a STORE zip (<take>.zip) the headset can
 * download (adb pull /sdcard/Download/<take>.zip) and the desktop can save or replay directly.
 */
import type { Envelope } from '../io/ws';
import { fromBase64 } from '../scan/base64';
import { extractJpeg, type InputLine, type TakeLine, type TakeMeta } from './take';
import { type ZipEntry, zipStore } from './zip';

export class Recorder {
  recording = false;
  private meta?: TakeMeta;
  private lines: TakeLine[] = [];
  private frames = new Map<string, string>();
  private t0 = 0;
  private lastPoseAt = -1;
  /** bytes of JPEG kept so far (base64 length × 3/4) */
  frameBytes = 0;

  start(meta: Omit<TakeMeta, 'kind' | 'v' | 'startedAt' | 'take'> & { take?: string }): string {
    const now = new Date();
    const take = meta.take ?? `take-${now.toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
    this.meta = { kind: 'meta', v: 1, startedAt: now.getTime(), ...meta, take };
    this.lines = [];
    this.frames.clear();
    this.frameBytes = 0;
    this.t0 = performance.now();
    this.lastPoseAt = -1;
    this.recording = true;
    return take;
  }

  stop(): void {
    this.recording = false;
  }

  get take(): string | undefined {
    return this.meta?.take;
  }

  get elapsedMs(): number {
    return this.recording ? performance.now() - this.t0 : 0;
  }

  get count(): { lines: number; frames: number } {
    return { lines: this.lines.length, frames: this.frames.size };
  }

  message(dir: 'in' | 'out', env: Envelope): void {
    if (!this.recording) return;
    const { msg, files } = extractJpeg(env);
    for (const [file, b64] of files) {
      if (!this.frames.has(file)) this.frameBytes += Math.round((b64.length * 3) / 4);
      this.frames.set(file, b64);
    }
    this.lines.push({ t: this.now(), dir, msg });
  }

  pose(head: { position: { x: number; y: number; z: number }; quaternion: { x: number; y: number; z: number; w: number } }): void {
    if (!this.recording) return;
    const t = this.now();
    if (this.lastPoseAt >= 0 && t - this.lastPoseAt < 100) return;
    this.lastPoseAt = t;
    const r = (n: number) => Math.round(n * 10000) / 10000;
    this.lines.push({
      t,
      kind: 'pose',
      head: {
        position: { x: r(head.position.x), y: r(head.position.y), z: r(head.position.z) },
        orientation: { x: r(head.quaternion.x), y: r(head.quaternion.y), z: r(head.quaternion.z), w: r(head.quaternion.w) },
      },
    });
  }

  input(type: string, data: Record<string, unknown> = {}): void {
    if (!this.recording) return;
    const line: InputLine = { t: this.now(), kind: 'input', input: { type, ...data } };
    this.lines.push(line);
  }

  /** session.jsonl text */
  jsonl(): string {
    if (!this.meta) return '';
    return [this.meta, ...this.lines].map((l) => JSON.stringify(l)).join('\n') + '\n';
  }

  toZip(): Uint8Array {
    if (!this.meta) throw new Error('nothing recorded');
    const take = this.meta.take;
    const enc = new TextEncoder();
    const entries: ZipEntry[] = [{ name: `${take}/session.jsonl`, data: enc.encode(this.jsonl()) }];
    for (const [file, b64] of this.frames) entries.push({ name: `${take}/${file}`, data: fromBase64(b64) });
    return zipStore(entries);
  }

  /** Save <take>.zip through a download link. */
  download(): string | null {
    if (!this.meta) return null;
    const blob = new Blob([this.toZip() as unknown as BlobPart], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this.meta.take}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return a.download;
  }

  private now(): number {
    return Math.round(performance.now() - this.t0);
  }
}
