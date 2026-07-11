/**
 * emailCampaignScheduler.js — promotes scheduled campaigns to sending.
 *
 * Runs every minute (same leader gate as jobs/emailCampaignQueue.js — both
 * are part of the same "email sending" pipeline, so they share
 * RUN_EMAIL_QUEUE_CRON rather than needing a second leader flag): finds
 * email_campaigns where status='scheduled' AND scheduled_at <= now(),
 * resolves any saved audience filter into recipient rows (materialized now,
 * at send time — not back when the filter was configured, so a segment
 * like "registered in the last 30 days" is evaluated fresh), then flips the
 * campaign to 'sending' so jobs/emailCampaignQueue.js's own tick picks up
 * the newly-queued recipients.
 */
import cron from 'node-cron';
import { supabase } from '../utils/client.js';
import { hasAnyFilters } from '../utils/recipientFilters.js';
import { materializeSegmentRecipients } from '../utils/audienceMaterializer.js';

async function logCampaignAction(campaignId, action, details) {
  try {
    await supabase.from('email_campaign_audit_log').insert([{
      campaign_id: campaignId,
      admin_email: 'system:scheduler',
      action,
      details_json: details || null,
    }]);
  } catch (err) {
    console.error('[email-scheduler] failed to write audit log:', err?.message || err);
  }
}

export async function processScheduledCampaigns() {
  const nowIso = new Date().toISOString();
  const { data: dueCampaigns, error } = await supabase
    .from('email_campaigns')
    .select('id, filter_json')
    .eq('status', 'scheduled')
    .lte('scheduled_at', nowIso);

  if (error) {
    console.error('[email-scheduler] failed to fetch due campaigns:', error.message);
    return { promoted: 0, failed: 0 };
  }
  if (!dueCampaigns || dueCampaigns.length === 0) return { promoted: 0, failed: 0 };

  console.log(`[email-scheduler] promoting ${dueCampaigns.length} scheduled campaign(s)`);

  let promoted = 0;
  let failed = 0;

  for (const campaign of dueCampaigns) {
    try {
      if (hasAnyFilters(campaign.filter_json)) {
        await materializeSegmentRecipients(campaign.id, campaign.filter_json);
      }

      const { count, error: countError } = await supabase
        .from('email_campaign_recipients')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', campaign.id);
      if (countError) throw new Error(countError.message);

      if (!count || count === 0) {
        await supabase
          .from('email_campaigns')
          .update({ status: 'failed', updated_at: new Date().toISOString() })
          .eq('id', campaign.id)
          .eq('status', 'scheduled');
        await logCampaignAction(campaign.id, 'send_started', { error: 'No recipients matched at scheduled time' });
        failed += 1;
        continue;
      }

      await supabase
        .from('email_campaigns')
        .update({ status: 'sending', recipient_count: count, updated_at: new Date().toISOString() })
        .eq('id', campaign.id)
        .eq('status', 'scheduled'); // don't clobber a campaign an admin cancelled in the same tick

      await logCampaignAction(campaign.id, 'send_started', { recipientCount: count, source: 'scheduler' });
      promoted += 1;
    } catch (err) {
      console.error(`[email-scheduler] failed to promote campaign ${campaign.id}:`, err?.message || err);
      failed += 1;
    }
  }

  console.log(`[email-scheduler] promoted: ${promoted}, failed: ${failed}`);
  return { promoted, failed };
}

if (process.env.RUN_EMAIL_QUEUE_CRON === 'true') {
  cron.schedule('* * * * *', () => {
    processScheduledCampaigns().catch((err) => {
      console.error('[email-scheduler] Unhandled error in scheduler tick:', err?.message || err);
    });
  });
  console.log('[email-scheduler] Email campaign scheduler worker scheduled — runs every minute.');
} else {
  console.log(
    '[email-scheduler] cron NOT scheduled — set RUN_EMAIL_QUEUE_CRON=true on exactly ONE replica to enable. processScheduledCampaigns remains available for manual triggers.'
  );
}
