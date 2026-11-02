import { afterEach, describe, expect, it, vi } from 'vitest';
import { promptedButton, SimDevice } from './device';
import type { SynthEngine } from './synth/engine';
import type { FeatureMeter } from './synth/features';
import type { RoomView } from './room/view';
import type { LampAnimator } from './room/lamp';
import { VISUAL_SYNTH_IDENTITY_REPLY, VISUAL_SYNTH_PORT, VISUAL_SYNTH_PORT_ID } from '@ce/vsynth';

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

describe('silent visual MIDI output', () => {
  function setup() {
    const synth = { panic: vi.fn(), controlChange: vi.fn(), noteOn: vi.fn() } as unknown as SynthEngine;
    const visual = { receiveMidi: vi.fn(() => true), reset: vi.fn() };
    const device = new SimDevice(synth, {} as FeatureMeter, {} as RoomView, {} as LampAnimator, visual);
    return { synth, visual, device };
  }

  it('routes mapped control and program bytes only to the requested visual port', async () => {
    const { synth, visual, device } = setup();
    const command = { execId: 'visual', executorDeviceId: 'sim', port: VISUAL_SYNTH_PORT_ID, op: { kind: 'midi' as const, msg: 'cc' as const, channel: 1, number: 71, value: 112 } };
    expect(await device.handleExec(command)).toMatchObject({ ok: true });
    expect(visual.receiveMidi).toHaveBeenCalledWith([0xb0, 71, 112]);
    expect(await device.handleExec({ ...command, port: 'Visual Synth' })).toMatchObject({ ok: true });
    expect(await device.handleExec({ ...command, port: VISUAL_SYNTH_PORT, op: { kind: 'midi', msg: 'pc', channel: 1, number: 2 } })).toMatchObject({ ok: true });
    expect(visual.receiveMidi).toHaveBeenLastCalledWith([0xc0, 2]);
    expect(await device.handleExec({ ...command, op: { kind: 'midi', msg: 'sysex-identity', channel: 1 } })).toMatchObject({ ok: true, reply: [...VISUAL_SYNTH_IDENTITY_REPLY] });
    expect(synth.controlChange).not.toHaveBeenCalled();
    expect(synth.noteOn).not.toHaveBeenCalled();
  });

  it('rejects unavailable outputs and unsupported messages without falling back to the audio synth', async () => {
    const { synth, visual, device } = setup();
    const command = { execId: 'visual', executorDeviceId: 'sim', port: VISUAL_SYNTH_PORT_ID, op: { kind: 'midi' as const, msg: 'note' as const, channel: 1, number: 60 } };
    expect(await device.handleExec(command)).toMatchObject({ ok: false, error: 'bad_args' });
    expect(await device.handleExec({ ...command, port: 'missing-visual-port' })).toMatchObject({ ok: false, error: 'no_port' });
    expect(visual.receiveMidi).not.toHaveBeenCalled();
    expect(synth.noteOn).not.toHaveBeenCalled();
    const unavailable = new SimDevice(synth, {} as FeatureMeter, {} as RoomView, {} as LampAnimator);
    expect(await unavailable.handleExec(command)).toMatchObject({ ok: false, error: 'no_port' });
  });

  it('keeps dry runs unchanged and resets the visual output on either Stop path', async () => {
    const { visual, device } = setup();
    const command = { execId: 'visual', executorDeviceId: 'sim', port: VISUAL_SYNTH_PORT_ID, op: { kind: 'midi' as const, msg: 'cc' as const, channel: 1, number: 71, value: 112 } };
    expect(await device.handleExec({ ...command, dryRun: true })).toMatchObject({ ok: true });
    expect(visual.receiveMidi).not.toHaveBeenCalled();
    expect(await device.handleExec({ ...command, op: { kind: 'midi', msg: 'panic', channel: 1 } })).toMatchObject({ ok: true });
    expect(visual.reset).toHaveBeenCalledOnce();
    device.panic();
    expect(visual.reset).toHaveBeenCalledTimes(2);
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
