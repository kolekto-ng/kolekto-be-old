-- ============================================================================
-- G1 — Structural financial idempotency guards  (PHASE 2.0 GUARDRAILS)
-- ============================================================================
-- STATUS: OPERATOR-GATED. Do NOT run blindly. Each block PRE-CHECKS for the
-- duplicates it would reject and RAISES if any exist, so it can never silently
-- break inserts. Resolve reported duplicates first, then re-run.
--
-- Purpose: replace PROCEDURAL duplicate protection (application-side
-- payment_reference lookups) with STRUCTURAL protection (DB constraints), so a
-- future PaymentService refactor cannot reintroduce double payments/records.
--
-- ZERO behavior change when clean: these only reject NEW duplicates that the app
-- already tries hard to prevent. Existing valid rows are untouched.
--
-- NOTE ON CONTRIBUTIONS: contributions are 1:N per payment_reference (one row
-- per ticket line item), keyed by (collection_id, payment_reference, line_index).
-- Structural idempotency for contributions ALREADY EXISTS via
--   uq_contributions_collection_ref_line   (see f3_step2_line_index_constraint.sql)
-- Verify it is live in production (query at the bottom). Do NOT add a plain
-- UNIQUE(payment_reference) on contributions — it would break multi-ticket orders.
-- ============================================================================

-- ── 1. deposits.payment_reference — one deposit per Paystack reference ───────
-- deposit.verifyPayment/handleWebhook already .single() on this; a duplicate
-- would currently throw at read time. Make it structurally impossible.
DO $$
DECLARE dup_count integer;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT payment_reference FROM public.deposits
     WHERE payment_reference IS NOT NULL
     GROUP BY payment_reference HAVING COUNT(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'G1: % duplicate deposits.payment_reference group(s) exist. Resolve before adding the unique index.', dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_deposits_payment_reference
    ON public.deposits (payment_reference)
    WHERE payment_reference IS NOT NULL;

-- ── 2. wallets.collection_id — exactly one wallet per collection ─────────────
-- Today the code tolerates MULTIPLE wallet rows per collection (it reads the
-- most-recently-updated one). That is latent drift. This index enforces one
-- wallet per collection. REQUIRES de-duplication first — the pre-check will
-- refuse to proceed while duplicates exist (it does NOT auto-merge, by design;
-- merging balances is a decision, not a migration).
DO $$
DECLARE dup_count integer;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT collection_id FROM public.wallets
     WHERE collection_id IS NOT NULL
     GROUP BY collection_id HAVING COUNT(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'G1: % collection(s) have multiple wallet rows. De-duplicate (keep newest, verify balances via scripts/reconcileFinancials.js) before adding the unique index.', dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_wallets_collection_id
    ON public.wallets (collection_id)
    WHERE collection_id IS NOT NULL;

-- ============================================================================
-- Verification queries (run to confirm state; read-only):
--
--   -- contributions guard present?
--   SELECT indexname FROM pg_indexes
--    WHERE tablename = 'contributions' AND indexname = 'uq_contributions_collection_ref_line';
--
--   -- any deposits duplicates?
--   SELECT payment_reference, COUNT(*) FROM public.deposits
--    WHERE payment_reference IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1;
--
--   -- any collections with >1 wallet?
--   SELECT collection_id, COUNT(*) FROM public.wallets
--    GROUP BY 1 HAVING COUNT(*) > 1;
-- ============================================================================
