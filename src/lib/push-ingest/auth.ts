import { timingSafeEqual } from "crypto";

export type AuthResult =
  | { ok: true }
  | { ok: false; status: 401; body: { error: "unauthorized" } };

const UNAUTHORIZED: AuthResult = {
  ok: false,
  status: 401,
  body: { error: "unauthorized" },
};

/**
 * Validates the Authorization header against PUSH_INGEST_SECRET.
 * Uses constant-time comparison to prevent timing attacks.
 *
 * Returns { ok: true } only when:
 * - PUSH_INGEST_SECRET is configured
 * - authHeader is present
 * - authHeader starts with "Bearer "
 * - The token matches PUSH_INGEST_SECRET exactly
 */
export function validateAuth(authHeader: string | null): AuthResult {
  const secret = process.env.PUSH_INGEST_SECRET;

  // If secret is not configured, reject all requests
  if (!secret) {
    return UNAUTHORIZED;
  }

  // Missing header
  if (!authHeader) {
    return UNAUTHORIZED;
  }

  // Must start with "Bearer "
  if (!authHeader.startsWith("Bearer ")) {
    return UNAUTHORIZED;
  }

  const token = authHeader.slice("Bearer ".length);

  // Constant-time comparison to prevent timing attacks
  if (!safeEqual(token, secret)) {
    return UNAUTHORIZED;
  }

  return { ok: true };
}

/**
 * Constant-time string comparison using crypto.timingSafeEqual.
 * Handles strings of different lengths safely (still constant-time
 * relative to the secret length).
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");

  // If lengths differ, we still do a comparison to avoid
  // leaking length information through timing
  if (bufA.length !== bufB.length) {
    // Compare bufB against itself to burn the same time,
    // then return false
    timingSafeEqual(bufB, bufB);
    return false;
  }

  return timingSafeEqual(bufA, bufB);
}
