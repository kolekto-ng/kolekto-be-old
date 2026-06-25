-- Realtime publication wiring for Kolekto.
--
-- The frontend subscribes to postgres_changes on these tables to update the UI
-- live (no manual refresh): collection list/details, organizer dashboard,
-- contributor list, wallet balance, contribution history, collection status.
-- For those subscriptions to receive anything, each table must be a member of
-- the `supabase_realtime` publication. A production diagnostic showed:
--
--   notifications_realtime  = true   (already wired by database/notifications.sql)
--   collections_realtime    = false  ← fixed here
--   contributions_realtime  = false  ← fixed here
--
-- wallets/withdrawals are included too because the dashboard, transaction
-- history, and collection details pages all subscribe to them for live balances.
--
-- Run this in the Supabase SQL editor. It is idempotent and safe to re-run.

-- ── 1. Publication membership ────────────────────────────────────────────────
-- `alter publication ... add table` errors if the table is already a member,
-- so guard each add against pg_publication_tables.
do $$
declare
    t text;
begin
    foreach t in array array[
        'collections',
        'contributions',
        'wallets',
        'withdrawals'
    ]
    loop
        if not exists (
            select 1 from pg_publication_tables
            where pubname = 'supabase_realtime'
              and schemaname = 'public'
              and tablename = t
        ) and exists (
            select 1 from information_schema.tables
            where table_schema = 'public' and table_name = t
        ) then
            execute format('alter publication supabase_realtime add table public.%I', t);
        end if;
    end loop;
end
$$;

-- ── 2. Replica identity ──────────────────────────────────────────────────────
-- Realtime evaluates RLS against the changed row to decide who may receive the
-- event. For UPDATE/DELETE (and for RLS policies that read non-PK columns —
-- e.g. contributions filtered by their parent collection's owner) the row must
-- carry its full column set, which requires REPLICA IDENTITY FULL. INSERT works
-- without it, but FULL is required for the collection-status (UPDATE) and
-- contributor (which RLS-checks via collection_id) live updates to be delivered.
alter table public.collections   replica identity full;
alter table public.contributions replica identity full;
alter table public.wallets       replica identity full;
-- withdrawals is filtered by user_id (a real column) so default identity is
-- enough, but FULL keeps DELETE events complete and is harmless.
alter table public.withdrawals   replica identity full;

-- ── 3. RLS reminder (verify, do not blindly recreate) ────────────────────────
-- Realtime only delivers an event to a client whose JWT passes the table's
-- SELECT policy for that row. These must already be true for the live UI:
--   • collections   — owner can SELECT own rows (user_id = auth.uid())
--   • contributions — owner can SELECT rows whose collection they own; and the
--                     anon role can SELECT for the PUBLIC /contribute page to
--                     live-update its contributor count/tier availability.
--   • wallets       — owner can SELECT their collection's wallet row.
-- If any of these SELECT policies is missing, realtime stays silent for that
-- table even though it is in the publication. This file deliberately does NOT
-- recreate them, to avoid clobbering working production policies.

-- ── 4. Verification (run after applying) ─────────────────────────────────────
-- Expect all *_realtime columns = true.
-- select
--   exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='collections')   as collections_realtime,
--   exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='contributions') as contributions_realtime,
--   exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='wallets')       as wallets_realtime,
--   exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='withdrawals')   as withdrawals_realtime;
