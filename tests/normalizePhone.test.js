import test from "node:test";
import assert from "node:assert/strict";
import { normalizePhone } from "../utils/normalizePhone.js";

test("null / empty / non-numeric → null", () => {
  assert.equal(normalizePhone(null), null);
  assert.equal(normalizePhone(undefined), null);
  assert.equal(normalizePhone(""), null);
  assert.equal(normalizePhone("   "), null);
  assert.equal(normalizePhone("abc"), null);
});

test("strips formatting, keeps digits", () => {
  assert.equal(normalizePhone("0803 123 4567"), "08031234567");
  assert.equal(normalizePhone("(080) 3123-4567"), "08031234567");
});

test("preserves exactly one leading + for international numbers", () => {
  assert.equal(normalizePhone("+234 803 123 4567"), "+2348031234567");
  assert.equal(normalizePhone("+234-803-123-4567"), "+2348031234567");
});

test("a legitimately normalized number always fits in varchar(20)", () => {
  assert.ok((normalizePhone("+234 803 123 4567") || "").length <= 20);
  assert.ok((normalizePhone("0803 123 4567") || "").length <= 20);
  // E.164 maximum: 15 digits + '+'
  assert.ok((normalizePhone("+123456789012345") || "").length <= 20);
});

test("overlong / garbage input is capped so the insert can never overflow", () => {
  // The prod failure shape: a 22-char contact phone that overflowed varchar(20).
  const out = normalizePhone("+234 (0) 803-123-4567-8901");
  assert.ok(out.length <= 20, `expected <= 20, got ${out.length}: ${out}`);

  const digitsOnly = normalizePhone("23480312345672348031234567"); // 26 digits
  assert.equal(digitsOnly.length, 20);
});

test("idempotent on already-normalized values", () => {
  const once = normalizePhone("+2348031234567");
  assert.equal(normalizePhone(once), once);
});
