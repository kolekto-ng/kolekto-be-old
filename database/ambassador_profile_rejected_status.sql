-- Allows 'rejected' as an ambassador_profiles.status value.
-- Needed because an ambassador can be rejected AFTER a profile already
-- exists (e.g. a previously-accepted ambassador is rejected on
-- reconsideration) — rejectAmbassadorApplication now syncs the profile
-- status to 'rejected' so verifyAmbassador/ambassadorSignIn correctly deny
-- access instead of leaving the profile stuck at 'accepted'.
-- Apply in Supabase SQL editor or your migration pipeline (see ambassador_program.sql).

alter table public.ambassador_profiles drop constraint if exists ambassador_profiles_status_check;
alter table public.ambassador_profiles add constraint ambassador_profiles_status_check
  check (status in ('accepted', 'suspended', 'rejected'));
