import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import validator from 'validator';
import { supabase } from '../utils/client.js';
import { sendAmbassadorEmail } from '../utils/ambassadorEmailer.js';
import {
  calculateBadges,
  calculateOrganizerReward,
  getAmbassadorRank,
  normalizeApplicationStatus,
  PROGRESSION_BADGES,
  serializeAmbassadorCode,
} from '../services/ambassadorProgram.js';
import { decryptAccountNumber } from '../utils/accountCrypto.js';
import { applicationReceivedTemplate } from '../templates/ambassador/applicationReceived.js';
import { interviewScheduledTemplate } from '../templates/ambassador/interviewScheduled.js';
import { acceptedTemplate } from '../templates/ambassador/accepted.js';
import { rejectedTemplate } from '../templates/ambassador/rejected.js';
import { suspendedTemplate } from '../templates/ambassador/suspended.js';
import { reactivatedTemplate } from '../templates/ambassador/reactivated.js';
import { withdrawalRequestedTemplate } from '../templates/ambassador/withdrawalRequested.js';
import { withdrawalApprovedTemplate } from '../templates/ambassador/withdrawalApproved.js';
import { withdrawalPaidTemplate } from '../templates/ambassador/withdrawalPaid.js';

const SESSION_SECRET =
  process.env.AMBASSADOR_JWT_SECRET ||
  process.env.JWT_SECRET ||
  process.env.SUPABASE_JWT_SECRET ||
  'kolekto-ambassador-dev-secret';
const RESOURCE_BUCKET = 'ambassador-resources';
const WITHDRAWAL_REQUEST_STATUSES = ['pending', 'approved'];
const IV_LENGTH = 16;

function cleanString(value) {
  return String(value || '').trim();
}

function normalizeEmail(value) {
  return cleanString(value).toLowerCase();
}

function validationError(res, message, field) {
  return res.status(400).json({ error: message, field });
}

function cleanPin(value) {
  return cleanString(value).replace(/\D/g, '');
}

function normalizeAmbassadorCode(value) {
  return cleanString(value).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6);
}

function getEncryptionKeyBuffer() {
  const raw = process.env.ACCOUNT_ENCRYPTION_KEY;
  if (!raw) return null;
  let buffer = Buffer.from(raw, 'utf8');
  if (buffer.length !== 32 && /^[0-9a-fA-F]{64}$/.test(raw)) {
    buffer = Buffer.from(raw, 'hex');
  }
  if (buffer.length === 32) return buffer;
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

function encryptAccountNumber(text) {
  const keyBuffer = getEncryptionKeyBuffer();
  if (!keyBuffer) throw new Error('ACCOUNT_ENCRYPTION_KEY is not configured');

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', keyBuffer, iv);
  const encrypted = Buffer.concat([
    cipher.update(String(text), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, encrypted]).toString('base64');
}

function normalizeAccountNumber(value) {
  return cleanString(value).replace(/\D/g, '').slice(0, 10);
}

function serializePayoutAccount(row) {
  return {
    id: row.id,
    bankName: row.bank_name,
    bankCode: row.bank_code,
    accountName: row.account_name,
    accountLast4: row.account_last4,
    isDefault: Boolean(row.is_default),
    status: row.status,
    createdAt: row.created_at,
  };
}

function serializeAmbassadorWithdrawal(row) {
  return {
    id: row.id,
    payoutAccountId: row.payout_account_id,
    amount: Number(row.amount || 0),
    status: row.status,
    adminNotes: row.admin_notes,
    requestedAt: row.requested_at,
    processedAt: row.processed_at,
    createdAt: row.created_at,
  };
}

function validatePin(pin, res, field = 'pin') {
  if (!pin) return validationError(res, 'PIN is required', field);
  if (!/^\d{4,6}$/.test(pin)) {
    return validationError(res, 'PIN must be 4 to 6 digits', field);
  }
  return null;
}

function parseBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
}

function parseInteger(value, fallback = 100) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

function normalizeResourcePayload(body = {}) {
  return {
    title: cleanString(body.title),
    description: cleanString(body.description),
    category: cleanString(body.category) || 'training',
    external_url: cleanString(body.external_url || body.externalUrl) || null,
    is_active: parseBoolean(body.is_active ?? body.isActive, true),
    sort_order: parseInteger(body.sort_order ?? body.sortOrder, 100),
  };
}

function sanitizeFilename(filename = 'resource') {
  const parts = String(filename).split('.');
  const extension = parts.length > 1 ? `.${parts.pop().replace(/[^a-zA-Z0-9]/g, '').slice(0, 10)}` : '';
  const base = parts.join('.').replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 80) || 'resource';
  return `${base}${extension}`;
}

async function ensureResourceBucket() {
  const { error } = await supabase.storage.createBucket(RESOURCE_BUCKET, {
    public: true,
    fileSizeLimit: 15 * 1024 * 1024,
  });

  if (error && !/already exists/i.test(error.message || '')) throw error;
}

async function uploadResourceFile(file) {
  if (!file) return null;
  await ensureResourceBucket();

  const path = `resources/${Date.now()}-${sanitizeFilename(file.originalname)}`;
  const { error } = await supabase.storage
    .from(RESOURCE_BUCKET)
    .upload(path, file.buffer, {
      contentType: file.mimetype || 'application/octet-stream',
      upsert: false,
    });

  if (error) throw error;

  const { data } = supabase.storage.from(RESOURCE_BUCKET).getPublicUrl(path);
  return data?.publicUrl || null;
}

function normalizeApplicationPayload(body = {}) {
  const communitySize = Number(body.community_size || body.communitySize || 0);
  return {
    full_name: cleanString(body.full_name || body.fullName),
    email: normalizeEmail(body.email),
    phone_number: cleanString(body.phone_number || body.phoneNumber),
    state: cleanString(body.state),
    city: cleanString(body.city),
    school_organization: cleanString(body.school_organization || body.schoolOrganization),
    social_links: cleanString(body.social_links || body.socialLinks),
    community_size: Number.isFinite(communitySize) && communitySize > 0 ? Math.round(communitySize) : null,
    leadership_experience: cleanString(body.leadership_experience || body.leadershipExperience),
    motivation: cleanString(body.motivation || body.why || body.whyAmbassador),
    promotion_plan: cleanString(body.promotion_plan || body.promotionPlan),
    previous_experience: cleanString(body.previous_experience || body.previousExperience),
  };
}

function validateApplication(payload, res) {
  if (!payload.full_name) return validationError(res, 'Full name is required', 'full_name');
  if (!payload.email || !validator.isEmail(payload.email)) return validationError(res, 'A valid email is required', 'email');
  if (!payload.phone_number) return validationError(res, 'Phone number is required', 'phone_number');
  if (!payload.state) return validationError(res, 'State is required', 'state');
  if (!payload.city) return validationError(res, 'City is required', 'city');
  if (!payload.school_organization) return validationError(res, 'School or organization is required', 'school_organization');
  if (!payload.community_size) return validationError(res, 'Community size is required', 'community_size');
  if (payload.motivation.length < 20) return validationError(res, 'Tell us more about why you want to become an ambassador', 'motivation');
  if (payload.promotion_plan.length < 20) return validationError(res, 'Tell us more about how you would promote Kolekto', 'promotion_plan');
  return null;
}

async function getNextAmbassadorCode(fullName = '') {
  for (let offset = 0; offset < 800; offset += 1) {
    const code = serializeAmbassadorCode(offset, fullName);
    const { data, error: lookupError } = await supabase
      .from('ambassador_profiles')
      .select('id')
      .eq('ambassador_code', code)
      .maybeSingle();

    if (lookupError) throw lookupError;
    if (!data) return code;
  }

  throw new Error('Unable to generate a unique ambassador code');
}

async function createAmbassadorProfileFromApplication(application) {
  const code = await getNextAmbassadorCode(application.full_name);
  const { data: createdProfile, error } = await supabase
    .from('ambassador_profiles')
    .insert([{
      application_id: application.id,
      full_name: application.full_name,
      email: application.email,
      phone_number: application.phone_number,
      state: application.state,
      city: application.city,
      school_organization: application.school_organization,
      ambassador_code: code,
      status: 'accepted',
      rank: 'Ambassador',
      activated_at: new Date().toISOString(),
    }])
    .select('*')
    .single();

  if (error) throw error;
  return createdProfile;
}

async function ensureAmbassadorProfile(application) {
  const { data: existingProfile, error } = await supabase
    .from('ambassador_profiles')
    .select('*')
    .eq('application_id', application.id)
    .maybeSingle();

  if (error) throw error;
  if (existingProfile) return existingProfile;
  if (application.status !== 'accepted') return null;

  return createAmbassadorProfileFromApplication(application);
}

async function sendAmbassadorAcceptanceEmail(application, profile) {
  if (!application?.email || !profile?.ambassador_code) return;

  const portalUrl = `${process.env.FRONTEND_URL || 'https://www.kolekto.com.ng'}/ambassador/login`;
  const referralUrl = `${process.env.FRONTEND_URL || 'https://www.kolekto.com.ng'}/register?ref=${encodeURIComponent(profile.ambassador_code)}`;
  const message = acceptedTemplate({
    fullName: application.full_name,
    ambassadorCode: profile.ambassador_code,
    rank: profile.rank,
    portalUrl,
    referralUrl,
  });

  await sendAmbassadorEmail({
    to: application.email,
    subject: message.subject,
    text: message.text,
    html: message.html,
    eventType: 'accepted',
    ambassadorId: profile.id,
    applicationId: application.id,
  });
}

async function loadProfileById(id) {
  const { data, error } = await supabase
    .from('ambassador_profiles')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function loadOrganizerRows(ambassadorId) {
  const { data, error } = await supabase
    .from('ambassador_influenced_organizers')
    .select('*')
    .eq('ambassador_id', ambassadorId)
    .order('last_activity_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

async function getAvailableAmbassadorWithdrawalAmount(profile) {
  const organizerRows = await loadOrganizerRows(profile.id);
  const overview = buildOverview(profile, organizerRows);

  const { data: withdrawals, error } = await supabase
    .from('ambassador_withdrawals')
    .select('amount, status')
    .eq('ambassador_id', profile.id)
    .in('status', WITHDRAWAL_REQUEST_STATUSES);

  if (error) throw error;

  const reserved = (withdrawals || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
  return Math.max(0, Number(overview.metrics.availableEarnings || 0) - reserved);
}

function serializeOrganizerRow(row) {
  const reward = calculateOrganizerReward(row.processed_amount_internal, row.reward_paid);
  return {
    id: row.id,
    organizerId: row.organizer_id || null,
    organizerName: row.organizer_name || 'Organizer',
    organizerEmail: row.organizer_email || null,
    earningsGenerated: reward.generated,  // always ≥ ₦2,000 (earned from day one)
    earningsAvailable: reward.available,  // unlocked & not yet paid
    earningsLocked: reward.locked,        // earned but waiting for ₦500k threshold
    earningsPaid: Number(row.reward_paid || 0),
    rewardProgress: reward.maxProgress,
    unlockProgress: reward.unlockProgress,
    rewardStatus: reward.status,
    remainingToUnlock: reward.remainingToUnlock,
    remainingToMax: reward.remainingToMax,
    collectionsInfluenced: Number(row.collections_influenced || 0),
    joinedAt: row.first_influenced_at,
    lastActivityAt: row.last_activity_at,
    isActive: row.status === 'active',
  };
}

function buildOverview(profile, organizerRows = []) {
  const organizers = organizerRows.map(serializeOrganizerRow);

  const totalEarnings = organizers.reduce((sum, row) => sum + row.earningsGenerated, 0);
  const availableEarnings = organizers.reduce((sum, row) => sum + row.earningsAvailable, 0);
  // pendingEarnings = sum of locked rewards (earned but waiting for unlock threshold)
  const pendingEarnings = organizers.reduce((sum, row) => sum + row.earningsLocked, 0);
  const totalCollections = organizers.reduce((sum, row) => sum + row.collectionsInfluenced, 0);
  const rank = getAmbassadorRank(totalCollections || profile.total_collections_influenced || 0);

  return {
    profile: {
      id: profile.id,
      fullName: profile.full_name,
      email: profile.email,
      phoneNumber: profile.phone_number,
      state: profile.state,
      city: profile.city,
      schoolOrganization: profile.school_organization,
      ambassadorCode: profile.ambassador_code,
      status: profile.status,
      rank,
      activatedAt: profile.activated_at,
      lastActiveAt: profile.last_active_at,
    },
    metrics: {
      totalOrganizersInfluenced: organizers.length || profile.total_organizers_influenced || 0,
      totalCollectionsInfluenced: totalCollections || profile.total_collections_influenced || 0,
      totalEarnings,
      pendingEarnings,
      availableEarnings,
      // totalWithdrawn is NOT included here — callers that need it fetch
      // ambassador_withdrawals separately and augment the metrics object.
    },
    organizers,
  };
}

function formatAmbassadorSession(profile) {
  return {
    id: profile.id,
    fullName: profile.full_name,
    email: profile.email,
    ambassadorCode: profile.ambassador_code,
    status: profile.status,
    pinSet: Boolean(profile.pin_hash),
  };
}

function issueAmbassadorToken(profile) {
  return jwt.sign(
    { type: 'ambassador', ambassadorId: profile.id, email: profile.email, code: profile.ambassador_code },
    SESSION_SECRET,
    { expiresIn: '7d' }
  );
}

function getAmbassadorToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return req.cookies?.ambassador_access_token || null;
}

// Ambassador access must be denied for any status other than 'accepted', but
// rejected and suspended ambassadors need distinct, specific copy rather
// than a generic "access is not active" — this is the single source of
// truth for that copy, used by every enforcement point (middleware, sign-in,
// PIN setup) so the message can never drift between them.
function ambassadorStatusDenialPayload(status) {
  if (status === 'rejected') {
    return {
      error: 'Your ambassador application was not approved. Please contact support if you believe this is an error.',
      status: 'rejected',
    };
  }
  if (status === 'suspended') {
    return {
      error: 'Your ambassador account has been temporarily suspended. Please contact the Kolekto team for assistance.',
      status: 'suspended',
    };
  }
  return { error: 'Ambassador access is not active', status: status || null };
}

export async function verifyAmbassador(req, res, next) {
  const token = getAmbassadorToken(req);
  if (!token) return res.status(401).json({ error: 'Ambassador token required' });

  try {
    const decoded = jwt.verify(token, SESSION_SECRET);
    if (decoded?.type !== 'ambassador' || !decoded?.ambassadorId) {
      return res.status(401).json({ error: 'Invalid ambassador token' });
    }

    const profile = await loadProfileById(decoded.ambassadorId);
    if (!profile) return res.status(403).json(ambassadorStatusDenialPayload(null));
    if (profile.status !== 'accepted') {
      return res.status(403).json(ambassadorStatusDenialPayload(profile.status));
    }

    req.ambassador = profile;
    return next();
  } catch (_err) {
    return res.status(401).json({ error: 'Invalid or expired ambassador token' });
  }
}

export async function submitAmbassadorApplication(req, res) {
  try {
    const payload = normalizeApplicationPayload(req.body);
    const errorResponse = validateApplication(payload, res);
    if (errorResponse) return errorResponse;

    const { data: existing, error: existingError } = await supabase
      .from('ambassador_applications')
      .select('id, status')
      .eq('email', payload.email)
      .maybeSingle();

    if (existingError) throw existingError;
    if (existing) {
      return res.status(409).json({
        error: 'An ambassador application already exists for this email',
        status: existing.status,
      });
    }

    const { data, error } = await supabase
      .from('ambassador_applications')
      .insert([{ ...payload, status: 'pending' }])
      .select('*')
      .single();

    if (error) throw error;

    (async () => {
      try {
        const message = applicationReceivedTemplate({ fullName: data.full_name });
        await sendAmbassadorEmail({
          to: data.email,
          subject: message.subject,
          text: message.text,
          html: message.html,
          eventType: 'application_received',
          applicationId: data.id,
        });
      } catch (mailErr) {
        console.error('[ambassador] application received email failed:', mailErr?.message || mailErr);
      }
    })();

    return res.status(201).json({ message: 'Application submitted successfully', application: data });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to submit ambassador application', details: err.message });
  }
}

export async function ambassadorSignIn(req, res) {
  try {
    const email = normalizeEmail(req.body?.email);
    const code = normalizeAmbassadorCode(req.body?.ambassador_code || req.body?.ambassadorCode);
    const pin = cleanPin(req.body?.pin);

    if (!email || !validator.isEmail(email)) return validationError(res, 'A valid email is required', 'email');
    if (!code) return validationError(res, 'Ambassador code is required', 'ambassador_code');
    const pinError = validatePin(pin, res);
    if (pinError) return pinError;

    const { data: profile, error } = await supabase
      .from('ambassador_profiles')
      .select('*')
      .eq('email', email)
      .eq('ambassador_code', code)
      .maybeSingle();

    if (error) throw error;
    if (!profile) return res.status(401).json({ error: 'Invalid ambassador credentials' });
    if (profile.status !== 'accepted') return res.status(403).json(ambassadorStatusDenialPayload(profile.status));
    if (!profile.pin_hash) {
      return res.status(409).json({ error: 'Please set your ambassador PIN before signing in', requiresPinSetup: true });
    }

    const pinMatches = await bcrypt.compare(pin, profile.pin_hash);
    if (!pinMatches) return res.status(401).json({ error: 'Invalid ambassador credentials' });

    await supabase
      .from('ambassador_profiles')
      .update({ last_login_at: new Date().toISOString(), last_active_at: new Date().toISOString() })
      .eq('id', profile.id);

    return res.json({
      token: issueAmbassadorToken(profile),
      ambassador: formatAmbassadorSession(profile),
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to sign in ambassador', details: err.message });
  }
}

export async function setupAmbassadorPin(req, res) {
  try {
    const email = normalizeEmail(req.body?.email);
    const code = normalizeAmbassadorCode(req.body?.ambassador_code || req.body?.ambassadorCode);
    const pin = cleanPin(req.body?.pin);
    const confirmPin = cleanPin(req.body?.confirm_pin || req.body?.confirmPin);

    if (!email || !validator.isEmail(email)) return validationError(res, 'A valid email is required', 'email');
    if (!code) return validationError(res, 'Ambassador code is required', 'ambassador_code');
    const pinError = validatePin(pin, res);
    if (pinError) return pinError;
    if (pin !== confirmPin) return validationError(res, 'PIN confirmation does not match', 'confirm_pin');

    const { data: profile, error } = await supabase
      .from('ambassador_profiles')
      .select('*')
      .eq('email', email)
      .eq('ambassador_code', code)
      .maybeSingle();

    if (error) throw error;
    if (!profile) return res.status(401).json({ error: 'Invalid ambassador credentials' });
    if (profile.status !== 'accepted') return res.status(403).json(ambassadorStatusDenialPayload(profile.status));
    if (profile.pin_hash) return res.status(409).json({ error: 'A PIN has already been set for this ambassador account' });

    const pinHash = await bcrypt.hash(pin, 12);
    const { data: updatedProfile, error: updateError } = await supabase
      .from('ambassador_profiles')
      .update({
        pin_hash: pinHash,
        pin_set_at: new Date().toISOString(),
        last_login_at: new Date().toISOString(),
        last_active_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', profile.id)
      .select('*')
      .single();

    if (updateError) throw updateError;

    return res.json({
      message: 'Ambassador PIN set successfully',
      token: issueAmbassadorToken(updatedProfile),
      ambassador: formatAmbassadorSession(updatedProfile),
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to set ambassador PIN', details: err.message });
  }
}

export function getAmbassadorMe(req, res) {
  return res.json({ ambassador: req.ambassador });
}

export async function getAmbassadorOverview(req, res) {
  try {
    const [organizerRows, withdrawalsRes] = await Promise.all([
      loadOrganizerRows(req.ambassador.id),
      supabase
        .from('ambassador_withdrawals')
        .select('amount, status')
        .eq('ambassador_id', req.ambassador.id),
    ]);

    const overview = buildOverview(req.ambassador, organizerRows);
    const wRows = withdrawalsRes.data || [];

    const totalWithdrawn = wRows
      .filter((w) => w.status === 'paid')
      .reduce((sum, w) => sum + Number(w.amount || 0), 0);

    // Subtract in-flight (pending + approved) requests from available so the
    // dashboard Available figure matches what the ambassador can actually withdraw.
    const inFlight = wRows
      .filter((w) => w.status === 'pending' || w.status === 'approved')
      .reduce((sum, w) => sum + Number(w.amount || 0), 0);

    return res.json({
      ...overview,
      metrics: {
        ...overview.metrics,
        availableEarnings: Math.max(0, (overview.metrics.availableEarnings || 0) - inFlight),
        totalWithdrawn,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load ambassador overview', details: err.message });
  }
}

export async function getAmbassadorEarnings(req, res) {
  try {
    const [rows, withdrawalsRes] = await Promise.all([
      loadOrganizerRows(req.ambassador.id),
      supabase
        .from('ambassador_withdrawals')
        .select('amount, status')
        .eq('ambassador_id', req.ambassador.id),
    ]);

    const organizers = rows.map(serializeOrganizerRow);
    const wRows = withdrawalsRes.data || [];

    const totalEarnings = organizers.reduce((sum, o) => sum + o.earningsGenerated, 0);
    const rawAvailable = organizers.reduce((sum, o) => sum + o.earningsAvailable, 0);
    // pendingEarnings = sum of locked amounts (earned but waiting for unlock threshold)
    const pendingEarnings = organizers.reduce((sum, o) => sum + o.earningsLocked, 0);

    const totalWithdrawn = wRows
      .filter((w) => w.status === 'paid')
      .reduce((sum, w) => sum + Number(w.amount || 0), 0);

    const inFlight = wRows
      .filter((w) => w.status === 'pending' || w.status === 'approved')
      .reduce((sum, w) => sum + Number(w.amount || 0), 0);

    return res.json({
      organizers,
      summary: {
        totalEarnings,
        availableEarnings: Math.max(0, rawAvailable - inFlight),
        pendingEarnings,
        totalWithdrawn,
        totalOrganizers: organizers.length,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load ambassador earnings', details: err.message });
  }
}

export async function getAmbassadorBadges(req, res) {
  try {
    const rows = await loadOrganizerRows(req.ambassador.id);
    const collectionsInfluenced = rows.reduce((sum, row) => sum + Number(row.collections_influenced || 0), 0);
    const largestCollectionAmount = rows.reduce((max, row) => Math.max(max, Number(row.largest_collection_amount_internal || 0)), 0);

    const badges = calculateBadges({
      collectionsInfluenced,
      largestCollectionAmount,
      weeklyActivityStreak: req.ambassador.weekly_activity_streak || 0,
      studentImpactEvents: req.ambassador.student_impact_events || 0,
      charityCollectionAmount: req.ambassador.charity_collection_amount_internal || 0,
      newCommunitiesOpened: req.ambassador.new_communities_opened || 0,
    });

    return res.json({ badges });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load ambassador badges', details: err.message });
  }
}

export async function getAmbassadorLeaderboard(req, res) {
  try {
    // Fetch ALL accepted ambassadors to compute true ranks across the full cohort.
    // No LIMIT — we need every ambassador's position so the current user's rank
    // can be returned even when they fall outside the public top-20.
    //
    // Sort order (primary → tie-breakers):
    //   1. total_processed_amount_internal DESC  — highest collection volume
    //   2. total_organizers_influenced DESC       — most referrals
    //   3. total_collections_influenced DESC      — badge proxy (more collections = more badges)
    //   4. activated_at ASC                       — earliest ambassador wins any remaining tie
    const { data, error } = await supabase
      .from('ambassador_profiles')
      .select('id, full_name, state, school_organization, total_organizers_influenced, total_collections_influenced, total_processed_amount_internal, activated_at')
      .eq('status', 'accepted')
      .order('total_processed_amount_internal', { ascending: false })
      .order('total_organizers_influenced', { ascending: false })
      .order('total_collections_influenced', { ascending: false })
      .order('activated_at', { ascending: true });

    if (error) throw error;

    const rows = data || [];

    // Assign deterministic dense ranks — ambassadors with identical metrics share a rank.
    // All four sort columns must match for a tie.
    const ranked = [];
    let rank = 0;
    for (let i = 0; i < rows.length; i++) {
      const prev = rows[i - 1];
      const cur = rows[i];
      const tied =
        prev &&
        cur.total_processed_amount_internal === prev.total_processed_amount_internal &&
        cur.total_organizers_influenced === prev.total_organizers_influenced &&
        cur.total_collections_influenced === prev.total_collections_influenced &&
        cur.activated_at === prev.activated_at;
      if (!tied) rank = i + 1;

      const collectionsCount = cur.total_collections_influenced || 0;
      const badgeCount = PROGRESSION_BADGES.filter((b) => collectionsCount >= b.requirement).length;
      const leadershipLevel = getAmbassadorRank(collectionsCount);

      ranked.push({
        _ambId: cur.id,
        rank,
        name: cur.full_name,
        state: cur.state,
        campus: cur.school_organization,
        organizersInfluenced: cur.total_organizers_influenced || 0,
        badgeCount,
        leadershipLevel,
        isCurrentAmbassador: cur.id === req.ambassador.id,
      });
    }

    // Top 20 visible on the leaderboard — strip internal _ambId before sending.
    const leaderboard = ranked.slice(0, 20).map(({ _ambId, ...rest }) => rest);

    // Current user's own rank (may be position 21+ if they're not in the top 20).
    const myEntry = ranked.find((r) => r._ambId === req.ambassador.id);
    const myRank = myEntry
      ? {
          rank: myEntry.rank,
          name: myEntry.name,
          leadershipLevel: myEntry.leadershipLevel,
          organizersInfluenced: myEntry.organizersInfluenced,
          badgeCount: myEntry.badgeCount,
          isInTopTwenty: myEntry.rank <= 20,
        }
      : null;

    return res.json({ leaderboard, myRank });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load ambassador leaderboard', details: err.message });
  }
}

export async function getAmbassadorResources(req, res) {
  try {
    const { data, error } = await supabase
      .from('ambassador_resources')
      .select('*')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (error) throw error;
    return res.json({ resources: data || [] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load ambassador resources', details: err.message });
  }
}

export async function getAmbassadorPayoutAccounts(req, res) {
  try {
    const { data, error } = await supabase
      .from('ambassador_payout_accounts')
      .select('id, bank_name, bank_code, account_name, account_last4, is_default, status, created_at')
      .eq('ambassador_id', req.ambassador.id)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false });

    if (error) throw error;

    const availableAmount = await getAvailableAmbassadorWithdrawalAmount(req.ambassador);
    return res.json({
      accounts: (data || []).map(serializePayoutAccount),
      availableAmount,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load payout accounts', details: err.message });
  }
}

export async function saveAmbassadorPayoutAccount(req, res) {
  try {
    const bankName = cleanString(req.body?.bank_name || req.body?.bankName);
    const bankCode = cleanString(req.body?.bank_code || req.body?.bankCode);
    const accountName = cleanString(req.body?.account_name || req.body?.accountName);
    const accountNumber = normalizeAccountNumber(req.body?.account_number || req.body?.accountNumber);

    if (!bankName) return validationError(res, 'Bank name is required', 'bank_name');
    if (!accountName) return validationError(res, 'Account name is required', 'account_name');
    if (!/^\d{10}$/.test(accountNumber)) return validationError(res, 'Enter a valid 10 digit account number', 'account_number');

    const { data: existingAccounts, error: existingError } = await supabase
      .from('ambassador_payout_accounts')
      .select('id')
      .eq('ambassador_id', req.ambassador.id);

    if (existingError) throw existingError;

    const isFirstAccount = (existingAccounts || []).length === 0;
    const { data, error } = await supabase
      .from('ambassador_payout_accounts')
      .insert([{
        ambassador_id: req.ambassador.id,
        bank_name: bankName,
        bank_code: bankCode || null,
        account_name: accountName,
        account_last4: accountNumber.slice(-4),
        account_number_cipher: encryptAccountNumber(accountNumber),
        is_default: isFirstAccount,
        status: 'active',
      }])
      .select('id, bank_name, bank_code, account_name, account_last4, is_default, status, created_at')
      .single();

    if (error) throw error;
    return res.status(201).json({ message: 'Payout account saved', account: serializePayoutAccount(data) });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to save payout account', details: err.message });
  }
}

export async function getAmbassadorWithdrawals(req, res) {
  try {
    const { data, error } = await supabase
      .from('ambassador_withdrawals')
      .select('id, payout_account_id, amount, status, admin_notes, requested_at, processed_at, created_at')
      .eq('ambassador_id', req.ambassador.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const availableAmount = await getAvailableAmbassadorWithdrawalAmount(req.ambassador);
    return res.json({
      withdrawals: (data || []).map(serializeAmbassadorWithdrawal),
      availableAmount,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load withdrawals', details: err.message });
  }
}

export async function requestAmbassadorWithdrawal(req, res) {
  try {
    const payoutAccountId = cleanString(req.body?.payout_account_id || req.body?.payoutAccountId);
    const amount = Number(req.body?.amount);

    if (!payoutAccountId) return validationError(res, 'Select a payout account', 'payout_account_id');
    if (!Number.isFinite(amount) || amount <= 0) return validationError(res, 'Withdrawal amount must be greater than zero', 'amount');

    const { data: payoutAccount, error: accountError } = await supabase
      .from('ambassador_payout_accounts')
      .select('id, status, bank_name, account_number_cipher')
      .eq('id', payoutAccountId)
      .eq('ambassador_id', req.ambassador.id)
      .maybeSingle();

    if (accountError) throw accountError;
    if (!payoutAccount || payoutAccount.status !== 'active') {
      return res.status(400).json({ error: 'Select an active payout account' });
    }

    const availableAmount = await getAvailableAmbassadorWithdrawalAmount(req.ambassador);
    if (amount > availableAmount) {
      return res.status(400).json({
        error: `Available withdrawal balance is ${availableAmount.toLocaleString('en-NG', { style: 'currency', currency: 'NGN' })}`,
        availableAmount,
      });
    }

    const { data, error } = await supabase
      .from('ambassador_withdrawals')
      .insert([{
        ambassador_id: req.ambassador.id,
        payout_account_id: payoutAccount.id,
        amount,
        status: 'pending',
      }])
      .select('id, payout_account_id, amount, status, admin_notes, requested_at, processed_at, created_at')
      .single();

    if (error) throw error;

    (async () => {
      try {
        const message = withdrawalRequestedTemplate({
          fullName: req.ambassador.full_name,
          amount: data.amount,
          bankName: payoutAccount.bank_name,
          accountNumber: decryptAccountNumber(payoutAccount.account_number_cipher),
          requestedAt: data.requested_at || data.created_at,
        });
        await sendAmbassadorEmail({
          to: req.ambassador.email,
          subject: message.subject,
          text: message.text,
          html: message.html,
          eventType: 'withdrawal_requested',
          ambassadorId: req.ambassador.id,
          withdrawalId: data.id,
        });
      } catch (mailErr) {
        console.error('[ambassador] withdrawal requested email failed:', mailErr?.message || mailErr);
      }
    })();

    return res.status(201).json({
      message: 'Withdrawal request submitted',
      withdrawal: serializeAmbassadorWithdrawal(data),
      availableAmount: Math.max(0, availableAmount - amount),
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to request withdrawal', details: err.message });
  }
}

export async function listAdminAmbassadorResources(req, res) {
  try {
    const { data, error } = await supabase
      .from('ambassador_resources')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json({ resources: data || [] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load ambassador resources', details: err.message });
  }
}

export async function createAdminAmbassadorResource(req, res) {
  try {
    const payload = normalizeResourcePayload(req.body);
    if (!payload.title) return validationError(res, 'Resource title is required', 'title');
    if (!req.file && !payload.external_url) {
      return validationError(res, 'Upload a file or provide an external URL', 'resource');
    }

    const fileUrl = await uploadResourceFile(req.file);
    const { data, error } = await supabase
      .from('ambassador_resources')
      .insert([{
        ...payload,
        file_url: fileUrl,
      }])
      .select('*')
      .single();

    if (error) throw error;
    return res.status(201).json({ message: 'Ambassador resource uploaded', resource: data });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to upload ambassador resource', details: err.message });
  }
}

export async function updateAdminAmbassadorResource(req, res) {
  try {
    const payload = normalizeResourcePayload(req.body);
    const update = {
      ...payload,
      updated_at: new Date().toISOString(),
    };

    if (req.file) update.file_url = await uploadResourceFile(req.file);

    const { data, error } = await supabase
      .from('ambassador_resources')
      .update(update)
      .eq('id', req.params.id)
      .select('*')
      .single();

    if (error) throw error;
    return res.json({ message: 'Ambassador resource updated', resource: data });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update ambassador resource', details: err.message });
  }
}

export async function deleteAdminAmbassadorResource(req, res) {
  try {
    const { data, error } = await supabase
      .from('ambassador_resources')
      .delete()
      .eq('id', req.params.id)
      .select('id')
      .single();

    if (error) throw error;
    return res.json({ message: 'Ambassador resource removed', resource: data });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to remove ambassador resource', details: err.message });
  }
}

export async function listAmbassadorApplications(req, res) {
  try {
    const status = normalizeApplicationStatus(req.query?.status);
    let query = supabase
      .from('ambassador_applications')
      .select('*')
      .order('created_at', { ascending: false });

    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw error;
    return res.json({ applications: data || [] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load ambassador applications', details: err.message });
  }
}

export async function getAmbassadorApplication(req, res) {
  try {
    const { data, error } = await supabase
      .from('ambassador_applications')
      .select('*, ambassador_profiles(id, ambassador_code, status, rank, pin_set_at, activated_at)')
      .eq('id', req.params.id)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Application not found' });
    return res.json({ application: data });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load ambassador application', details: err.message });
  }
}

export async function getAdminAmbassadorOverview(req, res) {
  try {
    const application = await fetchApplication(req.params.id);
    if (!application) return res.status(404).json({ error: 'Application not found' });

    const profile = await ensureAmbassadorProfile(application);
    if (!profile) return res.status(404).json({ error: 'Ambassador profile has not been created yet' });

    const organizers = await loadOrganizerRows(profile.id);
    return res.json({
      application,
      overview: buildOverview(profile, organizers),
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load ambassador overview', details: err.message });
  }
}

export async function getAdminAmbassadorDetail(req, res) {
  try {
    const application = await fetchApplication(req.params.id);
    if (!application) return res.status(404).json({ error: 'Application not found' });

    const profile = await ensureAmbassadorProfile(application);
    if (!profile) return res.status(404).json({ error: 'Ambassador profile has not been created yet' });

    const organizerRows = await loadOrganizerRows(profile.id);
    const organizerIds = organizerRows.map((row) => row.organizer_id).filter(Boolean);

    const [
      organizerProfilesRes,
      collectionsRes,
      payoutAccountsRes,
      organizerWithdrawalsRes,
      ambassadorPayoutAccountsRes,
      ambassadorWithdrawalsRes,
    ] = await Promise.all([
      organizerIds.length
        ? supabase
            .from('profiles')
            .select('id, full_name, email, phone_number, created_at')
            .in('id', organizerIds)
        : Promise.resolve({ data: [], error: null }),
      organizerIds.length
        ? supabase
            .from('collections')
            .select('id, user_id, title, status, created_at')
            .in('user_id', organizerIds)
        : Promise.resolve({ data: [], error: null }),
      organizerIds.length
        ? supabase
            .from('payout_accounts')
            .select('id, user_id, bank_name, account_name, account_last4, is_default, created_at')
            .in('user_id', organizerIds)
        : Promise.resolve({ data: [], error: null }),
      organizerIds.length
        ? supabase
            .from('withdrawals')
            .select('id, user_id, collection_id, amount, status, destination_account, created_at')
            .in('user_id', organizerIds)
            .order('created_at', { ascending: false })
        : Promise.resolve({ data: [], error: null }),
      supabase
        .from('ambassador_payout_accounts')
        .select('id, bank_name, bank_code, account_name, account_last4, account_number_cipher, is_default, status, created_at')
        .eq('ambassador_id', profile.id)
        .order('created_at', { ascending: false }),
      supabase
        .from('ambassador_withdrawals')
        .select('id, payout_account_id, amount, status, admin_notes, requested_at, processed_at, created_at')
        .eq('ambassador_id', profile.id)
        .order('created_at', { ascending: false }),
    ]);

    const firstCoreError = [
      organizerProfilesRes.error,
      collectionsRes.error,
      payoutAccountsRes.error,
      organizerWithdrawalsRes.error,
    ].find(Boolean);
    if (firstCoreError) throw firstCoreError;

    if (ambassadorPayoutAccountsRes.error) {
      console.warn('[ambassador detail] payout accounts unavailable:', ambassadorPayoutAccountsRes.error.message);
    }
    if (ambassadorWithdrawalsRes.error) {
      console.warn('[ambassador detail] withdrawals unavailable:', ambassadorWithdrawalsRes.error.message);
    }

    const organizersById = new Map((organizerProfilesRes.data || []).map((row) => [row.id, row]));
    const collectionsByOrganizer = new Map();
    for (const collection of collectionsRes.data || []) {
      const list = collectionsByOrganizer.get(collection.user_id) || [];
      list.push(collection);
      collectionsByOrganizer.set(collection.user_id, list);
    }

    const accountsByOrganizer = new Map();
    for (const account of payoutAccountsRes.data || []) {
      const list = accountsByOrganizer.get(account.user_id) || [];
      list.push(account);
      accountsByOrganizer.set(account.user_id, list);
    }

    const withdrawalsByOrganizer = new Map();
    for (const withdrawal of organizerWithdrawalsRes.data || []) {
      const list = withdrawalsByOrganizer.get(withdrawal.user_id) || [];
      list.push(withdrawal);
      withdrawalsByOrganizer.set(withdrawal.user_id, list);
    }

    const organizers = organizerRows.map((row) => {
      const organizer = organizersById.get(row.organizer_id) || {};
      const reward = calculateOrganizerReward(row.processed_amount_internal, row.reward_paid);
      return {
        id: row.id,
        organizerId: row.organizer_id,
        name: row.organizer_name || organizer.full_name || 'Organizer',
        email: row.organizer_email || organizer.email || null,
        phoneNumber: organizer.phone_number || null,
        joinedAt: organizer.created_at || row.first_influenced_at,
        collectionsInfluenced: row.collections_influenced || 0,
        rewardStatus: reward.status,
        earningsGenerated: reward.generated,
        earningsAvailable: reward.available,
        earningsLocked: reward.locked,   // earned but waiting for ₦500k threshold
        unlockProgress: reward.unlockProgress,
        remainingToUnlock: reward.remainingToUnlock,
        rewardProgress: reward.maxProgress,
        connectedAccounts: accountsByOrganizer.get(row.organizer_id) || [],
        withdrawals: withdrawalsByOrganizer.get(row.organizer_id) || [],
        collections: collectionsByOrganizer.get(row.organizer_id) || [],
      };
    });

    const baseOverview = buildOverview(profile, organizerRows);
    const withdrawalRows = ambassadorWithdrawalsRes.error ? [] : (ambassadorWithdrawalsRes.data || []);

    const totalWithdrawn = withdrawalRows
      .filter((w) => w.status === 'paid')
      .reduce((sum, w) => sum + Number(w.amount || 0), 0);

    const inFlight = withdrawalRows
      .filter((w) => w.status === 'pending' || w.status === 'approved')
      .reduce((sum, w) => sum + Number(w.amount || 0), 0);

    return res.json({
      application,
      profile: {
        ...baseOverview.profile,
        pinSet: Boolean(profile.pin_hash),
        lastLoginAt: profile.last_login_at,
      },
      metrics: {
        ...baseOverview.metrics,
        availableEarnings: Math.max(0, (baseOverview.metrics.availableEarnings || 0) - inFlight),
        totalWithdrawn,
      },
      organizers,
      ambassadorPayoutAccounts: ambassadorPayoutAccountsRes.error ? [] : (ambassadorPayoutAccountsRes.data || []).map((acct) => ({
        id: acct.id,
        bankName: acct.bank_name,
        bankCode: acct.bank_code,
        accountName: acct.account_name,
        accountLast4: acct.account_last4,
        accountNumber: decryptAccountNumber(acct.account_number_cipher) || null,
        isDefault: Boolean(acct.is_default),
        status: acct.status,
        createdAt: acct.created_at,
      })),
      ambassadorWithdrawals: withdrawalRows,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load ambassador detail', details: err.message });
  }
}

async function fetchApplication(id) {
  const { data, error } = await supabase
    .from('ambassador_applications')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) throw error;
  if (data) return data;

  const { data: profile, error: profileError } = await supabase
    .from('ambassador_profiles')
    .select('application_id')
    .eq('id', id)
    .maybeSingle();

  if (profileError) throw profileError;
  if (!profile?.application_id) return null;

  const { data: application, error: applicationError } = await supabase
    .from('ambassador_applications')
    .select('*')
    .eq('id', profile.application_id)
    .maybeSingle();

  if (applicationError) throw applicationError;
  return application;
}

async function updateApplication(id, payload) {
  const { data, error } = await supabase
    .from('ambassador_applications')
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

export async function scheduleAmbassadorInterview(req, res) {
  try {
    const interviewDate = cleanString(req.body?.interview_date || req.body?.interviewDate);
    if (!interviewDate) return validationError(res, 'Interview date is required', 'interview_date');

    const interviewTimezone = cleanString(req.body?.interview_timezone || req.body?.timezone) || null;
    const interviewLocation = cleanString(req.body?.interview_location || req.body?.location || req.body?.meeting_link) || null;
    const interviewPrepNotes = cleanString(req.body?.interview_prep_notes || req.body?.prep_notes) || null;

    const application = await updateApplication(req.params.id, {
      status: 'interview_scheduled',
      interview_date: interviewDate,
      interview_timezone: interviewTimezone,
      interview_location: interviewLocation,
      interview_prep_notes: interviewPrepNotes,
      admin_notes: cleanString(req.body?.notes) || null,
      reviewed_by: req.user?.id || null,
      reviewed_at: new Date().toISOString(),
    });

    (async () => {
      try {
        const message = interviewScheduledTemplate({
          fullName: application.full_name,
          interviewDate: application.interview_date,
          timezone: application.interview_timezone,
          location: application.interview_location,
          prepNotes: application.interview_prep_notes,
        });
        await sendAmbassadorEmail({
          to: application.email,
          subject: message.subject,
          text: message.text,
          html: message.html,
          eventType: 'interview_scheduled',
          applicationId: application.id,
        });
      } catch (mailErr) {
        console.error('[ambassador] interview scheduled email failed:', mailErr?.message || mailErr);
      }
    })();

    return res.json({ message: 'Interview scheduled', application });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to schedule interview', details: err.message });
  }
}

export async function acceptAmbassadorApplication(req, res) {
  try {
    const application = await fetchApplication(req.params.id);
    if (!application) return res.status(404).json({ error: 'Application not found' });

    const updatedApplication = await updateApplication(application.id, {
      status: 'accepted',
      reviewed_by: req.user?.id || null,
      reviewed_at: new Date().toISOString(),
      admin_notes: cleanString(req.body?.notes) || application.admin_notes || null,
    });

    let profile = await ensureAmbassadorProfile(updatedApplication);
    if (!profile) {
      throw new Error('Failed to create ambassador profile');
    }

    if (profile && profile.status !== 'accepted') {
      const { data: updatedProfile, error: updateProfileError } = await supabase
        .from('ambassador_profiles')
        .update({ status: 'accepted', updated_at: new Date().toISOString() })
        .eq('id', profile.id)
        .select('*')
        .single();
      if (updateProfileError) throw updateProfileError;
      profile = updatedProfile;
    }

    try {
      await sendAmbassadorAcceptanceEmail(updatedApplication, profile);
    } catch (mailError) {
      console.warn('[ambassador] acceptance email send failed:', mailError.message);
    }

    return res.json({
      message: 'Ambassador accepted',
      application: updatedApplication,
      profile,
      nextUrl: `/ambassadors/${updatedApplication.id}`,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to accept ambassador', details: err.message });
  }
}

export async function rejectAmbassadorApplication(req, res) {
  try {
    const application = await updateApplication(req.params.id, {
      status: 'rejected',
      reviewed_by: req.user?.id || null,
      reviewed_at: new Date().toISOString(),
      admin_notes: cleanString(req.body?.notes || req.body?.reason) || null,
    });

    // An application can be rejected after an ambassador profile already
    // exists (e.g. a previously-accepted ambassador is later rejected on
    // reconsideration) — without this, the profile stays status: 'accepted'
    // and the ambassador keeps full portal access despite the rejection.
    const { data: profile } = await supabase
      .from('ambassador_profiles')
      .update({ status: 'rejected', updated_at: new Date().toISOString() })
      .eq('application_id', application.id)
      .select('id')
      .maybeSingle();

    (async () => {
      try {
        const message = rejectedTemplate({ fullName: application.full_name });
        await sendAmbassadorEmail({
          to: application.email,
          subject: message.subject,
          text: message.text,
          html: message.html,
          eventType: 'rejected',
          applicationId: application.id,
          ambassadorId: profile?.id,
        });
      } catch (mailErr) {
        console.error('[ambassador] rejection email failed:', mailErr?.message || mailErr);
      }
    })();

    return res.json({ message: 'Application rejected', application });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reject application', details: err.message });
  }
}

export async function suspendAmbassador(req, res) {
  try {
    const reason = cleanString(req.body?.notes || req.body?.reason) || null;
    const application = await updateApplication(req.params.id, {
      status: 'suspended',
      reviewed_by: req.user?.id || null,
      reviewed_at: new Date().toISOString(),
      admin_notes: reason,
    });

    const { data: profile } = await supabase
      .from('ambassador_profiles')
      .update({ status: 'suspended', updated_at: new Date().toISOString() })
      .eq('application_id', application.id)
      .select('id')
      .maybeSingle();

    (async () => {
      try {
        const message = suspendedTemplate({ fullName: application.full_name, reason });
        await sendAmbassadorEmail({
          to: application.email,
          subject: message.subject,
          text: message.text,
          html: message.html,
          eventType: 'suspended',
          applicationId: application.id,
          ambassadorId: profile?.id,
        });
      } catch (mailErr) {
        console.error('[ambassador] suspension email failed:', mailErr?.message || mailErr);
      }
    })();

    return res.json({ message: 'Ambassador suspended', application });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to suspend ambassador', details: err.message });
  }
}

export async function reactivateAmbassador(req, res) {
  try {
    const application = await updateApplication(req.params.id, {
      status: 'accepted',
      reviewed_by: req.user?.id || null,
      reviewed_at: new Date().toISOString(),
      admin_notes: cleanString(req.body?.notes) || null,
    });

    const { data: profile, error } = await supabase
      .from('ambassador_profiles')
      .update({ status: 'accepted', updated_at: new Date().toISOString() })
      .eq('application_id', application.id)
      .select('*')
      .maybeSingle();

    if (error) throw error;

    (async () => {
      try {
        const portalUrl = `${process.env.FRONTEND_URL || 'https://www.kolekto.com.ng'}/ambassador/login`;
        const message = reactivatedTemplate({ fullName: application.full_name, portalUrl });
        await sendAmbassadorEmail({
          to: application.email,
          subject: message.subject,
          text: message.text,
          html: message.html,
          eventType: 'reactivated',
          applicationId: application.id,
          ambassadorId: profile?.id,
        });
      } catch (mailErr) {
        console.error('[ambassador] reactivation email failed:', mailErr?.message || mailErr);
      }
    })();

    return res.json({ message: 'Ambassador reactivated', application, profile });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reactivate ambassador', details: err.message });
  }
}

export async function addAmbassadorApplicationNote(req, res) {
  try {
    const notes = cleanString(req.body?.notes);
    if (!notes) return validationError(res, 'Notes are required', 'notes');

    const existing = await fetchApplication(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Application not found' });

    const joinedNotes = [existing.admin_notes, notes].filter(Boolean).join('\n\n');
    const application = await updateApplication(existing.id, {
      admin_notes: joinedNotes,
      reviewed_by: req.user?.id || null,
      reviewed_at: new Date().toISOString(),
    });

    return res.json({ message: 'Note added', application });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to add note', details: err.message });
  }
}

// ── Admin Ambassador Withdrawal Management ────────────────────────────────

export async function listAdminAmbassadorWithdrawals(req, res) {
  try {
    const status = cleanString(req.query?.status);
    const VALID_STATUSES = ['pending', 'approved', 'rejected', 'paid'];

    // Step 1: fetch withdrawals + ambassador profile (profile join is fine — no encrypted cols)
    let query = supabase
      .from('ambassador_withdrawals')
      .select(`
        id, ambassador_id, payout_account_id, amount, status,
        admin_notes, requested_at, processed_at, created_at,
        ambassador_profiles!ambassador_id (
          id, full_name, email, ambassador_code,
          total_earnings, pending_earnings, available_earnings
        )
      `)
      .order('created_at', { ascending: false });

    if (status && VALID_STATUSES.includes(status)) {
      query = query.eq('status', status);
    }

    const { data: rows, error } = await query;
    if (error) throw error;

    // Step 2: fetch payout accounts in a separate direct query so account_number_cipher
    // is reliably returned. PostgREST embedded joins can silently drop encrypted columns
    // depending on role-level grants; a direct .select() on the service-role client never has
    // this problem.
    const payoutIds = [...new Set((rows || []).map((r) => r.payout_account_id).filter(Boolean))];
    const accountMap = new Map();
    if (payoutIds.length) {
      const { data: accounts, error: acctErr } = await supabase
        .from('ambassador_payout_accounts')
        .select('id, bank_name, bank_code, account_name, account_last4, account_number_cipher')
        .in('id', payoutIds);
      if (acctErr) throw acctErr;
      for (const acct of accounts || []) {
        const plainNumber = decryptAccountNumber(acct.account_number_cipher);
        accountMap.set(acct.id, {
          bank_name: acct.bank_name,
          bank_code: acct.bank_code,
          account_name: acct.account_name,
          account_last4: acct.account_last4,
          // full decrypted number for admin — falls back to last4 display in the UI if null
          account_number: plainNumber || null,
        });
      }
    }

    const withdrawals = (rows || []).map((row) => ({
      ...row,
      ambassador_payout_accounts: accountMap.get(row.payout_account_id) || null,
    }));

    return res.json({ withdrawals });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list ambassador withdrawals', details: err.message });
  }
}

export async function adminLinkOrganizerToAmbassador(req, res) {
  try {
    const ambassadorId = cleanString(req.params.id);
    const organizerEmail = normalizeEmail(req.body?.organizer_email || req.body?.email || '');
    const organizerId = cleanString(req.body?.organizer_id || '');

    if (!organizerEmail && !organizerId) {
      return validationError(res, 'Provide organizer_email or organizer_id', 'organizer');
    }

    // Resolve ambassador profile
    const { data: ambassador, error: ambErr } = await supabase
      .from('ambassador_profiles')
      .select('id, full_name, ambassador_code, status')
      .eq('id', ambassadorId)
      .maybeSingle();
    if (ambErr) throw ambErr;
    if (!ambassador) return res.status(404).json({ error: 'Ambassador not found' });
    if (ambassador.status !== 'accepted') {
      return res.status(400).json({ error: 'Ambassador is not active (status must be accepted)' });
    }

    // Resolve organizer profile
    let orgQuery = supabase
      .from('profiles')
      .select('id, full_name, email, referred_by_ambassador_id');
    if (organizerId) {
      orgQuery = orgQuery.eq('id', organizerId);
    } else {
      orgQuery = orgQuery.ilike('email', organizerEmail);
    }
    const { data: organizer, error: orgErr } = await orgQuery.maybeSingle();
    if (orgErr) throw orgErr;
    if (!organizer) return res.status(404).json({ error: 'Organizer profile not found' });

    // Guard: don't overwrite a different ambassador's referral
    if (organizer.referred_by_ambassador_id && organizer.referred_by_ambassador_id !== ambassadorId) {
      return res.status(409).json({ error: 'Organizer is already referred by a different ambassador' });
    }

    // Guard: don't allow an ambassador to link themselves
    const { data: ambProfile } = await supabase
      .from('ambassador_profiles')
      .select('id')
      .eq('id', ambassadorId)
      .eq('id', organizer.id)   // same user
      .maybeSingle();
    if (ambProfile) return res.status(400).json({ error: 'An ambassador cannot be linked to themselves' });

    // Check for existing aio row
    const { data: existingAio, error: aioLookupErr } = await supabase
      .from('ambassador_influenced_organizers')
      .select('id, ambassador_id')
      .eq('organizer_id', organizer.id)
      .maybeSingle();
    if (aioLookupErr) throw aioLookupErr;

    if (existingAio && existingAio.ambassador_id !== ambassadorId) {
      return res.status(409).json({ error: 'Organizer is already linked to a different ambassador in the influence table' });
    }

    if (!existingAio) {
      const { error: insertErr } = await supabase
        .from('ambassador_influenced_organizers')
        .insert([{
          ambassador_id: ambassadorId,
          organizer_id: organizer.id,
          organizer_name: organizer.full_name,
          organizer_email: organizer.email,
          status: 'active',
        }]);
      if (insertErr) throw insertErr;
    }

    // Set profiles.referred_by_ambassador_id (may fail silently if already set correctly)
    const { error: profileErr } = await supabase
      .from('profiles')
      .update({
        referred_by_ambassador_id: ambassadorId,
        ambassador_referral_code: ambassador.ambassador_code,
      })
      .eq('id', organizer.id);
    if (profileErr) console.warn('[adminLinkOrganizer] profile update warning:', profileErr.message);

    // Backfill processed_amount_internal + largest_collection_amount_internal + collections_influenced
    // from all historical paid contributions for this organizer
    const { error: backfillErr } = await supabase.rpc('backfill_single_organizer_attribution', {
      p_organizer_id: organizer.id,
    });
    if (backfillErr) console.warn('[adminLinkOrganizer] backfill warning:', backfillErr.message);

    // Re-sync ambassador profile counters
    const { error: syncErr } = await supabase.rpc('sync_ambassador_profile_counters', {
      p_ambassador_id: ambassadorId,
    });
    if (syncErr) throw syncErr;

    // Return fresh ambassador overview
    const { data: freshProfile } = await supabase
      .from('ambassador_profiles')
      .select('total_earnings, available_earnings, pending_earnings, total_organizers_influenced, total_collections_influenced')
      .eq('id', ambassadorId)
      .maybeSingle();

    return res.json({
      message: `${organizer.full_name} has been linked to ambassador ${ambassador.full_name}`,
      organizer: { id: organizer.id, name: organizer.full_name, email: organizer.email },
      ambassador: { id: ambassador.id, name: ambassador.full_name, code: ambassador.ambassador_code },
      updatedMetrics: freshProfile || null,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to link organizer to ambassador', details: err.message });
  }
}

async function loadWithdrawalEmailContext(withdrawal) {
  const [{ data: profile }, { data: payoutAccount }] = await Promise.all([
    supabase
      .from('ambassador_profiles')
      .select('id, full_name, email')
      .eq('id', withdrawal.ambassador_id)
      .maybeSingle(),
    withdrawal.payout_account_id
      ? supabase
          .from('ambassador_payout_accounts')
          .select('bank_name, account_number_cipher')
          .eq('id', withdrawal.payout_account_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  return {
    profile,
    bankName: payoutAccount?.bank_name || null,
    accountNumber: payoutAccount ? decryptAccountNumber(payoutAccount.account_number_cipher) : null,
  };
}

export async function updateAdminAmbassadorWithdrawal(req, res) {
  try {
    const withdrawalId = cleanString(req.params.id);
    const action = cleanString(req.body?.action || req.body?.status);
    const adminNotes = cleanString(req.body?.notes || req.body?.admin_notes);

    if (!withdrawalId) return validationError(res, 'Withdrawal ID is required', 'id');

    const VALID_ACTIONS = ['approve', 'reject', 'pay'];
    if (!VALID_ACTIONS.includes(action)) {
      return res.status(400).json({ error: `Action must be one of: ${VALID_ACTIONS.join(', ')}` });
    }

    // Load the withdrawal to validate current state
    const { data: withdrawal, error: loadError } = await supabase
      .from('ambassador_withdrawals')
      .select('id, ambassador_id, payout_account_id, amount, status')
      .eq('id', withdrawalId)
      .maybeSingle();

    if (loadError) throw loadError;
    if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });

    // Validate state transitions
    if (action === 'approve' && withdrawal.status !== 'pending') {
      return res.status(409).json({ error: `Cannot approve a withdrawal with status '${withdrawal.status}'` });
    }
    if (action === 'reject' && !['pending', 'approved'].includes(withdrawal.status)) {
      return res.status(409).json({ error: `Cannot reject a withdrawal with status '${withdrawal.status}'` });
    }
    if (action === 'pay' && withdrawal.status !== 'approved') {
      return res.status(409).json({ error: `Cannot pay a withdrawal with status '${withdrawal.status}'. Approve it first.` });
    }

    if (action === 'pay') {
      // Atomic: distribute reward_paid across organizers and mark withdrawal as paid
      const { error: rpcError } = await supabase.rpc('distribute_ambassador_withdrawal_payment', {
        p_withdrawal_id: withdrawalId,
      });
      if (rpcError) throw rpcError;

      const { data: updated } = await supabase
        .from('ambassador_withdrawals')
        .select('*')
        .eq('id', withdrawalId)
        .maybeSingle();

      (async () => {
        try {
          const { profile, bankName, accountNumber } = await loadWithdrawalEmailContext(updated);
          if (!profile?.email) return;
          const message = withdrawalPaidTemplate({
            fullName: profile.full_name,
            amount: updated.amount,
            bankName,
            accountNumber,
            paidAt: updated.processed_at || updated.updated_at,
          });
          await sendAmbassadorEmail({
            to: profile.email,
            subject: message.subject,
            text: message.text,
            html: message.html,
            eventType: 'withdrawal_paid',
            ambassadorId: profile.id,
            withdrawalId: updated.id,
          });
        } catch (mailErr) {
          console.error('[ambassador] withdrawal paid email failed:', mailErr?.message || mailErr);
        }
      })();

      return res.json({ message: 'Withdrawal marked as paid and reward_paid distributed', withdrawal: updated });
    }

    // approve or reject — simple status update
    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    const { data: updated, error: updateError } = await supabase
      .from('ambassador_withdrawals')
      .update({
        status: newStatus,
        admin_notes: adminNotes || null,
        processed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', withdrawalId)
      .select('*')
      .single();

    if (updateError) throw updateError;

    if (newStatus === 'approved') {
      (async () => {
        try {
          const { profile, bankName, accountNumber } = await loadWithdrawalEmailContext(updated);
          if (!profile?.email) return;
          const message = withdrawalApprovedTemplate({
            fullName: profile.full_name,
            amount: updated.amount,
            bankName,
            accountNumber,
            referenceId: updated.id,
          });
          await sendAmbassadorEmail({
            to: profile.email,
            subject: message.subject,
            text: message.text,
            html: message.html,
            eventType: 'withdrawal_approved',
            ambassadorId: profile.id,
            withdrawalId: updated.id,
          });
        } catch (mailErr) {
          console.error('[ambassador] withdrawal approved email failed:', mailErr?.message || mailErr);
        }
      })();
    }

    return res.json({ message: `Withdrawal ${newStatus}`, withdrawal: updated });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update ambassador withdrawal', details: err.message });
  }
}
