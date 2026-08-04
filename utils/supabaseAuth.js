/**
 * supabaseAuth.js — access-token verification for the Express auth layer.
 *
 * WHY (F1): the previous verifyToken called supabase.auth.getUser(token) — a
 * REMOTE round-trip to Supabase Auth (GoTrue) — on EVERY authenticated request.
 * An admin page-load fans out into many parallel requests, each making its own
 * remote auth call, which can trip GoTrue rate limits and 401 half the page
 * (the "Failed to load records" bursts). This module makes the hot path fully
 * local:
 *
 *   1. verifyAccessTokenLocally() — cryptographically verifies the Supabase
 *      access token (HS256, signed with SUPABASE_JWT_SECRET) with NO network
 *      call. This is what the vast majority of requests hit.
 *
 *   2. verifyAccessTokenRemote() — authoritative fallback used ONLY when local
 *      verification is impossible/ambiguous (no secret configured, signature
 *      mismatch that could mean key rotation / an asymmetric-key project).
 *      Results are cached for CACHE_TTL_MS so even this path never repeats a
 *      network call for the same token within the window.
 *
 * Security notes:
 *   - Algorithm is pinned to HS256 (prevents alg-confusion / "none" downgrade).
 *   - Audience is pinned to "authenticated" (Supabase user sessions).
 *   - Expiry (exp) is enforced by jsonwebtoken.
 *   - The remote fallback keeps GoTrue as the source of truth for anything the
 *     local check can't vouch for, so there is no authz regression.
 */
import jwt from 'jsonwebtoken';
import { supabase } from './client.js';

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || '';
export const LOCAL_VERIFY_ENABLED = Boolean(JWT_SECRET);

// Short-TTL positive cache for the REMOTE fallback only. Keyed by the raw
// token. Positive results only — never cache a failure, so a recovering
// Auth server / a freshly-valid token is picked up immediately.
const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX_ENTRIES = 10_000;
const remoteCache = new Map(); // token -> { user, expiresAt }

function cacheGet(token) {
  const hit = remoteCache.get(token);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    remoteCache.delete(token);
    return null;
  }
  return hit.user;
}

function cacheSet(token, user, tokenExp) {
  // Never cache past the token's own expiry, and cap at CACHE_TTL_MS.
  const ttlCap = Date.now() + CACHE_TTL_MS;
  const expiresAt = tokenExp ? Math.min(ttlCap, tokenExp * 1000) : ttlCap;
  if (expiresAt <= Date.now()) return;
  // Crude bound on memory: if we blow the cap, drop the whole map. Simpler and
  // safer than a full LRU for a 60s-TTL cache; worst case is a brief cache miss.
  if (remoteCache.size >= CACHE_MAX_ENTRIES) remoteCache.clear();
  remoteCache.set(token, { user, expiresAt });
}

/**
 * Build the req.user shape from a decoded Supabase JWT. Downstream code only
 * reads req.user.id and req.user.email; we preserve the full claim set too so
 * any future consumer of role/app_metadata/etc keeps working.
 */
function userFromClaims(payload) {
  return {
    ...payload,
    id: payload.sub,        // Supabase user id lives in `sub`
    email: payload.email,
    role: payload.role,
  };
}

/**
 * Local, network-free verification.
 * @returns {{ ok: boolean, user?: object, code?: 'expired'|'invalid'|'no_secret', reason?: string }}
 */
export function verifyAccessTokenLocally(token) {
  if (!LOCAL_VERIFY_ENABLED) {
    return { ok: false, code: 'no_secret', reason: 'SUPABASE_JWT_SECRET not set' };
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'],
      audience: 'authenticated',
    });
    if (!payload?.sub) {
      return { ok: false, code: 'invalid', reason: 'token has no sub claim' };
    }
    return { ok: true, user: userFromClaims(payload) };
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return { ok: false, code: 'expired', reason: 'token expired' };
    }
    // JsonWebTokenError (bad signature, wrong audience, malformed), NotBefore, etc.
    return { ok: false, code: 'invalid', reason: err?.message || 'invalid token' };
  }
}

/**
 * Classify a Supabase auth error / thrown error into a stable kind so the
 * caller can react correctly and logs can distinguish the failure modes the
 * brief asked for.
 * @returns {'invalid'|'rate_limited'|'upstream'|'network'}
 */
export function classifyRemoteFailure(error) {
  // A thrown error with no HTTP status is a transport/network failure.
  const status = error?.status ?? error?.statusCode ?? null;
  if (status == null) return 'network';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'upstream';
  return 'invalid'; // 400/401/403 — token genuinely rejected
}

/**
 * Authoritative remote verification with a 60s positive cache.
 * @returns {Promise<{ ok: boolean, user?: object, kind?: 'invalid'|'rate_limited'|'upstream'|'network', reason?: string, status?: number|null }>}
 */
export async function verifyAccessTokenRemote(token) {
  const cached = cacheGet(token);
  if (cached) return { ok: true, user: cached, cached: true };

  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      const kind = error ? classifyRemoteFailure(error) : 'invalid';
      return { ok: false, kind, reason: error?.message || 'no user on token', status: error?.status ?? null };
    }
    // Decode (without re-verifying) purely to read exp for cache bounding.
    let exp;
    try { exp = jwt.decode(token)?.exp; } catch { /* ignore */ }
    cacheSet(token, data.user, exp);
    return { ok: true, user: data.user };
  } catch (err) {
    return { ok: false, kind: classifyRemoteFailure(err), reason: err?.message || 'network error', status: null };
  }
}

// Exposed for tests / diagnostics.
export function _clearRemoteCache() {
  remoteCache.clear();
}
