/**
 * Minimal Radiance .hdr (RGBE) decoder: header, "-Y h +X w" resolution, flat or new-style RLE scanlines.
 * Returns linear RGB floats (3 per pixel, row-major from the top). Used in the browser and in Node tests.
 */
export interface HdrImage {
  width: number;
  height: number;
  /** linear RGB, length = width * height * 3 */
  data: Float32Array;
  exposure: number;
}

function readLine(buf: Uint8Array, pos: number): [string, number] {
  let end = pos;
  while (end < buf.length && buf[end] !== 0x0a) end++;
  let s = '';
  for (let i = pos; i < end; i++) s += String.fromCharCode(buf[i]!);
  return [s, end + 1];
}

export function decodeHdr(input: ArrayBuffer | Uint8Array): HdrImage {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  let pos = 0;
  let line: string;
  [line, pos] = readLine(buf, pos);
  if (!line.startsWith('#?')) throw new Error('not a Radiance HDR file');
  let exposure = 1;
  for (;;) {
    [line, pos] = readLine(buf, pos);
    if (pos >= buf.length) throw new Error('HDR header has no end');
    if (line === '') break;
    const m = /^EXPOSURE\s*=\s*([0-9.eE+-]+)/.exec(line);
    if (m) exposure *= Number(m[1]);
    if (/^FORMAT=/.test(line) && !line.includes('32-bit_rle_rgbe')) throw new Error(`unsupported HDR format ${line}`);
  }
  [line, pos] = readLine(buf, pos);
  const res = /^-Y\s+(\d+)\s+\+X\s+(\d+)$/.exec(line.trim());
  if (!res) throw new Error(`unsupported HDR orientation "${line}"`);
  const height = Number(res[1]);
  const width = Number(res[2]);
  const rgbe = new Uint8Array(width * 4);
  const out = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    if (width >= 8 && width < 0x8000 && buf[pos] === 2 && buf[pos + 1] === 2 && ((buf[pos + 2]! << 8) | buf[pos + 3]!) === width) {
      pos += 4;
      for (let c = 0; c < 4; c++) {
        let x = 0;
        while (x < width) {
          let count = buf[pos++]!;
          if (count > 128) {
            count -= 128;
            const v = buf[pos++]!;
            for (let k = 0; k < count; k++) rgbe[(x++) * 4 + c] = v;
          } else {
            for (let k = 0; k < count; k++) rgbe[(x++) * 4 + c] = buf[pos++]!;
          }
        }
      }
    } else {
      // flat scanline (no RLE)
      rgbe.set(buf.subarray(pos, pos + width * 4));
      pos += width * 4;
    }
    const row = y * width * 3;
    for (let x = 0; x < width; x++) {
      const e = rgbe[x * 4 + 3]!;
      const o = row + x * 3;
      if (e === 0) {
        out[o] = out[o + 1] = out[o + 2] = 0;
        continue;
      }
      const f = 2 ** (e - 136);
      out[o] = (rgbe[x * 4]! + 0.5) * f;
      out[o + 1] = (rgbe[x * 4 + 1]! + 0.5) * f;
      out[o + 2] = (rgbe[x * 4 + 2]! + 0.5) * f;
    }
  }
  if (exposure !== 1) for (let i = 0; i < out.length; i++) out[i] = out[i]! / exposure;
  return { width, height, data: out, exposure };
}

/**
 * "CEL1" layer container written by scripts/pack-room.ts (gzip on top, so the browser fetches *.cel.gz):
 *   "CEL1" · u32le header length · header JSON {width, height, bits, layout: "rgbe-planar-up"} · 4 planes
 *   (R, G, B, E mantissa/exponent bytes), each row stored as the byte-wise difference to the row above.
 * Planar + row delta + 7-bit mantissas compress ~3x better than Radiance RLE at <= 1 % linear precision,
 * which is below one 8-bit step of the developed frame.
 */
export function decodeCel(bytes: Uint8Array): HdrImage {
  if (String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) !== 'CEL1') throw new Error('not a CEL1 layer');
  const hlen = bytes[4]! | (bytes[5]! << 8) | (bytes[6]! << 16) | (bytes[7]! << 24);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + hlen))) as { width: number; height: number; layout: string };
  if (header.layout !== 'rgbe-planar-up') throw new Error(`unsupported CEL layout ${header.layout}`);
  const { width, height } = header;
  const n = width * height;
  const planes = bytes.subarray(8 + hlen, 8 + hlen + 4 * n);
  if (planes.length < 4 * n) throw new Error('CEL1 layer is truncated');
  const pl = new Uint8Array(planes); // undo the row delta in place, plane by plane
  for (let c = 0; c < 4; c++) {
    const base = c * n;
    for (let i = width; i < n; i++) pl[base + i] = (pl[base + i]! + pl[base + i - width]!) & 255;
  }
  const out = new Float32Array(n * 3);
  for (let p = 0; p < n; p++) {
    const e = pl[3 * n + p]!;
    if (e === 0) continue;
    const f = 2 ** (e - 136);
    out[p * 3] = pl[p]! * f;
    out[p * 3 + 1] = pl[n + p]! * f;
    out[p * 3 + 2] = pl[2 * n + p]! * f;
  }
  return { width, height, data: out, exposure: 1 };
}

/** Encoder for decodeCel (Node packer and tests). `bits` = mantissa precision kept (8 = lossless RGBE). */
export function encodeCel(img: { width: number; height: number; data: Float32Array }, bits = 7): Uint8Array {
  const { width, height, data } = img;
  const n = width * height;
  const q = 1 << (8 - bits);
  const pl = new Uint8Array(4 * n);
  for (let p = 0; p < n; p++) {
    const r = data[p * 3]!;
    const g = data[p * 3 + 1]!;
    const b = data[p * 3 + 2]!;
    const v = Math.max(r, g, b);
    if (!(v > 1e-30)) continue;
    const e = Math.ceil(Math.log2(v) + 1e-12);
    const f = 256 / 2 ** e;
    const quant = (x: number) => Math.min(255, Math.floor((x * f) / q) * q + (q >> 1));
    pl[p] = quant(r);
    pl[n + p] = quant(g);
    pl[2 * n + p] = quant(b);
    pl[3 * n + p] = e + 128;
  }
  for (let c = 0; c < 4; c++) {
    const base = c * n;
    for (let i = n - 1; i >= width; i--) pl[base + i] = (pl[base + i]! - pl[base + i - width]!) & 255;
  }
  const header = new TextEncoder().encode(JSON.stringify({ width, height, bits, layout: 'rgbe-planar-up' }));
  const out = new Uint8Array(8 + header.length + pl.length);
  out.set([0x43, 0x45, 0x4c, 0x31, header.length & 255, (header.length >> 8) & 255, (header.length >> 16) & 255, (header.length >> 24) & 255]);
  out.set(header, 8);
  out.set(pl, 8 + header.length);
  return out;
}
