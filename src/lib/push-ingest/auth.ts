import { timingSafeEqual } from "crypto";

import { authenticateDevice } from "./devices";

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
  return validateBearer(authHeader, process.env.PUSH_INGEST_SECRET);
}

/**
 * Ingest auth: the shared PUSH_INGEST_SECRET or a paired device token.
 *
 * The secret is tried first because it costs no round trip, and because a device
 * token can only be checked by hashing it and looking the hash up — there is no
 * constant-time path for that, and there is nothing to protect: the digest is not
 * the credential.
 */
export async function validateIngestAuth(authHeader: string | null): Promise<AuthResult> {
  const shared = validateAuth(authHeader);
  if (shared.ok) return shared;

  const token = bearerToken(authHeader);
  if (!token) return UNAUTHORIZED;

  const device = await authenticateDevice(token, new Date());
  return device ? { ok: true } : UNAUTHORIZED;
}

function bearerToken(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length);
  return token.length > 0 ? token : null;
}

/**
 * Same check against an arbitrary secret, for the other endpoints that are
 * protected by a shared token (the cron trigger). An undefined secret rejects
 * everything, so a missing env var fails closed instead of open.
 */
export function validateBearer(authHeader: string | null, secret: string | undefined): AuthResult {
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
