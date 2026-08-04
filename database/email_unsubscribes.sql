-- Unsubscribe suppression list for the Email Campaign system. Backs the
-- {{unsubscribe_link}} merge tag — the link it renders points at a public
-- (token-verified, not admin-auth) endpoint that inserts a row here, and
-- both materializeSegmentRecipients() and the send queue check this table
-- so unsubscribed people never receive another campaign.
-- Apply after database/email_campaigns.sql.

-- `email` is always stored lowercased by the application (never rely on
-- Postgres to lowercase it) so a plain unique constraint on the column
-- works with supabase-js's upsert(..., { onConflict: 'email' }) — a
-- functional unique index on lower(email) can't be targeted that way via
-- PostgREST.
create table if not exists public.email_unsubscribes (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  campaign_id uuid references public.email_campaigns(id) on delete set null,
  reason text,
  unsubscribed_at timestamptz not null default now()
);
