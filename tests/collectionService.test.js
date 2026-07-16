// tests/collectionService.test.js
//
// Characterization tests for the consolidated CollectionService. They lock in
// the LIVE create-collection behavior (previously served by the Edge function
// `create-collection`) as reproduced by the Express service, so a future flip
// of the frontend onto this path is a behavioral no-op.
//
// Run: npm test   (uses Node's built-in test runner; no extra deps)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeCollectionService,
  resolveLegacyType,
} from "../services/collectionService.js";

const silentLogger = { warn() {}, error() {}, log() {} };

function makeFakeRepo(overrides = {}) {
  const calls = {
    getKycStatus: 0,
    countNonDeletedCollections: 0,
    insertCollection: [],
    createWalletIfAbsent: [],
    insertCampaign: [],
    insertVerificationDocuments: [],
    insertCampaignImages: [],
  };
  const repo = {
    async getKycStatus() {
      calls.getKycStatus++;
      return overrides.kycStatus ?? "verified";
    },
    async countNonDeletedCollections() {
      calls.countNonDeletedCollections++;
      return overrides.collectionCount ?? 0;
    },
    async insertCollection(row) {
      calls.insertCollection.push(row);
      if (overrides.insertThrows) throw new Error("db insert failed");
      return { id: "col-1", ...row };
    },
    async createWalletIfAbsent(wallet) {
      calls.createWalletIfAbsent.push(wallet);
      return { error: overrides.walletError ?? null };
    },
    async insertCampaign(row) {
      calls.insertCampaign.push(row);
      return { data: { id: row.id }, error: overrides.campaignError ?? null };
    },
    async insertVerificationDocuments(rows) {
      calls.insertVerificationDocuments.push(rows);
      return { error: null };
    },
    async insertCampaignImages(rows) {
      calls.insertCampaignImages.push(rows);
      return { error: null };
    },
  };
  return { repo, calls };
}

function makeService(overrides) {
  const { repo, calls } = makeFakeRepo(overrides);
  const service = makeCollectionService({
    repo,
    generateSlug: () => "my-title-abcde",
    logger: silentLogger,
  });
  return { service, calls };
}

const baseInput = { title: "My Title", amount: 5000, collection_type: "fixed" };

// ── Auth + validation ───────────────────────────────────────────────────────

test("rejects missing userId with 401", async () => {
  const { service } = makeService();
  await assert.rejects(
    () => service.create({ userId: null, input: baseInput }),
    (e) => e.statusCode === 401
  );
});

test("rejects blank title with 400", async () => {
  const { service } = makeService();
  await assert.rejects(
    () => service.create({ userId: "u1", input: { title: "   " } }),
    (e) => e.statusCode === 400 && /title/i.test(e.message)
  );
});

// ── KYC gate ────────────────────────────────────────────────────────────────

test("KYC gate: unverified user with an existing collection is blocked (403)", async () => {
  const { service } = makeService({ kycStatus: "pending", collectionCount: 1 });
  await assert.rejects(
    () => service.create({ userId: "u1", input: baseInput }),
    (e) => e.statusCode === 403 && /KYC/i.test(e.message)
  );
});

test("KYC gate: unverified user with zero collections is allowed", async () => {
  const { service, calls } = makeService({ kycStatus: "pending", collectionCount: 0 });
  const col = await service.create({ userId: "u1", input: baseInput });
  assert.equal(col.id, "col-1");
  assert.equal(calls.insertCollection.length, 1);
});

test("KYC gate: verified user is allowed regardless of count", async () => {
  const { service, calls } = makeService({ kycStatus: "verified", collectionCount: 99 });
  await service.create({ userId: "u1", input: baseInput });
  assert.equal(calls.insertCollection.length, 1);
  // A verified user should not incur the count query.
  assert.equal(calls.countNonDeletedCollections, 0);
});

// ── legacyType mapping (DB trigger contract) ────────────────────────────────

test("resolveLegacyType maps every product type to its trigger value", () => {
  assert.equal(resolveLegacyType("fixed"), "flat");
  assert.equal(resolveLegacyType("tiered"), "tiered");
  assert.equal(resolveLegacyType("ticket", "tiered"), "tiered");
  assert.equal(resolveLegacyType("ticket", "flat"), "flat");
  assert.equal(resolveLegacyType("open_pool"), "open_pool");
  assert.equal(resolveLegacyType("fundraising"), "fundraising");
});

test("insert row carries the legacy type for a fixed collection", async () => {
  const { service, calls } = makeService();
  await service.create({ userId: "u1", input: baseInput });
  assert.equal(calls.insertCollection[0].type, "flat");
  assert.equal(calls.insertCollection[0].collection_type, "fixed");
});

// ── Status + currency + wallet parity ───────────────────────────────────────

test("non-fundraising collection is created active with NGN currency", async () => {
  const { service, calls } = makeService();
  await service.create({ userId: "u1", input: baseInput });
  const row = calls.insertCollection[0];
  assert.equal(row.status, "active");
  assert.equal(row.currency, "NGN");
  assert.equal(row.currency_symbol, "₦");
  assert.equal(row.slug, "my-title-abcde");
});

test("wallet is created with zero balances and NO fee_breakdown (live parity)", async () => {
  const { service, calls } = makeService();
  await service.create({ userId: "u1", input: baseInput });
  const wallet = calls.createWalletIfAbsent[0];
  assert.equal(wallet.available_balance, 0);
  assert.equal(wallet.ledger_balance, 0);
  assert.equal(wallet.withdrawn, 0);
  // Deliberate parity: the live path never wrote fee_breakdown.
  assert.equal("fee_breakdown" in wallet, false);
});

test("a wallet error does not fail collection creation", async () => {
  const { service } = makeService({ walletError: { message: "wallet boom" } });
  const col = await service.create({ userId: "u1", input: baseInput });
  assert.equal(col.id, "col-1");
});

test("a DB insert failure surfaces as a 400", async () => {
  const { service } = makeService({ insertThrows: true });
  await assert.rejects(
    () => service.create({ userId: "u1", input: baseInput }),
    (e) => e.statusCode === 400
  );
});

// ── Fundraising side-effects ────────────────────────────────────────────────

test("fundraising collection is pending_review and creates campaign + docs + images", async () => {
  const { service, calls } = makeService();
  const input = {
    title: "Save the Hall",
    collection_type: "fundraising",
    amount: 1000,
    target_amount: 500000,
    banner_url: "https://img/banner.png",
    story_images: ["https://img/1.png", "https://img/2.png"],
    verification_documents: [{ url: "https://doc/1.pdf", name: "Proof" }],
    social_links: [{ platform: "Instagram", url: "https://ig/x" }],
  };
  const col = await service.create({ userId: "u1", input });

  assert.equal(calls.insertCollection[0].status, "pending_review");
  assert.equal(calls.insertCollection[0].type, "fundraising");

  assert.equal(calls.insertCampaign.length, 1);
  assert.equal(calls.insertCampaign[0].id, col.id);
  assert.equal(calls.insertCampaign[0].creator_id, "u1");
  assert.equal(calls.insertCampaign[0].social_instagram, "https://ig/x");
  assert.equal(calls.insertCampaign[0].status, "pending_verification");

  assert.equal(calls.insertVerificationDocuments.length, 1);
  assert.equal(calls.insertVerificationDocuments[0][0].campaign_id, col.id);
  assert.equal(calls.insertVerificationDocuments[0][0].document_name, "Proof");

  assert.equal(calls.insertCampaignImages.length, 1);
  assert.equal(calls.insertCampaignImages[0].length, 2);
  assert.equal(calls.insertCampaignImages[0][1].display_order, 1);
});

test("non-fundraising collection does not touch campaign tables", async () => {
  const { service, calls } = makeService();
  await service.create({ userId: "u1", input: baseInput });
  assert.equal(calls.insertCampaign.length, 0);
  assert.equal(calls.insertVerificationDocuments.length, 0);
  assert.equal(calls.insertCampaignImages.length, 0);
});
