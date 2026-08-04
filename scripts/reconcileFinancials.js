// scripts/reconcileFinancials.js
//
// PHASE 2.0 GUARDRAILS — Balance Reconciliation + Financial Consistency runner.
//
// READ-ONLY. Recomputes canonical balances from source rows (contributions +
// withdrawals) and compares them against the stored `wallets` projection for
// EVERY collection, plus flags impossible states. It NEVER writes anything.
//
// Because the stored wallet columns were written by whichever implementation
// last ran (Node updateWalletStats / Deno refreshCollectionAndWallets / SQL
// process_deposit_settlements), agreement between "expected" (canonical Node)
// and "stored" is the practical proof that all three implementations currently
// produce identical results. Any drift row is a discrepancy to investigate.
//
// Usage (never against prod without intent):
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/reconcileFinancials.js
//   Optional: RECONCILE_LIMIT=100  RECONCILE_JSON=1
import { createClient } from "@supabase/supabase-js";
import { reconcileCollection } from "../utils/financialReconcile.js";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

async function main() {
  if (!URL || !KEY) {
    console.error("[reconcile] SUPABASE_URL / key not set — nothing to do. Set them to run against a project.");
    process.exit(0);
  }
  const db = createClient(URL, KEY, { auth: { persistSession: false } });
  const limit = Number(process.env.RECONCILE_LIMIT || 0);
  const asJson = process.env.RECONCILE_JSON === "1";

  let query = db.from("collections").select("id, fee_bearer, collection_type").neq("status", "deleted");
  if (limit > 0) query = query.limit(limit);
  const { data: collections, error } = await query;
  if (error) { console.error("[reconcile] failed to load collections:", error.message); process.exit(1); }

  const results = [];
  for (const collection of collections || []) {
    const [{ data: wallets }, { data: paid }, { data: withdrawals }] = await Promise.all([
      db.from("wallets").select("*").eq("collection_id", collection.id),
      db.from("contributions").select("amount, gross_amount, created_at, status, payment_reference").eq("collection_id", collection.id).eq("status", "paid"),
      db.from("withdrawals").select("amount, status").eq("collection_id", collection.id),
    ]);
    results.push(
      reconcileCollection({
        collectionId: collection.id,
        collection,
        wallets: wallets || [],
        paidContributions: paid || [],
        withdrawals: withdrawals || [],
      })
    );
  }

  const drifted = results.filter((r) => r.drift.length > 0);
  const withIssues = results.filter((r) => r.invariants.length > 0);

  if (asJson) {
    console.log(JSON.stringify({ total: results.length, drifted, withIssues }, null, 2));
  } else {
    console.log(`\n=== Financial Reconciliation Report ===`);
    console.log(`Collections checked : ${results.length}`);
    console.log(`Balance drift       : ${drifted.length}`);
    console.log(`Consistency issues  : ${withIssues.length}\n`);
    for (const r of drifted) {
      console.log(`DRIFT  ${r.collectionId}`);
      for (const d of r.drift) console.log(`   ${d.field}: stored=${d.stored} expected=${d.expected} Δ=${d.delta}`);
    }
    for (const r of withIssues) {
      for (const i of r.invariants) console.log(`ISSUE  ${r.collectionId}  [${i.severity}] ${i.code} — ${i.detail}`);
    }
    const ok = drifted.length === 0 && withIssues.length === 0;
    console.log(`\n${ok ? "✅ All balances reconcile; no impossible states." : "⚠️  Discrepancies found — investigate above (nothing was modified)."}`);
  }
}

main().catch((e) => { console.error("[reconcile] unexpected:", e?.message || e); process.exit(1); });
