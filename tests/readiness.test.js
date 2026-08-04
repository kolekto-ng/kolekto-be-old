import test from "node:test";
import assert from "node:assert/strict";
import { getReadiness, setDependencyStatus, _resetReadiness } from "../utils/readiness.js";

test.beforeEach(() => _resetReadiness());

// ── Test D (system contract) — a dependency FAILURE is never "ready" ─────────
// The whole point: a failed privileged dependency must NOT be laundered into a
// healthy-looking empty state. It surfaces as not-ready (→ /health/ready 503),
// distinguishable from a valid, fully-operational backend.
test("D: a failed dependency makes the process NOT ready", () => {
    setDependencyStatus("supabase", { ok: false, reason: "service_role_access_unavailable" });
    const r = getReadiness();
    assert.equal(r.ready, false);
    assert.equal(r.checks.supabase.ok, false);
    assert.equal(r.checks.supabase.reason, "service_role_access_unavailable");
});

test("before any check has run, the process is NOT ready (fails closed)", () => {
    const r = getReadiness();
    assert.equal(r.ready, false);
});

test("a passing dependency makes the process ready with no leaked reason", () => {
    setDependencyStatus("supabase", { ok: true });
    const r = getReadiness();
    assert.equal(r.ready, true);
    assert.equal(r.checks.supabase.ok, true);
    assert.equal(r.checks.supabase.reason, null);
});

test("readiness is the AND of all dependencies — one failure blocks ready", () => {
    setDependencyStatus("supabase", { ok: true });
    setDependencyStatus("other", { ok: false, reason: "down" });
    assert.equal(getReadiness().ready, false);
});
