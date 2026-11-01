/**
 * The virtual ceiling light: a Koizumi-like dimming + colour-tuning LED ceiling light.
 *
 *   power off / on / night (常夜灯) · 10 brightness steps · 5 colour steps 2700-6500 K (equal mired) · CH1/CH2 ·
 *   ~1.5 s fades (Japanese LED ceiling lights fade; nothing ever flashes: changes are low-passed, < 1 Hz).
 *
 * Pure logic (no DOM), so the state machine and the fade are unit-tested.
 */
import type { Channel, LampCmd } from '../ir/table';
import { cctToRgb, NIGHT_RGB, type Rgb } from './cct';

export type Power = 'off' | 'on' | 'night';

export interface LampState {
  power: Power;
  /** 1..10 */
  level: number;
  cctK: number;
  /** which remote channel the fixture listens to */
  channel: Channel;
}

export const MIN_K = 2700;
export const MAX_K = 6500;
/** colour steps, equally spaced in mired (perceptually even): 370, 316, 262, 208, 154 mired */
export const CCT_LEVELS = [2700, 3200, 3800, 4800, 6500] as const;
export const STEPS = 10;
/** the night LED lights the whole shade a little (amber), plus a bright core at the centre */
export const NIGHT_SHADE_GLOW = 0.03;
/**
 * Light output per step (fraction of full), equal ratios like a perceptual LED dimmer: each press is x1.4
 * (about half a stop), so every step is visible to a fixed-exposure camera, from 4.8 % up to 100 %.
 */
export const LEVELS = [0.048, 0.067, 0.094, 0.13, 0.18, 0.26, 0.36, 0.51, 0.71, 1.0] as const;

export const DEFAULT_STATE: LampState = { power: 'off', level: 10, cctK: 4800, channel: 1 };

function cctIndex(k: number): number {
  let best = 0;
  for (let i = 1; i < CCT_LEVELS.length; i++) if (Math.abs(CCT_LEVELS[i]! - k) < Math.abs(CCT_LEVELS[best]! - k)) best = i;
  return best;
}

/** What one remote button does. Brightness and colour keys only act while the light is on. */
export function applyCmd(s: LampState, cmd: LampCmd): LampState {
  switch (cmd) {
    case 'fullOn':
      return { ...s, power: 'on', level: STEPS };
    case 'on':
      return { ...s, power: 'on' };
    case 'off':
      return { ...s, power: 'off' };
    case 'night':
      return { ...s, power: 'night' };
    case 'brighter':
      return s.power === 'on' ? { ...s, level: Math.min(STEPS, s.level + 1) } : s;
    case 'dimmer':
      return s.power === 'on' ? { ...s, level: Math.max(1, s.level - 1) } : s;
    case 'warmer':
      return s.power === 'on' ? { ...s, cctK: CCT_LEVELS[Math.max(0, cctIndex(s.cctK) - 1)]! } : s;
    case 'cooler':
      return s.power === 'on' ? { ...s, cctK: CCT_LEVELS[Math.min(CCT_LEVELS.length - 1, cctIndex(s.cctK) + 1)]! } : s;
  }
}

/** Linear-light multipliers the compositor uses. */
export interface LampDisplay {
  /** main LED output, 0..1 (fraction of full) */
  main: number;
  /** night LED output, 0..1 */
  night: number;
  /** main LED colour (white-balanced at 5000 K, luminance 1) */
  rgb: Rgb;
}

export function targetDisplay(s: LampState): LampDisplay {
  if (s.power === 'night') return { main: NIGHT_SHADE_GLOW, night: 1, rgb: NIGHT_RGB };
  return {
    main: s.power === 'on' ? LEVELS[Math.max(1, Math.min(STEPS, s.level)) - 1]! : 0,
    night: 0,
    rgb: cctToRgb(s.cctK),
  };
}

export function sameDisplay(a: LampDisplay, b: LampDisplay, eps = 1e-3): boolean {
  return Math.abs(a.main - b.main) < eps && Math.abs(a.night - b.night) < eps && a.rgb.every((v, i) => Math.abs(v - b.rgb[i]!) < eps);
}

/**
 * Exponential fade toward the target (time constants in ms): tau 450 ms reaches 95 % in ~1.35 s, like the real
 * fixture; colour moves a little slower. The displayed light is a pure function of time (no per-frame stepping),
 * so camera frames are right even when the page is in a background tab, and a "before" frame can be developed
 * for any instant of the last 10 s (sense.request offsetMs < 0).
 */
export class LampAnimator {
  private segs: { t0: number; from: LampDisplay; to: LampDisplay }[];
  private lastRendered?: LampDisplay;

  constructor(
    state: LampState,
    readonly tauMs = 450,
    readonly colorTauMs = 600,
    now = Date.now(),
  ) {
    const d = targetDisplay(state);
    this.segs = [{ t0: now, from: d, to: d }];
  }

  setTarget(state: LampState, opts: { instant?: boolean; now?: number } = {}): void {
    const now = opts.now ?? Date.now();
    const to = targetDisplay(state);
    const from = opts.instant ? to : this.at(now);
    this.segs.push({ t0: now, from, to });
    while (this.segs.length > 2 && now - this.segs[1]!.t0 > 10_000) this.segs.shift();
  }

  /** The light at instant t (epoch ms). */
  at(t: number): LampDisplay {
    let seg = this.segs[0]!;
    for (let i = this.segs.length - 1; i >= 0; i--) {
      if (this.segs[i]!.t0 <= t) {
        seg = this.segs[i]!;
        break;
      }
    }
    const dt = Math.max(0, t - seg.t0);
    const k = 1 - Math.exp(-dt / this.tauMs);
    const kc = 1 - Math.exp(-dt / this.colorTauMs);
    const { from: a, to: b } = seg;
    const d: LampDisplay = {
      main: a.main + (b.main - a.main) * k,
      night: a.night + (b.night - a.night) * k,
      rgb: [a.rgb[0] + (b.rgb[0] - a.rgb[0]) * kc, a.rgb[1] + (b.rgb[1] - a.rgb[1]) * kc, a.rgb[2] + (b.rgb[2] - a.rgb[2]) * kc],
    };
    return sameDisplay(d, b, 2e-4) ? b : d;
  }

  get display(): LampDisplay {
    return this.at(Date.now());
  }

  get settled(): boolean {
    const seg = this.segs.at(-1)!;
    return sameDisplay(this.at(Date.now()), seg.to, 2e-4);
  }

  /** For render loops: true when the light differs from what was last rendered. */
  step(_dtMs = 0, now = Date.now()): boolean {
    const d = this.at(now);
    if (this.lastRendered && sameDisplay(this.lastRendered, d, 1e-4)) return false;
    this.lastRendered = d;
    return true;
  }
}

export { NIGHT_RGB };
