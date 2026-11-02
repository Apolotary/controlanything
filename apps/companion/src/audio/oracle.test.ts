import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sine } from './features';
import { AudioOracle } from './oracle';

class FakeNode {
  connect = vi.fn((node: FakeNode) => node);
  disconnect = vi.fn();
}

class FakeWorklet extends FakeNode {
  static instances: FakeWorklet[] = [];
  port: { onmessage?: (event: MessageEvent<Float32Array>) => void } = {};

  constructor() {
    super();
    FakeWorklet.instances.push(this);
  }

  capture(samples: Float32Array): void {
    this.port.onmessage?.({ data: samples } as MessageEvent<Float32Array>);
  }
}

class FakeContext {
  static instances: FakeContext[] = [];
  sampleRate = 48000;
  destination = new FakeNode();
  source = new FakeNode();
  sink = Object.assign(new FakeNode(), { gain: { value: 1 } });
  processor = Object.assign(new FakeNode(), {
    onaudioprocess: undefined as ((event: AudioProcessingEvent) => void) | undefined,
  });
  audioWorklet: { addModule: ReturnType<typeof vi.fn> } | undefined = { addModule: vi.fn(async () => {}) };
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  createGain = vi.fn(() => this.sink);
  createMediaStreamSource = vi.fn(() => this.source);
  createScriptProcessor = vi.fn(() => this.processor);

  constructor() {
    FakeContext.instances.push(this);
  }
}

function input(deviceId: string, label: string, kind = 'audioinput') {
  return { deviceId, label, kind };
}

function stream(deviceId: string, label: string) {
  const track = {
    label,
    stop: vi.fn(),
    getSettings: () => ({ deviceId }),
    addEventListener: vi.fn(),
  };
  return { getTracks: () => [track], getAudioTracks: () => [track], track };
}

const mediaDevices = {
  getUserMedia: vi.fn(),
  enumerateDevices: vi.fn(),
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  FakeContext.instances = [];
  FakeWorklet.instances = [];
  mediaDevices.getUserMedia.mockReset();
  mediaDevices.enumerateDevices.mockReset().mockResolvedValue([]);
  vi.stubGlobal('navigator', { mediaDevices });
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('AudioWorkletNode', FakeWorklet);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-capture');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(performance, 'now').mockReturnValue(1000);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AudioOracle inputs', () => {
  it('handles browsers without microphone capture', async () => {
    vi.stubGlobal('navigator', {});
    expect(AudioOracle.supported).toBe(false);
    expect(await AudioOracle.inputs()).toEqual([]);
    expect(mediaDevices.enumerateDevices).not.toHaveBeenCalled();
  });

  it('lists usable audio inputs and marks synth inputs after permission', async () => {
    mediaDevices.enumerateDevices.mockResolvedValue([
      input('default', ''),
      input('communications', 'Microphone'),
      input('op1', 'OP-1 field'),
      input('camera', 'Camera', 'videoinput'),
      input('speaker', 'Speaker', 'audiooutput'),
    ]);
    expect(await AudioOracle.inputs()).toEqual([
      { deviceId: 'default', label: 'audio input', synth: false },
      { deviceId: 'op1', label: 'OP-1 field', synth: true },
    ]);
  });

  it('honors an input hint, otherwise prefers synth USB audio over the default mic', () => {
    const mic = { deviceId: 'default', label: 'Mac microphone', synth: false };
    const move = { deviceId: 'move', label: 'Move USB', synth: true };
    const op1 = { deviceId: 'op1', label: 'OP-1 field', synth: true };
    expect(AudioOracle.pick([mic, move, op1])).toBe(op1);
    expect(AudioOracle.pick([mic, move, op1], 'MOVE')).toBe(move);
    expect(AudioOracle.pick([mic])).toBe(mic);
    expect(AudioOracle.pick([])).toBeUndefined();
  });
});

describe('AudioOracle capture lifecycle', () => {
  it('switches to the synth after permission and keeps the capture graph muted', async () => {
    const mic = stream('default', 'Mac microphone');
    const synth = stream('op1', 'OP-1 field');
    mediaDevices.getUserMedia.mockResolvedValueOnce(mic).mockResolvedValueOnce(synth);
    mediaDevices.enumerateDevices.mockResolvedValue([input('default', 'Mac microphone'), input('op1', 'OP-1 field')]);
    const oracle = new AudioOracle();
    const states: string[] = [];
    oracle.onState = (state) => states.push(state);

    await oracle.start();

    expect(states).toEqual(['starting', 'on']);
    expect(mic.track.stop).toHaveBeenCalledOnce();
    expect(mediaDevices.getUserMedia).toHaveBeenNthCalledWith(2, {
      audio: {
        deviceId: { exact: 'op1' },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 2 },
      },
    });
    expect(oracle.input).toEqual({ deviceId: 'op1', label: 'OP-1 field', synth: true });
    const ctx = FakeContext.instances[0];
    expect(ctx.sink.gain.value).toBe(0);
    expect(ctx.source.connect).toHaveBeenCalledWith(FakeWorklet.instances[0]);
    expect(FakeWorklet.instances[0].connect).toHaveBeenCalledWith(ctx.sink);
    expect(ctx.sink.connect).toHaveBeenCalledWith(ctx.destination);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-capture');

    await oracle.stop();

    expect(states).toEqual(['starting', 'on', 'off']);
    expect(synth.track.stop).toHaveBeenCalledOnce();
    expect(ctx.source.disconnect).toHaveBeenCalledWith(FakeWorklet.instances[0]);
    expect(FakeWorklet.instances[0].disconnect).toHaveBeenCalledOnce();
    expect(ctx.sink.disconnect).toHaveBeenCalledOnce();
    expect(ctx.close).toHaveBeenCalledOnce();
  });

  it('keeps an explicitly selected microphone even if a synth is present', async () => {
    mediaDevices.getUserMedia.mockResolvedValue(stream('mic', 'External microphone'));
    mediaDevices.enumerateDevices.mockResolvedValue([input('mic', 'External microphone'), input('op1', 'OP-1 field')]);
    const oracle = new AudioOracle();
    await oracle.start('mic');
    expect(mediaDevices.getUserMedia).toHaveBeenCalledOnce();
    expect(mediaDevices.getUserMedia.mock.calls[0][0].audio.deviceId).toEqual({ exact: 'mic' });
    expect(oracle.input?.deviceId).toBe('mic');
    await oracle.stop();
  });

  it('reports denied permission without opening an audio context', async () => {
    mediaDevices.getUserMedia.mockRejectedValue(Object.assign(new Error('permission'), { name: 'NotAllowedError' }));
    const oracle = new AudioOracle();
    await oracle.start();
    expect(oracle.state).toBe('error');
    expect(oracle.error).toBe('microphone permission was denied');
    expect(FakeContext.instances).toHaveLength(0);
    await expect(oracle.measure()).rejects.toThrow('microphone permission was denied');
  });

  it('reports an input that is unplugged during capture', async () => {
    const mic = stream('mic', 'External microphone');
    mediaDevices.getUserMedia.mockResolvedValue(mic);
    const oracle = new AudioOracle();
    await oracle.start('mic');
    const ended = mic.track.addEventListener.mock.calls.find(([name]) => name === 'ended')?.[1] as () => void;
    ended();
    expect(oracle.state).toBe('error');
    expect(oracle.error).toContain('unplugged');
    await oracle.stop();
  });

  it('reuses a borrowed context without registering twice or closing its owner’s context', async () => {
    const ctx = new FakeContext();
    const oracle = new AudioOracle();
    for (let i = 0; i < 2; i++) {
      await oracle.startFromNode(ctx as unknown as AudioContext, ctx.source as unknown as AudioNode, 'Mock synth');
      expect(oracle.state).toBe('on');
      await oracle.stop();
    }
    expect(ctx.audioWorklet?.addModule).toHaveBeenCalledOnce();
    expect(ctx.close).not.toHaveBeenCalled();
    expect(mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(ctx.sink.gain.value).toBe(0);
  });
});

describe('AudioOracle measurements', () => {
  async function capturing() {
    const ctx = new FakeContext();
    const oracle = new AudioOracle();
    await oracle.startFromNode(ctx as unknown as AudioContext, ctx.source as unknown as AudioNode, 'Mock synth');
    return { oracle, worklet: FakeWorklet.instances.at(-1)! };
  }

  it('measures a buffered capture window with the selected input label', async () => {
    const { oracle, worklet } = await capturing();
    worklet.capture(sine(1000, 0.5, 48000, 100));
    const features = await oracle.measure(100, -100);
    expect(features.input).toBe('Mock synth');
    expect(features.windowMs).toBe(100);
    expect(features.rms).toBeCloseTo(0.5 / Math.SQRT2, 3);
    expect(features.centroidHz).toBeCloseTo(1000, -2);
    expect(oracle.levelDb()).toBeCloseTo(-9.03, 1);
    await oracle.stop();
  });

  it('waits for worklet samples when the measurement reaches into the future', async () => {
    const { oracle, worklet } = await capturing();
    const result = oracle.measure(100);
    vi.mocked(performance.now).mockReturnValue(1100);
    worklet.capture(sine(440, 0.25, 48000, 100));
    expect((await result).rms).toBeCloseTo(0.25 / Math.SQRT2, 3);
    await oracle.stop();
  });

  it('rejects a pending measurement when the user stops listening', async () => {
    const { oracle } = await capturing();
    const result = expect(oracle.measure(500)).rejects.toThrow('audio input stopped during the measurement');
    await oracle.stop();
    await result;
  });

  it('rejects a window with too little captured audio', async () => {
    const { oracle, worklet } = await capturing();
    worklet.capture(new Float32Array(480));
    await expect(oracle.measure(10, -10)).rejects.toThrow('not enough audio buffered');
    await oracle.stop();
  });

  it('downmixes capture channels in the legacy fallback and keeps its output muted', async () => {
    const ctx = new FakeContext();
    ctx.audioWorklet = undefined;
    const oracle = new AudioOracle();
    await oracle.startFromNode(ctx as unknown as AudioContext, ctx.source as unknown as AudioNode, 'Mock stereo');
    const left = sine(1000, 0.5, 48000, 100);
    const right = new Float32Array(left.length);
    ctx.processor.onaudioprocess?.({
      inputBuffer: { length: left.length, numberOfChannels: 2, getChannelData: (channel: number) => channel ? right : left },
    } as unknown as AudioProcessingEvent);
    expect((await oracle.measure(100, -100)).rms).toBeCloseTo(0.25 / Math.SQRT2, 3);
    expect(ctx.sink.gain.value).toBe(0);
    expect(FakeWorklet.instances).toHaveLength(0);
    await oracle.stop();
  });
});
