import { supabase } from '../../utils/client.js';
import { sendCampaignRecipientEmail } from '../../utils/marketingEmailer.js';
import { renderCampaignEmail, inlineCampaignHtml } from '../../templates/email/baseCampaignTemplate.js';
import { processQueueTick } from '../../jobs/emailCampaignQueue.js';
import { applyRecipientFilters, hasAnyFilters } from '../../utils/recipientFilters.js';
import { materializeSegmentRecipients } from '../../utils/audienceMaterializer.js';
import { renderMergeTags } from '../../utils/mergeTagEngine.js';
import { buildMergeDataForEmail, buildSampleMergeData, MERGE_TAG_CATALOG } from '../../utils/mergeDataResolver.js';

function cleanString(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function validationError(res, message, field) {
  return res.status(400).json({ error: message, field });
}

async function logCampaignAction(campaignId, adminEmail, action, details) {
  try {
    const { error } = await supabase.from('email_campaign_audit_log').insert([{
      campaign_id: campaignId,
      admin_email: adminEmail || 'unknown',
      action,
      details_json: details || null,
    }]);
    if (error) {
      console.error('[email-campaigns] failed to write audit log:', error.message);
    }
  } catch (err) {
    console.error('[email-campaigns] audit log insert threw:', err?.message || err);
  }
}

async function fetchCampaign(id) {
  const { data, error } = await supabase
    .from('email_campaigns')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

// ── Campaigns ───────────────────────────────────────────────────────────

export async function listEmailCampaigns(req, res) {
  try {
    const status = cleanString(req.query?.status);
    const search = cleanString(req.query?.search);
    const limit = Math.min(parseInt(req.query?.limit, 10) || 20, 100);
    const offset = Math.max(parseInt(req.query?.offset, 10) || 0, 0);

    let query = supabase
      .from('email_campaigns')
      .select('id, name, status, subject, recipient_count, scheduled_at, sent_at, created_at, updated_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq('status', status);
    if (search) query = query.ilike('name', `%${search}%`);

    const { data, error, count } = await query;
    if (error) throw new Error(error.message);

    return res.json({ campaigns: data || [], total: count || 0, limit, offset });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list campaigns', details: err.message });
  }
}

export async function createEmailCampaign(req, res) {
  try {
    const name = cleanString(req.body?.name);
    if (!name) return validationError(res, 'Campaign name is required', 'name');

    const payload = {
      name,
      subject: cleanString(req.body?.subject),
      preview_text: cleanString(req.body?.previewText) || null,
      sender_name: cleanString(req.body?.senderName) || null,
      reply_to_email: cleanString(req.body?.replyToEmail) || null,
      html_body: req.body?.htmlBody || '',
      footer_html: req.body?.footerHtml || null,
      template_id: req.body?.templateId || null,
      status: 'draft',
      created_by: req.user?.email || null,
    };

    const { data, error } = await supabase.from('email_campaigns').insert([payload]).select().single();
    if (error) throw new Error(error.message);

    await logCampaignAction(data.id, req.user?.email, 'created', { name });

    return res.status(201).json({ campaign: data });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create campaign', details: err.message });
  }
}

export async function getEmailCampaign(req, res) {
  try {
    const campaign = await fetchCampaign(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const { data: statusCounts, error: countsError } = await supabase
      .from('email_campaign_recipients')
      .select('status')
      .eq('campaign_id', campaign.id);
    if (countsError) throw new Error(countsError.message);

    const recipientStatusCounts = (statusCounts || []).reduce((acc, row) => {
      acc[row.status] = (acc[row.status] || 0) + 1;
      return acc;
    }, {});

    return res.json({ campaign, recipientStatusCounts });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch campaign', details: err.message });
  }
}

const EDITABLE_FIELDS = {
  name: 'name',
  subject: 'subject',
  previewText: 'preview_text',
  senderName: 'sender_name',
  replyToEmail: 'reply_to_email',
  htmlBody: 'html_body',
  footerHtml: 'footer_html',
  templateId: 'template_id',
  filterJson: 'filter_json',
};

export async function updateEmailCampaign(req, res) {
  try {
    const existing = await fetchCampaign(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Campaign not found' });
    if (!['draft', 'scheduled'].includes(existing.status)) {
      return res.status(409).json({ error: `Cannot edit a campaign with status "${existing.status}"` });
    }

    const updates = { updated_at: new Date().toISOString() };
    for (const [bodyKey, column] of Object.entries(EDITABLE_FIELDS)) {
      if (req.body?.[bodyKey] !== undefined) updates[column] = req.body[bodyKey];
    }

    const { data, error } = await supabase
      .from('email_campaigns')
      .update(updates)
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw new Error(error.message);

    await logCampaignAction(existing.id, req.user?.email, 'edited', { fields: Object.keys(updates) });

    return res.json({ campaign: data });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update campaign', details: err.message });
  }
}

export async function deleteEmailCampaign(req, res) {
  try {
    const existing = await fetchCampaign(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Campaign not found' });
    if (existing.status !== 'draft') {
      return res.status(409).json({ error: 'Only draft campaigns can be deleted' });
    }

    const { error } = await supabase.from('email_campaigns').delete().eq('id', existing.id);
    if (error) throw new Error(error.message);

    await logCampaignAction(existing.id, req.user?.email, 'deleted', { name: existing.name });

    return res.json({ message: 'Campaign deleted' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete campaign', details: err.message });
  }
}

// ── Recipients (Phase 1: explicit list; segment-based targeting is Phase 3) ──

export async function addEmailCampaignRecipients(req, res) {
  try {
    const existing = await fetchCampaign(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Campaign not found' });
    if (!['draft', 'scheduled'].includes(existing.status)) {
      return res.status(409).json({ error: `Cannot add recipients to a campaign with status "${existing.status}"` });
    }

    const recipients = Array.isArray(req.body?.recipients) ? req.body.recipients : [];
    const rows = recipients
      .map((r) => ({
        campaign_id: existing.id,
        user_id: r.userId || null,
        email: cleanString(r.email),
      }))
      .filter((r) => r.email);

    if (rows.length === 0) return validationError(res, 'At least one recipient with a valid email is required', 'recipients');

    const CHUNK_SIZE = 500;
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      const { error } = await supabase.from('email_campaign_recipients').insert(chunk);
      if (error) throw new Error(error.message);
    }

    const { count, error: countError } = await supabase
      .from('email_campaign_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', existing.id);
    if (countError) throw new Error(countError.message);

    await supabase.from('email_campaigns').update({ recipient_count: count || 0 }).eq('id', existing.id);

    return res.json({ added: rows.length, recipientCount: count || 0 });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to add recipients', details: err.message });
  }
}

// ── Recipient filtering / segment engine (Phase 3) ─────────────────────

export async function previewAudience(req, res) {
  try {
    const filters = req.body?.filters || {};
    const limit = Math.min(parseInt(req.body?.limit, 10) || 10, 100);
    const offset = Math.max(parseInt(req.body?.offset, 10) || 0, 0);

    let query = supabase
      .from('email_recipient_directory')
      .select('id,email,full_name', { count: 'exact' });
    query = applyRecipientFilters(query, filters);
    const { data, error, count } = await query
      .order('registered_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw new Error(error.message);

    return res.json({ total: count || 0, sample: data || [], estimatedDelivery: count || 0 });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to preview audience', details: err.message });
  }
}

export async function exportCampaignAudience(req, res) {
  try {
    const existing = await fetchCampaign(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Campaign not found' });

    let filters = existing.filter_json || {};
    if (req.query?.filters) {
      try {
        filters = JSON.parse(req.query.filters);
      } catch {
        return validationError(res, 'Invalid filters JSON', 'filters');
      }
    }

    let query = supabase
      .from('email_recipient_directory')
      .select('id,email,full_name,registered_at')
      .order('registered_at', { ascending: false });
    query = applyRecipientFilters(query, filters);
    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const rows = data || [];
    const csvLines = ['id,email,full_name,registered_at'];
    for (const r of rows) {
      const safeName = String(r.full_name || '').replace(/"/g, '""');
      csvLines.push(`${r.id},${r.email},"${safeName}",${r.registered_at || ''}`);
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="campaign-${existing.id}-audience.csv"`);
    return res.send(csvLines.join('\n'));
  } catch (err) {
    return res.status(500).json({ error: 'Failed to export audience', details: err.message });
  }
}

export async function listEmailCampaignRecipients(req, res) {
  try {
    const existing = await fetchCampaign(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Campaign not found' });

    const status = cleanString(req.query?.status);
    const limit = Math.min(parseInt(req.query?.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query?.offset, 10) || 0, 0);

    let query = supabase
      .from('email_campaign_recipients')
      .select('*', { count: 'exact' })
      .eq('campaign_id', existing.id)
      .order('queued_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq('status', status);

    const { data, error, count } = await query;
    if (error) throw new Error(error.message);

    return res.json({ recipients: data || [], total: count || 0, limit, offset });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list recipients', details: err.message });
  }
}

// Lets an admin drop one person from an already-added recipient list (or
// from an already-materialized segment) before sending. Only allowed while
// the campaign is still editable and the row hasn't been sent yet — once a
// send is in flight, removing the row would just orphan a job the queue
// worker already claimed or desync recipient_count from reality.
export async function removeEmailCampaignRecipient(req, res) {
  try {
    const existing = await fetchCampaign(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Campaign not found' });
    if (!['draft', 'scheduled'].includes(existing.status)) {
      return res.status(409).json({ error: `Cannot remove recipients from a campaign with status "${existing.status}"` });
    }

    const { data: recipient, error: fetchError } = await supabase
      .from('email_campaign_recipients')
      .select('id, status')
      .eq('id', req.params.recipientId)
      .eq('campaign_id', existing.id)
      .maybeSingle();
    if (fetchError) throw new Error(fetchError.message);
    if (!recipient) return res.status(404).json({ error: 'Recipient not found' });
    if (recipient.status !== 'pending') {
      return res.status(409).json({ error: `Cannot remove a recipient with status "${recipient.status}"` });
    }

    const { error: deleteError } = await supabase.from('email_campaign_recipients').delete().eq('id', recipient.id);
    if (deleteError) throw new Error(deleteError.message);

    const { count, error: countError } = await supabase
      .from('email_campaign_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', existing.id);
    if (countError) throw new Error(countError.message);

    await supabase.from('email_campaigns').update({ recipient_count: count || 0 }).eq('id', existing.id);

    return res.json({ recipientCount: count || 0 });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to remove recipient', details: err.message });
  }
}

// ── Send actions ────────────────────────────────────────────────────────

export async function sendTestEmail(req, res) {
  try {
    const existing = await fetchCampaign(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Campaign not found' });

    const testEmails = Array.isArray(req.body?.testEmails)
      ? req.body.testEmails.map(cleanString).filter(Boolean)
      : [];
    if (testEmails.length === 0) return validationError(res, 'At least one test email address is required', 'testEmails');

    const rawHtml = renderCampaignEmail({
      subject: `[TEST] ${existing.subject}`,
      preheader: existing.preview_text,
      bodyHtml: existing.html_body,
      footerHtml: existing.footer_html,
    });
    const inlinedTemplate = inlineCampaignHtml(rawHtml);

    const { data: attachmentRows } = await supabase
      .from('email_campaign_attachments')
      .select('file_name, file_url')
      .eq('campaign_id', existing.id);
    const attachments = (attachmentRows || []).map((a) => ({ filename: a.file_name, path: a.file_url }));

    // Personalized per test address using that address's real profile data
    // if it matches one (so a test send looks exactly like what a real
    // recipient would get) — not fake sample data, since the admin
    // explicitly chose these addresses to test with.
    const results = [];
    for (const to of testEmails) {
      const mergeData = await buildMergeDataForEmail(to, existing.id);
      const html = renderMergeTags(inlinedTemplate, mergeData);
      const result = await sendCampaignRecipientEmail({
        to,
        subject: renderMergeTags(`[TEST] ${existing.subject}`, mergeData),
        html,
        attachments: attachments.length > 0 ? attachments : undefined,
      });
      results.push({ to, success: result.success, error: result.error });
    }

    await logCampaignAction(existing.id, req.user?.email, 'test_sent', { testEmails });

    return res.json({ results });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to send test email', details: err.message });
  }
}

export async function sendCampaignNow(req, res) {
  try {
    const existing = await fetchCampaign(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Campaign not found' });
    if (!['draft', 'scheduled'].includes(existing.status)) {
      return res.status(409).json({ error: `Cannot send a campaign with status "${existing.status}"` });
    }
    if (!existing.subject || !existing.html_body) {
      return validationError(res, 'Campaign must have a subject and body before sending', 'subject/htmlBody');
    }

    // Resolve the saved audience filter (if any) into recipient rows now —
    // materialized at send time, not when the filter was saved, so a
    // segment like "registered in the last 30 days" is evaluated fresh.
    if (hasAnyFilters(existing.filter_json)) {
      await materializeSegmentRecipients(existing.id, existing.filter_json);
    }

    const { count, error: countError } = await supabase
      .from('email_campaign_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', existing.id);
    if (countError) throw new Error(countError.message);
    if (!count || count === 0) {
      return validationError(res, 'Campaign has no recipients — add recipients or an audience filter before sending', 'recipients');
    }

    const { data, error } = await supabase
      .from('email_campaigns')
      .update({ status: 'sending', recipient_count: count, updated_at: new Date().toISOString() })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw new Error(error.message);

    await logCampaignAction(existing.id, req.user?.email, 'send_started', { recipientCount: count });

    // Kick the queue worker immediately rather than waiting up to a minute
    // for the next cron tick — safe to call even if the leader cron is also
    // running (it will simply find nothing left to claim).
    processQueueTick().catch((err) => {
      console.error('[email-campaigns] immediate queue kick failed:', err?.message || err);
    });

    return res.json({ campaign: data, recipientCount: count });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to send campaign', details: err.message });
  }
}

// ── Preview ─────────────────────────────────────────────────────────────

export async function previewCampaignHtml(req, res) {
  try {
    const existing = await fetchCampaign(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Campaign not found' });

    const rawHtml = renderCampaignEmail({
      subject: existing.subject,
      preheader: existing.preview_text,
      bodyHtml: existing.html_body,
      footerHtml: existing.footer_html,
    });
    const inlinedTemplate = inlineCampaignHtml(rawHtml);

    // "Preview As Recipient": ?recipientEmail=<email> renders with that
    // person's real merge-tag data (if they're a known profile). With no
    // recipient specified, falls back to clearly-fake sample data so the
    // admin can still see the layout before any recipients exist.
    const recipientEmail = cleanString(req.query?.recipientEmail);
    const mergeData = recipientEmail
      ? await buildMergeDataForEmail(recipientEmail, existing.id)
      : buildSampleMergeData();

    const html = renderMergeTags(inlinedTemplate, mergeData);
    const subject = renderMergeTags(existing.subject, mergeData);

    return res.json({ html, subject, previewedAs: recipientEmail || null });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to render preview', details: err.message });
  }
}

export async function listMergeTags(req, res) {
  return res.json({ mergeTags: MERGE_TAG_CATALOG });
}

// Backs the "Preview As Recipient" picker — a lightweight search over the
// full recipient directory (not just this campaign's already-added
// recipients), so an admin can preview as anyone, including someone not
// materialized into the campaign yet.
export async function searchEmailRecipients(req, res) {
  try {
    const q = cleanString(req.query?.q).replace(/[,()]/g, '');
    if (!q || q.length < 2) return res.json({ recipients: [] });

    const { data, error } = await supabase
      .from('email_recipient_directory')
      .select('id, email, full_name')
      .or(`email.ilike.%${q}%,full_name.ilike.%${q}%`)
      .limit(10);
    if (error) throw new Error(error.message);

    return res.json({ recipients: data || [] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to search recipients', details: err.message });
  }
}

// ── Templates ───────────────────────────────────────────────────────────

export async function listEmailTemplates(req, res) {
  try {
    const category = cleanString(req.query?.category);
    let query = supabase.from('email_templates').select('*').order('created_at', { ascending: false });
    if (category) query = query.eq('category', category);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    return res.json({ templates: data || [] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list templates', details: err.message });
  }
}

export async function createEmailTemplate(req, res) {
  try {
    const name = cleanString(req.body?.name);
    if (!name) return validationError(res, 'Template name is required', 'name');

    const payload = {
      name,
      category: cleanString(req.body?.category) || 'custom',
      subject: cleanString(req.body?.subject),
      preview_text: cleanString(req.body?.previewText) || null,
      html_body: req.body?.htmlBody || '',
      thumbnail_url: cleanString(req.body?.thumbnailUrl) || null,
      is_system: false,
      created_by: req.user?.email || null,
    };

    const { data, error } = await supabase.from('email_templates').insert([payload]).select().single();
    if (error) throw new Error(error.message);

    return res.status(201).json({ template: data });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create template', details: err.message });
  }
}

export async function updateEmailTemplate(req, res) {
  try {
    const { data: existing, error: fetchError } = await supabase
      .from('email_templates')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();
    if (fetchError) throw new Error(fetchError.message);
    if (!existing) return res.status(404).json({ error: 'Template not found' });

    const updates = { updated_at: new Date().toISOString() };
    if (req.body?.name !== undefined) updates.name = cleanString(req.body.name);
    if (req.body?.category !== undefined) updates.category = cleanString(req.body.category);
    if (req.body?.subject !== undefined) updates.subject = req.body.subject;
    if (req.body?.previewText !== undefined) updates.preview_text = req.body.previewText;
    if (req.body?.htmlBody !== undefined) updates.html_body = req.body.htmlBody;
    if (req.body?.thumbnailUrl !== undefined) updates.thumbnail_url = req.body.thumbnailUrl;

    const { data, error } = await supabase
      .from('email_templates')
      .update(updates)
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw new Error(error.message);

    return res.json({ template: data });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update template', details: err.message });
  }
}

export async function deleteEmailTemplate(req, res) {
  try {
    const { data: existing, error: fetchError } = await supabase
      .from('email_templates')
      .select('id, is_system')
      .eq('id', req.params.id)
      .maybeSingle();
    if (fetchError) throw new Error(fetchError.message);
    if (!existing) return res.status(404).json({ error: 'Template not found' });
    if (existing.is_system) return res.status(409).json({ error: 'Built-in templates cannot be deleted' });

    const { error } = await supabase.from('email_templates').delete().eq('id', existing.id);
    if (error) throw new Error(error.message);

    return res.json({ message: 'Template deleted' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete template', details: err.message });
  }
}

// ── Attachments ─────────────────────────────────────────────────────────

const ATTACHMENT_BUCKET = process.env.EMAIL_ATTACHMENTS_BUCKET || 'email-attachments';
const ALLOWED_ATTACHMENT_MIMES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export async function listEmailCampaignAttachments(req, res) {
  try {
    const existing = await fetchCampaign(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Campaign not found' });

    const { data, error } = await supabase
      .from('email_campaign_attachments')
      .select('*')
      .eq('campaign_id', existing.id)
      .order('uploaded_at', { ascending: true });
    if (error) throw new Error(error.message);

    return res.json({ attachments: data || [] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list attachments', details: err.message });
  }
}

export async function uploadEmailCampaignAttachment(req, res) {
  try {
    const existing = await fetchCampaign(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Campaign not found' });

    const file = req.file;
    if (!file) return validationError(res, 'A file is required', 'file');
    if (!ALLOWED_ATTACHMENT_MIMES.has(file.mimetype)) {
      return validationError(res, `Unsupported file type: ${file.mimetype}`, 'file');
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return validationError(res, 'File exceeds the 10MB size limit', 'file');
    }

    const filePath = `${existing.id}/${Date.now()}-${file.originalname}`;
    const { error: storageError } = await supabase.storage
      .from(ATTACHMENT_BUCKET)
      .upload(filePath, file.buffer, { upsert: false, contentType: file.mimetype });
    if (storageError) throw new Error(storageError.message);

    const { data: publicUrlData } = supabase.storage.from(ATTACHMENT_BUCKET).getPublicUrl(filePath);

    const { data, error } = await supabase
      .from('email_campaign_attachments')
      .insert([{
        campaign_id: existing.id,
        file_name: file.originalname,
        file_url: publicUrlData.publicUrl,
        file_size: file.size,
        mime_type: file.mimetype,
      }])
      .select()
      .single();
    if (error) throw new Error(error.message);

    return res.status(201).json({ attachment: data });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to upload attachment', details: err.message });
  }
}

export async function deleteEmailCampaignAttachment(req, res) {
  try {
    const { data: existing, error: fetchError } = await supabase
      .from('email_campaign_attachments')
      .select('*')
      .eq('id', req.params.attachmentId)
      .maybeSingle();
    if (fetchError) throw new Error(fetchError.message);
    if (!existing) return res.status(404).json({ error: 'Attachment not found' });

    const { error } = await supabase.from('email_campaign_attachments').delete().eq('id', existing.id);
    if (error) throw new Error(error.message);

    return res.json({ message: 'Attachment deleted' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete attachment', details: err.message });
  }
}

export async function scheduleCampaign(req, res) {
  try {
    const existing = await fetchCampaign(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Campaign not found' });
    // 'scheduled' is allowed too — re-picking the time for a campaign that's
    // already scheduled (but hasn't started sending yet) is a reschedule,
    // not a new schedule.
    if (!['draft', 'scheduled'].includes(existing.status)) {
      return res.status(409).json({ error: `Cannot schedule a campaign with status "${existing.status}"` });
    }
    if (!existing.subject || !existing.html_body) {
      return validationError(res, 'Campaign must have a subject and body before scheduling', 'subject/htmlBody');
    }

    const scheduledAt = req.body?.scheduledAt ? new Date(req.body.scheduledAt) : null;
    if (!scheduledAt || Number.isNaN(scheduledAt.getTime())) {
      return validationError(res, 'A valid scheduledAt date/time is required', 'scheduledAt');
    }
    if (scheduledAt.getTime() <= Date.now()) {
      return validationError(res, 'scheduledAt must be in the future', 'scheduledAt');
    }

    // Recipients (explicit list or audience filter) are resolved by
    // jobs/emailCampaignScheduler.js when scheduledAt arrives, not now — so
    // a filter like "registered in the last 30 days" is evaluated fresh at
    // send time rather than locked in at schedule time. We only require
    // that *some* targeting exists (explicit recipients already added, or a
    // filter configured) so the scheduler doesn't promote an empty campaign.
    const { count, error: countError } = await supabase
      .from('email_campaign_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', existing.id);
    if (countError) throw new Error(countError.message);
    if ((!count || count === 0) && !hasAnyFilters(existing.filter_json)) {
      return validationError(res, 'Add recipients or an audience filter before scheduling', 'recipients');
    }

    const { data, error } = await supabase
      .from('email_campaigns')
      .update({ status: 'scheduled', scheduled_at: scheduledAt.toISOString(), updated_at: new Date().toISOString() })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw new Error(error.message);

    await logCampaignAction(existing.id, req.user?.email, 'scheduled', {
      scheduledAt: scheduledAt.toISOString(),
      previousScheduledAt: existing.scheduled_at || null,
    });

    return res.json({ campaign: data });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to schedule campaign', details: err.message });
  }
}

export async function cancelCampaign(req, res) {
  try {
    const existing = await fetchCampaign(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Campaign not found' });
    if (!['scheduled', 'sending'].includes(existing.status)) {
      return res.status(409).json({ error: `Cannot cancel a campaign with status "${existing.status}"` });
    }

    const { data, error } = await supabase
      .from('email_campaigns')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw new Error(error.message);

    await logCampaignAction(existing.id, req.user?.email, 'cancelled', {});

    return res.json({ campaign: data });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to cancel campaign', details: err.message });
  }
}
