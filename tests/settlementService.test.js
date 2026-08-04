// tests/settlementService.test.js
// Phase 2.1C — SettlementService delegates to the single SQL implementation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSettlementService } from "../services/settlementService.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function fakeSupabase(rpcResult) {
  const calls = [];
  return {
    calls,
    rpc: async (fn, args) => {
      calls.push({ fn, args });
      return rpcResult;
    },
  };
}

test("requires a supabase client", () => {
  assert.throws(() => makeSettlementService({}), /supabase/);
});

test("calls settlement_recompute_wallets with the trigger source and returns the run", async () => {
  const sb = fakeSupabase({ data: { ok: true, wallets_processed: 57, drift_after: 0 }, error: null });
  const svc = makeSettlementService({ supabase: sb, logger: silent });
  const run = await svc.runDailySettlement("cron");
  assert.equal(sb.calls.length, 1);
  assert.equal(sb.calls[0].fn, "settlement_recompute_wallets");
  assert.equal(sb.calls[0].args.p_triggered_by, "cron");
  assert.equal(run.wallets_processed, 57);
  assert.equal(run.drift_after, 0);
  assert.equal(run.ok, true);
});

test("handles a single-element array result shape", async () => {
  const sb = fakeSupabase({ data: [{ ok: true, wallets_processed: 10, drift_after: 0 }], error: null });
  const svc = makeSettlementService({ supabase: sb, logger: silent });
  const run = await svc.runDailySettlement("manual");
  assert.equal(sb.calls[0].args.p_triggered_by, "manual");
  assert.equal(run.wallets_processed, 10);
});

test("throws when the rpc returns an error", async () => {
  const sb = fakeSupabase({ data: null, error: { message: "boom" } });
  const svc = makeSettlementService({ supabase: sb, logger: silent });
  await assert.rejects(() => svc.runDailySettlement("cron"), (e) => e.message === "boom");
});

test("surfaces drift_after > 0 loudly (ok=false) but still returns the run", async () => {
  const events = [];
  const spy = { ...silent, error: (e, m) => events.push({ e, m }) };
  const sb = fakeSupabase({ data: { ok: false, wallets_processed: 57, drift_after: 3 }, error: null });
  const svc = makeSettlementService({ supabase: sb, logger: spy });
  const run = await svc.runDailySettlement("cron");
  assert.equal(run.drift_after, 3);
  assert.ok(events.find((x) => x.e === "settlement.drift_after_run"), "should log a drift alert");
});
