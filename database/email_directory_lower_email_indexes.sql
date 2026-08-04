-- F2-A: functional indexes supporting email_recipient_directory's lower(email)
-- EXISTS subqueries (is_ambassador / is_contributor).
--
-- Without these, every audience materialization, previewAudience call, and
-- per-minute scheduler tick full-scans public.contributions (computing
-- lower(email) + status='paid' per row) and public.ambassador_profiles to
-- build the semi-join hash. Verified on the TEST project: the contributions
-- subplan switched from a Seq Scan to a Bitmap Index Scan on
-- contributions_lower_email_paid_idx once this index existed.
--
-- ⚠️ PRODUCTION: run the CREATE INDEX statements with CONCURRENTLY and NOT in a
-- transaction block, so they don't take an ACCESS EXCLUSIVE lock on these
-- hot tables while building:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS contributions_lower_email_paid_idx
--     ON public.contributions (lower(email)) WHERE status = 'paid';
--
-- The plain (non-concurrent) form below is what was applied to TEST via the
-- migration runner (which wraps statements in a transaction).

-- Partial index: only 'paid' contributions are ever matched by the view.
CREATE INDEX IF NOT EXISTS contributions_lower_email_paid_idx
  ON public.contributions (lower(email))
  WHERE status = 'paid';

-- NOTE: a lower(email) index on ambassador_profiles was evaluated and
-- deliberately NOT kept — the view builds its ambassador-email hash via an
-- index-only scan on the existing UNIQUE index ambassador_profiles_email_key,
-- and no query filters on lower(email)=const there, so a dedicated functional
-- index would only add write overhead (flagged "unused" by the perf advisor).
