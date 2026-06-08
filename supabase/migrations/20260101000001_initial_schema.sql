-- =============================================================================
-- Maquinita — Initial schema
-- =============================================================================
-- Personal finance tracker. Money is ALWAYS stored in its native currency AND
-- with a snapshot of the USD value at load time (we never convert on the fly).
--
-- Data is written by TWO actors:
--   1. The Next.js app (authenticated user, governed by RLS — see 0002).
--   2. An EXTERNAL assistant with MCP access that parses bank statements and
--      writes directly to this database using the SERVICE ROLE key (bypasses
--      RLS). That writer MUST set `user_id` to the owning user's id on every
--      row it inserts. Column names and enums below are intentionally stable
--      and predictable for that writer.
-- =============================================================================

create extension if not exists pgcrypto;

-- Account categories. Stable enum — extend via migration, never ad-hoc.
create type account_type as enum ('crypto', 'broker', 'bank', 'wallet', 'cash');

-- -----------------------------------------------------------------------------
-- accounts — catalog of my accounts / wallets
-- -----------------------------------------------------------------------------
create table public.accounts (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade default auth.uid(),
  name             text not null,                 -- e.g. "Nexo", "IBKR", "Bancolombia CDT"
  type             account_type not null,
  native_currency  text not null,                 -- ISO-ish code: USD, COP, ARS, USDT, ...
  is_active        boolean not null default true,
  created_at       timestamptz not null default now()
);

comment on table  public.accounts is 'Catalog of the user''s accounts/wallets. One row per account.';
comment on column public.accounts.type is 'One of: crypto | broker | bank | wallet | cash';
comment on column public.accounts.native_currency is 'Currency the account holds, e.g. USD, COP, ARS, USDT.';

-- -----------------------------------------------------------------------------
-- categories — spending categories (self-referencing for subcategories)
-- -----------------------------------------------------------------------------
create table public.categories (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade default auth.uid(),
  name               text not null,
  parent_id          uuid references public.categories (id) on delete set null,
  color              text not null default '#8b5cf6',  -- hex used in charts
  monthly_budget_usd numeric(14, 2),                   -- optional per-category budget
  created_at         timestamptz not null default now()
);

comment on table  public.categories is 'Spending categories. parent_id enables subcategories.';
comment on column public.categories.color is 'Hex color (e.g. #8b5cf6) used to render the category in charts.';

-- -----------------------------------------------------------------------------
-- net_worth_snapshots — one row per account per cut-off date (monthly)
-- Feeds the net-worth line chart and the stacked-area composition chart.
-- -----------------------------------------------------------------------------
create table public.net_worth_snapshots (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade default auth.uid(),
  account_id      uuid not null references public.accounts (id) on delete cascade,
  snapshot_date   date not null,                  -- cut-off date for the balance
  balance_native  numeric(20, 4) not null,        -- balance in native currency
  native_currency text not null,
  fx_rate_to_usd  numeric(20, 8) not null,        -- FX rate used at load time (native -> USD)
  balance_usd     numeric(20, 4) not null,        -- = balance_native * fx_rate_to_usd, STORED snapshot
  notes           text,                           -- e.g. "44916 USDT + 2984 NEXO"
  is_pending      boolean not null default false, -- money in transit / reimbursements
  created_at      timestamptz not null default now(),
  unique (account_id, snapshot_date)
);

comment on table  public.net_worth_snapshots is 'One balance row per account per cut-off date. balance_usd is a stored snapshot, not computed on read.';
comment on column public.net_worth_snapshots.fx_rate_to_usd is 'Native->USD rate used at load time. Stored so historical USD values never shift.';
comment on column public.net_worth_snapshots.is_pending is 'True for money in transit / reimbursements not yet settled.';

-- -----------------------------------------------------------------------------
-- transactions — every individual line item from the statements
-- -----------------------------------------------------------------------------
create table public.transactions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade default auth.uid(),
  account_id       uuid not null references public.accounts (id) on delete cascade,
  tx_date          date not null,
  description_raw  text not null,                 -- description exactly as the bank sends it
  merchant         text,                          -- normalized merchant name
  amount_native    numeric(20, 4) not null,       -- positive = expense, negative = payment/refund
  native_currency  text not null,
  fx_rate_to_usd   numeric(20, 8) not null,
  amount_usd       numeric(20, 4) not null,       -- STORED snapshot
  category_id      uuid references public.categories (id) on delete set null,
  is_payment       boolean not null default false,-- true for "PAGOS ... APP", refunds: NOT an expense
  is_extraordinary boolean not null default false,-- one-off: flights, appliances, etc.
  installments     text,                          -- e.g. "1 de 1", "3 de 6"
  statement_period text,                          -- e.g. "2026-04-30 a 2026-05-28"
  created_at       timestamptz not null default now()
);

comment on table  public.transactions is 'Individual line items from statements. amount_native > 0 is an expense; < 0 is a payment/refund.';
comment on column public.transactions.is_payment is 'True for payments/refunds (e.g. "PAGOS ... APP"). These must be EXCLUDED from spending totals.';
comment on column public.transactions.is_extraordinary is 'True for one-off purchases (flights, appliances). Allows excluding them to see "normal life" spend.';
comment on column public.transactions.amount_usd is 'Stored snapshot of amount in USD. Sign matches amount_native.';

-- -----------------------------------------------------------------------------
-- goals — savings targets
-- -----------------------------------------------------------------------------
create table public.goals (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade default auth.uid(),
  name        text not null,                      -- e.g. "70k Julio 2026"
  target_usd  numeric(20, 2) not null,
  target_date date not null,
  start_usd   numeric(20, 2) not null,            -- net worth when the goal started
  start_date  date not null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

comment on table public.goals is 'Savings goals. Progress is measured from start_usd/start_date toward target_usd/target_date.';

-- Indexes for the read-heavy dashboards
create index accounts_user_idx              on public.accounts (user_id);
create index categories_user_idx            on public.categories (user_id);
create index net_worth_user_date_idx        on public.net_worth_snapshots (user_id, snapshot_date);
create index net_worth_account_date_idx     on public.net_worth_snapshots (account_id, snapshot_date);
create index transactions_user_date_idx     on public.transactions (user_id, tx_date);
create index transactions_category_idx      on public.transactions (category_id);
create index transactions_account_idx       on public.transactions (account_id);
create index goals_user_active_idx          on public.goals (user_id, is_active);
