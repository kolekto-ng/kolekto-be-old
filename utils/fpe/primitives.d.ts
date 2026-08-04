/**
 * primitives.ts — L1 pure financial primitives.
 *
 * Deterministic, dependency-free building blocks. No I/O, no Supabase, no
 * fetch, no logging. Time enters ONLY through an explicit `now` parameter
 * (defaulting to `new Date()` so existing call sites behave identically) —
 * there is no hidden `Date.now()` inside the math.
 *
 * Every function here is a verbatim lift of the reference implementation
 * (kolekto-be-old/utils/financial.js), except:
 *   - fee rates / cap / cutoff hour come from constants.ts (one source), and
 *   - `getSettlementCutoff` / `isPaymentSettled` accept an injectable `now`.
 * Behaviour is otherwise byte-identical; the differential parity suite proves
 * it against the live backend file.
 */
import type { ContributionRow, FeeBearer, FeeBreakdown } from "./types.ts";
/**
 * Round to 2 decimal places, coercing non-numeric values to 0.
 *
 * The universal money-rounding primitive: every intermediate and final
 * currency value in the engine passes through this so half-up 2dp behaviour is
 * identical everywhere. (`Number.toFixed` is used exactly as the reference
 * does — matching its rounding to the kobo.)
 */
export declare function roundCurrency(value: unknown): number;
/** Platform rate for a collection type, falling back to the default (0.5%). */
export declare function platformFeeRate(collectionType: string): number;
/**
 * Calculate the Kolekto platform fee, Paystack gateway fee, and totals.
 *
 * Rules (unchanged from the reference):
 *   - Fees are ALWAYS calculated on the contribution amount, never on payable.
 *   - contributor-borne → totalPayable = amount + totalFees
 *   - organizer-borne   → totalPayable = amount (fees come out of the net share)
 *   - Each fee is capped at MAX_FEE_AMOUNT (₦2,000) independently.
 *   - Fees are NEVER folded into Total Raised / net.
 */
export declare function calculateFees(amount: number, collectionType?: string, feeBearer?: FeeBearer): FeeBreakdown;
/**
 * Given the gross amount a contributor paid and the collection settings,
 * derive the NET contribution amount (what the organizer receives).
 *
 * organizer-borne  → gross === net (fees come out of the organizer's share).
 * contributor-borne → gross = net + platformFee + gatewayFee; back it out.
 *   Estimate net = gross / (1 + platformRate + gatewayRate) (exact when
 *   uncapped), then refine once through calculateFees to absorb the ₦2,000
 *   caps. Verbatim lift of the reference (utils/financial.js).
 */
export declare function deriveNetContribution(grossAmount: number, collectionType?: string, feeBearer?: FeeBearer): number;
/**
 * Normalize a single contribution row, correcting legacy rows where
 * `gross_amount` is 0/null by deriving the net amount from the gross.
 *
 *   gross === 0 → row passes through untouched (nothing to derive).
 *   otherwise   → amount := net(gross), gross_amount := gross.
 *
 * organizer-borne  → net = gross − totalFees.
 * contributor-borne → net = deriveNetContribution(gross).
 */
export declare function normalizeContribution<T extends ContributionRow>(row: T, feeBearer?: FeeBearer, collectionType?: string): T;
/**
 * Array form of `normalizeContribution` — the exact signature the Node backend
 * uses (`normalizeContributions`). Preserved for drop-in delegation in Wave 1.
 */
export declare function normalizeContributions<T extends ContributionRow>(contributions: T[] | null | undefined, feeBearer?: FeeBearer, collectionType?: string): T[];
/**
 * The most recent settlement cutoff at or before `now` — SETTLEMENT_HOUR_UTC
 * (04:00) UTC today, or yesterday's if `now` is before today's cutoff.
 *
 * `now` is injectable (defaults to the real clock) so the cutoff is fully
 * deterministic under test and identical across runtimes given the same input.
 */
export declare function getSettlementCutoff(now?: Date): Date;
/**
 * True if a payment made at `paymentDate` has settled (was made strictly
 * before the most recent cutoff at `now`). At/after the cutoff → pending.
 */
export declare function isPaymentSettled(paymentDate: Date | string, now?: Date): boolean;
/**
 * Split `total` across `weights`, rounding each share to 2dp and giving the
 * remainder to the last item so the parts always sum EXACTLY back to `total`
 * (no rounding leakage). Verbatim lift of the edge implementation
 * (supabase/functions/_shared/payment.ts).
 *
 *   empty weights            → []
 *   total === 0 or Σweight 0 → all-zero array of the same length
 */
export declare function allocateAmounts(total: number, weights: number[]): number[];
