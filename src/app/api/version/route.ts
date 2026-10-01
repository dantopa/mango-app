import { NextResponse } from "next/server";

import { BUILD_TIME, CURRENT_BUILD } from "@/lib/app-version";

// Must answer with the build serving this request, never a cached one.
export const dynamic = "force-dynamic";

/** The deployed build, so an open app can tell it is running an older one. */
export function GET(): NextResponse {
  return NextResponse.json(
    { build: CURRENT_BUILD, builtAt: BUILD_TIME },
    { headers: { "Cache-Control": "no-store" } },
  );
}
