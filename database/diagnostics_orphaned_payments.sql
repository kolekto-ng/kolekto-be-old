-- =============================================================================
-- diagnostics_orphaned_payments — read-only queries, NOT a migration.
-- =============================================================================
-- Run these in the Supabase SQL editor whenever "payment shows in Paystack
-- but the contribution never reflected" comes up again. Each block is
-- independent — run whichever one applies, no need to run top-to-bottom.
--
-- Requires payment_recovery_log.sql to already be applied for queries 1-2.
-- =============================================================================


-- 1. Recent reconciliation/verify FAILURES — start here.
-- Shows every post-success verify/reconcile attempt that did NOT result in
-- a recorded contribution, newest first. error_code tells you why
-- (missing_collection_id, collection_not_found, amount_mismatch,
-- contribution_insert_failed, collection_full, tier_sold_out, ...).
select
    reference,
    collection_id,
    error_code,
    error_message,
    metadata_source,
    context,
    created_at
from public.payment_recovery_log
where success = false
order by created_at desc
limit 50;


-- 2. Full history for one specific reference (what every attempt — webhook,
-- FE callback, admin reconcile — decided, in order).
select reference, collection_id, success, error_code, error_message,
       metadata_source, note, context, created_at
from public.payment_recovery_log
where reference = :reference   -- e.g. 'kolekto-1700000000-123456'
order by created_at asc;


-- 3. Orphaned `pending_payment_context` rows — a payment was initiated
-- (collectionId + metadata captured) but no contribution exists for that
-- reference at all. If this returns rows, the payment never made it through
-- verify/webhook/reconcile in ANY form yet.
select
    p.reference,
    p.collection_id,
    p.metadata,
    p.created_at
from public.pending_payment_context p
where not exists (
    select 1 from public.contributions c
    where c.payment_reference = p.reference
)
order by p.created_at desc
limit 50;


-- 4. Direct check: does THIS reference have a contribution row at all?
-- Empty result = the contribution was never created (requirement #1).
select id, collection_id, amount, gross_amount, status,
       payment_reference, line_index, created_at
from public.contributions
where payment_reference = :reference   -- e.g. 'kolekto-1700000000-123456'
order by line_index asc;


-- 5. Wallet-vs-contributions drift check for one collection. If
-- net_payment_from_contributions != wallets.net_payment, the wallet is
-- stale and needs a refresh (re-running verify/reconcile on any reference
-- for that collection recomputes the whole wallet from scratch).
select
    w.collection_id,
    w.net_payment        as wallet_net_payment,
    w.gross_payment       as wallet_gross_payment,
    w.available_balance,
    w.pending_balance,
    (select coalesce(sum(c.amount), 0)
       from public.contributions c
      where c.collection_id = w.collection_id and c.status = 'paid')  as net_payment_from_contributions,
    (select coalesce(sum(coalesce(c.gross_amount, c.amount)), 0)
       from public.contributions c
      where c.collection_id = w.collection_id and c.status = 'paid')  as gross_payment_from_contributions
from public.wallets w
where w.collection_id = :collection_id;   -- replace with the actual collection UUID


-- 6. Find every collection currently drifted (run without a specific ID —
-- useful as a periodic health check, not just incident response).
select
    w.collection_id,
    w.net_payment as wallet_net_payment,
    coalesce(sum(c.amount), 0) as actual_net_payment,
    w.net_payment - coalesce(sum(c.amount), 0) as drift
from public.wallets w
left join public.contributions c
       on c.collection_id = w.collection_id and c.status = 'paid'
group by w.collection_id, w.net_payment
having abs(w.net_payment - coalesce(sum(c.amount), 0)) > 0.5  -- ignore rounding noise
order by abs(w.net_payment - coalesce(sum(c.amount), 0)) desc;


-- 7. Contributions with a NULL or suspicious payment_reference (legacy rows
-- or rows that slipped through without the column populated — these can't
-- be matched by the idempotency check, risking duplicate inserts on retry).
select id, collection_id, amount, status, payment_reference, created_at
from public.contributions
where status = 'paid' and (payment_reference is null or trim(payment_reference) = '')
order by created_at desc
limit 50;


-- 8. Collections that changed status RECENTLY and have payment_recovery_log
-- failures around the same time — the smoking-gun pattern for the
-- "auto-close / admin-close raced a charge" root cause. Requires collections
-- to have an `updated_at` column (most Supabase tables do by default).
select
    l.reference, l.error_code, l.created_at as failed_at,
    col.id as collection_id, col.status, col.updated_at as collection_updated_at
from public.payment_recovery_log l
join public.collections col on col.id = l.collection_id
where l.success = false
  and l.error_code in ('collection_closed', 'collection_paused', 'collection_unavailable')
order by l.created_at desc
limit 50;
-- Note: as of the verify-paystack-payment fix, these error_codes should no
-- longer appear for NEW failures — collection status no longer blocks
-- recording of an already-captured payment. Historical rows here predate
-- the fix and identify which past payments were silently dropped.
