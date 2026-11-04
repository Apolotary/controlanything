import { describe, expect, it, vi } from 'vitest';
import { VisualSynthExecutor, visualSynthPort } from './vsynthExecutor';
import { createVisualSynthPort, createVisualSynthState, VISUAL_SYNTH_IDENTITY_REPLY } from '@ce/vsynth';
import type { ExecCommandPayload, MidiOp } from '@ce/protocol';

const port = () => ({ receiveMidi: vi.fn(), reset: vi.fn(), getState: createVisualSynthState, setState: vi.fn(), dispose: vi.fn() });
const command = (op: MidiOp, dryRun = false): ExecCommandPayload => ({ execId: 'exec', executorDeviceId: 'companion', port: visualSynthPort.id, op, dryRun });

describe('silent virtual output', () => {
  it('refuses output with no recent visible screen while still allowing Stop to reset saved state', async () => {
    const p = port();
    const executor = new VisualSynthExecutor(p, () => false);
    expect(await executor.execute(command({ kind: 'midi', msg: 'cc', channel: 1, number: 71, value: 127 }))).toMatchObject({ ok: false, error: 'no_port' });
    expect(p.receiveMidi).not.toHaveBeenCalled();
    expect((await executor.execute(command({ kind: 'midi', msg: 'panic', channel: 1 }))).ok).toBe(true);
    expect(p.reset).toHaveBeenCalledOnce();
  });

  it('relays CC and program bytes, reports the applied state, rejects notes, and resets on Stop', async () => {
    const p = port();
    const executor = new VisualSynthExecutor(p);
    const cc = await executor.execute(command({ kind: 'midi', msg: 'cc', channel: 1, number: 71, value: 127 }));
    expect(cc).toMatchObject({ ok: true, applied: { source: 'port', params: expect.objectContaining({ warp: expect.any(Number) }) } });
    expect(p.receiveMidi).toHaveBeenLastCalledWith([0xb0, 71, 127]);
    expect((await executor.execute(command({ kind: 'midi', msg: 'pc', channel: 1, number: 2 }))).ok).toBe(true);
    expect(p.receiveMidi).toHaveBeenLastCalledWith([0xc0, 2]);
    expect((await executor.execute(command({ kind: 'midi', msg: 'sysex-identity', channel: 1 }))).reply).toEqual(VISUAL_SYNTH_IDENTITY_REPLY);
    expect((await executor.execute(command({ kind: 'midi', msg: 'note', channel: 1, number: 60 }))).ok).toBe(false);
    expect((await executor.execute(command({ kind: 'midi', msg: 'cc', channel: 1, number: 71, value: '$value' }))).ok).toBe(false);
    await executor.execute(command({ kind: 'midi', msg: 'panic', channel: 1 }, true));
    expect(p.reset).not.toHaveBeenCalled();
    await executor.execute(command({ kind: 'midi', msg: 'panic', channel: 1 }));
    expect(p.reset).toHaveBeenCalledOnce();
    expect(p.receiveMidi).toHaveBeenCalledTimes(2);
  });

  it('accepts the fingertip (CC22 X, CC23 Y, CC24 pressure) and reports it in the applied state', async () => {
    const port = createVisualSynthPort();
    const executor = new VisualSynthExecutor(port);
    for (const [number, value] of [[22, 32], [23, 95], [24, 100]] as const) {
      const ack = await executor.execute(command({ kind: 'midi', msg: 'cc', channel: 1, number, value }));
      expect(ack.ok, `CC${number}`).toBe(true);
    }
    const ack = await executor.execute(command({ kind: 'midi', msg: 'cc', channel: 1, number: 24, value: 0 }));
    expect(ack.applied?.params).toMatchObject({ touchX: 32 / 127, touchY: 95 / 127, touchPressure: 0 });
    expect(Object.keys(ack.applied?.params ?? {}).length).toBeLessThanOrEqual(16); // the ack schema allows 16 keys
    await executor.execute(command({ kind: 'midi', msg: 'panic', channel: 1 }));
    expect(port.getState()).toMatchObject({ touchX: .5, touchY: .5, touchPressure: 0 });
    port.dispose();
  });

  it('labels a command confirmed by a drawing page as applied by the renderer', async () => {
    const params = { ...createVisualSynthState(), warp: 1 };
    const p = { ...port(), receiveMidiConfirmed: vi.fn().mockResolvedValue({ ok: true, receipt: { id: 'x', renderer: 'r', params, visible: true, frame: 42, at: Date.now() } }) };
    const ack = await new VisualSynthExecutor(p).execute(command({ kind: 'midi', msg: 'cc', channel: 1, number: 71, value: 127 }));
    expect(ack).toMatchObject({ ok: true, applied: { source: 'renderer', visible: true, frame: 42, params: expect.objectContaining({ warp: 1 }) } });
  });
});
