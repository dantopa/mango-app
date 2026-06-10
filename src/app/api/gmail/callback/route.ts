import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { storeRefreshToken } from "@/lib/sync/gmail/token-store";

/**
 * GET /api/gmail/callback
 * Handles the OAuth callback from Google.
 * Validates CSRF state, exchanges code for tokens, stores refresh token in Vault.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  const cookieStore = await cookies();
  const storedState = cookieStore.get("gmail_oauth_state")?.value;

  // CSRF protection: validate state matches cookie
  if (!state || !storedState || state !== storedState) {
    return NextResponse.json(
      { error: "Invalid state parameter (CSRF protection)" },
      { status: 403 },
    );
  }

  if (!code) {
    return NextResponse.redirect(`${origin}/?gmail=error`);
  }

  // Exchange authorization code for tokens
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URI!,
      grant_type: "authorization_code",
    }),
  });

  const tokenData = await tokenResponse.json();

  if (!tokenResponse.ok || !tokenData.refresh_token) {
    console.error("[gmail/callback] token exchange failed:", tokenData.error);
    return NextResponse.redirect(`${origin}/?gmail=error`);
  }

  // Store refresh token in Supabase Vault
  await storeRefreshToken(tokenData.refresh_token);

  // Clear the state cookie
  cookieStore.delete("gmail_oauth_state");

  return NextResponse.redirect(`${origin}/?gmail=connected`);
}
