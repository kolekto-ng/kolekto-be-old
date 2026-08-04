-- Recipient audience directory for the Email Campaign system.
-- Apply after database/email_campaigns.sql.
--
-- Backs BOTH:
--   1. the segment/filter engine (Phase 3) — the backend queries this view
--      with plain chained supabase-js filters (see utils/recipientFilters.js)
--      instead of a bespoke filter-DSL-to-SQL translator, and
--   2. the merge-tag personalization engine (Phase 2) — utils/mergeDataResolver.js
--      reads the per-recipient columns below to fill {{first_name}}, {{referral_code}},
--      {{available_earnings}}, etc.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- IMPORTANT (root-cause history): this file previously contained ONLY the base
-- 14 filter-engine columns, and its `create or replace view ... as select`
-- header had been clobbered by an accidental keystroke — leaving an orphaned
-- column list that fails to parse. The merge-tag columns (first_name, last_name,
-- ambassador_code, earnings, rank, organizer totals, latest collection) lived
-- in a SEPARATE follow-up migration (email_merge_tag_fields.sql) that had to be
-- applied AFTER this one. When this file failed to parse (or the follow-up was
-- never applied), the deployed view lacked every merge column, so
-- mergeDataResolver.js read `undefined` for first_name/referral_code/earnings/etc.
-- and those tags rendered empty — even though the engine, resolver, and every
-- render path (preview/test/scheduled/bulk) were correct.
--
-- FIX: this file is now the SINGLE, COMPLETE, self-sufficient definition of the
-- view (base filter columns + all merge-tag columns). Applying just this one
-- file produces a fully-working directory. email_merge_tag_fields.sql is now a
-- redundant no-op (identical `create or replace`) kept only for migration-history
-- continuity. Never split these again — the split is what broke personalization.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Column provenance (verified against the live schema — public.profiles has NO
-- country/state/city/organization_name/last_login columns, so those requested
-- filter/merge dimensions are intentionally NOT included here):
--   - public.profiles: id, email, full_name, first_name, last_name,
--     phone_number, is_organizer, referred_by_ambassador_id,
--     ambassador_referral_code (the code of whoever referred THIS person —
--     distinct from the ambassador's OWN ambassador_code below), created_at
--   - auth.users: email_confirmed_at, last_sign_in_at (Supabase Auth's own
--     tracking — there is no separate "last login" column on profiles)
--   - public.ambassador_profiles: ambassador_code (the ambassador's OWN
--     shareable code), rank, available_earnings, pending_earnings,
--     total_earnings. Matched by email (unique on ambassador_profiles).
--   - public.collections + public.wallets: an organizer's total processed
--     amount is the sum of wallets.net_payment across all their collections
--     (collections.user_id = organizer). "Latest collection" fields use the
--     single most-recently-created collection per organizer (a convention,
--     documented in utils/mergeDataResolver.js) since campaigns in this
--     system aren't scoped to one specific collection.
--   - public.contributions: matched by email (contributions aren't tied to a
--     profile id), status = 'paid' for a real contribution.
--
-- NOTE on column order: the merge-tag columns are appended AFTER the original
-- base columns so `create or replace view` succeeds over any pre-existing
-- thin (base-only) view already in the database — Postgres allows appending
-- columns via CREATE OR REPLACE but not reordering/removing them.

create or replace view public.email_recipient_directory as
select
  -- ── Base filter-engine columns ──────────────────────────────────────────
  p.id,
  p.email,
  p.full_name,
  p.phone_number,
  p.is_organizer,
  p.created_at as registered_at,
  (au.email_confirmed_at is not null) as is_email_verified,
  au.last_sign_in_at as last_login_at,
  exists (
    select 1 from public.ambassador_profiles ap where lower(ap.email) = lower(p.email)
  ) as is_ambassador,
  coalesce(cc.collections_count, 0) as collections_count,
  (coalesce(cc.collections_count, 0) > 0) as is_collection_creator,
  exists (
    select 1 from public.contributions co
    where lower(co.email) = lower(p.email) and co.status = 'paid'
  ) as is_contributor,
  (p.referred_by_ambassador_id is not null) as is_referred,
  p.ambassador_referral_code,
  -- ── Merge-tag personalization columns (read by mergeDataResolver.js) ─────
  p.first_name,
  p.last_name,
  amb.ambassador_code,
  amb.rank as ambassador_rank,
  amb.available_earnings as ambassador_available_earnings,
  amb.pending_earnings as ambassador_pending_earnings,
  amb.total_earnings as ambassador_total_earnings,
  coalesce(wp.total_amount_processed, 0) as organizer_total_amount_processed,
  lc.title as latest_collection_title,
  lc.target_amount as latest_collection_target_amount,
  lc.total_contributions as latest_collection_amount_raised,
  lc.status as latest_collection_status
from public.profiles p
left join auth.users au on au.id = p.id
left join (
  select user_id, count(*) as collections_count
  from public.collections
  group by user_id
) cc on cc.user_id = p.id
left join public.ambassador_profiles amb on lower(amb.email) = lower(p.email)
left join lateral (
  select sum(w.net_payment) as total_amount_processed
  from public.collections c
  join public.wallets w on w.collection_id = c.id
  where c.user_id = p.id
) wp on true
left join lateral (
  select c.title, c.target_amount, c.total_contributions, c.status
  from public.collections c
  where c.user_id = p.id
  order by c.created_at desc
  limit 1
) lc on true;

comment on view public.email_recipient_directory is
  'Recipient audience directory for the Email Campaign filter + merge-tag engine. Single complete definition (base filter columns + merge-tag columns). country/state/city/organization_name are not available — no such columns exist in the live schema.';
