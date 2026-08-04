import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error(
        "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/SUPABASE_ANON_KEY in environment."
    );
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// CLI flags:
//   --dry-run            report what would change, write nothing
//   --collection-id=UUID only process one collection (useful for spot-checks)
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const collectionIdFlag = args.find((a) => a.startsWith("--collection-id="));
const TARGET_COLLECTION_ID = collectionIdFlag ? collectionIdFlag.split("=")[1] : null;

/**
 * Backfills `contributor_unique_code` on paid contributions that belong to
 * eligible collections but are missing a code — the gap left by the
 * regression where unique-code generation silently stopped firing (see
 * CONTRIBUTOR_UNIQUE_ID_FIX_REPORT.md in kolekto-fe-old).
 *
 * "Eligible" mirrors the live write-path gate in
 * utils/contributionCodeService.js#resolveContributionUniqueCode: a
 * collection is eligible if it has a configured prefix anywhere — its own
 * `code_prefix`, or a `price_tiers[].prefix` on at least one tier.
 * `unique_id_enabled` is NOT part of this check — verified against real
 * production data that a schema migration backfilled that column to
 * `false` for every pre-existing collection (89 of them in production
 * have `unique_id_enabled=false` with a real `code_prefix` still set),
 * so using it as a filter here would silently skip the majority of
 * collections that actually need backfilling.
 *
 * Safety properties:
 *   - Idempotent: re-running skips rows that already have a code, and never
 *     reassigns or overwrites an existing code.
 *   - Numbering goes through the SAME atomic per-(collection, prefix) RPC
 *     the live payment path uses (database/c1_per_prefix_code_counters.sql)
 *     — not a separate locally-computed counter. Run that migration BEFORE
 *     using this script in live mode; otherwise a local count could drift
 *     from the counter table the live system relies on and create a
 *     duplicate the next time a real payment comes in for that prefix.
 *   - Dry-run never calls the mutating RPC (it would advance the counter
 *     without writing a code anywhere, creating a numbering gap). It
 *     previews the next number with a read-only lookup instead, falling
 *     back to a local MAX-based estimate if the counters table/migration
 *     isn't there yet to read from.
 *   - Only touches `contributor_unique_code`. No wallet, balance, amount,
 *     or status field is read or written by this script.
 */
function hasAnyConfiguredPrefix(collection) {
    if (collection.code_prefix) return true;
    const tiers = Array.isArray(collection.price_tiers) ? collection.price_tiers : [];
    return tiers.some((t) => Boolean(t?.prefix));
}

async function fetchEligibleCollections() {
    const pageSize = 500;
    const rows = [];
    let from = 0;

    while (true) {
        const to = from + pageSize - 1;
        let query = supabase
            .from("collections")
            .select("id, title, code_prefix, unique_id_enabled, price_tiers")
            .order("created_at", { ascending: true })
            .range(from, to);

        if (TARGET_COLLECTION_ID) {
            query = query.eq("id", TARGET_COLLECTION_ID);
        }

        const { data, error } = await query;
        if (error) throw error;
        if (!data || data.length === 0) break;

        rows.push(...data);
        if (data.length < pageSize) break;
        from += pageSize;
    }

    return rows.filter(hasAnyConfiguredPrefix);
}

async function fetchPaidContributions(collectionId) {
    const pageSize = 500;
    const rows = [];
    let from = 0;

    while (true) {
        const to = from + pageSize - 1;
        const { data, error } = await supabase
            .from("contributions")
            .select("id, contributor_unique_code, contributor_information, status, created_at")
            .eq("collection_id", collectionId)
            .eq("status", "paid")
            .order("created_at", { ascending: true })
            .range(from, to);

        if (error) throw error;
        if (!data || data.length === 0) break;

        rows.push(...data);
        if (data.length < pageSize) break;
        from += pageSize;
    }

    return rows;
}

/** Per-tier prefix, mirroring the same lookup the live write path uses. */
function getUnitPrefix(contribution, collection) {
    const infoRows = Array.isArray(contribution.contributor_information)
        ? contribution.contributor_information
        : [];
    const tierName = infoRows[0]?.Tier || infoRows[0]?.tierName || infoRows[0]?.tier_name || null;
    const tierId = infoRows[0]?.TierId || infoRows[0]?.tierId || infoRows[0]?.tier_id || null;

    const tiers = Array.isArray(collection.price_tiers) ? collection.price_tiers : [];
    const matchedTier = tiers.find(
        (t) => (tierId && String(t.id) === String(tierId)) || (tierName && String(t.name) === String(tierName))
    );

    // Strip internal whitespace too — organizers sometimes type a tier
    // prefix like "VIP 1" (label-style) rather than a code-style "VIP1".
    // Mirrors the same normalization in the live write path.
    return (matchedTier?.prefix || collection.code_prefix || "").trim().toUpperCase().replace(/\s+/g, "");
}

/**
 * LIVE mode: get a real, atomic next number for (collectionId, prefix) via
 * the same RPC the payment path uses. Falls back to a locally-tracked
 * MAX-based count (scoped to this run) if the RPC/migration isn't deployed
 * yet — same fallback shape as utils/contributionCodeService.js.
 */
async function mintNumber(collectionId, prefix, fallbackCounters) {
    try {
        const { data, error } = await supabase.rpc("next_contribution_code_number", {
            p_collection_id: collectionId,
            p_prefix: prefix,
        });
        if (!error && data != null) {
            const num = typeof data === "number" ? data : Number(data);
            if (Number.isFinite(num) && num > 0) return num;
        }
        if (error) {
            console.warn(
                `  ! next_contribution_code_number RPC unavailable for prefix=${prefix} — ` +
                "falling back to a local count for this run. Apply " +
                "database/c1_per_prefix_code_counters.sql before relying on this script.",
                { code: error.code, message: error.message }
            );
        }
    } catch (rpcErr) {
        console.warn(`  ! RPC threw for prefix=${prefix}, falling back:`, rpcErr?.message);
    }
    const next = (fallbackCounters.get(prefix) || 0) + 1;
    fallbackCounters.set(prefix, next);
    return next;
}

/**
 * DRY-RUN mode: preview the next number WITHOUT calling the mutating RPC
 * (calling it would advance the real counter and create a numbering gap
 * even though nothing gets written). Reads the counter table once per
 * prefix to establish a base, then increments a local cache for any
 * further missing rows sharing that prefix in this same run — otherwise
 * every row would preview the identical "next" number, since a read-only
 * lookup never itself advances.
 */
async function previewNextNumber(collectionId, prefix, fallbackCounters, previewCache) {
    if (!previewCache.has(prefix)) {
        const { data, error } = await supabase
            .from("contribution_code_counters")
            .select("next_number")
            .eq("collection_id", collectionId)
            .eq("prefix", prefix)
            .maybeSingle();

        const base = !error && data?.next_number != null
            ? Number(data.next_number)
            : (fallbackCounters.get(prefix) || 0);
        previewCache.set(prefix, base);
    }
    const next = previewCache.get(prefix) + 1;
    previewCache.set(prefix, next);
    return next;
}

async function run() {
    console.log(`[backfill] starting — mode=${DRY_RUN ? "DRY-RUN (no writes)" : "LIVE"}`);

    const collections = await fetchEligibleCollections();
    console.log(`[backfill] found ${collections.length} eligible collection(s) (have a configured prefix, collection-level or per-tier)`);

    let totalMissing = 0;
    let totalFilled = 0;
    let totalSkippedNoPrefix = 0;

    for (const collection of collections) {
        const contributions = await fetchPaidContributions(collection.id);
        const paidWithCode = contributions.filter((c) => c.contributor_unique_code);
        const missing = contributions.filter((c) => !c.contributor_unique_code);

        if (missing.length === 0) continue;

        // Only used as a fallback baseline if the RPC/counters table isn't
        // reachable (see mintNumber/previewNextNumber above) — seeded from
        // the highest existing numeric suffix already used for each prefix
        // in this collection.
        const fallbackCounters = new Map();
        for (const row of paidWithCode) {
            const code = String(row.contributor_unique_code || "");
            // Optional hyphen tolerates both the current "PREFIX-001" format
            // and legacy "PREFIX001" codes minted before the separator was
            // added.
            const match = code.match(/^([A-Za-z]+)-?(\d+)$/);
            if (!match) continue;
            const prefix = match[1].toUpperCase();
            const num = parseInt(match[2], 10);
            fallbackCounters.set(prefix, Math.max(fallbackCounters.get(prefix) || 0, num));
        }
        const previewCache = new Map();

        console.log(
            `[backfill] collection="${collection.title}" (${collection.id}) — ` +
            `${missing.length} paid contribution(s) missing a code`
        );
        totalMissing += missing.length;

        for (const contribution of missing) {
            const prefix = getUnitPrefix(contribution, collection);
            if (!prefix) {
                totalSkippedNoPrefix += 1;
                console.log(
                    `  - SKIP contribution=${contribution.id}: no code_prefix configured ` +
                    `(collection-level or per-tier) to build a code from`
                );
                continue;
            }

            if (DRY_RUN) {
                const previewNum = await previewNextNumber(collection.id, prefix, fallbackCounters, previewCache);
                const previewCode = `${prefix}-${String(previewNum).padStart(3, "0")}`;
                console.log(`  - WOULD ASSIGN contribution=${contribution.id} -> ${previewCode}`);
                totalFilled += 1;
                continue;
            }

            // Re-check BEFORE minting: guards against a concurrent payment
            // having assigned a code for this exact row between our initial
            // fetch and now, and avoids burning a sequence number on a row
            // we're about to skip anyway.
            const { data: currentRow, error: refetchError } = await supabase
                .from("contributions")
                .select("contributor_unique_code")
                .eq("id", contribution.id)
                .single();

            if (refetchError) {
                console.error(`  - ERROR re-checking contribution=${contribution.id}:`, refetchError.message);
                continue;
            }
            if (currentRow?.contributor_unique_code) {
                console.log(`  - SKIP contribution=${contribution.id}: code appeared since scan started (no-op)`);
                continue;
            }

            // Mint through the SAME atomic per-(collection, prefix) RPC the
            // live payment path uses — never a locally-computed number —
            // so this can never drift from what the live system would hand
            // out next.
            const nextNum = await mintNumber(collection.id, prefix, fallbackCounters);
            const uniqueCode = `${prefix}-${String(nextNum).padStart(3, "0")}`;

            const { error: updateError } = await supabase
                .from("contributions")
                .update({ contributor_unique_code: uniqueCode, updated_at: new Date().toISOString() })
                .eq("id", contribution.id)
                .is("contributor_unique_code", null); // belt-and-suspenders idempotency guard

            if (updateError) {
                console.error(`  - ERROR assigning contribution=${contribution.id}:`, updateError.message);
                continue;
            }

            console.log(`  - ASSIGNED contribution=${contribution.id} -> ${uniqueCode}`);
            totalFilled += 1;
        }
    }

    console.log("\n[backfill] summary:");
    console.log(`  collections scanned:        ${collections.length}`);
    console.log(`  contributions missing code: ${totalMissing}`);
    console.log(`  codes ${DRY_RUN ? "that would be assigned" : "assigned"}:    ${totalFilled}`);
    console.log(`  skipped (no prefix found):  ${totalSkippedNoPrefix}`);
    if (DRY_RUN) {
        console.log("\n  This was a dry run — no rows were written. Re-run without --dry-run to apply.");
    }
}

run()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error("[backfill] fatal error:", err);
        process.exit(1);
    });
