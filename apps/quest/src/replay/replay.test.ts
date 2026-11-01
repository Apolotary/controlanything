import { describe, expect, it } from 'vitest';
import type { Envelope } from '../io/ws';
import { toBase64 } from '../scan/base64';
import { recordFromPayload } from './player';
import { Recorder } from './recorder';
import { extractJpeg, parseJsonl } from './take';
import { crc32, unzip, zipStore } from './zip';

const env = (type: string, payload: unknown): Envelope => ({ v: 1, type, id: `m-${type}`, ts: 1, from: '', payload });
const jpeg = toBase64(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));

const frame = {
  frameId: 'f1',
  jpeg,
  width: 1280,
  height: 960,
  capturedAt: 1,
  space: 'local-floor',
  pose: { position: { x: 0, y: 1.6, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
  camera: { intrinsics: { fx: 868.31, fy: 868.31, cx: 640.18, cy: 482.07 }, eye: 'left', source: 'synthetic' },
  purpose: 'scan',
};

describe('zip', () => {
  it('crc32 matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('round-trips a STORE archive', async () => {
    const files = [
      { name: 'take/session.jsonl', data: new TextEncoder().encode('{"kind":"meta"}\n') },
      { name: 'take/frames/f1.jpg', data: new Uint8Array([0xff, 0xd8, 9, 9]) },
    ];
    const out = await unzip(zipStore(files));
    expect(out.map((e) => e.name)).toEqual(files.map((f) => f.name));
    expect(Array.from(out[1].data)).toEqual([0xff, 0xd8, 9, 9]);
  });
});

describe('take format', () => {
  it('moves frame JPEGs out of scan.frame and sense.result', () => {
    const a = extractJpeg(env('scan.frame', frame));
    expect(a.files).toEqual([['frames/f1.jpg', jpeg]]);
    expect((a.msg.payload as Record<string, unknown>).jpeg).toBeUndefined();
    expect((a.msg.payload as Record<string, unknown>).jpegFile).toBe('frames/f1.jpg');
    const b = extractJpeg(env('sense.result', { senseId: 's1', kind: 'frame', frame: { ...frame, frameId: 'f2' }, at: 2 }));
    expect(b.files[0][0]).toBe('frames/f2.jpg');
    expect(extractJpeg(env('agent.step', { stepId: 'x' })).files).toEqual([]);
  });

  it('the recorder writes meta first, then messages, poses and inputs; the zip holds the frames', async () => {
    const r = new Recorder();
    r.start({ app: 'quest@test', device: { kind: 'quest', name: 'Quest' }, camera: { width: 1280, height: 960, fx: 868.31, fy: 868.31, cx: 640.18, cy: 482.07 }, space: 'local-floor', take: 'take-test' });
    r.message('out', env('scan.frame', frame));
    r.message('in', env('scan.result', { frameId: 'f1', width: 1280, height: 960, detections: [], modelId: 'sam-3.1', source: 'live', latencyMs: 1500 }));
    r.pose({ position: { x: 0, y: 1.6, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } });
    r.input('lock', { targetId: 'tgt1' });
    r.stop();
    const { meta, lines } = parseJsonl(r.jsonl());
    expect(meta).toMatchObject({ kind: 'meta', v: 1, take: 'take-test', space: 'local-floor' });
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatchObject({ dir: 'out', msg: { type: 'scan.frame', payload: { jpegFile: 'frames/f1.jpg' } } });
    const entries = await unzip(r.toZip());
    expect(entries.map((e) => e.name).sort()).toEqual(['take-test/frames/f1.jpg', 'take-test/session.jsonl']);
  });

  it('a recorded scan.frame becomes a frame record with its own pose and intrinsics', () => {
    const rec = recordFromPayload(frame as never)!;
    expect(rec.frameId).toBe('f1');
    expect(rec.intrinsics).toMatchObject({ fx: 868.31, width: 1280, height: 960 });
    expect(rec.head.position.y).toBeCloseTo(1.6);
    expect(rec.cam.position.x).toBeCloseTo(-0.032, 6); // derived from the head when cameraPose is absent
  });
});
