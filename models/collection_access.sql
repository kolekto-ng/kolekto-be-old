-- Tables for the in-app "grant limited collection access" flow: an owner
-- invites another person (by email, account not required to exist yet) to
-- view specific collections, with two independent visibility toggles
-- (earnings, contributors). OTP to the owner proves initiation intent, then
-- an accept/decline link goes to the invited email. Apply this in Supabase
-- SQL editor / migrations.

create table if not exists public.collection_access_invites (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  to_email text not null,
  can_view_earnings boolean not null default false,
  can_view_contributors boolean not null default false,
  otp_hash text not null,
  otp_expires_at timestamptz not null,
  otp_verified_at timestamptz,
  confirm_token_hash text,
  confirm_expires_at timestamptz,
  status text not null default 'pending', -- pending | accepted | declined | cancelled | expired
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.collection_access_invite_items (
  id uuid primary key default gen_random_uuid(),
  invite_id uuid not null references public.collection_access_invites(id),
  collection_id uuid not null references public.collections(id)
);

create table if not exists public.collection_access_grants (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null references public.collections(id),
  collaborator_user_id uuid not null,
  granted_by_user_id uuid not null,
  can_view_earnings boolean not null default false,
  can_view_contributors boolean not null default false,
  invite_id uuid references public.collection_access_invites(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists collection_access_invites_confirm_token_hash_idx
  on public.collection_access_invites(confirm_token_hash);

create index if not exists collection_access_invite_items_invite_id_idx
  on public.collection_access_invite_items(invite_id);

create index if not exists collection_access_grants_collaborator_idx
  on public.collection_access_grants(collaborator_user_id) where revoked_at is null;

create index if not exists collection_access_grants_collection_idx
  on public.collection_access_grants(collection_id) where revoked_at is null;
