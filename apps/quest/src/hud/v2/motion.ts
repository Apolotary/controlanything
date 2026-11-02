/** Solve cubic-bezier(.2,.8,.2,1) without frame-rate-dependent damping. */
export function unfoldEase(progress: number): number {
  const x = Math.min(1, Math.max(0, progress));
  let low = 0, high = 1;
  for (let i = 0; i < 12; i++) {
    const t = (low + high) / 2, u = 1 - t;
    if (0.6 * u * u * t + 0.6 * u * t * t + t * t * t < x) low = t;
    else high = t;
  }
  const t = (low + high) / 2, u = 1 - t;
  return x === 0 || x === 1 ? x : 2.4 * u * u * t + 3 * u * t * t + t * t * t;
}
