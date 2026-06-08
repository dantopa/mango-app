// =============================================================================
// browser-token-mcp — Security utilities
// =============================================================================
// Constant-time comparison, token redaction, and error sanitization.
// Requirements: 2.5 (timing-safe compare), 10.3/10.6 (redaction), 9.3 (sanitize)
// =============================================================================

/**
 * Constant-time string comparison to prevent timing attacks.
 * Always compares all bytes regardless of mismatch position.
 * Requirement 2.5
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);

  // If lengths differ, we still compare all bytes of the longer buffer
  // to avoid leaking length information through timing.
  const maxLen = Math.max(bufA.length, bufB.length);
  let mismatch = bufA.length !== bufB.length ? 1 : 0;

  for (let i = 0; i < maxLen; i++) {
    const byteA = i < bufA.length ? bufA[i] : 0;
    const byteB = i < bufB.length ? bufB[i] : 0;
    mismatch |= byteA ^ byteB;
  }

  return mismatch === 0;
}

/**
 * Redact any meaningful segment of a token found in text.
 * Checks the full token string first, then if the token is valid JSON,
 * checks each field value that is ≥ 4 chars.
 * Requirement 10.3, 10.6
 */
export function redactToken(text: string, token: string): string {
  if (!text || !token || token.length < 4) return text;

  let result = text;

  // First: redact the full token if it appears in the text
  if (token.length >= 4 && result.includes(token)) {
    result = result.replaceAll(token, "[REDACTED]");
  }

  // If the token looks like JSON, extract field values and redact those too
  try {
    const parsed = JSON.parse(token);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const value of Object.values(parsed)) {
        if (typeof value === "string" && value.length >= 4 && result.includes(value)) {
          result = result.replaceAll(value, "[REDACTED]");
        }
      }
    }
  } catch {
    // Token is not JSON — try sliding window approach for plain string tokens.
    // For non-JSON tokens ≥ 4 chars, check substrings starting from longest.
    // We check progressively shorter substrings (minimum 4 chars) to catch
    // partial token leaks (e.g., URL-encoded or truncated token values).
    if (token.length >= 4) {
      // Check substrings from length-1 down to 4 chars
      for (let len = token.length - 1; len >= 4; len--) {
        for (let start = 0; start <= token.length - len; start++) {
          const sub = token.substring(start, start + len);
          if (result.includes(sub)) {
            result = result.replaceAll(sub, "[REDACTED]");
          }
        }
      }
    }
  }

  return result;
}

/** Patterns that indicate stack traces or internal file paths */
const STACK_TRACE_PATTERNS = [
  /^\s*at .+/gm, // "    at functionName (file:line:col)"
  /\(?\/[^\s)]+\.[a-z]{1,4}:\d+(?::\d+)?\)?/g, // /path/to/file.ts:42:10
  /\(?file:\/\/\/[^\s)]+\)?/g, // file:///path/to/file.ts
  /\(?https?:\/\/[^\s)]*deno[^\s)]*\)?/g, // Deno internal URLs
  /\(?ext:\/\/[^\s)]+\)?/g, // ext://... Deno extension paths
];

/** Max length for sanitized error messages */
const MAX_ERROR_LENGTH = 500;

/**
 * Sanitize an error for safe external output.
 * Strips stack traces, file paths, and limits to 500 chars.
 * Requirement 9.3
 */
export function sanitizeError(error: unknown): string {
  let message: string;

  if (error instanceof Error) {
    // Use only the message, not the stack
    message = error.message;
  } else if (typeof error === "string") {
    message = error;
  } else {
    try {
      message = JSON.stringify(error);
    } catch {
      message = "An unexpected error occurred";
    }
  }

  // Strip stack traces and file paths
  for (const pattern of STACK_TRACE_PATTERNS) {
    message = message.replace(pattern, "");
  }

  // Remove empty lines left behind after stripping
  message = message
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ");

  // Truncate to max length
  if (message.length > MAX_ERROR_LENGTH) {
    message = message.substring(0, MAX_ERROR_LENGTH - 3) + "...";
  }

  // If we ended up with an empty message after sanitization
  if (!message.trim()) {
    message = "An unexpected error occurred";
  }

  return message;
}
