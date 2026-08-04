-- ============================================================================
-- G2 — Atomic withdrawal request (fixes the TOCTOU over-withdrawal race)
--      PHASE 2.0 GUARDRAILS
-- ============================================================================
-- STATUS: OPERATOR-GATED. Applies a Postgres function; the controller change
-- that calls it is delivered separately and flag-gated (default OFF) so nothing
-- changes until BOTH are deployed and the flag is flipped.
--
-- THE BUG (Phase 2 audit §18): withdrawal.requestWithdrawal computes the cap
-- (available_balance − pending withdrawal requests) and THEN inserts, in two
-- separate round-trips. Two concurrent requests can each read the same cap and
-- both pass before either inserts → the collection can be over-withdrawn.
--
-- THE FIX: perform the cap check and the insert in ONE transaction, holding a
-- ROW LOCK on the collection's wallet (SELECT … FOR UPDATE). Concurrent requests
-- for the same collection then serialize: the second waits for the first to
-- commit and re-evaluates the cap against the now-updated pending sum.
--
-- BEHAVIOR PRESERVED: the cap is the SAME quantity the app uses today —
-- wallets.available_balance (the maintained projection) minus the live sum of
-- pending/processing withdrawals. No balance math is reimplemented in SQL; this
-- only makes the existing check atomic.
--
-- ⚠️ BEFORE APPLYING: align the INSERT column list below with the ACTUAL
-- withdrawals schema and with the exact columns controllers/withdrawal.js
-- currently writes (bank/account fields, fees, reference, etc.). The locking and
-- cap logic are the point; the column list is a template.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.request_withdrawal_atomic(
  p_collection_id uuid,
  p_user_id       uuid,
  p_amount        numeric,
  p_details       jsonb DEFAULT '{}'::jsonb
)
RETURNS public.withdrawals
LANGUAGE plpgsql
AS $$
DECLARE
  v_available numeric;
  v_pending   numeric;
  v_row       public.withdrawals;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT' USING ERRCODE = 'P0003';
  END IF;

  -- Lock the collection's wallet row so concurrent withdrawal requests for the
  -- SAME collection serialize. (Reads the most-recently-updated wallet, matching
  -- the app's getCollectionWallet strategy; after G1's uq_wallets_collection_id
  -- there is exactly one.)
  SELECT available_balance
    INTO v_available
    FROM public.wallets
   WHERE collection_id = p_collection_id
   ORDER BY updated_at DESC NULLS LAST
   LIMIT 1
   FOR UPDATE;

  IF v_available IS NULL THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- Live sum of withdrawals already reserved against this collection.
  SELECT COALESCE(SUM(amount), 0)
    INTO v_pending
    FROM public.withdrawals
   WHERE collection_id = p_collection_id
     AND status IN ('pending', 'processing');

  -- Strict cap — identical to the app's rule, now evaluated under the row lock.
  IF p_amount > (v_available - v_pending) THEN
    RAISE EXCEPTION 'INSUFFICIENT_WITHDRAWABLE' USING ERRCODE = 'P0001';
  END IF;

  -- Insert the request. ⚠️ Align these columns with the real schema before use.
  INSERT INTO public.withdrawals (collection_id, user_id, amount, status, created_at)
  VALUES (p_collection_id, p_user_id, p_amount, 'pending', now())
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- ============================================================================
-- Controller integration (deliver as a flag-gated change; default OFF):
--
--   // controllers/withdrawal.js — inside requestWithdrawal, replacing the
--   // read-then-insert with an atomic call when the flag is on:
--   if (process.env.USE_ATOMIC_WITHDRAWAL === 'true') {
--     const { data, error } = await supabase.rpc('request_withdrawal_atomic', {
--       p_collection_id: collectionId, p_user_id: userId, p_amount: withdrawalAmount,
--     });
--     if (error) {
--       // Map SQLSTATE → the SAME HTTP responses the app returns today:
--       //   P0001 INSUFFICIENT_WITHDRAWABLE → 400 (over-cap message)
--       //   P0002 WALLET_NOT_FOUND          → 404
--       //   P0003 INVALID_AMOUNT            → 400
--       ...
--     }
--     // else: use `data` as the created withdrawal row (same shape as before)
--   } else {
--     // ...existing read-then-insert path (unchanged)...
--   }
--
-- Rollout: apply this migration → deploy the flag-gated controller (flag OFF,
-- zero change) → enable USE_ATOMIC_WITHDRAWAL on one instance → soak → 100%.
-- Rollback: set the flag OFF (deploy-free). The function is harmless if unused.
--
-- Concurrency test (after enabling): fire two simultaneous requests that each
-- equal the full withdrawable amount; exactly one must succeed.
-- ============================================================================
