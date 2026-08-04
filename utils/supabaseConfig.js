/**
 * supabaseConfig.js — single source of truth for resolving & validating the
 * Supabase configuration the backend requires.
 *
 * WHY THIS EXISTS (incident-driven):
 * The Express backend is a PRIVILEGED service. It performs server-side reads
 * and writes against RLS-protected, service-role-only tables:
 *   - pending_payment_context   (Payment Monitoring driver — RLS on, 0 policies)
 *   - email_campaigns / templates / recipients (Communications — RLS on, 0 policies)
 *   - notifications, push_notification_events  (Push pipeline — service-role only)
 * Under the anon key these SELECTs DO NOT ERROR — RLS silently returns zero
 * rows — so a whole dashboard can look "empty" when the truth is "the backend
 * cannot read the data". That exact misconfiguration produced empty Payment
 * Monitoring and Communications pages while a real, successful payment
 * (kolekto-1784556863591-704214) existed in the database.
 *
 * This module makes the misconfiguration EXPLICIT and CATCHABLE:
 *   - resolveSupabaseConfig(env)  → pure, never throws. Returns what is present.
 *   - assertSupabaseConfig(env)   → throws a structured error if the required
 *                                   service-role configuration is missing/wrong.
 *
 * It is deliberately side-effect free (no createClient, no process.exit) so it
 * is trivially unit-testable with an injected env object.
 */

// The variables the PRIVILEGED backend cannot operate without.
export const REQUIRED_VARS = Object.freeze(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);

/**
 * A Supabase legacy API key is a JWT: `header.payload.signature`. Its payload
 * carries a `role` claim — `"anon"`, `"authenticated"`, or `"service_role"`.
 * Decoding that claim lets us catch the single most dangerous mistake this
 * whole task exists to prevent: the anon key pasted into the service-role slot.
 *
 * Newer Supabase secret keys (the `sb_secret_...` format) are NOT JWTs; for
 * those we simply cannot introspect a role and return null (no false alarm).
 *
 * Never logs or returns the key itself — only the decoded role string.
 * @returns {string|null} the role claim, or null if it cannot be determined.
 */
export function decodeSupabaseKeyRole(key) {
    if (typeof key !== 'string' || !key) return null;
    const parts = key.split('.');
    if (parts.length !== 3) return null; // not a JWT (e.g. sb_secret_… format)
    try {
        const json = Buffer.from(parts[1], 'base64url').toString('utf8');
        const payload = JSON.parse(json);
        return typeof payload?.role === 'string' ? payload.role : null;
    } catch {
        return null;
    }
}

/**
 * Pure resolver. Reads (but never mutates) the given env bag.
 * @param {Record<string,string|undefined>} [env=process.env]
 * @returns {{
 *   ok: boolean,
 *   url: string,
 *   serviceRoleKey: string,
 *   anonKey: string,
 *   serviceKeyRole: string|null,
 *   missing: string[],
 *   errors: string[],
 * }}
 */
export function resolveSupabaseConfig(env = process.env) {
    const url = String(env.SUPABASE_URL || '').trim();
    const serviceRoleKey = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    const anonKey = String(env.SUPABASE_ANON_KEY || '').trim();

    const missing = [];
    if (!url) missing.push('SUPABASE_URL');
    if (!serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');

    const errors = [];
    const serviceKeyRole = decodeSupabaseKeyRole(serviceRoleKey);
    // The exact incident: an anon key sitting in the service-role slot. RLS
    // would silently deny every privileged read. Treat as a hard config error.
    if (serviceRoleKey && serviceKeyRole && serviceKeyRole !== 'service_role') {
        errors.push(
            `SUPABASE_SERVICE_ROLE_KEY carries role="${serviceKeyRole}", not "service_role". ` +
            `This is the anon/wrong key in the service-role slot — privileged tables would be silently denied.`
        );
    }

    const ok = missing.length === 0 && errors.length === 0;
    return { ok, url, serviceRoleKey, anonKey, serviceKeyRole, missing, errors };
}

/**
 * Fail-fast guard. Returns the resolved config when valid; otherwise throws a
 * structured Error (code `SUPABASE_CONFIG_MISSING`). Never logs secrets.
 * @param {Record<string,string|undefined>} [env=process.env]
 */
export function assertSupabaseConfig(env = process.env) {
    const cfg = resolveSupabaseConfig(env);
    if (cfg.ok) return cfg;

    const reasonParts = [];
    if (cfg.missing.length) reasonParts.push(`missing: ${cfg.missing.join(', ')}`);
    if (cfg.errors.length) reasonParts.push(...cfg.errors);

    const err = new Error(
        '[FATAL] Supabase service-role configuration is unavailable — ' +
        reasonParts.join('; ') + '. ' +
        'Payment Monitoring and Communications cannot safely operate without a valid ' +
        'SUPABASE_SERVICE_ROLE_KEY. Refusing to fall back to the anon key.'
    );
    err.code = 'SUPABASE_CONFIG_MISSING';
    err.missing = cfg.missing;
    err.errors = cfg.errors;
    throw err;
}
