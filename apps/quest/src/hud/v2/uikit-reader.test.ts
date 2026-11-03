import { describe, expect, it, vi } from 'vitest';
import { type WebGLRenderer } from 'three';
import { configureAssistantRenderer, needsSystemReaderFont, UIKitReader } from './uikit-reader';
import { readingPages } from './assistant-panel';
import readerFont from '../../../public/fonts/muse-reader-inter.json';

describe('spatial reading surface', () => {
  it('uses local punctuation glyphs and deliberately falls back for unsupported scripts', () => {
    expect(needsSystemReaderFont('“Muse” — €20 × 2… • café')).toBe(false);
    expect(needsSystemReaderFont('日本語の本')).toBe(true);
    expect(needsSystemReaderFont('Синтезатор')).toBe(true);
  });

  it('never cuts a surrogate pair or emoji sequence at a reading-page boundary', () => {
    const content = '👩‍🚀'.repeat(90);
    const pages = readingPages(content);
    expect(pages.join('').replace(/\s/g, '')).toBe(content);
    expect(pages.every((page) => !page.includes('\ufffd'))).toBe(true);
  });

  it('budgets for two measured lines per worst-width source line', () => {
    // The local atlas W/emdash can wrap a 32-character source line once at
    // 16.5mm. Twelve UIKit lines at125% fit the264mm content viewport.
    for (const word of ['W'.repeat(500), '本'.repeat(500), 'https://example.com/' + 'W'.repeat(500)]) {
      const pages = readingPages(word);
      expect(pages.every((page) => page.split('\n').length <= 6)).toBe(true);
      expect(pages.every((page) => page.split('\n').every((line) => Array.from(line).length <= 32))).toBe(true);
      expect(pages.join('').replace(/\s/g, '')).toBe(word);
    }
    const widestGlyph = Math.max(...readerFont.chars.map((glyph) => glyph.xadvance)) / readerFont.info.size * 16.5;
    const charactersPerLine = Math.floor(364 / widestGlyph);
    const wrappedLines = 6 * Math.ceil(32 / charactersPerLine);
    expect(wrappedLines * 16.5 * 1.25).toBeLessThan(264);
  });
  it('retains every word across long request pages without shrinking the reading size', () => {
    const request = 'Please create a water ripple controlled by my hand moving forward and backward. '.repeat(30);
    const reader = new UIKitReader();
    const observed: string[] = [];
    for (const page of readingPages(request)) {
      reader.setText(page); reader.updateUi(16);
      observed.push(reader.text);
      expect(reader.scale.toArray()).toEqual([1, 1, 1]);
      expect(reader.layout.height).toBe(0.28);
    }
    expect(observed.join('').replace(/\s/g, '')).toBe(request.replace(/\s/g, ''));
    reader.disposeUi(); reader.disposeUi();
    expect(reader.children).toHaveLength(0);
  });

  it('retains explicit legacy HUD layer precedence under UIKit transparent sorting', () => {
    const setTransparentSort = vi.fn();
    const renderer = { localClippingEnabled: false, setTransparentSort } as unknown as WebGLRenderer;
    configureAssistantRenderer(renderer);
    const compare = setTransparentSort.mock.calls[0]![0] as (a: unknown, b: unknown) => number;
    // Large plates must not leap over button/text layers as depth changes.
    const plate = { groupOrder: 0, renderOrder: 20, z: -0.2, id: 3, object: {} };
    const button = { groupOrder: 0, renderOrder: 22, z: 3, id: 2, object: {} };
    const text = { groupOrder: 0, renderOrder: 24, z: 8, id: 1, object: {} };
    expect(compare(plate, button)).toBeLessThan(0);
    expect(compare(button, text)).toBeLessThan(0);
    expect(renderer.localClippingEnabled).toBe(true);
  });
});
