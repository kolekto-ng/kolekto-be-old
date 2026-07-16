// tests/financialReconcile.test.js
// PHASE 2.0 GUARDRAILS — unit tests for the reconciliation/consistency core.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  expectedBalances,
  diffWallet,
  checkInvariants,
  reconcileCollection,
} from "../utils/financialReconcile.js";
import { getSettlementCutoff } from "../utils/financial.js";

const beforeCutoff = () => new Date(getSettlementCutoff().getTime() - 3600_000).toISOString();

test("expectedBalances matches canonical math (organizer net = gross - fees)", () => {
  // normalizeContributions deducts fees for organizer-borne: 5000 gross → 4900 net.
  // This locks in that net_payment is the organizer's take-home, not the gross.
  const e = expectedBalances(
    [{ amount: 5000, gross_amount: 5000, created_at: beforeCutoff() }],
    [],
    { feeBearer: "organizer", collectionType: "fixed" }
  );
  assert.equal(e.netPayment, 4900);
  assert.equal(e.grossPayment, 5000);
  assert.equal(e.availableBalance, 4900);
});

test("diffWallet flags drift beyond tolerance, ignores rounding", () => {
  const expected = { netPayment: 5000, grossPayment: 5000, pendingBalance: 0, availableBalance: 5000, ledgerBalance: 5000, completedWithdrawals: 0 };
  const clean = { net_payment: 5000, gross_payment: 5000, pending_balance: 0, available_balance: 5000.004, ledger_balance: 5000, withdrawn: 0 };
  assert.equal(diffWallet(expected, clean).length, 0, "sub-cent difference ignored");

  const drifted = { ...clean, available_balance: 4000 };
  const d = diffWallet(expected, drifted);
  assert.equal(d.length, 1);
  assert.equal(d[0].field, "available_balance");
  assert.equal(d[0].delta, -1000);
});

test("diffWallet reports a missing wallet", () => {
  const expected = { netPayment: 100, grossPayment: 100, pendingBalance: 0, availableBalance: 100, ledgerBalance: 100, completedWithdrawals: 0 };
  const d = diffWallet(expected, null);
  assert.equal(d[0].field, "*wallet*");
});

test("checkInvariants flags multiple wallets", () => {
  const expected = expectedBalances([], []);
  const issues = checkInvariants({ collectionId: "c1", wallets: [{}, {}], expected });
  assert.ok(issues.find((i) => i.code === "MULTIPLE_WALLETS"));
});

test("checkInvariants flags a paid contribution missing its reference", () => {
  const expected = expectedBalances([{ amount: 100, gross_amount: 100, created_at: beforeCutoff() }], []);
  const issues = checkInvariants({
    collectionId: "c1",
    wallets: [{}],
    expected,
    paidContributions: [{ status: "paid", payment_reference: "" }],
  });
  assert.ok(issues.find((i) => i.code === "PAID_WITHOUT_REFERENCE"));
});

test("checkInvariants: healthy collection has no issues", () => {
  const expected = expectedBalances([{ amount: 100, gross_amount: 100, created_at: beforeCutoff() }], []);
  const issues = checkInvariants({
    collectionId: "c1",
    wallets: [{}],
    expected,
    paidContributions: [{ status: "paid", payment_reference: "ref-1" }],
  });
  assert.equal(issues.length, 0);
});

test("reconcileCollection: stored matches expected → ok:true", () => {
  const r = reconcileCollection({
    collectionId: "c1",
    collection: { fee_bearer: "organizer", collection_type: "fixed" },
    // organizer-borne: 5000 gross normalizes to 4900 net (fees deducted).
    wallets: [{
      net_payment: 4900, gross_payment: 5000, pending_balance: 0,
      available_balance: 4900, ledger_balance: 4900, withdrawn: 0,
      updated_at: new Date().toISOString(),
    }],
    paidContributions: [{ amount: 5000, gross_amount: 5000, status: "paid", payment_reference: "r1", created_at: beforeCutoff() }],
    withdrawals: [],
  });
  assert.equal(r.ok, true);
  assert.equal(r.drift.length, 0);
  assert.equal(r.invariants.length, 0);
});

test("reconcileCollection: stale stored balance is detected as drift", () => {
  const r = reconcileCollection({
    collectionId: "c1",
    collection: { fee_bearer: "organizer", collection_type: "fixed" },
    wallets: [{ net_payment: 1, available_balance: 1, ledger_balance: 1, pending_balance: 0, gross_payment: 1, withdrawn: 0, updated_at: new Date().toISOString() }],
    paidContributions: [{ amount: 5000, gross_amount: 5000, status: "paid", payment_reference: "r1", created_at: beforeCutoff() }],
    withdrawals: [],
  });
  assert.equal(r.ok, false);
  assert.ok(r.drift.length >= 1);
});
