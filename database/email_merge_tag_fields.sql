-- ⚠️ SUPERSEDED / NOW REDUNDANT (kept only for migration-history continuity).
--
-- The merge-tag columns this file adds have been FOLDED INTO the single
-- complete view definition in database/email_recipient_directory.sql. That
-- file is now self-sufficient — applying it alone produces the full view.
--
-- Root cause this split caused: the base file (email_recipient_directory.sql)
-- had a corrupted `create or replace view` header, and this follow-up was the
-- ONLY place the merge columns were defined. When the base file failed to parse
-- or this follow-up was never applied, the deployed view lacked every merge
-- column, so utils/mergeDataResolver.js read `undefined` for
-- first_name/referral_code/earnings/etc. and those tags rendered empty — even
-- though the engine and all render paths were correct. Do NOT re-split.
--
-- Re-running this file is a harmless no-op: it is a `create or replace view`
-- with the identical column set to email_recipient_directory.sql.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- (Original note preserved below.)
-- Extends email_recipient_directory (database/email_recipient_directory.sql)
-- with the fields needed for merge-tag personalization. Apply after that
-- file. Postgres requires CREATE OR REPLACE VIEW to keep existing columns
-- in place — everything below is a straight superset, new columns appended
-- at the end, so every existing consumer (the filter/segment engine) is
-- unaffected.
--
-- Column provenance (verified empirically against the live schema before
-- writing this):
--   - public.profiles: first_name, last_name (in addition to full_name,
--     already selected) — there is NO organization_name/org_name column
--     anywhere in this schema (checked profiles AND collections), so
--     {{organization_name}} is intentionally NOT backed by real data. The
--     merge tag engine still handles it gracefully via its fallback syntax
--     ({{organization_name|My Organization}}) — it just isn't offered in
--     the "real data available" catalog.
--   - public.ambassador_profiles: ambassador_code (the ambassador's OWN
--     shareable code — distinct from profiles.ambassador_referral_code,
--     which is the code of whoever referred THIS person), rank,
--     available_earnings, pending_earnings, total_earnings. Matched by
--     email (unique on ambassador_profiles), same as is_ambassador above.
--   - public.collections + public.wallets: an organizer's total processed
--     amount is the sum of wallets.net_payment across all their collections
--     (collections.user_id = organizer). "Latest collection" fields use the
--     single most-recently-created collection per organizer (a convention,
--     documented in utils/mergeDataResolver.js) since campaigns in this
--     system aren't scoped to one specific collection.

create or replace view public.email_recipient_directory as
select
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
  -- merge-tag fields (new)
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
  'Recipient audience directory for the Email Campaign filter + merge-tag engine. country/state/city/organization_name are not available — no such columns exist in the live schema.';
