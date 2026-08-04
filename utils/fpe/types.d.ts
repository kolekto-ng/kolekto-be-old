/**
 * types.ts — L0 type contracts for the Financial Projection Engine.
 *
 * These are pure type declarations (erased at runtime). They describe the
 * shapes the engine consumes and produces. Every runtime (Node, Deno) shares
 * these definitions; the SQL mirror encodes the same shapes as columns.
 *
 * DESIGN INVARIANT: the engine is a projection. Its inputs are only the two
 * immutable financial event streams — paid `contributions` and `withdrawals`.
 * Everything else (wallets) is derived output, never input.
 */
/** Who absorbs the platform + gateway fees. */
export type FeeBearer = "contributor" | "organizer";
/**
 * The collection product types. The engine only branches on these for fee
 * rates and normalization; all other product behaviour lives in the callers.
 */
export type CollectionType = "fixed" | "fundraising" | "tiered" | "ticket" | "open_pool";
/**
 * A single paid contribution row — one of the two sources of truth.
 *
 *   amount       = the NET contribution (the organizer's money; NO fees mixed in)
 *   gross_amount = what the contributor actually paid the gateway (net + fees
 *                  when contributor-borne; equal to net when organizer-borne).
 *                  May be absent/0 on legacy rows → falls back to `amount`.
 *   created_at   = ISO timestamp used to classify settled vs pending at cutoff.
 */
export interface ContributionRow {
    amount: number;
    gross_amount?: number | null;
    created_at?: string | null;
    [key: string]: unknown;
}
/**
 * A withdrawal row — the second source of truth. Only `amount` and `status`
 * participate in balance math. Status is matched against the canonical
 * COMPLETED / PENDING sets in constants.ts.
 */
export interface WithdrawalRow {
    amount: number;
    status?: string | null;
    [key: string]: unknown;
}
/** Output of `calculateFees`. `totalPayable` is what the contributor is charged. */
export interface FeeBreakdown {
    platformFee: number;
    gatewayFee: number;
    totalFees: number;
    totalPayable: number;
}
/**
 * The one wallet shape the engine projects. Enforced invariants (asserted in
 * the conformance suite):
 *   - ledger === available + pending
 *   - available >= 0
 *   - withdrawn <= net (a wallet cannot withdraw more than it ever earned net)
 */
export interface WalletProjection {
    /** Σ gross paid (what contributors handed the gateway). */
    gross: number;
    /** Σ net (Total Raised) — organizer money, fees excluded. */
    net: number;
    /** Σ completed/approved withdrawals. */
    withdrawn: number;
    /** Σ net where created_at >= cutoff (not yet settleable). */
    pending: number;
    /** max(0, settledNet − withdrawn) — the withdrawable-eligible settled money. */
    available: number;
    /** available + pending — total funds still in the wallet. */
    ledger: number;
}
/**
 * The legacy Node field names (utils/financial.js#computeWalletBalances).
 * Kept as an explicit shape so the Node adapter and the differential parity
 * suite can compare byte-for-byte against today's backend without any mapping
 * ambiguity. `computeWallet` (the canonical output) is a pure relabelling of
 * these same numbers.
 */
export interface WalletBalancesLegacy {
    netPayment: number;
    grossPayment: number;
    pendingBalance: number;
    availableBalance: number;
    ledgerBalance: number;
    completedWithdrawals: number;
}
/** Output of `computeCollectionTotals`. */
export interface CollectionTotals {
    /** Σ net contribution amounts (Total Raised). */
    totalContributions: number;
    /** Count of paid contribution rows. */
    count: number;
}
/** Output of `computeWithdrawalEligibility` — the strict withdrawable cap. */
export interface WithdrawalEligibility {
    /** available − Σ pending withdrawal requests, floored at 0. */
    withdrawable: number;
    /** Alias of `withdrawable`; the cap the UI and validator compare against. */
    cap: number;
}
/** A price tier as stored on a collection (loose shape — passthrough preserved). */
export interface TierInput {
    id?: string | null;
    name?: string | null;
    price?: number | null;
    quantity?: number | null;
    prefix?: string | null;
    description?: string | null;
    [key: string]: unknown;
}
/** Output row of `buildTierAvailability` (input tier + sold/remaining stats). */
export interface TierAvailability extends TierInput {
    tierId: string | null;
    tierName: string;
    tierKey: string;
    sold: number;
    totalCapacity: number | null;
    remainingCapacity: number | null;
}
