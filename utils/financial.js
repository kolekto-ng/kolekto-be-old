/**
 * financial.js — Canonical financial logic for Kolekto backend.
 *
 * All fee calculations, balance derivations, and settlement logic
 * must go through these utilities. Never duplicate this logic in
 * controllers or services.
 *
 * Fee structure (must stay in sync with supabase/functions/_shared/payment.ts):
 *   Platform fee: 1% for fundraising, 0.5% for all others — capped at ₦2,000
 *   Gateway fee:  1.5% for all types                       — capped at ₦2,000
 *
 * Balance definitions:
 *   gross_payment     = sum of what contributors actually paid (includes fees if contributor-borne)
 *   net_payment       = Total Raised = sum of contribution amounts (organizer's money, NO fees mixed in)
 *   pending_balance   = net amounts received today (after 5am WAT) — NOT yet withdrawable
 *   available_balance = settled net amounts minus completed withdrawals — withdrawable
 *   ledger_balance    = available_balance + pending_balance (total funds not yet withdrawn)
 *   withdrawn         = sum of all completed withdrawals
 *
 * T+1 settlement:
 *   Payments clear at 5:00 AM Nigeria Time (WAT = UTC+1), i.e. 4:00 AM UTC.
 *   A payment made Monday at 3pm is available Tuesday at 5am WAT.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLATFORM_FEE_RATES = {
    fundraising: 0.01,   // 1%
    fixed: 0.005,        // 0.5%
    tiered: 0.005,       // 0.5%
    ticket: 0.005,       // 0.5%
    open_pool: 0.005,    // 0.5%
};

const GATEWAY_FEE_RATE = 0.015;   // 1.5%
const MAX_FEE_AMOUNT = 2000;      // ₦2,000 cap per fee

// Settlement: 5am WAT = 4am UTC
const SETTLEMENT_HOUR_UTC = 4;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Round to 2 decimal places, coercing non-numeric values to 0.
 */
export function roundCurrency(value) {
    return Number((Number(value) || 0).toFixed(2));
}

// ---------------------------------------------------------------------------
// Fee calculation
// ---------------------------------------------------------------------------

/**
 * Calculate Kolekto platform fee, Paystack gateway fee, and totals.
 *
 * @param {number} amount         - The contribution amount (NOT including fees)
 * @param {string} collectionType - e.g. "fixed", "fundraising", "ticket", etc.
 * @param {string} feeBearer      - "contributor" | "organizer"
 * @returns {{ platformFee, gatewayFee, totalFees, totalPayable }}
 *
 * Rules:
 *   - Fees are ALWAYS calculated on the contribution amount, not the total payable.
 *   - If feeBearer === "contributor": totalPayable = amount + totalFees
 *   - If feeBearer === "organizer":   totalPayable = amount (fees come out of organizer's share)
 *   - Fees are NEVER added to Total Raised / net_payment. They are always separate.
 */
export function calculateFees(amount, collectionType = "fixed", feeBearer = "organizer") {
    const sanitizedAmount = roundCurrency(amount);
    const platformRate = PLATFORM_FEE_RATES[collectionType] ?? PLATFORM_FEE_RATES.fixed;

    const platformFee = roundCurrency(
        Math.min(sanitizedAmount * platformRate, MAX_FEE_AMOUNT)
    );
    const gatewayFee = roundCurrency(
        Math.min(sanitizedAmount * GATEWAY_FEE_RATE, MAX_FEE_AMOUNT)
    );
    const totalFees = roundCurrency(platformFee + gatewayFee);
    const totalPayable =
        feeBearer === "contributor"
            ? roundCurrency(sanitizedAmount + totalFees)
            : sanitizedAmount;

    return { platformFee, gatewayFee, totalFees, totalPayable };
}

/**
 * Given the gross amount a contributor paid and the collection settings,
 * derive the net contribution amount (what the organizer receives).
 *
 * @param {number} grossAmount    - What the contributor actually paid to Paystack
 * @param {string} collectionType
 * @param {string} feeBearer      - "contributor" | "organizer"
 * @returns {number} Net contribution amount
 */
export function deriveNetContribution(grossAmount, collectionType = "fixed", feeBearer = "organizer") {
    const gross = roundCurrency(grossAmount);
    if (gross <= 0) return 0;

    if (feeBearer === "contributor") {
        // Gross includes fees. Back-calculate contribution amount:
        // gross = contribution + platform_fee + gateway_fee
        // platform_fee = min(contribution * rate, 2000)
        // gateway_fee  = min(contribution * 0.015, 2000)
        // For uncapped amounts: contribution = gross / (1 + platformRate + 0.015)
        // We use the calculateFees function iteratively for accuracy.
        const platformRate = PLATFORM_FEE_RATES[collectionType] ?? PLATFORM_FEE_RATES.fixed;
        const combinedRate = platformRate + GATEWAY_FEE_RATE;

        // Estimate: works exactly when fees are not capped
        let estimate = roundCurrency(gross / (1 + combinedRate));

        // Refine once to account for caps
        const { totalFees } = calculateFees(estimate, collectionType, "contributor");
        const refined = roundCurrency(gross - totalFees);

        return Math.max(0, refined);
    }

    // Organizer-borne: gross === contribution amount; fees deducted from organizer's share
    return gross;
}

// ---------------------------------------------------------------------------
// T+1 Settlement
// ---------------------------------------------------------------------------

/**
 * Returns the most recent settlement cutoff timestamp.
 * Payments recorded BEFORE this time are settled (available).
 * Payments AT OR AFTER this time are pending (available at next cutoff).
 *
 * Settlement occurs at 5:00 AM WAT = 4:00 AM UTC daily.
 *
 * @returns {Date} UTC Date object for the last cutoff
 */
export function getSettlementCutoff() {
    const now = new Date();

    // Today's cutoff: 4am UTC
    const todayCutoff = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        SETTLEMENT_HOUR_UTC, 0, 0, 0
    ));

    // If now is before today's cutoff, use yesterday's cutoff
    return now >= todayCutoff
        ? todayCutoff
        : new Date(todayCutoff.getTime() - 86_400_000);
}

/**
 * Returns true if a payment made at `paymentDate` has settled
 * (i.e. it was made before the last 5am WAT cutoff).
 *
 * @param {Date|string} paymentDate
 * @returns {boolean}
 */
export function isPaymentSettled(paymentDate) {
    const cutoff = getSettlementCutoff();
    return new Date(paymentDate) < cutoff;
}

// ---------------------------------------------------------------------------
// Balance computation
// ---------------------------------------------------------------------------

/**
 * Compute the full wallet balance snapshot from raw contribution and withdrawal data.
 *
 * @param {Array<{amount: number, gross_amount?: number, created_at: string}>} paidContributions
 * @param {Array<{amount: number, status: string}>} withdrawals
 * @returns {{
 *   netPayment: number,
 *   grossPayment: number,
 *   pendingBalance: number,
 *   availableBalance: number,
 *   ledgerBalance: number,
 *   completedWithdrawals: number,
 * }}
 */
export function computeWalletBalances(paidContributions, withdrawals) {
    const cutoff = getSettlementCutoff();

    // Total Raised = sum of all contribution amounts (organizer's money)
    const netPayment = roundCurrency(
        paidContributions.reduce((sum, row) => sum + Number(row.amount || 0), 0)
    );

    // Gross = what contributors actually paid (gross_amount column stores totalPayable per row;
    // fallback to amount if the column is not yet populated for legacy rows)
    const grossPayment = roundCurrency(
        paidContributions.reduce(
            (sum, row) => sum + Number(row.gross_amount || row.amount || 0),
            0
        )
    );

    // Pending = net amounts from payments made AFTER the last cutoff (not yet settleable)
    const pendingBalance = roundCurrency(
        paidContributions
            .filter((row) => {
                const ts = row.created_at ? new Date(row.created_at) : null;
                return ts !== null && ts >= cutoff;
            })
            .reduce((sum, row) => sum + Number(row.amount || 0), 0)
    );

    // Settled = net amounts from payments made BEFORE the cutoff
    const settledNet = roundCurrency(netPayment - pendingBalance);

    // Completed withdrawals (irreversible).
    // "approved" is the status the admin panel writes when the admin marks
    // a manual withdrawal as paid out. Legacy values ("success", "successful",
    // "completed") are preserved for backwards compatibility with rows that
    // were processed via the old Paystack-transfer flow.
    const completedWithdrawals = roundCurrency(
        (withdrawals || [])
            .filter((row) => ["completed", "successful", "success", "approved"].includes(String(row.status || "")))
            .reduce((sum, row) => sum + Number(row.amount || 0), 0)
    );

    // Available = settled net minus what has already left the wallet
    const availableBalance = roundCurrency(Math.max(0, settledNet - completedWithdrawals));

    // Ledger = total funds still in the wallet (pending + available)
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
