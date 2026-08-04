-- In-app notification feed for Kolekto.
--
-- Every push notification the backend sends (utils/pushNotifications.js
-- #sendPushToUser) also writes one durable row here so users have an
-- in-app record they can read, mark read, and badge-count — independent of
-- whether the browser push was actually delivered.
--
-- Idempotency: writes are upserted on (user_id, type, dedupe_key). The send
-- path always supplies a stable dedupe_key (falling back to the push tag, or
-- a random UUID for the rare event with neither) so a Paystack webhook retry,
-- a failed-delivery retry sweep, or a double admin click can never create a
-- duplicate in-app notification.
--
-- Run this in the Supabase SQL editor before deploying the backend change.

create table if not exists public.notifications (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    type text not null,
    title text not null,
    body text not null default '',
    url text,
    entity_type text,
    entity_id text,
    data jsonb not null default '{}'::jsonb,
    dedupe_key text not null,
    read_at timestamptz,
    created_at timestamptz not null default now()
);

-- One row per (user, event type, natural key). The send path guarantees a
-- non-null dedupe_key, so a plain (non-partial) unique index is usable as a
-- PostgREST upsert conflict target.
create unique index if not exists notifications_identity_idx
    on public.notifications(user_id, type, dedupe_key);

create index if not exists notifications_user_created_idx
    on public.notifications(user_id, created_at desc);

-- Fast unread-badge count: partial index over only the unread rows.
create index if not exists notifications_user_unread_idx
    on public.notifications(user_id) where read_at is null;

alter table public.notifications enable row level security;

-- Users can read their own notifications.
drop policy if exists "Users can read their own notifications" on public.notifications;
create policy "Users can read their own notifications"
on public.notifications
for select
to authenticated
using ((select auth.uid()) = user_id);

-- Users can mark their own notifications read (update read_at). The WITH CHECK
-- keeps ownership pinned so a row can never be re-pointed at another user.
drop policy if exists "Users can update their own notifications" on public.notifications;
create policy "Users can update their own notifications"
on public.notifications
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

-- The backend service role writes every notification; users never insert.
grant select, insert, update, delete on table public.notifications to service_role;
grant select, update on table public.notifications to authenticated;

-- Realtime: the frontend subscribes to its own rows (filter user_id=eq.<uid>)
-- to update the badge and feed live. Adding an already-present table is an
-- error, so guard it.
do $$
begin
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'notifications'
    ) then
        alter publication supabase_realtime add table public.notifications;
    end if;
end
$$;
