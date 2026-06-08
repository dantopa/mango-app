-- =============================================================================
-- Maquinita v2 — Monthly close ritual (ADDITIVE)
-- A guided monthly checklist of the sources to load (statements, balances,
-- gmail-auto). The external MCP assistant updates item status as it loads each.
-- =============================================================================

create table if not exists public.monthly_close (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  period          text not null,                          -- 'YYYY-MM'
  status          text not null default 'pendiente',      -- pendiente | en_progreso | cerrado
  closed_at       timestamptz,
  net_worth_usd   numeric,
  total_spend_usd numeric,
  savings_usd     numeric,
  notes           text,
  created_at      timestamptz not null default now(),
  unique (user_id, period)
);

comment on table public.monthly_close is
  'One row per month-end close ritual. status: pendiente | en_progreso | cerrado. Snapshot fields (net_worth_usd, total_spend_usd, savings_usd) are frozen when the month is closed.';
comment on column public.monthly_close.period is 'Month bucket, format YYYY-MM (e.g. 2026-06).';
comment on column public.monthly_close.status is 'Enum (text): pendiente | en_progreso | cerrado.';

create table if not exists public.monthly_close_items (
  id          uuid primary key default gen_random_uuid(),
  close_id    uuid not null references public.monthly_close(id) on delete cascade,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  source      text not null,                              -- e.g. 'RappiCard', 'BBVA Visa', 'Nexo saldo'
  item_type   text not null,                              -- extracto_pdf | saldo | gmail_auto
  status      text not null default 'pendiente',          -- pendiente | cargado | omitido
  loaded_at   timestamptz,
  created_at  timestamptz not null default now()
);

comment on table public.monthly_close_items is
  'Checklist rows for a monthly_close. The external MCP assistant sets status=cargado and loaded_at as it ingests each source.';
comment on column public.monthly_close_items.item_type is
  'Enum (text): extracto_pdf (upload a PDF statement) | saldo (enter a numeric balance) | gmail_auto (ingested automatically from Gmail by the external assistant).';
comment on column public.monthly_close_items.status is 'Enum (text): pendiente | cargado | omitido.';

-- --- RLS: owner-scoped, mirrors the rest of the schema -----------------------
alter table public.monthly_close       enable row level security;
alter table public.monthly_close_items enable row level security;

create policy "monthly_close: owner read"   on public.monthly_close       for select using (auth.uid() = user_id);
create policy "monthly_close: owner write"  on public.monthly_close       for insert with check (auth.uid() = user_id);
create policy "monthly_close: owner update" on public.monthly_close       for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "monthly_close: owner delete" on public.monthly_close       for delete using (auth.uid() = user_id);

create policy "close_items: owner read"   on public.monthly_close_items   for select using (auth.uid() = user_id);
create policy "close_items: owner write"  on public.monthly_close_items   for insert with check (auth.uid() = user_id);
create policy "close_items: owner update" on public.monthly_close_items   for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "close_items: owner delete" on public.monthly_close_items   for delete using (auth.uid() = user_id);

-- --- indexes ------------------------------------------------------------------
create index if not exists idx_monthly_close_user_period on public.monthly_close(user_id, period);
create index if not exists idx_close_items_close_id      on public.monthly_close_items(close_id);
