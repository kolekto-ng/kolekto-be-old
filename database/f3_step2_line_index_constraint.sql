-- ============================================================================
-- F3 STEP 2 — re-backfill + add unique constraint on (collection_id,
--             payment_reference, line_index).
-- ============================================================================
--
-- Prerequisite: f3_step1_line_index_column.sql AND the edge function update
-- that populates line_index per unit have both been deployed.
--
-- This step:
--   1. Re-backfills line_index for any rows that landed AFTER step 1 was
--      applied but BEFORE the edge function deploy. Those rows would have
--      line_index = 0 (the column default), so a multi-ticket order would
--      have duplicate (collection_id, payment_reference, 0) — which the
--      new unique index below would reject. Re-backfilling collapses them
--      to 0,1,2,... before the constraint is added.
--   2. Creates the unique partial index. Only enforced for rows with a
--      payment_reference (excludes legacy pending rows with NULL reference).
--
-- Effect after deploy:
--   - Two concurrent `verify-paystack-payment` calls for the same Paystack
--     reference will each try to insert (collection, ref, 0). One will win;
--     the other will get a 23505 unique_violation. The F2 duplicate handler
--     in the edge function catches this and recovers the existing rows.
--   - End result: exactly N rows per N-unit payment, no duplicates, no
--     missing units, regardless of how many concurrent calls arrive.
--
-- This migration is IDEMPOTENT — re-running it is safe.
-- ============================================================================

-- 1. Defensive re-backfill (in case anything sneaked in with default-0
--    during the deploy window between step 1 and the edge-function update).
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
  ) sub
 WHERE c.id = sub.id
   AND c.line_index <> sub.rn - 1;

-- 2. Verify no duplicates remain BEFORE creating the constraint. If this
--    SELECT returns any rows, the CREATE UNIQUE INDEX below would fail.
--    Re-run the backfill step above and investigate; do not force-create
--    the index while duplicates exist.
DO $$
DECLARE
  dup_count integer;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT collection_id, payment_reference, line_index, COUNT(*)
      FROM public.contributions
     WHERE payment_reference IS NOT NULL
     GROUP BY collection_id, payment_reference, line_index
    HAVING COUNT(*) > 1
  ) dups;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'Cannot add unique index: % duplicate (collection_id, payment_reference, line_index) groups remain. Re-run the backfill and inspect.', dup_count;
  END IF;
END $$;

-- 3. Create the unique partial index. Partial (WHERE payment_reference IS
--    NOT NULL) so we don't accidentally constrain legacy unpaid rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_contributions_collection_ref_line
    ON public.contributions (collection_id, payment_reference, line_index)
    WHERE payment_reference IS NOT NULL;

-- ============================================================================
-- Smoke test (run after applying):
--
--   -- Attempt a deliberate duplicate insert. Should fail with 23505.
--   INSERT INTO public.contributions (collection_id, payment_reference, line_index, name, email, amount, status)
--     SELECT collection_id, payment_reference, line_index, 'TEST', 'test@example.com', 1, 'pending'
--       FROM public.contributions
--      WHERE payment_reference IS NOT NULL
--      LIMIT 1;
--   -- Expected: ERROR 23505 duplicate key violates unique constraint
--   --          "uq_contributions_collection_ref_line"
-- ============================================================================
