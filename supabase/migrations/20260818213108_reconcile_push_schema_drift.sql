-- =============================================================================
-- Maquinita — Reconcile push schema drift
-- =============================================================================
-- Brings the versioned schema back in sync with production for the objects that
-- were changed directly in the dashboard, and drops a stale CHECK constraint
-- that silently blocked three of the statuses the ingest pipeline writes.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Drop the stale status CHECK on push_ingest_log
-- -----------------------------------------------------------------------------
-- Migration 20260101000007 created chk_ingest_status with 8 statuses. The
-- statuses added later (20260611164340, 20260613014108) went into a second
-- constraint, push_ingest_log_status_check, so both were enforced at once and
-- their intersection was still the original 8. Every write of 'pending_cleanup',
-- 'deduped_wallet_echo' or 'upgraded_cross_source' was rejected by the database.
-- push_ingest_log_status_check is the authoritative list from here on.
ALTER TABLE public.push_ingest_log DROP CONSTRAINT IF EXISTS chk_ingest_status;

-- -----------------------------------------------------------------------------
-- 2. RLS on push_raw_log (owner read-only)
-- -----------------------------------------------------------------------------
-- Enabled in production but never committed. Writes come from the Route Handler
-- with the service role key, which bypasses RLS.
ALTER TABLE public.push_raw_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "push_raw_log read" ON public.push_raw_log;
CREATE POLICY "push_raw_log read" ON public.push_raw_log
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- -----------------------------------------------------------------------------
-- 3. get_google_secrets — created in the dashboard, no migration
-- -----------------------------------------------------------------------------
-- Reconstructed from the live definition. Currently unused by the app (the Gmail
-- token store uses vault_get_secret instead); committed so the schema is
-- reproducible, and a candidate for removal.
CREATE OR REPLACE FUNCTION public.get_google_secrets()
RETURNS TABLE(name text, secret text)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO ''
AS $$
  select s.name::text, s.decrypted_secret::text
  from vault.decrypted_secrets s
  where s.name in ('GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REFRESH_TOKEN');
$$;

REVOKE EXECUTE ON FUNCTION public.get_google_secrets() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_google_secrets() TO service_role;
