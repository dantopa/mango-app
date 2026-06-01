-- =============================================================================
-- Maquinita v2 — Expense dimensions (ADDITIVE, non-destructive)
-- Adds country / payment_type / expense_type so spend can be sliced by
-- account, country, payment medium and fixed/variable/extraordinary nature.
-- Safe to run on a database with existing data: only ADD COLUMN + UPDATE.
-- =============================================================================

-- --- accounts: default country + payment medium ------------------------------
alter table public.accounts
  add column if not exists country text,
  add column if not exists payment_type text;

comment on column public.accounts.country is
  'Country of the account/card. Enum (text): AR | CO | US | global.';
comment on column public.accounts.payment_type is
  'Default payment medium of this account. Enum (text): credito | debito | transferencia | pse_qr | efectivo | inversion | wallet.';

-- --- transactions: per-tx dimensions -----------------------------------------
alter table public.transactions
  add column if not exists country      text not null default 'CO',
  add column if not exists payment_type text,
  add column if not exists expense_type text not null default 'variable';

comment on column public.transactions.country is
  'Country where the expense happened. Enum (text): AR | CO | US | global. May differ from the account country (e.g. a CO card used while in AR). Default CO.';
comment on column public.transactions.payment_type is
  'Payment medium for this tx. Enum (text): credito | debito | transferencia | pse_qr | efectivo | inversion | wallet. Inherited from the account by default, editable per tx.';
comment on column public.transactions.expense_type is
  'Nature of the expense. Enum (text): fijo (rent, health insurance, subscriptions) | variable (delivery, transport, outings) | extraordinario (one-offs: flights, appliances). Default variable. Supersedes the legacy is_extraordinary boolean (kept for compatibility).';

-- --- backfill accounts by name (sensible defaults) ---------------------------
update public.accounts set
  country = case
    when name in ('Bancolombia Ahorros','Bancolombia CDT','Rappi') then 'CO'
    when name in ('BBVA','Brubank')                                 then 'AR'
    else 'global'
  end,
  payment_type = case
    when name = 'Bancolombia Ahorros'   then 'debito'
    when name = 'Bancolombia CDT'       then 'inversion'
    when name = 'BBVA'                  then 'credito'
    when name = 'Brubank'               then 'debito'
    when name = 'Rappi'                 then 'credito'
    when name = 'DolarApp/Arq'          then 'wallet'
    when name in ('Nexo','IBKR')        then 'inversion'
    when name = 'Wise PDE IT Services'  then 'transferencia'
    else 'debito'
  end
where country is null or payment_type is null;

-- --- backfill transactions ----------------------------------------------------
-- country + payment_type inherited from the owning account
update public.transactions t set
  country      = coalesce(a.country, 'CO'),
  payment_type = coalesce(a.payment_type, 'credito')
from public.accounts a
where t.account_id = a.id;

-- expense_type from category nature, then force extraordinary from the flag
update public.transactions t set
  expense_type = case
    when c.name in ('Suscripciones','Servicios (internet/telefonía)') then 'fijo'
    else 'variable'
  end
from public.categories c
where t.category_id = c.id and not t.is_extraordinary;

update public.transactions set expense_type = 'extraordinario'
where is_extraordinary;

-- --- indexes for fast faceted filtering --------------------------------------
create index if not exists idx_transactions_country      on public.transactions(country);
create index if not exists idx_transactions_payment_type on public.transactions(payment_type);
create index if not exists idx_transactions_expense_type on public.transactions(expense_type);
create index if not exists idx_transactions_account_id   on public.transactions(account_id);
