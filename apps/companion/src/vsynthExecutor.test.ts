import { describe, expect, it, vi } from 'vitest';
import { VisualSynthExecutor, visualSynthPort } from './vsynthExecutor';
import { createVisualSynthState, VISUAL_SYNTH_IDENTITY_REPLY } from '@ce/vsynth';
import type { ExecCommandPayload, MidiOp } from '@ce/protocol';

describe('silent virtual output', () => {
  it('refuses disconnected/hidden screen output while still allowing Stop to reset saved state', () => {
    const port = { receiveMidi: vi.fn(), reset: vi.fn(), getState: createVisualSynthState, setState: vi.fn(), dispose: vi.fn() };
    const executor = new VisualSynthExecutor(port, () => false);
    const command: ExecCommandPayload = { execId: 'exec', executorDeviceId: 'companion', port: visualSynthPort.id, op: { kind: 'midi', msg: 'cc', channel: 1, number: 71, value: 127 } };
    expect(executor.execute(command)).toMatchObject({ ok: false, error: 'no_port', detail: expect.stringContaining('visible') });
    expect(port.receiveMidi).not.toHaveBeenCalled();
    expect(executor.execute({ ...command, op: { kind: 'midi', msg: 'panic', channel: 1 } }).ok).toBe(true);
    expect(port.reset).toHaveBeenCalledOnce();
  });
  it('relays CC and program bytes without requesting Web MIDI, rejects notes, and resets on Stop', () => {
    const port = { receiveMidi: vi.fn(), reset: vi.fn(), getState: createVisualSynthState, setState: vi.fn(), dispose: vi.fn() };
    const executor = new VisualSynthExecutor(port);
    const command = (op: MidiOp, dryRun = false): ExecCommandPayload => ({ execId: 'exec', executorDeviceId: 'companion', port: visualSynthPort.id, op, dryRun });
    expect(executor.execute(command({ kind: 'midi', msg: 'cc', channel: 1, number: 71, value: 127 })).ok).toBe(true);
    expect(port.receiveMidi).toHaveBeenLastCalledWith([0xb0, 71, 127]);
    expect(executor.execute(command({ kind: 'midi', msg: 'pc', channel: 1, number: 2 })).ok).toBe(true);
    expect(port.receiveMidi).toHaveBeenLastCalledWith([0xc0, 2]);
    expect(executor.execute(command({ kind: 'midi', msg: 'sysex-identity', channel: 1 })).reply).toEqual(VISUAL_SYNTH_IDENTITY_REPLY);
    expect(executor.execute(command({ kind: 'midi', msg: 'note', channel: 1, number: 60 })).ok).toBe(false);
    expect(executor.execute(command({ kind: 'midi', msg: 'cc', channel: 1, number: 71, value: '$value' })).ok).toBe(false);
    executor.execute(command({ kind: 'midi', msg: 'panic', channel: 1 }, true));
    expect(port.reset).not.toHaveBeenCalled();
    executor.execute(command({ kind: 'midi', msg: 'panic', channel: 1 }));
    expect(port.reset).toHaveBeenCalledOnce();
    expect(port.receiveMidi).toHaveBeenCalledTimes(2);
  });
});
