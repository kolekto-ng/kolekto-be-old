// tests/financialAudit.test.js
// PHASE 2.0 GUARDRAILS — the audit helper must be correct AND unbreakable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { auditFinancial, startFinancialAudit, FINANCIAL_EVENTS } from "../utils/financialAudit.js";

function spy() {
  const events = [];
  const rec = (level) => (event, meta) => events.push({ level, event, meta });
  return { events, info: rec("info"), warn: rec("warn"), error: rec("error") };
}

test("emits financial.<event> with normalized fields", () => {
  const s = spy();
  auditFinancial(FINANCIAL_EVENTS.WITHDRAWAL_REQUESTED, {
    requestId: "r1", userId: "u1", collectionId: "c1", withdrawalId: "w1",
    paymentReference: "ref1", amount: 5000, result: "success",
  }, s);
  assert.equal(s.events.length, 1);
  const e = s.events[0];
  assert.equal(e.event, "financial.withdrawal_requested");
  assert.equal(e.level, "info");
  assert.equal(e.meta.payment_reference, "ref1");
  assert.equal(e.meta.collectionId, "c1");
  assert.equal(e.meta.amount, 5000);
});

test("failure result / *_failed event logs at error level", () => {
  const s = spy();
  auditFinancial("payment_verify_failed", { result: "failure" }, s);
  assert.equal(s.events[0].level, "error");
});

test("undefined fields are dropped", () => {
  const s = spy();
  auditFinancial("wallet_refreshed", { collectionId: "c1", userId: undefined }, s);
  assert.equal("userId" in s.events[0].meta, false);
});

test("NEVER throws, even if the logger throws", () => {
  const boom = { info: () => { throw new Error("logger down"); }, warn() {}, error() { throw new Error("x"); } };
  assert.doesNotThrow(() => auditFinancial("payment_verified", { result: "success" }, boom));
  assert.doesNotThrow(() => auditFinancial("payment_verify_failed", { result: "failure" }, boom));
});

test("NEVER throws on malformed input", () => {
  const s = spy();
  assert.doesNotThrow(() => auditFinancial("x", null, s));
  assert.doesNotThrow(() => auditFinancial(undefined, undefined, s));
});

test("startFinancialAudit stamps a numeric duration_ms", () => {
  const s = spy();
  const done = startFinancialAudit("payment_verified", { collectionId: "c1" }, s);
  done({ result: "success" });
  assert.equal(s.events[0].event, "financial.payment_verified");
  assert.equal(typeof s.events[0].meta.duration_ms, "number");
  assert.equal(s.events[0].meta.result, "success");
});
