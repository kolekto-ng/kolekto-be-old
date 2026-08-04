// tests/financial.characterization.test.js
//
// PHASE 2.0 GUARDRAILS — locks in TODAY'S financial math exactly.
// These are regression tests: their job is to fail loudly if any future
// refactor (PaymentService/WalletService/Ledger) changes a fee, a balance, or
// a settlement classification by even a kobo. They test the canonical pure
// functions in utils/financial.js — the single source these numbers must keep.
//
// Fee structure locked in (utils/financial.js constants):
//   platform: 1% fundraising / 0.5% others, capped ₦2,000
//   gateway:  1.5% all types,               capped ₦2,000
//   settlement cutoff: 4:00 AM UTC (5:00 AM WAT)
//
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  roundCurrency,
  calculateFees,
  deriveNetContribution,
  getSettlementCutoff,
  isPaymentSettled,
  computeWalletBalances,
  normalizeContributions,
} from "../utils/financial.js";

// ── roundCurrency ────────────────────────────────────────────────────────────
test("roundCurrency: 2dp, coerces non-numeric to 0", () => {
  assert.equal(roundCurrency(1.234), 1.23);
  assert.equal(roundCurrency(1.235), 1.24);
  assert.equal(roundCurrency(100), 100);
  assert.equal(roundCurrency("abc"), 0);
  assert.equal(roundCurrency(null), 0);
  assert.equal(roundCurrency(undefined), 0);
});

// ── calculateFees ────────────────────────────────────────────────────────────
test("calculateFees: fixed ₦5,000 organizer — fees separate, payable = amount", () => {
  const f = calculateFees(5000, "fixed", "organizer");
  assert.deepEqual(f, { platformFee: 25, gatewayFee: 75, totalFees: 100, totalPayable: 5000 });
});

test("calculateFees: fixed ₦5,000 contributor — payable = amount + fees", () => {
  const f = calculateFees(5000, "fixed", "contributor");
  assert.deepEqual(f, { platformFee: 25, gatewayFee: 75, totalFees: 100, totalPayable: 5100 });
});

test("calculateFees: fundraising uses 1% platform rate", () => {
  const f = calculateFees(10000, "fundraising", "contributor");
  assert.deepEqual(f, { platformFee: 100, gatewayFee: 150, totalFees: 250, totalPayable: 10250 });
});

test("calculateFees: fees are capped at ₦2,000 each", () => {
  // fixed 0.5%: platform caps at amount 400,000; gateway 1.5% caps at 133,333.33
  const f = calculateFees(500000, "fixed", "organizer");
  assert.equal(f.platformFee, 2000);
  assert.equal(f.gatewayFee, 2000);
  assert.equal(f.totalFees, 4000);
  assert.equal(f.totalPayable, 500000); // organizer-borne
  assert.equal(calculateFees(500000, "fixed", "contributor").totalPayable, 504000);
});

test("calculateFees: unknown type falls back to 0.5% platform", () => {
  const f = calculateFees(1000, "mystery", "organizer");
  assert.equal(f.platformFee, 5);
  assert.equal(f.gatewayFee, 15);
});

test("calculateFees: zero amount → zero fees", () => {
  assert.deepEqual(calculateFees(0, "fixed", "organizer"), {
    platformFee: 0, gatewayFee: 0, totalFees: 0, totalPayable: 0,
  });
});

// ── deriveNetContribution (inverse of contributor-borne fees) ────────────────
test("deriveNetContribution: organizer-borne gross == net", () => {
  assert.equal(deriveNetContribution(5000, "fixed", "organizer"), 5000);
});

test("deriveNetContribution: contributor-borne backs out the fees", () => {
  // gross 5100 (fixed) → net 5000
  assert.equal(deriveNetContribution(5100, "fixed", "contributor"), 5000);
  // gross 10250 (fundraising) → net 10000
  assert.equal(deriveNetContribution(10250, "fundraising", "contributor"), 10000);
});

test("deriveNetContribution: never negative, zero for non-positive gross", () => {
  assert.equal(deriveNetContribution(0, "fixed", "contributor"), 0);
  assert.equal(deriveNetContribution(-100, "fixed", "contributor"), 0);
});

test("round-trip: net → calculateFees.totalPayable → deriveNetContribution == net", () => {
  for (const [amt, type] of [[5000, "fixed"], [10000, "fundraising"], [2500, "tiered"]]) {
    const { totalPayable } = calculateFees(amt, type, "contributor");
    assert.equal(deriveNetContribution(totalPayable, type, "contributor"), amt);
  }
});

// ── Settlement cutoff ────────────────────────────────────────────────────────
test("getSettlementCutoff: is 4:00 AM UTC, today or yesterday", () => {
  const cutoff = getSettlementCutoff();
  assert.equal(cutoff.getUTCHours(), 4);
  assert.equal(cutoff.getUTCMinutes(), 0);
  const now = Date.now();
  assert.ok(cutoff.getTime() <= now, "cutoff is in the past");
  assert.ok(now - cutoff.getTime() < 48 * 3600 * 1000, "cutoff within last 48h");
});

test("isPaymentSettled: strictly before cutoff is settled; at/after is pending", () => {
  const cutoff = getSettlementCutoff();
  assert.equal(isPaymentSettled(new Date(cutoff.getTime() - 1000)), true);
  assert.equal(isPaymentSettled(new Date(cutoff.getTime())), false);
  assert.equal(isPaymentSettled(new Date(cutoff.getTime() + 1000)), false);
});

// ── computeWalletBalances (the projection math) ──────────────────────────────
const beforeCutoff = () => new Date(getSettlementCutoff().getTime() - 3600 * 1000).toISOString();
const afterCutoff = () => new Date(getSettlementCutoff().getTime() + 1000).toISOString();

test("computeWalletBalances: empty → all zero", () => {
  assert.deepEqual(computeWalletBalances([], []), {
    netPayment: 0, grossPayment: 0, pendingBalance: 0,
    availableBalance: 0, ledgerBalance: 0, completedWithdrawals: 0,
  });
});

test("computeWalletBalances: settled contribution is available, not pending", () => {
  const b = computeWalletBalances(
    [{ amount: 5000, gross_amount: 5100, created_at: beforeCutoff() }],
    []
  );
  assert.equal(b.netPayment, 5000);
  assert.equal(b.grossPayment, 5100);
  assert.equal(b.pendingBalance, 0);
  assert.equal(b.availableBalance, 5000);
  assert.equal(b.ledgerBalance, 5000);
});

test("computeWalletBalances: today's contribution is pending, not available", () => {
  const b = computeWalletBalances(
    [{ amount: 3000, gross_amount: 3000, created_at: afterCutoff() }],
    []
  );
  assert.equal(b.netPayment, 3000);
  assert.equal(b.pendingBalance, 3000);
  assert.equal(b.availableBalance, 0);
  assert.equal(b.ledgerBalance, 3000);
});

test("computeWalletBalances: completed withdrawals reduce available only", () => {
  const b = computeWalletBalances(
    [
      { amount: 5000, gross_amount: 5000, created_at: beforeCutoff() },
      { amount: 2000, gross_amount: 2000, created_at: afterCutoff() }, // pending
    ],
    [{ amount: 1000, status: "approved" }]
  );
  assert.equal(b.netPayment, 7000);
  assert.equal(b.pendingBalance, 2000);
  assert.equal(b.completedWithdrawals, 1000);
  assert.equal(b.availableBalance, 4000); // settled 5000 - 1000
  assert.equal(b.ledgerBalance, 6000); // 4000 + 2000
});

test("computeWalletBalances: available floors at 0 (over-withdrawn never negative)", () => {
  const b = computeWalletBalances(
    [{ amount: 1000, gross_amount: 1000, created_at: beforeCutoff() }],
    [{ amount: 5000, status: "completed" }]
  );
  assert.equal(b.availableBalance, 0);
});

test("computeWalletBalances: all legacy completed-status synonyms count as withdrawn", () => {
  for (const status of ["completed", "successful", "success", "approved"]) {
    const b = computeWalletBalances(
      [{ amount: 5000, gross_amount: 5000, created_at: beforeCutoff() }],
      [{ amount: 1000, status }]
    );
    assert.equal(b.completedWithdrawals, 1000, `status=${status}`);
  }
  // pending/processing withdrawals do NOT count
  const b = computeWalletBalances(
    [{ amount: 5000, gross_amount: 5000, created_at: beforeCutoff() }],
    [{ amount: 1000, status: "pending" }]
  );
  assert.equal(b.completedWithdrawals, 0);
  assert.equal(b.availableBalance, 5000);
});

test("computeWalletBalances: gross falls back to amount when gross_amount missing", () => {
  const b = computeWalletBalances(
    [{ amount: 5000, created_at: beforeCutoff() }],
    []
  );
  assert.equal(b.grossPayment, 5000);
});

// ── normalizeContributions ───────────────────────────────────────────────────
test("normalizeContributions: organizer-borne subtracts fees to get net", () => {
  const [row] = normalizeContributions(
    [{ amount: 0, gross_amount: 5000, created_at: beforeCutoff() }],
    "organizer",
    "fixed"
  );
  // fees on 5000 fixed = 100 → net 4900
  assert.equal(row.amount, 4900);
  assert.equal(row.gross_amount, 5000);
});

test("normalizeContributions: contributor-borne derives net from gross", () => {
  const [row] = normalizeContributions(
    [{ amount: 0, gross_amount: 5100, created_at: beforeCutoff() }],
    "contributor",
    "fixed"
  );
  assert.equal(row.amount, 5000);
});

test("normalizeContributions: gross===0 rows pass through untouched", () => {
  const input = [{ amount: 0, gross_amount: 0, created_at: beforeCutoff() }];
  assert.deepEqual(normalizeContributions(input, "organizer", "fixed"), input);
});

// ── End-to-end money invariant ───────────────────────────────────────────────
test("INVARIANT: available + pending == ledger, always", () => {
  const rows = [
    { amount: 5000, gross_amount: 5000, created_at: beforeCutoff() },
    { amount: 1234.56, gross_amount: 1234.56, created_at: afterCutoff() },
    { amount: 999.99, gross_amount: 999.99, created_at: beforeCutoff() },
  ];
  const b = computeWalletBalances(rows, [{ amount: 500, status: "approved" }]);
  assert.equal(roundCurrency(b.availableBalance + b.pendingBalance), b.ledgerBalance);
});
