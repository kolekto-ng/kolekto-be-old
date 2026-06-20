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
    dedupe_key text not null,
    created_at timestamptz not null default now()
);

-- A delivery event is a durable log, not just a dedupe marker. Failed and
-- subscription-less events remain retryable; only a successful delivery is
-- permanently suppressed.
alter table public.push_notification_events
    -- Existing dedupe rows came from completed historical attempts. Mark them
    -- sent during migration so deploying this schema does not replay old pushes.
    add column if not exists status text not null default 'sent',
    add column if not exists payload jsonb not null default '{}'::jsonb,
    add column if not exists attempt_count integer not null default 1,
    add column if not exists subscription_count integer not null default 0,
    add column if not exists sent_count integer not null default 0,
    add column if not exists failed_count integer not null default 0,
    add column if not exists removed_count integer not null default 0,
    add column if not exists last_error text,
    add column if not exists last_attempt_at timestamptz not null default now(),
    add column if not exists sent_at timestamptz,
    add column if not exists updated_at timestamptz not null default now();

delete from public.push_notification_events where user_id is null;
alter table public.push_notification_events alter column user_id set not null;

alter table public.push_notification_events
    drop constraint if exists push_notification_events_dedupe_key_key;

create unique index if not exists push_notification_events_identity_idx
    on public.push_notification_events(user_id, event_type, dedupe_key);

create index if not exists push_notification_events_user_id_idx on public.push_notification_events(user_id);
create index if not exists push_notification_events_event_type_idx on public.push_notification_events(event_type);
create index if not exists push_notification_events_retry_idx
    on public.push_notification_events(user_id, status, last_attempt_at);

alter table public.push_notification_events enable row level security;

drop policy if exists "Users can read their own push notification events" on public.push_notification_events;
create policy "Users can read their own push notification events"
on public.push_notification_events
for select
to authenticated
using ((select auth.uid()) = user_id);

grant select, insert, update, delete on table public.push_subscriptions to service_role;
grant select, insert, update on table public.push_notification_events to service_role;

-- Atomically claims a notification event. Concurrent webhook/callback/job
-- paths cannot both send it. Failed/no-subscription events can be retried and
-- a crashed worker's processing lease expires after five minutes.
create or replace function public.claim_push_notification_event(
    p_user_id uuid,
    p_event_type text,
    p_dedupe_key text,
    p_payload jsonb default '{}'::jsonb
)
returns table(event_id uuid, should_send boolean, is_duplicate boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
    claimed_id uuid;
begin
    insert into public.push_notification_events (
        user_id, event_type, dedupe_key, payload, status,
        attempt_count, last_attempt_at, updated_at
    ) values (
        p_user_id, p_event_type, p_dedupe_key, coalesce(p_payload, '{}'::jsonb),
        'processing', 1, now(), now()
    )
    on conflict (user_id, event_type, dedupe_key) do nothing
    returning id into claimed_id;

    if claimed_id is not null then
        return query select claimed_id, true, false;
        return;
    end if;

    update public.push_notification_events
       set status = 'processing',
           payload = coalesce(p_payload, payload),
           attempt_count = attempt_count + 1,
           last_attempt_at = now(),
           updated_at = now(),
           last_error = null
     where user_id = p_user_id
       and event_type = p_event_type
       and dedupe_key = p_dedupe_key
       and (
           status in ('failed', 'no_subscriptions')
           or (status = 'processing' and last_attempt_at < now() - interval '5 minutes')
       )
    returning id into claimed_id;

    if claimed_id is not null then
        return query select claimed_id, true, false;
        return;
    end if;

    select id into claimed_id
      from public.push_notification_events
     where user_id = p_user_id
       and event_type = p_event_type
       and dedupe_key = p_dedupe_key;

    return query select claimed_id, false, true;
end;
$$;

revoke all on function public.claim_push_notification_event(uuid, text, text, jsonb) from public;
revoke all on function public.claim_push_notification_event(uuid, text, text, jsonb) from anon;
revoke all on function public.claim_push_notification_event(uuid, text, text, jsonb) from authenticated;
grant execute on function public.claim_push_notification_event(uuid, text, text, jsonb) to service_role;
