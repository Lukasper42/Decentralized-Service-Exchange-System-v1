import type { ClockPort } from './ports.js';

/** Fixed-window counter per key. The window start is derived from the injected clock. Memory is bounded by `maxKeys`. */
export class RateLimiter {
  readonly #hits = new Map<string, { windowStart: number; count: number }>();
  constructor(private readonly limit: number, private readonly windowMs: number, private readonly clock: ClockPort, private readonly maxKeys = 10000) {}

  /** True iff this call is within the limit (and is counted). */
  allow(key: string): boolean {
    const now = this.clock.nowMs();
    const entry = this.#hits.get(key);
    if (entry === undefined || now - entry.windowStart >= this.windowMs) {
      if (this.#hits.size >= this.maxKeys && !this.#hits.has(key)) this.#evict(now);
      this.#hits.set(key, { windowStart: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }
  #evict(now: number): void {
    for (const [key, entry] of this.#hits) if (now - entry.windowStart >= this.windowMs) this.#hits.delete(key);
    if (this.#hits.size >= this.maxKeys) {
      const oldest = this.#hits.keys().next();
      if (oldest.done !== true) this.#hits.delete(oldest.value);
    }
  }
}
