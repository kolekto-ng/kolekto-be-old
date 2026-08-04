-- ============================================================================
-- H2 — Atomic contributor-code allocation
-- ============================================================================
-- STATUS: applied to TEST (lpeeckqsltxohppheucz) only. NOT applied to
-- production. This file is the version-controlled record of that change —
-- apply to production only after a full TEST soak and explicit approval.
--
-- THE BUG this closes (see KOLEKTO_CONTRIBUTOR_ID_ATOMICITY_INVESTIGATION.md
-- and KOLEKTO_CONTRIBUTOR_CODE_NUMBERING_DIAGNOSTIC.md for the full forensic
-- trail): `next_contribution_code_number` was called, and committed, in its
-- own standalone statement from the edge function BEFORE the corresponding
-- `contributions` row was inserted — true on both the pre-H1 default path
-- and the H1 `claim_payment_contributions` atomic path (H1 made idempotency
-- + capacity + insert atomic, but received the contributor code as a
-- pre-minted, caller-supplied input; its atomicity never covered the mint
-- step). Any failure between mint and insert — a rejected capacity check, a
-- lost duplicate-request race, a trigger abort, a data-validation error, an
-- infinitely-retried permanently-broken payment reference — permanently
-- burned the number. Confirmed in production: one stuck reference retried
-- every 5 minutes for 11+ days burned 3,247+ numbers with zero corresponding
-- contributions (collection "Busybrain Night Of Majesty", prefix BBN: 34
-- real contributions, counter at 3,361).
--
-- THE FIX: `claim_payment_contributions` now allocates the contributor code
-- itself, per row, immediately before that row's own INSERT, inside the
-- exact same transaction as everything else the function already does
-- (idempotency check, capacity check, insert). The edge function no longer
-- computes or supplies `contributor_unique_code` at all — it only resolves
-- and passes a `prefix` per row (unchanged resolution logic: unit-level tier
-- prefix, falling back to the collection's code_prefix). This is a full
-- cutover of the p_rows JSON contract, not a dual-format transition — both
-- call sites (this function and the edge function) are changed together.
--
-- WHY THIS IS SAFE UNDER ROLLBACK: the counter increment
-- (`INSERT INTO contribution_code_counters ... ON CONFLICT DO UPDATE ...
-- RETURNING`) now executes as one of several statements inside this
-- function's single transaction, per row, in a loop, immediately followed by
-- that row's own `INSERT INTO contributions`. The function's existing
-- top-level `EXCEPTION WHEN unique_violation` block wraps the ENTIRE
-- function body (an implicit PL/pgSQL subtransaction/savepoint established
-- at function entry) — so a unique_violation on ANY row's insert rolls back
-- every counter increment and every insert already performed earlier in
-- THIS SAME call, not just the failing row. Any OTHER exception (a trigger
-- raising — enforce_max_contributions, trg_ambassador_payment_attribution,
-- or any future trigger — a constraint violation, anything) is NOT caught by
-- this function at all (no WHEN OTHERS clause, matching the pre-existing
-- design) and propagates out, aborting the entire enclosing transaction the
-- RPC call runs in — which necessarily also undoes every counter increment
-- made during this call. Either way: allocate-and-insert now succeed or fail
-- together, for the whole call, with no code ever left permanently spent on
-- an outcome that didn't happen.
--
-- WHAT DID NOT CHANGE: locking strategy (still the same `SELECT ... FOR
-- UPDATE` on `collections`, still sufficient — the new counter increment is
-- a strict subset of what that lock already serializes); idempotency check
-- ordering (still first, before any capacity or allocation work); capacity
-- check logic (byte-for-byte identical — collection-wide then per-tier);
-- `contribution_code_counters` table shape and seeded values (untouched —
-- historical codes are fully preserved and unaffected); both existing
-- unique constraints (`(collection_id, contributor_unique_code)` and
-- `(collection_id, payment_reference, line_index)`, kept as the correctness
-- backstop); `next_contribution_code_number` itself (kept, unmodified, in
-- the schema — see the retirement note below).
--
-- RETIREMENT OF `next_contribution_code_number` FROM THE LIVE PAYMENT PATH:
-- after this migration and the matching edge-function change, no live
-- payment-verification path calls this RPC anymore. It is NOT dropped here
-- — `kolekto-be-old/scripts/backfillUniqueContributionCodes.js` (an
-- operator-invoked, offline script, not part of live traffic) still calls it
-- directly and continues to work unmodified. Do not delete this function
-- until that script is also migrated or retired in a separate, explicit
-- change.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.claim_payment_contributions(
  p_collection_id uuid,
  p_payment_reference text,
  p_rows jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_existing          jsonb;
  v_price_tiers       jsonb;
  v_max_contributions integer;
  v_paid_count        integer;
  v_row               jsonb;
  v_tier_id           text;
  v_tier_name         text;
  v_tier_qty          integer;
  v_tier_key          text;
  v_claims            jsonb := '{}'::jsonb;
  v_demand            integer;
  v_tier_sold         integer;
  v_tier_capacity     integer;
  -- H2: inline contributor-code allocation state.
  v_prefix            text;
  v_next_number       bigint;
  v_code              text;
  v_info              jsonb;
BEGIN
  IF p_rows IS NULL OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'NO_ROWS_SUPPLIED' USING ERRCODE = 'P0004';
  END IF;

  -- Lock the collection row so every verify call for THIS collection
  -- serializes. Released automatically when this function call's implicit
  -- transaction ends (a single RPC invocation = one transaction). This same
  -- lock is what makes the new inline counter increment below safe — no
  -- second lock is required, since per-prefix allocation for this collection
  -- is a strict subset of what's already fully serialized here.
  SELECT price_tiers, max_contributions
    INTO v_price_tiers, v_max_contributions
    FROM public.collections
   WHERE id = p_collection_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'COLLECTION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- ── Authoritative idempotency check — INSIDE the lock, BEFORE any
  -- allocation work — unchanged from H1. A duplicate verification of an
  -- already-successful reference returns immediately: no capacity math, no
  -- counter touched, no insert.
  SELECT jsonb_agg(to_jsonb(c) ORDER BY c.line_index)
    INTO v_existing
    FROM public.contributions c
   WHERE c.collection_id = p_collection_id
     AND c.payment_reference = p_payment_reference;

  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'idempotent', 'contributions', v_existing);
  END IF;

  -- ── Live, locked capacity re-check — unchanged from H1. Collection-wide
  -- cap first, then per-tier. If capacity is rejected here, execution
  -- returns before the allocation loop below is ever reached — no counter
  -- touched.
  SELECT COUNT(*) INTO v_paid_count
    FROM public.contributions
   WHERE collection_id = p_collection_id AND status = 'paid';

  IF v_max_contributions IS NOT NULL AND v_max_contributions > 0
     AND (v_paid_count + jsonb_array_length(p_rows)) > v_max_contributions THEN
    RETURN jsonb_build_object('outcome', 'capacity_exceeded', 'collection_full', true,
                              'failed_tier_id', null, 'failed_tier_name', null);
  END IF;

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

  -- ── H2: capacity confirmed under lock — allocate + insert, ONE ROW AT A
  -- TIME, so each row's contributor code is minted from the correct
  -- (collection, prefix) counter immediately before THAT row's own insert,
  -- inside this same transaction/lock. `prefix` is caller-supplied (the
  -- edge function's existing unit/tier → collection-prefix resolution,
  -- unchanged); `contributor_unique_code` is NEVER accepted as input — this
  -- function is now the sole place a code is ever produced.
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    v_prefix := NULLIF(upper(regexp_replace(COALESCE(v_row->>'prefix', ''), '\s+', '', 'g')), '');
    v_code := NULL;

    IF v_prefix IS NOT NULL THEN
      -- Same atomic INSERT...ON CONFLICT DO UPDATE...RETURNING pattern the
      -- standalone next_contribution_code_number RPC has always used — now
      -- executed HERE, inside this function's own transaction, instead of
      -- as a separate, independently-committed call from the edge function.
      INSERT INTO public.contribution_code_counters (collection_id, prefix, next_number, updated_at)
      VALUES (p_collection_id, v_prefix, 1, now())
      ON CONFLICT (collection_id, prefix) DO UPDATE
          SET next_number = contribution_code_counters.next_number + 1,
              updated_at = now()
      RETURNING next_number INTO v_next_number;

      v_code := v_prefix || '-' || lpad(v_next_number::text, 3, '0');
    END IF;

    -- Embed the freshly-minted code into the row's own receipt payload —
    -- the edge function can no longer set this client-side since it no
    -- longer knows the code at build time.
    --
    -- jsonb_set's create_missing only creates the FINAL path segment; every
    -- earlier segment must already exist or the call silently no-ops (not an
    -- error). In live traffic the edge function always pre-populates a full
    -- _receipt object (with unique_code left null), so {0,_receipt,unique_code}
    -- already has its parent — but this must not depend on that caller
    -- convention. Set/merge the WHOLE _receipt object in one step instead, so
    -- the only required-to-exist parent is index 0 itself (guaranteed above).
    v_info := COALESCE(v_row->'contributor_information', '[]'::jsonb);
    IF jsonb_typeof(v_info) IS DISTINCT FROM 'array' OR jsonb_array_length(v_info) = 0 THEN
      v_info := '[{}]'::jsonb;
    END IF;
    v_info := jsonb_set(
      v_info,
      '{0,_receipt}',
      COALESCE(v_info->0->'_receipt', '{}'::jsonb) || jsonb_build_object('unique_code', to_jsonb(v_code)),
      true
    );

    INSERT INTO public.contributions (
      collection_id, name, email, phone, amount, gross_amount, status,
      payment_reference, contributor_unique_code, contributor_information,
      line_index, check_in_status
    )
    VALUES (
      p_collection_id,
      v_row->>'name', v_row->>'email', NULLIF(v_row->>'phone', ''),
      (v_row->>'amount')::numeric, (v_row->>'gross_amount')::numeric, 'paid',
      p_payment_reference,
      v_code,
      v_info,
      (v_row->>'line_index')::int,
      COALESCE(NULLIF(v_row->>'check_in_status', ''), 'not_checked_in')
    );
  END LOOP;

  SELECT jsonb_agg(to_jsonb(c) ORDER BY c.line_index)
    INTO v_existing
    FROM public.contributions c
   WHERE c.collection_id = p_collection_id
     AND c.payment_reference = p_payment_reference;

  RETURN jsonb_build_object('outcome', 'inserted', 'contributions', v_existing);

EXCEPTION
  -- Unchanged from H1: catches a genuine concurrent-duplicate-insert race
  -- (two calls for the same reference both passed the idempotency check
  -- above before either committed). Because this EXCEPTION clause wraps the
  -- ENTIRE function body, PL/pgSQL's implicit savepoint-per-block means
  -- hitting this handler rolls back EVERYTHING done since function entry —
  -- every counter increment and every insert already performed earlier in
  -- THIS call's loop, not just the row that collided. The caller's whole
  -- attempt is discarded as one unit and the concurrent winner's committed
  -- rows are returned instead. No number from the losing attempt survives.
  --
  -- Any OTHER exception (a trigger raising, a non-unique constraint
  -- violation, anything) is deliberately NOT caught here — it propagates out
  -- and aborts the entire enclosing transaction, which equally undoes every
  -- counter increment made during this call.
  WHEN unique_violation THEN
    SELECT jsonb_agg(to_jsonb(c) ORDER BY c.line_index)
      INTO v_existing
      FROM public.contributions c
     WHERE c.collection_id = p_collection_id
       AND c.payment_reference = p_payment_reference;
    RETURN jsonb_build_object('outcome', 'idempotent', 'contributions', COALESCE(v_existing, '[]'::jsonb), 'note', 'unique_violation_recovered');
END;
$$;

-- Privileges are unchanged by CREATE OR REPLACE on the same signature, but
-- restated defensively (idempotent, matches this file's own prior
-- convention) since Supabase auto-grants EXECUTE to anon/authenticated on
-- newly created functions in `public` regardless of a PUBLIC-only revoke.
REVOKE EXECUTE ON FUNCTION public.claim_payment_contributions(uuid, text, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.claim_payment_contributions(uuid, text, jsonb) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_payment_contributions(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_payment_contributions(uuid, text, jsonb) TO service_role;
