import { supabase } from './client.js';
import { applyRecipientFilters } from './recipientFilters.js';
import { log } from './logger.js';

// Defensive upper bound on how many recipients a single segment can
// materialize in one call. This is a safety valve, not an expected limit:
// it prevents a mis-scoped "everyone" filter from pulling an unbounded result
// set (and holding a Supabase connection) in one shot. If a real campaign
// ever legitimately needs more, raise this and/or paginate — the warn log
// below makes hitting the cap visible instead of silent.
const AUDIENCE_MATERIALIZE_CAP = parseInt(process.env.AUDIENCE_MATERIALIZE_CAP || '100000', 10);

// Resolves `filters` against email_recipient_directory and inserts any
// matches not already queued for this campaign. Deduplicates by email so
// calling this alongside manually-added recipients — or re-calling it, e.g.
// send-now retried, or the scheduler promoting a campaign that already had
// some explicit recipients added — never creates duplicate recipient rows.
//
// Shared by controllers/admin/emailCampaigns.js (send-now) and
// jobs/emailCampaignScheduler.js (promoting scheduled campaigns), so the
// "materialize at send time, not save time" rule is enforced identically
// for both paths.
export async function materializeSegmentRecipients(campaignId, filters) {
  let query = supabase.from('email_recipient_directory').select('id,email').limit(AUDIENCE_MATERIALIZE_CAP);
  query = applyRecipientFilters(query, filters);
  const { data: matches, error } = await query;
  if (error) throw new Error(error.message);

  if ((matches?.length || 0) >= AUDIENCE_MATERIALIZE_CAP) {
    // Hitting the cap means the audience was truncated — surface it loudly so
    // it's diagnosable rather than a silently-under-sent campaign.
    log.warn('audience.materialize_cap_hit', {
      campaignId,
      cap: AUDIENCE_MATERIALIZE_CAP,
      hint: 'Segment matched at least the cap; raise AUDIENCE_MATERIALIZE_CAP or paginate.',
    });
  }

  const { data: existingRows, error: existingError } = await supabase
    .from('email_campaign_recipients')
    .select('email')
    .eq('campaign_id', campaignId);
  if (existingError) throw new Error(existingError.message);
  const existingEmails = new Set((existingRows || []).map((r) => String(r.email).toLowerCase()));

  // Never re-materialize someone who unsubscribed — segments are resolved
  // fresh at send time specifically so this stays accurate up to the last
  // moment. (The send queue also re-checks this per-recipient right before
  // sending, in case someone unsubscribes in the gap between materializing
  // and actually sending.)
  const { data: unsubRows, error: unsubError } = await supabase.from('email_unsubscribes').select('email');
  if (unsubError) throw new Error(unsubError.message);
  const unsubscribedEmails = new Set((unsubRows || []).map((r) => String(r.email).toLowerCase()));

  const newRows = (matches || [])
    .filter((r) => r.email && !existingEmails.has(String(r.email).toLowerCase()) && !unsubscribedEmails.has(String(r.email).toLowerCase()))
    .map((r) => ({ campaign_id: campaignId, user_id: r.id, email: r.email }));

  const CHUNK_SIZE = 500;
  for (let i = 0; i < newRows.length; i += CHUNK_SIZE) {
    const chunk = newRows.slice(i, i + CHUNK_SIZE);
    const { error: insertError } = await supabase.from('email_campaign_recipients').insert(chunk);
    if (insertError) throw new Error(insertError.message);
  }
  return newRows.length;
}
