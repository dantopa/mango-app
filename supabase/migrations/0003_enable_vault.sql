-- Migration: Enable Supabase Vault for encrypted token storage
-- Requirement 4.6: Edge Function interacts with Vault via vault.secrets schema

-- Enable the vault extension (pgsodium is a dependency, already present in Supabase)
create extension if not exists supabase_vault with schema vault;

-- Grant service role access to vault tables and views
grant usage on schema vault to service_role;
grant select, insert, update, delete on vault.secrets to service_role;
grant select on vault.decrypted_secrets to service_role;
