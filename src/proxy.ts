import { type NextRequest } from "next/server";

import { updateSession } from "@/lib/supabase/middleware";

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Match all request paths except static assets, image files, and the
     * public PWA files (manifest + service worker) which must be reachable
     * without a session.
     *
     * `.well-known` is excluded because Chrome's Digital Asset Links check does
     * not follow redirects: sending it to /login is what makes the Android TWA
     * fall back to showing a URL bar.
     */
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|\\.well-known/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
