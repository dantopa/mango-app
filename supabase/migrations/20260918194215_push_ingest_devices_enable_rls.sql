-- Supersedes the "RLS stays disabled" decision in 20260819031500_push_ingest_devices.sql.
--
-- That reasoning was wrong: the table is only ever touched with the service role
-- key, which bypasses RLS, so enabling it with no policies costs nothing. Left
-- open, anon could read every user_id and insert a device row with a known
-- token_hash already bound to a user, and use it to forge /api/push-ingest calls.
--
-- No policies on purpose: anon and authenticated get no access at all.

ALTER TABLE public.push_ingest_devices ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.push_ingest_devices FROM anon, authenticated;
