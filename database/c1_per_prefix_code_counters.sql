-- ============================================================================
-- C-1: Atomic PER-PREFIX contributor unique-code counters
-- ============================================================================
--
-- Why this exists: the B-3 migration (b3_contributor_code_sequence.sql)
-- added one atomic counter PER COLLECTION (`collections.next_contributor_number`).
-- That's correct for collections with a single code_prefix, but the actual
-- live code-generation path (supabase/functions/verify-paystack-payment)
-- assigns a DIFFERENT prefix per pricing tier / ticket tier ("Fix #7:
-- Per-prefix sequential IDs"), and was never wired to call the B-3 RPC at
-- all — it computed each sequence number from an in-memory COUNT taken at
-- the start of the request. Two payments to the same collection/prefix
-- arriving concurrently could both read the same count and mint the exact
-- same code (e.g. two contributors both getting "REG-005").
--
-- This migration adds a counter keyed by (collection_id, prefix) instead of
-- just collection_id, with the same atomic UPDATE/INSERT...RETURNING
-- pattern, so every prefix in every collection gets its own race-free
-- sequence — including collections with multiple tier prefixes.
--
-- This migration is IDEMPOTENT — re-running it is safe. It does not modify
-- or remove the B-3 table/column/function; that one is left in place
-- (harmless if unused) so nothing that may still reference it breaks.
-- ============================================================================

-- 1. Per-(collection, prefix) counter table.
CREATE TABLE IF NOT EXISTS public.contribution_code_counters (
    collection_id uuid NOT NULL REFERENCES public.collections(id) ON DELETE CASCADE,
    prefix text NOT NULL,
    next_number bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (collection_id, prefix)
);

-- 2. Backfill: seed each (collection, prefix) counter from the highest
--    existing numeric suffix already used for that prefix, so the FIRST
--    atomic call after migration returns a value greater than every
--    existing code for that prefix — no overlap, no duplicates.
--    Tolerates both "PREFIX-001" (current) and legacy "PREFIX001" codes.
--    Safe to re-run: only raises a counter, via the GREATEST() guard,
--    never lowers one that's already ahead of the historical max.
INSERT INTO public.contribution_code_counters (collection_id, prefix, next_number)
SELECT
    sub.collection_id,
    sub.prefix,
    max(sub.num) AS next_number
FROM (
    SELECT
        collection_id,
        upper((regexp_match(contributor_unique_code, '^([A-Za-z]+)-?(\d+)$'))[1]) AS prefix,
        (regexp_match(contributor_unique_code, '^([A-Za-z]+)-?(\d+)$'))[2]::bigint AS num
    FROM public.contributions
    WHERE status = 'paid'
      AND contributor_unique_code IS NOT NULL
) sub
WHERE sub.prefix IS NOT NULL
GROUP BY sub.collection_id, sub.prefix
ON CONFLICT (collection_id, prefix) DO UPDATE
    SET next_number = GREATEST(contribution_code_counters.next_number, EXCLUDED.next_number);

-- 3. Atomic increment-and-return function, keyed by (collection_id, prefix).
--    Single INSERT ... ON CONFLICT DO UPDATE ... RETURNING is atomic by
--    definition — Postgres serialises concurrent callers on the same row.
CREATE OR REPLACE FUNCTION public.next_contribution_code_number(
    p_collection_id uuid,
    p_prefix text
)
RETURNS bigint
LANGUAGE sql
AS $$
    INSERT INTO public.contribution_code_counters (collection_id, prefix, next_number, updated_at)
    VALUES (p_collection_id, upper(p_prefix), 1, now())
    ON CONFLICT (collection_id, prefix) DO UPDATE
        SET next_number = contribution_code_counters.next_number + 1,
            updated_at = now()
    RETURNING next_number;
$$;

GRANT EXECUTE ON FUNCTION public.next_contribution_code_number(uuid, text)
    TO anon, authenticated, service_role;

-- 4. Hard database-level guarantee on top of the atomic RPC: reject any
--    duplicate (collection_id, contributor_unique_code) pair outright,
--    regardless of which code path tries to write it (a future bug, an
--    out-of-band script, a manual SQL edit, etc).
--
--    Verified clean before enabling this (2026-06-24): a duplicate check
--    across the whole contributions table —
--
--      SELECT collection_id, contributor_unique_code, count(*)
--        FROM public.contributions
--       WHERE contributor_unique_code IS NOT NULL
--       GROUP BY 1, 2
--      HAVING count(*) > 1;
--
--    — returned zero rows (121 codes, 121 unique pairs) after the Round 3
--    backfill. Safe to enable.
CREATE UNIQUE INDEX IF NOT EXISTS uq_contributions_unique_code
    ON public.contributions (collection_id, contributor_unique_code)
    WHERE contributor_unique_code IS NOT NULL;

-- ============================================================================
-- Smoke test (run after applying):
--   SELECT public.next_contribution_code_number('<some-collection-uuid>', 'REG');
--   SELECT public.next_contribution_code_number('<some-collection-uuid>', 'REG');
-- Should return two distinct, increasing values for the same prefix, and
-- an independent sequence starting near 1 for a different prefix on the
-- same collection.
-- ============================================================================
