-- Recovered from the remote migration history (version 20260613014108); this
-- migration was applied to production without being committed to the repo.

ALTER TABLE push_ingest_log DROP CONSTRAINT IF EXISTS push_ingest_log_status_check;
ALTER TABLE push_ingest_log ADD CONSTRAINT push_ingest_log_status_check
  CHECK (status = ANY (ARRAY['processing', 'registered', 'duplicate', 'deduped_cross_source', 'no_parser', 'fx_pending', 'registration_failed', 'transfer', 'pending_cleanup', 'deduped_wallet_echo', 'upgraded_cross_source']));
