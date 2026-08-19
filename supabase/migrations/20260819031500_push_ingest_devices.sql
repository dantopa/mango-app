-- =============================================================================
-- Maquinita — push_ingest_devices (per-device ingest tokens)
-- =============================================================================
-- Replaces typing PUSH_INGEST_SECRET into the Android app by hand. The phone
-- generates its own token, keeps it, and sends only its SHA-256 here, so the
-- server can recognise the device later without ever holding the token.
--
-- Pairing is a two-sided handshake:
--   1. The phone enrols (no session): token_hash + pairing_code_hash land in a
--      row with user_id NULL. Nothing in that row is usable.
--   2. The signed-in web app posts the pairing code plaintext, which binds the
--      row to a user. Only then does the token authenticate anything.
--
-- Written exclusively with the service role key, like the other push_* tables,
-- so RLS stays disabled: the pairing step has to read rows that belong to no
-- user yet, which no RLS policy can express safely.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.push_ingest_devices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  label              text NOT NULL,
  token_hash         text NOT NULL UNIQUE,
  pairing_code_hash  text UNIQUE,
  pairing_expires_at timestamptz,
  paired_at          timestamptz,
  last_used_at       timestamptz,
  revoked_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.push_ingest_devices IS
  'Per-device bearer tokens for POST /api/push-ingest. Stores hashes only; the token itself never leaves the phone.';
COMMENT ON COLUMN public.push_ingest_devices.user_id IS
  'NULL until the pairing code is approved from a signed-in session. A row with NULL user_id authenticates nothing.';
COMMENT ON COLUMN public.push_ingest_devices.label IS
  'Human-readable device name, from Build.MANUFACTURER + Build.MODEL.';
COMMENT ON COLUMN public.push_ingest_devices.token_hash IS
  'SHA-256 hex of the bearer token. Unique so re-enrolling the same phone updates its row instead of duplicating it.';
COMMENT ON COLUMN public.push_ingest_devices.pairing_code_hash IS
  'SHA-256 hex of the one-time pairing code. Cleared on approval so the code cannot be replayed.';
COMMENT ON COLUMN public.push_ingest_devices.revoked_at IS
  'Set to disable a lost phone without deleting its history.';

ALTER TABLE public.push_ingest_devices DISABLE ROW LEVEL SECURITY;

-- The hot path: every ingest request looks up one token_hash. Covered by the
-- UNIQUE constraint's index, so only the ownership listing needs its own.
CREATE INDEX IF NOT EXISTS idx_push_ingest_devices_user
  ON public.push_ingest_devices(user_id)
  WHERE user_id IS NOT NULL;
