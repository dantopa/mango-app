-- push_ingest_devices: RLS on, no policies.
--
-- 20260819031500 left RLS disabled on the reasoning that only the service role
-- touches this table. That reasoning is right about who should, not about who
-- can: with RLS off, the anon key (public by design) can read and rewrite device
-- token hashes and mint a working ingest token. Production already has RLS on;
-- this makes the repo agree, so re-applying migrations cannot reopen it.
-- The service role bypasses RLS, so nothing in the app changes.
alter table public.push_ingest_devices enable row level security;
revoke all on public.push_ingest_devices from anon, authenticated;
