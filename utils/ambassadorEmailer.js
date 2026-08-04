import { sendAmbassadorMail } from './ambassadorMailer.js';
import { supabase } from './client.js';

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = [0, 2000, 5000];

function wait(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function logAmbassadorEmail({
  eventType,
  to,
  subject,
  status,
  attempts,
  lastError,
  providerMessageId,
  ambassadorId,
  applicationId,
  withdrawalId,
}) {
  try {
    const { error } = await supabase.from('ambassador_email_logs').insert([{
      event_type: eventType,
      recipient_email: Array.isArray(to) ? to.join(', ') : to,
      subject,
      status,
      attempts,
      last_error: lastError || null,
      provider_message_id: providerMessageId || null,
      ambassador_id: ambassadorId || null,
      application_id: applicationId || null,
      withdrawal_id: withdrawalId || null,
    }]);
    if (error) {
      console.error('[ambassador-email] failed to write audit log:', error.message);
    }
  } catch (err) {
    console.error('[ambassador-email] audit log insert threw:', err?.message || err);
  }
}

/**
 * Sends an ambassador lifecycle email with retry-with-backoff and a
 * persisted delivery-tracking audit log (ambassador_email_logs).
 *
 * Never throws — always resolves to { success, attempts, error? } so call
 * sites can keep using the existing fire-and-forget try/catch pattern
 * without new error-handling scaffolding.
 */
export async function sendAmbassadorEmail({
  to,
  subject,
  html,
  text,
  eventType,
  ambassadorId,
  applicationId,
  withdrawalId,
}) {
  if (!to) {
    console.warn(`[ambassador-email] skipped "${eventType}" — no recipient email`);
    return { success: false, attempts: 0, error: 'No recipient email' };
  }

  let lastError = null;
  let providerMessageId = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    await wait(RETRY_DELAY_MS[attempt - 1]);

    try {
      const result = await sendAmbassadorMail({ to, subject, html, text });
      if (result.success) {
        console.log(`✅ [ambassador-email] "${eventType}" sent to ${to} (attempt ${attempt})`);
        await logAmbassadorEmail({
          eventType,
          to,
          subject,
          status: 'sent',
          attempts: attempt,
          providerMessageId: result.messageId,
          ambassadorId,
          applicationId,
          withdrawalId,
        });
        return { success: true, attempts: attempt, messageId: result.messageId };
      }
      lastError = result.error;
    } catch (err) {
      lastError = err?.message || String(err);
    }

    console.warn(`⚠️ [ambassador-email] "${eventType}" attempt ${attempt}/${MAX_ATTEMPTS} failed for ${to}: ${lastError}`);
  }

  console.error(`❌ [ambassador-email] "${eventType}" failed after ${MAX_ATTEMPTS} attempts for ${to}: ${lastError}`);
  await logAmbassadorEmail({
    eventType,
    to,
    subject,
    status: 'failed',
    attempts: MAX_ATTEMPTS,
    lastError,
    providerMessageId,
    ambassadorId,
    applicationId,
    withdrawalId,
  });
  return { success: false, attempts: MAX_ATTEMPTS, error: lastError };
}
