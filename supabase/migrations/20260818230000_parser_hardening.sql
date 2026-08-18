-- =============================================================================
-- Parser hardening: card→account mapping, self-verified templates, ignore status
-- =============================================================================
-- Context: 172 of 609 ingests failed with "Account not found" because the LLM
-- fallback invented account names instead of resolving real ones, and because a
-- deterministic parser returning NULL for "this is a declined purchase" was
-- indistinguishable from "I don't understand this format" — so the LLM overrode
-- correct rejections. 49 of ~55 BBVA notifications were "Compra rechazada".
-- =============================================================================

-- --- 1. Card → account mapping -----------------------------------------------
-- Notifications identify the card by its last 4 digits, which is the only
-- reliable account key. Names ("Mastercard Nexo Card ••4186") never matched.
alter table accounts
  add column if not exists card_digits text[] not null default '{}';

comment on column accounts.card_digits is
  'Last-4 digits of every card that charges to this account. Primary key for resolving push notifications to an account.';

-- Seed from the card labels observed in push_raw_log. Names are unique per user.
update accounts set card_digits = '{4186}'  where name = 'Nexo Card'           and card_digits = '{}';
update accounts set card_digits = '{3679}'  where name = 'Rappi'               and card_digits = '{}';
update accounts set card_digits = '{9253}'  where name = 'BBVA Visa'           and card_digits = '{}';
update accounts set card_digits = '{1886}'  where name = 'BBVA Mastercard'     and card_digits = '{}';
-- ••5685 is the debit card drawing on the savings account, not a separate pool.
update accounts set card_digits = '{5685}'  where name = 'Bancolombia Ahorros' and card_digits = '{}';
update accounts set card_digits = '{6928}'  where name = 'Wise Personal'       and card_digits = '{}';

-- --- 2. Ingest log: "ignored" status ------------------------------------------
-- A notification the parser recognized and deliberately did not register
-- (declined purchase, delivery update, promo). Distinct from no_parser, which
-- means "nobody understood this" and is the only case worth escalating to AI.
alter table push_ingest_log drop constraint if exists push_ingest_log_status_check;
alter table push_ingest_log add constraint push_ingest_log_status_check
  check (status = any (array[
    'processing',
    'registered',
    'duplicate',
    'deduped_cross_source',
    'upgraded_cross_source',
    'no_parser',
    'ignored',
    'fx_pending',
    'registration_failed',
    'transfer',
    'pending_cleanup',
    'pending_confirmation',
    'deduped_wallet_echo'
  ]));

-- --- 3. Parser templates: outcome + provenance --------------------------------
-- `is_expense` could not express "recognized, and it is a refund" or
-- "recognized, and it must never be registered", which is where the garbage
-- came from. Provenance columns make the self-verification reproducible.
alter table push_parser_templates
  add column if not exists outcome      text not null default 'expense',
  add column if not exists source_title text,
  add column if not exists source_text  text;

update push_parser_templates set outcome = case when is_expense then 'expense' else 'ignore' end;

alter table push_parser_templates
  drop constraint if exists push_parser_templates_outcome_check;
alter table push_parser_templates
  add constraint push_parser_templates_outcome_check
  check (outcome in ('expense', 'refund', 'ignore'));

alter table push_parser_templates drop column if exists is_expense;

-- Named capture groups are preferred over positional indexes, so the positional
-- columns become optional.
alter table push_parser_templates alter column amount_group drop not null;
alter table push_parser_templates alter column amount_group drop default;

comment on column push_parser_templates.outcome is
  'expense = register (positive), refund = register (negative), ignore = recognized but never registered.';
comment on column push_parser_templates.source_text is
  'The notification text this template was learned from. A template is only stored if re-running it over this text reproduces the extraction.';

-- --- 4. Drop the auto-learned templates ---------------------------------------
-- All 28 existing rows have hit_count = 0 (they never matched anything, because
-- hit_count was never selected before being incremented) and encode invented
-- account names, currency USD on € patterns, and positional group indexes
-- against named-group patterns. None can pass the new self-verification, and
-- keeping them would resurrect the bad extractions.
delete from push_parser_templates;

-- --- 5. Reprocess support -----------------------------------------------------
-- Recovering a failed ingest means re-running the pipeline over the raw log,
-- but the dedup key short-circuits anything already logged. This marks the rows
-- a reprocess run is allowed to overwrite.
alter table push_ingest_log
  add column if not exists reprocessed_at timestamptz;

comment on column push_ingest_log.reprocessed_at is
  'Set when this ingest was re-run from push_raw_log by /api/sync/notifications?force=1.';

create index if not exists idx_push_ingest_log_status on push_ingest_log (user_id, status);
