-- Table used for the in-app "transfer collection ownership" flow (OTP to
-- current owner, then accept/decline link to the recipient, resolved by
-- email). Apply this in Supabase SQL editor / migrations.

create table if not exists public.collection_transfer_requests (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null references public.collections(id),
  from_user_id uuid not null,
  to_email text not null,
  to_user_id uuid not null,
  otp_hash text not null,
  otp_expires_at timestamptz not null,
  otp_verified_at timestamptz,
  confirm_token_hash text,
  confirm_expires_at timestamptz,
  status text not null default 'pending', -- pending | accepted | declined | cancelled | expired
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists collection_transfer_requests_collection_id_idx
  on public.collection_transfer_requests(collection_id);

create index if not exists collection_transfer_requests_confirm_token_hash_idx
  on public.collection_transfer_requests(confirm_token_hash);
