import { touchPhase, type VisualSynthParameters } from './state.js';

export interface WaterAudioSample { x: number; y: number; pressure: number }
export interface WaterAudioPlan {
  phase: ReturnType<typeof touchPhase>; splash: number; hover: number; wake: number; pan: number; pitch: number;
}

/** Event-derived sound controls. A snapshot/adoption never manufactures a contact or wake. */
export class WaterAudioGesture {
  private previous?: WaterAudioSample;
  private previousAt = 0;
  sample(next: WaterAudioSample, seconds: number, live = true): WaterAudioPlan {
    const previous = this.previous;
    const phase = touchPhase(next.pressure);
    const touching = phase === 'touching';
    const dt = Math.max(.008, Math.min(.25, seconds - this.previousAt));
    const speed = previous && live ? Math.hypot(next.x - previous.x, next.y - previous.y) / dt : 0;
    const plan: WaterAudioPlan = {
      phase,
      splash: live && touching && (!previous || touchPhase(previous.pressure) !== 'touching') ? .4 + .6 * next.pressure : 0,
      hover: live && phase === 'hover' ? Math.min(1, next.pressure * 127 / 20) : 0,
      wake: live && touching ? Math.min(1, speed / 2) * (.5 + .5 * next.pressure) : 0,
      pan: Math.max(-1, Math.min(1, next.x * 2 - 1)),
      pitch: Math.max(0, Math.min(1, 1 - next.y)),
    };
    this.previous = { ...next }; this.previousAt = seconds;
    return plan;
  }
  reset(): void { this.previous = undefined; this.previousAt = 0; }
}

/** Procedural browser audio, driven only by the same touch samples that move the rendered water. */
export class WaterAudio {
  private context?: AudioContext;
  private master?: GainNode;
  private bus?: GainNode;
  private analyser?: AnalyserNode;
  private readonly samples = new Float32Array(1024);
  private wake?: GainNode;
  private shimmer?: GainNode;
  private waterFilter?: BiquadFilterNode;
  private pan?: StereoPannerNode;
  private shimmerTone?: OscillatorNode;
  private shimmerOvertone?: OscillatorNode;
  private noise?: AudioBuffer;
  private readonly sources = new Set<AudioScheduledSourceNode>();
  private readonly contactVoices: AudioScheduledSourceNode[] = [];
  private gesture = new WaterAudioGesture();
  private volume = 0;
  private active = false;
  private disposed = false;
  private idle?: ReturnType<typeof setTimeout>;
  private counters = { contacts: 0, movement: 0, hover: 0 };
  private readonly options: { createContext?: () => AudioContext };
  constructor(options: { createContext?: () => AudioContext } = {}) { this.options = options; }

  setVolume(volume: number): void {
    this.volume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0;
    if (this.context && this.master) this.master.gain.setTargetAtTime(this.active ? this.volume : 0, this.context.currentTime, .025);
  }
  async unlock(): Promise<void> {
    if (this.disposed) return;
    if (!this.context) {
      const create = this.options.createContext ?? (() => new AudioContext({ latencyHint: 'interactive' }));
      this.context = create(); this.build(this.context);
    }
    await this.context.resume();
  }
  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    if (!active) this.stop();
    if (this.context && this.master) this.master.gain.setTargetAtTime(active ? this.volume : 0, this.context.currentTime, .025);
    if (this.context) void (active ? this.context.resume() : this.context.suspend()).catch(() => {});
  }
  receive(parameters: VisualSynthParameters, live = true): void {
    const plan = this.gesture.sample({ x: parameters.touchX, y: parameters.touchY, pressure: parameters.touchPressure },
      this.context?.currentTime ?? performance.now() / 1000, live);
    if (!this.active || !this.context || this.context.state !== 'running') return;
    const c = this.context, now = c.currentTime;
    this.pan!.pan.setTargetAtTime(plan.pan, now, .04);
    this.waterFilter!.frequency.setTargetAtTime(650 + plan.pitch * 1900, now, .035);
    this.shimmerTone!.frequency.setTargetAtTime(500 + plan.pitch * 460 + plan.hover * 220, now, .05);
    this.shimmerOvertone!.frequency.setTargetAtTime(1000 + plan.pitch * 920 + plan.hover * 440, now, .05);
    // Each movement refreshes a short envelope; an absent hand cannot leave a drone behind.
    this.shimmer!.gain.cancelScheduledValues(now);
    this.shimmer!.gain.setTargetAtTime(plan.hover * .025, now, .06);
    // X/Y/pressure arrive separately. An unchanged pressure packet must not
    // erase the wake started by X/Y a few milliseconds earlier.
    if (plan.wake > .005 || plan.phase !== 'touching') {
      this.wake!.gain.cancelScheduledValues(now);
      this.wake!.gain.setTargetAtTime(plan.wake * .12, now, .025);
      this.wake!.gain.setTargetAtTime(0, now + .12, .09);
    }
    if (plan.splash && live) { this.splash(plan.splash, plan.pan); this.counters.contacts++; }
    if (plan.wake > .005) this.counters.movement++;
    if (plan.hover > 0) this.counters.hover++;
    clearTimeout(this.idle);
    // Mirrors the renderer's stale-input fade while making lost input quiet promptly.
    this.idle = setTimeout(() => this.quiet(), 1200);
  }
  /** Stop/reconnect must not replay a saved pressure as a fresh splash. */
  adopt(parameters: VisualSynthParameters): void { this.receive(parameters, false); this.quiet(); }
  stop(): void { clearTimeout(this.idle); this.idle = undefined; this.quiet(); this.gesture.reset(); }
  diagnostics() {
    let sum = 0, peak = 0;
    this.analyser?.getFloatTimeDomainData(this.samples);
    for (const value of this.samples) { sum += value * value; peak = Math.max(peak, Math.abs(value)); }
    return { ...this.counters, context: this.context?.state ?? 'locked', active: this.active, volume: this.volume,
      masterGain: this.master?.gain.value ?? 0, rmsBeforeMaster: Math.sqrt(sum / this.samples.length), peakBeforeMaster: peak };
  }
  dispose(): void {
    this.disposed = true; this.stop();
    for (const source of this.sources) { try { source.stop(); } catch { /* already ended */ } }
    this.sources.clear(); void this.context?.close().catch(() => {}); this.context = undefined;
  }
  private quiet(): void {
    if (!this.context) return;
    const now = this.context.currentTime;
    for (const gain of [this.wake, this.shimmer]) if (gain) { gain.gain.cancelScheduledValues(now); gain.gain.setValueAtTime(0, now); }
    for (const voice of this.contactVoices.splice(0)) { try { voice.stop(now); } catch { /* already ended */ } }
  }
  private build(c: AudioContext): void {
    this.master = c.createGain(); this.master.gain.value = this.active ? this.volume : 0; this.master.connect(c.destination);
    this.bus = c.createGain(); this.analyser = c.createAnalyser(); this.analyser.fftSize = this.samples.length;
    this.bus.connect(this.analyser); this.analyser.connect(this.master);
    this.pan = c.createStereoPanner(); this.pan.connect(this.bus);
    this.waterFilter = c.createBiquadFilter(); this.waterFilter.type = 'lowpass'; this.waterFilter.frequency.value = 1300; this.waterFilter.Q.value = .8;
    this.wake = c.createGain(); this.wake.gain.value = 0; this.waterFilter.connect(this.wake); this.wake.connect(this.pan);
    this.shimmer = c.createGain(); this.shimmer.gain.value = 0; this.shimmer.connect(this.pan);
    this.noise = c.createBuffer(1, Math.ceil(c.sampleRate * .6), c.sampleRate);
    const data = this.noise.getChannelData(0); let random = 0x51a7b, last = 0;
    for (let i = 0; i < data.length; i++) { random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
      last = last * .45 + ((random >>> 0) / 0xffffffff * 2 - 1) * .55; data[i] = last; }
    const noise = c.createBufferSource(); noise.buffer = this.noise; noise.loop = true; noise.connect(this.waterFilter); this.sources.add(noise); noise.start();
    this.shimmerTone = c.createOscillator(); this.shimmerTone.type = 'sine'; this.shimmerTone.frequency.value = 700; this.shimmerTone.connect(this.shimmer);
    const overtoneGain = c.createGain(); overtoneGain.gain.value = .25; overtoneGain.connect(this.shimmer);
    this.shimmerOvertone = c.createOscillator(); this.shimmerOvertone.type = 'sine'; this.shimmerOvertone.frequency.value = 1400; this.shimmerOvertone.connect(overtoneGain);
    for (const source of [this.shimmerTone, this.shimmerOvertone]) { this.sources.add(source); source.start(); }
  }
  private splash(strength: number, pan: number): void {
    const c = this.context!, now = c.currentTime;
    // Bounded voices: contacts can overlap briefly without accumulating an audio graph.
    while (this.contactVoices.length >= 4) { try { this.contactVoices.shift()!.stop(); } catch { /* ended */ } }
    const position = c.createStereoPanner(); position.pan.value = pan; position.connect(this.bus!);
    const filter = c.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.setValueAtTime(2600, now); filter.frequency.exponentialRampToValueAtTime(380, now + .35); filter.Q.value = .6;
    const spray = c.createGain(); spray.gain.setValueAtTime(.001, now); spray.gain.exponentialRampToValueAtTime(.26 * strength, now + .008); spray.gain.exponentialRampToValueAtTime(.001, now + .44);
    const noise = c.createBufferSource(); noise.buffer = this.noise!; noise.playbackRate.value = .8 + strength * .3;
    noise.connect(filter); filter.connect(spray); spray.connect(position);
    const plop = c.createOscillator(); plop.type = 'sine'; plop.frequency.setValueAtTime(230 + strength * 110, now); plop.frequency.exponentialRampToValueAtTime(65, now + .18);
    const body = c.createGain(); body.gain.setValueAtTime(.001, now); body.gain.exponentialRampToValueAtTime(.2 * strength, now + .007); body.gain.exponentialRampToValueAtTime(.001, now + .25);
    plop.connect(body); body.connect(position);
    let ended = 0;
    for (const source of [noise, plop]) {
      this.sources.add(source); this.contactVoices.push(source);
      source.onended = () => { this.sources.delete(source); const index = this.contactVoices.indexOf(source); if (index >= 0) this.contactVoices.splice(index, 1);
        if (++ended === 2) { noise.disconnect(); plop.disconnect(); filter.disconnect(); spray.disconnect(); body.disconnect(); position.disconnect(); } };
      source.start(now); source.stop(now + .5);
    }
  }
}
