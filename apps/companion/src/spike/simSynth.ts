/**
 * A small Web Audio synth behind a virtual MIDI port, so the spike runs end to end with no hardware
 * (and in browsers that refuse Web MIDI). It follows the OP-1 Field CC map for the parameters it has
 * and answers the identity request with the MMA non-commercial id 7D: it never impersonates a real device.
 *   CC 46 cutoff · 47 resonance · 48 detune · 49 drive · 54 delay time · 55 feedback · 57 delay mix
 *   CC 7 volume · 10 pan · 90/91/92 EQ low/mid/high · notes on any channel · CC 123/120 all off
 */
import type { MidiInEvent, MidiIO, MidiPortLike } from '../midiExec';

export const SIM_PORT: MidiPortLike = { id: 'ce-sim-synth', name: 'CE Sim Synth', manufacturer: 'simulator · OP-1 CC numbers', state: 'connected' };
export const SIM_IDENTITY = [0xf0, 0x7e, 0x7f, 0x06, 0x02, 0x7d, 0x01, 0x00, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0xf7];

const lin = (v: number, a: number, b: number) => a + (b - a) * (v / 127);
const expo = (v: number, a: number, b: number) => a * (b / a) ** (v / 127);

export class SimSynth {
  readonly ctx: AudioContext;
  /** the synth's output: tap this for the audio oracle */
  readonly out: GainNode;
  private readonly filter: BiquadFilterNode;
  private readonly shaper: WaveShaperNode;
  private readonly delay: DelayNode;
  private readonly feedback: GainNode;
  private readonly wet: GainNode;
  private readonly pan: StereoPannerNode;
  private readonly eq: BiquadFilterNode[];
  private detuneCents = 7;
  private readonly voices = new Map<number, { oscs: OscillatorNode[]; env: GainNode }>();
  /** CC values the synth holds (for the on-screen readout) */
  readonly cc = new Map<number, number>();
  onIdentityRequest: (reply: number[]) => void = () => {};

  constructor() {
    this.ctx = new AudioContext();
    const c = this.ctx;
    this.filter = new BiquadFilterNode(c, { type: 'lowpass', frequency: 1200, Q: 1 });
    this.shaper = new WaveShaperNode(c, { curve: SimSynth.curve(0) });
    this.delay = new DelayNode(c, { delayTime: 0.25, maxDelayTime: 1 });
    this.feedback = new GainNode(c, { gain: 0.3 });
    this.wet = new GainNode(c, { gain: 0 });
    this.eq = [new BiquadFilterNode(c, { type: 'lowshelf', frequency: 200 }), new BiquadFilterNode(c, { type: 'peaking', frequency: 1200, Q: 0.8 }), new BiquadFilterNode(c, { type: 'highshelf', frequency: 5000 })];
    this.pan = new StereoPannerNode(c);
    this.out = new GainNode(c, { gain: 0.5 });
    this.filter.connect(this.shaper);
    this.shaper.connect(this.eq[0]);
    this.eq[0].connect(this.eq[1]).connect(this.eq[2]);
    this.eq[2].connect(this.pan);
    this.eq[2].connect(this.delay);
    this.delay.connect(this.feedback).connect(this.delay);
    this.delay.connect(this.wet).connect(this.pan);
    this.pan.connect(this.out);
    this.out.connect(c.destination);
  }

  private static curve(amount: number): Float32Array<ArrayBuffer> {
    const n = 1024;
    const k = amount * 40;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      out[i] = k ? ((1 + k) * x) / (1 + k * Math.abs(x)) : x;
    }
    return out;
  }

  async resume(): Promise<void> {
    await this.ctx.resume();
  }

  private set(p: AudioParam, v: number): void {
    p.setTargetAtTime(v, this.ctx.currentTime, 0.015);
  }

  receive(bytes: readonly number[]): void {
    const [st, d1 = 0, d2 = 0] = bytes;
    if (st === 0xf0) {
      if (bytes[1] === 0x7e && bytes[3] === 0x06 && bytes[4] === 0x01) setTimeout(() => this.onIdentityRequest([...SIM_IDENTITY]), 12);
      return;
    }
    const kind = st & 0xf0;
    if (kind === 0x90 && d2 > 0) this.noteOn(d1, d2);
    else if (kind === 0x80 || (kind === 0x90 && d2 === 0)) this.noteOff(d1);
    else if (kind === 0xb0) this.controlChange(d1, d2);
  }

  private controlChange(cc: number, v: number): void {
    this.cc.set(cc, v);
    switch (cc) {
      case 46:
        this.set(this.filter.frequency, expo(v, 80, 12000));
        break;
      case 47:
        this.set(this.filter.Q, lin(v, 0.5, 18));
        break;
      case 48:
        this.detuneCents = lin(v, 0, 50);
        for (const voice of this.voices.values()) voice.oscs.forEach((o, i) => this.set(o.detune, i ? this.detuneCents : -this.detuneCents));
        break;
      case 49:
        this.shaper.curve = SimSynth.curve(v / 127);
        break;
      case 54:
        this.set(this.delay.delayTime, lin(v, 0.03, 0.8));
        break;
      case 55:
        this.set(this.feedback.gain, lin(v, 0, 0.85));
        break;
      case 57:
        this.set(this.wet.gain, lin(v, 0, 0.9));
        break;
      case 7:
        this.set(this.out.gain, lin(v, 0, 0.8));
        break;
      case 10:
        this.set(this.pan.pan, lin(v, -1, 1));
        break;
      case 90:
      case 91:
      case 92:
        this.set(this.eq[cc - 90].gain, lin(v, -12, 12));
        break;
      case 120:
      case 123:
        for (const n of [...this.voices.keys()]) this.noteOff(n);
        break;
      default:
      // like the real device, unassigned CCs do nothing (the negative control relies on it)
    }
  }

  private noteOn(note: number, vel: number): void {
    this.noteOff(note);
    const f = 440 * 2 ** ((note - 69) / 12);
    const env = new GainNode(this.ctx, { gain: 0 });
    const oscs = (['sawtooth', 'square'] as OscillatorType[]).map((type, i) => {
      const o = new OscillatorNode(this.ctx, { type, frequency: f, detune: i ? this.detuneCents : -this.detuneCents });
      o.connect(env);
      o.start();
      return o;
    });
    env.connect(this.filter);
    const t = this.ctx.currentTime;
    env.gain.setTargetAtTime((vel / 127) * 0.25, t, 0.01);
    this.voices.set(note, { oscs, env });
  }

  private noteOff(note: number): void {
    const v = this.voices.get(note);
    if (!v) return;
    this.voices.delete(note);
    const t = this.ctx.currentTime;
    v.env.gain.setTargetAtTime(0, t, 0.05);
    for (const o of v.oscs) o.stop(t + 0.4);
  }
}

/** Real Web MIDI plus the sim port, as one MidiIO for the executor. */
export class SpikeIO implements MidiIO {
  sim?: SimSynth;
  private readonly listeners = new Set<(m: MidiInEvent) => void>();

  constructor(private readonly real: MidiIO) {
    real.addListener((m) => this.emit(m));
  }

  get enabled(): boolean {
    return this.real.enabled || Boolean(this.sim);
  }

  get sysex(): boolean {
    return this.real.sysex || Boolean(this.sim);
  }

  attachSim(sim: SimSynth): void {
    this.sim = sim;
    sim.onIdentityRequest = (reply) => this.emit({ portId: SIM_PORT.id, portName: SIM_PORT.name!, data: new Uint8Array(reply), time: performance.now() });
  }

  outputs(): MidiPortLike[] {
    return [...this.real.outputs(), ...(this.sim ? [SIM_PORT] : [])];
  }

  inputs(): MidiPortLike[] {
    return [...this.real.inputs(), ...(this.sim ? [SIM_PORT] : [])];
  }

  send(outputId: string, bytes: number[], timestamp?: number): void {
    if (outputId === SIM_PORT.id && this.sim) {
      const wait = timestamp ? Math.max(0, timestamp - performance.now()) : 0;
      if (wait > 1) setTimeout(() => this.sim?.receive(bytes), wait);
      else this.sim.receive(bytes);
      return;
    }
    this.real.send(outputId, bytes, timestamp);
  }

  addListener(fn: (m: MidiInEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(m: MidiInEvent): void {
    for (const fn of this.listeners) fn(m);
  }
}
