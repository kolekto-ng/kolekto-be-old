/**
 * health.js — liveness & readiness endpoints (unauthenticated, secret-free).
 *
 *   GET /health/live   → the PROCESS is running. Always 200 while alive. Does
 *                        NOT check dependencies, so a live-but-degraded process
 *                        is not killed by an orchestrator's liveness probe.
 *
 *   GET /health/ready  → the process is running AND required backend
 *                        dependencies (privileged Supabase access) are usable.
 *                        200 when ready, 503 when not. This is what tells an
 *                        orchestrator/load balancer whether it is safe to route
 *                        traffic — a backend that cannot read its privileged
 *                        tables would otherwise serve empty financial and
 *                        operational dashboards and still look "healthy".
 *
 * Responses carry only pass/fail + a short machine reason per dependency —
 * never keys, tokens, or database rows.
 */
import { Router } from 'express';
import { getReadiness } from '../utils/readiness.js';

const router = Router();

router.get('/health/live', (req, res) => {
    res.status(200).json({ status: 'alive', ts: new Date().toISOString() });
});

router.get('/health/ready', (req, res) => {
    const { ready, checks } = getReadiness();
    res.status(ready ? 200 : 503).json({
        status: ready ? 'ready' : 'not_ready',
        checks,
        ts: new Date().toISOString(),
    });
});

export default router;
