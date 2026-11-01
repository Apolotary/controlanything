/**
 * The virtual synth's voice (Web Audio). Paraphonic: up to 8 voices of saw + detuned square into one
 * resonant low-pass filter, drive, chorus + delay, track volume/mute/pan and a 3-band master EQ. Every
 * parameter is driven by the OP-1 Field CC numbers (see ccmap.ts).
 *
 * The AudioContext starts on the first user gesture (browser autoplay rules). CC values received before that
 * are kept and applied when audio starts; notes before that are dropped and reported.
 */
import { CC_BY_NUMBER, type CcDef, INITIAL_CC, tempoFromCc } from './ccmap';

export interface CcEvent {
  cc: number;
  value: number;
  channel: number;
  def?: CcDef;
  /** the CC changed the sound (false: not modelled, ignored or wrong channel) */
  applied: boolean;
  note: string;
  at: number;
}

export interface NoteEvent {
  on: boolean;
  note: number;
  velocity: number;
  channel: number;
  accepted: boolean;
  at: number;
}

type Listener<T> = (e: T) => void;

interface Voice {
  note: number;
  oscA: OscillatorNode;
  oscB: OscillatorNode;
  gain: GainNode;
  velocity: number;
  releasing: boolean;
  held: boolean;
  startedAt: number;
}

const MAX_VOICES = 8;
const LOOP_PATTERN = [45, 57, 52, 57, 48, 60, 55, 60, 43, 55, 50, 55, 47, 59, 52, 59]; // A minor walk, 16ths

export class SynthEngine {
  ctx?: AudioContext;
  analyser?: AnalyserNode;
  /**
   * `?mute=1`: the whole graph runs (notes, CCs, analyser, audio features and the audio-clock ticker are
   * unchanged) but the master bus reaches the speakers through a zero gain, so a silent machine can still
   * verify the synth by its audio features. Set before the first start(); setMuted() flips it later.
   */
  muted = false;
  private out?: GainNode;
  /** the synth listens to notes on this channel only (like SYSTEM > MIDI on the device) */
  channel = 1;
  readonly cc = new Map<number, number>(Object.entries(INITIAL_CC).map(([k, v]) => [Number(k), v]));
  private voices: Voice[] = [];
  private pedal = false;
  private n: Partial<{
    filter: BiquadFilterNode;
    drive: WaveShaperNode;
    driveOut: GainNode;
    dry: GainNode;
    wet: GainNode;
    chorus: DelayNode;
    chorusDepth: GainNode;
    delay: DelayNode;
    feedback: GainNode;
    track: GainNode;
    trem: GainNode;
    tremDepth: GainNode;
    pan: StereoPannerNode;
    eqLow: BiquadFilterNode;
    eqMid: BiquadFilterNode;
    eqHigh: BiquadFilterNode;
    master: GainNode;
    lfo: OscillatorNode;
    lfoCutoff: GainNode;
    lfoPitch: GainNode;
  }> = {};
  private loopTimer?: ReturnType<typeof setInterval>;
  private loopStep = 0;
  private loopNextTime = 0;
  looping = false;
  private readonly ccListeners = new Set<Listener<CcEvent>>();
  private readonly noteListeners = new Set<Listener<NoteEvent>>();
  private readonly stateListeners = new Set<Listener<string>>();
  private readonly tickListeners = new Set<() => void>();
  private tickFallback?: ReturnType<typeof setInterval>;

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  /** Speakers on/off without touching the graph (the analyser keeps reading the synth's own output). */
  setMuted(v: boolean): void {
    this.muted = v;
    if (this.out && this.ctx) this.out.gain.setTargetAtTime(v ? 0 : 1, this.ctx.currentTime, 0.01);
  }

  onCc(fn: Listener<CcEvent>): () => void {
    this.ccListeners.add(fn);
    return () => this.ccListeners.delete(fn);
  }

  onNote(fn: Listener<NoteEvent>): () => void {
    this.noteListeners.add(fn);
    return () => this.noteListeners.delete(fn);
  }

  onState(fn: Listener<string>): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  /**
   * ~21 ms ticks on the AUDIO clock (an AudioWorklet posting every 8 render quanta). Timers and rAF are throttled
   * in background tabs; the audio thread is not, so audio features stay correct while the sim tab is hidden.
   */
  onTick(fn: () => void): () => void {
    this.tickListeners.add(fn);
    return () => this.tickListeners.delete(fn);
  }

  private startTicker(ctx: AudioContext, tap: AudioNode): void {
    const code = `class CeTick extends AudioWorkletProcessor{constructor(){super();this.n=0}process(){if(++this.n>=8){this.n=0;this.port.postMessage(0)}return true}}registerProcessor('ce-tick',CeTick);`;
    const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
    const fire = () => {
      for (const fn of this.tickListeners) fn();
    };
    ctx.audioWorklet
      .addModule(url)
      .then(() => {
        const node = new AudioWorkletNode(ctx, 'ce-tick', { numberOfInputs: 1, numberOfOutputs: 1 });
        node.port.onmessage = fire;
        const mute = new GainNode(ctx, { gain: 0 });
        tap.connect(node).connect(mute).connect(ctx.destination);
      })
      .catch(() => {
        this.tickFallback = setInterval(fire, 20); // no AudioWorklet: timers (throttled in background tabs)
      })
      .finally(() => URL.revokeObjectURL(url));
  }

  /** Call from a user gesture. Idempotent. */
  async start(): Promise<boolean> {
    if (!this.ctx) this.build();
    if (this.ctx!.state !== 'running') {
      try {
        await this.ctx!.resume();
      } catch {
        // still suspended (no gesture yet)
      }
    }
    for (const fn of this.stateListeners) fn(this.ctx!.state);
    return this.running;
  }

  private build(): void {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    ctx.onstatechange = () => {
      for (const fn of this.stateListeners) fn(ctx.state);
    };
    const n = this.n;
    n.filter = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 2000, Q: 2 });
    n.drive = new WaveShaperNode(ctx, { oversample: '2x' });
    n.driveOut = new GainNode(ctx, { gain: 1 });
    n.dry = new GainNode(ctx, { gain: 1 });
    n.wet = new GainNode(ctx, { gain: 0.3 });
    n.chorus = new DelayNode(ctx, { delayTime: 0.014, maxDelayTime: 0.05 });
    n.chorusDepth = new GainNode(ctx, { gain: 0.002 });
    n.delay = new DelayNode(ctx, { delayTime: 0.33, maxDelayTime: 1.0 });
    n.feedback = new GainNode(ctx, { gain: 0.35 });
    const fbTone = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 3500 });
    n.track = new GainNode(ctx, { gain: 0.6 });
    n.trem = new GainNode(ctx, { gain: 1 });
    n.tremDepth = new GainNode(ctx, { gain: 0 });
    n.pan = new StereoPannerNode(ctx, { pan: 0 });
    n.eqLow = new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: 220, gain: 0 });
    n.eqMid = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 1200, Q: 0.9, gain: 0 });
    n.eqHigh = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 4500, gain: 0 });
    n.master = new GainNode(ctx, { gain: 0.8 });
    this.analyser = new AnalyserNode(ctx, { fftSize: 4096, smoothingTimeConstant: 0 });
    // LFO (CC 58-61) and a slow chorus LFO
    n.lfo = new OscillatorNode(ctx, { type: 'sine', frequency: 1 });
    n.lfoCutoff = new GainNode(ctx, { gain: 0 });
    n.lfoPitch = new GainNode(ctx, { gain: 0 });
    const chorusLfo = new OscillatorNode(ctx, { type: 'sine', frequency: 0.8 });
    chorusLfo.connect(n.chorusDepth).connect(n.chorus.delayTime);
    n.lfo.connect(n.lfoCutoff).connect(n.filter.detune);
    n.lfo.connect(n.lfoPitch);
    n.lfo.connect(n.tremDepth).connect(n.trem.gain);
    n.lfo.start();
    chorusLfo.start();
    // signal path
    n.filter.connect(n.drive).connect(n.driveOut);
    n.driveOut.connect(n.dry);
    n.driveOut.connect(n.chorus).connect(n.delay);
    n.delay.connect(fbTone).connect(n.feedback).connect(n.delay);
    n.chorus.connect(n.wet);
    n.delay.connect(n.wet);
    n.dry.connect(n.track);
    n.wet.connect(n.track);
    n.track.connect(n.trem).connect(n.pan).connect(n.eqLow).connect(n.eqMid).connect(n.eqHigh).connect(n.master);
    n.master.connect(this.analyser);
    this.out = new GainNode(ctx, { gain: this.muted ? 0 : 1 });
    n.master.connect(this.out).connect(ctx.destination);
    this.startTicker(ctx, n.master);
    for (const [cc, v] of this.cc) this.apply(cc, v, true);
  }

  // --- MIDI in -----------------------------------------------------------------------------------

  /** Handle one CC. Returns what happened (also emitted to listeners). */
  controlChange(channel: number, cc: number, value: number): CcEvent {
    const def = CC_BY_NUMBER.get(cc);
    const at = Date.now();
    let applied = false;
    let note: string;
    if (!def) note = `CC ${cc} is not in the OP-1 Field chart: ignored`;
    else if ([7, 9, 10].includes(cc) && channel !== this.channel) note = `${def.chart} on channel ${channel} = tape track ${channel}: not the live synth`;
    else if (def.unsafe) note = `${def.chart}: destructive on the real device, ignored by the sim`;
    else if (!def.audible) note = `${def.chart}: accepted, not modelled in the sim voice`;
    else {
      this.cc.set(cc, value);
      applied = true;
      note = `${def.sim} = ${value}`;
      if (cc === 123) this.allNotesOff();
      else if (cc === 64) this.setPedal(value >= 64);
      else if (cc === 104 && value >= 64) this.setLoop(false);
      else if (cc === 105 && value >= 64) this.setLoop(true);
      else this.apply(cc, value, false);
    }
    const e: CcEvent = { cc, value, channel, def, applied, note, at };
    for (const fn of this.ccListeners) fn(e);
    return e;
  }

  /** `durationMs` > 0 schedules the release on the audio clock (exact even in a throttled background tab). */
  noteOn(channel: number, note: number, velocity = 100, durationMs = 0): NoteEvent {
    const accepted = channel === this.channel && this.running;
    if (accepted) this.startVoice(note, velocity, false, durationMs);
    const e: NoteEvent = { on: true, note, velocity, channel, accepted, at: Date.now() };
    for (const fn of this.noteListeners) fn(e);
    return e;
  }

  noteOff(channel: number, note: number): NoteEvent {
    const accepted = channel === this.channel;
    if (accepted) this.releaseVoice(note);
    const e: NoteEvent = { on: false, note, velocity: 0, channel, accepted, at: Date.now() };
    for (const fn of this.noteListeners) fn(e);
    return e;
  }

  /** Release everything (MIDI panic): notes, pedal, loop. */
  panic(): void {
    this.setLoop(false);
    this.pedal = false;
    this.allNotesOff(true);
  }

  // --- loop ("tape") -------------------------------------------------------------------------------

  setLoop(on: boolean): void {
    if (on === this.looping) return;
    this.looping = on;
    if (this.loopTimer) clearInterval(this.loopTimer);
    this.loopTimer = undefined;
    if (on && this.ctx) {
      this.loopNextTime = this.ctx.currentTime + 0.05;
      this.loopStep = 0;
      this.loopTimer = setInterval(() => this.scheduleLoop(), 25);
    }
    for (const fn of this.stateListeners) fn(this.ctx?.state ?? 'suspended');
  }

  private scheduleLoop(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const stepDur = 60 / tempoFromCc(this.cc.get(80) ?? 74) / 4;
    while (this.loopNextTime < ctx.currentTime + 0.12) {
      const note = LOOP_PATTERN[this.loopStep % LOOP_PATTERN.length]!;
      const t = this.loopNextTime;
      const delayMs = Math.max(0, (t - ctx.currentTime) * 1000);
      setTimeout(() => {
        if (!this.looping) return;
        this.startVoice(note, this.loopStep % 4 === 0 ? 112 : 88, true);
        setTimeout(() => this.releaseVoice(note, true), stepDur * 1000 * 0.7);
      }, delayMs);
      this.loopStep++;
      this.loopNextTime += stepDur;
    }
  }

  // --- voices --------------------------------------------------------------------------------------

  private startVoice(note: number, velocity: number, fromLoop = false, durationMs = 0): void {
    const ctx = this.ctx;
    const n = this.n;
    if (!ctx || !n.filter || ctx.state !== 'running') return;
    const existing = this.voices.find((v) => v.note === note && !v.releasing);
    if (existing) this.killVoice(existing, 0.01);
    if (this.voices.length >= MAX_VOICES) this.killVoice(this.voices[0]!, 0.01); // oldest-note stealing
    const now = ctx.currentTime;
    const f = 440 * 2 ** ((note - 69) / 12);
    const spread = ((this.cc.get(48) ?? 24) / 127) * 28;
    const oscA = new OscillatorNode(ctx, { type: 'sawtooth', frequency: f, detune: -spread });
    const oscB = new OscillatorNode(ctx, { type: 'square', frequency: f, detune: spread });
    const mixB = new GainNode(ctx, { gain: 0.18 + ((this.cc.get(48) ?? 24) / 127) * 0.3 });
    const gain = new GainNode(ctx, { gain: 0 });
    oscA.connect(gain);
    oscB.connect(mixB).connect(gain);
    n.lfoPitch!.connect(oscA.detune);
    n.lfoPitch!.connect(oscB.detune);
    gain.connect(n.filter);
    const vel = (velocity / 127) ** 1.6 * 0.32;
    const A = this.attack();
    const D = this.decay();
    const S = this.sustain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(vel, now + A);
    gain.gain.setTargetAtTime(vel * S, now + A, D / 3);
    oscA.start(now);
    oscB.start(now);
    const voice: Voice = { note, oscA, oscB, gain, velocity, releasing: false, held: !fromLoop && this.pedal, startedAt: now };
    this.voices.push(voice);
    if (durationMs > 0) {
      const off = now + durationMs / 1000;
      const r = this.release();
      gain.gain.setTargetAtTime(0, off, Math.max(0.005, r / 3));
      oscA.stop(off + Math.max(0.03, r * 1.6));
      oscB.stop(off + Math.max(0.03, r * 1.6));
      oscA.onended = () => {
        voice.releasing = true;
        try {
          gain.disconnect();
          this.n.lfoPitch?.disconnect(oscA.detune);
          this.n.lfoPitch?.disconnect(oscB.detune);
        } catch {
          // already disconnected
        }
        this.voices = this.voices.filter((x) => x !== voice);
      };
    }
  }

  private releaseVoice(note: number, fromLoop = false): void {
    for (const v of this.voices) {
      if (v.note !== note || v.releasing) continue;
      if (this.pedal && !fromLoop) {
        v.held = true;
        continue;
      }
      this.killVoice(v, this.release());
    }
  }

  private killVoice(v: Voice, releaseS: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    v.releasing = true;
    const now = ctx.currentTime;
    v.gain.gain.cancelScheduledValues(now);
    v.gain.gain.setValueAtTime(v.gain.gain.value, now);
    v.gain.gain.setTargetAtTime(0, now, Math.max(0.005, releaseS / 3));
    const stopAt = now + Math.max(0.03, releaseS * 1.6);
    v.oscA.stop(stopAt);
    v.oscB.stop(stopAt);
    v.oscA.onended = () => {
      try {
        v.gain.disconnect();
        this.n.lfoPitch?.disconnect(v.oscA.detune);
        this.n.lfoPitch?.disconnect(v.oscB.detune);
      } catch {
        // already disconnected
      }
      this.voices = this.voices.filter((x) => x !== v);
    };
  }

  private allNotesOff(hard = false): void {
    for (const v of [...this.voices]) if (!v.releasing) this.killVoice(v, hard ? 0.01 : this.release());
  }

  private setPedal(down: boolean): void {
    this.pedal = down;
    if (!down) for (const v of this.voices) if (v.held && !v.releasing) this.killVoice(v, this.release());
  }

  activeNotes(): number[] {
    return this.voices.filter((v) => !v.releasing).map((v) => v.note);
  }

  // --- parameters ------------------------------------------------------------------------------------

  private attack = () => 0.001 + ((this.cc.get(50) ?? 4) / 127) ** 2 * 2;
  private decay = () => 0.01 + ((this.cc.get(51) ?? 50) / 127) ** 2 * 3;
  private sustain = () => (this.cc.get(52) ?? 90) / 127;
  private release = () => 0.01 + ((this.cc.get(53) ?? 40) / 127) ** 2 * 4;

  private apply(cc: number, value: number, instant: boolean): void {
    const ctx = this.ctx;
    const n = this.n;
    if (!ctx || !n.filter) return;
    const now = ctx.currentTime;
    const tc = instant ? 0.001 : 0.02;
    const set = (p: AudioParam, v: number) => p.setTargetAtTime(v, now, tc);
    const x = value / 127;
    switch (cc) {
      case 46:
        set(n.filter.frequency, 60 * 2 ** (x * 7.6));
        break;
      case 47:
        set(n.filter.Q, 0.5 + x ** 1.5 * 17);
        break;
      case 48:
        break; // read at note-on (spread + square level)
      case 49: {
        const k = 1 + x ** 1.5 * 24;
        const curve = new Float32Array(2048);
        const norm = Math.tanh(k);
        for (let i = 0; i < curve.length; i++) {
          const t = (i / (curve.length - 1)) * 2 - 1;
          curve[i] = Math.tanh(k * t) / norm;
        }
        n.drive!.curve = curve;
        set(n.driveOut!.gain, 1 / (1 + x * 1.4));
        break;
      }
      case 54:
        set(n.delay!.delayTime, 0.04 + x ** 1.3 * 0.76);
        break;
      case 55:
        set(n.feedback!.gain, x * 0.85);
        break;
      case 56:
        set(n.chorusDepth!.gain, x * 0.008);
        break;
      case 57:
        set(n.wet!.gain, x * 0.9);
        set(n.dry!.gain, 1 - x * 0.45);
        break;
      case 58:
        set(n.lfo!.frequency, 0.05 + x ** 2 * 12);
        break;
      case 59:
        set(n.lfoCutoff!.gain, x * 2400);
        break;
      case 60:
        set(n.lfoPitch!.gain, x * 60);
        break;
      case 61:
        set(n.tremDepth!.gain, x * 0.5);
        set(n.trem!.gain, 1 - x * 0.5);
        break;
      case 7:
      case 9: {
        const vol = ((this.cc.get(7) ?? 100) / 127) ** 2;
        const muted = (this.cc.get(9) ?? 0) >= 64;
        set(n.track!.gain, muted ? 0 : vol * 0.95);
        break;
      }
      case 10:
        set(n.pan!.pan, Math.max(-1, Math.min(1, (value - 64) / 63)));
        break;
      case 90:
        set(n.eqLow!.gain, ((value - 64) / 64) * 12);
        break;
      case 91:
        set(n.eqMid!.gain, ((value - 64) / 64) * 12);
        break;
      case 92:
        set(n.eqHigh!.gain, ((value - 64) / 64) * 12);
        break;
      default:
        break;
    }
  }
}
