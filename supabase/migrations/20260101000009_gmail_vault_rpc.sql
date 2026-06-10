-- Migration: Vault helper RPCs + PALOMMA transfer classification rule
-- Requirements: 1.6 (refresh token only accessible via service_role)
--               5.4 (transfer classification rule for Palomma dedup)

-- -----------------------------------------------------------------------------
-- vault_upsert_secret — insert or update a named secret in Vault
-- -----------------------------------------------------------------------------
create or replace function public.vault_upsert_secret(p_name text, p_secret text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from vault.secrets where name = p_name) then
    perform vault.update_secret((select id from vault.secrets where name = p_name), p_secret);
  else
    perform vault.create_secret(p_secret, p_name);
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- vault_get_secret — retrieve decrypted value of a named secret
-- -----------------------------------------------------------------------------
create or replace function public.vault_get_secret(p_name text)
returns text language sql security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_name;
$$;

-- -----------------------------------------------------------------------------
-- Permissions: revoke from public/anon/authenticated, grant only to service_role
-- -----------------------------------------------------------------------------
revoke execute on function public.vault_upsert_secret(text, text) from public, anon, authenticated;
revoke execute on function public.vault_get_secret(text) from public, anon, authenticated;
grant  execute on function public.vault_upsert_secret(text, text) to service_role;
grant  execute on function public.vault_get_secret(text) to service_role;

-- -----------------------------------------------------------------------------
-- Seed: transfer_classification_rules — PALOMMA allowlist
-- The Arriendo payment via Palomma also generates a Bancolombia "Transferiste"
-- email. This rule ensures that transfer is marked is_payment (not double-counted).
-- -----------------------------------------------------------------------------
insert into public.transfer_classification_rules (user_id, pattern, match_type, list_type, description)
values (
  '49b33f55-dcf2-4370-ba9a-204b91f2551d',
  'PALOMMA',
  'ilike',
  'allowlist',
  'Pago de arriendo vía Palomma — la transferencia Bancolombia es el mismo gasto'
);
