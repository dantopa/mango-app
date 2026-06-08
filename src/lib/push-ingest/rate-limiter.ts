/**
 * Sliding window in-memory rate limiter.
 *
 * - Configurable via PUSH_INGEST_RATE_LIMIT env var (max requests per 60s window, default 60).
 * - Resets on cold start (acceptable for Vercel serverless — basic protection, not bullet-proof).
 */

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfter: number };

/** Window size in milliseconds (60 seconds) */
const WINDOW_MS = 60_000;

/** Internal state: timestamps of requests per IP. Exported for testing. */
export const requestLog: Map<string, number[]> = new Map();

/** Reset all rate-limiting state (for testing) */
export function resetRateLimit(): void {
  requestLog.clear();
}

/** Get the configured max requests per window */
function getLimit(): number {
  const envVal = process.env.PUSH_INGEST_RATE_LIMIT;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return 60;
}

/**
 * Check whether an IP is allowed to make a request.
 *
 * Sliding window algorithm:
 * 1. Remove timestamps older than the window.
 * 2. If count < limit → allowed, record timestamp.
 * 3. If count >= limit → rejected, compute retryAfter as seconds until oldest entry expires.
 */
export function checkRateLimit(ip: string): RateLimitResult {
  const now = Date.now();
  const limit = getLimit();
  const windowStart = now - WINDOW_MS;

  // Get or create timestamp array for this IP
  let timestamps = requestLog.get(ip);
  if (!timestamps) {
    timestamps = [];
    requestLog.set(ip, timestamps);
  }

  // Remove timestamps older than the window
  const filtered = timestamps.filter((t) => t > windowStart);
  requestLog.set(ip, filtered);

  if (filtered.length < limit) {
    // Allowed: record this request
    filtered.push(now);
    return { allowed: true };
  }

  // Rejected: calculate retryAfter (seconds until oldest entry in window expires)
  const oldestInWindow = filtered[0];
  const expiresAt = oldestInWindow + WINDOW_MS;
  const retryAfterMs = expiresAt - now;
  const retryAfter = Math.ceil(retryAfterMs / 1000);

  return { allowed: false, retryAfter: Math.max(retryAfter, 1) };
}
