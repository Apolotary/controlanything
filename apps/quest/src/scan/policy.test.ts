import { describe, expect, it } from 'vitest';
import { annotationFadeMs, annotationRange, annotationVisible, inAnnotationRange, matchesAnnotationFilter } from './policy';
import { allowedClasses, CATEGORIES } from './yolo/classes';

const head = { x: 0, y: 1.6, z: 0 };
const target = { label: 'Ceiling light', score: 0.9, position: { x: 0, y: 1.6, z: -2 }, lastSeenAt: 1000 };

describe('annotation policy', () => {
  it('offers All, Lights and Electronics, with every device class included by default', () => {
    expect(CATEGORIES.map((category) => category.label)).toEqual(['All', 'Lights', 'Electronics']);
    for (const label of ['TV', 'laptop', 'cell phone', 'remote', 'keyboard', 'synthesizer', 'mouse', 'speakers', 'ceiling light', 'microwave']) {
      expect(matchesAnnotationFilter(label)).toBe(true);
    }
  });

  it('keeps lights separate from electronics and appliances exclusive to All', () => {
    for (const label of ['TV', 'computer', 'phone', 'remote', 'keyboard', 'synthesizer', 'speaker']) {
      expect(matchesAnnotationFilter(label, 'electronics')).toBe(true);
      expect(matchesAnnotationFilter(label, 'lights')).toBe(false);
    }
    for (const label of ['ceiling light', 'smart lamp', 'electronic light']) {
      expect(matchesAnnotationFilter(label, 'lights')).toBe(true);
      expect(matchesAnnotationFilter(label, 'electronics')).toBe(false);
    }
    expect(matchesAnnotationFilter('microwave', 'electronics')).toBe(false);
    expect(matchesAnnotationFilter('microwave', 'lights')).toBe(false);
    expect(allowedClasses('electronics').has(68)).toBe(false);
    expect(allowedClasses('everything').has(68)).toBe(true);
  });

  it('excludes people, body parts, and scenery from every filter', () => {
    for (const category of CATEGORIES) for (const label of ['person', 'person holding a phone', 'hand', 'wall', 'chair']) {
      expect(matchesAnnotationFilter(label, category.id)).toBe(false);
      expect(allowedClasses(category.id).has(0)).toBe(false);
    }
  });

  it('accepts an explicit positive range and includes only positions within that head distance', () => {
    for (const value of [null, '', '-1', '0', 'Infinity', 'oops']) expect(annotationRange(value)).toBe(3);
    expect(annotationRange('1.5')).toBe(1.5);
    expect(inAnnotationRange({ x: 0, y: 1.6, z: -3 }, head)).toBe(true);
    expect(inAnnotationRange({ x: 0.1, y: 1.6, z: -3 }, head)).toBe(false);
    expect(inAnnotationRange({ x: NaN, y: 1.6, z: -2 }, head)).toBe(false);
  });

  it('expires transient detections at 400 ms but keeps an explicitly tagged anchor', () => {
    expect(annotationVisible(target, head, 'everything', 1399)).toBe(true);
    expect(annotationVisible(target, head, 'everything', 1400)).toBe(false);
    expect(annotationVisible({ ...target, score: 0.49 }, head, 'everything', 1000)).toBe(false);
    expect(annotationVisible({ ...target, score: 0.5 }, head, 'everything', 1000)).toBe(true);
    expect(annotationVisible(target, head, 'electronics', 1000)).toBe(false);
    expect(annotationVisible(target, head, 'electronics', 10_000, 3, true)).toBe(true);
  });

  it('keeps SAM-only boxes for one scan cycle and live YOLO boxes for 0.4 s', () => {
    expect(annotationFadeMs(true)).toBe(400);
    expect(annotationFadeMs(false)).toBeGreaterThanOrEqual(3000);
  });
});
