import { afterEach, describe, expect, it, vi } from 'vitest';
import { promptedButton, SimDevice } from './device';
import type { SynthEngine } from './synth/engine';
import type { FeatureMeter } from './synth/features';
import type { RoomView } from './room/view';
import type { LampAnimator } from './room/lamp';

afterEach(() => vi.useRealTimers());

describe('sim Stop', () => {
  it('cancels queued lamp sends, active learning and automatic remote presses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const synth = { panic: vi.fn() } as unknown as SynthEngine;
    const device = new SimDevice(synth, {} as FeatureMeter, {} as RoomView, { setTarget: vi.fn() } as unknown as LampAnimator);
    const receive = vi.spyOn(device, 'receiveIr').mockReturnValue({} as ReturnType<SimDevice['receiveIr']>);
    const remote = vi.spyOn(device, 'remotePress').mockImplementation(() => {});
    const command = { execId: 'lamp', executorDeviceId: 'sim', op: { kind: 'ir' as const, protocol: 'RAW' as const, rawUs: [9000, 4500] } };
    expect((await device.handleExec(command)).ok).toBe(true);
    const waiting = device.handleExec(command);
    const queued = device.handleExec(command);
    await Promise.resolve();
    device.autoPress = true;
    await device.handleSense({ senseId: 'learn', sensorDeviceId: 'sim', kind: 'ir-capture', prompt: 'Press full on once', durationMs: 3000 });
    expect(device.learn).toBeDefined();
    device.panic();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await waiting).toMatchObject({ ok: false });
    expect(await queued).toMatchObject({ ok: false });
    expect(receive).toHaveBeenCalledOnce();
    expect(remote).not.toHaveBeenCalled();
    expect(synth.panic).toHaveBeenCalledOnce();
    expect(device.learn).toBeUndefined();
  });
});

describe('learn prompts', () => {
  it('finds the button whatever the remote calls it', () => {
    const cases: [string, string][] = [
      ['Press 全灯 (full on) once', 'fullOn'],
      ['Press 消灯 (off) once', 'off'],
      ['Press 明るく (brighter) once', 'brighter'],
      ['Press 暗く (dimmer) once', 'dimmer'],
      ['Press 常夜灯 (night light) once', 'night'],
      ['Press 暖色 (warm) once', 'warmer'],
      ['Press 白色 (cool white) once', 'cooler'],
      ['press 暖かい光', 'warmer'],
      ['press 点灯 once', 'on'],
      ['press On', 'on'],
      ['press Off', 'off'],
    ];
    for (const [prompt, cmd] of cases) expect(promptedButton(prompt), prompt).toBe(cmd);
    expect(promptedButton('press any button')).toBeUndefined();
    expect(promptedButton(undefined)).toBeUndefined();
  });
});
