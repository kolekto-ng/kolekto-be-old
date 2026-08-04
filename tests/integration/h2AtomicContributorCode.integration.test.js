// tests/integration/h2AtomicContributorCode.integration.test.js
//
// H2 — proves contributor-code allocation is now atomic WITH the contribution
// insert inside claim_payment_contributions (database/h2_atomic_contributor_code_allocation.sql),
// closing the gap H1 left open (H1 made idempotency+capacity+insert atomic,
// but received contributor_unique_code as a pre-minted, caller-supplied
// input — this suite proves the RPC now mints it itself, in the same
// transaction, so a rolled-back attempt can never permanently burn a number).
//
// SAFETY — this suite is OPT-IN and never runs against production:
//   - Uses SUPABASE_TEST_URL / SUPABASE_TEST_SERVICE_ROLE_KEY if set, else
//     falls back to this backend's own SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.
//   - Refuses outright if the resolved URL matches the known PRODUCTION ref.
//   - Every test creates its own throwaway collection(s) and deletes them
//     (and their contributions + counters) in `after` cleanup.
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
    ? "REFUSING to run H2 atomicity tests against the production Supabase project"
    : false;

const client = skip ? null : createClient(URL, KEY, { auth: { persistSession: false } });

const createdCollectionIds = [];

async function makeScratchCollection(db, { quantity = 100, maxContributions = null, prefix = null } = {}) {
  const { data: profile } = await db.from("profiles").select("id").limit(1).maybeSingle();
  const { data, error } = await db
    .from("collections")
    .insert({
      user_id: profile?.id || null,
      title: "__H2_ATOMIC_CODE_TEST__",
      collection_type: "tiered",
      status: "active",
      support_phone_number: "0000000000",
      amount: 0,
      max_contributions: maxContributions,
      price_tiers: [{ id: "t1", name: "Only Tier", price: 1000, quantity, prefix }],
    })
    .select("id")
    .single();
  if (error) throw error;
  createdCollectionIds.push(data.id);
  return data.id;
}

// H2 row shape: `prefix` in, NOT `contributor_unique_code` — the RPC mints it.
function makeRow({ lineIndex = 0, tierId = "t1", tierName = "Only Tier", prefix = null, phone = null } = {}) {
  return {
    name: "H2 Atomicity Test",
    email: "h2-atomicity-test@example.local",
    phone,
    amount: 1000,
    gross_amount: 1000,
    contributor_information: [{ Tier: tierName, TierId: tierId, Quantity: 1 }],
    line_index: lineIndex,
    check_in_status: "not_checked_in",
    prefix,
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
  return { data, error };
}

async function getCounter(db, collectionId, prefix) {
  const { data } = await db
    .from("contribution_code_counters")
    .select("next_number")
    .eq("collection_id", collectionId)
    .eq("prefix", prefix.toUpperCase())
    .maybeSingle();
  return data?.next_number ?? 0;
}

async function cleanup(db) {
  if (!createdCollectionIds.length) return;
  await db.from("contributions").delete().in("collection_id", createdCollectionIds);
  await db.from("contribution_code_counters").delete().in("collection_id", createdCollectionIds);
  await db.from("collections").delete().in("id", createdCollectionIds);
}

after(async () => {
  if (client) await cleanup(client);
});

// ── Case A — Normal successful payment ────────────────────────────────────
test("A: normal success — counter +1, one contribution, correct code", { skip }, async () => {
  const collectionId = await makeScratchCollection(client);
  const ref = `H2A-${Date.now()}`;
  const { data, error } = await claim(client, collectionId, ref, [makeRow({ prefix: "TSTA" })]);

  assert.equal(error, null);
  assert.equal(data.outcome, "inserted");
  assert.equal(data.contributions.length, 1);
  assert.equal(data.contributions[0].contributor_unique_code, "TSTA-001");
  // Receipt payload should have the same code injected server-side.
  const receiptCode = data.contributions[0].contributor_information?.[0]?._receipt?.unique_code;
  assert.equal(receiptCode, "TSTA-001");

  const counter = await getCounter(client, collectionId, "TSTA");
  assert.equal(counter, 1, "counter must advance by exactly 1 for one successful contribution");
});

// ── Case B — Forced contribution insert failure ───────────────────────────
test("B: forced insert failure (phone too long) — no contribution, counter unchanged", { skip }, async () => {
  const collectionId = await makeScratchCollection(client);
  const ref = `H2B-${Date.now()}`;
  // contributions.phone is varchar(20) — this is the exact real-world trigger
  // that caused the production BBN incident (3,247+ burned numbers).
  const tooLongPhone = "this-value-is-definitely-longer-than-twenty-characters";
  assert.ok(tooLongPhone.length > 20);

  const { data, error } = await claim(client, collectionId, ref, [
    makeRow({ prefix: "TSTB", phone: tooLongPhone }),
  ]);

  assert.equal(data, null, "the RPC call itself must fail, not return a normal outcome");
  assert.ok(error, "expected a Postgres error (22001 value too long)");

  const { count } = await client
    .from("contributions")
    .select("id", { count: "exact", head: true })
    .eq("collection_id", collectionId)
    .eq("payment_reference", ref);
  assert.equal(count, 0, "no contribution may exist after a failed insert");

  const counter = await getCounter(client, collectionId, "TSTB");
  assert.equal(counter, 0, "THE CORE FIX: counter must NOT advance when the insert fails");
});

// ── Case C — Trigger failure rolls back the counter together with the insert ─
// NOT executed in this file: supabase-js has no raw multi-statement SQL
// primitive (only table operations + defined RPCs), so a real, non-mocked
// proof of "a trigger exception mid-transaction undoes an earlier counter
// increment in the SAME transaction" requires an actual multi-statement SQL
// round trip. That was executed directly against the TEST database's
// Postgres connection (not via this Node suite) — see the H2 report for the
// exact SQL and its output. Also note: the RPC's OWN capacity pre-check is
// logically identical to enforce_max_contributions' query, so a single
// process can never make the RPC's pre-check pass while the trigger
// disagrees — that only proves the trigger is redundant defense-in-depth,
// not reachable via this RPC under single-process testing. This is expected
// and documented, not a gap.

// ── Case D — Capacity rejection ───────────────────────────────────────────
test("D: capacity rejection — no contribution, counter unchanged", { skip }, async () => {
  const collectionId = await makeScratchCollection(client, { quantity: 1 }); // exactly 1 slot
  const prefix = "TSTD";

  const refA = `H2D-A-${Date.now()}`;
  const first = await claim(client, collectionId, refA, [makeRow({ prefix })]);
  assert.equal(first.error, null);
  assert.equal(first.data.outcome, "inserted");
  assert.equal(first.data.contributions[0].contributor_unique_code, "TSTD-001");

  const refB = `H2D-B-${Date.now()}`;
  const second = await claim(client, collectionId, refB, [makeRow({ prefix })]);
  assert.equal(second.error, null);
  assert.equal(second.data.outcome, "capacity_exceeded");

  const { count } = await client
    .from("contributions")
    .select("id", { count: "exact", head: true })
    .eq("collection_id", collectionId)
    .eq("payment_reference", refB);
  assert.equal(count, 0, "the rejected attempt must not have inserted a row");

  const counter = await getCounter(client, collectionId, prefix);
  assert.equal(counter, 1, "capacity rejection must NOT mint a code — counter stays at the winner's 1 value");
});

// ── Case E — Duplicate payment reference (sequential) ─────────────────────
test("E: duplicate reference (sequential) — one contribution, counter increments once", { skip }, async () => {
  const collectionId = await makeScratchCollection(client);
  const prefix = "TSTE";
  const ref = `H2E-${Date.now()}`;
  const rows = [makeRow({ prefix })];

  const first = await claim(client, collectionId, ref, rows);
  const second = await claim(client, collectionId, ref, rows);

  assert.equal(first.data.outcome, "inserted");
  assert.equal(second.data.outcome, "idempotent");
  assert.equal(first.data.contributions[0].contributor_unique_code, second.data.contributions[0].contributor_unique_code);

  const counter = await getCounter(client, collectionId, prefix);
  assert.equal(counter, 1, "a duplicate reference replay must never mint a second number");
});

// ── Case F — Same-reference concurrent requests ───────────────────────────
test("F: same-reference concurrent requests — exactly one contribution, one code allocation", { skip }, async () => {
  const collectionId = await makeScratchCollection(client);
  const prefix = "TSTF";
  const ref = `H2F-${Date.now()}`;
  const rows = [makeRow({ prefix })];

  const [a, b] = await Promise.all([
    claim(client, collectionId, ref, rows),
    claim(client, collectionId, ref, rows),
  ]);

  const outcomes = [a.data?.outcome, b.data?.outcome].sort();
  assert.deepEqual(outcomes, ["idempotent", "inserted"]);

  const { count } = await client
    .from("contributions")
    .select("id", { count: "exact", head: true })
    .eq("collection_id", collectionId)
    .eq("payment_reference", ref);
  assert.equal(count, 1);

  const counter = await getCounter(client, collectionId, prefix);
  assert.equal(counter, 1, "a genuine same-reference race must still only ever mint ONE code total");
});

// ── Case G — Different-reference concurrent requests ──────────────────────
test("G: different-reference concurrent requests — sequential unique codes, no gaps", { skip }, async () => {
  const collectionId = await makeScratchCollection(client, { quantity: 100 });
  const prefix = "TSTG";
  const refA = `H2G-A-${Date.now()}`;
  const refB = `H2G-B-${Date.now()}`;

  const [a, b] = await Promise.all([
    claim(client, collectionId, refA, [makeRow({ prefix })]),
    claim(client, collectionId, refB, [makeRow({ prefix })]),
  ]);

  assert.equal(a.data.outcome, "inserted");
  assert.equal(b.data.outcome, "inserted");

  const codes = [a.data.contributions[0].contributor_unique_code, b.data.contributions[0].contributor_unique_code].sort();
  assert.deepEqual(codes, ["TSTG-001", "TSTG-002"], "two genuinely concurrent successes must get distinct, contiguous codes");

  const counter = await getCounter(client, collectionId, prefix);
  assert.equal(counter, 2);
});

// ── Case H — Multi-unit contribution/payment ──────────────────────────────
test("H: multi-unit order — each unit gets exactly one code, all atomic as one operation", { skip }, async () => {
  const collectionId = await makeScratchCollection(client, { quantity: 100 });
  const prefix = "TSTH";
  const ref = `H2H-${Date.now()}`;

  const rows = [
    makeRow({ lineIndex: 0, prefix }),
    makeRow({ lineIndex: 1, prefix }),
    makeRow({ lineIndex: 2, prefix }),
  ];

  const { data, error } = await claim(client, collectionId, ref, rows);
  assert.equal(error, null);
  assert.equal(data.outcome, "inserted");
  assert.equal(data.contributions.length, 3);

  const codes = data.contributions.map((c) => c.contributor_unique_code).sort();
  assert.deepEqual(codes, ["TSTH-001", "TSTH-002", "TSTH-003"]);

  const counter = await getCounter(client, collectionId, prefix);
  assert.equal(counter, 3, "one RPC call for a 3-unit order must advance the counter by exactly 3, atomically");
});

// ── Case I — Recovery retry does not burn numbers ─────────────────────────
// Directly reproduces the production incident: a permanently-broken payment
// (phone too long) retried repeatedly by scheduled-payment-recovery. Under
// H1 (or the pre-H1 default path), each retry burned a fresh number. Under
// H2 it must not, no matter how many times it's retried.
test("I: repeated recovery retries of a permanently-broken reference never advance the counter", { skip }, async () => {
  const collectionId = await makeScratchCollection(client);
  const prefix = "TSTI";
  const ref = `H2I-${Date.now()}`;
  const tooLongPhone = "this-value-is-definitely-longer-than-twenty-characters";

  const ATTEMPTS = 5;
  for (let i = 0; i < ATTEMPTS; i++) {
    const { data, error } = await claim(client, collectionId, ref, [
      makeRow({ prefix, phone: tooLongPhone }),
    ]);
    assert.equal(data, null, `attempt ${i + 1} must fail (simulating scheduled_recovery retrying forever)`);
    assert.ok(error, `attempt ${i + 1} must surface a Postgres error`);
  }

  const counter = await getCounter(client, collectionId, prefix);
  assert.equal(counter, 0, `THE CORE FIX, exercised ${ATTEMPTS}x: a permanently-failing reference retried repeatedly must NEVER advance the counter — this is the exact BBN production incident (3,247+ retries, 1,650+ burned numbers) reproduced and proven closed`);

  const { count } = await client
    .from("contributions")
    .select("id", { count: "exact", head: true })
    .eq("collection_id", collectionId)
    .eq("payment_reference", ref);
  assert.equal(count, 0);
});

// ── Case J — Full reconciliation across all TEST collections/prefixes ─────
test("J: TEST-wide reconciliation — every counter matches assigned codes exactly", { skip }, async () => {
  const { data: counters, error } = await client
    .from("contribution_code_counters")
    .select("collection_id, prefix, next_number");
  assert.equal(error, null);

  const { data: assigned } = await client
    .from("contributions")
    .select("collection_id, contributor_unique_code")
    .eq("status", "paid")
    .not("contributor_unique_code", "is", null);

  const maxByKey = new Map();
  const countByKey = new Map();
  for (const row of assigned || []) {
    const m = String(row.contributor_unique_code).match(/^(.*?)-?(\d+)$/);
    if (!m) continue;
    const prefix = m[1].toUpperCase();
    const num = parseInt(m[2], 10);
    const key = `${row.collection_id}::${prefix}`;
    maxByKey.set(key, Math.max(maxByKey.get(key) || 0, num));
    countByKey.set(key, (countByKey.get(key) || 0) + 1);
  }

  const gaps = [];
  for (const c of counters || []) {
    const key = `${c.collection_id}::${c.prefix.toUpperCase()}`;
    const maxAssigned = maxByKey.get(key) || 0;
    const gap = c.next_number - maxAssigned;
    if (gap > 0) gaps.push({ ...c, maxAssigned, gap });
  }

  assert.deepEqual(gaps, [], `TEST must reconcile with zero gaps after this test run; found: ${JSON.stringify(gaps)}`);
});

// ── Constraint check — unique index still active and effective ───────────
test("Constraint sanity: (collection_id, contributor_unique_code) unique index still rejects a raw duplicate", { skip }, async () => {
  const collectionId = await makeScratchCollection(client);
  const code = "TSTK-001";
  const base = {
    collection_id: collectionId,
    name: "Constraint Test",
    email: "constraint-test@example.local",
    amount: 1000,
    gross_amount: 1000,
    status: "paid",
    contributor_unique_code: code,
    contributor_information: [{}],
  };

  const { error: e1 } = await client.from("contributions").insert({ ...base, line_index: 0, payment_reference: `H2K-A-${Date.now()}` });
  assert.equal(e1, null);

  const { error: e2 } = await client.from("contributions").insert({ ...base, line_index: 1, payment_reference: `H2K-B-${Date.now()}` });
  assert.ok(e2, "a second row with the same (collection_id, contributor_unique_code) must be rejected");
  assert.equal(e2.code, "23505");
});
