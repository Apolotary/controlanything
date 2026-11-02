// Rebuild the local HUD fonts: node apps/quest/scripts/bundle-inter.mjs
// Troika does not apply tnum; select Inter's existing tabular glyphs in a derived cmap.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { deflateSync, inflateSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const destination = new URL('../public/fonts/', import.meta.url);
mkdirSync(destination, { recursive: true });
for (const weight of [400, 500, 600]) {
  const filename = `inter-latin-${weight}-normal.woff`;
  copyFileSync(require.resolve(`@fontsource/inter/files/${filename}`), new URL(filename, destination));
}
copyFileSync(require.resolve('@fontsource/inter/LICENSE'), new URL('OFL-Inter.txt', destination));

const source = readFileSync(new URL('inter-latin-600-normal.woff', destination));
assert.equal(source.toString('ascii', 0, 4), 'wOFF');
const tables = new Map();
for (let i = 0; i < source.readUInt16BE(12); i++) {
  const record = 44 + i * 20;
  const offset = source.readUInt32BE(record + 4);
  const length = source.readUInt32BE(record + 8);
  const data = source.subarray(offset, offset + length);
  tables.set(source.toString('ascii', record, record + 4), Buffer.from(length < source.readUInt32BE(record + 12) ? inflateSync(data) : data));
}

// Inter Latin's format-4 digit segment maps consecutive glyphs. Read its native tnum substitution.
const cmap = tables.get('cmap');
const gsub = tables.get('GSUB');
const featureList = gsub.readUInt16BE(6), lookupList = gsub.readUInt16BE(8);
let substitution;
for (let i = 0; i < gsub.readUInt16BE(featureList); i++) {
  const record = featureList + 2 + i * 6;
  if (gsub.toString('ascii', record, record + 4) !== 'tnum') continue;
  const feature = featureList + gsub.readUInt16BE(record + 4);
  assert.equal(gsub.readUInt16BE(feature + 2), 1);
  const lookup = lookupList + gsub.readUInt16BE(lookupList + 2 + gsub.readUInt16BE(feature + 4) * 2);
  assert.equal(gsub.readUInt16BE(lookup), 1); // Single substitution.
  substitution = lookup + gsub.readUInt16BE(lookup + 6);
}
assert.ok(substitution, 'Inter must supply a tnum feature');
assert.equal(gsub.readUInt16BE(substitution), 2);
const coverage = substitution + gsub.readUInt16BE(substitution + 2);
assert.equal(gsub.readUInt16BE(coverage), 2);
const glyphIndex = (glyph) => {
  for (let i = 0; i < gsub.readUInt16BE(coverage + 2); i++) {
    const record = coverage + 4 + i * 6, first = gsub.readUInt16BE(record), last = gsub.readUInt16BE(record + 2);
    if (glyph >= first && glyph <= last) return gsub.readUInt16BE(record + 4) + glyph - first;
  }
  throw new Error(`Missing tabular substitution for glyph ${glyph}`);
};
const visited = new Set();
for (let i = 0; i < cmap.readUInt16BE(2); i++) {
  const offset = cmap.readUInt32BE(8 + i * 8);
  if (visited.has(offset)) continue;
  visited.add(offset);
  assert.equal(cmap.readUInt16BE(offset), 4);
  const count = cmap.readUInt16BE(offset + 6) / 2;
  let patched = false;
  for (let segment = 0; segment < count; segment++) {
    if (cmap.readUInt16BE(offset + 16 + count * 2 + segment * 2) !== 48 || cmap.readUInt16BE(offset + 14 + segment * 2) !== 57) continue;
    assert.equal(cmap.readUInt16BE(offset + 16 + count * 6 + segment * 2), 0);
    const deltaAt = offset + 16 + count * 4 + segment * 2;
    const original = cmap.readInt16BE(deltaAt) + 48;
    const replacements = Array.from({ length: 10 }, (_, digit) => gsub.readUInt16BE(substitution + 6 + glyphIndex(original + digit) * 2));
    replacements.forEach((glyph, digit) => assert.equal(glyph, replacements[0] + digit));
    cmap.writeInt16BE(replacements[0] - 48, deltaAt);
    patched = true;
  }
  assert.ok(patched, 'Expected Inter Latin digit segment');
}

// Clearly distinguish the derivative in font metadata while retaining all copyright/licence records.
const name = tables.get('name'), nameCount = name.readUInt16BE(2), stringStart = name.readUInt16BE(4);
const header = Buffer.from(name.subarray(0, 6 + nameCount * 12)), strings = [];
let stringLength = 0;
header.writeUInt16BE(header.length, 4);
for (let i = 0; i < nameCount; i++) {
  const record = 6 + i * 12, id = name.readUInt16BE(record + 6), platform = name.readUInt16BE(record);
  let value = name.subarray(stringStart + name.readUInt16BE(record + 10), stringStart + name.readUInt16BE(record + 10) + name.readUInt16BE(record + 8));
  const replacement = id === 6 ? 'CEInterTabular-SemiBold' : [1, 3, 4, 16, 18].includes(id) ? 'CE Inter Tabular' : null;
  if (replacement) value = platform === 0 || platform === 3 ? Buffer.from(replacement, 'utf16le').swap16() : Buffer.from(replacement, 'ascii');
  header.writeUInt16BE(value.length, record + 8);
  header.writeUInt16BE(stringLength, record + 10);
  strings.push(value); stringLength += value.length;
}
tables.set('name', Buffer.concat([header, ...strings]));

const aligned = (length) => (length + 3) & ~3;
const checksum = (data) => {
  const padded = Buffer.alloc(aligned(data.length)); data.copy(padded);
  let sum = 0;
  for (let offset = 0; offset < padded.length; offset += 4) sum = (sum + padded.readUInt32BE(offset)) >>> 0;
  return sum;
};
tables.get('head').writeUInt32BE(0, 8);
const count = tables.size, sfnt = Buffer.alloc(12 + count * 16);
source.copy(sfnt, 0, 4, 8); sfnt.writeUInt16BE(count, 4);
sfnt.writeUInt16BE(16 * 2 ** Math.floor(Math.log2(count)), 6);
sfnt.writeUInt16BE(Math.floor(Math.log2(count)), 8);
sfnt.writeUInt16BE(count * 16 - sfnt.readUInt16BE(6), 10);
let sfntLength = sfnt.length, index = 0, tableSum = 0;
for (const [tag, data] of tables) {
  const record = 12 + index++ * 16, sum = checksum(data);
  sfnt.write(tag, record); sfnt.writeUInt32BE(sum, record + 4); sfnt.writeUInt32BE(sfntLength, record + 8); sfnt.writeUInt32BE(data.length, record + 12);
  tableSum = (tableSum + sum) >>> 0; sfntLength += aligned(data.length);
}
tables.get('head').writeUInt32BE((0xb1b0afba - checksum(sfnt) - tableSum) >>> 0, 8);
const directory = Buffer.alloc(44 + count * 20), chunks = [];
source.copy(directory, 0, 0, 20); directory.writeUInt32BE(sfntLength, 16);
let woffLength = directory.length;
index = 0;
for (const [tag, data] of tables) {
  const record = 44 + index * 20, compressed = deflateSync(data), stored = compressed.length < data.length ? compressed : data;
  directory.write(tag, record); directory.writeUInt32BE(woffLength, record + 4); directory.writeUInt32BE(stored.length, record + 8);
  directory.writeUInt32BE(data.length, record + 12); directory.writeUInt32BE(sfnt.readUInt32BE(12 + index++ * 16 + 4), record + 16);
  const padded = Buffer.alloc(aligned(stored.length)); stored.copy(padded); chunks.push(padded); woffLength += padded.length;
}
directory.writeUInt32BE(woffLength, 8);
writeFileSync(new URL('ce-inter-tabular-600.woff', destination), Buffer.concat([directory, ...chunks]));
