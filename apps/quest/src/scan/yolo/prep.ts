/**
 * YOLOX pre-processing, as in YOLOX's own `preproc`: keep the aspect ratio, resize so the long side fits the
 * square input, paste at the TOP-LEFT, pad the rest with grey 114, feed BGR in 0..255 (no normalisation) as
 * NCHW float32. Pure functions, unit-tested; the worker draws the scaled image onto a 114-filled canvas and
 * calls `rgbaToBgrChw` on the pixels.
 */

export type Box = [number, number, number, number]; // x, y, w, h (pixels)

export interface Letterbox {
  /** square model input side, px */
  size: number;
  /** source → input scale */
  scale: number;
  /** scaled image size inside the input (pasted at 0,0) */
  width: number;
  height: number;
  srcWidth: number;
  srcHeight: number;
}

export const PAD_VALUE = 114;

export function letterbox(srcWidth: number, srcHeight: number, size: number): Letterbox {
  const scale = Math.min(size / srcWidth, size / srcHeight);
  return {
    size,
    scale,
    width: Math.max(1, Math.round(srcWidth * scale)),
    height: Math.max(1, Math.round(srcHeight * scale)),
    srcWidth,
    srcHeight,
  };
}

/**
 * RGBA pixels of the size×size letterboxed input → BGR planar float32 (NCHW, batch 1). Pixels outside the
 * pasted image are forced to the pad value, so it does not matter what the canvas held there.
 */
export function rgbaToBgrChw(rgba: Uint8ClampedArray | Uint8Array, lb: Letterbox, out?: Float32Array): Float32Array {
  const s = lb.size;
  const plane = s * s;
  const t = out && out.length === plane * 3 ? out : new Float32Array(plane * 3);
  for (let y = 0; y < s; y++) {
    const inside = y < lb.height;
    for (let x = 0; x < s; x++) {
      const i = y * s + x;
      if (inside && x < lb.width) {
        const p = i * 4;
        t[i] = rgba[p + 2]!; // B
        t[plane + i] = rgba[p + 1]!; // G
        t[2 * plane + i] = rgba[p]!; // R
      } else {
        t[i] = PAD_VALUE;
        t[plane + i] = PAD_VALUE;
        t[2 * plane + i] = PAD_VALUE;
      }
    }
  }
  return t;
}

/** A box in model-input pixels → source-image pixels, clipped to the image. */
export function toSource(b: Box, lb: Letterbox): Box {
  const x0 = clamp(b[0] / lb.scale, 0, lb.srcWidth);
  const y0 = clamp(b[1] / lb.scale, 0, lb.srcHeight);
  const x1 = clamp((b[0] + b[2]) / lb.scale, 0, lb.srcWidth);
  const y1 = clamp((b[1] + b[3]) / lb.scale, 0, lb.srcHeight);
  return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
