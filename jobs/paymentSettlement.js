/**
 * paymentSettlement.js — T+1 Settlement Job
 *
 * Runs daily at 5:00 AM Nigeria Time (WAT = UTC+1), i.e. 4:00 AM UTC.
 *
 * What it does:
 *   For every collection wallet, recomputes available_balance and pending_balance
 *   from the contributions and withdrawals tables. This moves yesterday's pending
 *   payments into available_balance automatically.
 *
 * No custom RPC function is required — all logic runs in the application layer.
 */

import cron from "node-cron";
import { createClient } from "@supabase/supabase-js";
import { computeWalletBalances } from "../utils/financial.js";

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

/**
 * Settle pending balances for all active collection wallets.
 * Fetches contributions + withdrawals per collection and recomputes
 * all balance fields from scratch using the canonical financial utility.
 */
async function runDailySettlement() {
    const startedAt = new Date().toISOString();
    console.log(`[settlement] Starting T+1 settlement run at ${startedAt}`);

    // Fetch all wallets (with their collection IDs)
    const { data: wallets, error: walletsError } = await supabase
        .from("wallets")
        .select("id, collection_id");

    if (walletsError || !wallets) {
        console.error("[settlement] Failed to fetch wallets:", walletsError);
        return;
    }

    console.log(`[settlement] Processing ${wallets.length} wallets...`);

    let settled = 0;
    let failed = 0;

    for (const wallet of wallets) {
        try {
            const [{ data: contributions, error: contribError }, { data: withdrawals, error: withError }] =
                await Promise.all([
                    supabase
                        .from("contributions")
                        .select("amount, gross_amount, created_at")
                        .eq("collection_id", wallet.collection_id)
                        .eq("status", "paid"),
                    supabase
                        .from("withdrawals")
                        .select("amount, status")
                        .eq("collection_id", wallet.collection_id),
                ]);

            if (contribError || withError) {
                console.error(
                    `[settlement] Error fetching data for collection ${wallet.collection_id}:`,
                    contribError || withError
                );
                failed++;
                continue;
            }

            const balances = computeWalletBalances(contributions || [], withdrawals || []);

            const { error: updateError } = await supabase
                .from("wallets")
                .update({
                    net_payment: balances.netPayment,
                    pending_balance: balances.pendingBalance,
                    available_balance: balances.availableBalance,
                    ledger_balance: balances.ledgerBalance,
                    withdrawn: balances.completedWithdrawals,
                    updated_at: new Date().toISOString(),
                })
                .eq("id", wallet.id);

            if (updateError) {
                console.error(
                    `[settlement] Failed to update wallet ${wallet.id}:`,
                    updateError
                );
                failed++;
                continue;
            }

            if (balances.pendingBalance === 0 && balances.availableBalance > 0) {
                // All pending settled — nothing special needed, balances already updated
            }

            settled++;
        } catch (err) {
            console.error(
                `[settlement] Unexpected error for wallet ${wallet.id}:`,
                err?.message || err
            );
            failed++;
        }
    }

    console.log(
        `[settlement] ✅ Settlement run complete. Settled: ${settled}, Failed: ${failed}. Finished at ${new Date().toISOString()}`
    );
}

/**
 * Schedule: 4:00 AM UTC daily = 5:00 AM WAT (Nigeria Time).
 * Cron syntax: "0 4 * * *" = minute=0, hour=4, every day.
 */
cron.schedule("0 4 * * *", () => {
    runDailySettlement().catch((err) => {
        console.error("[settlement] Unhandled error in settlement job:", err?.message || err);
    });
});

console.log("[settlement] T+1 settlement job scheduled — runs daily at 5:00 AM WAT (4:00 AM UTC)");

// Export for manual trigger (e.g. admin endpoint or testing)
export { runDailySettlement };
