/**
 * supabaseStartupProbe.js — verifies the backend can actually EXERCISE its
 * privileged Supabase access, not merely that a key string is present.
 *
 * A present-but-wrong service-role key (or a key whose project/grant is broken)
 * constructs a perfectly valid client and errors nowhere at boot — yet every
 * privileged read comes back empty or denied at runtime. This probe closes that
 * gap by doing ONE minimal, read-only check against a known service-role-only
 * table and distinguishing the two outcomes that matter:
 *
 *   query succeeded, zero rows   → VALID empty state  → ok
 *   query FAILED (RLS/denied/net) → dependency failure → not ok
 *
 * It never exposes financial data: `head: true` fetches NO row bodies, only a
 * count and the pass/fail of the read itself.
 */
import { serviceSupabase } from './client.js';
import { log } from './logger.js';

// Service-role-only table used as the canary. It is the Payment Monitoring
// driver table — RLS-enabled with zero policies — so a successful read here
// proves the exact access path the incident was missing.
export const PROBE_TABLE = 'pending_payment_context';

/**
 * Run the minimal privileged read. Accepts an injected client so it is unit
 * testable without a live database.
 * @param {object} [client=serviceSupabase]
 * @param {{ table?: string }} [opts]
 * @returns {Promise<{ ok: boolean, table: string, durationMs: number, rowCount?: number|null, reason?: string, message?: string, code?: string|null }>}
 */
export async function probeSupabaseAccess(client = serviceSupabase, { table = PROBE_TABLE } = {}) {
    const startedAt = Date.now();
    try {
        // head:true + count:'exact' → no row data returned, only permission +
        // count. Zero rows on an empty table is success; an RLS/permission
        // denial or transport error surfaces as `error`.
        const { error, count } = await client
            .from(table)
            .select('*', { count: 'exact', head: true });

        const durationMs = Date.now() - startedAt;

        if (error) {
            return {
                ok: false,
                table,
                durationMs,
                reason: 'service_role_access_unavailable',
                message: error.message || 'query failed',
                code: error.code || null,
            };
        }

        // Success — INCLUDING zero rows. That is a valid empty state, NOT a failure.
        return {
            ok: true,
            table,
            durationMs,
            rowCount: typeof count === 'number' ? count : null,
        };
    } catch (err) {
        return {
            ok: false,
            table,
            durationMs: Date.now() - startedAt,
            reason: 'probe_threw',
            message: err?.message || String(err),
            code: err?.code || null,
        };
    }
}

/**
 * Probe + structured logging. Returns the raw probe result so callers can set
 * readiness / decide whether to exit. Diagnostics answer "which dependency
 * failed and why" without leaking secrets or row bodies.
 */
export async function runStartupProbe(opts = {}) {
    const result = await probeSupabaseAccess(opts.client, opts);
    if (result.ok) {
        log.info('startup_probe.ok', {
            dependency: 'supabase',
            component: 'startup_probe',
            status: 'ok',
            table: result.table,
            rowCount: result.rowCount,
            durationMs: result.durationMs,
        });
    } else {
        log.error('startup_probe.failed', {
            dependency: 'supabase',
            component: 'startup_probe',
            status: 'failed',
            reason: result.reason,
            table: result.table,
            message: result.message,
            durationMs: result.durationMs,
        });
    }
    return result;
}
