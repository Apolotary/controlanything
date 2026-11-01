/** Sliding-window counter per key (an IP address, a device id...). */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private recent(key: string): number[] {
    const t = this.now();
    const list = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** True when `key` has used up its budget for the current window. */
  blocked(key: string): boolean {
    return this.recent(key).length >= this.limit;
  }

  /** Count one hit; returns false (and does not count it) when the key is already over the limit. */
  hit(key: string): boolean {
    const list = this.recent(key);
    if (list.length >= this.limit) return false;
    list.push(this.now());
    this.hits.set(key, list);
    return true;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}
