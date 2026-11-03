// Build-time only. The pinned generator's internal class is used here because its
// public entry assumes a browser Worker. Nothing is compiled on the headset.
import { readFile, writeFile } from 'node:fs/promises';
import { inflateSync, deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const base = new URL('../', import.meta.url);
const dep = new URL('node_modules/@zappar/msdf-generator/dist/', base);
const font = await readFile(new URL('apps/quest/public/fonts/inter-latin-500-normal.woff', base));
// Read the font's actual cmap; never advertise a missing character as present.
let cmap;
for (let i = 0; i < font.readUInt16BE(12); i++) {
  const o = 44 + i * 20;
  if (font.toString('ascii', o, o + 4) !== 'cmap') continue;
  const start = font.readUInt32BE(o + 4), length = font.readUInt32BE(o + 8);
  const raw = font.subarray(start, start + length);
  cmap = length < font.readUInt32BE(o + 12) ? inflateSync(raw) : raw;
}
if (!cmap) throw new Error('Expected WOFF cmap');
const codepoints = new Set();
for (let table = 0; table < cmap.readUInt16BE(2); table++) {
  const o = cmap.readUInt32BE(4 + table * 8 + 4);
  if (cmap.readUInt16BE(o) !== 4) continue;
  const segments = cmap.readUInt16BE(o + 6) / 2;
  const end = o + 14, start = end + segments * 2 + 2;
  const delta = start + segments * 2, range = delta + segments * 2;
  for (let i = 0; i < segments; i++) {
    for (let cp = cmap.readUInt16BE(start + i * 2); cp <= cmap.readUInt16BE(end + i * 2) && cp < 0xffff; cp++) {
      const r = cmap.readUInt16BE(range + i * 2);
      const glyph = r ? cmap.readUInt16BE(range + i * 2 + r + 2 * (cp - cmap.readUInt16BE(start + i * 2))) : (cp + cmap.readInt16BE(delta + i * 2)) & 0xffff;
      if (glyph && cp >= 32 && !(cp >= 127 && cp < 160)) codepoints.add(cp);
    }
  }
}
const charset = [...codepoints].sort((a, b) => a - b).map((cp) => String.fromCodePoint(cp)).join('');
// The WASM FreeType build accepts SFNT, not WOFF. Reconstruct its uncompressed
// tables from the existing local WOFF instead of adding a converter dependency.
const tableCount = font.readUInt16BE(12), tableHeader = Buffer.alloc(12 + tableCount * 16);
tableHeader.writeUInt32BE(font.readUInt32BE(4)); tableHeader.writeUInt16BE(tableCount, 4);
const power = Math.floor(Math.log2(tableCount));
tableHeader.writeUInt16BE(16 * 2 ** power, 6); tableHeader.writeUInt16BE(power, 8);
tableHeader.writeUInt16BE(tableCount * 16 - 16 * 2 ** power, 10);
const tableParts = []; let tableOffset = tableHeader.length;
for (let i = 0; i < tableCount; i++) {
  const o = 44 + i * 20, d = 12 + i * 16;
  const start = font.readUInt32BE(o + 4), length = font.readUInt32BE(o + 8), original = font.readUInt32BE(o + 12);
  const raw = font.subarray(start, start + length), decoded = length < original ? inflateSync(raw) : raw;
  font.copy(tableHeader, d, o, o + 4); tableHeader.writeUInt32BE(font.readUInt32BE(o + 16), d + 4);
  tableHeader.writeUInt32BE(tableOffset, d + 8); tableHeader.writeUInt32BE(original, d + 12);
  const padded = Buffer.alloc(Math.ceil(original / 4) * 4); decoded.copy(padded);
  tableParts.push(padded); tableOffset += padded.length;
}
const sfnt = Buffer.concat([tableHeader, ...tableParts]);
const worker = await readFile(new URL('worker.js', dep), 'utf8');
const source = worker.slice(worker.indexOf('var MSDFGenerator = class'), worker.indexOf('// src/worker.ts', worker.indexOf('var MSDFGenerator = class')));
const { MSDFGenerator } = await import(`data:text/javascript;base64,${Buffer.from(`${source}\nexport { MSDFGenerator };`).toString('base64')}`);
const { default: loadWasm } = await import(new URL('msdfgen_wasm.js', dep).href);
const module = await loadWasm({ wasmBinary: await readFile(new URL('msdfgen_wasm.wasm', dep)), print() {}, printErr: console.error });
globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
const generator = new MSDFGenerator(module);
await generator.loadFont(new Uint8Array(sfnt));
const atlas = generator.generateAtlas({ charset, fontSize: 48, textureSize: [1024, 1024], fieldRange: 4, fixOverlaps: true });
const metadata = generator.exportJSON({ atlas, fontSize: 48 });
metadata.pages = ['muse-reader-inter.png'];
const crcTable = Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
const chunk = (type, data) => {
  const name = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([name, data])) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, name, data, checksum]);
};
const [width, height] = atlas.textureSize, header = Buffer.alloc(13);
header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
const pixels = Buffer.alloc(height * (width * 4 + 1));
for (let y = 0; y < height; y++) Buffer.from(atlas.texture.data.buffer, y * width * 4, width * 4).copy(pixels, y * (width * 4 + 1) + 1);
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
const output = new URL('apps/quest/public/fonts/', base);
await writeFile(new URL('muse-reader-inter.json', output), JSON.stringify(metadata));
await writeFile(new URL('muse-reader-inter.png', output), png);
await writeFile(new URL('muse-reader-coverage.json', output), JSON.stringify([...codepoints].sort((a, b) => a - b)));
generator.dispose();
console.log(JSON.stringify({ glyphs: metadata.chars.length, pngBytes: png.length, source: fileURLToPath(new URL('apps/quest/public/fonts/inter-latin-500-normal.woff', base)) }));
