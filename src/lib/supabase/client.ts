import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "./database.types";

/** Browser-side Supabase client. RLS scopes every query to the signed-in user. */
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
