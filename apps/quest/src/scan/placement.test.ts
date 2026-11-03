import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { Det } from '../io/v1';
import { aimAt, touching } from './aim';
import type { FrameRecord } from './capture';
import { type DepthProvider, placeDetection, rejectReason } from './placement';
import { cameraPoseFromHead, QUEST3_1280x960, rayPlane, worldToPixel } from './projection';
import { displayLabel, TargetStore, toHudTarget } from './targets';

function record(extra: Partial<FrameRecord> = {}): FrameRecord {
  const head = { position: new Vector3(0, 1.6, 0), quaternion: new Quaternion() };
  return {
    frameId: 'f1',
    purpose: 'scan',
    source: 'synthetic',
    capturedAt: 0,
    tCapture: 0,
    width: 1280,
    height: 960,
    intrinsics: { ...QUEST3_1280x960 },
    head,
    cam: cameraPoseFromHead(head, 'left'),
    speedDeg: 0,
    handJoints: [],
    bytes: 0,
    ...extra,
  };
}

/** A wall 2 m in front of the head. */
const wall: DepthProvider = {
  name: 'wall',
  async hit(ray) {
    const p = rayPlane(ray, new Vector3(0, 0, -2), new Vector3(0, 0, 1));
    return p ? { point: p, normal: new Vector3(0, 0, 1) } : null;
  },
};

const det = (over: Partial<Det> = {}): Det => ({ detId: 'd1', label: 'synthesizer', prompt: 'synthesizer', score: 0.9, box: [560, 420, 160, 120], ...over });

describe('placeDetection', () => {
  it('lands on the depth provider along the capture ray and projects back onto the box centre', async () => {
    const rec = record();
    const pl = await placeDetection(det(), rec, [wall]);
    expect(pl.confirmed).toBe(true);
    expect(pl.method).toBe('wall');
    expect(pl.position.z).toBeCloseTo(-2, 6);
    const px = worldToPixel(pl.position, rec.intrinsics, rec.cam)!;
    expect(px.u).toBeCloseTo(640, 4);
    expect(px.v).toBeCloseTo(480, 4);
    // 160 px at ~1.94 m along the axis ≈ 0.36 m wide
    expect(pl.sizeM[0]).toBeGreaterThan(0.3);
    expect(pl.sizeM[0]).toBeLessThan(0.4);
    expect(pl.contour).toHaveLength(4);
  });

  it('falls back to a size prior (unconfirmed) when nothing is hit', async () => {
    const pl = await placeDetection(det({ label: 'ceiling light', box: [600, 50, 200, 100] }), record(), []);
    expect(pl.confirmed).toBe(false);
    expect(pl.method).toBe('size-prior');
    expect(pl.depth).toBeCloseTo((868.31 * 0.5) / 200, 6);
    expect(pl.position.y).toBeGreaterThan(1.6); // a ceiling light is above the head
  });
});

describe('rejectReason (devices only)', () => {
  it('drops people and body parts', () => {
    expect(rejectReason(det({ label: 'person' }), record())).toMatch(/person/);
    expect(rejectReason(det({ label: 'hand', prompt: 'hand' }), record())).toMatch(/person/);
  });
  it('drops walls (over 60 % of the frame)', () => {
    expect(rejectReason(det({ box: [0, 0, 1200, 900] }), record())).toMatch(/60/);
  });
  it('accepts an object filling a deliberately cropped area but still excludes people', () => {
    const rec = record({ region: [0.25, 0.25, 0.75, 0.75] });
    expect(rejectReason(det({ box: [0, 0, 1200, 900] }), rec)).toBeNull();
    expect(rejectReason(det({ label: 'hand', prompt: 'hand', box: [0, 0, 1200, 900] }), rec)).toMatch(/person/);
  });
  it('keeps held devices when a hand covers only their middle', () => {
    const rec = record();
    // 15 joints projected into the middle of the box
    const p = new Vector3(0, 0, -1).applyQuaternion(rec.cam.quaternion).multiplyScalar(0.5).add(rec.cam.position);
    const joints = Array.from({ length: 15 }, () => p.clone());
    const withHand = record({ handJoints: joints });
    expect(rejectReason(det({ label: 'electronic device', box: [540, 380, 200, 200] }), withHand)).toBeNull();
    expect(rejectReason(det({ label: 'remote control', box: [540, 380, 200, 200] }), withHand)).toBeNull();
  });
  it('keeps an ordinary device', () => {
    expect(rejectReason(det(), record())).toBeNull();
  });
});

describe('TargetStore', () => {
  it('uses one short sentence-case label', () => {
    expect(displayLabel('  CEILING   LIGHT  ')).toBe('Ceiling light');
    expect(displayLabel('LAPTOP')).toBe('Laptop');
    expect(displayLabel('')).toBe('Unidentified device');
    expect(displayLabel('electronic device')).toBe('Unidentified device');
    expect(displayLabel('device with screen and keyboard')).toBe('Pocket computer');
    expect(displayLabel('Very long electronic device description').length).toBeLessThanOrEqual(22);
  });

  it('merges repeated detections of the same device and keeps different devices apart', async () => {
    const store = new TargetStore();
    const rec = record();
    const a = await placeDetection(det(), rec, [wall]);
    const first = store.upsert(det(), a, 'f1', 'sam-3.1');
    expect(first.created).toBe(true);
    const b = await placeDetection(det({ detId: 'd9', box: [565, 425, 160, 120] }), rec, [wall]);
    const again = store.upsert(det({ detId: 'd9', box: [565, 425, 160, 120] }), b, 'f2');
    expect(again.created).toBe(false);
    expect(again.target.id).toBe(first.target.id);
    expect(again.target.frameId).toBe('f2');
    expect(again.target.detId).toBe('d9');
    const far = await placeDetection(det({ label: 'laptop', prompt: 'laptop', box: [100, 420, 160, 120] }), rec, [wall]);
    expect(store.upsert(det({ label: 'laptop', prompt: 'laptop', box: [100, 420, 160, 120] }), far, 'f3').created).toBe(true);
    expect(store.list()).toHaveLength(2);
  });

  it('upgrades a generic "electronic device" to the specific label at the same place', async () => {
    const store = new TargetStore();
    const rec = record();
    const generic = det({ label: 'electronic device', prompt: 'electronic device' });
    store.upsert(generic, await placeDetection(generic, rec, [wall]), 'f1');
    const t = store.upsert(det(), await placeDetection(det(), rec, [wall]), 'f2').target;
    expect(store.list()).toHaveLength(1);
    expect(t.label).toBe('synthesizer');
    expect(toHudTarget(t).label).toBe('Synth');
  });

  it('tagging preserves the object anchor and subsequent detections track it smoothly', async () => {
    const store = new TargetStore();
    const rec = record();
    const t = store.upsert(det(), await placeDetection(det(), rec, [wall]), 'f1').target;
    const before = t.position.clone();
    store.refine(t.id, new Vector3(0.01, 1.2, -1.9));
    expect(t.position).toEqual(before);
    const next = await placeDetection(det({ box: [570, 430, 160, 120] }), rec, [wall]);
    store.upsert(det({ box: [570, 430, 160, 120] }), next, 'f2');
    expect(t.position.distanceTo(before)).toBeGreaterThan(0);
    expect(t.position.distanceTo(before)).toBeLessThan(next.position.distanceTo(before));
    expect(t.refined).toBe(true);
  });

  it('a new scan keeps locked/linked targets only', async () => {
    const store = new TargetStore();
    const rec = record();
    const t1 = store.upsert(det(), await placeDetection(det(), rec, [wall]), 'f1').target;
    const lap = det({ label: 'laptop', prompt: 'laptop', box: [100, 420, 160, 120] });
    const t2 = store.upsert(lap, await placeDetection(lap, rec, [wall]), 'f1').target;
    t2.cardId = 'card1';
    const removed = store.clearTransient((t) => Boolean(t.cardId));
    expect(removed).toEqual([t1.id]);
    expect(store.byCard('card1')?.id).toBe(t2.id);
  });

  it('keeps two nearby same-class boxes in a capture separate and respects known device identities', async () => {
    const store = new TargetStore();
    const placement = await placeDetection(det(), record(), [wall]);
    const first = store.upsert(det({ detId: 'one', deviceId: 'one' }), placement, 'f1').target;
    const next = { ...placement, position: placement.position.clone().add(new Vector3(0.12, 0, 0)) };
    const second = store.upsert(det({ detId: 'two', deviceId: 'two' }), next, 'f1').target;
    expect(second.id).not.toBe(first.id);
    // A later detection for another physical device cannot reuse a neighboring target by proximity.
    const third = store.upsert(det({ detId: 'three', deviceId: 'three' }), next, 'f2').target;
    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
    const anonymous = new TargetStore();
    const a = anonymous.upsert(det({ detId: 'one' }), placement, 'f1').target;
    const b = anonymous.upsert(det({ detId: 'two' }), next, 'f1').target;
    expect(a.id).not.toBe(b.id);
  });

  it('selection does not turn a size estimate into measured depth, and a later measurement may improve it', async () => {
    const store = new TargetStore();
    const estimate = await placeDetection(det(), record(), []);
    const target = store.upsert(det(), estimate, 'f1').target;
    store.refine(target.id, new Vector3(0, 0, -0.2));
    expect(target.refined).toBe(true);
    expect(target.confirmed).toBe(false);
    expect(target.method).toBe('size-prior');
    expect(target.position.equals(estimate.position)).toBe(true);
    const measured = { ...estimate, position: estimate.position.clone().add(new Vector3(0, 0, -0.1)), confirmed: true, method: 'hit-test' };
    expect(store.upsert(det(), measured, 'f2').target).toBe(target);
    expect(target.confirmed).toBe(true);
    expect(target.position.equals(measured.position)).toBe(true);
    expect(target.method).toBe('hit-test');
    // Neither the prior depth nor its scaled dimensions may replace that measurement on the next scan.
    store.upsert(det(), { ...estimate, sizeM: [0.5, 0.5, 0.5] }, 'f3');
    expect(target.position.equals(measured.position)).toBe(true);
    expect(target.sizeM).toEqual(measured.sizeM);
  });
});

describe('aim', () => {
  const targets = [
    { id: 'near', position: new Vector3(0, 1.5, -1), size: 0.3 },
    { id: 'light', position: new Vector3(0.4, 2.4, -2), size: 0.5 },
  ];
  it('picks the target on the ray', () => {
    expect(aimAt(new Vector3(0, 1.6, 0), new Vector3(0, -0.1, -1), targets)?.id).toBe('near');
    const toLight = new Vector3(0.4, 0.8, -2).normalize();
    expect(aimAt(new Vector3(0, 1.6, 0), toLight, targets)?.id).toBe('light');
    expect(aimAt(new Vector3(0, 1.6, 0), new Vector3(-1, 0, 0), targets)).toBeNull();
  });
  it('a pinch touches a target within reach', () => {
    expect(touching(new Vector3(0.05, 1.5, -1), targets)?.id).toBe('near');
    expect(touching(new Vector3(0, 1.5, -0.5), targets)).toBeNull();
  });
});
