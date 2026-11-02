/**
 * Microphone → PCM16 mono 16 kHz in ~100 ms chunks, via an AudioWorklet (no Web Speech API in Quest Browser;
 * MediaRecorder's webm/opus is rejected by the ASR). Prepare it from a 2D-page tap BEFORE entering XR so the
 * permission prompt and the AudioContext unlock happen outside the session; push-to-talk then only gates chunks.
 */
import type { AudioFeatures } from '@ce/protocol';
import { wireFeatures } from '../../../companion/src/audio/features';
import { AudioOracle } from '../../../companion/src/audio/oracle';
import { Emitter } from '../app/emitter';

export const TARGET_RATE = 16_000;

/** Worklet source, loaded from a Blob URL (no bundler step needed). Same algorithm as wav.ts LinearResampler. */
const WORKLET = `
class CePcmTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const target = (options && options.processorOptions && options.processorOptions.targetRate) || 16000;
    this.ratio = sampleRate / target;
    this.pos = -1;
    this.prev = 0;
    this.chunk = new Int16Array(Math.round(target * 0.1));
    this.n = 0;
    this.active = false;
    this.levelSum = 0;
    this.levelCount = 0;
    this.blocks = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'start') { this.active = true; this.n = 0; }
      else if (e.data === 'stop') { this.flush(true); this.active = false; }
    };
  }
  flush(final) {
    const out = this.chunk.slice(0, this.n);
    this.n = 0;
    this.port.postMessage({ type: 'pcm', pcm: out.buffer, final }, [out.buffer]);
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let sum = 0;
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
    this.levelSum += sum; this.levelCount += ch.length;
    if (++this.blocks % 6 === 0) {
      this.port.postMessage({ type: 'level', rms: Math.sqrt(this.levelSum / Math.max(1, this.levelCount)) });
      this.levelSum = 0; this.levelCount = 0;
    }
    const n = ch.length;
    if (this.active) {
      let t = this.pos;
      while (t < n - 1) {
        const i = Math.floor(t);
        const f = t - i;
        const a = i < 0 ? this.prev : ch[i];
        const b = ch[i + 1];
        let s = a + (b - a) * f;
        s = s < -1 ? -1 : s > 1 ? 1 : s;
        this.chunk[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.n === this.chunk.length) this.flush(false);
        t += this.ratio;
      }
      this.pos = t - n;
    }
    this.prev = ch[n - 1];
    return true;
  }
}
registerProcessor('ce-pcm-tap', CePcmTap);
`;

export interface MicEvents extends Record<string, unknown> {
  level: number;
  chunk: { pcm: Int16Array; final: boolean };
}

export class Mic extends Emitter<MicEvents> {
  private ctx?: AudioContext;
  private node?: AudioWorkletNode;
  private stream?: MediaStream;
  private preparing?: Promise<void>;
  /** Shares the prepared input/context with PTT; it only captures and never plays audio. */
  private readonly oracle = new AudioOracle();
  ready = false;
  rate = TARGET_RATE;
  label = '';

  /** getUserMedia + AudioContext + worklet. Call from a user gesture. */
  async prepare(): Promise<void> {
    if (this.ready) {
      await this.ctx?.resume();
      return;
    }
    if (!this.preparing) this.preparing = this.open().finally(() => { this.preparing = undefined; });
    await this.preparing;
  }

  private async open(): Promise<void> {
    try {
      await this.openInput();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  private async openInput(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia unavailable (needs a secure context)');
    this.stream = await navigator.mediaDevices.getUserMedia({
      // Speech processing changes level/timbre and would invalidate a synth comparison.
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
    const track = this.stream.getAudioTracks()[0];
    this.label = (track?.label || 'Quest 3 microphone').slice(0, 120);
    try {
      this.ctx = new AudioContext({ sampleRate: TARGET_RATE });
    } catch {
      this.ctx = new AudioContext(); // the worklet resamples
    }
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    try {
      await this.ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'ce-pcm-tap', { processorOptions: { targetRate: TARGET_RATE } });
    this.node.port.onmessage = (e: MessageEvent<{ type: string; pcm?: ArrayBuffer; final?: boolean; rms?: number }>) => {
      if (e.data.type === 'level') this.emit('level', e.data.rms ?? 0);
      else if (e.data.type === 'pcm' && e.data.pcm) this.emit('chunk', { pcm: new Int16Array(e.data.pcm), final: Boolean(e.data.final) });
    };
    src.connect(this.node);
    // keep the graph pulling without making a sound
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.node.connect(mute).connect(this.ctx.destination);
    await this.ctx.resume();
    await this.oracle.startFromNode(this.ctx, src, this.label);
    if (this.oracle.state !== 'on') throw new Error(this.oracle.error ?? 'Microphone sensing could not start');
    track?.addEventListener('ended', () => this.close());
    this.ready = true;
  }

  /** Verification uses the continuously buffered input without starting/stopping push-to-talk. */
  async measure(durationMs = 600, offsetMs = 0): Promise<AudioFeatures> {
    if (!this.ready || this.ctx?.state !== 'running') throw new Error('Enable the headset microphone before setting up the synth');
    return wireFeatures(await this.oracle.measure(durationMs, offsetMs));
  }

  start(): void {
    void this.ctx?.resume();
    this.node?.port.postMessage('start');
  }

  stop(): void {
    this.node?.port.postMessage('stop');
  }

  close(): void {
    this.ready = false;
    void this.oracle.stop();
    if (this.node) this.node.port.onmessage = null;
    this.node?.disconnect();
    this.node = undefined;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    void this.ctx?.close();
    this.ctx = undefined;
  }
}
