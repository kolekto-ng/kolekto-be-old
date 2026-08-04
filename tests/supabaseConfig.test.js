import test from "node:test";
import assert from "node:assert/strict";
import {
    resolveSupabaseConfig,
    assertSupabaseConfig,
    decodeSupabaseKeyRole,
    REQUIRED_VARS,
} from "../utils/supabaseConfig.js";

// Build a syntactically valid Supabase-style JWT carrying the given role claim.
function fakeJwt(role) {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ role })}.sig`;
}

const SERVICE = fakeJwt("service_role");
const ANON = fakeJwt("anon");
const URL = "https://busfgcmbndleljklrcbd.supabase.co";

// ── Test A — Missing service-role key ────────────────────────────────────────
test("A: resolve reports not-ok and lists SUPABASE_SERVICE_ROLE_KEY as missing", () => {
    const cfg = resolveSupabaseConfig({ SUPABASE_URL: URL, SUPABASE_ANON_KEY: ANON });
    assert.equal(cfg.ok, false);
    assert.ok(cfg.missing.includes("SUPABASE_SERVICE_ROLE_KEY"));
});

test("A: assert THROWS a structured error when the service-role key is missing", () => {
    assert.throws(
        () => assertSupabaseConfig({ SUPABASE_URL: URL, SUPABASE_ANON_KEY: ANON }),
        (err) => {
            assert.equal(err.code, "SUPABASE_CONFIG_MISSING");
            assert.ok(err.missing.includes("SUPABASE_SERVICE_ROLE_KEY"));
            // Never leaks a key value; names the safe operation impact instead.
            assert.match(err.message, /service-role/i);
            return true;
        }
    );
});

test("A: missing SUPABASE_URL is also fatal", () => {
    assert.throws(() => assertSupabaseConfig({ SUPABASE_SERVICE_ROLE_KEY: SERVICE }));
});

// ── The exact incident — anon key in the service-role slot ───────────────────
test("anon key pasted into the service-role slot is rejected (role != service_role)", () => {
    const cfg = resolveSupabaseConfig({ SUPABASE_URL: URL, SUPABASE_SERVICE_ROLE_KEY: ANON });
    assert.equal(cfg.ok, false);
    assert.equal(cfg.serviceKeyRole, "anon");
    assert.ok(cfg.errors.some((e) => /role="anon"/.test(e)));
    assert.throws(() => assertSupabaseConfig({ SUPABASE_URL: URL, SUPABASE_SERVICE_ROLE_KEY: ANON }));
});

test("decodeSupabaseKeyRole reads the role claim, tolerates non-JWT keys", () => {
    assert.equal(decodeSupabaseKeyRole(SERVICE), "service_role");
    assert.equal(decodeSupabaseKeyRole(ANON), "anon");
    assert.equal(decodeSupabaseKeyRole("sb_secret_notajwt"), null); // new key format
    assert.equal(decodeSupabaseKeyRole(""), null);
    assert.equal(decodeSupabaseKeyRole(null), null);
});

// ── Valid configuration ──────────────────────────────────────────────────────
test("a correct service-role config resolves ok and does not throw", () => {
    const cfg = resolveSupabaseConfig({
        SUPABASE_URL: URL,
        SUPABASE_SERVICE_ROLE_KEY: SERVICE,
        SUPABASE_ANON_KEY: ANON,
    });
    assert.equal(cfg.ok, true);
    assert.equal(cfg.serviceKeyRole, "service_role");
    assert.equal(cfg.missing.length, 0);
    assert.doesNotThrow(() =>
        assertSupabaseConfig({ SUPABASE_URL: URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE })
    );
});

test("REQUIRED_VARS names both hard requirements", () => {
    assert.deepEqual([...REQUIRED_VARS].sort(), ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_URL"]);
});
