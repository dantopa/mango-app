import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";

/** Exchanges the magic-link / OAuth code for a session, then redirects home. */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  // Only same-site paths: "next=@evil.com" would turn `${origin}${next}` into
  // "https://app@evil.com", and "//evil.com" is protocol-relative.
  const requested = searchParams.get("next") ?? "/";
  const next = requested.startsWith("/") && !requested.startsWith("//") && !requested.startsWith("/\\")
    ? requested
    : "/";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
