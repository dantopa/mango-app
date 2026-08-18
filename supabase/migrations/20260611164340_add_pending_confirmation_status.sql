-- Recovered from the remote migration history (version 20260611164340); this
-- migration was applied to production without being committed to the repo.

-- Add pending_confirmation status to push_ingest_log
ALTER TABLE push_ingest_log DROP CONSTRAINT IF EXISTS push_ingest_log_status_check;
ALTER TABLE push_ingest_log ADD CONSTRAINT push_ingest_log_status_check
  CHECK (status = ANY (ARRAY['processing', 'registered', 'duplicate', 'deduped_cross_source', 'no_parser', 'fx_pending', 'registration_failed', 'transfer', 'upgraded_cross_source', 'pending_confirmation']));

-- Add confirmation columns
ALTER TABLE push_ingest_log ADD COLUMN IF NOT EXISTS pending_data jsonb;
COMMENT ON COLUMN push_ingest_log.pending_data IS 'Parsed transaction data waiting for user confirmation (LLM-detected new source).';
