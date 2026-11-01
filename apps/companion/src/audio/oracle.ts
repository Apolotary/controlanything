/**
 * The audio oracle: listens to the synth's own USB audio input (preferred: "OP-1", "EP-133", Move) or the
 * Mac microphone, keeps a rolling buffer, and measures windows on request (sense.request audio-features).
 * Capture runs in an AudioWorklet, so measurements keep working while the tab is in the background.
 * Echo cancellation, noise suppression and auto gain are off: we want the raw signal.
 */
import { computeFeatures } from './features';

const BUFFER_SECONDS = 6;
/** label hints for synth USB audio inputs, best first */
const SYNTH_INPUTS = [/op-1/i, /ep-133|k\.?o\.? ?ii/i, /move/i, /teenage/i];

const WORKLET_SRC = `
class CeTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(1024); this.n = 0; }
  process(inputs) {
    const chans = inputs[0];
    if (!chans || !chans.length) return true;
    const len = chans[0].length;
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let c = 0; c < chans.length; c++) s += chans[c][i];
      this.buf[this.n++] = s / chans.length;
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(1024);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('ce-tap', CeTap);
`;

export interface AudioInput {
  deviceId: string;
  label: string;
  synth: boolean;
}

export type OracleState = 'off' | 'starting' | 'on' | 'error';

export class AudioOracle {
  state: OracleState = 'off';
  error?: string;
  input?: AudioInput;
  sampleRate = 48000;
  private ctx?: AudioContext;
  private stream?: MediaStream;
  /** contexts that already registered the capture worklet (registering twice throws) */
  private static readonly loaded = new WeakSet<BaseAudioContext>();
  private node?: AudioNode;
  private srcNode?: AudioNode;
  private sinkNode?: AudioNode;
  private borrowed?: AudioContext;
  private ring = new Float32Array(1);
  private write = 0;
  private filled = 0;
  /** performance.now() of the newest sample */
  private newestAt = 0;
  private waiters: { until: number; resolve: () => void }[] = [];
  /** RMS dB of each 1024-sample block (~21 ms), newest last, for meters and sparklines */
  readonly levels: { at: number; db: number }[] = [];
  onState: (s: OracleState) => void = () => {};

  static get supported(): boolean {
    return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) && typeof AudioContext !== 'undefined';
  }

  /** Audio inputs; labels appear only after the first permission grant. */
  static async inputs(): Promise<AudioInput[]> {
    if (!AudioOracle.supported) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all
      .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications')
      .map((d) => ({ deviceId: d.deviceId, label: d.label || 'audio input', synth: SYNTH_INPUTS.some((r) => r.test(d.label)) }));
  }

  /** The synth's own USB audio when present (matched by label), else the default input. */
  static pick(inputs: AudioInput[], hint?: string): AudioInput | undefined {
    if (hint) {
      const h = inputs.find((i) => i.label.toLowerCase().includes(hint.toLowerCase()));
      if (h) return h;
    }
    for (const r of SYNTH_INPUTS) {
      const m = inputs.find((i) => r.test(i.label));
      if (m) return m;
    }
    return inputs.find((i) => i.deviceId === 'default') ?? inputs[0];
  }

  private setState(s: OracleState, error?: string): void {
    this.state = s;
    this.error = error;
    this.onState(s);
  }

  /**
   * Start listening (call from a click the first time: it shows the mic prompt). Without a deviceId the
   * synth's USB audio is preferred; the first call may need a second pass once labels are visible.
   */
  async start(deviceId?: string): Promise<void> {
    await this.stop();
    this.setState('starting');
    try {
      const constraints = (id?: string): MediaStreamConstraints => ({
        audio: { ...(id ? { deviceId: { exact: id } } : {}), echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } },
      });
      let stream = await navigator.mediaDevices.getUserMedia(constraints(deviceId));
      if (!deviceId) {
        // labels are visible now: switch to the synth's own input if one is plugged in
        const best = AudioOracle.pick(await AudioOracle.inputs());
        const current = stream.getAudioTracks()[0]?.getSettings().deviceId;
        if (best && best.synth && best.deviceId !== current) {
          stream.getTracks().forEach((t) => t.stop());
          stream = await navigator.mediaDevices.getUserMedia(constraints(best.deviceId));
        }
      }
      this.stream = stream;
      const track = stream.getAudioTracks()[0];
      const settings = track?.getSettings() ?? {};
      const inputs = await AudioOracle.inputs();
      this.input = inputs.find((i) => i.deviceId === settings.deviceId) ?? { deviceId: settings.deviceId ?? '', label: track?.label ?? 'audio input', synth: SYNTH_INPUTS.some((r) => r.test(track?.label ?? '')) };
      track?.addEventListener('ended', () => this.setState('error', 'the audio input went away (unplugged?)'));
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx = ctx;
      await ctx.resume();
      await this.tap(ctx, ctx.createMediaStreamSource(stream));
      this.setState('on');
    } catch (e) {
      await this.stop();
      const err = e as Error;
      this.setState('error', err.name === 'NotAllowedError' ? 'microphone permission was denied' : err.message);
    }
  }

  /** Listen to a node in an existing context (the spike's sim synth): no microphone involved. */
  async startFromNode(ctx: AudioContext, node: AudioNode, label: string): Promise<void> {
    await this.stop();
    this.setState('starting');
    try {
      await ctx.resume();
      this.input = { deviceId: 'node', label, synth: true };
      await this.tap(ctx, node);
      this.borrowed = ctx;
      this.setState('on');
    } catch (e) {
      await this.stop();
      this.setState('error', (e as Error).message);
    }
  }

  /** Route `src` through the capture worklet into the rolling buffer. */
  private async tap(ctx: AudioContext, src: AudioNode): Promise<void> {
    this.sampleRate = ctx.sampleRate;
    this.ring = new Float32Array(Math.round(ctx.sampleRate * BUFFER_SECONDS));
    this.write = 0;
    this.filled = 0;
    this.levels.length = 0;
    const sink = ctx.createGain();
    sink.gain.value = 0; // keeps the graph pulled without playing anything back
    sink.connect(ctx.destination);
    if (ctx.audioWorklet) {
      if (!AudioOracle.loaded.has(ctx)) {
        const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
        try {
          await ctx.audioWorklet.addModule(url);
          AudioOracle.loaded.add(ctx);
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      const tap = new AudioWorkletNode(ctx, 'ce-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      tap.port.onmessage = (e: MessageEvent<Float32Array>) => this.push(e.data);
      src.connect(tap).connect(sink);
      this.node = tap;
      this.srcNode = src;
      this.sinkNode = sink;
      return;
    }
    // very old browsers: ScriptProcessor fallback
    const sp = ctx.createScriptProcessor(1024, 2, 1);
    sp.onaudioprocess = (e) => {
      const b = e.inputBuffer;
      const mono = new Float32Array(b.length);
      for (let c = 0; c < b.numberOfChannels; c++) {
        const d = b.getChannelData(c);
        for (let i = 0; i < d.length; i++) mono[i] += d[i] / b.numberOfChannels;
      }
      this.push(mono);
    };
    src.connect(sp).connect(sink);
    this.node = sp;
    this.srcNode = src;
    this.sinkNode = sink;
  }

  async stop(): Promise<void> {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    try {
      if (this.srcNode && this.node) this.srcNode.disconnect(this.node);
    } catch {
      // already disconnected
    }
    this.node?.disconnect();
    this.sinkNode?.disconnect();
    this.node = undefined;
    this.srcNode = undefined;
    this.sinkNode = undefined;
    this.borrowed = undefined; // a borrowed context belongs to its owner: never close it
    const ctx = this.ctx;
    this.ctx = undefined;
    if (ctx) await ctx.close().catch(() => {});
    for (const w of this.waiters) w.resolve();
    this.waiters = [];
    if (this.state !== 'off') this.setState('off');
  }

  private push(block: Float32Array): void {
    const n = this.ring.length;
    for (let i = 0; i < block.length; i++) {
      this.ring[this.write] = block[i];
      this.write = (this.write + 1) % n;
    }
    this.filled = Math.min(n, this.filled + block.length);
    this.newestAt = performance.now();
    let ss = 0;
    for (let i = 0; i < block.length; i++) ss += block[i] * block[i];
    this.levels.push({ at: this.newestAt, db: 10 * Math.log10(ss / block.length + 1e-12) });
    while (this.levels.length > 600) this.levels.shift();
    if (this.waiters.length) {
      const ready = this.waiters.filter((w) => w.until <= this.newestAt);
      this.waiters = this.waiters.filter((w) => w.until > this.newestAt);
      for (const w of ready) w.resolve();
    }
  }

  /** Latest block level in dBFS (for meters). */
  levelDb(): number {
    return this.levels.at(-1)?.db ?? -120;
  }

  /** Samples between two performance.now() times, from the rolling buffer. */
  private slice(from: number, to: number): Float32Array {
    const sr = this.sampleRate;
    const newestIdx = this.write; // exclusive
    const back0 = Math.round(((this.newestAt - from) / 1000) * sr);
    const back1 = Math.max(0, Math.round(((this.newestAt - to) / 1000) * sr));
    const count = Math.max(0, Math.min(this.filled, back0) - back1);
    const out = new Float32Array(count);
    const n = this.ring.length;
    const start = (((newestIdx - back1 - count) % n) + n) % n;
    for (let i = 0; i < count; i++) out[i] = this.ring[(start + i) % n];
    return out;
  }

  /**
   * Measure a window that starts `offsetMs` from now (negative = in the past, from the buffer) and lasts
   * `durationMs`. Resolves as soon as the window has been captured.
   */
  async measure(durationMs = 600, offsetMs = 0) {
    if (this.state !== 'on') throw new Error(this.error ?? 'the audio oracle is off (press LISTEN)');
    const from = performance.now() + offsetMs;
    const to = from + durationMs;
    if (to > this.newestAt) {
      await new Promise<void>((resolve) => {
        const w = { until: to, resolve };
        this.waiters.push(w);
        // background tabs throttle timers, but worklet messages keep arriving; this is only a safety net
        setTimeout(resolve, to - performance.now() + 1500);
      });
    }
    if (this.state !== 'on') throw new Error('the audio input stopped during the measurement');
    const samples = this.slice(from, to);
    if (samples.length < this.sampleRate * 0.02) throw new Error('not enough audio buffered for that window');
    return computeFeatures(samples, this.sampleRate, this.input?.label);
  }
}
