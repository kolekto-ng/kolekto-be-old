// Re-encrypts payout_accounts.account_number_cipher from the OLD key to the
// CURRENT key, for a safe key rotation. READ-ONLY (dry-run) unless --apply.
//
// Usage:
//   1. Set the NEW key as ACCOUNT_ENCRYPTION_KEY.
//   2. Set the OLD key as ACCOUNT_ENCRYPTION_KEY_PREVIOUS (so old rows decrypt).
//   3. Dry run (no writes):   node scripts/reencryptPayoutAccounts.js
//   4. Apply (writes):        node scripts/reencryptPayoutAccounts.js --apply
//   5. Once all rows report "rewritten/ok", remove ACCOUNT_ENCRYPTION_KEY_PREVIOUS.
//
// Safety:
//   - A row is only rewritten if it currently decrypts (via current OR previous
//     key) AND the re-encrypted value decrypts back to the same plaintext.
//   - Rows that cannot be decrypted with any key are reported and SKIPPED — they
//     are never overwritten, so no readable data is ever lost.
//   - The account number is never printed.

import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import {
    decryptAccountNumber,
    encryptAccountNumber,
    isAccountEncryptionConfigured,
} from "../utils/accountCrypto.js";

dotenv.config();

const APPLY = process.argv.includes("--apply");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error(
        "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/SUPABASE_ANON_KEY."
    );
    process.exit(1);
}
if (!isAccountEncryptionConfigured()) {
    console.error("ACCOUNT_ENCRYPTION_KEY is not set. Aborting.");
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function fetchAll() {
    const pageSize = 500;
    const rows = [];
    let from = 0;
    while (true) {
        const { data, error } = await supabase
            .from("payout_accounts")
            .select("id, account_number_cipher")
            .order("created_at", { ascending: true })
            .range(from, from + pageSize - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        rows.push(...data);
        if (data.length < pageSize) break;
        from += pageSize;
    }
    return rows;
}

async function run() {
    console.log(
        `\nRe-encrypt payout accounts — mode: ${APPLY ? "APPLY (writing)" : "DRY RUN (no writes)"}\n`
    );

    const rows = await fetchAll();
    let ok = 0;
    let rewritten = 0;
    let skippedNoCipher = 0;
    let skippedUnrecoverable = 0;
    let failed = 0;

    for (const row of rows) {
        if (!row.account_number_cipher) {
            skippedNoCipher++;
            continue;
        }
        const plain = decryptAccountNumber(row.account_number_cipher);
        if (!plain) {
            skippedUnrecoverable++;
            console.warn(`SKIP unrecoverable: id=${row.id}`);
            continue;
        }

        // Re-encrypt with the current key and verify the round-trip before writing.
        const newCipher = encryptAccountNumber(plain);
        if (decryptAccountNumber(newCipher) !== plain) {
            failed++;
            console.error(`FAIL verify: id=${row.id}`);
            continue;
        }

        if (!APPLY) {
            ok++;
            continue;
        }

        const { error } = await supabase
            .from("payout_accounts")
            .update({ account_number_cipher: newCipher })
            .eq("id", row.id);
        if (error) {
            failed++;
            console.error(`FAIL write: id=${row.id} ${error.message}`);
        } else {
            rewritten++;
        }
    }

    console.log("\nSummary");
    console.log("=======");
    console.log(`Total rows:            ${rows.length}`);
    console.log(`No cipher (skipped):   ${skippedNoCipher}`);
    console.log(`Unrecoverable (skip):  ${skippedUnrecoverable}`);
    if (APPLY) {
        console.log(`Rewritten:             ${rewritten}`);
    } else {
        console.log(`Would rewrite:         ${ok}`);
    }
    console.log(`Failed:                ${failed}`);
    console.log(
        APPLY
            ? "\nDone. Verify the app, then remove ACCOUNT_ENCRYPTION_KEY_PREVIOUS.\n"
            : "\nDry run complete (no database writes). Re-run with --apply to write.\n"
    );
}

run().catch((err) => {
    console.error("Re-encryption failed:", err?.message || err);
    process.exit(1);
});
