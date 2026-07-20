/**
 * constants.ts — L0 canonical financial constants.
 *
 * THE single source for every rate, cap, hour, and status set in Kolekto's
 * money math. Node and Deno import these; the SQL mirror hard-codes the same
 * literals under `-- MIRRORS kolekto-shared-financial` annotation.
 *
 * Lifted verbatim from the reference implementation (kolekto-be-old
 * utils/financial.js), which reconciliation validates at 0 drift. The ONE
 * deliberate convergence: COMPLETED_WITHDRAWAL_STATUSES adopts the Node set
 * (the superset), resolving the latent Node/Edge divergence documented in
 * FINANCIAL_COMPUTATION_MATRIX.md row 15.
 */
import type { CollectionType, FeeBearer } from "./types.ts";
/**
 * Platform fee rate per collection type.
 *   fundraising → 1%; everything else → 0.5%.
 * Unknown types fall back to PLATFORM_FEE_RATE_DEFAULT (see calculateFees).
 */
export declare const PLATFORM_FEE_RATES: Readonly<Record<CollectionType, number>>;
/** Fallback platform rate for any collection type not in PLATFORM_FEE_RATES. */
export declare const PLATFORM_FEE_RATE_DEFAULT = 0.005;
/** Paystack gateway fee rate — 1.5% for all collection types. */
export declare const GATEWAY_FEE_RATE = 0.015;
/** Per-fee cap: each of platform and gateway fee is capped at ₦2,000. */
export declare const MAX_FEE_AMOUNT = 2000;
/**
 * T+1 settlement hour, in UTC. Settlement runs at 5:00 AM WAT (UTC+1) = 4:00
 * AM UTC. A payment made before the most recent 04:00 UTC cutoff is settled
 * (available); at/after is pending until the next cutoff.
 */
export declare const SETTLEMENT_HOUR_UTC = 4;
/** Milliseconds in one day — the cutoff step. */
export declare const ONE_DAY_MS = 86400000;
/**
 * Withdrawal statuses that count as money that has LEFT the wallet.
 *
 * CANONICAL (superset). Node accepted all four; Edge accepted only
 * {completed, successful}. The engine adopts Node's set — the value
 * reconciliation already validates at 0 drift. Edge conformance to this set is
 * proven by the "approved"/"success" divergence golden vectors.
 *
 *   completed / successful / success → legacy Paystack-transfer terminal states
 *   approved                         → the state the admin panel writes on a
 *                                      manual payout ("mark as paid")
 */
export declare const COMPLETED_WITHDRAWAL_STATUSES: ReadonlySet<string>;
/**
 * Withdrawal statuses that are in-flight: they reserve against the withdrawable
 * cap but are NOT yet deducted from `available` (only completed withdrawals
 * reduce available). See computeWithdrawalEligibility.
 */
export declare const PENDING_WITHDRAWAL_STATUSES: ReadonlySet<string>;
/** All recognised collection types (for validation / iteration). */
export declare const COLLECTION_TYPES: readonly CollectionType[];
/** The two fee bearers. */
export declare const FEE_BEARERS: readonly FeeBearer[];
/**
 * Aggregate constant bag — the shape design docs refer to as `FPE.CONSTANTS`.
 * Prefer the named exports above in new code; this is a convenience view.
 */
export declare const CONSTANTS: {
    readonly PLATFORM_FEE_RATES: Readonly<Record<CollectionType, number>>;
    readonly PLATFORM_FEE_RATE_DEFAULT: 0.005;
    readonly GATEWAY_FEE_RATE: 0.015;
    readonly MAX_FEE_AMOUNT: 2000;
    readonly SETTLEMENT_HOUR_UTC: 4;
    readonly ONE_DAY_MS: 86400000;
    readonly COMPLETED_WITHDRAWAL_STATUSES: ReadonlySet<string>;
    readonly PENDING_WITHDRAWAL_STATUSES: ReadonlySet<string>;
    readonly COLLECTION_TYPES: readonly CollectionType[];
    readonly FEE_BEARERS: readonly FeeBearer[];
};
