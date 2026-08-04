import test from "node:test";
import assert from "node:assert/strict";
import { probeSupabaseAccess, PROBE_TABLE } from "../utils/supabaseStartupProbe.js";

/**
 * Minimal mock shaped like the supabase-js query builder: `client.from(table)
 * .select(cols, opts)` resolves to `{ data, error, count }`. Records the call so
 * we can assert correct client/table selection.
 */
function mockClient(resolveValue) {
    const calls = [];
    return {
        calls,
        from(table) {
            return {
                select(cols, opts) {
                    calls.push({ table, cols, opts });
                    return Promise.resolve(resolveValue);
                },
            };
        },
    };
}

// ── Test C — Valid access with zero records → valid empty state ──────────────
test("C: query succeeds with zero rows → ok:true (empty is VALID, not a failure)", async () => {
    const client = mockClient({ error: null, count: 0 });
    const result = await probeSupabaseAccess(client);
    assert.equal(result.ok, true);
    assert.equal(result.rowCount, 0);
});

test("C2: query succeeds with rows present → ok:true", async () => {
    const client = mockClient({ error: null, count: 12 });
    const result = await probeSupabaseAccess(client);
    assert.equal(result.ok, true);
    assert.equal(result.rowCount, 12);
});

// ── Test B — Invalid service-role access → probe fails ───────────────────────
test("B: query returns an RLS/permission error → ok:false, reason service_role_access_unavailable", async () => {
    const client = mockClient({
        error: { message: "permission denied for table pending_payment_context", code: "42501" },
        count: null,
    });
    const result = await probeSupabaseAccess(client);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "service_role_access_unavailable");
    assert.equal(result.code, "42501");
});

test("B2: a thrown transport error → ok:false, reason probe_threw (never silently ok)", async () => {
    const client = {
        from() {
            return { select() { return Promise.reject(new Error("ECONNREFUSED")); } };
        },
    };
    const result = await probeSupabaseAccess(client);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "probe_threw");
});

// ── Test E — Correct client & table selection ────────────────────────────────
test("E: probe targets the service-role-only PROBE_TABLE with a head-only read (no row data)", async () => {
    const client = mockClient({ error: null, count: 0 });
    await probeSupabaseAccess(client);
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].table, PROBE_TABLE);
    assert.equal(PROBE_TABLE, "pending_payment_context");
    // head:true ⇒ no financial row bodies are ever fetched by the probe.
    assert.equal(client.calls[0].opts?.head, true);
    assert.equal(client.calls[0].opts?.count, "exact");
});
