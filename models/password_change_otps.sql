-- Table used for in-app "change password" OTP flow.
-- Apply this in Supabase SQL editor / migrations.

create table if not exists public.password_change_otps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  otp_hash text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists password_change_otps_user_id_idx
  on public.password_change_otps(user_id);

create index if not exists password_change_otps_expires_at_idx
  on public.password_change_otps(expires_at);

