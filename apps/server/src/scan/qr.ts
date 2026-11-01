/**
 * Pairing by looking: every scan frame is searched for a QR code (pure JS: jpeg-js + jsQR). A code of the
 * form https://<host>/p/<pairingId>#<code> (what the pairing manager prints) approves that pending request
 * on behalf of the frame's sender when the sender may approve.
 */
import jsQR from 'jsqr';
import type { PxBox } from '@ce/protocol';
import type { DecodedImage } from '../oracle/image';

export interface QrSighting {
  text: string;
  pairingId?: string;
  code?: string;
  box?: PxBox;
}

/** Parse the pairing URL (or a bare code) out of QR text. */
export function parsePairingQr(text: string): { pairingId?: string; code?: string } {
  const m = /\/p\/([A-Za-z0-9_-]+)(?:#([A-Za-z0-9-]+))?/.exec(text);
  if (m) return { pairingId: m[1], code: m[2] };
  const bare = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{3}-?[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{3}$/i.exec(text.trim());
  if (bare) return { code: text.trim() };
  return {};
}

/** Decode the first QR code in an RGBA image. Optionally downscale by an integer factor to save time. */
export function findQr(img: DecodedImage, scale = 1): QrSighting | null {
  let data: Uint8Array | Uint8ClampedArray = img.data;
  let width = img.width;
  let height = img.height;
  if (scale > 1) {
    width = Math.floor(img.width / scale);
    height = Math.floor(img.height / scale);
    data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      const sy = y * scale * img.width;
      for (let x = 0; x < width; x++) {
        const si = (sy + x * scale) * 4;
        const di = (y * width + x) * 4;
        data[di] = img.data[si];
        data[di + 1] = img.data[si + 1];
        data[di + 2] = img.data[si + 2];
        data[di + 3] = 255;
      }
    }
  }
  const r = jsQR(data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width, height, { inversionAttempts: 'attemptBoth' });
  if (!r || !r.data) return null;
  const loc = r.location;
  const xs = [loc.topLeftCorner.x, loc.topRightCorner.x, loc.bottomLeftCorner.x, loc.bottomRightCorner.x].map((v) => v * scale);
  const ys = [loc.topLeftCorner.y, loc.topRightCorner.y, loc.bottomLeftCorner.y, loc.bottomRightCorner.y].map((v) => v * scale);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const out: QrSighting = { text: r.data, box: [Math.round(x), Math.round(y), Math.round(Math.max(...xs) - x), Math.round(Math.max(...ys) - y)] };
  const parsed = parsePairingQr(r.data);
  if (parsed.pairingId) out.pairingId = parsed.pairingId;
  if (parsed.code) out.code = parsed.code;
  return out;
}
