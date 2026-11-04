import { touchPhase } from './state.js';
import type { TouchPhase } from './state.js';

/** Fixed-budget analytic wave impulses. No allocation or physics worker in the frame loop. */
export const WATER_RIPPLE_CAPACITY = 6;
export class WaterRipples {
  /** x/y origin, start seconds, signed strength; passed directly to a WebGL uniform array. */
  readonly data = new Float32Array(WATER_RIPPLE_CAPACITY * 4);
  private cursor = 0;
  private latest = -1;
  reset(): void { this.data.fill(0); this.cursor = 0; this.latest = -1; }
  push(previous: number, next: number, seconds: number): void {
    if (![previous, next, seconds].every(Number.isFinite)) return;
    const delta = Math.max(-1, Math.min(1, next - previous));
    if (Math.abs(delta) < 1 / 254) return;
    const strength = Math.max(-.18, Math.min(.18, delta * 1.1));
    // Coalesce high-rate samples into a bounded ten-Hz wavefront without losing direction.
    const recent = this.latest >= 0 && seconds - this.data[this.latest + 2]! >= -1e-5 && seconds - this.data[this.latest + 2]! < .10;
    const index = recent ? this.latest : this.cursor * 4;
    if (recent) this.data[index + 3] = Math.max(-.22, Math.min(.22, this.data[index + 3]! + strength));
    else {
      this.data[index] = (next - .5) * .38; this.data[index + 1] = 0;
      this.data[index + 2] = seconds; this.data[index + 3] = strength;
      this.latest = index; this.cursor = (this.cursor + 1) % WATER_RIPPLE_CAPACITY;
    }
  }
}

/**
 * Touch the water: the wearer's fingertip (CC22 X, CC23 Y, CC24 pressure) as water waves. A fixed ring buffer of
 * wave segments for the shader (one allocation, no per-frame garbage): a tap splashes (and echoes once), a drag
 * leaves a wake of segments spawned at ~20 Hz along the finger's smoothed path, a lift sends one soft ring, and a
 * hovering finger shows a lens + glow. Positions are canvas fractions (u left→right, v top→bottom) so a resize
 * or any aspect keeps them where the finger is; the shader maps them with the live aspect.
 */
export const TOUCH_WAVE_CAPACITY = 24;
/** Slots 0..5 hold splashes, echoes and lift rings (they live seconds); 6..23 hold the wake (it lives ~1 s). */
const SPLASH_SLOTS = 6;
/** The wake is sampled at 20 Hz. */
export const TOUCH_WAKE_INTERVAL = 0.05;
/** The finger must have moved this far (screen-height units: the shader's p space is 2 across the canvas height). */
const MOVE_EPSILON = 0.012;
/** A fast finger adds a wake segment every this much path, and no segment is longer. */
const WAKE_SPACING = 0.45;
/** A hover/touch that stops getting updates (the wiring died, the headset dropped) fades after this long. */
export const TOUCH_STALE_SECONDS = 8;
/** Splash bigness for the shader: 0 = wake, 1 = full splash. */
const BIG = { wake: 0, release: .35, echo: .8, splash: 1 } as const;

export interface TouchSample { x: number; y: number; pressure: number }
export interface TouchWaveInfo { x: number; y: number; x2: number; y2: number; age: number; strength: number; big: number }

/** Splash strength by pressure: CC 21 is a gentle plop, CC 127 a hard slap. */
export const touchSplashStrength = (pressure: number): number => {
  const cc = Math.round(pressure * 127);
  return .55 + .6 * Math.max(0, Math.min(1, (cc - 20) / 107));
};

export class TouchWater {
  /** a.u a.v b.u b.v per slot */
  readonly segments = new Float32Array(TOUCH_WAVE_CAPACITY * 4);
  /** start seconds, signed strength, bigness, spare per slot (a future start is allowed: the echo) */
  readonly waves = new Float32Array(TOUCH_WAVE_CAPACITY * 4);
  /** fingertip u, v, hover glow 0..1, contact 0..1: a uniform */
  readonly finger = new Float32Array([.5, .5, 0, 0]);
  /** 0..1, how present the fingertip is: it quiets the steady centre rings while the wearer plays */
  activity = 0;
  phase: TouchPhase = 'lifted';
  private target: TouchSample = { x: .5, y: .5, pressure: 0 };
  private smoothX = .5; private smoothY = .5;
  private splashCursor = 0; private wakeCursor = 0;
  private pendingSplash = 0; private pendingRelease = false;
  /** the newest splash slot, and until when a late X/Y may still move it (touch-down before the position arrived) */
  private lastSplashSlot = -1; private reseatUntil = -1; private reseatsLeft = 0;
  private lastWakeAt = 0; private lastWakeX = .5; private lastWakeY = .5;
  private lastMessageAt = -Infinity;
  private now = 0;

  reset(): void {
    this.segments.fill(0); this.waves.fill(0); this.finger.set([.5, .5, 0, 0]);
    this.activity = 0; this.phase = 'lifted'; this.target = { x: .5, y: .5, pressure: 0 };
    this.smoothX = this.smoothY = .5; this.splashCursor = this.wakeCursor = 0;
    this.pendingSplash = 0; this.pendingRelease = false; this.lastSplashSlot = -1; this.reseatUntil = -1;
    this.lastMessageAt = -Infinity;
  }

  /** A snapshot from another tab or a resume: take the finger as it is without making a splash out of it. */
  adopt(sample: TouchSample, seconds: number): void {
    this.segments.fill(0); this.waves.fill(0);
    this.target = { ...sample }; this.smoothX = sample.x; this.smoothY = sample.y; this.phase = touchPhase(sample.pressure);
    this.pendingSplash = 0; this.pendingRelease = false; this.lastSplashSlot = -1; this.reseatUntil = -1;
    this.lastMessageAt = this.phase === 'lifted' ? -Infinity : seconds;
    this.lastWakeX = sample.x; this.lastWakeY = sample.y; this.lastWakeAt = seconds;
  }

  /** A live CC22/23/24 change. Cheap and immediate: nothing here waits on smoothing or the 20 Hz wake clock. */
  receive(sample: TouchSample, seconds: number): void {
    if (![sample.x, sample.y, sample.pressure, seconds].every(Number.isFinite)) return;
    const was = this.phase, now = touchPhase(sample.pressure);
    const moved = sample.x !== this.target.x || sample.y !== this.target.y;
    this.target = { ...sample }; this.phase = now; this.lastMessageAt = seconds;
    if (now === 'touching' && was !== 'touching') {
      this.pendingSplash = touchSplashStrength(sample.pressure);
      this.smoothX = this.lastWakeX = sample.x; this.smoothY = this.lastWakeY = sample.y; this.lastWakeAt = seconds;
    } else if (was === 'touching' && now !== 'touching') this.pendingRelease = true;
    else if (moved && now === 'touching' && seconds < this.reseatUntil && this.reseatsLeft > 0 && this.lastSplashSlot >= 0) {
      this.reseatsLeft--;
      // The pressure arrived a few ms before its X/Y: move the young splash under the finger instead of leaving it behind.
      this.place(this.lastSplashSlot, sample.x, sample.y, sample.x, sample.y);
      this.place((this.lastSplashSlot + 1) % SPLASH_SLOTS, sample.x, sample.y, sample.x, sample.y);
      this.smoothX = this.lastWakeX = sample.x; this.smoothY = this.lastWakeY = sample.y;
    }
  }

  /** Per rendered frame: place the pending splash, spawn the wake, ease the lens. `aspect` = canvas width / height. */
  frame(seconds: number, dt: number, aspect: number): void {
    this.now = seconds;
    const { x, y, pressure } = this.target;
    const stale = seconds - this.lastMessageAt > TOUCH_STALE_SECONDS;
    if (this.pendingSplash) {
      const strength = this.pendingSplash; this.pendingSplash = 0;
      this.smoothX = x; this.smoothY = y;
      const slot = this.splashCursor; this.splashCursor = (this.splashCursor + 2) % SPLASH_SLOTS;
      this.write(slot, x, y, x, y, seconds, strength, BIG.splash);
      this.write((slot + 1) % SPLASH_SLOTS, x, y, x, y, seconds + .16, strength * .5, BIG.echo);
      this.lastSplashSlot = slot; this.reseatUntil = seconds + .12; this.reseatsLeft = 2;
      this.lastWakeX = x; this.lastWakeY = y; this.lastWakeAt = seconds;
    }
    if (this.pendingRelease) {
      this.pendingRelease = false;
      this.write(this.splashCursor, this.smoothX, this.smoothY, this.smoothX, this.smoothY, seconds, -.4, BIG.release);
      this.splashCursor = (this.splashCursor + 1) % SPLASH_SLOTS;
    }
    // The fingertip follows the CC position with ~30 ms of ease so 7-bit steps do not jitter the wake or the lens.
    const follow = 1 - Math.exp(-dt / (this.phase === 'touching' ? .03 : .05));
    this.smoothX += (x - this.smoothX) * follow; this.smoothY += (y - this.smoothY) * follow;
    if (this.phase === 'touching' && !stale) {
      // The wake: a short wave segment every 50 ms of motion, or every WAKE_SPACING of path when the finger is fast
      // (a long swipe becomes a chain of short segments, never one flat-sided wave).
      let distance = Math.hypot((this.smoothX - this.lastWakeX) * 2 * aspect, (this.smoothY - this.lastWakeY) * 2);
      const speed = distance / Math.min(Math.max(seconds - this.lastWakeAt, TOUCH_WAKE_INTERVAL), .12);
      const strength = Math.min(.5, .18 + .1 * speed) * (.8 + .2 * Math.min(1, (Math.round(pressure * 127) - 20) / 80));
      const fromX = this.lastWakeX, fromY = this.lastWakeY, toX = this.smoothX, toY = this.smoothY, whole = distance;
      for (let budget = 3; budget > 0 && distance > MOVE_EPSILON && (distance >= WAKE_SPACING || seconds - this.lastWakeAt >= TOUCH_WAKE_INTERVAL); budget--) {
        const step = Math.min(distance, WAKE_SPACING), done = (whole - distance + step) / whole;
        const nextX = fromX + (toX - fromX) * done, nextY = fromY + (toY - fromY) * done;
        const slot = SPLASH_SLOTS + this.wakeCursor; this.wakeCursor = (this.wakeCursor + 1) % (TOUCH_WAVE_CAPACITY - SPLASH_SLOTS);
        this.write(slot, this.lastWakeX, this.lastWakeY, nextX, nextY, seconds, strength, BIG.wake);
        this.lastWakeX = nextX; this.lastWakeY = nextY; this.lastWakeAt = seconds; distance -= step;
      }
    }
    const cc = Math.round(pressure * 127);
    const hoverTarget = stale ? 0 : this.phase === 'touching' ? 1 : this.phase === 'hover' ? Math.max(.08, cc / 20) : 0;
    const contactTarget = stale || this.phase !== 'touching' ? 0 : 1;
    const glow = this.finger[2]!, contact = this.finger[3]!;
    this.finger[0] = this.smoothX; this.finger[1] = this.smoothY;
    this.finger[2] = glow + (hoverTarget - glow) * (1 - Math.exp(-dt / (hoverTarget > glow ? .07 : .22)));
    this.finger[3] = contact + (contactTarget - contact) * (1 - Math.exp(-dt / (contactTarget > contact ? .04 : .2)));
    const presence = Math.max(this.finger[2]!, this.finger[3]!);
    this.activity += (presence - this.activity) * (1 - Math.exp(-dt / (presence > this.activity ? .15 : .9)));
  }

  /** Read-only evidence for tests and screenshots. */
  diagnostics(): { phase: TouchPhase; x: number; y: number; pressure: number; glow: number; contact: number; waves: TouchWaveInfo[] } {
    const waves: TouchWaveInfo[] = [];
    for (let slot = 0; slot < TOUCH_WAVE_CAPACITY; slot++) {
      const offset = slot * 4, strength = this.waves[offset + 1]!, age = this.now - this.waves[offset]!;
      // (float32 start times: a wave born this very frame can read a hair in the future)
      if (strength === 0 || age < -1e-4 || age > 6) continue;
      waves.push({ x: this.segments[offset]!, y: this.segments[offset + 1]!, x2: this.segments[offset + 2]!, y2: this.segments[offset + 3]!, age: Math.max(0, age), strength, big: this.waves[offset + 2]! });
    }
    return { phase: this.phase, x: this.target.x, y: this.target.y, pressure: this.target.pressure, glow: this.finger[2]!, contact: this.finger[3]!, waves };
  }

  private place(slot: number, u: number, v: number, u2: number, v2: number): void {
    const offset = slot * 4;
    this.segments[offset] = u; this.segments[offset + 1] = v; this.segments[offset + 2] = u2; this.segments[offset + 3] = v2;
  }
  private write(slot: number, u: number, v: number, u2: number, v2: number, start: number, strength: number, big: number): void {
    this.place(slot, u, v, u2, v2);
    const offset = slot * 4;
    this.waves[offset] = start; this.waves[offset + 1] = strength; this.waves[offset + 2] = big; this.waves[offset + 3] = 0;
  }
}
