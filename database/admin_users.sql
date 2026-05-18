-- =============================================================================
-- admin_users — DB-backed admin allowlist
-- =============================================================================
-- Replaces the hardcoded ADMIN_EMAILS env var / HARDCODED_ADMIN_EMAILS array.
--
-- Read by:
--   - kolekto-admin-control-panel-1/src/stores/authStore.ts (login gate)
--   - kolekto-be-old/utils/requireAdmin.js (route middleware)
--
-- IMPORTANT — apply this against project: lpeeckqsltxohppheucz
-- Apply via:
--   supabase db push   (CLI, if linked)
--   OR paste into Supabase dashboard → SQL editor
-- =============================================================================

-- Case-insensitive email comparisons. citext makes the unique constraint and
-- lookups behave correctly regardless of case (e.g. Foo@x.com vs foo@x.com).
create extension if not exists citext;

create table if not exists public.admin_users (
    id          uuid primary key default gen_random_uuid(),
    email       citext not null unique,
    role        text not null default 'admin',
    created_at  timestamptz not null default now(),

    -- Audit who granted access. Nullable for the bootstrap row.
    created_by  uuid references auth.users(id) on delete set null,

    constraint admin_users_role_check check (role in ('admin', 'superadmin'))
);

comment on table public.admin_users is
    'DB-backed admin allowlist. Replaces the legacy ADMIN_EMAILS env var. A row here is necessary AND sufficient to log into the admin panel.';

create index if not exists admin_users_email_idx on public.admin_users (email);

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed the existing admin so we don't lock everyone out on cutover.
-- Idempotent — re-running the migration is a no-op.
-- ─────────────────────────────────────────────────────────────────────────────
insert into public.admin_users (email, role)
values ('gazalianfellow@gmail.com', 'superadmin')
on conflict (email) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS — only admins can read/manage the allowlist.
-- ─────────────────────────────────────────────────────────────────────────────
-- We use a SECURITY DEFINER helper so the RLS policy on admin_users itself
-- doesn't recursively query admin_users with anon RLS in effect.
create or replace function public.is_current_user_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
    select exists (
        select 1
        from public.admin_users a
        where a.email = (auth.jwt() ->> 'email')::citext
    );
$$;

revoke all on function public.is_current_user_admin() from public;
grant execute on function public.is_current_user_admin() to anon, authenticated;

alter table public.admin_users enable row level security;
alter table public.admin_users force row level security;

-- Authenticated admin users can read the table (needed for the login gate
-- which queries `select 1 from admin_users where email = ?`).
drop policy if exists admin_users_select on public.admin_users;
create policy admin_users_select on public.admin_users
    for select
    to authenticated
    using (public.is_current_user_admin());

-- Only superadmins can insert/update/delete rows. Promote/demote happens
-- via the admin panel; ad-hoc SQL is the bootstrap path.
drop policy if exists admin_users_insert on public.admin_users;
create policy admin_users_insert on public.admin_users
    for insert
    to authenticated
    with check (
        exists (
            select 1 from public.admin_users a
            where a.email = (auth.jwt() ->> 'email')::citext
              and a.role = 'superadmin'
        )
    );

drop policy if exists admin_users_update on public.admin_users;
create policy admin_users_update on public.admin_users
    for update
    to authenticated
    using (
        exists (
            select 1 from public.admin_users a
            where a.email = (auth.jwt() ->> 'email')::citext
              and a.role = 'superadmin'
        )
    )
    with check (
        exists (
            select 1 from public.admin_users a
            where a.email = (auth.jwt() ->> 'email')::citext
              and a.role = 'superadmin'
        )
    );

drop policy if exists admin_users_delete on public.admin_users;
create policy admin_users_delete on public.admin_users
    for delete
    to authenticated
    using (
        exists (
            select 1 from public.admin_users a
            where a.email = (auth.jwt() ->> 'email')::citext
              and a.role = 'superadmin'
        )
    );

-- The Node backend uses the service role key and bypasses RLS, so
-- requireAdmin queries work without a policy. The policies above gate the
-- admin panel's direct supabase.from('admin_users') queries.

-- ─────────────────────────────────────────────────────────────────────────────
-- Convenience RPC for the admin panel: returns the calling user's admin row
-- (or null), without forcing the FE to pass its own email.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.current_admin_user()
returns table (
    id uuid,
    email citext,
    role text,
    created_at timestamptz
)
language sql
security definer
stable
set search_path = public
as $$
    select a.id, a.email, a.role, a.created_at
    from public.admin_users a
    where a.email = (auth.jwt() ->> 'email')::citext
    limit 1;
$$;

revoke all on function public.current_admin_user() from public;
grant execute on function public.current_admin_user() to authenticated;
