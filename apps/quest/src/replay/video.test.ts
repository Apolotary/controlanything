import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TakeVideoRecorder } from './video';

class Track extends EventTarget {
  readyState = 'live';
  stop = vi.fn();
  constructor(readonly kind = 'video') { super(); }
  getSettings() { return { width: 1280, height: 960 }; }
}
class Stream {
  constructor(readonly tracks: Track[]) {}
  getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video'); }
}
class Encoder {
  static last: Encoder;
  static isTypeSupported(type: string) { return type.startsWith('video/webm'); }
  state = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly stream: Stream) { Encoder.last = this; }
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; }
  finish() { this.ondataavailable?.({ data: new Blob(['video']) }); this.onstop?.(); }
}
let now = 0;
beforeEach(() => {
  now = 100; vi.useFakeTimers(); vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('MediaStream', Stream); vi.stubGlobal('MediaRecorder', Encoder);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
const element = (tracks: Track[]) => ({ srcObject: new Stream(tracks) }) as unknown as HTMLVideoElement;

describe('take video recorder', () => {
  it('excludes audio and never stops shared camera tracks; video duration excludes encoder finalization', async () => {
    const camera = new Track(); const microphone = new Track('audio');
    const recorder = new TakeVideoRecorder();
    expect(recorder.start(element([camera, microphone]), 25, vi.fn(), vi.fn())).toBeNull();
    expect(Encoder.last.stream.tracks).toEqual([camera]);
    now = 1100; const result = recorder.stop();
    now = 3000; Encoder.last.finish();
    const file = await result;
    expect(file?.metadata).toMatchObject({ startOffsetMs: 25, durationMs: 1000, alignment: 'approximate', cameraExtrinsics: 'uncalibrated' });
    expect(new TextDecoder().decode(file!.bytes)).toBe('video');
    expect(camera.stop).not.toHaveBeenCalled(); expect(microphone.stop).not.toHaveBeenCalled();
  });

  it('uses decoded video dimensions when the track omits them, and rejects an unknown size', async () => {
    const track = new Track(); vi.spyOn(track, 'getSettings').mockReturnValue({} as { width: number; height: number });
    const recorder = new TakeVideoRecorder();
    expect(recorder.start(element([track]), 0, vi.fn(), vi.fn())).toContain('dimensions are not ready');
    const camera = Object.assign(element([track]), { videoWidth: 1280, videoHeight: 720 });
    expect(recorder.start(camera, 0, vi.fn(), vi.fn())).toBeNull();
    const result = recorder.stop(); Encoder.last.finish();
    expect((await result)?.metadata).toMatchObject({ width: 1280, height: 720 });
  });

  it('returns a clear telemetry-only reason for missing camera and resolves an encoder timeout', async () => {
    const recorder = new TakeVideoRecorder(); const warning = vi.fn();
    expect(recorder.start(undefined, 0, warning, vi.fn())).toContain('tracking data only');
    expect(recorder.start(element([new Track()]), 0, warning, vi.fn())).toBeNull();
    now = 300; const result = recorder.stop();
    now = 5300; vi.advanceTimersByTime(5000);
    expect(await result).toBeNull(); expect(warning).toHaveBeenCalledWith(expect.stringContaining('timed out'));
  });

  it('notifies the app and finalizes when the camera track ends', async () => {
    const track = new Track(); const recorder = new TakeVideoRecorder(); const ended = vi.fn();
    recorder.start(element([track]), 0, vi.fn(), ended);
    now = 800; track.dispatchEvent(new Event('ended'));
    expect(ended).toHaveBeenCalledOnce(); expect(Encoder.last.state).toBe('inactive');
    Encoder.last.finish(); expect((await recorder.stop())?.metadata.durationMs).toBe(700);
    expect(track.stop).not.toHaveBeenCalled();
  });
});
