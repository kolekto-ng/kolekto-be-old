/**
 * financial.js — Backend ADAPTER over the Financial Projection Engine (FPE).
 *
 * ⚠️  This file no longer implements financial business logic. As of Phase 2.2
 *     Wave 1 it is a thin compatibility layer that DELEGATES every function to
 *     the canonical engine (utils/fpe, vendored from kolekto-shared-financial).
 *     Business math exists in exactly ONE place now — the engine.
 *
 *     • Do NOT add or edit math here. Change the engine
 *       (kolekto-fe-old/kolekto-shared-financial/src) and re-vendor.
 *     • Every historical import keeps working: the public API surface below is
 *       byte-for-byte the same names, signatures, and return shapes as before.
 *
 * Fee structure (unchanged — now sourced from the engine constants):
 *   Platform fee: 1% fundraising / 0.5% others — capped ₦2,000
 *   Gateway fee:  1.5% all types                — capped ₦2,000
 *
 * Balance definitions (unchanged):
 *   gross_payment     = Σ what contributors paid (incl. fees if contributor-borne)
 *   net_payment       = Total Raised = Σ contribution amounts (no fees mixed in)
 *   pending_balance   = net received after the last 5am WAT cutoff (not withdrawable)
 *   available_balance = settled net − completed withdrawals (withdrawable)
 *   ledger_balance    = available + pending
 *   withdrawn         = Σ completed/approved withdrawals
 *
 * T+1 settlement: 5:00 AM WAT (UTC+1) = 4:00 AM UTC.
 *
 * The engine takes an injectable `now` (defaulting to the real clock); these
 * re-exports call it with that default, preserving the previous no-arg
 * signatures exactly.
 */

// ── Canonical implementation (delegation target) ────────────────────────────
export {
  // Primitives (L1) — original public API, unchanged behaviour.
  roundCurrency,
  calculateFees,
  deriveNetContribution,
  getSettlementCutoff,
  isPaymentSettled,
  normalizeContributions,
  // Projections (L2) — original public API.
  computeWalletBalances,
  // Withdrawal eligibility (L2) — the canonical strict-cap math. Exposed here so
  // controllers delegate through this adapter instead of re-deriving the cap
  // inline (see controllers/withdrawal.js).
  computeWithdrawalEligibility,
  computePendingWithdrawals,
} from "./fpe/index.js";

// ── Canonical status sets, as arrays for Supabase `.in(...)` filters ─────────
// One source for withdrawal status classification (was hardcoded in
// controllers/withdrawal.js). Array form because the Supabase query builder's
// `.in()` needs an array; the engine holds the canonical Sets.
import {
  PENDING_WITHDRAWAL_STATUSES as PENDING_SET,
  COMPLETED_WITHDRAWAL_STATUSES as COMPLETED_SET,
} from "./fpe/index.js";

export const PENDING_WITHDRAWAL_STATUSES = [...PENDING_SET];
export const COMPLETED_WITHDRAWAL_STATUSES = [...COMPLETED_SET];
