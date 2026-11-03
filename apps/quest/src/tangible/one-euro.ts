/**
 * One Euro filter (Casiez, Roussel, Vogel, CHI 2012): a low-pass whose cutoff rises with speed, so a still
 * object is rock steady and a moving one has little lag. Allocation-free; times are milliseconds.
 */
import type { Vector3 } from 'three';

const alphaFor = (cutoffHz: number, dtS: number) => {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtS);
};

export class OneEuro {
  private x = 0;
  private dx = 0;
  private t = -1;
  constructor(public minCutoff = 1, public beta = 0.02, public dCutoff = 1) {}

  get value(): number { return this.x; }
  /** Units per second, filtered. */
  get velocity(): number { return this.dx; }
  get primed(): boolean { return this.t >= 0; }

  reset(x?: number, tMs = -1): void {
    this.t = x === undefined ? -1 : tMs;
    this.x = x ?? 0;
    this.dx = 0;
  }

  filter(x: number, tMs: number): number {
    if (this.t < 0) { this.t = tMs; this.x = x; this.dx = 0; return x; }
    const dt = Math.max(1e-3, (tMs - this.t) / 1000);
    this.t = tMs;
    const ad = alphaFor(this.dCutoff, dt);
    this.dx += ad * ((x - this.x) / dt - this.dx);
    const a = alphaFor(this.minCutoff + this.beta * Math.abs(this.dx), dt);
    this.x += a * (x - this.x);
    return this.x;
  }
}

/** Three One Euro channels for a world position. */
export class OneEuro3 {
  readonly x: OneEuro;
  readonly y: OneEuro;
  readonly z: OneEuro;
  constructor(minCutoff = 1, beta = 0.02, dCutoff = 1) {
    this.x = new OneEuro(minCutoff, beta, dCutoff);
    this.y = new OneEuro(minCutoff, beta, dCutoff);
    this.z = new OneEuro(minCutoff, beta, dCutoff);
  }
  get primed(): boolean { return this.x.primed; }
  reset(p?: Vector3, tMs = -1): void {
    this.x.reset(p?.x, tMs); this.y.reset(p?.y, tMs); this.z.reset(p?.z, tMs);
  }
  /** Filters `p` in place and returns it. */
  filter(p: Vector3, tMs: number): Vector3 {
    p.set(this.x.filter(p.x, tMs), this.y.filter(p.y, tMs), this.z.filter(p.z, tMs));
    return p;
  }
  velocity(out: Vector3): Vector3 { return out.set(this.x.velocity, this.y.velocity, this.z.velocity); }
}
