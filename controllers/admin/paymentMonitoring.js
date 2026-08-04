// Payment Monitoring & Recovery Center — admin visibility into payment
// state without needing SQL or terminal access.
//
// Reads from the same tables the reliability mechanism already writes to
// (pending_payment_context, contributions, payment_recovery_log) plus the
// new payment_admin_actions audit table. Writes here never touch a
// contribution directly — every recovery action goes through
// invokeVerifyEdgeFunction (verify-paystack-payment), the single source of
// truth, exactly like the existing Admin Reconcile page already does.
//
// Auth: verifyToken + requireAdmin (enforced at the route layer).

import { supabase } from "../../utils/client.js";
import { invokeVerifyEdgeFunction } from "../deposit.js";
import { previewTransaction } from "../../utils/paystack.js";

const LOOKBACK_DAYS = 7;
const ORPHAN_THRESHOLD_MINUTES = 5;
const RECOVERY_SOURCES = ["scheduled_recovery", "admin_reconcile"];

function startOfTodayIso() {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString();
}

function lookbackIso() {
    return new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Pulls the four source tables for a bounded window and assembles one
 * record per pending_payment_context row, classified into the dashboard's
 * status categories. Shared by the list endpoint and the retry-all endpoint
 * (which needs the same "what's currently failed" computation).
 */
async function loadPaymentMonitoringState() {
    const cutoff = lookbackIso();

    const { data: contexts, error: contextsError } = await supabase
        .from("pending_payment_context")
        .select("reference, collection_id, metadata, created_at")
        .gte("created_at", cutoff)
        .order("created_at", { ascending: false })
        .limit(500);
    if (contextsError) throw new Error(`pending_payment_context query failed: ${contextsError.message}`);

    const references = (contexts || []).map((c) => c.reference);
    const collectionIds = [...new Set((contexts || []).map((c) => c.collection_id).filter(Boolean))];

    const [{ data: contributions, error: contribError }, { data: recoveryLogs, error: logError }, { data: actions, error: actionsError }, { data: collections, error: collError }] = await Promise.all([
        references.length
            ? supabase.from("contributions").select("id, payment_reference, status, name, email, amount, gross_amount, created_at").in("payment_reference", references)
            : Promise.resolve({ data: [], error: null }),
        references.length
            ? supabase.from("payment_recovery_log").select("*").in("reference", references).order("created_at", { ascending: true })
            : Promise.resolve({ data: [], error: null }),
        references.length
            ? supabase.from("payment_admin_actions").select("*").in("reference", references).order("created_at", { ascending: true })
            : Promise.resolve({ data: [], error: null }),
        collectionIds.length
            ? supabase.from("collections").select("id, title").in("id", collectionIds)
            : Promise.resolve({ data: [], error: null }),
    ]);
    if (contribError) throw new Error(`contributions query failed: ${contribError.message}`);
    if (logError) throw new Error(`payment_recovery_log query failed: ${logError.message}`);
    if (actionsError) throw new Error(`payment_admin_actions query failed: ${actionsError.message}`);
    if (collError) throw new Error(`collections query failed: ${collError.message}`);

    const collectionTitleById = new Map((collections || []).map((c) => [c.id, c.title]));
    const now = Date.now();

    const items = (contexts || []).map((ctx) => {
        const contribution = (contributions || []).find((c) => c.payment_reference === ctx.reference) || null;
        const logsForRef = (recoveryLogs || []).filter((l) => l.reference === ctx.reference);
        const actionsForRef = (actions || []).filter((a) => a.reference === ctx.reference);
        const lastAction = actionsForRef.length ? actionsForRef[actionsForRef.length - 1] : null;
        const isResolved = lastAction?.action === "mark_resolved";
        const ageMinutes = (now - new Date(ctx.created_at).getTime()) / 60000;
        const hasFailedAttempt = logsForRef.some((l) => l.success === false);
        // Any successful log tagged with a recovery source — not just the
        // first — counts as "this was recovered, not a clean first-try
        // success". verify-paystack-payment's own internal log entry for a
        // freshly-recovered reference doesn't necessarily come before the
        // sweep's own log entry for the same reference (both get written
        // within the same request), so checking only the first one
        // under-counted recoveries.
        const wasRecovered = logsForRef.some((l) => l.success === true && RECOVERY_SOURCES.includes(l.invocation_source));

        let category;
        if (contribution && contribution.status === "paid") {
            category = wasRecovered ? "recovered" : "successful";
        } else if (isResolved) {
            category = "resolved";
        } else if (ageMinutes < ORPHAN_THRESHOLD_MINUTES) {
            category = "pending";
        } else if (hasFailedAttempt) {
            category = "failed";
        } else {
            category = "orphaned";
        }

        const metadata = ctx.metadata || {};
        return {
            reference: ctx.reference,
            collectionId: ctx.collection_id,
            collectionTitle: collectionTitleById.get(ctx.collection_id) || null,
            contactName: metadata.contact?.name || metadata.contactName || null,
            contactEmail: metadata.contact?.email || metadata.contactEmail || null,
            amount: metadata.contributionAmount ?? null,
            totalPayable: metadata.totalPayable ?? null,
            createdAt: ctx.created_at,
            ageMinutes: Math.round(ageMinutes),
            category,
            isResolved,
            contribution: contribution
                ? { id: contribution.id, status: contribution.status, amount: contribution.amount, createdAt: contribution.created_at }
                : null,
            attemptCount: logsForRef.filter((l) => l.invocation_source === "scheduled_recovery" || l.invocation_source === "admin_reconcile").length,
            lastAttempt: logsForRef.length ? logsForRef[logsForRef.length - 1] : null,
            lastError: [...logsForRef].reverse().find((l) => l.success === false) || null,
        };
    });

    return { items, cutoff };
}

export const getPaymentMonitoring = async (req, res) => {
    try {
        const { items } = await loadPaymentMonitoringState();
        const todayIso = startOfTodayIso();

        const byCategory = (cat) => items.filter((i) => i.category === cat);

        const successfulToday = items.filter((i) => i.category === "successful" && i.contribution?.createdAt >= todayIso).length;
        const recoveredToday = items.filter((i) => i.category === "recovered" && i.contribution?.createdAt >= todayIso).length;

        const { data: recoveryLogsToday } = await supabase
            .from("payment_recovery_log")
            .select("invocation_source, success, duration_ms")
            .gte("created_at", todayIso);

        const successRateBySource = {};
        for (const source of ["frontend_callback", "webhook", "scheduled_recovery", "admin_reconcile"]) {
            const rows = (recoveryLogsToday || []).filter((r) => r.invocation_source === source);
            const successCount = rows.filter((r) => r.success).length;
            successRateBySource[source] = rows.length ? Math.round((successCount / rows.length) * 100) : null;
        }

        // This is the verify-paystack-payment API call latency, not how long
        // the payment actually sat broken — kept as a secondary technical
        // metric (~1-2s always). Mean Time To Recovery below is the
        // operationally meaningful number.
        const recoveryDurations = (recoveryLogsToday || [])
            .filter((r) => r.success && RECOVERY_SOURCES.includes(r.invocation_source) && typeof r.duration_ms === "number")
            .map((r) => r.duration_ms);
        const avgRecoveryMs = recoveryDurations.length
            ? Math.round(recoveryDurations.reduce((s, v) => s + v, 0) / recoveryDurations.length)
            : null;

        // Mean Time To Recovery: how long a payment actually sat broken
        // (checkout started → contribution finally recorded), not just how
        // long the recovery API call itself took. This is the number that
        // tells you whether the system is performing well over time.
        // Computed over the same 7-day window as the rest of the
        // dashboard — "today" alone is too small a sample on quiet days.
        const recoveredItems = byCategory("recovered");
        const mttrSamples = recoveredItems
            .filter((i) => i.contribution?.createdAt)
            .map((i) => new Date(i.contribution.createdAt).getTime() - new Date(i.createdAt).getTime())
            .filter((ms) => ms >= 0);
        const mttrMs = mttrSamples.length
            ? Math.round(mttrSamples.reduce((s, v) => s + v, 0) / mttrSamples.length)
            : null;

        // Payments the next sweep run will actually attempt (orphaned +
        // failed — both are "no contribution yet, already past the 5-minute
        // grace window"). "Pending" items are too young to count as
        // awaiting recovery; they're still expected to resolve normally via
        // the frontend callback or webhook.
        const awaitingRecovery = byCategory("orphaned").length + byCategory("failed").length;

        // TRUE IN-FLIGHT COUNT: every initiated checkout that has no
        // contribution yet, regardless of age or recovery status. This is the
        // number that answers "how many payments are mid-lifecycle right now?"
        //   - "pending"  (<5 min) — callback/webhook hasn't fired yet
        //   - "orphaned" (≥5 min) — missed by callback AND webhook, sweep will act
        //   - "failed"   (≥5 min) — recovery was attempted but didn't succeed yet
        // This was the gap: the old banner only showed awaitingRecovery (≥5 min),
        // which made fresh missed payments invisible to admins watching the dashboard.
        const awaitingContribution = items.filter((i) => !i.contribution && !i.isResolved).length;

        // Combined "awaiting" view: all no-contribution items sorted newest first.
        // Gives admins a single tab to answer "what payments don't have a
        // contribution yet?" without splitting their attention across three tabs.
        const awaitingItems = [
            ...byCategory("pending"),
            ...byCategory("orphaned"),
            ...byCategory("failed"),
        ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        // Sweep runs on a '*/5 * * * *' cron schedule (see migration /
        // scheduled-payment-recovery deploy) — next tick is the next
        // multiple-of-5 minute boundary from server time now.
        const now = new Date();
        const minutesIntoSlot = now.getUTCMinutes() % 5;
        const secondsUntilNextSweep = (5 - minutesIntoSlot) * 60 - now.getUTCSeconds();

        res.status(200).json({
            stats: {
                successfulToday,
                recoveredToday,
                pendingVerification: byCategory("pending").length,
                orphaned: byCategory("orphaned").length,
                failedRecoveries: byCategory("failed").length,
                avgRecoveryMs,
                mttrMs,
                awaitingRecovery,
                awaitingContribution,
                nextSweepInSeconds: secondsUntilNextSweep,
                successRateBySource,
                // Snapshot timestamp lets the frontend show "as of HH:MM:SS" even
                // after client-side auto-refresh so admins know exactly how fresh
                // the data is without relying on browser clocks.
                serverNow: now.toISOString(),
            },
            categories: {
                all: items,
                awaiting: awaitingItems,
                successful: byCategory("successful"),
                pending: byCategory("pending"),
                recovered: byCategory("recovered"),
                failed: byCategory("failed"),
                orphaned: byCategory("orphaned"),
            },
        });
    } catch (err) {
        console.error("[paymentMonitoring] LIST_FAILED", err?.message);
        res.status(500).json({ error: "Failed to load payment monitoring data", details: err?.message });
    }
};

export const getPaymentMonitoringDetail = async (req, res) => {
    const reference = String(req.params.reference || "").trim();
    if (!reference) return res.status(400).json({ error: "Reference is required" });

    try {
        const [{ data: context }, { data: contribution }, { data: recoveryLogs }, { data: actions }] = await Promise.all([
            supabase.from("pending_payment_context").select("*").eq("reference", reference).maybeSingle(),
            supabase.from("contributions").select("*").eq("payment_reference", reference).maybeSingle(),
            supabase.from("payment_recovery_log").select("*").eq("reference", reference).order("created_at", { ascending: true }),
            supabase.from("payment_admin_actions").select("*").eq("reference", reference).order("created_at", { ascending: true }),
        ]);

        let collection = null;
        if (context?.collection_id) {
            const { data } = await supabase.from("collections").select("id, title, collection_type, price_tiers").eq("id", context.collection_id).maybeSingle();
            collection = data || null;
        }

        // Best-effort, read-only — never blocks the response if Paystack is slow/down.
        const paystackPreview = await previewTransaction(reference);

        res.status(200).json({
            reference,
            pendingPaymentContext: context || null,
            contribution: contribution || null,
            collection,
            recoveryLog: recoveryLogs || [],
            adminActions: actions || [],
            paystackPreview,
        });
    } catch (err) {
        console.error(`[paymentMonitoring ref=${reference}] DETAIL_FAILED`, err?.message);
        res.status(500).json({ error: "Failed to load payment detail", details: err?.message });
    }
};

async function logAdminAction({ reference, collectionId, req, action, oldStatus, newStatus, reason, notes }) {
    try {
        await supabase.from("payment_admin_actions").insert({
            reference,
            collection_id: collectionId || null,
            admin_user_id: req.user?.id || null,
            admin_email: req.user?.email || null,
            action,
            old_status: oldStatus || null,
            new_status: newStatus || null,
            reason: reason || null,
            notes: notes || null,
        });
    } catch (err) {
        console.warn(`[paymentMonitoring ref=${reference}] ADMIN_ACTION_LOG_FAILED (non-fatal):`, err?.message);
    }
}

export const retryPayment = async (req, res) => {
    const reference = String(req.params.reference || "").trim();
    if (!reference) return res.status(400).json({ error: "Reference is required" });

    const { data: contextRow } = await supabase.from("pending_payment_context").select("collection_id").eq("reference", reference).maybeSingle();
    const result = await invokeVerifyEdgeFunction(reference, null, null, "admin_reconcile");

    await logAdminAction({
        reference,
        collectionId: contextRow?.collection_id,
        req,
        action: "retry",
        oldStatus: "orphaned_or_failed",
        newStatus: result.ok ? "recovered" : "failed",
        reason: "Manual retry from Payment Monitoring dashboard",
    });

    res.status(result.ok ? 200 : (result.status >= 400 ? result.status : 502)).json({
        ok: result.ok,
        reference,
        body: result.body,
    });
};

export const manualReconcilePayment = async (req, res) => {
    const reference = String(req.params.reference || "").trim();
    const collectionId = String(req.body?.collectionId || "").trim() || null;
    const selectedTierId = String(req.body?.selectedTierId || "").trim() || null;
    if (!reference) return res.status(400).json({ error: "Reference is required" });

    const result = await invokeVerifyEdgeFunction(reference, collectionId, selectedTierId, "admin_reconcile");

    await logAdminAction({
        reference,
        collectionId,
        req,
        action: "manual_reconcile",
        oldStatus: "orphaned",
        newStatus: result.ok ? "recovered" : "failed",
        reason: `collectionId=${collectionId || "(inferred)"} selectedTierId=${selectedTierId || "(inferred)"}`,
    });

    res.status(result.ok ? 200 : (result.status >= 400 ? result.status : 502)).json({
        ok: result.ok,
        reference,
        body: result.body,
    });
};

export const retryAllFailed = async (req, res) => {
    try {
        const { items } = await loadPaymentMonitoringState();
        const failed = items.filter((i) => i.category === "failed");

        const CONCURRENCY = 3;
        const results = [];
        for (let i = 0; i < failed.length; i += CONCURRENCY) {
            const batch = failed.slice(i, i + CONCURRENCY);
            const batchResults = await Promise.all(
                batch.map(async (item) => {
                    const result = await invokeVerifyEdgeFunction(item.reference, null, null, "admin_reconcile");
                    await logAdminAction({
                        reference: item.reference,
                        collectionId: item.collectionId,
                        req,
                        action: "retry_all",
                        oldStatus: "failed",
                        newStatus: result.ok ? "recovered" : "failed",
                        reason: "Bulk retry-all-failed from Payment Monitoring dashboard",
                    });
                    return { reference: item.reference, ok: result.ok };
                })
            );
            results.push(...batchResults);
        }

        res.status(200).json({
            attempted: results.length,
            recovered: results.filter((r) => r.ok).length,
            stillFailed: results.filter((r) => !r.ok).length,
            results,
        });
    } catch (err) {
        console.error("[paymentMonitoring] RETRY_ALL_FAILED", err?.message);
        res.status(500).json({ error: "Retry-all failed to run", details: err?.message });
    }
};

export const resolvePayment = async (req, res) => {
    const reference = String(req.params.reference || "").trim();
    const reason = String(req.body?.reason || "").trim();
    if (!reference) return res.status(400).json({ error: "Reference is required" });
    if (!reason) return res.status(400).json({ error: "A reason is required to mark a payment resolved." });

    const { data: contextRow } = await supabase.from("pending_payment_context").select("collection_id").eq("reference", reference).maybeSingle();

    await logAdminAction({
        reference,
        collectionId: contextRow?.collection_id,
        req,
        action: "mark_resolved",
        oldStatus: "orphaned_or_failed",
        newStatus: "resolved",
        reason,
    });

    res.status(200).json({ ok: true, reference, status: "resolved" });
};

export const addPaymentNote = async (req, res) => {
    const reference = String(req.params.reference || "").trim();
    const notes = String(req.body?.notes || "").trim();
    if (!reference) return res.status(400).json({ error: "Reference is required" });
    if (!notes) return res.status(400).json({ error: "Note text is required" });

    const { data: contextRow } = await supabase.from("pending_payment_context").select("collection_id").eq("reference", reference).maybeSingle();

    await logAdminAction({
        reference,
        collectionId: contextRow?.collection_id,
        req,
        action: "add_note",
        notes,
    });

    res.status(200).json({ ok: true, reference });
};
