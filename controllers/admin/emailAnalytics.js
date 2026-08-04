import { supabase } from '../../utils/client.js';

function cleanString(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

// ── Cross-campaign delivery log ────────────────────────────────────────

export async function listEmailLogs(req, res) {
  try {
    const status = cleanString(req.query?.status);
    const campaignId = cleanString(req.query?.campaignId);
    const search = cleanString(req.query?.search);
    const limit = Math.min(parseInt(req.query?.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query?.offset, 10) || 0, 0);

    let query = supabase
      .from('email_campaign_recipients')
      .select('*, email_campaigns(id, name, subject)', { count: 'exact' })
      .order('queued_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq('status', status);
    if (campaignId) query = query.eq('campaign_id', campaignId);
    if (search) query = query.ilike('email', `%${search}%`);

    const { data, error, count } = await query;
    if (error) throw new Error(error.message);

    return res.json({ logs: data || [], total: count || 0, limit, offset });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list email logs', details: err.message });
  }
}

// ── Analytics ───────────────────────────────────────────────────────────

const SENT_STATUSES = new Set(['sent', 'delivered', 'opened', 'clicked']);
const DELIVERED_STATUSES = new Set(['delivered', 'opened', 'clicked']);

// Aggregates in JS over a bounded date-range window rather than a SQL
// aggregate RPC — simple and correct at current data volume. If campaign
// volume grows into the tens of thousands sent per window, this should
// move to a SQL-side aggregate (group by) instead of pulling every row.
export async function getEmailAnalytics(req, res) {
  try {
    const days = Math.min(parseInt(req.query?.days, 10) || 30, 365);
    const campaignId = cleanString(req.query?.campaignId);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    let query = supabase
      .from('email_campaign_recipients')
      .select('status, queued_at, sent_at, opened_at, clicked_at')
      .gte('queued_at', since);
    if (campaignId) query = query.eq('campaign_id', campaignId);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const rows = data || [];
    const totals = { total: rows.length, sent: 0, delivered: 0, opened: 0, clicked: 0, failed: 0, bounced: 0 };
    const trendMap = new Map();

    for (const r of rows) {
      const sent = SENT_STATUSES.has(r.status);
      const delivered = DELIVERED_STATUSES.has(r.status);
      const opened = Boolean(r.opened_at) || r.status === 'opened' || r.status === 'clicked';
      const clicked = Boolean(r.clicked_at) || r.status === 'clicked';
      const failed = r.status === 'failed';
      const bounced = r.status === 'bounced';

      if (sent) totals.sent += 1;
      if (delivered) totals.delivered += 1;
      if (opened) totals.opened += 1;
      if (clicked) totals.clicked += 1;
      if (failed) totals.failed += 1;
      if (bounced) totals.bounced += 1;

      const dayKey = (r.sent_at || r.queued_at || '').slice(0, 10);
      if (dayKey) {
        const entry = trendMap.get(dayKey) || { date: dayKey, sent: 0, opened: 0, clicked: 0 };
        if (sent) entry.sent += 1;
        if (opened) entry.opened += 1;
        if (clicked) entry.clicked += 1;
        trendMap.set(dayKey, entry);
      }
    }

    const trend = Array.from(trendMap.values()).sort((a, b) => a.date.localeCompare(b.date));

    const rates = {
      openRate: totals.sent > 0 ? Number(((totals.opened / totals.sent) * 100).toFixed(1)) : 0,
      clickThroughRate: totals.sent > 0 ? Number(((totals.clicked / totals.sent) * 100).toFixed(1)) : 0,
      bounceRate: totals.sent > 0 ? Number(((totals.bounced / totals.sent) * 100).toFixed(1)) : 0,
    };

    return res.json({ totals, rates, trend });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load analytics', details: err.message });
  }
}

// ── ZeptoMail delivery-event webhook ───────────────────────────────────
//
// NOT validated against a real ZeptoMail webhook payload — this backend has
// no live webhook configured yet, and I don't have access to ZeptoMail's
// webhook payload documentation. Built defensively: verifies a shared
// secret, logs the raw payload on every call (so the real shape can be
// inspected in server logs once ZeptoMail actually calls this), tries a few
// plausible field-name conventions for message id / event type, and always
// responds 200 so ZeptoMail doesn't retry-storm on a shape mismatch.
// Revisit the field mapping below once a real event has been observed.
const STATUS_RANK = { pending: 0, processing: 0, sent: 1, delivered: 2, opened: 3, clicked: 4 };

function mapEventToUpdate(eventType, event) {
  const nowIso = new Date().toISOString();
  const type = String(eventType || '').toLowerCase();
  if (type.includes('deliver')) return { status: 'delivered', delivered_at: nowIso };
  if (type.includes('open')) return { status: 'opened', opened_at: nowIso };
  if (type.includes('click')) return { status: 'clicked', clicked_at: nowIso };
  if (type.includes('bounce') || type.includes('fail')) {
    return { status: 'bounced', failed_reason: String(event?.reason || event?.bounce_reason || type).slice(0, 500) };
  }
  return null;
}

export async function handleZeptoMailWebhook(req, res) {
  try {
    const token = req.query?.token || req.headers['x-webhook-token'];
    if (!process.env.ZEPTOMAIL_WEBHOOK_TOKEN || token !== process.env.ZEPTOMAIL_WEBHOOK_TOKEN) {
      return res.status(401).json({ error: 'Invalid webhook token' });
    }

    const events = Array.isArray(req.body) ? req.body : [req.body];
    console.log(`[email-webhook] received ${events.length} event(s) — raw payload:`, JSON.stringify(req.body).slice(0, 2000));

    for (const event of events) {
      if (!event || typeof event !== 'object') continue;

      const messageId = event.z_messageid || event.message_id || event.messageId || event.reference_id || event.referenceId;
      const eventType = event.event_type || event.eventType || event.event;
      if (!messageId || !eventType) {
        console.warn('[email-webhook] skipped event — missing message id or event type:', JSON.stringify(event).slice(0, 500));
        continue;
      }

      const updates = mapEventToUpdate(eventType, event);
      if (!updates) {
        console.warn(`[email-webhook] unrecognized event type "${eventType}" — skipped`);
        continue;
      }

      const { data: existingRow, error: fetchError } = await supabase
        .from('email_campaign_recipients')
        .select('id, status')
        .eq('provider_message_id', messageId)
        .maybeSingle();
      if (fetchError || !existingRow) {
        console.warn(`[email-webhook] no recipient row found for message id "${messageId}"`);
        continue;
      }

      // Never let an out-of-order webhook move status backwards (e.g. a
      // delayed "delivered" event arriving after "clicked" already landed)
      // — bounced/failed always win regardless of prior state.
      const finalUpdates = { ...updates };
      if (updates.status && updates.status !== 'bounced') {
        const currentRank = STATUS_RANK[existingRow.status] ?? 0;
        const newRank = STATUS_RANK[updates.status] ?? 0;
        if (newRank < currentRank) delete finalUpdates.status;
      }

      await supabase.from('email_campaign_recipients').update(finalUpdates).eq('id', existingRow.id);
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('[email-webhook] error processing webhook:', err?.message || err);
    return res.status(200).json({ received: true });
  }
}
