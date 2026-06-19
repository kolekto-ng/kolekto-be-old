-- Push notification subscriptions and delivery dedupe for Kolekto PWA.
-- Run this in Supabase SQL editor before enabling push in production.

create table if not exists public.push_subscriptions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    endpoint text not null unique,
    p256dh text not null,
    auth_secret text not null,
    expiration_time bigint,
    user_agent text,
    platform text,
    device_label text,
    last_seen_at timestamptz default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists push_subscriptions_user_id_idx on public.push_subscriptions(user_id);

alter table public.push_subscriptions enable row level security;

drop policy if exists "Users can manage their own push subscriptions" on public.push_subscriptions;
create policy "Users can manage their own push subscriptions"
on public.push_subscriptions
for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create table if not exists public.push_notification_events (
    id uuid primary key default gen_random_uuid(),
    user_id uuid references auth.users(id) on delete cascade,
    event_type text not null,
    dedupe_key text not null unique,
    created_at timestamptz not null default now()
);

create index if not exists push_notification_events_user_id_idx on public.push_notification_events(user_id);
create index if not exists push_notification_events_event_type_idx on public.push_notification_events(event_type);

alter table public.push_notification_events enable row level security;

drop policy if exists "Users can read their own push notification events" on public.push_notification_events;
create policy "Users can read their own push notification events"
on public.push_notification_events
for select
to authenticated
using ((select auth.uid()) = user_id);

grant select, insert, update, delete on table public.push_subscriptions to service_role;
grant select, insert on table public.push_notification_events to service_role;
