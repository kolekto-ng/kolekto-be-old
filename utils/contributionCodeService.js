import { supabase } from "./client.js";

/**
 * Single source of truth for minting a contributor unique ID/code.
 *
 * Every successful-payment path (verifyPayment, handleWebhook, and any
 * future contribution-insert path) must call `resolveContributionUniqueCode`
 * instead of re-implementing the gate inline. Before this helper existed,
 * the gate was duplicated in two places in controllers/deposit.js and only
 * checked `collection.code_prefix`, never `collection.unique_id_enabled` —
 * so a collection with the toggle off but a stale/leftover code_prefix value
 * would still mint codes. This helper makes `unique_id_enabled` the
 * authoritative switch, with `code_prefix` (collection-level or per
 * tier/ticket unit) supplying the actual prefix text.
 *
 * Returns null when no code should be assigned (feature disabled, or no
 * prefix configured to build a code from).
 */
export async function resolveContributionUniqueCode({ collectionId, collection, unitPrefix }) {
    if (!shouldGenerateUniqueCode(collection)) return null;

    // Strip internal whitespace too — organizers sometimes type a tier
    // prefix like "VIP 1" (label-style) rather than a code-style "VIP1".
    // This never touches the stored prefix value, only the code built
    // from it.
    const prefix = String(unitPrefix || collection?.code_prefix || "").trim().toUpperCase().replace(/\s+/g, "");
    if (!prefix) return null;

    const nextNumber = await nextContributorCodeNumber(collectionId, prefix);
    return `${prefix}-${nextNumber}`;
}

/**
 * unique_id_enabled is the authoritative switch — but it didn't always
 * exist as a column. Rows created before it was added have it as
 * null/undefined rather than false, and for those legacy rows the only
 * signal that ever existed was "is code_prefix set". Treating null the
 * same as false would silently stop generation for older collections that
 * have real history to preserve — explicit false must still always mean
 * "never generate", per the organizer's actual choice.
 */
export function shouldGenerateUniqueCode(collection) {
    if (collection?.unique_id_enabled === true) return true;
    if (collection?.unique_id_enabled === false) return false;
    return Boolean(collection?.code_prefix);
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
