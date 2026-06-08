-- =============================================================================
-- Maquinita — Push Sensor tables (realtime expense ingestion)
-- =============================================================================
-- Tables for the push notification-based expense capture pipeline.
-- Data is written exclusively by the Route Handler using SERVICE ROLE key
-- (bypasses RLS). All new tables have RLS DISABLED.
--
-- Tables created:
--   1. push_raw_log          — every raw payload received (audit/debug)
--   2. push_ingest_log       — processing state per dedup_key
--   3. merchant_category_rules    — merchant → category auto-assignment rules
--   4. transfer_classification_rules — transfer vs expense classification
--
-- Also adds columns to transactions: needs_review, source.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- push_raw_log — permanent log of every push payload received
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.push_raw_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  package_name text NOT NULL,
  payload      jsonb NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.push_raw_log IS
  'Permanent log of every push notification payload received. One row per POST, regardless of processing outcome.';
COMMENT ON COLUMN public.push_raw_log.package_name IS
  'Android package name that generated the notification (e.g. com.todo1.mobile).';
COMMENT ON COLUMN public.push_raw_log.payload IS
  'Complete JSON payload as received from the Android forwarder. No schema enforced at DB level.';
COMMENT ON COLUMN public.push_raw_log.received_at IS
  'Timestamp when the Route Handler received the request.';

ALTER TABLE public.push_raw_log DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_push_raw_log_user_received
  ON public.push_raw_log(user_id, received_at);

-- -----------------------------------------------------------------------------
-- push_ingest_log — processing state tracker, dedup_key as PK
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.push_ingest_log (
  dedup_key         text PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  package_name      text NOT NULL,
  amount_native     numeric(20, 4),
  native_currency   text,
  amount_usd        numeric(20, 4),
  merchant          text,
  status            text NOT NULL DEFAULT 'processing',
  transaction_id    uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  raw_log_id        uuid REFERENCES public.push_raw_log(id) ON DELETE SET NULL,
  related_dedup_key text,
  error_message     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.push_ingest_log IS
  'Ingestion control table. One row per unique push event (dedup_key = PK). Tracks processing state from receipt through transaction registration.';
COMMENT ON COLUMN public.push_ingest_log.dedup_key IS
  'Hash of (packageName + title + text + minute-truncated timestamp). Guarantees uniqueness at DB level.';
COMMENT ON COLUMN public.push_ingest_log.status IS
  'Processing state: processing | registered | duplicate | deduped_cross_source | no_parser | fx_pending | registration_failed | transfer.';
COMMENT ON COLUMN public.push_ingest_log.related_dedup_key IS
  'Reference to the retained dedup_key when this entry was discarded by cross-source dedup.';

ALTER TABLE public.push_ingest_log
  ADD CONSTRAINT chk_ingest_status
  CHECK (status IN (
    'processing', 'registered', 'duplicate',
    'deduped_cross_source', 'no_parser', 'fx_pending',
    'registration_failed', 'transfer'
  ));

ALTER TABLE public.push_ingest_log DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_push_ingest_amount_created
  ON public.push_ingest_log(amount_native, created_at);

CREATE INDEX IF NOT EXISTS idx_push_ingest_status
  ON public.push_ingest_log(status);

-- -----------------------------------------------------------------------------
-- merchant_category_rules — auto-categorization by merchant pattern
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.merchant_category_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pattern     text NOT NULL,
  match_type  text NOT NULL DEFAULT 'ilike',
  category_id uuid NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
  priority    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.merchant_category_rules IS
  'Rules for auto-assigning categories to transactions based on merchant name pattern matching. Higher priority wins.';
COMMENT ON COLUMN public.merchant_category_rules.pattern IS
  'ILIKE or regex pattern to match against merchant name.';
COMMENT ON COLUMN public.merchant_category_rules.match_type IS
  'Pattern matching strategy: ilike | regex.';
COMMENT ON COLUMN public.merchant_category_rules.priority IS
  'Higher value = more specific rule. Highest matching priority wins.';

ALTER TABLE public.merchant_category_rules DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_merchant_rules_user_priority
  ON public.merchant_category_rules(user_id, priority DESC);

-- -----------------------------------------------------------------------------
-- transfer_classification_rules — allowlist/denylist for transfer detection
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.transfer_classification_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pattern     text NOT NULL,
  match_type  text NOT NULL DEFAULT 'ilike',
  list_type   text NOT NULL DEFAULT 'allowlist',
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.transfer_classification_rules IS
  'Rules for classifying movements as transfers (excluded from spend) vs expenses. Allowlist = transfer, denylist = force expense.';
COMMENT ON COLUMN public.transfer_classification_rules.list_type IS
  'Rule type: allowlist (match = transfer/is_payment) | denylist (match = expense).';

ALTER TABLE public.transfer_classification_rules DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_transfer_rules_user
  ON public.transfer_classification_rules(user_id);

-- -----------------------------------------------------------------------------
-- ALTER transactions — add needs_review and source columns
-- -----------------------------------------------------------------------------
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS needs_review boolean NOT NULL DEFAULT false;

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';

COMMENT ON COLUMN public.transactions.needs_review IS
  'True when the system could not auto-categorize. User must review manually.';
COMMENT ON COLUMN public.transactions.source IS
  'Origin of the transaction: manual | push_ingest | email_ingest | mcp.';

CREATE INDEX IF NOT EXISTS idx_transactions_needs_review
  ON public.transactions(needs_review) WHERE needs_review = true;
