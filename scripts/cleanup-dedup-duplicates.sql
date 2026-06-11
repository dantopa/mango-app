-- =============================================================================
-- CLEANUP DEDUP DUPLICATES (ONE-OFF)
-- =============================================================================
-- ⚠️  MANUAL REVIEW REQUIRED — DO NOT RUN AUTOMATICALLY
--
-- Purpose: Remove the two known duplicate transactions caused by:
--   Bug 1: Push pipeline didn't check `transactions` table (PERGAMINO)
--   Bug 2: No cross-currency dedup (COYO TAC COP vs USD)
--
-- Context (from cross-source-dedup spec, Req 5.4):
--   After deploying the unified resolveDuplicate() logic, these historical
--   duplicates remain in the database. This script removes the "worse" version
--   of each pair, keeping one transaction per physical purchase.
--
-- How to use:
--   1. Run the DRY-RUN SELECTs first (Step 1) to verify matches
--   2. Review that EXACTLY the expected rows are identified
--   3. Run the full script (Step 2) in a transaction
--   4. Verify with Step 3 queries
--   5. If anything looks wrong, ROLLBACK (the transaction protects you)
--
-- Date: 2025 (after cross-source-dedup deployment)
-- Author: Automated cleanup for known bugs
-- =============================================================================


-- =============================================================================
-- STEP 1: DRY-RUN — Identify the duplicates (SELECT only, safe to run anytime)
-- =============================================================================

-- Bug 1: PERGAMINO — two rows for the same COP 7500 purchase
-- Keep: sync_bancolombia version (richer description: "COMPRA EN PERGAMINO VIVA ENVIG")
-- Delete: push_ingest version (shorter description: "PERGAMINO VIVA ENVIGAD")
SELECT
  id,
  source,
  description_raw,
  amount_native,
  native_currency,
  tx_date,
  created_at,
  merchant,
  '*** BUG 1 — PERGAMINO duplicate (push_ingest to DELETE) ***' AS action
FROM public.transactions
WHERE source = 'push_ingest'
  AND amount_native = 7500
  AND native_currency = 'COP'
  AND description_raw ILIKE '%PERGAMINO%'
ORDER BY created_at;

-- The one we KEEP (for reference / verification):
SELECT
  id,
  source,
  description_raw,
  amount_native,
  native_currency,
  tx_date,
  created_at,
  merchant,
  '*** BUG 1 — PERGAMINO keeper (sync_bancolombia) ***' AS action
FROM public.transactions
WHERE source = 'sync_bancolombia'
  AND amount_native = 7500
  AND native_currency = 'COP'
  AND description_raw ILIKE '%PERGAMINO%'
ORDER BY created_at;


-- Bug 2: COYO TAC — same purchase in COP (POS amount) and USD (settlement)
-- Keep: COP 63400 version (ground-truth POS amount per Req 5.1)
-- Delete: USD 17.70 version (settlement currency from BBVA)
SELECT
  id,
  source,
  description_raw,
  amount_native,
  native_currency,
  amount_usd,
  tx_date,
  created_at,
  merchant,
  card_last4,
  '*** BUG 2 — COYO TAC duplicate (USD settlement to DELETE) ***' AS action
FROM public.transactions
WHERE description_raw ILIKE '%COYO TAC%'
  AND native_currency = 'USD'
ORDER BY created_at;

-- The one we KEEP (for reference / verification):
SELECT
  id,
  source,
  description_raw,
  amount_native,
  native_currency,
  amount_usd,
  tx_date,
  created_at,
  merchant,
  card_last4,
  '*** BUG 2 — COYO TAC keeper (COP POS amount) ***' AS action
FROM public.transactions
WHERE description_raw ILIKE '%COYO TAC%'
  AND native_currency = 'COP'
  AND amount_native = 63400
ORDER BY created_at;


-- =============================================================================
-- STEP 2: ACTUAL CLEANUP — Run inside a transaction
-- =============================================================================
-- ⚠️  Review Step 1 output FIRST. Only proceed if exactly 1 row matches each
--     DELETE condition below.

BEGIN;

-- Safety check: abort if we'd delete more than expected
DO $$
DECLARE
  pergamino_count INTEGER;
  coyo_tac_count INTEGER;
BEGIN
  -- Count PERGAMINO duplicates to delete
  SELECT COUNT(*) INTO pergamino_count
  FROM public.transactions
  WHERE source = 'push_ingest'
    AND amount_native = 7500
    AND native_currency = 'COP'
    AND description_raw ILIKE '%PERGAMINO%';

  IF pergamino_count != 1 THEN
    RAISE EXCEPTION
      'SAFETY ABORT: Expected exactly 1 PERGAMINO push_ingest duplicate, found %. '
      'Review manually before proceeding.', pergamino_count;
  END IF;

  -- Count COYO TAC duplicates to delete
  SELECT COUNT(*) INTO coyo_tac_count
  FROM public.transactions
  WHERE description_raw ILIKE '%COYO TAC%'
    AND native_currency = 'USD';

  IF coyo_tac_count != 1 THEN
    RAISE EXCEPTION
      'SAFETY ABORT: Expected exactly 1 COYO TAC USD duplicate, found %. '
      'Review manually before proceeding.', coyo_tac_count;
  END IF;

  RAISE NOTICE 'Safety checks passed: PERGAMINO=%, COYO_TAC=%', pergamino_count, coyo_tac_count;
END $$;


-- DELETE Bug 1: PERGAMINO push_ingest duplicate
-- Criteria: source=push_ingest AND amount=7500 COP AND merchant contains PERGAMINO
-- Rationale: sync_bancolombia version has richer description and was the original insert
DELETE FROM public.transactions
WHERE source = 'push_ingest'
  AND amount_native = 7500
  AND native_currency = 'COP'
  AND description_raw ILIKE '%PERGAMINO%';


-- DELETE Bug 2: COYO TAC USD settlement duplicate
-- Criteria: description contains "COYO TAC" AND currency=USD
-- Rationale: COP is the ground-truth POS amount (Req 5.1); USD is the bank settlement
--            with FX spread baked in. The engine converts COP→USD with the day's rate.
DELETE FROM public.transactions
WHERE description_raw ILIKE '%COYO TAC%'
  AND native_currency = 'USD';


-- Log what was done
DO $$
BEGIN
  RAISE NOTICE '✅ Cleanup complete:';
  RAISE NOTICE '   - Deleted PERGAMINO push_ingest duplicate (COP 7500)';
  RAISE NOTICE '   - Deleted COYO TAC USD settlement duplicate (17.70 USD)';
  RAISE NOTICE '   Net result: 1 transaction per physical purchase (Req 5.4)';
END $$;


-- =============================================================================
-- STEP 3: VERIFICATION — Confirm the cleanup worked
-- =============================================================================

-- Should return exactly 1 row for PERGAMINO (the sync_bancolombia version)
SELECT
  id, source, description_raw, amount_native, native_currency, tx_date,
  'Should be exactly 1 row (sync_bancolombia)' AS expected
FROM public.transactions
WHERE (description_raw ILIKE '%PERGAMINO%')
  AND amount_native = 7500
  AND native_currency = 'COP';

-- Should return exactly 1 row for COYO TAC (the COP version)
SELECT
  id, source, description_raw, amount_native, native_currency, amount_usd, tx_date,
  'Should be exactly 1 row (COP 63400)' AS expected
FROM public.transactions
WHERE description_raw ILIKE '%COYO TAC%';

-- Final sanity: no transaction should have both COP and USD versions
-- of the same purchase anymore
SELECT
  description_raw, native_currency, COUNT(*) AS cnt
FROM public.transactions
WHERE description_raw ILIKE '%COYO TAC%'
   OR description_raw ILIKE '%PERGAMINO%'
GROUP BY description_raw, native_currency
HAVING COUNT(*) > 1;
-- ^ This should return 0 rows


COMMIT;

-- =============================================================================
-- If anything went wrong, run this instead of COMMIT:
--   ROLLBACK;
-- =============================================================================
