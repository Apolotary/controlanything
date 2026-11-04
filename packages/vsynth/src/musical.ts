import { MUSICAL_CONTROLS, MUSICAL_SCALE, musicalDefaults, type MusicalParameters } from './musical-manifest.js';
export interface MusicalReceipt {
  params: MusicalParameters;
  audio: { unlocked: boolean; muted: boolean; rms: number; peak: number; frequency: number; activeNote?: number };
  frame: number; at: number;
}
/** Authored monophonic sound engine. Only a deliberate Mac click may call unlock(). */
export class MusicalSynth {
  private ctx?: AudioContext;
  private oscillator?: OscillatorNode;
  private filter?: BiquadFilterNode;
  private envelope?: GainNode;
  private dry?: GainNode;
  private wet?: GainNode;
  private delayNode?: DelayNode;
  private feedback?: GainNode;
  private master?: GainNode;
  private analyser?: AnalyserNode;
  private wave?: Float32Array<ArrayBuffer>;
  private frame = 0;
  private generation = 0;
  private noteTimer?: ReturnType<typeof setTimeout>;
  private state = musicalDefaults();
  private unlocked = false;
  constructor(private readonly options: { muted?: boolean; changed?(): void; context?(): AudioContext } = {}) {}
  get enabled(): boolean { return this.unlocked && this.ctx?.state === 'running'; }
  get clock(): { contextTime: number; contextState: AudioContextState | 'closed' } {
    return { contextTime: this.ctx?.currentTime ?? 0, contextState: this.ctx?.state ?? 'closed' };
  }
  getState(): MusicalParameters { return { ...this.state }; }
  async unlock(): Promise<boolean> {
    const generation = ++this.generation;
    if (!this.ctx) {
      const ctx = this.ctx = this.options.context?.() ?? new AudioContext();
      const osc = this.oscillator = ctx.createOscillator();
      const filter = this.filter = ctx.createBiquadFilter(); filter.type = 'lowpass';
      const env = this.envelope = ctx.createGain(); env.gain.value = 0;
      const dry = this.dry = ctx.createGain(), wet = this.wet = ctx.createGain();
      const delay = this.delayNode = ctx.createDelay(1); delay.delayTime.value = .18;
      const feedback = this.feedback = ctx.createGain(); feedback.gain.value = .25;
      const analyser = this.analyser = ctx.createAnalyser(); analyser.fftSize = 2048;
      const master = this.master = ctx.createGain(); master.gain.value = 0;
      osc.connect(filter); filter.connect(env); env.connect(dry); dry.connect(analyser);
      env.connect(delay); delay.connect(wet); wet.connect(analyser); delay.connect(feedback); feedback.connect(delay);
      analyser.connect(master); master.connect(ctx.destination); this.wave = new Float32Array(analyser.fftSize);
      osc.start(); this.applyParameters();
    }
    const ctx = this.ctx;
    try { await ctx.resume(); } catch { return false; }
    if (this.ctx !== ctx || this.generation !== generation) return false;
    // Chrome can resolve resume() while its output device is still starting. Do not
    // publish a ready port until actual render quanta advance; the envelope and
    // master remain zero throughout this bounded, cancellable clock check.
    const clockStart = ctx.currentTime, deadline = Date.now() + 4000;
    while (ctx.currentTime - clockStart < .05) {
      if (this.ctx !== ctx || this.generation !== generation) return false;
      if (ctx.state !== 'running' || Date.now() >= deadline) { this.lock(); return false; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (this.ctx !== ctx || this.generation !== generation) return false;
    this.unlocked = ctx.state === 'running';
    this.master!.gain.setValueAtTime(this.options.muted ? 0 : .16, ctx.currentTime);
    this.options.changed?.(); return this.enabled;
  }
  /** Immediate silence also kills the delay tail; re-enabling requires another click. */
  lock(): void {
    clearTimeout(this.noteTimer); this.noteTimer = undefined;
    this.generation++; this.unlocked = false; this.state.gate = 0;
    const ctx = this.ctx;
    if (ctx) {
      this.master?.gain.cancelScheduledValues(ctx.currentTime); this.master?.gain.setValueAtTime(0, ctx.currentTime);
      this.envelope?.gain.cancelScheduledValues(ctx.currentTime); this.envelope?.gain.setValueAtTime(0, ctx.currentTime);
      this.oscillator?.stop(); void ctx.close().catch(() => {});
    }
    this.ctx = undefined; this.oscillator = undefined; this.filter = undefined; this.envelope = undefined;
    this.dry = this.wet = this.feedback = this.master = undefined; this.delayNode = undefined;
    this.analyser = undefined; this.wave = undefined;
    this.options.changed?.();
  }
  dispose(): void { this.lock(); }
  get masterGain(): number { return this.master?.gain.value ?? 0; }
  receiveMidi(bytes: readonly number[]): boolean {
    if (bytes[0] === 0xff || bytes[0] === 0xb0 && [120, 121, 123].includes(bytes[1]!)) { this.lock(); return true; }
    if (!this.enabled || bytes[0] === undefined || (bytes[0] & 15) !== 0) return false;
    const command = bytes[0] & 0xf0;
    if (command === 0xc0) {
      const preset = bytes[1]; if (preset === undefined || !Number.isInteger(preset) || preset < 0 || preset > 2) return false;
      this.release(); this.state.preset = preset;
      Object.assign(this.state, preset === 0 ? { cutoff: 80, resonance: 20, attack: 10, release: 30, delay: 24 }
        : preset === 1 ? { cutoff: 110, resonance: 8, attack: 2, release: 60, delay: 70 }
          : { cutoff: 95, resonance: 40, attack: 0, release: 10, delay: 18 });
      this.applyParameters(); this.options.changed?.(); return true;
    }
    if (command !== 0xb0) return false;
    const control = MUSICAL_CONTROLS.find(c => c.cc === bytes[1]), value = bytes[2];
    if (!control || value === undefined || !Number.isFinite(value) || value < control.min || value > control.max) return false;
    const before = this.state.gate >= 64;
    this.state[control.parameter] = Math.round(value);
    this.applyParameters();
    if (control.parameter === 'gate') {
      if (this.state.gate >= 64 && !before) this.attack();
      else if (this.state.gate < 64 && before) this.release();
    }
    this.options.changed?.(); return true;
  }
  private applyParameters(): void {
    const ctx = this.ctx; if (!ctx) return;
    const at = ctx.currentTime, s = this.state;
    if (this.oscillator) {
      this.oscillator.type = (['triangle', 'sine', 'sawtooth'] as OscillatorType[])[s.preset] ?? 'triangle';
      this.oscillator.frequency.setTargetAtTime(440 * 2 ** ((MUSICAL_SCALE[s.noteIndex]! - 69) / 12), at, .012);
    }
    this.filter?.frequency.setTargetAtTime(80 * 100 ** (s.cutoff / 127), at, .015);
    this.filter?.Q.setTargetAtTime(.2 + s.resonance / 127 * 11.8, at, .015);
    this.wet?.gain.setTargetAtTime(s.delay / 127 * .5, at, .015);
    this.dry?.gain.setTargetAtTime(1 - s.delay / 127 * .25, at, .015);
  }
  private attack(): void {
    const ctx = this.ctx; if (!ctx || !this.enabled) return;
    const gain = this.envelope!.gain, now = ctx.currentTime;
    gain.cancelScheduledValues(now); gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(.65, now + .005 + this.state.attack / 127 * 1.495);
    // A stale held gate cannot leave a note sounding forever after a network failure.
    clearTimeout(this.noteTimer); this.noteTimer = setTimeout(() => { this.release(); this.options.changed?.(); }, 8000);
  }
  private release(): void {
    clearTimeout(this.noteTimer); this.noteTimer = undefined; this.state.gate = 0;
    const ctx = this.ctx; if (!ctx) return;
    const gain = this.envelope!.gain, now = ctx.currentTime;
    gain.cancelScheduledValues(now); gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(0, now + .03 + this.state.release / 127 * 1.97);
  }
  receipt(): MusicalReceipt {
    let rms = 0, peak = 0, frequency = 0;
    if (this.enabled && this.analyser && this.wave && this.ctx) {
      this.analyser.getFloatTimeDomainData(this.wave);
      let first = -1, last = -1, crossings = 0;
      for (let i = 0; i < this.wave.length; i++) {
        const value = this.wave[i]!; rms += value * value; peak = Math.max(peak, Math.abs(value));
        if (i && this.wave[i - 1]! <= 0 && value > 0) { const crossing = i - 1 - this.wave[i - 1]! / (value - this.wave[i - 1]!); if (first < 0) first = crossing; last = crossing; crossings++; }
      }
      rms = Math.sqrt(rms / this.wave.length);
      if (rms > 1e-5 && crossings > 1 && last > first) frequency = this.ctx.sampleRate * (crossings - 1) / (last - first);
    }
    return { params: this.getState(), audio: { unlocked: this.enabled, muted: !!this.options.muted, rms, peak, frequency,
      ...(this.state.gate >= 64 ? { activeNote: MUSICAL_SCALE[this.state.noteIndex] } : {}) }, frame: ++this.frame, at: Date.now() };
  }
}
