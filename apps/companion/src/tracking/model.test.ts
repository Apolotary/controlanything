import { describe, expect, it } from 'vitest';
import { zipStore } from '../../../quest/src/replay/zip';
import {
  HAND_BONES, JOINT_NAMES, MAX_ARCHIVE_BYTES, createDemoTake, exportTrackingJsonl, loadTrackingBytes,
  loadTrackingFile, parseTrackingJsonl, projectPoint, sampleAt, trackingStats, worldToHead,
} from './model';

const q = { x: 0, y: 0, z: 0, w: 1 };
const head = { position: { x: 0, y: 1.6, z: 0 }, orientation: q };
const joint = { position: { x: 0.1, y: 1.3, z: -0.4 }, orientation: q, radius: 0.01 };
const meta = { kind: 'meta', v: 1, take: 'test-take', startedAt: 1, app: 'test', device: { kind: 'quest', name: 'Quest' }, space: 'local-floor',
  tracking: { source: 'webxr', sampleRateHz: 30, jointConvention: 'webxr-hand-25', units: 'meters', axes: 'right-handed-y-up-negative-z-forward' } };
const tracked = { source: 'hand', joints: { wrist: joint, 'index-finger-tip': joint }, pinching: false };
const untracked = { source: 'untracked', joints: {}, pinching: false };
const row = (t: number, extra = {}) => ({ kind: 'pose', t, head, hands: { left: tracked, right: untracked }, spaceId: 1, ...extra });
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n');
const parse = (rows: unknown[], metadata: unknown = meta) => parseTrackingJsonl(jsonl([metadata, ...rows]));
const encode = (s: string) => new TextEncoder().encode(s);

describe('recorded tracking model', () => {
  it('represents WebXR 25 joint names and all five wrist-to-finger chains without crossing fingers', () => {
    expect(JOINT_NAMES).toHaveLength(25);
    expect(new Set(JOINT_NAMES).size).toBe(25);
    expect(HAND_BONES).toHaveLength(24);
    expect(HAND_BONES.filter(([a]) => a === 'wrist')).toHaveLength(5);
    expect(HAND_BONES).toContainEqual(['thumb-phalanx-distal', 'thumb-tip']);
    expect(HAND_BONES).toContainEqual(['pinky-finger-phalanx-distal', 'pinky-finger-tip']);
  });

  it('loads legacy head-only takes without fabricating hands or assigning WebXR provenance', () => {
    const { tracking: _tracking, ...legacy } = meta;
    const take = parse([{ kind: 'pose', t: 0, head }], legacy);
    expect(take.samples[0].head).toEqual(head);
    expect(take.samples[0].hands).toEqual({ left: untracked, right: untracked });
    expect(take.meta.tracking).toBeUndefined();
    expect(take.warnings.join(' ')).toContain('Legacy');
  });

  it('rejects unsupported units/axes/version and malformed headers with useful errors', () => {
    expect(() => parse([row(0)], { ...meta, v: 99 })).toThrow('version');
    expect(() => parse([row(0)], { ...meta, tracking: { ...meta.tracking, units: 'millimeters' } })).toThrow('coordinates');
    expect(() => parseTrackingJsonl(jsonl([row(0)]))).toThrow('metadata');
    expect(() => parse([meta, row(0)])).toThrow('more than one');
    expect(() => parseTrackingJsonl(jsonl([meta]) + '\nnot-json')).toThrow('line 2');
    expect(() => parse([], meta)).toThrow('no head or hand');
  });

  it('marks bad head quaternions and malformed joints missing, discards unknown joints, and never turns a controller into a hand', () => {
    const take = parse([row(0, {
      head: { ...head, orientation: { x: 0, y: 0, z: 0, w: 0 } },
      hands: {
        left: { ...tracked, joints: { wrist: joint, fake: joint, 'thumb-tip': { ...joint, position: { x: 2e20, y: 0, z: 0 } }, 'index-finger-tip': { ...joint, radius: -1 } } },
        right: { source: 'controller', joints: { wrist: joint }, pinching: true },
      },
    })]);
    expect(take.samples[0].head).toBeNull();
    expect(Object.keys(take.samples[0].hands.left.joints)).toEqual(['wrist']);
    expect(take.samples[0].hands.right).toEqual({ source: 'controller', joints: {}, pinching: true });
    expect(take.warnings.join(' ')).toContain('invalid head');
  });

  it('sorts samples, keeps final duplicates and never holds more than 100 ms or returns a future pose', () => {
    const take = parse([row(500), row(0), row(33), row(33, { head: null })]);
    expect(take.samples.map((s) => s.t)).toEqual([0, 33, 500]);
    expect(sampleAt(take, -1)).toBeNull();
    expect(sampleAt(take, 33)?.head).toBeNull();
    expect(sampleAt(take, 133)?.t).toBe(33);
    expect(sampleAt(take, 134)).toBeNull();
    expect(sampleAt(take, 300, 10_000)).toBeNull();
    expect(sampleAt(take, 501)).toBeNull();
    expect(sampleAt(take, Number.NaN)).toBeNull();
  });

  it('respects lost hands and space resets instead of interpolating poses across them', () => {
    const take = parse([row(0), row(33, { hands: { left: untracked, right: untracked } }), row(66, { spaceId: 2, head: null })]);
    expect(sampleAt(take, 50)?.hands.left.source).toBe('untracked');
    expect(sampleAt(take, 66)).toMatchObject({ spaceId: 2, head: null });
    expect(trackingStats(take).spaces).toBe(2);
  });

  it('stops holding a legacy sample immediately at an explicit space boundary and preserves its reason', () => {
    const take = parse([row(0), { kind: 'input', t: 40, input: { type: 'space', spaceId: 2, reason: 'reference-reset' } }, row(100, { spaceId: 2 })]);
    expect(sampleAt(take, 39)?.spaceId).toBe(1);
    expect(sampleAt(take, 40)).toBeNull();
    expect(sampleAt(take, 99)).toBeNull();
    expect(sampleAt(take, 100)?.spaceId).toBe(2);
    expect(trackingStats(take).headCoverage).toBeCloseTo(0.4);
    const reimport = parseTrackingJsonl(exportTrackingJsonl(take));
    expect(reimport.events[0].data).toEqual({ spaceId: 2, reason: 'reference-reset' });
    expect(sampleAt(reimport, 40)).toBeNull();
  });

  it('computes duration-weighted coverage including missing intervals, rather than claiming complete tracking from sparse samples', () => {
    const take = parse([row(0), row(50), row(900)], { ...meta, durationMs: 1000 });
    const stats = trackingStats(take);
    expect(stats.headCoverage).toBeCloseTo(0.25);
    expect(stats.leftCoverage).toBeCloseTo(0.25);
    expect(stats.rightCoverage).toBe(0);
    expect(stats.rateHz).toBe(20);
  });

  it('transforms world coordinates with inverse head rotation and projects -Z forward with image Y down', () => {
    const rotatedHead = { position: { x: 1, y: 2, z: 3 }, orientation: { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 } };
    const p = worldToHead({ x: 0, y: 2, z: 3 }, rotatedHead);
    expect(p.x).toBeCloseTo(0); expect(p.y).toBeCloseTo(0); expect(p.z).toBeCloseTo(-1);
    const k = { width: 640, height: 480, fx: 400, fy: 400, cx: 320, cy: 240 };
    expect(projectPoint({ x: 0.1, y: 1.7, z: -1 }, head, k)).toMatchObject({ x: 360, depth: 1 });
    expect(projectPoint({ x: 0.1, y: 1.7, z: -1 }, head, k)?.y).toBeCloseTo(200);
    expect(projectPoint({ x: 0, y: 1.6, z: 1 }, head, k)).toBeNull();
  });

  it('exports actual safe interaction timing while excluding authentication, raw commands, and voice text', () => {
    const take = parse([
      row(0), { kind: 'input', t: 20, input: { type: 'hack', actionId: 'cutoff', value: 0.6, token: 'PRIVATE', prompt: 'PRIVATE' } },
      { t: 30, dir: 'in', msg: { type: 'exec.command', payload: { execId: 'exec-1', actionId: 'cutoff', dryRun: true, op: { bytes: 'PRIVATE' } } } },
      { t: 50, dir: 'out', msg: { type: 'exec.ack', payload: { execId: 'exec-1', ok: true, detail: 'PRIVATE' } } },
      row(100),
    ]);
    const output = exportTrackingJsonl(take);
    expect(output).not.toContain('PRIVATE');
    expect(take.events).toHaveLength(3);
    expect(take.events[2]).toMatchObject({ t: 50, label: 'Transport acknowledged', data: { execId: 'exec-1', ok: true } });
    expect(output).toContain('do not prove a physical effect');
    const reimported = parseTrackingJsonl(output);
    expect(reimported.samples).toEqual(take.samples);
    expect(reimported.events).toEqual(take.events);
  });

  it('exports the synthetic example with unmistakable provenance and an explicit tracking gap', () => {
    const take = createDemoTake();
    expect(take.demo).toBe(true);
    expect(Object.keys(take.samples[0].hands.left.joints)).toHaveLength(25);
    expect(sampleAt(take, 3400)?.hands.left.source).toBe('untracked');
    const output = exportTrackingJsonl(take);
    expect(output).toContain('"synthetic":true');
    expect(output).toContain('synthetic-demo');
    expect(parseTrackingJsonl(output).demo).toBe(true);
  });
});

describe('bounded local recording import', () => {
  const video = { file: 'video.webm', mimeType: 'video/webm', width: 640, height: 480, startOffsetMs: 25, durationMs: 100, alignment: 'approximate', cameraExtrinsics: 'uncalibrated' };
  const archive = (metadata: unknown = { ...meta, video }, extras = [{ name: 'take/video.webm', data: new Uint8Array([1, 2, 3]) }]) => zipStore([
    { name: 'take/session.jsonl', data: encode(jsonl([metadata, row(0), row(100)])) }, ...extras,
  ]);

  it('loads a take ZIP and its referenced video without executing or fetching anything', async () => {
    const take = await loadTrackingBytes(archive(), 'take.zip');
    expect(take.video?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(take.meta.video).toMatchObject({ startOffsetMs: 25, cameraExtrinsics: 'uncalibrated' });
    const exported = parseTrackingJsonl(exportTrackingJsonl(take, { videoOffsetMs: -200 }));
    expect(exported.meta.video?.startOffsetMs).toBe(-200);
  });

  it('keeps telemetry useful when video is absent, and accepts JSONL alone', async () => {
    const take = await loadTrackingBytes(archive(undefined, []), 'take.zip');
    expect(take.video).toBeUndefined();
    expect(take.warnings.join(' ')).toContain('video is missing');
    const textOnly = await loadTrackingBytes(encode(jsonl([meta, row(0)])), 'session.jsonl');
    expect(textOnly.samples).toHaveLength(1);
  });

  it('rejects unreadable ZIPs, duplicates, traversal paths, corrupt checksums, and ambiguous sessions', async () => {
    await expect(loadTrackingBytes(new Uint8Array([1, 2]), 'bad.zip')).rejects.toThrow('supported ZIP');
    await expect(loadTrackingBytes(archive(meta, [{ name: 'take/session.jsonl', data: encode('') }]), 'take.zip')).rejects.toThrow('duplicate');
    await expect(loadTrackingBytes(archive(meta, [{ name: '../escape.webm', data: new Uint8Array() }]), 'take.zip')).rejects.toThrow('file path');
    await expect(loadTrackingBytes(archive(meta, [{ name: 'two/session.jsonl', data: encode(jsonl([meta, row(0)])) }]), 'take.zip')).rejects.toThrow('exactly one');
    const corrupt = archive(); corrupt[30 + 'take/session.jsonl'.length + 10] ^= 1;
    await expect(loadTrackingBytes(corrupt, 'take.zip')).rejects.toThrow('checksum');
  });

  it('rejects declared expansion bombs before inflation and oversized files before reading', async () => {
    const bomb = archive(), view = new DataView(bomb.buffer);
    for (let i = 0; i < bomb.length - 46; i++) {
      if (view.getUint32(i, true) === 0x02014b50) { view.setUint32(i + 24, MAX_ARCHIVE_BYTES + 1, true); break; }
    }
    await expect(loadTrackingBytes(bomb, 'bomb.zip')).rejects.toThrow('128 MB');
    let read = false;
    await expect(loadTrackingFile({ name: 'big.zip', size: MAX_ARCHIVE_BYTES + 1, arrayBuffer: async () => { read = true; return new ArrayBuffer(0); } })).rejects.toThrow('128 MB');
    expect(read).toBe(false);
  });
});
