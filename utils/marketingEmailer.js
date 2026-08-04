import { sendMarketingMail } from './marketingMailer.js';

export const MAX_CAMPAIGN_SEND_ATTEMPTS = 3;
// Backoff applied between retry *ticks* of the queue worker (jobs/emailCampaignQueue.js),
// not an in-process wait — campaigns can have thousands of recipients, so a
// failed send must never block the worker from moving on to the next
// recipient. This differs deliberately from utils/ambassadorEmailer.js,
// whose in-memory wait-then-retry loop is fine for a single lifecycle email
// but would serialize and stall a large batch here. Retry state
// (retry_count, next_retry_at) is persisted on the email_campaign_recipients
// row itself, so it also survives a server restart mid-campaign — the
// Ambassador flow's in-memory retry does not.
const RETRY_BACKOFF_MS = [0, 2 * 60 * 1000, 10 * 60 * 1000];

export function nextRetryDelayMs(attemptNumber) {
  return RETRY_BACKOFF_MS[Math.min(attemptNumber, RETRY_BACKOFF_MS.length - 1)];
}

/**
 * Sends a single campaign recipient email via the dedicated Marketing Mail
 * Agent. One attempt only — never throws, always resolves
 * { success, messageId?, error? }. Retry scheduling is the caller's
 * (queue worker's) responsibility, since it owns the persisted recipient row.
 */
export async function sendCampaignRecipientEmail({ to, subject, html, text, attachments }) {
  if (!to) {
    return { success: false, error: 'No recipient email' };
  }

  try {
    const result = await sendMarketingMail({ to, subject, html, text, attachments });
    if (result.success) {
      return { success: true, messageId: result.messageId };
    }
    return { success: false, error: result.error };
  } catch (err) {
    return { success: false, error: err?.message || String(err) };
  }
}
