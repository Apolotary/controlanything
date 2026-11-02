import { describe, expect, it, vi } from 'vitest';
import { QuestApp } from './app';
import { Quaternion, Vector3 } from 'three';

function setup() {
  const app = Object.create(QuestApp.prototype) as QuestApp;
  const modes = { mode: 'control', byCard: (id: string) => id === 'synth' ? { cardId: id } : undefined };
  const audio = { rms: 0.2, centroidHz: 440, bands: [-20], input: 'Quest microphone' };
  const mic = { ready: true, measure: vi.fn(async () => audio) };
  const params = new URLSearchParams();
  const send = vi.fn();
  Object.assign(app, { identity: { deviceId: 'quest' }, modes, activeSetup: 'synth', params, mic, ws: { send } });
  const request = { senseId: 'sense', sensorDeviceId: 'quest', kind: 'audio-features', cardId: 'synth', durationMs: 600, offsetMs: -600 };
  const sense = (changes = {}) => Reflect.get(app, 'onSenseRequest').call(app, { ...request, ...changes }) as Promise<void>;
  return { app, modes, mic, params, send, sense, audio };
}

describe('headset verification requests', () => {
  it('sends fresh fixture boxes in the camera frame coordinate system', async () => {
    const { app, send, sense } = setup();
    const payload = { frameId: 'frame', jpeg: 'AAAA', width: 1280, height: 960, capturedAt: 1, space: 'local-floor', purpose: 'verify' };
    Object.assign(app, {
      camera: { kind: 'synthetic' },
      room: { imageWidth: 100, imageToWorld: (u: number, v: number) => new Vector3((u - 50) / 50, (50 - v) / 50, -2) },
      fixture: { source: 'sim layout', modelId: 'sim-layout', imageWidth: 100, imageHeight: 100, wallMs: 0,
        detections: [{ prompt: 'synthesizer', label: 'ControlAnything Visual Synth', score: 1, box: [40, 40, 20, 20] }] },
      poses: { peakSpeed: () => 0 },
      capture: { capture: async () => ({ payload, record: { width: 1280, height: 960, bytes: 500,
        intrinsics: { width: 1280, height: 960, fx: 100, fy: 100, cx: 640, cy: 480 },
        cam: { position: new Vector3(), quaternion: new Quaternion() } } }) },
      targetForCard: () => undefined,
      showLastFrame: vi.fn(),
      page: { log: vi.fn() },
    });
    await sense({ kind: 'frame' });
    expect(send).toHaveBeenCalledWith('sense.result', expect.objectContaining({ kind: 'frame', ok: true,
      frame: expect.objectContaining({ fixtureDetections: [{ detId: 'fx0', prompt: 'synthesizer', label: 'ControlAnything Visual Synth', score: 1, box: [630, 470, 20, 20] }] }),
    }), { to: 'server' });
  });

  it('answers an authorized synth measurement through the authenticated socket', async () => {
    const { mic, send, sense, audio } = setup();
    await sense();
    expect(mic.measure).toHaveBeenCalledExactlyOnceWith(600, -600);
    expect(send).toHaveBeenCalledWith('sense.result', expect.objectContaining({ senseId: 'sense', kind: 'audio-features', ok: true, audio }), { to: 'server' });
  });

  it('does not listen for another sensor, an untagged device or in Annotate', async () => {
    const { modes, mic, send, sense } = setup();
    await sense({ sensorDeviceId: 'mac' });
    await sense({ cardId: 'other' });
    modes.mode = 'annotate';
    await sense();
    expect(mic.measure).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps mic=0 silent and reports unavailable input instead of claiming evidence', async () => {
    const { mic, params, send, sense } = setup();
    params.set('mic', '0');
    await sense();
    expect(mic.measure).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('sense.result', expect.objectContaining({ ok: false, error: expect.stringContaining('Enable the headset microphone') }), { to: 'server' });
  });

  it('discards a result when the user leaves Control during measurement', async () => {
    const { modes, mic, audio, send, sense } = setup();
    mic.measure.mockImplementation(async () => { modes.mode = 'annotate'; return audio; });
    await sense();
    expect(send).not.toHaveBeenCalled();
  });
});
