/**
 * emailCampaignQueue.js — Email Campaign send worker.
 *
 * Postgres-backed queue: email_campaign_recipients rows with status='pending'
 * (or status='failed' with retry_count < MAX and next_retry_at due) are the
 * job queue. No Redis/Bull — this mirrors jobs/paymentSettlement.js's
 * single-replica-leader cron pattern, which this codebase already uses for
 * exactly the same reason (no distributed lock available across replicas).
 *
 * Gated by RUN_EMAIL_QUEUE_CRON=true on exactly ONE replica. Runs every
 * minute; processQueueTick is also exported for manual/admin-triggered runs.
 */
import cron from 'node-cron';
import { supabase } from '../utils/client.js';
import {
  sendCampaignRecipientEmail,
  nextRetryDelayMs,
  MAX_CAMPAIGN_SEND_ATTEMPTS,
} from '../utils/marketingEmailer.js';
import { renderCampaignEmail, inlineCampaignHtml } from '../templates/email/baseCampaignTemplate.js';
import { renderMergeTags } from '../utils/mergeTagEngine.js';
import { buildMergeDataMapForRecipients } from '../utils/mergeDataResolver.js';

const BATCH_SIZE = parseInt(process.env.EMAIL_QUEUE_BATCH_SIZE || '25', 10);
// Small delay between individual sends within a batch — respects ZeptoMail
// SMTP throughput, same tactic as services/emailService.js's sendBulkEmail.
const SEND_DELAY_MS = 150;
// A row claimed (status='processing') but never completed — e.g. the worker
// crashed mid-batch — is reclaimable after this window. Must comfortably exceed
// the longest realistic batch runtime (BATCH_SIZE * SEND_DELAY_MS + SMTP time).
const STALE_CLAIM_MINUTES = parseInt(process.env.EMAIL_QUEUE_STALE_MINUTES || '15', 10);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Release rows we claimed but couldn't proceed with (e.g. campaign fetch
// failed) back to 'pending' so the next tick retries them immediately rather
// than waiting for the stale-recovery window.
async function releaseClaims(recipientIds) {
  if (!recipientIds || recipientIds.length === 0) return;
  await supabase
    .from('email_campaign_recipients')
    .update({ status: 'pending', claimed_at: null })
    .in('id', recipientIds);
}

// Atomically claim a batch. The DB-side RPC uses FOR UPDATE SKIP LOCKED to flip
// due rows (pending / due-retry / stale-processing) to 'processing' so NO other
// worker — another tick in this process, or another replica — can grab the same
// rows. This is the fix for the double-send race (a send-now kick racing the
// cron tick). See migration email_queue_atomic_claim.
async function claimBatch() {
  const { data: claimed, error } = await supabase.rpc('claim_email_campaign_recipients', {
    p_batch_size: BATCH_SIZE,
    p_max_attempts: MAX_CAMPAIGN_SEND_ATTEMPTS,
    p_stale_minutes: STALE_CLAIM_MINUTES,
  });

  if (error) {
    console.error('[email-queue] atomic claim failed:', error.message);
    return [];
  }

  const rows = claimed || [];
  if (rows.length === 0) return [];

  // The RPC returns recipient rows only; re-attach each row's campaign (fetched
  // once per distinct campaign_id) to preserve the recipient.email_campaigns
  // shape the rest of processQueueTick relies on.
  const campaignIds = [...new Set(rows.map((r) => r.campaign_id))];
  const { data: campaigns, error: campErr } = await supabase
    .from('email_campaigns')
    .select('id, status, subject, preview_text, html_body, footer_html, sender_name, reply_to_email')
    .in('id', campaignIds);

  if (campErr) {
    console.error('[email-queue] failed to load campaigns for claimed batch:', campErr.message);
    await releaseClaims(rows.map((r) => r.id));
    return [];
  }

  const byId = new Map((campaigns || []).map((c) => [c.id, c]));
  return rows.map((r) => ({ ...r, email_campaigns: byId.get(r.campaign_id) || null }));
}

async function markSent(recipientId, messageId) {
  await supabase
    .from('email_campaign_recipients')
    .update({ status: 'sent', sent_at: new Date().toISOString(), provider_message_id: messageId || null, claimed_at: null })
    .eq('id', recipientId);
}

async function markFailed(recipientId, previousRetryCount, error) {
  const retryCount = (previousRetryCount || 0) + 1;
  const stillRetryable = retryCount < MAX_CAMPAIGN_SEND_ATTEMPTS;
  await supabase
    .from('email_campaign_recipients')
    .update({
      status: 'failed',
      retry_count: retryCount,
      failed_reason: String(error || 'Unknown error').slice(0, 500),
      next_retry_at: stillRetryable
        ? new Date(Date.now() + nextRetryDelayMs(retryCount)).toISOString()
        : null,
      // Release the claim so a due retry can be re-claimed at next_retry_at,
      // rather than waiting out the stale-processing recovery window.
      claimed_at: null,
    })
    .eq('id', recipientId);
}

async function finalizeCampaignsIfDone(campaignIds) {
  for (const campaignId of campaignIds) {
    const { count: openCount, error: openError } = await supabase
      .from('email_campaign_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', campaignId)
      .or(`status.eq.pending,status.eq.processing,and(status.eq.failed,retry_count.lt.${MAX_CAMPAIGN_SEND_ATTEMPTS})`);

    if (openError) {
      console.error(`[email-queue] failed to check remaining work for campaign ${campaignId}:`, openError.message);
      continue;
    }
    if (openCount && openCount > 0) continue;

    const { count: sentCount, error: sentError } = await supabase
      .from('email_campaign_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', campaignId)
      .in('status', ['sent', 'delivered', 'opened', 'clicked']);

    if (sentError) {
      console.error(`[email-queue] failed to check sent count for campaign ${campaignId}:`, sentError.message);
      continue;
    }

    await supabase
      .from('email_campaigns')
      .update({
        status: sentCount && sentCount > 0 ? 'sent' : 'failed',
        sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', campaignId)
      .eq('status', 'sending'); // don't clobber a campaign an admin already cancelled
  }
}

// In-process guard: the cron tick and an admin send-now kick can both call
// processQueueTick in the SAME process. The DB atomic claim already prevents
// double-SEND, but running two ticks at once is wasted work and log noise, so
// we serialise them here as defense-in-depth.
let tickInProgress = false;

/**
 * Processes one batch of due recipients. Exported for manual/admin-triggered
 * runs in addition to the cron schedule below.
 */
export async function processQueueTick() {
  if (tickInProgress) {
    return { processed: 0, sent: 0, failed: 0, skipped: 'already_running' };
  }
  tickInProgress = true;
  try {
    return await runQueueTick();
  } finally {
    tickInProgress = false;
  }
}

async function markUnsubscribed(recipientId) {
  await supabase
    .from('email_campaign_recipients')
    .update({
      status: 'failed',
      failed_reason: 'Recipient unsubscribed',
      retry_count: MAX_CAMPAIGN_SEND_ATTEMPTS,
      next_retry_at: null,
      claimed_at: null,
    })
    .eq('id', recipientId);
}

async function runQueueTick() {
  const batch = await claimBatch();
  if (batch.length === 0) return { processed: 0, sent: 0, failed: 0 };

  console.log(`[email-queue] processing ${batch.length} recipient(s)`);

  // Re-check unsubscribes right before sending — materializeSegmentRecipients
  // already filters at segment-resolution time, but someone can unsubscribe
  // in the gap between that and this batch actually being sent.
  const batchEmails = [...new Set(batch.map((r) => r.email.toLowerCase()))];
  const { data: unsubRows } = await supabase.from('email_unsubscribes').select('email').in('email', batchEmails);
  const unsubscribedEmails = new Set((unsubRows || []).map((r) => r.email.toLowerCase()));

  // Merge-tag data for the whole batch in one query (not N+1) — see
  // utils/mergeDataResolver.js. The rendered *template* (wrapper + juice
  // inlining) is still cached once per campaign since juice only inlines
  // CSS and never depends on merge-tag values; only the final substitution
  // step runs per recipient.
  const mergeDataMap = await buildMergeDataMapForRecipients(batch);

  const templateByCampaign = new Map();
  const attachmentsByCampaign = new Map();
  let sent = 0;
  let failed = 0;
  const touchedCampaignIds = new Set();

  for (const recipient of batch) {
    const campaign = recipient.email_campaigns;
    touchedCampaignIds.add(recipient.campaign_id);

    if (!campaign || campaign.status === 'cancelled') {
      // Campaign was cancelled after recipients were queued — drop the job.
      await supabase
        .from('email_campaign_recipients')
        .update({ status: 'failed', failed_reason: 'Campaign cancelled', retry_count: MAX_CAMPAIGN_SEND_ATTEMPTS, next_retry_at: null, claimed_at: null })
        .eq('id', recipient.id);
      failed += 1;
      continue;
    }

    if (unsubscribedEmails.has(recipient.email.toLowerCase())) {
      await markUnsubscribed(recipient.id);
      failed += 1;
      continue;
    }

    let template = templateByCampaign.get(recipient.campaign_id);
    if (!template) {
      const rawHtml = renderCampaignEmail({
        subject: campaign.subject,
        preheader: campaign.preview_text,
        bodyHtml: campaign.html_body,
        footerHtml: campaign.footer_html,
      });
      template = inlineCampaignHtml(rawHtml);
      templateByCampaign.set(recipient.campaign_id, template);
    }

    let attachments = attachmentsByCampaign.get(recipient.campaign_id);
    if (!attachments) {
      const { data: attachmentRows } = await supabase
        .from('email_campaign_attachments')
        .select('file_name, file_url')
        .eq('campaign_id', recipient.campaign_id);
      attachments = (attachmentRows || []).map((a) => ({ filename: a.file_name, path: a.file_url }));
      attachmentsByCampaign.set(recipient.campaign_id, attachments);
    }

    const mergeData = mergeDataMap.get(recipient.id) || {};
    const html = renderMergeTags(template, mergeData);
    const subject = renderMergeTags(campaign.subject, mergeData);

    const result = await sendCampaignRecipientEmail({
      to: recipient.email,
      subject,
      html,
      attachments: attachments.length > 0 ? attachments : undefined,
    });

    if (result.success) {
      await markSent(recipient.id, result.messageId);
      sent += 1;
    } else {
      await markFailed(recipient.id, recipient.retry_count, result.error);
      failed += 1;
    }

    await wait(SEND_DELAY_MS);
  }

  await finalizeCampaignsIfDone(touchedCampaignIds);

  console.log(`[email-queue] batch complete — sent: ${sent}, failed: ${failed}`);
  return { processed: batch.length, sent, failed };
}

if (process.env.RUN_EMAIL_QUEUE_CRON === 'true') {
  cron.schedule('* * * * *', () => {
    processQueueTick().catch((err) => {
      console.error('[email-queue] Unhandled error in queue tick:', err?.message || err);
    });
  });
  console.log('[email-queue] Email campaign queue worker scheduled — runs every minute.');
} else {
  console.log(
    '[email-queue] cron NOT scheduled — set RUN_EMAIL_QUEUE_CRON=true on exactly ONE replica to enable. processQueueTick remains available for manual triggers.'
  );
}
