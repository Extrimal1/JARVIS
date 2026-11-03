/**
 * Tiny in-memory sliding-window rate limiter for auth-adjacent
 * routes. Pure and time-injectable so tests drive it without
 * timers; the route owns one module-level store.
 *
 * This blunts online brute force against the password endpoint.
 * It is per-instance (serverless instances do not share it), so
 * Supabase's own auth rate limiting remains the outer backstop.
 */

export type RateLimitStore = Map<string, number[]>;

export type RateLimitOptions = {
  /** Max attempts per window. */
  maxAttempts: number;
  /** Window length in milliseconds. */
  windowMs: number;
};

export const LOGIN_RATE_LIMIT: RateLimitOptions = {
  maxAttempts: 10,
  windowMs: 10 * 60 * 1000,
};

/**
 * Record an attempt for `key` at `nowMs`. Returns true when the
 * attempt is allowed, false when the key already exhausted its
 * window (the attempt is still recorded, so sustained hammering
 * keeps pushing the window forward).
 */
export function checkRateLimit(
  store: RateLimitStore,
  key: string,
  options: RateLimitOptions,
  nowMs: number,
): boolean {
  const windowStart = nowMs - options.windowMs;
  const prior = store.get(key) ?? [];
  const recent = prior.filter((stamp) => stamp > windowStart);

  recent.push(nowMs);
  store.set(key, recent);

  if (store.size > 5000) {
    const oldest = store.keys().next().value;

    if (oldest !== undefined) store.delete(oldest);
  }

  return recent.length <= options.maxAttempts;
}

/** Test seam: forget all recorded attempts. */
export function clearRateLimit(store: RateLimitStore): void {
  store.clear();
}
