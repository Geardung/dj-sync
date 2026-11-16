/** Sliding-window rate limiter keyed by an arbitrary string (guestId or IP). */
export class SlidingWindow {
  private hits = new Map<string, number[]>();

  constructor(
    private limit: number,
    private windowMs: number
  ) {}

  /** Record an attempt; false when the key is over budget. */
  attempt(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const times = (this.hits.get(key) || []).filter((t) => t > cutoff);
    if (times.length >= this.limit) {
      this.hits.set(key, times);
      return false;
    }
    times.push(now);
    this.hits.set(key, times);
    return true;
  }

  /** Seconds until the key gets a free slot again (0 = allowed now). */
  retryAfterSec(key: string): number {
    const times = this.hits.get(key);
    if (!times || times.length < this.limit) return 0;
    const oldest = times[0]!;
    return Math.max(1, Math.ceil((oldest + this.windowMs - Date.now()) / 1000));
  }

  /** Drop keys with no recent activity — keeps the map small. */
  prune(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, times] of this.hits) {
      const alive = times.filter((t) => t > cutoff);
      if (alive.length === 0) this.hits.delete(key);
      else this.hits.set(key, alive);
    }
  }
}
