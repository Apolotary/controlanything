import { describe, expect, it } from 'vitest';
import { allowedClasses, CATEGORIES, PERSON_CLASS } from './classes';
import { anchorCount, decodeYolox, dropLaptopKeyboards, nms, postprocess, type Candidate } from './post';
import { letterbox, PAD_VALUE, rgbaToBgrChw, toSource } from './prep';
import { BoxTracker, trackOpacity } from './tracker';

function anchor(cls: number, other?: number): Float32Array {
  const out = new Float32Array(85);
  out.set([1, 1, Math.log(2), Math.log(2), 0.9]);
  out[5 + cls] = 0.95;
  if (other !== undefined) out[5 + other] = 0.85;
  return out;
}

const options = { inputSize: 8, strides: [8], scoreThreshold: 0.3, allowed: allowedClasses('everything') };
const laptop: Candidate = { cls: 63, score: 0.9, box: [0, 0, 100, 80] };

describe('YOLOX input and class filtering', () => {
  it('letterboxes without stretching and maps boxes back to source pixels', () => {
    const lb = letterbox(1280, 960, 416);
    expect([lb.width, lb.height]).toEqual([416, 312]);
    expect(toSource([0, 0, 416, 416], lb)).toEqual([0, 0, 1280, 960]);
    expect(anchorCount(416)).toBe(3549);
  });

  it('packs BGR channels and uses 114 padding in a reusable tensor', () => {
    const lb = letterbox(2, 1, 2);
    const out = new Float32Array(12);
    expect(rgbaToBgrChw(new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255]), lb, out)).toBe(out);
    expect([...out]).toEqual([30, 60, PAD_VALUE, PAD_VALUE, 20, 50, PAD_VALUE, PAD_VALUE, 10, 40, PAD_VALUE, PAD_VALUE]);
  });

  it('decodes device boxes and excludes people from every category', () => {
    const box = decodeYolox(anchor(63), options).devices[0]!.box;
    [0, 0, 16, 16].forEach((value, i) => expect(box[i]).toBeCloseTo(value, 5));
    for (const c of CATEGORIES) expect(allowedClasses(c.id).has(PERSON_CLASS)).toBe(false);
  });

  it('drops a person-dominant anchor instead of relabeling it as a device', () => {
    expect(decodeYolox(anchor(0, 63), { ...options, allowed: new Set([0, 63]) }).devices).toEqual([]);
  });

  it('enforces device classes even if the caller requests other COCO classes', () => {
    expect(postprocess(anchor(56), { ...options, allowed: new Set([56]) })).toEqual([]);
  });

  it('drops non-finite model coordinates', () => {
    const out = anchor(63);
    out[2] = Infinity;
    expect(postprocess(out, options)).toEqual([]);
  });
});

describe('YOLOX NMS and tracking', () => {
  it('keeps the strongest box per object and retains distant devices', () => {
    const close: Candidate = { ...laptop, score: 0.6, box: [2, 0, 100, 80] };
    const far: Candidate = { ...laptop, box: [200, 0, 100, 80] };
    expect(nms([close, far, laptop], 0.45)).toEqual([far, laptop]);
  });

  it('suppresses a laptop keyboard but keeps a separate keyboard', () => {
    const builtIn: Candidate = { cls: 66, score: 0.8, box: [5, 40, 90, 35] };
    const separate: Candidate = { ...builtIn, box: [110, 0, 90, 35] };
    expect(dropLaptopKeyboards([laptop, builtIn, separate])).toEqual([laptop, separate]);
  });

  it('smooths movement, preserves ids through brief misses and stabilizes class votes', () => {
    const tracker = new BoxTracker();
    const first = tracker.update([laptop], 0).tracks[0]!;
    tracker.update([{ ...laptop, cls: 66, box: [4, 0, 100, 80] }], 100);
    expect(first.cls).toBe(63);
    tracker.update([{ ...laptop, box: [4, 0, 100, 80] }], 200);
    expect(first.cls).toBe(63);
    expect(first.box[0]).toBeGreaterThan(0);
    expect(first.box[0]).toBeLessThan(4);
    tracker.update([], 400);
    expect(tracker.update([laptop], 550).tracks[0]?.id).toBe(first.id);
    expect(tracker.update([], 950).removed[0]?.id).toBe(first.id);
  });

  it('waits at least 150 ms before showing even a very confident detection', () => {
    const tracker = new BoxTracker();
    const detection = { ...laptop, score: 0.99 };
    const first = tracker.update([detection], 0).tracks[0]!;
    expect(first.live).toBe(false);
    expect(first.opacity).toBe(0);
    tracker.update([detection], 70);
    tracker.update([detection], 140);
    expect(first.live).toBe(false);
    tracker.update([detection], 150);
    expect(first.live).toBe(true);
    expect(first.opacity).toBe(1);
  });

  it('coasts and fades independently of inference, then expires after 400 ms unseen', () => {
    const tracker = new BoxTracker();
    tracker.update([laptop], 0);
    const track = tracker.update([laptop], 150).tracks[0]!;
    expect(trackOpacity(track, 350)).toBe(1);
    expect(trackOpacity(track, 450)).toBe(0.5);
    expect(tracker.age(450)).toEqual([]);
    expect(track.opacity).toBe(0.5);
    expect(tracker.age(550)).toEqual([track]);
    expect(tracker.list()).toEqual([]);
    expect(trackOpacity(track, 600)).toBe(0);
  });

  it('keeps a selected track while SAM is pending, then lets it expire when released', () => {
    const tracker = new BoxTracker();
    tracker.update([laptop], 0);
    const track = tracker.update([laptop], 150).tracks[0]!;
    expect(tracker.age(1000, track.id)).toEqual([]);
    expect(track.opacity).toBe(1);
    expect(tracker.age(1001)).toEqual([track]);
  });

  it('confirms across a slow sampling gap while still fading unseen boxes at 400 ms', () => {
    const tracker = new BoxTracker();
    const retentionMs = 1500;
    const track = tracker.update([laptop], 0, undefined, undefined, retentionMs).tracks[0]!;
    expect(tracker.age(400, undefined, retentionMs)).toEqual([]);
    expect(track.opacity).toBe(0);
    expect(track.live).toBe(false);
    const confirmed = tracker.update([laptop], 600, undefined, undefined, retentionMs).tracks[0]!;
    expect(confirmed.id).toBe(track.id);
    expect(confirmed.live).toBe(true);
    expect(confirmed.opacity).toBe(1);
    expect(tracker.age(1000, undefined, retentionMs)).toEqual([]);
    expect(confirmed.opacity).toBe(0);
    expect(tracker.update([laptop], 1200, undefined, undefined, retentionMs).tracks[0]?.id).toBe(track.id);
    expect(confirmed.opacity).toBe(1);
    expect(tracker.age(2700, undefined, retentionMs)).toEqual([track]);
  });

  it('never revives an expired id and suppresses duplicate classes for one object', () => {
    const tracker = new BoxTracker();
    const first = tracker.update([laptop, { ...laptop, cls: 66, score: 0.7, box: [2, 0, 100, 80] }], 0);
    expect(first.tracks).toHaveLength(1);
    const next = tracker.update([laptop], 500);
    expect(next.removed[0]?.id).toBe(first.tracks[0]?.id);
    expect(next.tracks[0]?.id).not.toBe(first.tracks[0]?.id);
    expect(next.tracks[0]?.live).toBe(false);
  });

  it('drops people at the tracker boundary and defaults to five tracks', () => {
    const tracker = new BoxTracker();
    expect(tracker.update([{ ...laptop, cls: PERSON_CLASS }], 0).tracks).toEqual([]);
    const detections: Candidate[] = Array.from({ length: 10 }, (_, i) => ({ ...laptop, box: [i * 200, 0, 100, 80] }));
    expect(tracker.update(detections, 100).tracks).toHaveLength(5);
  });

  it('uses capture-pose prediction to match a device after head movement', () => {
    const tracker = new BoxTracker();
    const first = tracker.update([laptop], 0).tracks[0]!;
    const shifted: Candidate = { ...laptop, box: [200, 0, 100, 80] };
    expect(tracker.update([shifted], 100, () => shifted.box).tracks[0]?.id).toBe(first.id);
    expect(tracker.list()).toHaveLength(1);
  });

  it('rejects tentative one-frame noise and caps the total track count', () => {
    const tracker = new BoxTracker({ maxTracks: 2 });
    expect(tracker.update([{ ...laptop, score: 0.4 }], 0).tracks[0]?.live).toBe(false);
    expect(tracker.update([], 100).tracks).toEqual([]);
    expect(tracker.update([0, 200, 400].map((x) => ({ ...laptop, box: [x, 0, 100, 80] })), 200).tracks).toHaveLength(2);
  });
});
