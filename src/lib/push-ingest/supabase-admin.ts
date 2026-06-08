import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../supabase/database.types";

/**
 * Server-side Supabase client with service role key (bypasses RLS).
 * Lazy singleton — only initializes on first call, not at import time.
 * This prevents build failures when env vars aren't available at compile time.
 *
 * Use this exclusively in server-side push-ingest modules.
 * Never expose or import from client-side code.
 */
let _client: SupabaseClient<Database> | null = null;

export function getSupabaseAdmin(): SupabaseClient<Database> {
  if (!_client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    }
    _client = createClient<Database>(url, key, { auth: { persistSession: false } });
  }
  return _client;
}
