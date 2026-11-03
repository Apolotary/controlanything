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
