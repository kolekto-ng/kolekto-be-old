// AUTO-GENERATED from kolekto-shared-financial — DO NOT EDIT BY HAND.
// Regenerate: (in kolekto-fe-old/kolekto-shared-financial) npm run build && npm run vendor:backend
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
import { COMPLETED_WITHDRAWAL_STATUSES, PENDING_WITHDRAWAL_STATUSES } from "./constants.js";
import { getSettlementCutoff, roundCurrency } from "./primitives.js";
// ---------------------------------------------------------------------------
// Wallet balance projection (the core)
// ---------------------------------------------------------------------------
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
export function computeWalletBalances(paidContributions, withdrawals, now = new Date()) {
    const cutoff = getSettlementCutoff(now);
    const rows = paidContributions || [];
    // Total Raised = Σ net contribution amounts (organizer's money).
    const netPayment = roundCurrency(rows.reduce((sum, row) => sum + Number(row.amount || 0), 0));
    // Gross = what contributors actually paid (gross_amount, falling back to
    // amount for legacy rows that never populated the column).
    const grossPayment = roundCurrency(rows.reduce((sum, row) => sum + Number(row.gross_amount || row.amount || 0), 0));
    // Pending = net from payments made AT/AFTER the last cutoff (not settleable).
    const pendingBalance = roundCurrency(rows
        .filter((row) => {
        const ts = row.created_at ? new Date(row.created_at) : null;
        return ts !== null && ts >= cutoff;
    })
        .reduce((sum, row) => sum + Number(row.amount || 0), 0));
    // Settled = net from payments made BEFORE the cutoff.
    const settledNet = roundCurrency(netPayment - pendingBalance);
    // Completed withdrawals (irreversible) — canonical superset status match.
    const completedWithdrawals = roundCurrency((withdrawals || [])
        .filter((row) => COMPLETED_WITHDRAWAL_STATUSES.has(String(row.status || "")))
        .reduce((sum, row) => sum + Number(row.amount || 0), 0));
    // Available = settled net minus what has already left the wallet (floored 0).
    const availableBalance = roundCurrency(Math.max(0, settledNet - completedWithdrawals));
    // Ledger = total funds still in the wallet (pending + available).
    const ledgerBalance = roundCurrency(availableBalance + pendingBalance);
    return {
        netPayment,
        grossPayment,
        pendingBalance,
        availableBalance,
        ledgerBalance,
        completedWithdrawals,
    };
}
/**
 * Canonical wallet projection. Same numbers as `computeWalletBalances`,
 * relabelled to the engine's WalletProjection shape:
 *   net → net, gross → gross, pending → pending, available → available,
 *   ledger → ledger, completedWithdrawals → withdrawn.
 *
 * Invariants (asserted in the conformance suite):
 *   ledger === available + pending; available >= 0.
 */
export function computeWallet(paidContributions, withdrawals, now = new Date()) {
    const b = computeWalletBalances(paidContributions, withdrawals, now);
    return {
        gross: b.grossPayment,
        net: b.netPayment,
        withdrawn: b.completedWithdrawals,
        pending: b.pendingBalance,
        available: b.availableBalance,
        ledger: b.ledgerBalance,
    };
}
// ---------------------------------------------------------------------------
// Balance selectors (over the canonical projection)
// ---------------------------------------------------------------------------
/** Settled, withdrawable-eligible balance. */
export function computeAvailableBalance(paidContributions, withdrawals, now = new Date()) {
    return computeWallet(paidContributions, withdrawals, now).available;
}
/** Net from payments not yet past the cutoff. */
export function computePendingBalance(paidContributions, now = new Date()) {
    return computeWallet(paidContributions, [], now).pending;
}
/** available + pending — total funds still in the wallet. */
export function computeLedgerBalance(paidContributions, withdrawals, now = new Date()) {
    return computeWallet(paidContributions, withdrawals, now).ledger;
}
/**
 * Sum the `available` across all of an organizer's wallet projections.
 * Accepts anything carrying a numeric `available` (a WalletProjection or a
 * persisted wallet row exposing `available_balance`).
 */
export function computeOrganizerBalance(wallets) {
    return roundCurrency((wallets || []).reduce((sum, w) => {
        if (!w)
            return sum;
        const available = w.available ?? w.available_balance ?? 0;
        return sum + Number(available || 0);
    }, 0));
}
// ---------------------------------------------------------------------------
// Collection totals
// ---------------------------------------------------------------------------
/**
 * Total Raised + paid count for a collection. `totalContributions` is Σ net
 * `amount` (matching Total Raised); `count` is the number of paid rows.
 */
export function computeCollectionTotals(contributions) {
    const rows = contributions || [];
    const totalContributions = roundCurrency(rows.reduce((sum, row) => sum + Number(row.amount || 0), 0));
    return { totalContributions, count: rows.length };
}
// ---------------------------------------------------------------------------
// Withdrawal eligibility (strict cap)
// ---------------------------------------------------------------------------
/** Σ amounts of in-flight (pending/processing) withdrawal requests. */
export function computePendingWithdrawals(withdrawals, { excludeId = null } = {}) {
    return roundCurrency((withdrawals || [])
        .filter((row) => {
        if (excludeId != null && row.id === excludeId) {
            return false;
        }
        return PENDING_WITHDRAWAL_STATUSES.has(String(row.status || ""));
    })
        .reduce((sum, row) => sum + Number(row.amount || 0), 0));
}
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
export function computeWithdrawalEligibility(wallet, pendingWithdrawals) {
    const pending = typeof pendingWithdrawals === "number"
        ? roundCurrency(pendingWithdrawals)
        : computePendingWithdrawals(pendingWithdrawals);
    const cap = roundCurrency(Math.max(0, Number(wallet.available || 0) - pending));
    return { withdrawable: cap, cap };
}
// ---------------------------------------------------------------------------
// Tier availability (verbatim lift of the edge implementation)
// ---------------------------------------------------------------------------
function asNumber(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value.replace(/,/g, ""));
        if (Number.isFinite(parsed))
            return parsed;
    }
    return 0;
}
function asPositiveInt(value) {
    const parsed = Math.floor(asNumber(value));
    return parsed > 0 ? parsed : 0;
}
function getTierMatchKey(tier, index) {
    return String(tier.id || tier.name || `tier-${index}`);
}
function getTierLabel(tier, index) {
    return String(tier.name || `Tier ${index + 1}`);
}
function getInfoRows(row) {
    if (Array.isArray(row.contributor_information)) {
        return row.contributor_information.filter((entry) => entry && typeof entry === "object");
    }
    if (row.contact_info && typeof row.contact_info === "object") {
        return [row.contact_info];
    }
    return [];
}
/**
 * Compute sold / remaining capacity per price tier from the paid rows.
 * Verbatim lift of supabase/functions/_shared/payment.ts#buildTierAvailability
 * — matches tiers by TierId then Tier name, sums Quantity (default 1).
 */
export function buildTierAvailability(tiers, paidRows) {
    const soldByTier = new Map();
    for (const row of paidRows) {
        const infoRows = getInfoRows(row);
        for (const info of infoRows) {
            const tierId = info.TierId ? String(info.TierId) : "";
            const tierName = info.Tier ? String(info.Tier) : "";
            const quantity = asPositiveInt(info.Quantity) || 1;
            if (tierId) {
                soldByTier.set(tierId, (soldByTier.get(tierId) || 0) + quantity);
            }
            else if (tierName) {
                soldByTier.set(tierName, (soldByTier.get(tierName) || 0) + quantity);
            }
        }
    }
    return tiers.map((tier, index) => {
        const tierId = tier.id ? String(tier.id) : null;
        const tierName = getTierLabel(tier, index);
        const sold = (tierId ? soldByTier.get(tierId) : undefined) ||
            soldByTier.get(tierName) ||
            0;
        const totalCapacity = tier.quantity == null ? null : asPositiveInt(tier.quantity);
        const remainingCapacity = totalCapacity == null ? null : Math.max(0, totalCapacity - sold);
        return {
            ...tier,
            tierId,
            tierName,
            tierKey: getTierMatchKey(tier, index),
            sold,
            totalCapacity,
            remainingCapacity,
        };
    });
}
