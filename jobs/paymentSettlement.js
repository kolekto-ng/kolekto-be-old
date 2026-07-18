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
import { makeSettlementService } from "../services/settlementService.js";

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

/**
 * Settle pending balances for all active collection wallets.
 * Fetches contributions + withdrawals per collection and recomputes
 * all balance fields from scratch using the canonical financial utility.
 */
// Delegates to the canonical settlement implementation — the Postgres function
// settlement_recompute_wallets() (database/settlement_recompute.sql) — via
// services/settlementService.js. The Node balance loop that used to live here
// was removed: the DB function is now the single source of the settlement math
// (derives from contributions, never deposits; idempotent; observable).
//
// NOTE: the reliable scheduler is pg_cron (job 'settlement-recompute-wallets').
// Keep RUN_SETTLEMENT_CRON=false so there is exactly ONE active settlement
// scheduler. This Node path remains for manual/admin triggers and as a fallback.
const settlementService = makeSettlementService({ supabase });

async function runDailySettlement() {
    console.log("[settlement] Starting T+1 settlement (delegating to settlement_recompute_wallets)...");
    try {
        const run = await settlementService.runDailySettlement("cron");
        console.log(
            `[settlement] ✅ Settlement complete: wallets=${run?.wallets_processed}, ` +
            `drift_after=${run?.drift_after}, ok=${run?.ok}`
        );
        return run;
    } catch (err) {
        console.error("[settlement] ❌ Settlement failed:", err?.message || err);
        throw err;
    }
}

/**
 * Schedule: 4:00 AM UTC daily = 5:00 AM WAT (Nigeria Time).
 * Cron syntax: "0 4 * * *" = minute=0, hour=4, every day.
 *
 * B-8: Single-replica gate.
 *   Previously this scheduled the cron at module-load time, so every backend
 *   replica scheduled its own daily run. With N replicas, the wallet recompute
 *   fires N times in close succession at 5am WAT — wasteful at best, and on
 *   any future non-idempotent change a real correctness risk.
 *
 *   We now schedule only when RUN_SETTLEMENT_CRON=true. Set this on EXACTLY
 *   ONE replica (the "leader"). On other replicas it stays disabled.
 *
 *   The export `runDailySettlement` is still available for manual triggers
 *   (admin endpoint, scripts) regardless of the env flag.
 */
if (process.env.RUN_SETTLEMENT_CRON === "true") {
    cron.schedule("0 4 * * *", () => {
        runDailySettlement().catch((err) => {
            console.error("[settlement] Unhandled error in settlement job:", err?.message || err);
        });
    });
    console.log(
        "[settlement] T+1 settlement job scheduled — runs daily at 5:00 AM WAT (4:00 AM UTC)"
    );
} else {
    console.log(
        "[settlement] cron NOT scheduled — set RUN_SETTLEMENT_CRON=true on exactly ONE replica to enable. The runDailySettlement export remains available for manual triggers."
    );
}

// Export for manual trigger (e.g. admin endpoint or testing)
export { runDailySettlement };
