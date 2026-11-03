import { describe, expect, it } from 'vitest';
import type { Det } from '../io/v1';
import { deduplicateDetections } from './detections';

const det = (detId: string, label: string, box: Det['box'], score = 0.9): Det => ({ detId, label, box, score });

describe('same-capture detection clarity', () => {
  it('keeps the named laptop instead of generic screen/palm-rest crops even with higher generic confidence', () => {
    const laptop = det('laptop', 'laptop', [100, 100, 200, 160], 0.7);
    const generic = det('generic', 'electronic device', [110, 110, 180, 130], 0.99);
    const palmRest = det('palm-rest', 'electronic device', [140, 210, 100, 40], 0.98);
    const result = deduplicateDetections([generic, palmRest, laptop]);
    expect(result.kept).toEqual([laptop]);
    expect(result.suppressed).toEqual([generic, palmRest]);
  });

  it('preserves neighboring devices, overlapping distinct named classes and an uncertain large region', () => {
    const laptop = det('laptop', 'laptop', [100, 100, 200, 160]);
    const phone = det('phone', 'phone', [200, 150, 30, 60]);
    const neighboring = det('unknown', 'electronic device', [310, 110, 100, 80]);
    const broad = det('broad', 'electronic device', [0, 0, 500, 400]);
    expect(deduplicateDetections([laptop, phone, neighboring, broad]).kept).toEqual([laptop, phone, neighboring, broad]);
  });

  it('deduplicates repeated classes and generic synonyms without mutating input order', () => {
    const first = det('first', 'laptop', [100, 100, 200, 160], 0.8);
    const better = det('better', 'LAPTOP', [110, 110, 200, 160], 0.95);
    const generic = det('unknown', 'object', [400, 100, 100, 100]);
    const another = det('another', 'electronic device', [402, 100, 100, 100], 0.7);
    const input = [first, better, generic, another];
    const result = deduplicateDetections(input);
    expect(result.kept).toEqual([better, generic]);
    expect(result.suppressed).toEqual([first, another]);
    expect(input).toEqual([first, better, generic, another]);
  });

  it('does not merge known separate device identities even when their image boxes overlap', () => {
    const a = { ...det('a', 'laptop', [100, 100, 200, 160]), deviceId: 'a', cardId: 'a' };
    const b = { ...a, detId: 'b', deviceId: 'b', cardId: 'b' };
    expect(deduplicateDetections([a, b]).kept).toEqual([a, b]);
  });
});
