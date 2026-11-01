/**
 * Frame → JPEG base64, in a worker when OffscreenCanvas is available (Quest Browser has it), else on the
 * main thread (still fine at ≤ 1 Hz on a desktop).
 */
import { toBase64 } from './base64';

export interface EncodedJpeg {
  base64: string;
  width: number;
  height: number;
  bytes: number;
}

type Pending = { resolve: (r: EncodedJpeg) => void; reject: (e: Error) => void };

export class JpegEncoder {
  private worker?: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private workerBroken = false;

  constructor(
    readonly maxWidth = 1280,
    readonly quality = 0.8,
  ) {
    if (typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined') {
      try {
        this.worker = new Worker(new URL('./encode.worker.ts', import.meta.url), { type: 'module' });
        this.worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; error?: string } & EncodedJpeg>) => {
          const p = this.pending.get(e.data.id);
          if (!p) return;
          this.pending.delete(e.data.id);
          if (e.data.ok) p.resolve({ base64: e.data.base64, width: e.data.width, height: e.data.height, bytes: e.data.bytes });
          else p.reject(new Error(e.data.error ?? 'encode failed'));
        };
        this.worker.onerror = () => {
          this.workerBroken = true;
          for (const p of this.pending.values()) p.reject(new Error('encoder worker failed'));
          this.pending.clear();
        };
      } catch {
        this.worker = undefined;
      }
    }
  }

  /** Takes ownership of the bitmap (it is transferred or closed). */
  encode(bitmap: ImageBitmap, opts: { maxWidth?: number; quality?: number } = {}): Promise<EncodedJpeg> {
    const maxWidth = opts.maxWidth ?? this.maxWidth;
    const quality = opts.quality ?? this.quality;
    if (this.worker && !this.workerBroken) {
      const id = this.nextId++;
      return new Promise<EncodedJpeg>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.worker!.postMessage({ id, bitmap, maxWidth, quality }, [bitmap]);
      });
    }
    return encodeOnMainThread(bitmap, maxWidth, quality);
  }

  dispose(): void {
    this.worker?.terminate();
  }
}

async function encodeOnMainThread(bitmap: ImageBitmap, maxWidth: number, quality: number): Promise<EncodedJpeg> {
  const scale = Math.min(1, maxWidth / bitmap.width);
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', quality));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { base64: toBase64(bytes), width, height, bytes: bytes.length };
}
