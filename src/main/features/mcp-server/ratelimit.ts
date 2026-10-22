/** Sliding-window rate limiter keyed by client (pure). */
export interface RateLimiter {
  /** Records a hit and returns true when `key` is still under `limit` hits per `windowMs`. */
  take(key: string, limit: number, windowMs?: number): boolean;
  reset(): void;
}

export function createRateLimiter(now: () => number = Date.now): RateLimiter {
  const hits = new Map<string, number[]>();
  return {
    take(key, limit, windowMs = 60_000) {
      const t = now();
      const list = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
      if (list.length >= limit) {
        hits.set(key, list);
        return false;
      }
      list.push(t);
      hits.set(key, list);
      return true;
    },
    reset: () => hits.clear(),
  };
}
