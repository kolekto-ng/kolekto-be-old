import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import validator from 'validator';
import { supabase } from '../utils/client.js';
import { sendEmail } from '../services/emailService.js';
import {
  calculateBadges,
  calculateOrganizerReward,
  getAmbassadorRank,
  normalizeApplicationStatus,
  serializeAmbassadorCode,
} from '../services/ambassadorProgram.js';

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

function ambassadorAcceptanceEmail({ application, profile }) {
  const portalUrl = `${process.env.FRONTEND_URL || 'https://www.kolekto.com.ng'}/ambassador/login`;
  const referralUrl = `${process.env.FRONTEND_URL || 'https://www.kolekto.com.ng'}/register?ref=${encodeURIComponent(profile.ambassador_code)}`;
  const name = application.full_name || 'Kolekto Ambassador';

  return {
    subject: 'Your Kolekto Ambassador account is ready',
    text:
      `Hi ${name},\n\n` +
      `Congratulations. Your Kolekto Ambassador application has been accepted.\n\n` +
      `Your ambassador code is ${profile.ambassador_code}.\n` +
      `Use this code with your email to set your PIN and log into the ambassador portal: ${portalUrl}\n\n` +
      `Your shareable referral link is ${referralUrl}.\n\n` +
      `Kolekto Team`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#0f172a">
        <h2 style="color:#1b5e20">Congratulations, ${name}</h2>
        <p>Your Kolekto Ambassador application has been accepted.</p>
        <p style="margin:24px 0;padding:16px;border:1px solid #bbf7d0;background:#f0fdf4;border-radius:10px">
          <strong>Your ambassador code:</strong><br />
          <span style="font-size:22px;font-weight:700;color:#166534">${profile.ambassador_code}</span>
        </p>
        <p>Use this code with your email to set your PIN and log into the ambassador portal.</p>
        <p><a href="${portalUrl}" style="display:inline-block;background:#1b5e20;color:white;padding:12px 18px;border-radius:8px;text-decoration:none">Open Ambassador Portal</a></p>
        <p>Your shareable referral link is <a href="${referralUrl}">${referralUrl}</a>.</p>
        <p>Organizers you refer can enter this code when creating their Kolekto account so their account is connected to you.</p>
        <p>Kolekto Team</p>
      </div>
    `,
  };
}

async function sendAmbassadorAcceptanceEmail(application, profile) {
  if (!application?.email || !profile?.ambassador_code) return;

  const message = ambassadorAcceptanceEmail({ application, profile });
  const result = await sendEmail({
    to: application.email,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });

  if (!result.success) {
    console.warn('[ambassador] acceptance email failed:', result.error);
  }
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

function buildOverview(profile, organizerRows = []) {
  const organizers = organizerRows.map((row) => {
    const reward = calculateOrganizerReward(row.processed_amount_internal, row.reward_paid);
    return {
      id: row.id,
      organizerName: row.organizer_name || 'Organizer',
      earningsGenerated: reward.generated,
      rewardProgress: reward.maxProgress,
      unlockProgress: reward.unlockProgress,
      rewardStatus: reward.status,
      collectionsInfluenced: row.collections_influenced || 0,
      lastActivityAt: row.last_activity_at,
    };
  });

  const totalEarnings = organizers.reduce((sum, row) => sum + row.earningsGenerated, 0);
  const availableEarnings = organizerRows.reduce((sum, row) => {
    const reward = calculateOrganizerReward(row.processed_amount_internal, row.reward_paid);
    return sum + reward.available;
  }, 0);
  const totalCollections = organizerRows.reduce((sum, row) => sum + Number(row.collections_influenced || 0), 0);
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
    },
    metrics: {
      totalOrganizersInfluenced: organizerRows.length || profile.total_organizers_influenced || 0,
      totalCollectionsInfluenced: totalCollections || profile.total_collections_influenced || 0,
      totalEarnings,
      pendingEarnings: Math.max(0, totalEarnings - availableEarnings),
      availableEarnings,
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

export async function verifyAmbassador(req, res, next) {
  const token = getAmbassadorToken(req);
  if (!token) return res.status(401).json({ error: 'Ambassador token required' });

  try {
    const decoded = jwt.verify(token, SESSION_SECRET);
    if (decoded?.type !== 'ambassador' || !decoded?.ambassadorId) {
      return res.status(401).json({ error: 'Invalid ambassador token' });
    }

    const profile = await loadProfileById(decoded.ambassadorId);
    if (!profile || profile.status !== 'accepted') {
      return res.status(403).json({ error: 'Ambassador access is not active' });
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
    if (profile.status !== 'accepted') return res.status(403).json({ error: 'Ambassador access is not active' });
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
    if (profile.status !== 'accepted') return res.status(403).json({ error: 'Ambassador access is not active' });
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
    const organizers = await loadOrganizerRows(req.ambassador.id);
    return res.json(buildOverview(req.ambassador, organizers));
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load ambassador overview', details: err.message });
  }
}

export async function getAmbassadorEarnings(req, res) {
  try {
    const rows = await loadOrganizerRows(req.ambassador.id);
    const organizers = rows.map((row) => {
      const reward = calculateOrganizerReward(row.processed_amount_internal, row.reward_paid);
      return {
        id: row.id,
        organizerName: row.organizer_name || 'Organizer',
        earningsGenerated: reward.generated,
        rewardProgress: reward.maxProgress,
        unlockProgress: reward.unlockProgress,
        rewardStatus: reward.status,
        availableEarnings: reward.available,
        pendingEarnings: reward.pending,
      };
    });

    return res.json({ organizers });
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
    const { data, error } = await supabase
      .from('ambassador_profiles')
      .select('id, full_name, state, school_organization, total_organizers_influenced, total_collections_influenced, total_processed_amount_internal')
      .eq('status', 'accepted')
      .order('total_collections_influenced', { ascending: false })
      .limit(50);

    if (error) throw error;

    const leaderboard = (data || []).map((row, index) => ({
      rank: index + 1,
      name: row.full_name,
      state: row.state,
      campus: row.school_organization,
      organizersInfluenced: row.total_organizers_influenced || 0,
      collectionsInfluenced: row.total_collections_influenced || 0,
      volumeGenerated: Number(row.total_processed_amount_internal || 0),
      isCurrentAmbassador: row.id === req.ambassador.id,
    }));

    return res.json({ leaderboard });
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
      .select('id, status')
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
        .select('id, bank_name, bank_code, account_name, account_last4, is_default, status, created_at')
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
        availableEarnings: reward.available,
        pendingEarnings: reward.pending,
        connectedAccounts: accountsByOrganizer.get(row.organizer_id) || [],
        withdrawals: withdrawalsByOrganizer.get(row.organizer_id) || [],
        collections: collectionsByOrganizer.get(row.organizer_id) || [],
      };
    });

    return res.json({
      application,
      profile: {
        ...buildOverview(profile, organizerRows).profile,
        pinSet: Boolean(profile.pin_hash),
        lastLoginAt: profile.last_login_at,
      },
      metrics: buildOverview(profile, organizerRows).metrics,
      organizers,
      ambassadorPayoutAccounts: ambassadorPayoutAccountsRes.error ? [] : ambassadorPayoutAccountsRes.data || [],
      ambassadorWithdrawals: ambassadorWithdrawalsRes.error ? [] : ambassadorWithdrawalsRes.data || [],
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

    const application = await updateApplication(req.params.id, {
      status: 'interview_scheduled',
      interview_date: interviewDate,
      admin_notes: cleanString(req.body?.notes) || null,
      reviewed_by: req.user?.id || null,
      reviewed_at: new Date().toISOString(),
    });

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

    return res.json({ message: 'Application rejected', application });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reject application', details: err.message });
  }
}

export async function suspendAmbassador(req, res) {
  try {
    const application = await updateApplication(req.params.id, {
      status: 'suspended',
      reviewed_by: req.user?.id || null,
      reviewed_at: new Date().toISOString(),
      admin_notes: cleanString(req.body?.notes || req.body?.reason) || null,
    });

    await supabase
      .from('ambassador_profiles')
      .update({ status: 'suspended', updated_at: new Date().toISOString() })
      .eq('application_id', application.id);

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
