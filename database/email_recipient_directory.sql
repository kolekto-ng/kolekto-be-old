-- Recipient-filtering audience view for the Email Campaign system (Phase 3).
-- Apply after database/email_campaigns.sql. Backs the segment/filter engine —
-- the backend queries this view with plain chained supabase-js filters
-- instead of a bespoke filter-DSL-to-SQL translator.
--
-- Column provenance (verified empirically against the live schema before
-- writing this — public.profiles has NO country/state/city/last_login/
-- email_verified columns, so those requested filter dimensions are not
-- available and are intentionally NOT included here):
--   - public.profiles: id, email, full_name, phone_number, is_organizer,
--     referred_by_ambassador_id, ambassador_referral_code, created_at
--   - auth.users: email_confirmed_at, last_sign_in_at (Supabase Auth's own
--     tracking — there is no separate "last login" column on profiles)
--   - public.collections: user_id (organizer FK), used for collection counts
--   - public.contributions: email (contributions aren't tied to a profile
--     id — a contributor is matched by email), status = 'paid' for a real
--     contributionhjdhjfdhjdhjded
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
  p.ambassador_referral_code
from public.profiles p
left join auth.users au on au.id = p.id
left join (
  select user_id, count(*) as collections_count
  from public.collections
  group by user_id
) cc on cc.user_id = p.id;

comment on view public.email_recipient_directory is
  'Recipient audience directory for the Email Campaign filter engine. country/state/city are not available — no such columns exist on public.profiles.';
