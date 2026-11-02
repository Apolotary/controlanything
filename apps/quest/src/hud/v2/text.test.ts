import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { makeText, setText } from './text';
import { THEME } from './theme';

const require = createRequire(import.meta.url);
const bundled = (filename: string) => readFileSync(new URL(`../../../public/fonts/${filename}`, import.meta.url));
function tables(font: Buffer): Map<string, Buffer> {
  expect(font.toString('ascii', 0, 4)).toBe('wOFF');
  const result = new Map<string, Buffer>();
  for (let i = 0; i < font.readUInt16BE(12); i++) {
    const record = 44 + i * 20, offset = font.readUInt32BE(record + 4), length = font.readUInt32BE(record + 8);
    const data = font.subarray(offset, offset + length);
    result.set(font.toString('ascii', record, record + 4), length < font.readUInt32BE(record + 12) ? inflateSync(data) : data);
  }
  return result;
}
function glyphId(cmap: Buffer, char: string): number {
  const offset = cmap.readUInt32BE(8), count = cmap.readUInt16BE(offset + 6) / 2, code = char.codePointAt(0)!;
  expect(cmap.readUInt16BE(offset)).toBe(4);
  for (let i = 0; i < count; i++) {
    const end = cmap.readUInt16BE(offset + 14 + i * 2), start = cmap.readUInt16BE(offset + 16 + count * 2 + i * 2);
    if (code < start || code > end) continue;
    const delta = cmap.readInt16BE(offset + 16 + count * 4 + i * 2), rangeAt = offset + 16 + count * 6 + i * 2, range = cmap.readUInt16BE(rangeAt);
    const glyph = range ? cmap.readUInt16BE(rangeAt + range + (code - start) * 2) : code;
    return glyph ? (glyph + delta) & 0xffff : 0;
  }
  return 0;
}

describe('local Inter SDF text', () => {
  it('ships the three original weights, their licence, and local font URLs', () => {
    for (const [weight, path] of [[400, THEME.font.regular], [500, THEME.font.medium], [600, THEME.font.semibold]] as const) {
      const filename = `inter-latin-${weight}-normal.woff`;
      expect(path).toBe(`/quest/fonts/${filename}`);
      expect(bundled(filename)).toEqual(readFileSync(require.resolve(`@fontsource/inter/files/${filename}`)));
    }
    expect(bundled('OFL-Inter.txt').toString()).toContain('SIL OPEN FONT LICENSE Version 1.1');
    const text = makeText({ text: 'Brightness', weight: 500 });
    expect(text.font).toBe(THEME.font.medium);
    expect(text.letterSpacing).toBeLessThan(0);
    text.dispose();
  });

  it('uses equal native digit advances for values without extra text meshes', () => {
    const font = tables(bundled('ce-inter-tabular-600.woff'));
    const advances = Array.from('0123456789', (digit) => font.get('hmtx')!.readUInt16BE(glyphId(font.get('cmap')!, digit) * 4));
    expect(advances[0]).toBeGreaterThan(0);
    expect(new Set(advances).size).toBe(1);
    const text = makeText({ text: '80%', tabular: true });
    expect(text.font).toBe(THEME.font.tabular);
    expect(text.letterSpacing).toBe(0);
    expect(text.children).toHaveLength(0);
    setText(text, '11%');
    expect(text.font).toBe(THEME.font.tabular);
    text.dispose();
  });

  it('keeps every rendered character within local glyph coverage so fallback fonts are unnecessary', () => {
    const cmaps = [400, 500, 600].map((weight) => tables(bundled(`inter-latin-${weight}-normal.woff`)).get('cmap')!);
    const text = makeText({ text: '\n\t•  Café — 80%\n日本語 ✓ 🛋️' });
    expect(text.text).toContain('•  Café — 80%');
    expect(text.text).not.toContain('?');
    for (const cmap of cmaps) for (const [index, char] of Array.from(text.text).entries()) {
      expect(glyphId(cmap, char) > 0 || (index > 0 && /\s/u.test(char))).toBe(true);
    }
    // Check the complete BMP in chunks, including combining marks and format characters.
    const rendered = new Set<string>();
    for (let start = 0; start < 0x10000; start += 128) {
      setText(text, Array.from({ length: 128 }, (_, offset) => String.fromCharCode(start + offset)).join(''));
      for (const char of text.text) if (!/\s/u.test(char)) rendered.add(char);
    }
    for (const cmap of cmaps) for (const char of rendered) expect(glyphId(cmap, char), `U+${char.codePointAt(0)!.toString(16)}`).toBeGreaterThan(0);
    text.dispose();
  });
});

it('fits a long wrapped sentence inside both its width and height and restores the scale for short text', () => {
  const text = makeText({ text: 'Connect a companion.', maxWidth: 0.36, maxHeight: 0.105, anchorY: 'top' });
  text.textRenderInfo = { blockBounds: [0, -0.21, 0.4, 0] };
  const sentence = 'Connect the synthesizer to your Mac with USB-C, open the companion app, and make sure its MIDI port is available before setting up the controls. The headset will confirm when the companion is connected.';
  setText(text, sentence);
  expect(text.text).toBe(sentence);
  expect(text.scale.y * 0.21).toBeCloseTo(0.105);
  expect(text.scale.x * 0.4).toBeLessThanOrEqual(0.36);
  text.textRenderInfo = { blockBounds: [0, -0.02, 0.1, 0] };
  setText(text, 'Connected.');
  expect(text.scale.x).toBe(1);
  text.dispose();
});

it('renders remote button English meanings and never substitutes missing CJK glyphs', () => {
  const text = makeText({ text: 'Press 全灯 (full on) once' });
  expect(text.text).toBe('Press the "full on" button once');
  setText(text, '消灯 (off)'); expect(text.text).toBe('off');
  setText(text, '全灯'); expect(text.text).toBe('full on');
  setText(text, '名前のない装置'); expect(text.text).toBe('Device');
  expect(text.text).not.toMatch(/[?\p{Script=Han}]/u);
  text.dispose();
});
