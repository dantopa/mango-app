-- =============================================================================
-- Maquinita — Remove the auto-seed on signup.
-- The owner already has real data; the signup trigger (0002_rls_and_seed.sql)
-- was creating an empty default account/category catalog for every new user,
-- which showed up as duplicate/empty accounts. Drop the trigger + functions.
--
-- Note: existing data is untouched. Empty seed rows for non-owner users were
-- removed as a one-off data cleanup (not part of this DDL migration).
-- =============================================================================

drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();
drop function if exists public.seed_defaults_for_user(uuid);
