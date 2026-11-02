import { describe, expect, it } from 'vitest';
import { annotationRange, annotationVisible, inAnnotationRange, matchesAnnotationFilter } from './policy';
import { allowedClasses, CATEGORIES } from './yolo/classes';

const head = { x: 0, y: 1.6, z: 0 };
const target = { label: 'Ceiling light', score: 0.9, position: { x: 0, y: 1.6, z: -2 }, lastSeenAt: 1000 };

describe('annotation policy', () => {
  it('offers the three device filters and defaults to nearby electronics including lamps and synths', () => {
    expect(CATEGORIES.map((category) => category.label)).toEqual(['Electronics', 'Lights', 'All devices']);
    for (const label of ['TV', 'laptop', 'cell phone', 'remote', 'keyboard', 'synthesizer', 'mouse', 'speakers', 'ceiling light']) {
      expect(matchesAnnotationFilter(label)).toBe(true);
    }
    expect(matchesAnnotationFilter('microwave')).toBe(false);
    expect(matchesAnnotationFilter('microwave', 'everything')).toBe(true);
    expect(allowedClasses('electronics').has(68)).toBe(false);
    expect(allowedClasses('everything').has(68)).toBe(true);
    expect(matchesAnnotationFilter('Ceiling light', 'lights')).toBe(true);
    expect(matchesAnnotationFilter('Laptop', 'lights')).toBe(false);
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
    expect(annotationVisible(target, head, 'electronics', 1399)).toBe(true);
    expect(annotationVisible(target, head, 'electronics', 1400)).toBe(false);
    expect(annotationVisible({ ...target, score: 0.49 }, head, 'electronics', 1000)).toBe(false);
    expect(annotationVisible({ ...target, score: 0.5 }, head, 'electronics', 1000)).toBe(true);
    expect(annotationVisible(target, head, 'electronics', 10_000, 3, true)).toBe(true);
  });
});
