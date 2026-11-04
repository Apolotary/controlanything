/**
 * The page's own hand feedback sound (browser Web Audio, procedural, no samples, no models): a soft airy shimmer
 * that follows how fast your hands move, panned to where they are, a low "catch" when a hand closes and a bright
 * flick when it opens. It goes through the shared master volume. Instruments make their own sound only once
 * Muse wires them.
 */
import { demoAudioMaster } from '@ce/protocol';
import type { TrackedHand } from './tracker';

export class HandSound {
  private ctx?: AudioContext;
  private master?: GainNode;
  private voices: { gain: GainNode; filter: BiquadFilterNode; pan: StereoPannerNode }[] = [];
  private volume = 0;
  private closed = { left: false, right: false };
  private present = { left: false, right: false };
  enabled = true;
  /** quieter while an instrument plays */
  duck = 1;
  readonly stats = { unlocked: false, events: 0 };

  constructor(private readonly quiet: boolean) {
    demoAudioMaster.registerOutput(v => { this.volume = v; this.applyVolume(); });
    demoAudioMaster.onUnlock(() => this.unlock());
  }

  private applyVolume(): void {
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(this.quiet || !this.enabled ? 0 : this.volume * 0.5, this.ctx.currentTime, 0.05);
  }

  unlock(): void {
    if (this.quiet) return;
    try {
      if (!this.ctx) {
        const ctx = this.ctx = new AudioContext({ latencyHint: 'interactive' });
        this.master = ctx.createGain(); this.master.gain.value = 0; this.master.connect(ctx.destination);
        const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
        const d = noise.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        for (let k = 0; k < 2; k++) {
          const src = ctx.createBufferSource(); src.buffer = noise; src.loop = true;
          const filter = ctx.createBiquadFilter(); filter.type = 'bandpass'; filter.Q.value = 7; filter.frequency.value = 900;
          const gain = ctx.createGain(); gain.gain.value = 0;
          const pan = ctx.createStereoPanner();
          src.connect(filter).connect(gain).connect(pan).connect(this.master);
          src.start();
          this.voices.push({ gain, filter, pan });
        }
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
      this.stats.unlocked = this.ctx.state === 'running';
      this.applyVolume();
    } catch { /* audio unavailable: visuals continue */ }
  }

  setEnabled(on: boolean): void { this.enabled = on; this.applyVolume(); }

  update(hands: TrackedHand[]): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    (['left', 'right'] as const).forEach((side, k) => {
      const h = hands.find(x => x.side === side);
      const v = this.voices[k]!;
      const speed = h ? Math.min(1, h.speed / 2.2) : 0;
      v.gain.gain.setTargetAtTime(h ? (0.015 + speed * 0.22) * this.duck : 0, now, 0.08);
      if (h) {
        v.filter.frequency.setTargetAtTime(380 + (1 - h.y) * 2400 + speed * 900, now, 0.06);
        v.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, (h.x - 0.5) * 1.6)), now, 0.06);
        if (!this.present[side]) this.chime(side === 'left' ? 660 : 880, 0.05, 0.25);
        if (h.fist && !this.closed[side]) this.thump(side === 'left' ? 110 : 147);
        else if (!h.fist && this.closed[side]) this.chime(side === 'left' ? 990 : 1320, 0.07, 0.35);
      }
      this.present[side] = !!h; this.closed[side] = !!h?.fist;
    });
  }

  private chime(hz: number, amount: number, length: number): void {
    const ctx = this.ctx, master = this.master;
    if (!ctx || !master) return;
    this.stats.events++;
    const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime;
    o.type = 'sine'; o.frequency.setValueAtTime(hz, t); o.frequency.exponentialRampToValueAtTime(hz * 1.5, t + length);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(amount * this.duck + 0.0001, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + length);
    o.connect(g).connect(master); o.start(t); o.stop(t + length + 0.05);
    o.onended = () => { o.disconnect(); g.disconnect(); };
  }

  private thump(hz: number): void {
    const ctx = this.ctx, master = this.master;
    if (!ctx || !master) return;
    this.stats.events++;
    const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime;
    o.type = 'triangle'; o.frequency.setValueAtTime(hz * 2, t); o.frequency.exponentialRampToValueAtTime(hz, t + 0.12);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12 * this.duck + 0.0001, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.connect(g).connect(master); o.start(t); o.stop(t + 0.25);
    o.onended = () => { o.disconnect(); g.disconnect(); };
  }
}
