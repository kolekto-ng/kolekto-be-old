// services/settlementService.js
//
// The canonical SettlementService (Phase 2.1C). It is deliberately a THIN
// wrapper over the single settlement implementation — the Postgres function
// `settlement_recompute_wallets()` (see database/settlement_recompute.sql).
//
// Why a DB function is the one implementation: settlement must (a) derive only
// from `contributions` (source of truth), (b) run reliably on schedule, and
// (c) never duplicate the balance math. The reliable scheduler in Kolekto's
// Supabase-centric deployment is pg_cron (the Node cron was found not to
// execute — see SETTLEMENT_ARCHITECTURE_AUDIT.md). Placing the recompute in the
// database, called by pg_cron, satisfies all three. This service is the code
// entry point (used by the Node cron, an admin trigger, or tests) and delegates
// to that ONE function — so there is exactly one balance-math implementation for
// settlement. Consolidating the remaining event-path recompute copies
// (edge/Node) into a shared WalletService is Phase 2.1.
import { auditFinancial } from "../utils/financialAudit.js";

/**
 * @param {{ supabase: object, logger?: object }} deps
 */
export function makeSettlementService({ supabase, logger = console } = {}) {
  if (!supabase) throw new Error("settlementService requires a supabase client");

  /**
   * Recompute every wallet projection from contributions+withdrawals and record
   * the run. Idempotent, atomic, observable. Returns the settlement_runs row.
   * @param {string} triggeredBy 'cron' | 'manual' | 'admin' | ...
   */
  async function runDailySettlement(triggeredBy = "cron") {
    const { data, error } = await supabase.rpc("settlement_recompute_wallets", {
      p_triggered_by: triggeredBy,
    });

    if (error) {
      auditFinancial("settlement_failed", { result: "failure", triggeredBy, err: error }, logger);
      throw error;
    }

    // Supabase returns the composite row (object) or a single-element array.
    const run = Array.isArray(data) ? data[0] : data;

    auditFinancial("settlement_completed", {
      result: run?.ok ? "success" : "failure",
      triggeredBy,
      walletsProcessed: run?.wallets_processed,
      driftAfter: run?.drift_after,
    }, logger);

    if (run && run.ok === false) {
      // Settlement completed but left drift — surface loudly for monitoring.
      logger.error?.("settlement.drift_after_run", { driftAfter: run.drift_after });
    }
    return run;
  }

  return { runDailySettlement };
}

export default makeSettlementService;
