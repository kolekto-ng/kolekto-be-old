-- ============================================================================
-- B-3: Atomic contributor unique-code generation (Option B — Postgres sequence)
-- ============================================================================
--
-- Run this in the Supabase SQL editor BEFORE deploying the matching code
-- change in controllers/deposit.js. After this migration is applied,
-- deposit.js calls `select * from next_contributor_code_number($1)` which
-- atomically increments a per-collection counter and returns the next value.
--
-- The previous app code minted codes with `COUNT(paid contributions) + 1`,
-- which is NOT atomic: two concurrent payment-confirmations would observe
-- the same count and both produce e.g. KLT001 → duplicate codes (and a
-- 23505 unique_violation if a unique constraint exists). This migration
-- replaces that with a Postgres-level atomic UPDATE … RETURNING which is
-- single-statement atomic by definition.
--
-- This migration is IDEMPOTENT — re-running it is safe.
-- ============================================================================

-- 1. Per-collection counter column.
ALTER TABLE public.collections
    ADD COLUMN IF NOT EXISTS next_contributor_number bigint NOT NULL DEFAULT 0;

-- 2. Backfill: set each collection's counter to the current paid count.
--    This ensures the FIRST atomic call after migration returns a value
--    greater than every existing code, with no overlap.
--    Safe to re-run: it always overwrites with the live paid count.
UPDATE public.collections c
   SET next_contributor_number = COALESCE(sub.cnt, 0)
  FROM (
      SELECT collection_id, COUNT(*)::bigint AS cnt
        FROM public.contributions
       WHERE status = 'paid'
       GROUP BY collection_id
  ) sub
 WHERE c.id = sub.collection_id;

-- 3. Atomic increment-and-return function.
--    LANGUAGE sql with a single UPDATE … RETURNING is the simplest atomic
--    pattern in Postgres — Postgres holds the row lock for the duration
--    of the UPDATE, so concurrent callers serialise and each gets a
--    distinct value.
CREATE OR REPLACE FUNCTION public.next_contributor_code_number(
    p_collection_id uuid
)
RETURNS bigint
LANGUAGE sql
AS $$
    UPDATE public.collections
       SET next_contributor_number = COALESCE(next_contributor_number, 0) + 1,
           updated_at = NOW()
     WHERE id = p_collection_id
 RETURNING next_contributor_number;
$$;

-- 4. Grant execute to anon/authenticated so PostgREST can expose it as an
--    RPC for the Supabase JS client. Adjust roles to match your project.
GRANT EXECUTE ON FUNCTION public.next_contributor_code_number(uuid)
    TO anon, authenticated, service_role;

-- 5. (Optional but recommended) Prevent duplicate codes from sneaking in
--    via legacy paths by adding a unique partial index. Only enforced when
--    contributor_unique_code is non-null. Comment this out if any
--    historical duplicates exist that you intend to preserve.
-- CREATE UNIQUE INDEX IF NOT EXISTS uq_contributions_unique_code
--     ON public.contributions (collection_id, contributor_unique_code)
--     WHERE contributor_unique_code IS NOT NULL;

-- ============================================================================
-- Smoke test (run after applying):
--   SELECT public.next_contributor_code_number('<some-collection-uuid>');
-- Should return monotonically increasing values per call.
-- ============================================================================
