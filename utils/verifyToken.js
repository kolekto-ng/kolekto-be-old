import { supabase } from './client.js';
import { log } from './logger.js';
import {
    LOCAL_VERIFY_ENABLED,
    verifyAccessTokenLocally,
    verifyAccessTokenRemote,
} from './supabaseAuth.js';

/**
 * verifyToken — authenticates a request from its Supabase access token.
 *
 * Verification order (see utils/supabaseAuth.js for the why):
 *   1. LOCAL crypto verification (HS256 via SUPABASE_JWT_SECRET) — no network.
 *      This is the hot path that eliminated the per-request GoTrue call (F1).
 *   2. On a valid-but-EXPIRED token → attempt a cookie-based refresh (remote,
 *      but rare — only at the ~1h access-token boundary).
 *   3. On an AMBIGUOUS local failure (bad signature / no secret configured) →
 *      fall back to an authoritative, 60s-cached remote getUser so we never
 *      lock out a legitimate token during a JWT-secret/key-rotation edge.
 *
 * Every outcome emits a structured `auth.*` log so an incident window can be
 * classified at a glance: invalid/expired vs rate-limited vs upstream outage
 * vs network failure vs (later) authorization failure in requireAdmin.
 */
export default async function verifyToken(req, res, next) {
    const logger = req.log || log;

    // Try to get token from cookies first (for session-based auth)
    let token = req.cookies?.access_token;

    // Fallback to Authorization header (for API clients)
    if (!token) {
        const authHeader = req.headers.authorization;
        if (authHeader) {
            token = authHeader.split(" ")[1];
        }
    }

    if (!token) {
        return res.status(401).json({ error: "No token provided", requestId: req.id });
    }

    // ── 1. Local verification (no network) ───────────────────────────────────
    const local = verifyAccessTokenLocally(token);
    if (local.ok) {
        req.user = local.user;
        return next();
    }

    // ── 2. Expired token → refresh via cookie ────────────────────────────────
    // Only a cleanly-expired (but otherwise valid) token is eligible for the
    // refresh path. A bad-signature token must NOT be refreshed on trust.
    if (local.code === 'expired') {
        const refreshed = await tryCookieRefresh(req, res, logger);
        if (refreshed) return next();
        logger.warn('auth.expired_no_refresh', { path: req.path });
        return res.status(401).json({ error: "Invalid or expired token", requestId: req.id });
    }

    // ── 3. Ambiguous local failure → authoritative remote check (cached) ─────
    // Reached when: SUPABASE_JWT_SECRET is unset, OR the signature/audience
    // didn't match locally (possible with key rotation or an asymmetric-key
    // project). We defer to GoTrue as the source of truth rather than guessing.
    const remote = await verifyAccessTokenRemote(token);
    if (remote.ok) {
        // Local said invalid but remote said valid → the local secret is stale
        // or the project uses non-HS256 signing. Loud, actionable, once-per-token
        // (cache suppresses repeats): fix SUPABASE_JWT_SECRET to re-enable the
        // fast path, otherwise every request pays the remote cost again.
        if (LOCAL_VERIFY_ENABLED) {
            logger.warn('auth.local_verify_mismatch', {
                path: req.path,
                reason: local.reason,
                hint: 'SUPABASE_JWT_SECRET may be wrong or the project uses asymmetric JWTs',
            });
        }
        req.user = remote.user;
        return next();
    }

    // Remote also failed — classify precisely for diagnosis.
    switch (remote.kind) {
        case 'rate_limited':
            // F1 SMOKING GUN: GoTrue throttled us. During an incident, clusters
            // of this event across many paths at the same instant confirm F1.
            logger.error('auth.rate_limited', { path: req.path, status: remote.status, reason: remote.reason });
            // 503 (not 401) so the frontend does NOT force a logout on a transient throttle.
            return res.status(503).json({ error: "Authentication temporarily unavailable, please retry", requestId: req.id });
        case 'upstream':
            logger.error('auth.upstream_error', { path: req.path, status: remote.status, reason: remote.reason });
            return res.status(503).json({ error: "Authentication temporarily unavailable, please retry", requestId: req.id });
        case 'network':
            logger.error('auth.network_error', { path: req.path, reason: remote.reason });
            return res.status(503).json({ error: "Authentication temporarily unavailable, please retry", requestId: req.id });
        case 'invalid':
        default:
            logger.warn('auth.invalid_token', { path: req.path, localReason: local.reason, remoteReason: remote.reason });
            return res.status(401).json({ error: "Invalid or expired token", requestId: req.id });
    }
}

/**
 * Attempt to refresh an expired session from the refresh_token cookie and
 * rotate BOTH auth cookies. Returns true and sets req.user on success.
 *
 * (Unchanged behaviour from the original inline implementation — extracted so
 * the main flow reads cleanly. See B-11 note below on rotating both cookies.)
 */
async function tryCookieRefresh(req, res, logger) {
    const refreshToken = req.cookies?.refresh_token;
    if (!refreshToken) return false;

    let refreshData, refreshError;
    try {
        ({ data: refreshData, error: refreshError } = await supabase.auth.refreshSession({
            refresh_token: refreshToken,
        }));
    } catch (err) {
        // A thrown error here is a Supabase outage/network failure, NOT a bad
        // token — log it distinctly so it isn't misread as a dead session.
        logger.error('auth.refresh_error', { path: req.path, reason: err?.message || String(err) });
        return false;
    }

    if (refreshError || !refreshData?.session) {
        logger.warn('auth.refresh_rejected', {
            path: req.path,
            status: refreshError?.status ?? null,
            reason: refreshError?.message || 'no session returned',
        });
        return false;
    }

    // B-11: rotate BOTH cookies on a successful refresh.
    //
    // Supabase may rotate the refresh token (refresh-token rotation is enabled
    // by default in newer projects). Previously we only wrote a new
    // access_token cookie and left the stale refresh_token cookie in place. On
    // the next access-token expiry the client would present the OLD refresh
    // token, Supabase would reject it, and the user would be silently logged
    // out mid-session.
    //
    // Cookie options match exactly what controllers/auth.js (signIn) sets, so
    // the browser overwrites rather than accumulates two cookies of the same name.
    const isProd = process.env.NODE_ENV === 'production';
    const baseCookieOptions = {
        httpOnly: true,
        secure: isProd,
        sameSite: 'none',
        path: '/',
        domain: isProd ? '.kolekto.com.ng' : undefined,
    };
    res.cookie('access_token', refreshData.session.access_token, {
        ...baseCookieOptions,
        maxAge: 60 * 60 * 1000, // 1 hour — matches signIn
    });
    if (refreshData.session.refresh_token) {
        res.cookie('refresh_token', refreshData.session.refresh_token, {
            ...baseCookieOptions,
            maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days — matches signIn
        });
    }

    req.user = refreshData.user;
    logger.info('auth.refreshed', { path: req.path });
    return true;
}
