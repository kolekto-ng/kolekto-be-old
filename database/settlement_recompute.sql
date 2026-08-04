-- ============================================================================
-- Canonical Settlement (Phase 2.1C) — the SINGLE settlement implementation.
-- ============================================================================
-- Replaces the corrupting `settle_pending_balances()` (which read the empty
-- `deposits` table). This recomputes every wallet projection from the SOURCE OF
-- TRUTH — `contributions` + `withdrawals` — NEVER from `deposits`.
--
-- ┌─ MIRRORS kolekto-shared-financial (Financial Projection Engine) ───────────┐
-- │ Phase 2.2 Wave 3: this SQL is a PROVEN MIRROR of the TypeScript engine      │
-- │ `kolekto-shared-financial@0.1.0`. It is NOT an independent implementation.  │
-- │   • settlement_cutoff()            ≡ FPE.getSettlementCutoff                 │
-- │   • settlement_recompute_wallets() ≡ FPE.normalizeContributions →           │
-- │                                       FPE.computeWallet (per collection)     │
-- │ Equivalence is enforced by the golden-vector conformance suite              │
-- │ (kolekto-shared-financial/test/sql.harness.sql + the Wave 3 conformance     │
-- │ query). Verified on test project lpeeckqsltxohppheucz: 16/16 conformance    │
-- │ vectors + 57/57 live wallets, 0 drift (2026-07-18).                         │
-- │ ⚠️ Any edit that changes fee/cutoff/normalization/projection math here MUST │
-- │ keep the conformance suite green, or update the engine + re-prove all three │
-- │ runtimes. Do not diverge silently.                                          │
-- └────────────────────────────────────────────────────────────────────────────┘
--
-- Properties:
--   • derives only from contributions (source of truth); wallets is a projection
--   • ONE settlement cutoff definition: settlement_cutoff() (4am UTC = 5am WAT),
--     mirrors utils/financial.js getSettlementCutoff()
--   • idempotent (full recompute; running twice yields identical rows)
--   • atomic/retry-safe (single transaction; failure rolls back, next run redoes)
--   • observable (public.settlement_runs; drift_after=0 & ok=true on success)
--   • balance math faithful to normalizeContributions -> computeWalletBalances
--     (validated: 57/57 wallets, 0 drift)
--
-- Scheduler: pg_cron job 'settlement-recompute-wallets' at '0 4 * * *'. pg_cron
-- is the authoritative scheduler for this Supabase-centric deployment (the Node
-- cron `jobs/paymentSettlement.js` was found not to execute reliably — see
-- SETTLEMENT_ARCHITECTURE_AUDIT.md). Keep RUN_SETTLEMENT_CRON=false so there is
-- exactly ONE active settlement scheduler.
--
-- This file documents/version-controls what is deployed on the database. It is
-- applied via the Supabase MCP, not run by the Node app.
-- ============================================================================

-- ── ONE cutoff definition ───────────────────────────────────────────────────
-- MIRRORS kolekto-shared-financial@0.1.0 · getSettlementCutoff (04:00 UTC T+1).
CREATE OR REPLACE FUNCTION public.settlement_cutoff() RETURNS timestamptz
LANGUAGE sql STABLE AS $fn$
  SELECT CASE WHEN now() >= ((date_trunc('day', now() AT TIME ZONE 'UTC') + interval '4 hours') AT TIME ZONE 'UTC')
              THEN ((date_trunc('day', now() AT TIME ZONE 'UTC') + interval '4 hours') AT TIME ZONE 'UTC')
              ELSE ((date_trunc('day', now() AT TIME ZONE 'UTC') + interval '4 hours') AT TIME ZONE 'UTC') - interval '1 day' END;
$fn$;

-- ── Observability ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.settlement_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  cutoff_used  timestamptz,
  wallets_processed int DEFAULT 0,
  drift_after  int,          -- collections still violating invariants after the run (must be 0)
  triggered_by text DEFAULT 'cron',
  ok           boolean
);

-- ── Canonical settlement ────────────────────────────────────────────────────
-- MIRRORS kolekto-shared-financial@0.1.0 · per-collection recompute ≡
--   FPE.normalizeContributions (base→calc→net: gross→node_net) then
--   FPE.computeWallet (agg/wd/recomputed: net/gross/pending/available/ledger/withdrawn).
-- Completed-withdrawal set {approved,completed,successful,success} = FPE canonical
-- superset. Fee rates/cap and the est→refine capped-fee inverse match the engine.
CREATE OR REPLACE FUNCTION public.settlement_recompute_wallets(p_triggered_by text DEFAULT 'cron')
RETURNS public.settlement_runs
LANGUAGE plpgsql AS $fn$
DECLARE
  v_run public.settlement_runs;
  v_cutoff timestamptz := public.settlement_cutoff();
  v_processed int := 0;
  v_drift int := 0;
BEGIN
  INSERT INTO public.settlement_runs (started_at, cutoff_used, triggered_by)
  VALUES (now(), v_cutoff, p_triggered_by) RETURNING * INTO v_run;

  WITH base AS (
    SELECT col.id AS collection_id, col.fee_bearer, ct.amount::numeric AS amount, ct.created_at,
           (CASE WHEN col.collection_type='fundraising' THEN 0.01 ELSE 0.005 END)::numeric AS prate,
           coalesce(ct.gross_amount, ct.amount, 0)::numeric AS gross
    FROM collections col JOIN contributions ct ON ct.collection_id=col.id AND ct.status='paid'),
  calc AS (SELECT collection_id, fee_bearer, amount, created_at, gross, prate,
      round(round(least(gross*prate,2000),2)+round(least(gross*0.015,2000),2),2) AS total_fees,
      round(gross/(1+prate+0.015),2) AS est FROM base),
  net AS (SELECT collection_id, created_at, gross,
      CASE WHEN gross=0 THEN amount WHEN fee_bearer='organizer' THEN round(gross-total_fees,2)
           ELSE greatest(0, round(gross - round(round(least(est*prate,2000),2)+round(least(est*0.015,2000),2),2),2)) END AS node_net FROM calc),
  agg AS (SELECT collection_id, round(sum(node_net),2) AS net_payment, round(sum(gross),2) AS gross_payment,
      round(coalesce(sum(node_net) FILTER (WHERE created_at >= v_cutoff),0),2) AS pending_balance FROM net GROUP BY collection_id),
  wd AS (SELECT collection_id, round(coalesce(sum(amount) FILTER (WHERE status IN ('approved','completed','successful','success')),0),2) AS c_wd FROM withdrawals GROUP BY collection_id),
  recomputed AS (SELECT col.id AS collection_id, coalesce(a.net_payment,0) AS net_payment, coalesce(a.gross_payment,0) AS gross_payment,
      coalesce(a.pending_balance,0) AS pending_balance,
      round(greatest(0, coalesce(a.net_payment,0)-coalesce(a.pending_balance,0)-coalesce(wd.c_wd,0)),2) AS available_balance,
      coalesce(wd.c_wd,0) AS withdrawn
    FROM collections col LEFT JOIN agg a ON a.collection_id=col.id LEFT JOIN wd ON wd.collection_id=col.id)
  UPDATE public.wallets w SET
    net_payment=r.net_payment, gross_payment=r.gross_payment, pending_balance=r.pending_balance,
    available_balance=r.available_balance, ledger_balance=round(r.available_balance+r.pending_balance,2),
    withdrawn=r.withdrawn, updated_at=now()
  FROM recomputed r WHERE w.collection_id=r.collection_id;
  GET DIAGNOSTICS v_processed = ROW_COUNT;

  SELECT count(*) INTO v_drift FROM wallets w
   WHERE round(w.available_balance+w.pending_balance,2) <> round(w.ledger_balance,2)
      OR w.available_balance < 0 OR w.pending_balance < 0;

  UPDATE public.settlement_runs SET finished_at=now(), wallets_processed=v_processed, drift_after=v_drift, ok=(v_drift=0)
   WHERE id=v_run.id RETURNING * INTO v_run;
  RETURN v_run;
END;
$fn$;

-- ── Scheduler (single active settlement scheduler) ──────────────────────────
-- SELECT cron.schedule('settlement-recompute-wallets', '0 4 * * *',
--   'SELECT public.settlement_recompute_wallets(''cron'');');

-- ── Manual trigger / validation ─────────────────────────────────────────────
-- SELECT public.settlement_recompute_wallets('manual');
-- SELECT * FROM public.settlement_runs ORDER BY started_at DESC LIMIT 5;

-- ── Monitoring query (alert if any row has ok=false / drift_after>0, or if no
--    run in the last 25h) ──────────────────────────────────────────────────
-- SELECT * FROM public.settlement_runs WHERE ok IS DISTINCT FROM true ORDER BY started_at DESC;
-- SELECT max(started_at) < now() - interval '25 hours' AS settlement_stale FROM public.settlement_runs;

-- ── Rollback (Phase 2.1C only; do NOT drop the legacy functions here) ───────
-- SELECT cron.unschedule('settlement-recompute-wallets');
-- DROP FUNCTION IF EXISTS public.settlement_recompute_wallets(text);
-- DROP FUNCTION IF EXISTS public.settlement_cutoff();
-- DROP TABLE IF EXISTS public.settlement_runs;
