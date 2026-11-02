import { describe, expect, it, vi } from 'vitest';
import { QuestApp } from './app';

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
