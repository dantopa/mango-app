-- =============================================================================
-- Transaction status + reconciliation audit
-- =============================================================================
-- Context: closing September 2026 took deleting 34 rows by hand (3,708 → 3,110
-- USD): RappiCard purchases notified twice (issuer + Google Wallet, plus
-- Wallet re-posts), Uber/Didi pre-authorizations counted as spend after being
-- released, and a 1M COP transfer between the owner's own accounts filed as
-- "Varios".
--
-- Rows are no longer deleted. Each one carries a status, and only `active`
-- rows count toward spend, income, the monthly close and the semaphore. The
-- reconciler (src/lib/reconcile) sets the others and logs why.
-- Everything here is additive: every existing row starts `active`, so totals
-- do not move until the reconciler runs.
-- =============================================================================

-- --- 1. Status on transactions -----------------------------------------------
alter table public.transactions
  add column if not exists status        text    not null default 'active',
  add column if not exists duplicate_of  uuid    references public.transactions (id) on delete set null,
  add column if not exists paired_with   uuid    references public.transactions (id) on delete set null,
  add column if not exists status_reason text,
  add column if not exists status_manual boolean not null default false;

alter table public.transactions drop constraint if exists transactions_status_check;
alter table public.transactions add constraint transactions_status_check
  check (status in ('active', 'duplicate', 'voided', 'internal_transfer'));

comment on column public.transactions.status is
  'active = counts; duplicate = another notification of the purchase in duplicate_of; voided = a pre-authorization and its release, see paired_with; internal_transfer = money between the owner''s own accounts. Only active rows count toward spend or income.';
comment on column public.transactions.duplicate_of is 'For status = duplicate: the row kept for this purchase.';
comment on column public.transactions.paired_with is 'For status = voided: the hold or release this row cancels out with.';
comment on column public.transactions.status_reason is 'Rule that set the status (duplicate_notification | preauth_released | internal_transfer | manual).';
comment on column public.transactions.status_manual is 'A person set the status; the reconciler never changes it.';

-- Spend queries always filter on active; most rows are.
create index if not exists transactions_active_user_date_idx
  on public.transactions (user_id, tx_date) where status = 'active';

-- --- 2. Explicit kind -----------------------------------------------------------
-- Income used to be "negative and not a payment", and showed up as a row with
-- no category. Derived, so no writer (app, sync, external MCP assistant) can
-- forget to set it or leave it stale after toggling is_payment.
alter table public.transactions
  add column if not exists kind text generated always as (
    case
      when is_payment then 'payment'
      when amount_native < 0 then 'income'
      else 'expense'
    end
  ) stored;

comment on column public.transactions.kind is
  'expense | income | payment (card payment or refund, is_payment = true). Derived from is_payment and the sign of amount_native.';

-- --- 3. Audit log of every reconciliation decision ----------------------------
create table if not exists public.transaction_reconcile_log (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade default auth.uid(),
  run_id         uuid not null,
  trigger        text not null,          -- ingest | job | backfill
  transaction_id uuid not null references public.transactions (id) on delete cascade,
  rule           text not null,          -- duplicate_notification | preauth_released | internal_transfer | restored
  ref_transaction_id uuid references public.transactions (id) on delete set null,
  from_status    text not null,
  to_status      text not null,
  detail         text,
  created_at     timestamptz not null default now()
);

comment on table public.transaction_reconcile_log is
  'One row per status change made by the reconciler: which rule matched and against which transaction.';

create index if not exists idx_reconcile_log_tx on public.transaction_reconcile_log (transaction_id);
create index if not exists idx_reconcile_log_user_created on public.transaction_reconcile_log (user_id, created_at desc);

alter table public.transaction_reconcile_log enable row level security;
drop policy if exists "reconcile_log: owner read" on public.transaction_reconcile_log;
create policy "reconcile_log: owner read" on public.transaction_reconcile_log
  for select using (auth.uid() = user_id);

-- --- 4. Owner identity, for internal transfers --------------------------------
alter table public.user_settings
  add column if not exists owner_names text[] not null default '{}',
  add column if not exists owner_keys  text[] not null default '{}';

comment on column public.user_settings.owner_names is
  'Full names the owner''s bank accounts are registered under. A transfer to or from them is internal.';
comment on column public.user_settings.owner_keys is
  'Transfer keys (llaves) and account numbers the owner controls. A transfer to them is internal.';

-- --- 5. Nexo Card: the new card ••5667 ----------------------------------------
-- Unmapped, the resolver fell back to the name "Nexo Mastercard" and filed its
-- notifications under "Nexo" (the USDT wallet) instead of "Nexo Card".
update public.accounts
set card_digits = array_append(card_digits, '5667')
where name = 'Nexo Card' and not ('5667' = any (card_digits));

-- --- 6. "Seguridad social" category -------------------------------------------
-- "APORTES EN LINEA" is PILA (social security), not rent. Created for every
-- user that has the rule that was sending it to Vivienda/Arriendo.
insert into public.categories (user_id, name, color)
select distinct r.user_id, 'Seguridad social', '#0d9488'
from public.merchant_category_rules r
where r.pattern ilike 'APORTES EN%'
  and not exists (
    select 1 from public.categories c where c.user_id = r.user_id and c.name = 'Seguridad social'
  );

update public.merchant_category_rules r
set category_id = c.id, priority = greatest(r.priority, 10)
from public.categories c
where r.pattern ilike 'APORTES EN%'
  and c.user_id = r.user_id and c.name = 'Seguridad social';

update public.transactions t
set category_id = c.id
from public.categories c
where t.user_id = c.user_id and c.name = 'Seguridad social'
  and (t.merchant ilike 'APORTES EN LINEA%' or t.description_raw ilike '%APORTES EN LINEA%');
