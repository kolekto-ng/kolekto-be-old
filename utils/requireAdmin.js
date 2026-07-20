import { supabase } from './client.js';

/**
 * Admin authorization middleware — driven ONLY by the `public.admin_users`
 * table in Supabase. There is no hardcoded email list and no environment-var
 * allowlist in the authorization path.
 *
 * Two guards are exported:
 *   - `requireAdmin`      → any row in admin_users (role 'admin' OR 'superadmin').
 *   - `requireSuperAdmin` → row with role === 'superadmin' only.
 *
 * Resolution — `public.admin_users` is the ONLY source of truth for identity
 * AND role. A cached lookup (60s TTL) keyed by email avoids a DB round trip on
 * every request. There is NO email allowlist and NO bootstrap fallback: if the
 * table cannot be queried, authorization FAILS CLOSED (503, no access granted).
 *
 * Both guards attach `req.adminUser = { email, role }` and `req.adminRole`
 * for downstream handlers, and must be used AFTER verifyToken (so req.user is
 * populated).
 *
 * Usage:
 *   router.post('/approve', verifyToken, requireSuperAdmin, approveWithdrawal);
 *   router.get('/kyc-documents', verifyToken, requireAdmin, getAllKycDocuments);
 */

const ADMIN_CACHE_TTL_MS = 60 * 1000;
// email → { result: {status:'ok', role} | {status:'not_admin'}, expiresAt }
// Note: db_error results are intentionally never cached, so the next request
// retries the DB and self-heals once Supabase recovers.
const adminCache = new Map();

function getCached(email) {
    const hit = adminCache.get(email);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
        adminCache.delete(email);
        return null;
    }
    return hit.result;
}

function setCached(email, result) {
    adminCache.set(email, {
        result,
        expiresAt: Date.now() + ADMIN_CACHE_TTL_MS,
    });
}

/**
 * Resolve the caller's admin role from `admin_users`.
 * Returns one of:
 *   { status: 'ok', role: 'admin' | 'superadmin' }
 *   { status: 'not_admin' }
 *   { status: 'db_error' }
 */
async function resolveAdminRole(email) {
    const cached = getCached(email);
    if (cached) return cached;

    let dbErrored = false;
    let row = null;
    try {
        const { data, error } = await supabase
            .from('admin_users')
            .select('role')
            .eq('email', email)
            .maybeSingle();

        if (error) {
            dbErrored = true;
            console.error('[requireAdmin] DB lookup error:', error.message);
        } else if (data) {
            row = data;
        }
    } catch (err) {
        dbErrored = true;
        console.error('[requireAdmin] DB lookup threw:', err?.message || err);
    }

    if (row) {
        // Normalise: an unrecognised/missing role degrades to the least
        // privilege ('admin'), never to super-admin.
        const role = row.role === 'superadmin' ? 'superadmin' : 'admin';
        const result = { status: 'ok', role };
        setCached(email, result);
        return result;
    }

    if (dbErrored) {
        // Never cache — retry on the next request so we self-heal.
        return { status: 'db_error' };
    }

    const result = { status: 'not_admin' };
    setCached(email, result);
    return result;
}

function denyNoEmail(res) {
    console.warn('[requireAdmin] denied: no email on req.user');
    return res.status(403).json({
        error: 'Forbidden: admin access required',
        reason: 'NO_AUTHENTICATED_EMAIL',
    });
}

function denyNotAdmin(res, email) {
    return res.status(403).json({
        error: 'Forbidden: admin access required',
        reason: 'NOT_IN_ADMIN_USERS',
        email,
        hint: 'Insert this email into public.admin_users.',
    });
}

function dbUnavailable(res) {
    return res.status(503).json({
        error: 'Admin check temporarily unavailable. Try again shortly.',
        reason: 'DB_LOOKUP_FAILED',
    });
}

export default async function requireAdmin(req, res, next) {
    const email = (req.user?.email || '').toLowerCase();
    if (!email) return denyNoEmail(res);

    const r = await resolveAdminRole(email);

    if (r.status === 'ok') {
        req.adminUser = { email, role: r.role };
        req.adminRole = r.role;
        return next();
    }

    if (r.status === 'db_error') {
        // Fail closed — an unreachable admin_users table grants NO access.
        return dbUnavailable(res);
    }

    console.warn(`[requireAdmin] denied: ${email} not in admin_users`);
    return denyNotAdmin(res, email);
}

export async function requireSuperAdmin(req, res, next) {
    const email = (req.user?.email || '').toLowerCase();
    if (!email) return denyNoEmail(res);

    const r = await resolveAdminRole(email);

    if (r.status === 'ok') {
        if (r.role === 'superadmin') {
            req.adminUser = { email, role: r.role };
            req.adminRole = r.role;
            return next();
        }
        // Authenticated admin, but not a super-admin — this is the exact case
        // Task 2 restricts (Withdrawals / Ambassador Payouts / Communications /
        // Settings). Enforced here so a hidden nav item is not the only guard.
        console.warn(`[requireAdmin] denied super-admin route: ${email} is role='${r.role}'`);
        return res.status(403).json({
            error: 'Forbidden: super-admin access required',
            reason: 'REQUIRES_SUPERADMIN',
            role: r.role,
        });
    }

    if (r.status === 'db_error') {
        // Fail closed — an unreachable admin_users table grants NO access.
        return dbUnavailable(res);
    }

    console.warn(`[requireAdmin] denied super-admin route: ${email} not in admin_users`);
    return denyNotAdmin(res, email);
}

/**
 * Exposed so other modules (e.g. the admin email notification dispatch in
 * withdrawal.js) can pull the admin recipient list. This is a NOTIFICATION
 * concern, not authorization — it answers "who should we email", never "who
 * may act". It reads `admin_users` and returns every admin email; the env
 * fallback below only fires if the table is empty/unreachable so a fresh
 * deploy still notifies someone.
 */
function envAdminEmails() {
    const raw = (process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL || '').trim();
    if (!raw) return [];
    return raw
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
}

export async function listAdminEmails() {
    try {
        const { data, error } = await supabase
            .from('admin_users')
            .select('email');
        if (error) {
            console.warn('[requireAdmin] listAdminEmails DB error — falling back to env:', error.message);
            return envAdminEmails();
        }
        const fromDb = (data || []).map((r) => String(r.email || '').toLowerCase()).filter(Boolean);
        if (fromDb.length > 0) return fromDb;
        const envList = envAdminEmails();
        if (envList.length > 0) {
            console.warn('[requireAdmin] admin_users table is empty — using ADMIN_EMAILS env for notifications');
        }
        return envList;
    } catch (err) {
        console.warn('[requireAdmin] listAdminEmails threw — falling back to env:', err?.message || err);
        return envAdminEmails();
    }
}
