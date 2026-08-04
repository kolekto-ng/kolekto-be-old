-- Kolekto Email Campaign & Communication System schema.
-- Apply in Supabase SQL editor or your migration pipeline before rollout.
--
-- Phase 1 (foundation) needs: email_campaigns, email_campaign_recipients,
-- email_campaign_audit_log. email_templates and email_campaign_attachments
-- are included now too since they're self-contained (no dependency on
-- external table shapes). The recipient-filtering audience view
-- (email_recipient_directory) is intentionally NOT in this file — it joins
-- against profiles/collections/ambassador_profiles and ships as a separate
-- file in Phase 3 once the filter engine's exact column needs are locked in
-- against the live schema, so it isn't guessed here.

create extension if not exists pgcrypto;

create table if not exists public.email_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null default 'custom',
  subject text not null default '',
  preview_text text,
  html_body text not null default '',
  design_json jsonb,
  thumbnail_url text,
  is_system boolean not null default false,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists email_templates_category_idx on public.email_templates(category);

create table if not exists public.email_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'sending', 'sent', 'failed', 'cancelled')),
  subject text not null default '',
  preview_text text,
  sender_name text,
  reply_to_email text,
  html_body text not null default '',
  design_json jsonb,
  footer_html text,
  template_id uuid references public.email_templates(id) on delete set null,
  filter_json jsonb,
  recipient_count integer not null default 0,
  scheduled_at timestamptz,
  sent_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists email_campaigns_status_idx on public.email_campaigns(status);
create index if not exists email_campaigns_scheduled_idx on public.email_campaigns(status, scheduled_at);
create index if not exists email_campaigns_created_at_idx on public.email_campaigns(created_at desc);

-- One row = one send job (consumed by the queue worker) AND one delivery
-- log line (queried by Email Logs / Analytics) — deliberately the same
-- table so we don't duplicate state between a "queue" and a "log".
create table if not exists public.email_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.email_campaigns(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  email text not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'sent', 'delivered', 'opened', 'clicked', 'bounced', 'failed')),
  queued_at timestamptz not null default now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  failed_reason text,
  retry_count integer not null default 0,
  next_retry_at timestamptz,
  provider_message_id text
);

create index if not exists email_campaign_recipients_campaign_idx on public.email_campaign_recipients(campaign_id, status);
create index if not exists email_campaign_recipients_pending_idx on public.email_campaign_recipients(status) where status = 'pending';
create index if not exists email_campaign_recipients_retry_idx on public.email_campaign_recipients(status, next_retry_at) where status = 'failed';
create index if not exists email_campaign_recipients_message_idx on public.email_campaign_recipients(provider_message_id);

create table if not exists public.email_campaign_attachments (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.email_campaigns(id) on delete cascade,
  file_name text not null,
  file_url text not null,
  file_size integer,
  mime_type text,
  uploaded_at timestamptz not null default now()
);

create index if not exists email_campaign_attachments_campaign_idx on public.email_campaign_attachments(campaign_id);

create table if not exists public.email_campaign_audit_log (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references public.email_campaigns(id) on delete cascade,
  admin_email text not null,
  action text not null check (action in ('created', 'edited', 'test_sent', 'scheduled', 'send_started', 'cancelled', 'deleted')),
  details_json jsonb,
  created_at timestamptz not null default now()
);

create index if not exists email_campaign_audit_log_campaign_idx on public.email_campaign_audit_log(campaign_id);
create index if not exists email_campaign_audit_log_created_idx on public.email_campaign_audit_log(created_at desc);

insert into storage.buckets (id, name, public, file_size_limit)
values ('email-attachments', 'email-attachments', true, 15728640)
on conflict (id) do update
set public = true,
    file_size_limit = 15728640;
