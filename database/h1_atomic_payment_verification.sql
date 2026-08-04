-- ============================================================================
-- H1 — Atomic payment verification (fixes the TOCTOU tier-capacity race)
--      PHASE 2.1 GUARDRAILS
-- ============================================================================
-- STATUS: OPERATOR-GATED. Applies a Postgres function; the edge-function
-- change that calls it is delivered separately and flag-gated
-- (VERIFY_USE_ATOMIC_RPC, default OFF) so nothing changes until BOTH are
-- deployed and the flag is flipped — same rollout shape as G2
-- (g2_atomic_withdrawal_request.sql). This migration is additive only: it
-- creates one new function and (defensively) the missing F3 unique index. It
-- does not alter, delete, or backfill any existing financial row.
--
-- THE BUG (incident: kolekto-1784556863591-704214): verify-paystack-payment
-- checks "does a contribution already exist for this reference?" ONCE, at the
-- top of the request (index.ts ~line 303), then — only if that check missed —
-- computes tier capacity from a SEPARATE, unlocked SELECT of all paid rows
-- (`paidRows`) taken moments later, and hard-throws `tier_sold_out` /
-- `insufficient_ticket_capacity` / `collection_full` (_shared1.ts lines
-- 1147-1148, 1177-1183, 1202-1203, 1262-1263, 1272-1273) directly from that
-- snapshot, BEFORE the insert / BEFORE the existing DB unique-constraint
-- recovery path (index.ts ~line 634) ever gets a chance to run.
--
-- Two concurrent verify calls for the SAME reference: Request A completes and
-- commits its contribution (consuming the tier's last slot) while Request B
-- is still mid-flight. B's own idempotency check (at the top of ITS request)
-- ran before A committed, so it correctly saw nothing yet. But B's LATER
-- tier-capacity check reads a FRESH paidRows snapshot that now includes A's
-- committed row — so B is told the tier is sold out, when the true answer is
-- "you (this exact reference) already succeeded." Nothing re-checks
-- idempotency between the early miss and the capacity throw.
--
-- Two DIFFERENT references genuinely racing for the last slot: there is today
-- NO atomic protection at all — both can read the same stale remainingCapacity
-- and both pass, because "sold" is derived by re-scanning
-- contributions.contributor_information in application code with no lock.
-- (uq_contributions_collection_ref_line only dedupes the SAME reference; it
-- does nothing for two different references.)
--
-- THE FIX: perform (a) the idempotency check, (b) the live tier/collection
-- capacity check, and (c) the insert, in ONE transaction, holding a ROW LOCK
-- on the collection (SELECT … FOR UPDATE) — identical locking strategy to
-- G2's request_withdrawal_atomic. Concurrent calls for the SAME collection
-- serialize: the loser re-evaluates against the now-committed state, so a
-- duplicate call for an already-successful reference finds its own rows FIRST
-- (before any capacity math runs) and a duplicate call for a genuinely
-- different reference gets an authoritative, fresh capacity read.
--
-- BEHAVIOR PRESERVED: this does not reimplement fee calculation, minimum-
-- amount checks, ticket-selection parsing, or any non-concurrency validation
-- — those stay exactly as they are today in normalizePaymentRequest. This
-- function only makes the idempotency + capacity DECISION atomic; the caller
-- still builds the exact same row payloads it builds today.
-- ============================================================================

-- 1. Defensive: ensure the F3 Step 2 constraint this function's insert path
--    relies on as a last line of defense is actually present. (Verified
--    2026-07-21: present on prod, MISSING on test — pure deploy drift, zero
--    existing duplicates on test, safe to add.) No-op if already applied.
DO $$
DECLARE dup_count integer;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT collection_id, payment_reference, line_index, COUNT(*)
      FROM public.contributions
     WHERE payment_reference IS NOT NULL
     GROUP BY collection_id, payment_reference, line_index
    HAVING COUNT(*) > 1
  ) dups;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'H1: % duplicate (collection_id, payment_reference, line_index) groups exist — resolve before this migration can proceed.', dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_contributions_collection_ref_line
    ON public.contributions (collection_id, payment_reference, line_index)
    WHERE payment_reference IS NOT NULL;

-- 2. Atomic verify-and-claim function.
--
--    p_rows is a JSON array of fully-formed row payloads (the edge function
--    builds these exactly as it does today — fees, contributor_information,
--    unique codes, etc. all unchanged). Each element additionally carries:
--      tier_id        (text, nullable)  — matches contributor_information.TierId
--      tier_name      (text, nullable)  — matches contributor_information.Tier
--      tier_quantity  (int, default 1)  — units this row claims from that tier
--
--    Returns jsonb:
--      { outcome: 'idempotent',        contributions: [...] }
--      { outcome: 'inserted',          contributions: [...] }
--      { outcome: 'capacity_exceeded', collection_full: bool,
--        failed_tier_id: text|null, failed_tier_name: text|null }
CREATE OR REPLACE FUNCTION public.claim_payment_contributions(
  p_collection_id uuid,
  p_payment_reference text,
  p_rows jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_existing         jsonb;
  v_price_tiers      jsonb;
  v_max_contributions integer;
  v_paid_count       integer;
  v_row              jsonb;
  v_tier_id          text;
  v_tier_name        text;
  v_tier_qty         integer;
  v_tier_key         text;
  v_claims           jsonb := '{}'::jsonb;
  v_demand           integer;
  v_tier_sold        integer;
  v_tier_capacity    integer;
BEGIN
  IF p_rows IS NULL OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'NO_ROWS_SUPPLIED' USING ERRCODE = 'P0004';
  END IF;

  -- Lock the collection row so every verify call for THIS collection
  -- serializes. Released automatically when this function call's implicit
  -- transaction ends (a single RPC invocation = one transaction).
  SELECT price_tiers, max_contributions
    INTO v_price_tiers, v_max_contributions
    FROM public.collections
   WHERE id = p_collection_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'COLLECTION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- ── Authoritative idempotency check — INSIDE the lock ─────────────────────
  -- If this exact reference already has recorded contributions, this is a
  -- duplicate verification of an ALREADY-SUCCESSFUL payment. Return them
  -- as-is: no capacity math, no insert, no repeated financial effect. This is
  -- the direct fix for the incident — a same-reference re-verify can no
  -- longer fall through to a capacity check at all.
  SELECT jsonb_agg(to_jsonb(c) ORDER BY c.line_index)
    INTO v_existing
    FROM public.contributions c
   WHERE c.collection_id = p_collection_id
     AND c.payment_reference = p_payment_reference;

  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'idempotent', 'contributions', v_existing);
  END IF;

  -- ── Live, locked capacity re-check (not the caller's earlier snapshot) ────
  -- Collection-wide cap (max_contributions), same semantics as
  -- remainingContributionCapacity in _shared1.ts.
  SELECT COUNT(*) INTO v_paid_count
    FROM public.contributions
   WHERE collection_id = p_collection_id AND status = 'paid';

  IF v_max_contributions IS NOT NULL AND v_max_contributions > 0
     AND (v_paid_count + jsonb_array_length(p_rows)) > v_max_contributions THEN
    RETURN jsonb_build_object('outcome', 'capacity_exceeded', 'collection_full', true,
                              'failed_tier_id', null, 'failed_tier_name', null);
  END IF;

  -- Per-tier cap. A single order can claim multiple tiers (multi-ticket
  -- orders) — aggregate this order's demand per tier first, then check each
  -- against a FRESH sold count, matched the same way buildTierAvailability
  -- matches in the edge function: TierId first, else Tier name; Quantity
  -- defaults to 1.
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    v_tier_id := NULLIF(v_row->>'tier_id', '');
    v_tier_name := NULLIF(v_row->>'tier_name', '');
    v_tier_qty := COALESCE((v_row->>'tier_quantity')::int, 1);
    v_tier_key := COALESCE(v_tier_id, v_tier_name);
    IF v_tier_key IS NOT NULL THEN
      v_claims := jsonb_set(
        v_claims, ARRAY[v_tier_key],
        to_jsonb(COALESCE((v_claims->>v_tier_key)::int, 0) + v_tier_qty)
      );
    END IF;
  END LOOP;

  FOR v_tier_key, v_demand IN SELECT key, value::int FROM jsonb_each_text(v_claims)
  LOOP
    SELECT COALESCE(SUM(COALESCE((info->>'Quantity')::int, 1)), 0)
      INTO v_tier_sold
      FROM public.contributions c, LATERAL jsonb_array_elements(c.contributor_information) AS info
     WHERE c.collection_id = p_collection_id
       AND c.status = 'paid'
       AND (
            (NULLIF(info->>'TierId', '') IS NOT NULL AND info->>'TierId' = v_tier_key)
         OR (NULLIF(info->>'TierId', '') IS NULL AND info->>'Tier' = v_tier_key)
       );

    SELECT (t->>'quantity')::int
      INTO v_tier_capacity
      FROM jsonb_array_elements(COALESCE(v_price_tiers, '[]'::jsonb)) AS t
     WHERE (t->>'id') = v_tier_key OR (t->>'name') = v_tier_key
     LIMIT 1;

    IF v_tier_capacity IS NOT NULL AND (v_tier_sold + v_demand) > v_tier_capacity THEN
      RETURN jsonb_build_object(
        'outcome', 'capacity_exceeded', 'collection_full', false,
        'failed_tier_id', v_tier_key, 'failed_tier_name', v_tier_key
      );
    END IF;
  END LOOP;

  -- ── Capacity confirmed under lock — insert now ─────────────────────────────
  INSERT INTO public.contributions (
    collection_id, name, email, phone, amount, gross_amount, status,
    payment_reference, contributor_unique_code, contributor_information,
    line_index, check_in_status
  )
  SELECT
    p_collection_id,
    r->>'name', r->>'email', NULLIF(r->>'phone', ''),
    (r->>'amount')::numeric, (r->>'gross_amount')::numeric, 'paid',
    p_payment_reference,
    NULLIF(r->>'contributor_unique_code', ''),
    COALESCE(r->'contributor_information', '[]'::jsonb),
    (r->>'line_index')::int,
    COALESCE(NULLIF(r->>'check_in_status', ''), 'not_checked_in')
  FROM jsonb_array_elements(p_rows) AS r;

  SELECT jsonb_agg(to_jsonb(c) ORDER BY c.line_index)
    INTO v_existing
    FROM public.contributions c
   WHERE c.collection_id = p_collection_id
     AND c.payment_reference = p_payment_reference;

  RETURN jsonb_build_object('outcome', 'inserted', 'contributions', v_existing);

EXCEPTION
  -- Defensive depth: should be unreachable given the row lock above, but if
  -- the unique index ever catches a genuine race anyway, resolve it exactly
  -- like the edge function's existing F2 handler does — re-fetch and return
  -- as idempotent, never surface a raw constraint error.
  WHEN unique_violation THEN
    SELECT jsonb_agg(to_jsonb(c) ORDER BY c.line_index)
      INTO v_existing
      FROM public.contributions c
     WHERE c.collection_id = p_collection_id
       AND c.payment_reference = p_payment_reference;
    RETURN jsonb_build_object('outcome', 'idempotent', 'contributions', COALESCE(v_existing, '[]'::jsonb), 'note', 'unique_violation_recovered');
END;
$$;

-- service_role only — this function performs financial writes that bypass
-- RLS-equivalent checks; it must never be reachable by anon/authenticated
-- (unlike the unique-code counter RPC, which is a harmless sequence
-- generator). IMPORTANT: "REVOKE ALL ... FROM PUBLIC" alone is NOT enough —
-- Supabase applies schema-level default privileges that auto-grant EXECUTE
-- to anon/authenticated on every newly created function in `public`
-- regardless of a PUBLIC-only revoke (confirmed live on the test project:
-- pg_proc.proacl showed anon/authenticated with EXECUTE even after this exact
-- REVOKE-FROM-PUBLIC line ran). Revoke from anon/authenticated EXPLICITLY,
-- by name, in addition to PUBLIC.
REVOKE EXECUTE ON FUNCTION public.claim_payment_contributions(uuid, text, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.claim_payment_contributions(uuid, text, jsonb) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_payment_contributions(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_payment_contributions(uuid, text, jsonb) TO service_role;

-- ============================================================================
-- Edge-function integration (delivered alongside this migration, flag-gated
-- via VERIFY_USE_ATOMIC_RPC, default OFF until this migration is confirmed
-- applied to the target project):
--
--   if (Deno.env.get("VERIFY_USE_ATOMIC_RPC") === "true") {
--     const { data, error } = await supabase.rpc("claim_payment_contributions", {
--       p_collection_id: collectionId,
--       p_payment_reference: String(transaction.reference),
--       p_rows: rowsWithTierClaims,
--     });
--     // outcome: 'idempotent' | 'inserted' | 'capacity_exceeded'
--   } else {
--     // ...existing read-then-check-then-insert path (unchanged)...
--   }
--
-- Rollout: apply this migration → deploy the flag-gated edge function (flag
-- OFF, zero behavior change) → flip VERIFY_USE_ATOMIC_RPC=true on test → soak
-- → prod.
-- Rollback: set the flag OFF (deploy-free, no migration revert needed — the
-- function is inert if uncalled).
--
-- Concurrency test (after enabling): fire
--   await Promise.all([verify(ref), verify(ref)])
-- for the same reference against a tier with 1 remaining slot. Exactly one
-- contribution must be created; the second call must return 'idempotent',
-- never 'capacity_exceeded'.
-- ============================================================================
