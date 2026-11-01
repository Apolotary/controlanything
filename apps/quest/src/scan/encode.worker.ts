/**
 * JPEG encoder worker: ImageBitmap (transferred) → scaled to ≤ maxWidth → JPEG → base64.
 * Keeps the 8–15 ms encode off the XR main thread (research/04 §11).
 * (Typed against the DOM lib; the worker scope is narrowed by hand to avoid mixing in the webworker lib.)
 */
import { toBase64 } from './base64';

interface EncodeRequest {
  id: number;
  bitmap: ImageBitmap;
  maxWidth: number;
  quality: number;
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<EncodeRequest>) => void) | null;
  postMessage(message: unknown): void;
};

scope.onmessage = async (e) => {
  const { id, bitmap, maxWidth, quality } = e.data;
  try {
    const scale = Math.min(1, maxWidth / bitmap.width);
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context in worker');
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    scope.postMessage({ id, ok: true, base64: toBase64(bytes), width, height, bytes: bytes.length });
  } catch (err) {
    scope.postMessage({ id, ok: false, error: (err as Error).message });
  }
};
