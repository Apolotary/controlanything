import { afterEach, describe, expect, it, vi } from 'vitest';
import { VisualSynthExecutor, visualSynthPort } from './vsynthExecutor';
import { createVisualSynthPort, createVisualSynthState, VISUAL_SYNTH_IDENTITY_REPLY } from '@ce/vsynth';
import type { ExecCommandPayload, MidiOp } from '@ce/protocol';
import { MusicalSynthPanel, musicalStageText } from './musicalSynth';

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

describe('musical sound permission lifecycle', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('distinguishes locked, unwired, writing, checking, ready and stopped without claiming the Quest Worker is running', () => {
    expect(musicalStageText(false).readout).toBe('Sound is off');
    expect(musicalStageText(false, 'ready').readout).toBe('Sound is off');
    expect(musicalStageText(true).readout).toBe('Ask Muse in Quest');
    expect(musicalStageText(true, 'writing').readout).toBe('Muse is writing…');
    expect(musicalStageText(true, 'dry-run').readout).toBe('Checking your wiring…');
    expect(musicalStageText(true, 'ready').readout).toBe('Follow your Quest instructions');
    expect(musicalStageText(true, 'stopped').readout).toBe('Stopped · ask Muse again');
    expect(musicalStageText(true, 'ready').status).not.toMatch(/running|playing/i);
  });
  it.each(['hidden', 'disconnected'])('invalidates pending audio resume when %s, even if it recovers before resume resolves', async boundary => {
    const param = () => ({ value: 0, setValueAtTime(value: number) { this.value = value; }, setTargetAtTime: vi.fn(),
      cancelScheduledValues: vi.fn(), linearRampToValueAtTime: vi.fn() });
    const node = () => ({ connect: vi.fn(), start: vi.fn(), stop: vi.fn(), gain: param(), frequency: param(), Q: param(), delayTime: param(), fftSize: 2048 });
    let finishResume!: () => void;
    const ctx = { state: 'suspended', currentTime: 0, sampleRate: 48000, destination: node(),
      createOscillator: node, createBiquadFilter: node, createGain: node, createDelay: node, createAnalyser: node,
      resume: () => new Promise<void>(resolve => { finishResume = () => { if (ctx.state !== 'closed') ctx.state = 'running'; resolve(); }; }),
      close: vi.fn(async () => { ctx.state = 'closed'; }),
    };
    vi.stubGlobal('AudioContext', class { constructor() { return ctx; } });
    const visibility = { hidden: false }; vi.stubGlobal('document', visibility);
    let connected = true;
    const panel = new MusicalSynthPanel({ connected: () => connected, changed: vi.fn(), muted: true });
    // Exercise the actual permission/engine lifecycle without constructing unrelated DOM.
    const lifecycle = panel as unknown as { panel: HTMLElement; unlock(): Promise<void> };
    lifecycle.panel = {} as HTMLElement;
    const pending = lifecycle.unlock();
    expect(panel.snapshot().enabled).toBe(false);
    if (boundary === 'hidden') visibility.hidden = true; else connected = false;
    panel.update();
    expect(ctx.close).toHaveBeenCalledOnce();
    visibility.hidden = false; connected = true; panel.update();
    finishResume(); await pending;
    expect(panel.snapshot()).toMatchObject({ enabled: false, available: false, masterGain: 0 });
    expect(panel.snapshot().state.gate).toBe(0);
  });
});
