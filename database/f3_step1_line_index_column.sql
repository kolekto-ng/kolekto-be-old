-- ============================================================================
-- F3 STEP 1 — line_index column + backfill (no constraint yet).
-- ============================================================================
--
-- Goal: prepare the contributions table for the unique constraint added in
-- step 2. We need every existing row to have a usable line_index BEFORE the
-- constraint goes live, otherwise CREATE UNIQUE INDEX will fail on legacy
-- duplicates.
--
-- This migration is FULLY BACKWARDS-COMPATIBLE:
--   • Adds the column with a default of 0
--   • Backfills row-numbers grouped by (collection_id, payment_reference)
--     so existing multi-ticket payments get 0,1,2,... instead of all-zero
--   • Does NOT add any constraint yet — old edge function code that inserts
--     without specifying line_index continues to work (uses DEFAULT 0)
--
-- Apply order:
--   1. Run this SQL in Supabase SQL editor.   ← you are here
--   2. Deploy the new edge function (sets line_index per unit).
--   3. Run f3_step2_line_index_constraint.sql (re-backfill + unique index).
--
-- This migration is IDEMPOTENT — re-running it is safe.
-- ============================================================================

-- 1. Add the column. NULL initially so we can detect un-backfilled rows.
ALTER TABLE public.contributions
    ADD COLUMN IF NOT EXISTS line_index integer;

-- 2. Backfill: assign sequential line_index per (collection_id, payment_reference)
--    so multi-line orders (ticket purchases with quantity > 1) get distinct
--    line indices. Single-row payments naturally get line_index = 0.
--
--    ROW_NUMBER starts at 1, so we subtract 1 to make line_index 0-based.
UPDATE public.contributions c
   SET line_index = sub.rn - 1
  FROM (
      SELECT
          id,
          ROW_NUMBER() OVER (
              PARTITION BY collection_id, payment_reference
              ORDER BY created_at NULLS FIRST, id
          ) AS rn
        FROM public.contributions
       WHERE payment_reference IS NOT NULL
         AND line_index IS NULL
  ) sub
 WHERE c.id = sub.id;

-- 3. Catch any remaining NULLs (e.g. rows with payment_reference NULL — legacy
--    pending rows that never had a real payment). Set to 0 so we can later
--    enforce NOT NULL.
UPDATE public.contributions
   SET line_index = 0
 WHERE line_index IS NULL;

-- 4. Make the column required + default to 0 for future inserts.
ALTER TABLE public.contributions
    ALTER COLUMN line_index SET DEFAULT 0;

ALTER TABLE public.contributions
    ALTER COLUMN line_index SET NOT NULL;

-- ============================================================================
-- Smoke test (run after applying):
--
--   SELECT collection_id, payment_reference, COUNT(*), array_agg(line_index ORDER BY line_index)
--     FROM public.contributions
--    WHERE payment_reference IS NOT NULL
--    GROUP BY collection_id, payment_reference
--    HAVING COUNT(*) > 1
--    LIMIT 20;
--
-- For every multi-row group the line_index array should be [0,1,2,...] with
-- no duplicates. If you see duplicates here, DO NOT proceed to step 2 — file
-- a bug.
-- ============================================================================
