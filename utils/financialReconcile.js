// utils/financialReconcile.js
//
// PHASE 2.0 GUARDRAILS — pure reconciliation + consistency logic.
//
// Verification only: given the source-of-truth rows (paid contributions +
// withdrawals) and the stored wallet projection, compute what the balances
// SHOULD be (via the canonical utils/financial.js) and report any drift or
// impossible state. This never mutates anything — it is the tool that lets a
// future refactor prove it did not change the numbers.
//
// The Supabase-connected runner lives in scripts/reconcileFinancials.js; this
// module is pure and unit-tested so the invariant logic is trustworthy.
import { computeWalletBalances, normalizeContributions, roundCurrency } from "./financial.js";

const DEFAULT_TOLERANCE = 0.01; // ₦0.01 — absorb float rounding only

/**
 * The canonical expected balances for a collection, from source rows.
 * This is the SAME path the app uses (normalizeContributions → computeWalletBalances),
 * so it is the reference every other implementation (Deno, SQL, stored columns)
 * must match.
 */
export function expectedBalances(paidContributions, withdrawals, { feeBearer = "organizer", collectionType = "fixed" } = {}) {
  const normalized = normalizeContributions(paidContributions || [], feeBearer, collectionType);
  return computeWalletBalances(normalized, withdrawals || []);
}

const WALLET_FIELDS = [
  ["net_payment", "netPayment"],
  ["gross_payment", "grossPayment"],
  ["pending_balance", "pendingBalance"],
  ["available_balance", "availableBalance"],
  ["ledger_balance", "ledgerBalance"],
  ["withdrawn", "completedWithdrawals"],
];

/**
 * Compare the stored wallet row against the expected (recomputed) balances.
 * @returns {Array<{field, stored, expected, delta}>} only fields that differ beyond tolerance.
 */
export function diffWallet(expected, storedWallet, tolerance = DEFAULT_TOLERANCE) {
  if (!storedWallet) return [{ field: "*wallet*", stored: null, expected: expected.netPayment, delta: null }];
  const diffs = [];
  for (const [col, key] of WALLET_FIELDS) {
    const stored = Number(storedWallet[col] || 0);
    const exp = Number(expected[key] || 0);
    const delta = roundCurrency(stored - exp);
    if (Math.abs(delta) > tolerance) diffs.push({ field: col, stored, expected: exp, delta });
  }
  return diffs;
}

/**
 * Detect impossible / inconsistent states for one collection.
 * @returns {Array<{code, severity, detail}>}
 */
export function checkInvariants({ collectionId, wallets = [], expected, paidContributions = [], withdrawals = [] }) {
  const issues = [];
  const push = (code, severity, detail) => issues.push({ collectionId, code, severity, detail });

  // Wallet cardinality
  if (wallets.length === 0) {
    push("NO_WALLET", "high", "collection has paid contributions but no wallet row");
  } else if (wallets.length > 1) {
    push("MULTIPLE_WALLETS", "high", `${wallets.length} wallet rows for one collection (dedup needed before UNIQUE index)`);
  }

  // Internal ledger identity on the EXPECTED numbers (must always hold)
  const identity = roundCurrency(expected.availableBalance + expected.pendingBalance);
  if (Math.abs(identity - expected.ledgerBalance) > DEFAULT_TOLERANCE) {
    push("LEDGER_IDENTITY_BROKEN", "critical", `available+pending (${identity}) != ledger (${expected.ledgerBalance})`);
  }

  // Impossible states
  if (expected.availableBalance < -DEFAULT_TOLERANCE) push("NEGATIVE_AVAILABLE", "critical", `${expected.availableBalance}`);
  if (expected.pendingBalance < -DEFAULT_TOLERANCE) push("NEGATIVE_PENDING", "critical", `${expected.pendingBalance}`);
  if (expected.completedWithdrawals > roundCurrency(expected.netPayment + DEFAULT_TOLERANCE)) {
    push("OVER_WITHDRAWN", "critical", `withdrawn ${expected.completedWithdrawals} > net raised ${expected.netPayment}`);
  }
  if (expected.availableBalance > roundCurrency(expected.netPayment + DEFAULT_TOLERANCE)) {
    push("AVAILABLE_EXCEEDS_RAISED", "critical", `available ${expected.availableBalance} > net ${expected.netPayment}`);
  }

  // Orphaned data: a paid contribution with no usable payment_reference
  const orphanPaid = (paidContributions || []).filter(
    (c) => c.status === "paid" && (!c.payment_reference || String(c.payment_reference).trim() === "")
  );
  if (orphanPaid.length) push("PAID_WITHOUT_REFERENCE", "medium", `${orphanPaid.length} paid contribution(s) with no payment_reference`);

  return issues;
}

/**
 * Full per-collection reconciliation record.
 */
export function reconcileCollection({ collectionId, collection = {}, wallets = [], paidContributions = [], withdrawals = [], tolerance = DEFAULT_TOLERANCE }) {
  const expected = expectedBalances(paidContributions, withdrawals, {
    feeBearer: collection.fee_bearer || "organizer",
    collectionType: collection.collection_type || "fixed",
  });
  // Reconcile against the most-recently-updated wallet (matches app read strategy).
  const activeWallet = [...wallets].sort(
    (a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0)
  )[0] || null;
  const drift = diffWallet(expected, activeWallet, tolerance);
  const invariants = checkInvariants({ collectionId, wallets, expected, paidContributions, withdrawals });
  return {
    collectionId,
    expected,
    stored: activeWallet,
    drift,
    invariants,
    ok: drift.length === 0 && invariants.length === 0,
  };
}

export const RECONCILE_TOLERANCE = DEFAULT_TOLERANCE;
