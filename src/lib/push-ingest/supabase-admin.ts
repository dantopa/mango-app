import { createClient } from "@supabase/supabase-js";

import type { Database } from "../supabase/database.types";

/**
 * Server-side Supabase client with service role key (bypasses RLS).
 * Singleton — reusable across invocations within the same serverless container.
 *
 * Use this exclusively in server-side push-ingest modules.
 * Never expose or import from client-side code.
 */
export const supabaseAdmin = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);
