// AUTO-GENERATED from kolekto-shared-financial — DO NOT EDIT BY HAND.
// Regenerate: (in kolekto-fe-old/kolekto-shared-financial) npm run build && npm run vendor:backend
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
import { GATEWAY_FEE_RATE, MAX_FEE_AMOUNT, ONE_DAY_MS, PLATFORM_FEE_RATE_DEFAULT, PLATFORM_FEE_RATES, SETTLEMENT_HOUR_UTC, } from "./constants.js";
// ---------------------------------------------------------------------------
// roundCurrency
// ---------------------------------------------------------------------------
/**
 * Round to 2 decimal places, coercing non-numeric values to 0.
 *
 * The universal money-rounding primitive: every intermediate and final
 * currency value in the engine passes through this so half-up 2dp behaviour is
 * identical everywhere. (`Number.toFixed` is used exactly as the reference
 * does — matching its rounding to the kobo.)
 */
export function roundCurrency(value) {
    return Number((Number(value) || 0).toFixed(2));
}
// ---------------------------------------------------------------------------
// Fee rate lookup
// ---------------------------------------------------------------------------
/** Platform rate for a collection type, falling back to the default (0.5%). */
export function platformFeeRate(collectionType) {
    return (PLATFORM_FEE_RATES[collectionType] ??
        PLATFORM_FEE_RATE_DEFAULT);
}
// ---------------------------------------------------------------------------
// calculateFees
// ---------------------------------------------------------------------------
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
export function calculateFees(amount, collectionType = "fixed", feeBearer = "organizer") {
    const sanitizedAmount = roundCurrency(amount);
    const platformRate = platformFeeRate(collectionType);
    const platformFee = roundCurrency(Math.min(sanitizedAmount * platformRate, MAX_FEE_AMOUNT));
    const gatewayFee = roundCurrency(Math.min(sanitizedAmount * GATEWAY_FEE_RATE, MAX_FEE_AMOUNT));
    const totalFees = roundCurrency(platformFee + gatewayFee);
    const totalPayable = feeBearer === "contributor"
        ? roundCurrency(sanitizedAmount + totalFees)
        : sanitizedAmount;
    return { platformFee, gatewayFee, totalFees, totalPayable };
}
// ---------------------------------------------------------------------------
// deriveNetContribution
// ---------------------------------------------------------------------------
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
export function deriveNetContribution(grossAmount, collectionType = "fixed", feeBearer = "organizer") {
    const gross = roundCurrency(grossAmount);
    if (gross <= 0)
        return 0;
    if (feeBearer === "contributor") {
        const platformRate = platformFeeRate(collectionType);
        const combinedRate = platformRate + GATEWAY_FEE_RATE;
        // Exact when fees are not capped.
        const estimate = roundCurrency(gross / (1 + combinedRate));
        // Refine once to account for the per-fee caps.
        const { totalFees } = calculateFees(estimate, collectionType, "contributor");
        const refined = roundCurrency(gross - totalFees);
        return Math.max(0, refined);
    }
    // Organizer-borne: gross is the contribution amount.
    return gross;
}
// ---------------------------------------------------------------------------
// normalizeContribution(s)
// ---------------------------------------------------------------------------
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
export function normalizeContribution(row, feeBearer = "organizer", collectionType = "fixed") {
    const gross = Number(row.gross_amount || row.amount || 0);
    if (gross === 0)
        return row;
    const { totalFees } = calculateFees(gross, collectionType, feeBearer);
    const net = feeBearer === "organizer"
        ? roundCurrency(gross - totalFees)
        : deriveNetContribution(gross, collectionType, feeBearer);
    return {
        ...row,
        amount: net,
        gross_amount: gross,
    };
}
/**
 * Array form of `normalizeContribution` — the exact signature the Node backend
 * uses (`normalizeContributions`). Preserved for drop-in delegation in Wave 1.
 */
export function normalizeContributions(contributions, feeBearer = "organizer", collectionType = "fixed") {
    return (contributions || []).map((row) => normalizeContribution(row, feeBearer, collectionType));
}
// ---------------------------------------------------------------------------
// T+1 settlement
// ---------------------------------------------------------------------------
/**
 * The most recent settlement cutoff at or before `now` — SETTLEMENT_HOUR_UTC
 * (04:00) UTC today, or yesterday's if `now` is before today's cutoff.
 *
 * `now` is injectable (defaults to the real clock) so the cutoff is fully
 * deterministic under test and identical across runtimes given the same input.
 */
export function getSettlementCutoff(now = new Date()) {
    const todayCutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), SETTLEMENT_HOUR_UTC, 0, 0, 0));
    return now >= todayCutoff
        ? todayCutoff
        : new Date(todayCutoff.getTime() - ONE_DAY_MS);
}
/**
 * True if a payment made at `paymentDate` has settled (was made strictly
 * before the most recent cutoff at `now`). At/after the cutoff → pending.
 */
export function isPaymentSettled(paymentDate, now = new Date()) {
    const cutoff = getSettlementCutoff(now);
    return new Date(paymentDate) < cutoff;
}
// ---------------------------------------------------------------------------
// allocateAmounts
// ---------------------------------------------------------------------------
/**
 * Split `total` across `weights`, rounding each share to 2dp and giving the
 * remainder to the last item so the parts always sum EXACTLY back to `total`
 * (no rounding leakage). Verbatim lift of the edge implementation
 * (supabase/functions/_shared/payment.ts).
 *
 *   empty weights            → []
 *   total === 0 or Σweight 0 → all-zero array of the same length
 */
export function allocateAmounts(total, weights) {
    const normalizedWeights = weights.map((weight) => roundCurrency(Math.max(0, weight)));
    const sum = normalizedWeights.reduce((acc, weight) => acc + weight, 0);
    if (normalizedWeights.length === 0)
        return [];
    if (roundCurrency(total) === 0 || sum === 0) {
        return normalizedWeights.map(() => 0);
    }
    let remaining = roundCurrency(total);
    return normalizedWeights.map((weight, index) => {
        if (index === normalizedWeights.length - 1) {
            return remaining;
        }
        const share = roundCurrency((total * weight) / sum);
        remaining = roundCurrency(remaining - share);
        return share;
    });
}
