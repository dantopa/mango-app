import { getRefreshToken } from "./token-store";
import { htmlToText } from "./html-to-text";
import type { ParsedEmail } from "./types";

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class GmailAuthError extends Error {
  code = "GMAIL_AUTH_REQUIRED" as const;

  constructor(message: string) {
    super(message);
    this.name = "GmailAuthError";
  }
}

export class GmailApiError extends Error {
  code = "GMAIL_API_ERROR" as const;

  constructor(message: string) {
    super(message);
    this.name = "GmailApiError";
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const TIMEOUT_MS = 10_000;
const RETRY_BACKOFF_MS = 1_000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Fetch wrapper with 10s timeout via AbortController.
 * On 429 or 5xx, retries once after 1s backoff; then throws.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const attempt = async (): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      return res;
    } finally {
      clearTimeout(timer);
    }
  };

  let response: Response;
  try {
    response = await attempt();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new GmailApiError("Gmail API request timed out (10s)");
    }
    throw new GmailApiError(
      err instanceof Error ? err.message : "Network error",
    );
  }

  // Retry on 429 or 5xx
  if (response.status === 429 || response.status >= 500) {
    await sleep(RETRY_BACKOFF_MS);

    try {
      response = await attempt();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new GmailApiError("Gmail API request timed out on retry (10s)");
      }
      throw new GmailApiError(
        err instanceof Error ? err.message : "Network error on retry",
      );
    }

    if (response.status === 429 || response.status >= 500) {
      throw new GmailApiError(
        `Gmail API error: HTTP ${response.status} after retry`,
      );
    }
  }

  return response;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Decode a base64url-encoded string to UTF-8 text.
 */
function decodeBase64Url(encoded: string): string {
  // Convert base64url to standard base64
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const buffer = Buffer.from(base64, "base64");
  return buffer.toString("utf-8");
}

// ---------------------------------------------------------------------------
// Gmail API types (internal, from the REST response)
// ---------------------------------------------------------------------------

interface GmailListResponse {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

interface GmailMessagePart {
  mimeType: string;
  body?: { data?: string; size?: number };
  parts?: GmailMessagePart[];
}

interface GmailMessageResponse {
  id: string;
  internalDate: string;
  payload: {
    headers: Array<{ name: string; value: string }>;
    mimeType: string;
    body?: { data?: string; size?: number };
    parts?: GmailMessagePart[];
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Refresh the Gmail access token using the stored refresh token from Vault.
 * Throws GmailAuthError if no refresh token exists or if it's been revoked.
 */
export async function refreshAccessToken(): Promise<string> {
  const refreshToken = await getRefreshToken();

  if (!refreshToken) {
    throw new GmailAuthError("No refresh token stored — Gmail not connected");
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new GmailApiError(
      "Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET env vars",
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new GmailApiError("Token refresh request timed out (10s)");
    }
    throw new GmailApiError(
      err instanceof Error ? err.message : "Token refresh network error",
    );
  } finally {
    clearTimeout(timer);
  }

  const data = await response.json();

  if (!response.ok) {
    if (data.error === "invalid_grant") {
      throw new GmailAuthError(
        "Refresh token revoked or expired — reconnect Gmail",
      );
    }
    throw new GmailApiError(
      `Token refresh failed: ${data.error_description || data.error || response.status}`,
    );
  }

  return data.access_token as string;
}

/**
 * List message IDs matching a Gmail search query.
 * Returns message IDs and the next page token (null if no more pages).
 */
export async function listMessageIds(
  accessToken: string,
  query: string,
  pageToken?: string,
): Promise<{ messageIds: string[]; nextPageToken: string | null }> {
  const params = new URLSearchParams({
    q: query,
    maxResults: "100",
  });
  if (pageToken) {
    params.set("pageToken", pageToken);
  }

  const url = `${GMAIL_API_BASE}/messages?${params.toString()}`;

  const response = await fetchWithRetry(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (response.status === 401) {
    throw new GmailAuthError("Access token expired or invalid");
  }

  if (!response.ok) {
    throw new GmailApiError(
      `Gmail list messages failed: HTTP ${response.status}`,
    );
  }

  const data: GmailListResponse = await response.json();

  return {
    messageIds: data.messages?.map((m) => m.id) ?? [],
    nextPageToken: data.nextPageToken ?? null,
  };
}

/**
 * Fetch a full message and parse it into a ParsedEmail.
 * Prefers text/plain body part; falls back to html-to-text conversion.
 */
export async function getMessage(
  accessToken: string,
  messageId: string,
): Promise<ParsedEmail> {
  const url = `${GMAIL_API_BASE}/messages/${messageId}?format=full`;

  const response = await fetchWithRetry(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (response.status === 401) {
    throw new GmailAuthError("Access token expired or invalid");
  }

  if (!response.ok) {
    throw new GmailApiError(
      `Gmail get message failed: HTTP ${response.status}`,
    );
  }

  const msg: GmailMessageResponse = await response.json();

  // Extract subject from headers
  const subject =
    msg.payload.headers.find(
      (h) => h.name.toLowerCase() === "subject",
    )?.value ?? "";

  // Extract body: prefer text/plain, fallback to text/html → htmlToText
  const bodyText = extractBodyText(msg.payload);

  return {
    messageId: msg.id,
    internalDate: msg.internalDate,
    subject,
    bodyText,
  };
}

// ---------------------------------------------------------------------------
// Body extraction helpers
// ---------------------------------------------------------------------------

/**
 * Recursively find a body part by MIME type in the message payload.
 */
function findPart(
  part: GmailMessagePart,
  mimeType: string,
): GmailMessagePart | null {
  if (part.mimeType === mimeType && part.body?.data) {
    return part;
  }
  if (part.parts) {
    for (const child of part.parts) {
      const found = findPart(child, mimeType);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Extract body text from the message payload.
 * Priority: text/plain > text/html (converted via htmlToText).
 */
function extractBodyText(payload: GmailMessageResponse["payload"]): string {
  // Simple case: top-level body with text/plain
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  // Search within multipart structure
  const asPartNode: GmailMessagePart = {
    mimeType: payload.mimeType,
    body: payload.body,
    parts: payload.parts,
  };

  // Try text/plain first
  const plainPart = findPart(asPartNode, "text/plain");
  if (plainPart?.body?.data) {
    return decodeBase64Url(plainPart.body.data);
  }

  // Fallback to text/html → convert to plain text
  const htmlPart = findPart(asPartNode, "text/html");
  if (htmlPart?.body?.data) {
    const html = decodeBase64Url(htmlPart.body.data);
    return htmlToText(html);
  }

  // No usable body found
  return "";
}
