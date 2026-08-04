-- Table used for the in-app "change email" flow (OTP to current email,
-- then confirmation link to the new email). Apply this in Supabase SQL
-- editor / migrations.

create table if not exists public.email_change_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  new_email text not null,
  otp_hash text not null,
  otp_expires_at timestamptz not null,
  otp_verified_at timestamptz,
  confirm_token_hash text,
  confirm_expires_at timestamptz,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists email_change_requests_user_id_idx
  on public.email_change_requests(user_id);

create index if not exists email_change_requests_confirm_token_hash_idx
  on public.email_change_requests(confirm_token_hash);
