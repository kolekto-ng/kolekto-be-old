-- =============================================================================
-- diagnostics_host_visibility_and_aggregates — read-only queries, NOT a migration.
-- =============================================================================
-- For: "admin sees the contributor on a collection, the host (owner) does not"
-- + "tier/ticket/contributor counts on collection detail pages are wrong".
--
-- Run in the Supabase SQL editor. Each block is independent. Start with 1-2 —
-- they tell us whether this is an RLS visibility gap (host's query is blocked
-- by policy) or an aggregate-staleness gap (host sees the row but a cached
-- total/tier-count column is wrong). Those are different bugs with different
-- fixes, and code review alone can't tell which one is live in prod because
-- the actual RLS policy text isn't checked into either repo.
-- =============================================================================


-- 1. Dump the ACTUAL RLS policies on the tables in play. We need the literal
-- `qual` (USING) expression for contributions/wallets/collections SELECT
-- policies — this is not stored in any repo, only in the live DB.
select schemaname, tablename, policyname, roles, cmd, qual, with_check
from pg_policies
where tablename in ('collections', 'contributions', 'wallets', 'deposits')
order by tablename, cmd, policyname;


-- 2. Confirm the real ownership column on collections (code in both repos
-- mostly uses `user_id`, but one legacy form + stale generated types.ts use
-- `organizer_id` — need to know which one actually exists in prod, and
-- whether both do).
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'collections'
  and column_name in ('user_id', 'organizer_id');


-- 3. INCIDENT-SPECIFIC: replace COLLECTION_ID_HERE (and HOST_AUTH_UID_HERE
-- once you have it — run the first half without it if you don't yet) to
-- reproduce the exact "admin sees it, host doesn't" gap for the collection/
-- contributor you observed. host_auth_uid is the collection owner's
-- auth.users.id (look it up via `select id from auth.users where email = '...'`
-- or just read collection_owner_id from this query's own output first).
select
    c.id as contribution_id,
    c.collection_id,
    c.status,
    c.payment_reference,
    c.created_at,
    col.user_id as collection_owner_id,
    (col.user_id = 'HOST_AUTH_UID_HERE') as ownership_matches,
    col.status as collection_status
from public.contributions c
join public.collections col on col.id = c.collection_id
where c.collection_id = 'COLLECTION_ID_HERE'   -- replace with the actual collection UUID
order by c.created_at desc;
-- If `ownership_matches` is false, the host's RLS-bound query will never
-- return this row no matter what the FE does — that's the root cause, and
-- the fix is in the RLS policy or in how the collection's user_id got set,
-- not in any application code.


-- 4. Collections where the cached `total_contributions` column disagrees
-- with the actual count of paid contributions. Confirms/denies the
-- "aggregate staleness" branch of Issue 1 (totals/counts wrong even when the
-- row IS visible).
select
    col.id as collection_id,
    col.title,
    col.total_contributions as cached_total_contributions,
    count(c.id) as actual_paid_count
from public.collections col
left join public.contributions c
       on c.collection_id = col.id and c.status = 'paid'
group by col.id, col.title, col.total_contributions
having col.total_contributions is distinct from count(c.id)
order by abs(coalesce(col.total_contributions, 0) - count(c.id)) desc
limit 100;


-- 5. Tier / ticket-category sold-count mismatch. Compares the persisted
-- `collections.price_tiers[].sold_quantity` snapshot (written only by the
-- edge function's refreshCollectionAndWallets — can silently fail to write,
-- per verify-paystack-payment/index.ts ~line 1514-1519) against a live count
-- grouped by tier name/id from contributor_information. Run per-collection —
-- replace COLLECTION_ID_HERE (appears twice below).
with live_tier_counts as (
    select
        coalesce(
            (c.contributor_information -> 0 ->> 'TierId'),
            (c.contributor_information -> 0 ->> 'Tier')
        ) as tier_key,
        count(*) as live_sold
    from public.contributions c
    where c.collection_id = 'COLLECTION_ID_HERE'
      and c.status = 'paid'
    group by 1
)
select
    tier ->> 'id' as tier_id,
    tier ->> 'name' as tier_name,
    (tier ->> 'sold_quantity')::int as cached_sold_quantity,
    coalesce(ltc.live_sold, 0) as live_sold_quantity
from public.collections col
cross join lateral jsonb_array_elements(col.price_tiers) as tier
left join live_tier_counts ltc
       on ltc.tier_key = (tier ->> 'id') or ltc.tier_key = (tier ->> 'name')
where col.id = 'COLLECTION_ID_HERE';   -- replace with the actual collection UUID


-- 6. Same mismatch as #5, but as a fleet-wide health check across every
-- tiered/ticket collection (no placeholder needed) — flags collections where
-- ANY tier's cached count is off by more than rounding noise.
select
    col.id as collection_id,
    col.title,
    tier ->> 'name' as tier_name,
    (tier ->> 'sold_quantity')::int as cached_sold_quantity,
    (
        select count(*) from public.contributions c
        where c.collection_id = col.id
          and c.status = 'paid'
          and (
              (c.contributor_information -> 0 ->> 'TierId') = (tier ->> 'id')
              or (c.contributor_information -> 0 ->> 'Tier') = (tier ->> 'name')
          )
    ) as live_sold_quantity
from public.collections col
cross join lateral jsonb_array_elements(col.price_tiers) as tier
where jsonb_typeof(col.price_tiers) = 'array'
order by col.id;
-- Rows where cached_sold_quantity <> live_sold_quantity are drifted.


-- 7. Wallet-vs-contributions drift fleet-wide (same as
-- diagnostics_orphaned_payments.sql query 6 — included here too since it's
-- part of the same "host-facing totals wrong" symptom family).
select
    w.collection_id,
    w.net_payment as wallet_net_payment,
    coalesce(sum(c.amount), 0) as actual_net_payment,
    w.net_payment - coalesce(sum(c.amount), 0) as drift
from public.wallets w
left join public.contributions c
       on c.collection_id = w.collection_id and c.status = 'paid'
group by w.collection_id, w.net_payment
having abs(w.net_payment - coalesce(sum(c.amount), 0)) > 0.5
order by abs(w.net_payment - coalesce(sum(c.amount), 0)) desc;
