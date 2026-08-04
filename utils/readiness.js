/**
 * readiness.js — process-wide readiness state, separate from liveness.
 *
 * Liveness  = "the process is running" (see routes/health.js /health/live).
 * Readiness = "the process is running AND its required backend dependencies
 *              are actually usable" (see /health/ready).
 *
 * The startup probe (utils/supabaseStartupProbe.js) records the result of
 * verifying privileged Supabase access here. The health route reads it. A
 * dependency failure flips readiness to false WITHOUT killing the process, so
 * an orchestrator stops routing traffic to a backend that would otherwise
 * serve empty financial/operational dashboards.
 *
 * Never store secrets here — only pass/fail + a short machine reason.
 */

// name → { ok: boolean, reason: string|null, checkedAt: string }
const dependencies = new Map();

// Until the startup probe has run, the process is NOT ready. A brand-new
// process answering /health/ready before its checks complete must report 503.
let hasRunAnyCheck = false;

/**
 * Record the status of a single named dependency.
 * @param {string} name
 * @param {{ ok: boolean, reason?: string|null }} status
 */
export function setDependencyStatus(name, status) {
    hasRunAnyCheck = true;
    dependencies.set(name, {
        ok: Boolean(status?.ok),
        reason: status?.ok ? null : (status?.reason || 'unknown'),
        checkedAt: new Date().toISOString(),
    });
}

/**
 * @returns {{ ready: boolean, checks: Record<string, {ok:boolean, reason:string|null, checkedAt:string}> }}
 */
export function getReadiness() {
    const checks = {};
    for (const [name, status] of dependencies.entries()) {
        checks[name] = { ...status };
    }
    const ready = hasRunAnyCheck && [...dependencies.values()].every((s) => s.ok);
    return { ready, checks };
}

/** Test-only: reset state between cases. */
export function _resetReadiness() {
    dependencies.clear();
    hasRunAnyCheck = false;
}
