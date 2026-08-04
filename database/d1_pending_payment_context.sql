-- ============================================================================
-- D-1: Persist payment context ourselves instead of trusting Paystack to
--      faithfully round-trip arbitrary metadata.
-- ============================================================================
--
-- Root cause this addresses: production logs showed
--   WEBHOOK_VERIFY_FAILED status=400 { error: 'Missing collection ID in
--   payment metadata' }
-- `verify-paystack-payment` was relying ENTIRELY on Paystack returning back
-- the exact `metadata` object we sent at `initiate-paystack-payment` time.
-- That object can come back malformed for reasons outside our control —
-- e.g. Paystack returning `metadata` as a JSON-encoded STRING instead of an
-- already-parsed object for some transactions (a known integration gotcha),
-- or metadata exceeding an undocumented size limit and getting truncated on
-- Paystack's side. Either way, `collectionId` can silently go missing even
-- though we sent it correctly.
--
-- The fix: WE store the payment context ourselves at initiate time, keyed
-- by the `reference` we generate, and look it up FIRST at verify time. We
-- only fall back to parsing Paystack's returned metadata for references
-- that predate this change (no row in this table yet). This makes
-- verification correct regardless of what Paystack's API does with
-- metadata — we're the source of truth for our own data.
--
-- This migration is IDEMPOTENT — re-running it is safe.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.pending_payment_context (
    reference text PRIMARY KEY,
    collection_id uuid NOT NULL,
    metadata jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pending_payment_context_created_at ON public.pending_payment_context (created_at);
-- RLS: only service_role (used internally by edge functions / backend,
-- which bypasses RLS regardless) should ever touch this table — it's
-- write-once-read-once internal plumbing, never read by end users.
ALTER TABLE public.pending_payment_context ENABLE ROW LEVEL SECURITY;
-- No policies added for anon/authenticated — default-deny applies to them.
-- service_role bypasses RLS automatically, no policy needed for it either.
-- Optional periodic cleanup (run manually or via a cron job) — rows are
-- only useful for the few minutes between initiate and verify; anything
-- older than a few days is from an abandoned or already-verified checkout
-- and safe to discard. NOT run automatically by this migration.
-- DELETE FROM public.pending_payment_context WHERE created_at < now() - interval '7 days';