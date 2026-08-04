-- =============================================================================
-- payment_recovery_log — durable diagnostics for verify-paystack-payment
-- =============================================================================
-- Root cause this supports: `verify-paystack-payment` (called both by the
-- normal contributor callback AND by Admin Reconcile, since reconcile just
-- invokes the same edge function) used to apply `ensureCollectionIsPayable`'s
-- paused/closed/completed/pending_review gate AFTER Paystack had already
-- captured the contributor's money. If the collection's status changed
-- between charge-time and verify-time (auto-close cron on `deadline`, or an
-- admin pausing/closing it), the contribution was silently dropped — no row,
-- no wallet update, no notification — and every console.log describing why
-- vanished once the edge function instance recycled. Admin Reconcile hit the
-- identical rejection on retry because it's the same code path, so the
-- failure looked permanent.
--
-- This table makes every post-success verify/reconcile outcome (success AND
-- failure) durable and queryable, so "why didn't this payment record?" has
-- an answer without needing to catch it in the Supabase function logs live.
--
-- Written by: kolekto-fe-old/supabase/functions/verify-paystack-payment/index.ts
--             (logRecoveryAttempt helper — best-effort, never blocks the
--             actual payment outcome if the insert itself fails).
--
-- IMPORTANT — apply this against the same project as admin_users.sql /
-- contributions / collections.
-- Apply via:
--   supabase db push   (CLI, if linked)
--   OR paste into Supabase dashboard → SQL editor
-- =============================================================================

create table if not exists public.payment_recovery_log (
    id              uuid primary key default gen_random_uuid(),

    -- Paystack transaction reference. Not unique — the same reference can
    -- legitimately appear multiple times (idempotent replay attempts,
    -- repeated reconcile clicks, webhook retries all hitting this function).
    reference       text not null,

    -- Null when collectionId resolution itself failed (missing_collection_id).
    collection_id   uuid,

    success         boolean not null,

    -- Set on failure rows. Mirrors PaymentValidationError.code from the edge
    -- function (e.g. missing_collection_id, collection_not_found,
    -- amount_mismatch, contribution_insert_failed, collection_full,
    -- tier_sold_out, insufficient_ticket_capacity).
    error_code      text,
    error_message   text,

    -- Where the collectionId/metadata came from: pending_payment_context,
    -- paystack_object, paystack_string_parsed, manual_override, or none.
    metadata_source text,

    -- Free-text marker for non-error outcomes, e.g. "idempotent_hit
    -- existing=2" or "new_contribution_recorded count=1".
    note            text,

    -- Extra structured context (e.g. {verifiedTotal, expectedTotal} for an
    -- amount_mismatch row, or resolvedKeys for a missing_collection_id row).
    context         jsonb,

    created_at      timestamptz not null default now()
);

comment on table public.payment_recovery_log is
    'Durable log of every verify-paystack-payment outcome after Paystack confirms a charge (covers both the contributor callback and Admin Reconcile, since both call the same edge function). Query this first when a payment shows in Paystack but not in contributions.';

create index if not exists payment_recovery_log_reference_idx on public.payment_recovery_log (reference);
create index if not exists payment_recovery_log_created_at_idx on public.payment_recovery_log (created_at desc);
create index if not exists payment_recovery_log_failures_idx on public.payment_recovery_log (created_at desc) where success = false;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS — the edge function writes with the service-role key and bypasses RLS
-- entirely, so these policies only gate the admin panel's direct reads.
-- Reuses the is_current_user_admin() helper defined in admin_users.sql.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.payment_recovery_log enable row level security;
alter table public.payment_recovery_log force row level security;

drop policy if exists payment_recovery_log_select on public.payment_recovery_log;
create policy payment_recovery_log_select on public.payment_recovery_log
    for select
    to authenticated
    using (public.is_current_user_admin());
