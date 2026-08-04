-- Kolekto Ambassador Program schema.
-- Apply in Supabase SQL editor or your migration pipeline before production rollout.

create extension if not exists pgcrypto;

create table if not exists public.ambassador_applications (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text not null unique,
  phone_number text not null,
  state text not null,
  city text not null,
  school_organization text not null,
  social_links text,
  community_size integer,
  leadership_experience text,
  motivation text not null,
  promotion_plan text not null,
  previous_experience text,
  status text not null default 'pending' check (status in ('pending', 'interview_scheduled', 'accepted', 'rejected', 'suspended')),
  interview_date timestamptz,
  admin_notes text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ambassador_applications_status_idx on public.ambassador_applications(status);
create index if not exists ambassador_applications_created_at_idx on public.ambassador_applications(created_at desc);

create table if not exists public.ambassador_profiles (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null unique references public.ambassador_applications(id) on delete cascade,
  full_name text not null,
  email text not null unique,
  phone_number text,
  state text,
  city text,
  school_organization text,
  ambassador_code text not null unique,
  pin_hash text,
  pin_set_at timestamptz,
  status text not null default 'accepted' check (status in ('accepted', 'suspended')),
  rank text not null default 'Ambassador',
  total_organizers_influenced integer not null default 0,
  total_collections_influenced integer not null default 0,
  total_processed_amount_internal numeric(14,2) not null default 0,
  total_earnings numeric(14,2) not null default 0,
  pending_earnings numeric(14,2) not null default 0,
  available_earnings numeric(14,2) not null default 0,
  weekly_activity_streak integer not null default 0,
  student_impact_events integer not null default 0,
  charity_collection_amount_internal numeric(14,2) not null default 0,
  new_communities_opened integer not null default 0,
  activated_at timestamptz not null default now(),
  last_active_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ambassador_profiles
  add column if not exists pin_hash text,
  add column if not exists pin_set_at timestamptz,
  add column if not exists last_login_at timestamptz;

create index if not exists ambassador_profiles_code_idx on public.ambassador_profiles(ambassador_code);
create index if not exists ambassador_profiles_status_idx on public.ambassador_profiles(status);

alter table public.ambassador_profiles
  drop constraint if exists ambassador_profiles_code_format_chk;

alter table public.ambassador_profiles
  add constraint ambassador_profiles_code_format_chk
  check (ambassador_code ~ '^[A-Z]{6}$');

create table if not exists public.ambassador_influenced_organizers (
  id uuid primary key default gen_random_uuid(),
  ambassador_id uuid not null references public.ambassador_profiles(id) on delete cascade,
  organizer_id uuid,
  organizer_name text,
  organizer_email text,
  processed_amount_internal numeric(14,2) not null default 0,
  largest_collection_amount_internal numeric(14,2) not null default 0,
  collections_influenced integer not null default 0,
  reward_paid numeric(14,2) not null default 0,
  status text not null default 'active' check (status in ('active', 'inactive')),
  first_influenced_at timestamptz not null default now(),
  last_activity_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ambassador_influenced_organizers_ambassador_idx on public.ambassador_influenced_organizers(ambassador_id);
create index if not exists ambassador_influenced_organizers_organizer_idx on public.ambassador_influenced_organizers(organizer_id);
create unique index if not exists ambassador_influenced_organizers_organizer_unique_idx
  on public.ambassador_influenced_organizers(organizer_id)
  where organizer_id is not null;

alter table public.profiles
  add column if not exists referred_by_ambassador_id uuid references public.ambassador_profiles(id),
  add column if not exists ambassador_referral_code text;

create index if not exists profiles_referred_by_ambassador_idx on public.profiles(referred_by_ambassador_id);

create table if not exists public.ambassador_payout_accounts (
  id uuid primary key default gen_random_uuid(),
  ambassador_id uuid not null references public.ambassador_profiles(id) on delete cascade,
  bank_name text,
  bank_code text,
  account_name text,
  account_last4 text,
  account_number_cipher text,
  is_default boolean not null default false,
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ambassador_payout_accounts_ambassador_idx on public.ambassador_payout_accounts(ambassador_id);

create table if not exists public.ambassador_withdrawals (
  id uuid primary key default gen_random_uuid(),
  ambassador_id uuid not null references public.ambassador_profiles(id) on delete cascade,
  payout_account_id uuid references public.ambassador_payout_accounts(id),
  amount numeric(14,2) not null default 0,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'paid')),
  admin_notes text,
  requested_at timestamptz not null default now(),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ambassador_withdrawals_ambassador_idx on public.ambassador_withdrawals(ambassador_id);
create index if not exists ambassador_withdrawals_status_idx on public.ambassador_withdrawals(status);

create table if not exists public.ambassador_resources (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  category text not null default 'training',
  file_url text,
  external_url text,
  is_active boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.ambassador_resources (title, description, category, external_url, sort_order)
values
  ('Ambassador Handbook', 'Core onboarding guide for Kolekto Ambassadors.', 'handbook', null, 10),
  ('Brand Guidelines', 'Approved Kolekto messaging, logo usage, and community standards.', 'brand', null, 20),
  ('Campus Activation Checklist', 'A practical checklist for launching Kolekto in a campus or community.', 'training', null, 30),
  ('Social Media Starter Pack', 'Caption prompts and campaign ideas for community awareness.', 'marketing', null, 40)
on conflict do nothing;

insert into storage.buckets (id, name, public, file_size_limit)
values ('ambassador-resources', 'ambassador-resources', true, 15728640)
on conflict (id) do update
set public = true,
    file_size_limit = 15728640;

-- Future referral infrastructure hook:
-- When organizer referral attribution ships, update ambassador_influenced_organizers
-- from organizer/collection/payment events and recalculate profile counters nightly.
