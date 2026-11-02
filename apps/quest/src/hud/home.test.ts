import { describe, expect, it } from 'vitest';
import { controlSegmentLabel, homeHint } from './home';

describe('home bar next step', () => {
  it('guides tagging, switching modes and opening a device without stale instructions', () => {
    expect(homeHint('annotate', 0, false)).toBe('Pinch a device to tag it');
    expect(homeHint('annotate', 2, false)).toBe("Switch to Control when you're ready");
    expect(homeHint('control', 2, false)).toBe('Pinch a tagged device to open it');
    expect(homeHint('control', 2, true)).toBe('');
  });
  it('puts the tagged count in the Control segment', () => {
    expect(controlSegmentLabel(0)).toBe('Control');
    expect(controlSegmentLabel(2)).toBe('Control · 2');
  });
});
