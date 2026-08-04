-- Ambassador email delivery-tracking / audit log.
-- Apply in Supabase SQL editor or your migration pipeline (see ambassador_program.sql).

create table if not exists public.ambassador_email_logs (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  recipient_email text not null,
  subject text not null,
  status text not null check (status in ('sent', 'failed')),
  attempts integer not null default 1,
  last_error text,
  provider_message_id text,
  ambassador_id uuid references public.ambassador_profiles(id) on delete set null,
  application_id uuid references public.ambassador_applications(id) on delete set null,
  withdrawal_id uuid references public.ambassador_withdrawals(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists ambassador_email_logs_event_idx on public.ambassador_email_logs(event_type);
create index if not exists ambassador_email_logs_ambassador_idx on public.ambassador_email_logs(ambassador_id);
create index if not exists ambassador_email_logs_created_idx on public.ambassador_email_logs(created_at desc);
