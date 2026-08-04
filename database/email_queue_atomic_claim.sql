-- F3-A: atomic claim for the email send queue (fixes the double-send race).
--
-- Before this, jobs/emailCampaignQueue.js SELECTed status='pending' rows and
-- processed them with no claim step. Two overlapping runs — the per-minute
-- cron tick racing the immediate processQueueTick() kick fired by send-now, or
-- two replicas — could both grab the same rows and send the same email twice
-- to real users.
--
-- claim_email_campaign_recipients() claims a batch atomically with
-- FOR UPDATE SKIP LOCKED and flips the claimed rows to 'processing' (a value
-- the status CHECK constraint already permitted), so no other worker can pick
-- them up. claimed_at enables crash recovery: rows left 'processing' by a
-- worker that died mid-batch become reclaimable after p_stale_minutes.
--
-- Verified on the TEST project: 3 pending rows, claim(2)->{1,2}, claim(2)->{3},
-- claim(2)->none. Zero overlap.

ALTER TABLE public.email_campaign_recipients
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

CREATE OR REPLACE FUNCTION public.claim_email_campaign_recipients(
  p_batch_size int,
  p_max_attempts int,
  p_stale_minutes int DEFAULT 15
)
RETURNS SETOF public.email_campaign_recipients
LANGUAGE sql
AS $$
  WITH claimable AS (
    SELECT c.id
    FROM public.email_campaign_recipients c
    WHERE (
        c.status = 'pending'
        OR (c.status = 'failed'
            AND c.retry_count < p_max_attempts
            AND c.next_retry_at <= now())
        -- Crash recovery: reclaim rows stuck 'processing' past the stale window.
        OR (c.status = 'processing'
            AND c.claimed_at < now() - make_interval(mins => p_stale_minutes))
    )
    ORDER BY c.queued_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.email_campaign_recipients r
  SET status = 'processing', claimed_at = now()
  FROM claimable
  WHERE r.id = claimable.id
  RETURNING r.*;
$$;

COMMENT ON FUNCTION public.claim_email_campaign_recipients(int, int, int) IS
  'Atomically claims a batch of due email recipients (pending / due-retry / stale-processing) via FOR UPDATE SKIP LOCKED, marking them processing. Safe against concurrent workers and multiple replicas.';
