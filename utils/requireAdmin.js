import { supabase } from './client.js';

/**
 * Middleware that restricts a route to admin users only.
 *
 * Resolution order for admin membership:
 *   1. `public.admin_users` table (preferred — DB-managed, no redeploy).
 *   2. `ADMIN_EMAILS` / `ADMIN_EMAIL` env vars (legacy + cutover fallback).
 *   3. `ADMIN_BOOTSTRAP_EMAIL` (only when the DB lookup actually errored).
 *
 * The env-var fallback exists so the admin can keep working during the
 * window between code deploy and migration application. Once everyone is
 * confirmed in the `admin_users` table, you can unset ADMIN_EMAILS.
 *
 * Must be used AFTER verifyToken (so req.user is already populated).
 *
 * Usage:
 *   router.post('/approve', verifyToken, requireAdmin, approveWithdrawal);
 */

const ADMIN_CACHE_TTL_MS = 60 * 1000;
const adminCache = new Map(); // email → { isAdmin: bool, expiresAt: number }

function getCached(email) {
    const hit = adminCache.get(email);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
        adminCache.delete(email);
        return null;
    }
    return hit.isAdmin;
}

function setCached(email, isAdmin) {
    adminCache.set(email, {
        isAdmin,
        expiresAt: Date.now() + ADMIN_CACHE_TTL_MS,
    });
}

function envAdminEmails() {
    const raw = (process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL || '').trim();
    if (!raw) return [];
    return raw
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
}

/**
 * Exposed so other modules (e.g. the admin email notification dispatch in
 * withdrawal.js) can pull the admin recipient list. Tries DB first, falls
 * back to env vars if the table is empty / unreachable so notifications
 * keep flowing during the cutover.
 */
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
        // Empty table — fall back to env so a fresh deploy still notifies someone.
        const envList = envAdminEmails();
        if (envList.length > 0) {
            console.warn('[requireAdmin] admin_users table is empty — using ADMIN_EMAILS env');
        }
        return envList;
    } catch (err) {
        console.warn('[requireAdmin] listAdminEmails threw — falling back to env:', err?.message || err);
        return envAdminEmails();
    }
}

export default async function requireAdmin(req, res, next) {
    const callerEmail = (req.user?.email || '').toLowerCase();

    if (!callerEmail) {
        console.warn('[requireAdmin] denied: no email on req.user');
        return res.status(403).json({
            error: 'Forbidden: admin access required',
            reason: 'NO_AUTHENTICATED_EMAIL',
        });
    }

    const cached = getCached(callerEmail);
    if (cached === true) return next();
    if (cached === false) {
        return res.status(403).json({
            error: 'Forbidden: admin access required',
            reason: 'NOT_IN_ADMIN_USERS',
            email: callerEmail,
        });
    }

    let dbErrored = false;
    let dbHit = false;

    try {
        const { data, error } = await supabase
            .from('admin_users')
            .select('id')
            .eq('email', callerEmail)
            .maybeSingle();

        if (error) {
            dbErrored = true;
            console.error('[requireAdmin] DB lookup error:', error.message, '— will try env fallback');
        } else if (data) {
            dbHit = true;
        }
    } catch (err) {
        dbErrored = true;
        console.error('[requireAdmin] DB lookup threw:', err?.message || err);
    }

    if (dbHit) {
        setCached(callerEmail, true);
        return next();
    }

    // Cutover / fallback path: the email may not be in the new table yet,
    // OR the DB query may have errored. Honour the legacy env-var
    // allowlist so we don't lock the admin team out.
    const envList = envAdminEmails();
    if (envList.includes(callerEmail)) {
        if (dbErrored) {
            console.warn(`[requireAdmin] allowing ${callerEmail} via ADMIN_EMAILS (DB lookup failed)`);
        } else {
            console.warn(
                `[requireAdmin] ${callerEmail} not in admin_users table but allowed via ADMIN_EMAILS env. ` +
                `Add them to admin_users to remove this warning.`
            );
        }
        // Don't cache env-fallback as "true" — we want the next request
        // to retry the DB and self-heal once the seed lands.
        return next();
    }

    // Emergency bootstrap (DB error AND env empty/mismatch) — last resort.
    if (dbErrored) {
        const bootstrap = (process.env.ADMIN_BOOTSTRAP_EMAIL || '').trim().toLowerCase();
        if (bootstrap && callerEmail === bootstrap) {
            console.warn('[requireAdmin] DB unavailable — allowing bootstrap admin:', callerEmail);
            return next();
        }
        return res.status(503).json({
            error: 'Admin check temporarily unavailable. Try again shortly.',
            reason: 'DB_LOOKUP_FAILED',
        });
    }

    // Confirmed not-an-admin (DB query succeeded, returned no row, no env match).
    setCached(callerEmail, false);
    console.warn(`[requireAdmin] denied: ${callerEmail} not in admin_users and not in ADMIN_EMAILS`);
    return res.status(403).json({
        error: 'Forbidden: admin access required',
        reason: 'NOT_IN_ADMIN_USERS',
        email: callerEmail,
        hint: 'Insert this email into public.admin_users or add it to ADMIN_EMAILS env.',
    });
}
