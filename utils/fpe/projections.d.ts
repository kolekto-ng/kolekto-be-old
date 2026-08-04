/**
 * projections.ts — L2 pure projections.
 *
 * Take arrays of the two source-of-truth streams (paid contributions,
 * withdrawals) and project derived money: wallet balances, organizer roll-ups,
 * collection totals, tier availability, and the withdrawal cap. Pure and
 * deterministic; time enters only via injected `now`.
 *
 * `computeWalletBalances` is a verbatim lift of the reference
 * (kolekto-be-old/utils/financial.js) with the cutoff made injectable and the
 * completed-withdrawal set sourced from constants. `computeWallet` relabels
 * those same numbers into the canonical WalletProjection shape.
 * `buildTierAvailability` is a verbatim lift of the edge implementation.
 */
import type { CollectionTotals, ContributionRow, TierAvailability, TierInput, WalletBalancesLegacy, WalletProjection, WithdrawalEligibility, WithdrawalRow } from "./types.ts";
/**
 * Compute the full wallet balance snapshot from raw paid-contribution and
 * withdrawal rows, in the LEGACY Node field names. This is the byte-for-byte
 * reference shape the differential parity suite compares against the live
 * backend. Prefer `computeWallet` (canonical shape) in new code.
 *
 * @param paidContributions rows with { amount, gross_amount?, created_at }
 * @param withdrawals       rows with { amount, status }
 * @param now               injected clock for the settlement cutoff
 */
export declare function computeWalletBalances(paidContributions: ContributionRow[] | null | undefined, withdrawals: WithdrawalRow[] | null | undefined, now?: Date): WalletBalancesLegacy;
/**
 * Canonical wallet projection. Same numbers as `computeWalletBalances`,
 * relabelled to the engine's WalletProjection shape:
 *   net → net, gross → gross, pending → pending, available → available,
 *   ledger → ledger, completedWithdrawals → withdrawn.
 *
 * Invariants (asserted in the conformance suite):
 *   ledger === available + pending; available >= 0.
 */
export declare function computeWallet(paidContributions: ContributionRow[] | null | undefined, withdrawals: WithdrawalRow[] | null | undefined, now?: Date): WalletProjection;
/** Settled, withdrawable-eligible balance. */
export declare function computeAvailableBalance(paidContributions: ContributionRow[] | null | undefined, withdrawals: WithdrawalRow[] | null | undefined, now?: Date): number;
/** Net from payments not yet past the cutoff. */
export declare function computePendingBalance(paidContributions: ContributionRow[] | null | undefined, now?: Date): number;
/** available + pending — total funds still in the wallet. */
export declare function computeLedgerBalance(paidContributions: ContributionRow[] | null | undefined, withdrawals: WithdrawalRow[] | null | undefined, now?: Date): number;
/**
 * Sum the `available` across all of an organizer's wallet projections.
 * Accepts anything carrying a numeric `available` (a WalletProjection or a
 * persisted wallet row exposing `available_balance`).
 */
export declare function computeOrganizerBalance(wallets: Array<{
    available?: number;
    available_balance?: number;
} | null | undefined>): number;
/**
 * Total Raised + paid count for a collection. `totalContributions` is Σ net
 * `amount` (matching Total Raised); `count` is the number of paid rows.
 */
export declare function computeCollectionTotals(contributions: ContributionRow[] | null | undefined): CollectionTotals;
/** Σ amounts of in-flight (pending/processing) withdrawal requests. */
export declare function computePendingWithdrawals(withdrawals: WithdrawalRow[] | null | undefined, { excludeId }?: {
    excludeId?: string | number | null;
}): number;
/**
 * The strict withdrawable cap: `available − Σ pending withdrawal requests`,
 * floored at 0. Pending requests reserve against the cap but are NOT deducted
 * from `available` (only completed withdrawals reduce available). This is the
 * ONE number the picker and the request validator compare against.
 *
 * @param wallet             a WalletProjection (or any { available } carrier)
 * @param pendingWithdrawals either a pre-summed number, or the raw withdrawal
 *                           rows (they will be summed over PENDING statuses)
 */
export declare function computeWithdrawalEligibility(wallet: {
    available: number;
} | Pick<WalletProjection, "available">, pendingWithdrawals: number | WithdrawalRow[]): WithdrawalEligibility;
/**
 * Compute sold / remaining capacity per price tier from the paid rows.
 * Verbatim lift of supabase/functions/_shared/payment.ts#buildTierAvailability
 * — matches tiers by TierId then Tier name, sums Quantity (default 1).
 */
export declare function buildTierAvailability(tiers: TierInput[], paidRows: Array<Record<string, unknown>>): TierAvailability[];
