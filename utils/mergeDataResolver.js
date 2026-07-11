// Domain logic for merge-tag personalization: what keys exist, where their
// values come from, and how they're formatted. The generic substitution
// mechanics live in utils/mergeTagEngine.js — this file is the only place
// that knows "referral_code means ambassador_profiles.ambassador_code".
import { supabase } from './client.js';
import { log } from './logger.js';
import { signUnsubscribeToken } from './unsubscribeTokens.js';

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://www.kolekto.com.ng';
// The backend's own public URL, needed to build an absolute unsubscribe
// link that works from inside an email client (a relative path can't).
// Falls back to localhost in dev — this MUST be set to the real deployed
// backend URL before sending real campaign traffic, or unsubscribe links
// will point at localhost.
const BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL || `http://localhost:${process.env.PORT || 5050}`;

// Catalog shown in the admin UI's "Personalization" dropdown (GET
// /email/merge-tags serves this directly, so the frontend never hardcodes
// its own copy that could drift from what's actually supported).
// organization_name is deliberately NOT included — no such data exists
// anywhere in the schema (verified against profiles and collections before
// this was written). The engine still handles {{organization_name|...}}
// gracefully via its fallback syntax; it's just not offered as a "real
// data" tag since there's nothing real to insert.
export const MERGE_TAG_CATALOG = [
  { key: 'first_name', label: 'First Name', category: 'Recipient' },
  { key: 'last_name', label: 'Last Name', category: 'Recipient' },
  { key: 'full_name', label: 'Full Name', category: 'Recipient' },
  { key: 'email', label: 'Email', category: 'Recipient' },
  { key: 'phone', label: 'Phone', category: 'Recipient' },
  { key: 'registration_date', label: 'Registration Date', category: 'Recipient' },
  { key: 'referral_code', label: 'Referral Code', category: 'Ambassador' },
  { key: 'available_earnings', label: 'Available Earnings', category: 'Ambassador' },
  { key: 'pending_earnings', label: 'Pending Earnings', category: 'Ambassador' },
  { key: 'total_earnings', label: 'Total Earnings', category: 'Ambassador' },
  { key: 'badge', label: 'Ambassador Badge / Rank', category: 'Ambassador' },
  { key: 'collections_created', label: 'Collections Created', category: 'Organizer' },
  { key: 'total_amount_processed', label: 'Total Amount Processed', category: 'Organizer' },
  { key: 'collection_title', label: 'Latest Collection Title', category: 'Collection' },
  { key: 'collection_target_amount', label: 'Latest Collection Target', category: 'Collection' },
  { key: 'collection_amount_raised', label: 'Latest Collection Amount Raised', category: 'Collection' },
  { key: 'current_date', label: 'Current Date', category: 'System' },
  { key: 'current_year', label: 'Current Year', category: 'System' },
  { key: 'dashboard_link', label: 'Dashboard Link', category: 'System' },
  { key: 'unsubscribe_link', label: 'Unsubscribe Link', category: 'System' },
];

function formatMoney(amount) {
  if (amount === null || amount === undefined) return undefined;
  const n = Number(amount);
  if (Number.isNaN(n)) return undefined;
  return new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
}

function formatDate(value) {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return new Intl.DateTimeFormat('en-NG', { year: 'numeric', month: 'long', day: 'numeric' }).format(d);
}

export function buildUnsubscribeLink(email, campaignId) {
  const token = signUnsubscribeToken(email, campaignId);
  return `${BACKEND_PUBLIC_URL}/api/email/unsubscribe?token=${encodeURIComponent(token)}`;
}

function buildSystemMergeData() {
  const now = new Date();
  return {
    current_date: formatDate(now),
    current_year: String(now.getFullYear()),
    dashboard_link: `${FRONTEND_URL}/dashboard`,
  };
}

/** Maps one email_recipient_directory row to the flat merge-tag key space. */
function mapDirectoryRowToMergeData(row) {
  return {
    first_name: row.first_name || undefined,
    last_name: row.last_name || undefined,
    full_name: row.full_name || undefined,
    email: row.email || undefined,
    phone: row.phone_number || undefined,
    registration_date: formatDate(row.registered_at),
    referral_code: row.ambassador_code || undefined,
    available_earnings: formatMoney(row.ambassador_available_earnings),
    pending_earnings: formatMoney(row.ambassador_pending_earnings),
    total_earnings: formatMoney(row.ambassador_total_earnings),
    badge: row.ambassador_rank || undefined,
    collections_created: row.collections_count !== undefined && row.collections_count !== null ? String(row.collections_count) : undefined,
    total_amount_processed: formatMoney(row.organizer_total_amount_processed),
    collection_title: row.latest_collection_title || undefined,
    collection_target_amount: formatMoney(row.latest_collection_target_amount),
    collection_amount_raised: formatMoney(row.latest_collection_amount_raised),
  };
}

/**
 * Batch-resolves merge data for a set of already-materialized recipients
 * (rows from email_campaign_recipients: { id, user_id, email, campaign_id }).
 * ONE query for the whole batch (not N+1) — this is the path used by the
 * send queue, so it has to stay cheap at bulk-send volume. A single claimed
 * batch can span more than one campaign (the atomic claim in
 * jobs/emailCampaignQueue.js doesn't group by campaign), so each
 * recipient's own campaign_id is used for its unsubscribe link, not a
 * single shared id.
 *
 * Returns a Map keyed by the recipient row's own id.
 */
export async function buildMergeDataMapForRecipients(recipients) {
  const system = buildSystemMergeData();
  const userIds = [...new Set(recipients.filter((r) => r.user_id).map((r) => r.user_id))];

  let directoryById = new Map();
  if (userIds.length > 0) {
    const { data, error } = await supabase.from('email_recipient_directory').select('*').in('id', userIds);
    if (error) {
      log.warn('merge-tags.directory_batch_fetch_failed', { err: error, count: userIds.length });
    } else {
      directoryById = new Map((data || []).map((row) => [row.id, row]));
    }
  }

  const map = new Map();
  for (const recipient of recipients) {
    const directoryRow = recipient.user_id ? directoryById.get(recipient.user_id) : null;
    const base = directoryRow ? mapDirectoryRowToMergeData(directoryRow) : { email: recipient.email };
    map.set(recipient.id, {
      ...system,
      ...base,
      email: base.email || recipient.email,
      unsubscribe_link: buildUnsubscribeLink(recipient.email, recipient.campaign_id),
    });
  }
  return map;
}

/**
 * Resolves merge data for a single email address — used by "Preview As
 * Recipient" and by test-sends that target a real recipient. Looks the
 * email up in email_recipient_directory; if it's not a known profile
 * (e.g. a manually-added address), falls back to just { email }.
 */
export async function buildMergeDataForEmail(email, campaignId) {
  const system = buildSystemMergeData();
  const { data, error } = await supabase
    .from('email_recipient_directory')
    .select('*')
    .ilike('email', email)
    .maybeSingle();

  if (error) {
    log.warn('merge-tags.single_fetch_failed', { err: error, email });
  }

  const base = data ? mapDirectoryRowToMergeData(data) : { email };
  return {
    ...system,
    ...base,
    email: base.email || email,
    unsubscribe_link: buildUnsubscribeLink(email, campaignId),
  };
}

/**
 * Sample data for previews/test-sends with no specific recipient selected
 * — clearly-fake values so nobody mistakes them for a real person's data.
 */
export function buildSampleMergeData() {
  return {
    ...buildSystemMergeData(),
    first_name: 'Jordan',
    last_name: 'Ade',
    full_name: 'Jordan Ade',
    email: 'jordan.ade@example.com',
    phone: '+234 801 234 5678',
    registration_date: formatDate(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)),
    referral_code: 'ABC123',
    available_earnings: formatMoney(12000),
    pending_earnings: formatMoney(3000),
    total_earnings: formatMoney(15000),
    badge: 'Ambassador',
    collections_created: '3',
    total_amount_processed: formatMoney(450000),
    collection_title: 'Sample Fundraiser',
    collection_target_amount: formatMoney(500000),
    collection_amount_raised: formatMoney(320000),
    unsubscribe_link: buildUnsubscribeLink('jordan.ade@example.com', null),
  };
}
