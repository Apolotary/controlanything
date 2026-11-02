import { AudioFeatures } from '@ce/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sine } from '../../../companion/src/audio/features';
import { Mic } from './mic';

class Node {
  connect = vi.fn((node: Node) => node);
  disconnect = vi.fn();
}

class Worklet extends Node {
  static instances: Worklet[] = [];
  port = { onmessage: null as ((event: MessageEvent) => void) | null, postMessage: vi.fn() };
  constructor(_context: unknown, readonly name: string) { super(); Worklet.instances.push(this); }
  capture(data: unknown): void { this.port.onmessage?.({ data } as MessageEvent); }
}

class Context {
  static instances: Context[] = [];
  static failModule = false;
  sampleRate = 48000;
  state = 'suspended';
  source = new Node();
  destination = new Node();
  sinks: (Node & { gain: { value: number } })[] = [];
  audioWorklet = { addModule: vi.fn(async () => {
    if (Context.failModule) { Context.failModule = false; throw new Error('worklet failed'); }
  }) };
  resume = vi.fn(async () => { this.state = 'running'; });
  close = vi.fn(async () => { this.state = 'closed'; });
  createMediaStreamSource = vi.fn(() => this.source);
  createGain = vi.fn(() => {
    const sink = Object.assign(new Node(), { gain: { value: 1 } });
    this.sinks.push(sink);
    return sink;
  });
  constructor() { Context.instances.push(this); }
}

const media = { getUserMedia: vi.fn() };
const track = { label: 'Quest microphone', stop: vi.fn(), addEventListener: vi.fn() };
const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
const worklet = (name: string) => Worklet.instances.find((node) => node.name === name)!;
let mic: Mic;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  Context.instances = [];
  Context.failModule = false;
  Worklet.instances = [];
  track.label = 'Quest microphone';
  track.stop.mockReset();
  track.addEventListener.mockReset();
  media.getUserMedia.mockReset().mockResolvedValue(stream);
  vi.stubGlobal('navigator', { mediaDevices: media });
  vi.stubGlobal('AudioContext', Context);
  vi.stubGlobal('AudioWorkletNode', Worklet);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:quest-mic');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(performance, 'now').mockReturnValue(1000);
  mic = new Mic();
});

afterEach(() => {
  mic.close();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Quest microphone sensing', () => {
  it('requires a prepared running microphone without asking permission during measurement', async () => {
    await expect(mic.measure()).rejects.toThrow('Enable the headset microphone');
    expect(media.getUserMedia).not.toHaveBeenCalled();
    await mic.prepare();
    Context.instances[0].state = 'suspended';
    await expect(mic.measure()).rejects.toThrow('Enable the headset microphone');
    expect(media.getUserMedia).toHaveBeenCalledOnce();
  });

  it('shares one raw input and context with speech and keeps both capture graphs muted', async () => {
    await Promise.all([mic.prepare(), mic.prepare()]);
    expect(media.getUserMedia).toHaveBeenCalledExactlyOnceWith({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false,
    });
    expect(Context.instances).toHaveLength(1);
    const ctx = Context.instances[0];
    expect(ctx.source.connect).toHaveBeenCalledWith(worklet('ce-pcm-tap'));
    expect(ctx.source.connect).toHaveBeenCalledWith(worklet('ce-tap'));
    expect(ctx.sinks).toHaveLength(2);
    for (const sink of ctx.sinks) {
      expect(sink.gain.value).toBe(0);
      expect(sink.connect).toHaveBeenCalledWith(ctx.destination);
    }
    expect(mic.ready).toBe(true);
  });

  it('measures a requested past window instead of the newer sound', async () => {
    track.label = 'Quest input '.repeat(20);
    await mic.prepare();
    const sensor = worklet('ce-tap');
    sensor.capture(sine(220, 0.25, 48000, 100));
    vi.mocked(performance.now).mockReturnValue(1100);
    sensor.capture(sine(880, 0.5, 48000, 100));
    const before = await mic.measure(100, -200);
    const after = await mic.measure(100, -100);
    expect(AudioFeatures.safeParse(before).success).toBe(true);
    expect(before.input).toHaveLength(120);
    expect(before.sampleRate).toBe(48000);
    expect(before.windowMs).toBe(100);
    expect(before.rms).toBeCloseTo(0.25 / Math.SQRT2, 3);
    expect(Math.abs(before.centroidHz - 220)).toBeLessThan(40);
    expect(after.rms).toBeCloseTo(0.5 / Math.SQRT2, 3);
    expect(Math.abs(after.centroidHz - 880)).toBeLessThan(40);
    expect(before.spec).toHaveLength(128);
  });

  it('waits for future audio without changing push-to-talk chunks or its recording state', async () => {
    await mic.prepare();
    const chunks = vi.fn();
    mic.on('chunk', chunks);
    mic.start();
    const result = mic.measure(100);
    const pcm = new Int16Array([100, 200]);
    worklet('ce-pcm-tap').capture({ type: 'pcm', pcm: pcm.buffer, final: false });
    vi.mocked(performance.now).mockReturnValue(1100);
    worklet('ce-tap').capture(sine(440, 0.25, 48000, 100));
    expect((await result).rms).toBeCloseTo(0.25 / Math.SQRT2, 3);
    expect(chunks).toHaveBeenCalledExactlyOnceWith({ pcm, final: false });
    expect(worklet('ce-pcm-tap').port.postMessage.mock.calls).toEqual([['start']]);
    mic.stop();
    expect(worklet('ce-pcm-tap').port.postMessage.mock.calls).toEqual([['start'], ['stop']]);
    vi.mocked(performance.now).mockReturnValue(1200);
    worklet('ce-tap').capture(sine(880, 0.5, 48000, 100));
    expect((await mic.measure(100, -100)).centroidHz).toBeGreaterThan(800);
  });

  it('rejects interrupted measurements and releases the borrowed context only once', async () => {
    await mic.prepare();
    const result = expect(mic.measure(500)).rejects.toThrow('audio input stopped');
    const ctx = Context.instances[0];
    mic.close();
    await result;
    expect(mic.ready).toBe(false);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(ctx.close).toHaveBeenCalledOnce();
    expect(worklet('ce-tap').disconnect).toHaveBeenCalledOnce();
  });

  it('fails honestly when capture stalls or the input ends', async () => {
    await mic.prepare();
    const stalled = expect(mic.measure(100)).rejects.toThrow('not enough audio buffered');
    await vi.advanceTimersByTimeAsync(1700);
    await stalled;
    const ended = track.addEventListener.mock.calls.find(([name]) => name === 'ended')?.[1] as () => void;
    ended();
    expect(mic.ready).toBe(false);
    await expect(mic.measure()).rejects.toThrow('Enable the headset microphone');
  });

  it('releases a failed preparation so a new user gesture can retry', async () => {
    Context.failModule = true;
    await expect(mic.prepare()).rejects.toThrow('worklet failed');
    expect(mic.ready).toBe(false);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(Context.instances[0].close).toHaveBeenCalledOnce();
    await mic.prepare();
    expect(mic.ready).toBe(true);
    expect(media.getUserMedia).toHaveBeenCalledTimes(2);
  });
});
