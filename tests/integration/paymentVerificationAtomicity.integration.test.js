// tests/integration/paymentVerificationAtomicity.integration.test.js
//
// P0 concurrency/idempotency tests for the H1 fix (database/h1_atomic_payment_verification.sql).
// These exercise the REAL public.claim_payment_contributions() Postgres function
// against a REAL Supabase project — the exact function verify-paystack-payment
// calls (behind VERIFY_USE_ATOMIC_RPC) to make idempotency + tier-capacity +
// insert atomic. No mocks: the invariant under test (a row lock serializing
// concurrent callers) cannot be verified against a mock.
//
// SAFETY — this suite is OPT-IN and never runs against production:
//   - Uses SUPABASE_TEST_URL / SUPABASE_TEST_SERVICE_ROLE_KEY if set, else
//     falls back to this backend's own SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
//     (which, for local/dev/test runs, points at the Kolekto TEST project).
//   - Refuses outright if the resolved URL matches the known PRODUCTION ref.
//   - Every test creates its own throwaway collection and deletes it (and its
//     contributions) in `after`/inline cleanup — nothing here touches
//     pre-existing data.
//
// Run: npm run test:integration
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_TEST_URL || process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

const PROD_REFS = ["busfgcmbndleljklrcbd"];
const looksLikeProd = URL && PROD_REFS.some((ref) => URL.includes(ref));

const skip =
  !URL || !KEY
    ? "SUPABASE_TEST_URL/SUPABASE_URL + a service-role key are required — skipping"
    : looksLikeProd
    ? "REFUSING to run atomicity tests against the production Supabase project"
    : false;

const client = skip ? null : createClient(URL, KEY, { auth: { persistSession: false } });

const createdCollectionIds = [];

async function makeScratchCollection(db, { quantity = 1, maxContributions = null } = {}) {
  const { data: profile } = await db.from("profiles").select("id").limit(1).maybeSingle();
  const { data, error } = await db
    .from("collections")
    .insert({
      user_id: profile?.id || null,
      title: "__H1_ATOMICITY_TEST__",
      collection_type: "tiered",
      status: "active",
      support_phone_number: "0000000000",
      amount: 0,
      max_contributions: maxContributions,
      price_tiers: [{ id: "t1", name: "Only Tier", price: 1000, quantity, prefix: null }],
    })
    .select("id")
    .single();
  if (error) throw error;
  createdCollectionIds.push(data.id);
  return data.id;
}

function makeRow({ reference, lineIndex = 0, tierId = "t1", tierName = "Only Tier" }) {
  return {
    name: "Atomicity Test",
    email: "atomicity-test@example.local",
    phone: null,
    amount: 1000,
    gross_amount: 1000,
    contributor_unique_code: null,
    contributor_information: [{ Tier: tierName, TierId: tierId, Quantity: 1 }],
    line_index: lineIndex,
    check_in_status: "not_checked_in",
    tier_id: tierId,
    tier_name: tierName,
    tier_quantity: 1,
  };
}

async function claim(db, collectionId, reference, rows) {
  const { data, error } = await db.rpc("claim_payment_contributions", {
    p_collection_id: collectionId,
    p_payment_reference: reference,
    p_rows: rows,
  });
  if (error) throw error;
  return data;
}

async function cleanup(db) {
  if (!createdCollectionIds.length) return;
  await db.from("contributions").delete().in("collection_id", createdCollectionIds);
  await db.from("collections").delete().in("id", createdCollectionIds);
}

after(async () => {
  if (client) await cleanup(client);
});

// ── Test 1 — Sequential duplicate verification ───────────────────────────────
test("1: sequential duplicate verification — one contribution, second call idempotent", { skip }, async () => {
  const collectionId = await makeScratchCollection(client);
  const ref = `TEST1-${Date.now()}`;
  const rows = [makeRow({ reference: ref })];

  const first = await claim(client, collectionId, ref, rows);
  const second = await claim(client, collectionId, ref, rows);

  assert.equal(first.outcome, "inserted");
  assert.equal(second.outcome, "idempotent");
  assert.equal(first.contributions.length, 1);
  assert.deepEqual(
    second.contributions.map((c) => c.id).sort(),
    first.contributions.map((c) => c.id).sort()
  );

  const { count } = await client
    .from("contributions")
    .select("id", { count: "exact", head: true })
    .eq("collection_id", collectionId)
    .eq("payment_reference", ref);
  assert.equal(count, 1, "exactly one contribution must exist for this reference");
});

// ── Test 2 — Concurrent duplicate verification ────────────────────────────────
test("2: concurrent duplicate verification — exactly one contribution, no duplicate", { skip }, async () => {
  const collectionId = await makeScratchCollection(client, { quantity: 100 }); // ample capacity, isolates dup-handling from capacity
  const ref = `TEST2-${Date.now()}`;
  const rows = [makeRow({ reference: ref })];

  const [a, b] = await Promise.all([
    claim(client, collectionId, ref, rows),
    claim(client, collectionId, ref, rows),
  ]);

  const outcomes = [a.outcome, b.outcome].sort();
  // One of the two acquired the lock first and inserted; the other, once it
  // acquires the lock, must find the already-committed row and be idempotent.
  assert.deepEqual(outcomes, ["idempotent", "inserted"]);

  const { count } = await client
    .from("contributions")
    .select("id", { count: "exact", head: true })
    .eq("collection_id", collectionId)
    .eq("payment_reference", ref);
  assert.equal(count, 1, "concurrent duplicate calls must never create more than one contribution");
});

// ── Test 3 — Same payment, last tier slot, concurrent ─────────────────────────
test("3: same reference racing itself for the LAST slot — second call idempotent, never tier_sold_out", { skip }, async () => {
  const collectionId = await makeScratchCollection(client, { quantity: 1 }); // exactly 1 slot
  const ref = `TEST3-${Date.now()}`;
  const rows = [makeRow({ reference: ref })];

  const [a, b] = await Promise.all([
    claim(client, collectionId, ref, rows),
    claim(client, collectionId, ref, rows),
  ]);

  const outcomes = [a.outcome, b.outcome].sort();
  assert.deepEqual(outcomes, ["idempotent", "inserted"]);
  assert.ok(
    !outcomes.includes("capacity_exceeded"),
    "a duplicate verification of the SAME reference must never be told the tier is sold out — this is the exact incident"
  );

  const { data: tierRows } = await client
    .from("contributions")
    .select("id")
    .eq("collection_id", collectionId)
    .eq("status", "paid");
  assert.equal(tierRows.length, 1, "sold_quantity must increase exactly once for a 1-capacity tier");
});

// ── Test 4 — Different payments competing for the last slot ──────────────────
test("4: two DIFFERENT references competing for the last slot — exactly one succeeds, one is capacity_exceeded", { skip }, async () => {
  const collectionId = await makeScratchCollection(client, { quantity: 1 });
  const refA = `TEST4A-${Date.now()}`;
  const refB = `TEST4B-${Date.now()}`;

  const [a, b] = await Promise.all([
    claim(client, collectionId, refA, [makeRow({ reference: refA })]),
    claim(client, collectionId, refB, [makeRow({ reference: refB })]),
  ]);

  const outcomes = [a.outcome, b.outcome].sort();
  assert.deepEqual(outcomes, ["capacity_exceeded", "inserted"]);

  const { count } = await client
    .from("contributions")
    .select("id", { count: "exact", head: true })
    .eq("collection_id", collectionId)
    .eq("status", "paid");
  assert.equal(count, 1, "sold_quantity must never exceed the tier's quantity (1)");
});

// ── Test 5 — Pre-seeded existing successful contribution ─────────────────────
test("5: re-verifying a reference that ALREADY has a contribution — idempotent, no capacity mutation", { skip }, async () => {
  const collectionId = await makeScratchCollection(client, { quantity: 1 });
  const ref = `TEST5-${Date.now()}`;

  // Pre-seed directly (simulating an already-successful prior verification).
  const { error: seedErr } = await client.from("contributions").insert({
    collection_id: collectionId,
    name: "Pre-seeded",
    email: "preseed@example.local",
    phone: null,
    amount: 1000,
    gross_amount: 1000,
    status: "paid",
    payment_reference: ref,
    contributor_information: [{ Tier: "Only Tier", TierId: "t1", Quantity: 1 }],
    line_index: 0,
  });
  assert.equal(seedErr, null);

  const result = await claim(client, collectionId, ref, [makeRow({ reference: ref })]);

  assert.equal(result.outcome, "idempotent");
  assert.equal(result.contributions.length, 1);

  const { count } = await client
    .from("contributions")
    .select("id", { count: "exact", head: true })
    .eq("collection_id", collectionId);
  assert.equal(count, 1, "no duplicate contribution and no capacity mutation from re-verifying a pre-seeded success");
});

// ── Test 7 — Incident regression (read-only, no mutation) ────────────────────
test("7: incident reference kolekto-1784556863591-704214 classifies as successful (read-only)", { skip }, async () => {
  const REF = "kolekto-1784556863591-704214";
  const { data: contribution, error } = await client
    .from("contributions")
    .select("status, amount, gross_amount, payment_reference")
    .eq("payment_reference", REF)
    .maybeSingle();

  if (!contribution) {
    // Different project than the one the incident was recorded against —
    // not a failure of this suite, just nothing to assert against here.
    return;
  }
  assert.equal(error, null);
  assert.equal(contribution.status, "paid");
  assert.equal(Number(contribution.amount), 50000);
  assert.equal(Number(contribution.gross_amount), 51000);

  // Re-verifying this exact reference through the atomic RPC must be idempotent
  // and must NEVER produce tier_sold_out or a second contribution.
  const { data: ctx } = await client
    .from("pending_payment_context")
    .select("collection_id")
    .eq("reference", REF)
    .maybeSingle();
  if (!ctx?.collection_id) return;

  const result = await claim(client, ctx.collection_id, REF, [
    makeRow({ reference: REF, tierId: "regression-check", tierName: "regression-check" }),
  ]);
  assert.equal(result.outcome, "idempotent");

  const { count } = await client
    .from("contributions")
    .select("id", { count: "exact", head: true })
    .eq("payment_reference", REF);
  assert.equal(count, 1, "the incident reference must still have exactly one contribution after this test");
});
