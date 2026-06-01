-- =============================================================================
-- Maquinita — Row Level Security + per-user default seed
-- =============================================================================
-- Every table is owner-scoped: a user can only read/write rows where
-- user_id = auth.uid(). The external statement-parsing writer uses the SERVICE
-- ROLE key, which bypasses RLS entirely, so it can write rows for any user as
-- long as it sets user_id correctly.
-- =============================================================================

alter table public.accounts            enable row level security;
alter table public.categories          enable row level security;
alter table public.net_worth_snapshots enable row level security;
alter table public.transactions        enable row level security;
alter table public.goals               enable row level security;

-- Owner-only policies (one helper macro per table, expanded explicitly).
create policy "accounts: owner read"   on public.accounts            for select using (auth.uid() = user_id);
create policy "accounts: owner write"  on public.accounts            for insert with check (auth.uid() = user_id);
create policy "accounts: owner update" on public.accounts            for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "accounts: owner delete" on public.accounts            for delete using (auth.uid() = user_id);

create policy "categories: owner read"   on public.categories        for select using (auth.uid() = user_id);
create policy "categories: owner write"  on public.categories        for insert with check (auth.uid() = user_id);
create policy "categories: owner update" on public.categories        for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "categories: owner delete" on public.categories        for delete using (auth.uid() = user_id);

create policy "snapshots: owner read"   on public.net_worth_snapshots for select using (auth.uid() = user_id);
create policy "snapshots: owner write"  on public.net_worth_snapshots for insert with check (auth.uid() = user_id);
create policy "snapshots: owner update" on public.net_worth_snapshots for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "snapshots: owner delete" on public.net_worth_snapshots for delete using (auth.uid() = user_id);

create policy "transactions: owner read"   on public.transactions    for select using (auth.uid() = user_id);
create policy "transactions: owner write"  on public.transactions    for insert with check (auth.uid() = user_id);
create policy "transactions: owner update" on public.transactions    for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "transactions: owner delete" on public.transactions    for delete using (auth.uid() = user_id);

create policy "goals: owner read"   on public.goals                  for select using (auth.uid() = user_id);
create policy "goals: owner write"  on public.goals                  for insert with check (auth.uid() = user_id);
create policy "goals: owner update" on public.goals                  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "goals: owner delete" on public.goals                  for delete using (auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- Per-user default seed: when a user signs up, give them the standard account
-- catalog and category set so the app is usable immediately. Sample
-- transactions/snapshots are loaded separately (see supabase/seed.sql).
-- -----------------------------------------------------------------------------
create or replace function public.seed_defaults_for_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Default accounts (skip if the user already has any)
  if not exists (select 1 from public.accounts where user_id = p_user_id) then
    insert into public.accounts (user_id, name, type, native_currency) values
      (p_user_id, 'Nexo',                  'crypto', 'USDT'),
      (p_user_id, 'IBKR',                  'broker', 'USD'),
      (p_user_id, 'Wise PDE IT Services',  'bank',   'USD'),
      (p_user_id, 'Bancolombia CDT',       'bank',   'COP'),
      (p_user_id, 'Bancolombia Ahorros',   'bank',   'COP'),
      (p_user_id, 'Rappi',                 'wallet', 'COP'),
      (p_user_id, 'Brubank',               'bank',   'ARS'),
      (p_user_id, 'BBVA',                  'bank',   'ARS'),
      (p_user_id, 'DolarApp/Arq',          'wallet', 'USD');
  end if;

  -- Default categories (skip if the user already has any)
  if not exists (select 1 from public.categories where user_id = p_user_id) then
    insert into public.categories (user_id, name, color) values
      (p_user_id, 'Mercado/Super',                  '#22c55e'),
      (p_user_id, 'Delivery comida',                '#f97316'),
      (p_user_id, 'Restaurantes/Bares',             '#ef4444'),
      (p_user_id, 'Cafés',                          '#a16207'),
      (p_user_id, 'Transporte (Uber/Didi)',         '#3b82f6'),
      (p_user_id, 'Suscripciones',                  '#8b5cf6'),
      (p_user_id, 'Salud/Farmacia',                 '#06b6d4'),
      (p_user_id, 'Servicios (internet/telefonía)', '#0ea5e9'),
      (p_user_id, 'Compras/Hogar',                  '#ec4899'),
      (p_user_id, 'Viajes/Pasajes',                 '#eab308'),
      (p_user_id, 'Gym/Salud física',               '#14b8a6'),
      (p_user_id, 'Varios',                         '#6b7280');
  end if;
end;
$$;

comment on function public.seed_defaults_for_user is 'Seeds the default account catalog and category set for a user. Idempotent.';

-- Run the seed automatically on signup.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.seed_defaults_for_user(new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
