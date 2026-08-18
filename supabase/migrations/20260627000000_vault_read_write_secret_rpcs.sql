-- vault_read_secret / vault_write_secret — RPCs used by the browser-token-mcp
-- Edge Function (supabase/functions/browser-token-mcp/vault.ts).
--
-- These were created directly in the dashboard, so they have no entry in the
-- remote migration history. Reconstructed here from the live definitions in
-- production. The version is dated before 20260627230357, which REVOKEs EXECUTE
-- on them and would fail on a fresh database if they did not exist yet.
--
-- They overlap with vault_get_secret / vault_upsert_secret (20260610024636),
-- which are the ones the Next.js app uses.

CREATE OR REPLACE FUNCTION public.vault_read_secret(secret_name text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  result text;
BEGIN
  SELECT decrypted_secret INTO result
  FROM vault.decrypted_secrets
  WHERE name = secret_name
  LIMIT 1;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.vault_write_secret(secret_name text, secret_value text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  existing_id uuid;
BEGIN
  SELECT id INTO existing_id FROM vault.secrets WHERE name = secret_name LIMIT 1;
  IF existing_id IS NOT NULL THEN
    PERFORM vault.update_secret(existing_id, secret_value, secret_name);
  ELSE
    PERFORM vault.create_secret(secret_value, secret_name);
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.vault_read_secret(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.vault_write_secret(text, text) TO service_role;
