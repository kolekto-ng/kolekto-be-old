// tests/integration/collectionService.integration.test.js
//
// P0 integration tests for the Collection domain. These exercise the REAL
// CollectionService against a REAL Supabase project to validate the two
// highest-risk assumptions the unit tests cannot cover:
//   1. the DB trigger validate_collection_amount() accepts the `type` value the
//      service sends for every collection type;
//   2. the fundraising multi-table side-effects (campaigns + verification
//      documents + campaign images) succeed against the real schema/FKs.
//
// SAFETY — this suite is OPT-IN and never runs against production:
//   - It uses dedicated env vars, NOT the app's default Supabase client:
//       SUPABASE_TEST_URL, SUPABASE_TEST_SERVICE_ROLE_KEY, SUPABASE_TEST_USER_ID
//   - SUPABASE_TEST_USER_ID must be a KYC-verified user in the TEST project.
//   - If any are missing, every test is SKIPPED (so `npm run test:integration`
//     is safe on a laptop with no creds).
//   - If the URL looks like the known production project, the suite refuses.
//
// Run: npm run test:integration   (after exporting the SUPABASE_TEST_* vars)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { makeCollectionService } from "../../services/collectionService.js";

const URL = process.env.SUPABASE_TEST_URL;
const KEY = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const USER = process.env.SUPABASE_TEST_USER_ID;

// Known production project ref — a hard guard so this can never mutate prod.
const PROD_REFS = ["busfgcmbndleljklrcbd"];
const looksLikeProd = URL && PROD_REFS.some((ref) => URL.includes(ref));

const skip =
  !URL || !KEY || !USER
    ? "SUPABASE_TEST_URL / SUPABASE_TEST_SERVICE_ROLE_KEY / SUPABASE_TEST_USER_ID not set — skipping integration tests"
    : looksLikeProd
    ? "REFUSING to run integration tests against the production Supabase project"
    : false;

// Only construct a client when we actually intend to run.
const client = skip ? null : createClient(URL, KEY, { auth: { persistSession: false } });

// A repository bound to the TEST client (mirrors repositories/collectionRepository.js).
function makeTestRepo(db) {
  return {
    async getKycStatus(userId) {
      const { data, error } = await db
        .from("kyc_verifications")
        .select("status")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw error;
      return data?.status ?? null;
    },
    async countNonDeletedCollections(userId) {
      const { count, error } = await db
        .from("collections")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .neq("status", "deleted");
      if (error) throw error;
      return count ?? 0;
    },
    async insertCollection(row) {
      const { data, error } = await db.from("collections").insert(row).select().single();
      if (error) throw error;
      return data;
    },
    async createWalletIfAbsent(wallet) {
      const { error } = await db
        .from("wallets")
        .upsert(wallet, { onConflict: "collection_id", ignoreDuplicates: true });
      return { error };
    },
    async insertCampaign(row) {
      const { data, error } = await db.from("campaigns").insert(row).select().single();
      return { data, error };
    },
    async insertVerificationDocuments(rows) {
      const { error } = await db.from("verification_documents").insert(rows);
      return { error };
    },
    async insertCampaignImages(rows) {
      const { error } = await db.from("campaign_images").insert(rows);
      return { error };
    },
  };
}

const createdCollectionIds = [];

function serviceFor(db) {
  const repo = makeTestRepo(db);
  // Wrap insertCollection to record ids for cleanup.
  const baseInsert = repo.insertCollection.bind(repo);
  repo.insertCollection = async (row) => {
    const created = await baseInsert(row);
    if (created?.id) createdCollectionIds.push(created.id);
    return created;
  };
  return makeCollectionService({ repo, logger: { debug() {}, info() {}, warn() {}, error() {} } });
}

after(async () => {
  if (!client || createdCollectionIds.length === 0) return;
  // Best-effort cleanup so the test project stays tidy.
  for (const id of createdCollectionIds) {
    await client.from("campaign_images").delete().eq("campaign_id", id);
    await client.from("verification_documents").delete().eq("campaign_id", id);
    await client.from("campaigns").delete().eq("id", id);
    await client.from("wallets").delete().eq("collection_id", id);
    await client.from("collections").delete().eq("id", id);
  }
});

// One create per type — the point is that the DB trigger accepts each `type`
// value and a wallet row is produced.
for (const [collection_type, extra] of [
  ["fixed", { amount: 5000 }],
  ["tiered", { price_tiers: [{ name: "Regular", price: 2000 }] }],
  ["ticket", { ticket_mode: "tiered", price_tiers: [{ name: "VIP", price: 10000 }] }],
  ["open_pool", { amount: 0 }],
]) {
  test(`creates a ${collection_type} collection and its wallet (trigger accepts type)`, { skip }, async () => {
    const service = serviceFor(client);
    const col = await service.create({
      userId: USER,
      input: { title: `IT ${collection_type} ${Date.now()}`, collection_type, ...extra },
      requestId: `it-${collection_type}`,
    });
    assert.ok(col?.id, "collection row created");

    const { data: wallet, error } = await client
      .from("wallets")
      .select("collection_id, available_balance")
      .eq("collection_id", col.id)
      .single();
    assert.equal(error, null);
    assert.equal(wallet.collection_id, col.id);
  });
}

test("creates a fundraising collection with campaign + docs + images", { skip }, async () => {
  const service = serviceFor(client);
  const col = await service.create({
    userId: USER,
    input: {
      title: `IT fundraising ${Date.now()}`,
      collection_type: "fundraising",
      amount: 1000,
      target_amount: 500000,
      story_images: ["https://example.test/1.png"],
      verification_documents: [{ url: "https://example.test/doc.pdf", name: "Proof" }],
      social_links: [{ platform: "Instagram", url: "https://ig.test/x" }],
    },
    requestId: "it-fundraising",
  });

  const { data: campaign } = await client
    .from("campaigns")
    .select("id, status")
    .eq("id", col.id)
    .single();
  assert.ok(campaign, "campaign row created");
  assert.equal(campaign.status, "pending_verification");

  const { count: docCount } = await client
    .from("verification_documents")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", col.id);
  assert.equal(docCount, 1);

  const { count: imgCount } = await client
    .from("campaign_images")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", col.id);
  assert.equal(imgCount, 1);
});
