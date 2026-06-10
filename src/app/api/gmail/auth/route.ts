import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomBytes } from "crypto";

import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/gmail/auth
 * Initiates the Google OAuth flow for Gmail readonly access.
 * Requires an authenticated Supabase session; redirects to /login otherwise.
 */
export async function GET(request: Request) {
  const { origin } = new URL(request.url);

  // Verify Supabase session
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(`${origin}/login`);
  }

  // Generate random state for CSRF protection
  const state = randomBytes(32).toString("hex");

  // Set state as httpOnly cookie (SameSite=Lax, 10 min TTL)
  const cookieStore = await cookies();
  cookieStore.set("gmail_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/",
    secure: process.env.NODE_ENV === "production",
  });

  // Build Google OAuth URL
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URI!,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    access_type: "offline",
    prompt: "consent",
    state,
  });

  const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

  return NextResponse.redirect(googleAuthUrl, 302);
}
