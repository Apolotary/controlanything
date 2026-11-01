/**
 * Synthesized UI sound (no assets), recipes from the creative-director brief. Gain bus 0.25, every cue through
 * a PannerNode at the widget. UI stays ≥ 12 dB under the instrument; synth key presses make no sound.
 */
import type { Vector3 } from 'three';

export type Cue = 'tick' | 'click' | 'lock' | 'step' | 'ok' | 'fail' | 'blip' | 'daemon' | 'sweep' | 'voiceOn' | 'voiceOff' | 'pluck' | 'knock' | 'chirp';

/**
 * Global mute (user directive, Nov 2: no Web Audio playback on this Mac until lifted). While true, no
 * AudioContext is created and play() is a no-op. Flip with `UiAudio.muted = false` or `?audio=1`.
 */
let MUTED = true;
try {
  if (typeof location !== 'undefined') {
    const q = new URLSearchParams(location.search);
    if (q.get('audio') === '1') MUTED = false;
    if (q.get('mute') === '1') MUTED = true;
  }
} catch {
  /* non-browser */
}
/** `window.__ceMute = true` (set by the shell or a test) always wins over the URL. */
function muted(): boolean {
  const w = globalThis as { __ceMute?: boolean };
  return w.__ceMute === true || MUTED;
}

export class UiAudio {
  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null;
  private blipIndex = 0;
  enabled = true;

  static get muted(): boolean {
    return muted();
  }
  static set muted(v: boolean) {
    MUTED = v;
  }

  /** Call from a user gesture (first pinch / click) so the context may start. No-op while muted. */
  unlock(): void {
    if (muted()) return;
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      this.ctx = new AudioContext();
      this.bus = this.ctx.createGain();
      this.bus.gain.value = 0.25;
      this.bus.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
    }
  }

  setListener(position: Vector3, forward: Vector3, up: Vector3): void {
    const l = this.ctx?.listener;
    if (!l) return;
    if ('positionX' in l) {
      l.positionX.value = position.x;
      l.positionY.value = position.y;
      l.positionZ.value = position.z;
      l.forwardX.value = forward.x;
      l.forwardY.value = forward.y;
      l.forwardZ.value = forward.z;
      l.upX.value = up.x;
      l.upY.value = up.y;
      l.upZ.value = up.z;
    }
  }

  play(cue: Cue, at?: Vector3): void {
    if (muted() || !this.enabled || !this.ctx || !this.bus) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    let dest: AudioNode = this.bus;
    if (at) {
      const p = ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = 0.5;
      p.positionX.value = at.x;
      p.positionY.value = at.y;
      p.positionZ.value = at.z;
      p.connect(this.bus);
      dest = p;
    }
    const tone = (type: OscillatorType, freq: number, start: number, dur: number, gain = 0.6, attack = 0.004, decayTo = 0.001) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0 + start);
      g.gain.exponentialRampToValueAtTime(gain, t0 + start + attack);
      g.gain.exponentialRampToValueAtTime(decayTo, t0 + start + dur);
      o.connect(g).connect(dest);
      o.start(t0 + start);
      o.stop(t0 + start + dur + 0.02);
    };
    switch (cue) {
      case 'tick':
        tone('sine', 1800, 0, 0.03, 0.5);
        break;
      case 'click':
        tone('square', 900, 0, 0.025, 0.25);
        break;
      case 'lock':
        tone('square', 660, 0, 0.06, 0.3);
        tone('square', 990, 0.06, 0.08, 0.3);
        break;
      case 'step':
        tone('triangle', 1200, 0, 0.04, 0.4);
        break;
      case 'ok':
        tone('sine', 880, 0, 0.14, 0.5);
        tone('sine', 1108.7, 0.02, 0.16, 0.5);
        break;
      case 'pluck':
        tone('sine', 1320, 0, 0.18, 0.4, 0.002);
        break;
      case 'fail':
      case 'knock': {
        // FM thud: carrier 110 Hz, modulator 220 Hz, 180 Hz depth, 200 ms
        const c = ctx.createOscillator();
        const m = ctx.createOscillator();
        const mg = ctx.createGain();
        const g = ctx.createGain();
        c.frequency.value = 110;
        m.frequency.value = 220;
        mg.gain.value = 180;
        m.connect(mg).connect(c.frequency);
        g.gain.setValueAtTime(0.7, t0);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.2);
        c.connect(g).connect(dest);
        c.start(t0);
        m.start(t0);
        c.stop(t0 + 0.22);
        m.stop(t0 + 0.22);
        break;
      }
      case 'blip': {
        const seq = [392, 440, 523.25, 587.33, 659.25];
        tone('square', seq[this.blipIndex % seq.length]!, 0, 0.04, 0.25);
        this.blipIndex++;
        break;
      }
      case 'chirp':
        tone('square', 523.25, 0, 0.03, 0.2);
        tone('square', 783.99, 0.03, 0.04, 0.2);
        break;
      case 'daemon':
        tone('sine', 60, 0, 0.25, 0.5, 0.01);
        break;
      case 'voiceOn':
        tone('sine', 523, 0, 0.08, 0.4);
        tone('sine', 659, 0.08, 0.1, 0.4);
        break;
      case 'voiceOff':
        tone('sine', 659, 0, 0.08, 0.4);
        tone('sine', 523, 0.08, 0.1, 0.4);
        break;
      case 'sweep': {
        // 1.2 s white noise through a bandpass Q 8 ramped 400 Hz -> 4 kHz, gain 0.12
        const len = Math.floor(ctx.sampleRate * 1.2);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.value = 8;
        bp.frequency.setValueAtTime(400, t0);
        bp.frequency.exponentialRampToValueAtTime(4000, t0 + 1.2);
        const g = ctx.createGain();
        g.gain.value = 0.12;
        src.connect(bp).connect(g).connect(dest);
        src.start(t0);
        break;
      }
    }
  }
}
