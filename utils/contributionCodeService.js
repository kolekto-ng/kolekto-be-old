import { supabase } from "./client.js";

/**
 * Single source of truth for minting a contributor unique ID/code.
 *
 * Every successful-payment path (verifyPayment, handleWebhook, and any
 * future contribution-insert path) must call `resolveContributionUniqueCode`
 * instead of re-implementing the gate inline.
 *
 * Round 4 correction (verified against real production data): a schema
 * migration added `unique_id_enabled` with `NOT NULL DEFAULT false`, which
 * backfilled EVERY pre-existing collection to `false` — including ones
 * that already had a real `code_prefix` and had been generating codes
 * successfully for months under the old (prefix-only) logic. In
 * production this affects 89 collections (vs. only 12 genuinely `true`).
 * Treating `false` as a hard block — what an earlier pass here did —
 * silently broke generation for the large majority of working
 * collections, with zero effect on new ones (the current collection UI
 * always clears `code_prefix` when the toggle is off, so for anything
 * saved through it, "a prefix is configured" and "the toggle is on" are
 * the same fact). So: a configured prefix is what drives generation;
 * `unique_id_enabled` is read for display only, never as a gate.
 *
 * Returns null when no code should be assigned (no prefix configured to
 * build a code from, collection-level or on the specific unit/tier).
 */
export async function resolveContributionUniqueCode({ collectionId, collection, unitPrefix }) {
    // Strip internal whitespace too — organizers sometimes type a tier
    // prefix like "VIP 1" (label-style) rather than a code-style "VIP1".
    // This never touches the stored prefix value, only the code built
    // from it.
    const prefix = String(unitPrefix || collection?.code_prefix || "").trim().toUpperCase().replace(/\s+/g, "");
    if (!prefix) return null;

    const nextNumber = await nextContributorCodeNumber(collectionId, prefix);
    return `${prefix}-${nextNumber}`;
}

/** Display-only — whether to show a "unique code" section/label. Not a generation gate (see above). */
export function shouldGenerateUniqueCode(collection) {
    if (collection?.code_prefix) return true;
    const tiers = Array.isArray(collection?.price_tiers) ? collection.price_tiers : [];
    return tiers.some((t) => Boolean(t?.prefix));
}

/**
 * C-1: Mint the next contributor unique code atomically, per (collection,
 * prefix) — NOT just per collection, because collections can have multiple
 * independent prefixes (one per pricing tier / ticket tier).
 *
 * Primary path: call the Postgres RPC `next_contribution_code_number`
 * (see database/c1_per_prefix_code_counters.sql). The RPC is a single
 * INSERT ... ON CONFLICT DO UPDATE ... RETURNING statement, which Postgres
 * serialises automatically — two concurrent calls for the same
 * (collection, prefix) cannot produce the same number.
 *
 * Fallback path (RPC not yet deployed): use MAX(numeric_suffix)+1 instead
 * of COUNT(*)+1. This is still racy under concurrent writes but far less
 * likely to collide than a plain count, and it lets the code ship before
 * the SQL migration is run. A clear console.warn is logged when the
 * fallback fires so ops can see the migration hasn't been applied.
 *
 * Returns: padded numeric string (e.g. "001", "042", "1234"). The caller
 * prefixes it with the resolved code prefix.
 */
export async function nextContributorCodeNumber(collectionId, codePrefix) {
    // Primary: atomic RPC, keyed by (collection, prefix)
    try {
        const { data, error } = await supabase
            .rpc("next_contribution_code_number", { p_collection_id: collectionId, p_prefix: codePrefix });
        if (!error && data != null) {
            const num = typeof data === "number" ? data : Number(data);
            if (Number.isFinite(num) && num > 0) {
                return String(num).padStart(3, "0");
            }
        }
        if (error) {
            console.warn(
                "[nextContributorCodeNumber] RPC not available — falling back to MAX+1. " +
                "Apply database/c1_per_prefix_code_counters.sql to remove this fallback.",
                { code: error.code, message: error.message }
            );
        }
    } catch (rpcErr) {
        console.warn(
            "[nextContributorCodeNumber] RPC threw — falling back to MAX+1:",
            rpcErr?.message
        );
    }

    // Fallback: derive the next number from the largest existing suffix that
    // matches this collection's code_prefix. Still racy under concurrent
    // writes but better than COUNT(*)+1, and ONLY runs if the RPC is missing.
    try {
        const { data: rows } = await supabase
            .from("contributions")
            .select("contributor_unique_code")
            .eq("collection_id", collectionId)
            .not("contributor_unique_code", "is", null);
        let maxNum = 0;
        const prefix = String(codePrefix || "");
        for (const r of rows || []) {
            const code = String(r.contributor_unique_code || "");
            const tail = prefix && code.startsWith(prefix) ? code.slice(prefix.length) : code;
            // Strip the "PREFIX-001" separator before parsing — without this,
            // slicing the prefix off "FASSA-001" leaves "-001", and
            // parseInt("-001", 10) is -1, which would corrupt the running max.
            const n = parseInt(tail.replace(/^-/, ""), 10);
            if (Number.isFinite(n) && n > maxNum) maxNum = n;
        }
        return String(maxNum + 1).padStart(3, "0");
    } catch (fallbackErr) {
        console.error(
            "[nextContributorCodeNumber] both RPC and fallback failed:",
            fallbackErr?.message
        );
        // Last resort: timestamp-based so we still produce a unique-looking
        // code rather than skipping the field entirely.
        return String(Date.now() % 100000).padStart(5, "0");
    }
}
