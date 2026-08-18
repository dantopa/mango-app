-- Recovered from the remote migration history (version 20260627230430); this
-- migration was applied to production without being committed to the repo.

REVOKE EXECUTE ON FUNCTION public.vault_read_secret(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.vault_write_secret(text, text) FROM PUBLIC;
