import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Recorder, TAKE_DURATION_LIMIT_MS } from './recorder';
import { isPose, loadTake, parseJsonl, type RecordedVideo } from './take';
import { unzip } from './zip';

const meta = { app: 'quest@test', device: { kind: 'quest', name: 'Quest' }, camera: { width: 1280, height: 960, fx: 868, fy: 868, cx: 640, cy: 480 }, space: 'local-floor' as const };
const pose = () => ({ position: { x: 0, y: 1.6, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } });
const video: RecordedVideo = { file: 'video.webm', mimeType: 'video/webm', width: 1280, height: 960, startOffsetMs: 12, durationMs: 1000, clock: 'performance', alignment: 'approximate', cameraExtrinsics: 'uncalibrated' };
let now = 0;
beforeEach(() => { now = 0; vi.useFakeTimers(); vi.spyOn(performance, 'now').mockImplementation(() => now); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('recorded tracking', () => {
  it('copies fresh joints and explicitly records missing head/hands without retaining their last pose', () => {
    const recorder = new Recorder(); recorder.start(meta);
    const joint = { ...pose(), radius: 0.008 };
    recorder.pose(pose(), { left: { joints: { wrist: joint }, pinching: true } });
    joint.position.x = 99;
    now = 40; recorder.pose(null);
    now = 80; recorder.pose(pose(), { right: { joints: { wrist: joint }, pinching: true, controller: true } });
    recorder.stop();
    const lines = parseJsonl(recorder.jsonl()).lines.filter(isPose);
    expect(lines[0].hands?.left).toMatchObject({ source: 'hand', pinching: true, joints: { wrist: { position: { x: 0 } } } });
    expect(lines[1]).toMatchObject({ head: null, hands: { left: { source: 'untracked', joints: {}, pinching: false }, right: { source: 'untracked' } } });
    expect(lines[2].hands?.right).toEqual({ source: 'controller', joints: {}, pinching: false });
  });

  it('marks reference-space boundaries and never serializes invalid joint values', () => {
    const recorder = new Recorder(); recorder.start(meta);
    recorder.pose(pose()); now = 40;
    recorder.spaceBoundary('reference-reset'); now = 80;
    recorder.pose(pose(), { left: { joints: { wrist: { ...pose(), radius: NaN }, 'index-finger-tip': { ...pose(), radius: 0.008 }, unknown: { ...pose(), radius: 0.008 } }, pinching: false } });
    recorder.stop();
    const rows = parseJsonl(recorder.jsonl()).lines;
    expect(rows).toContainEqual({ t: 40, kind: 'input', input: { type: 'space', spaceId: 1, reason: 'reference-reset' } });
    const lines = rows.filter(isPose);
    expect(lines[0].spaceId).toBe(0); expect(lines[1]).toMatchObject({ head: null, spaceId: 1 });
    expect(Object.keys(lines[2].hands!.left.joints)).toEqual(['index-finger-tip']);
  });

  it('samples at a bounded rate and stops on its duration limit without needing animation frames', () => {
    const recorder = new Recorder(); const limit = vi.fn(); recorder.onLimit = limit; recorder.start(meta);
    for (now = 0; now < 1000; now += 10) recorder.pose(pose());
    expect(parseJsonl(recorder.jsonl()).lines.filter(isPose).length).toBeLessThanOrEqual(31);
    now = TAKE_DURATION_LIMIT_MS; vi.advanceTimersByTime(TAKE_DURATION_LIMIT_MS);
    expect(recorder.recording).toBe(false); expect(limit).toHaveBeenCalledOnce();
    expect(parseJsonl(recorder.jsonl()).meta).toMatchObject({ durationMs: TAKE_DURATION_LIMIT_MS, recordingWarnings: [expect.stringContaining('90 second')] });
  });

  it('prevents partial save, preserves video metadata and loads embedded video in a backwards-compatible ZIP', async () => {
    const recorder = new Recorder(); recorder.start({ ...meta, take: 'video-test' });
    expect(() => recorder.toZip()).toThrow('Stop recording');
    now = 1000; recorder.stop();
    recorder.attachVideo(video, new Uint8Array([1, 2, 3]));
    const bytes = recorder.toZip();
    expect((await unzip(bytes)).map((entry) => entry.name)).toEqual(['video-test/session.jsonl', 'video-test/video.webm']);
    const loaded = await loadTake(bytes);
    expect(loaded.meta.video).toEqual(video); expect(loaded.video).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('accounts for a replaced JPEG instead of undercounting retained memory', () => {
    const recorder = new Recorder(); recorder.start(meta);
    const frame = (jpeg: string) => ({ v: 1 as const, id: 'frame', ts: 0, from: '', type: 'scan.frame', payload: { frameId: 'same', jpeg } });
    recorder.message('out', frame('AAAA')); expect(recorder.frameBytes).toBe(3);
    recorder.message('out', frame('AAAAAAAA')); expect(recorder.frameBytes).toBe(6);
    recorder.stop();
  });
});
