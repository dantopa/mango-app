-- Add dedup signals columns (nullable, additive — no breaking change)
alter table public.transactions
  add column if not exists card_last4  text,
  add column if not exists external_ts timestamptz;

comment on column public.transactions.card_last4 is
  'Últimos 4 dígitos de la tarjeta (señal fuerte de dedup cross-source). Poblada por push y sync.';
comment on column public.transactions.external_ts is
  'Timestamp real de la compra/notificación (push: payload.timestamp). NULL si la fuente solo da día. Usado por la ventana fina cross-currency; distinto de created_at (inserción).';

-- Backfill best-effort del last4 desde description_raw
update public.transactions
set card_last4 = (regexp_match(description_raw, '[*•]{1,2}(\d{4})'))[1]
where card_last4 is null and description_raw ~ '[*•]{1,2}\d{4}';

-- Index for same-currency dedup lookups (user + amount + date)
create index if not exists idx_tx_dedup
  on public.transactions (user_id, amount_native, tx_date);

-- Index for cross-currency dedup lookups (user + card_last4 + external_ts)
create index if not exists idx_tx_dedup_card
  on public.transactions (user_id, card_last4, external_ts);
