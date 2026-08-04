// utils/financialAudit.js
//
// PHASE 2.0 GUARDRAILS — one structured audit-log entrypoint for every
// money-moving action. Built on the existing utils/logger.js (JSON lines) so it
// needs no new infrastructure. It emits `financial.<event>` with a consistent
// field set so a single reference can be traced across init → verify → wallet →
// withdrawal, and so metrics (§ monitoring) can be derived from the logs.
//
// HARD RULE: audit logging must NEVER throw. A logging failure must not break a
// payment. Every call is wrapped; on any error it silently degrades.
import { log } from "./logger.js";

/** Canonical money-moving events (stable strings — dashboards key off these). */
export const FINANCIAL_EVENTS = Object.freeze({
  PAYMENT_INITIALIZED: "payment_initialized",
  PAYMENT_VERIFIED: "payment_verified",
  PAYMENT_VERIFY_FAILED: "payment_verify_failed",
  WEBHOOK_RECEIVED: "webhook_received",
  WEBHOOK_DUPLICATE: "webhook_duplicate",
  CONTRIBUTION_CREATED: "contribution_created",
  CONTRIBUTION_PAID: "contribution_paid",
  WALLET_REFRESHED: "wallet_refreshed",
  SETTLEMENT_COMPLETED: "settlement_completed",
  SETTLEMENT_FAILED: "settlement_failed",
  WITHDRAWAL_REQUESTED: "withdrawal_requested",
  WITHDRAWAL_APPROVED: "withdrawal_approved",
  WITHDRAWAL_REJECTED: "withdrawal_rejected",
  WITHDRAWAL_PAID: "withdrawal_paid",
  RECONCILIATION_MISMATCH: "reconciliation_mismatch",
});

/**
 * Emit a structured financial audit line. Never throws.
 *
 * @param {string} event   one of FINANCIAL_EVENTS (or any stable slug)
 * @param {object} fields  { requestId, userId, collectionId, contributionId,
 *                           withdrawalId, paymentReference, amount, result,
 *                           durationMs, ...extra }
 * @param {object} [logger] injectable for tests; defaults to the app logger
 */
export function auditFinancial(event, fields = {}, logger = log) {
  try {
    const {
      requestId,
      userId,
      collectionId,
      contributionId,
      withdrawalId,
      paymentReference,
      amount,
      result,
      durationMs,
      err,
      ...extra
    } = fields || {};

    const meta = {
      requestId,
      userId,
      collectionId,
      contributionId,
      withdrawalId,
      payment_reference: paymentReference,
      amount,
      result,
      duration_ms: durationMs,
      ...extra,
    };
    // Drop undefined keys to keep lines clean.
    for (const k of Object.keys(meta)) if (meta[k] === undefined) delete meta[k];
    if (err !== undefined) meta.err = err;

    const level = result === "failure" || event.endsWith("_failed") ? "error" : "info";
    (logger[level] || logger.info)(`financial.${event}`, meta);
  } catch {
    /* audit logging must never break a financial operation */
  }
}

/** Convenience timer: returns a done(fields) that stamps duration_ms and audits. */
export function startFinancialAudit(event, baseFields = {}, logger = log) {
  const startedAt = process.hrtime.bigint();
  return (extraFields = {}) => {
    const durationMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e5) / 10;
    auditFinancial(event, { ...baseFields, ...extraFields, durationMs }, logger);
  };
}

export default auditFinancial;
