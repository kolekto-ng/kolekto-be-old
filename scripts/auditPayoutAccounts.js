import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
// Use the SAME decryption used by the live withdrawal path so the audit's
// "decryptable" verdict matches what the app will actually be able to read.
import {
  decryptAccountNumber,
  isAccountEncryptionConfigured,
  describeCipherShape,
} from "../utils/accountCrypto.js";

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

function canDecryptAccountNumber(cipherValue) {
  return !!decryptAccountNumber(cipherValue);
}

// CLI flags:
//   --newest=N        only inspect the N most recently created rows
//                      (use this right after adding a test account in
//                      production to see immediately whether it's
//                      decryptable, without touching legacy rows)
//   --account-id=UUID  inspect exactly one row in detail
const args = process.argv.slice(2);
const newestFlag = args.find((a) => a.startsWith("--newest="));
const accountIdFlag = args.find((a) => a.startsWith("--account-id="));
const NEWEST_N = newestFlag ? parseInt(newestFlag.split("=")[1], 10) : null;
const TARGET_ACCOUNT_ID = accountIdFlag ? accountIdFlag.split("=")[1] : null;

async function fetchAllPayoutAccounts() {
  const pageSize = 500;
  const rows = [];
  let from = 0;

  while (true) {
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from("payout_accounts")
      .select(
        "id,user_id,created_at,bank_name,bank_code,account_name,account_last4,recipient_code,account_number_cipher"
      )
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

function printSummary(summary) {
  console.log("\nPayout Account Audit Summary");
  console.log("============================");
  console.log(`Total payout accounts: ${summary.total}`);
  console.log(`With recipient_code: ${summary.withRecipientCode}`);
  console.log(`Without recipient_code: ${summary.withoutRecipientCode}`);
  console.log(`With ciphertext: ${summary.withCipherText}`);
  console.log(`Decryptable ciphertext: ${summary.decryptable}`);
  console.log(`Non-decryptable ciphertext: ${summary.nonDecryptable}`);
  console.log(`High-risk rows (no recipient_code + non-decryptable): ${summary.highRisk}`);
  console.log(`Users with at least one high-risk row: ${summary.impactedUsers}`);
}

function printExamples(label, rows) {
  if (!rows.length) return;
  console.log(`\n${label} (first ${Math.min(rows.length, 20)}):`);
  rows.slice(0, 20).forEach((row) => {
    console.log(
      `- id=${row.id} user_id=${row.user_id} bank=${row.bank_name || "N/A"} last4=${row.account_last4 || "N/A"} created_at=${row.created_at}`
    );
  });
}

async function run() {
  const keyRaw = process.env.ACCOUNT_ENCRYPTION_KEY;
  console.log(
    `ACCOUNT_ENCRYPTION_KEY: ${keyRaw ? `present (length=${keyRaw.length})` : "MISSING"}`
  );
  if (!isAccountEncryptionConfigured()) {
    console.warn(
      "Warning: ACCOUNT_ENCRYPTION_KEY is missing. Decryptability checks will be reported as non-decryptable."
    );
  }

  let rows = await fetchAllPayoutAccounts();

  if (TARGET_ACCOUNT_ID) {
    rows = rows.filter((r) => r.id === TARGET_ACCOUNT_ID);
    if (!rows.length) {
      console.error(`No payout_accounts row found with id=${TARGET_ACCOUNT_ID}`);
      return;
    }
  } else if (NEWEST_N) {
    rows = rows.slice(-NEWEST_N); // fetchAllPayoutAccounts orders created_at ascending
  }

  const annotated = rows.map((row) => {
    const hasCipher = !!row.account_number_cipher;
    const decryptable = hasCipher ? canDecryptAccountNumber(row.account_number_cipher) : false;
    const hasRecipient = !!row.recipient_code;
    const highRisk = !hasRecipient && (!hasCipher || !decryptable);
    // Never includes the cipher bytes or any decrypted value — shape/length only.
    const shapeInfo = hasCipher ? describeCipherShape(row.account_number_cipher) : null;
    return {
      ...row,
      hasCipher,
      decryptable,
      hasRecipient,
      highRisk,
      shapeInfo,
    };
  });

  if (TARGET_ACCOUNT_ID || NEWEST_N) {
    console.log(`\nInspecting ${annotated.length} row(s):`);
    annotated.forEach((row) => {
      console.log(
        `- id=${row.id} user_id=${row.user_id} created_at=${row.created_at} bank=${row.bank_name || "N/A"} last4=${row.account_last4 || "N/A"} decryptable=${row.decryptable} shape=${JSON.stringify(row.shapeInfo)}`
      );
    });
    console.log("\nAudit completed (read-only, no database writes).");
    return;
  }

  const summary = {
    total: annotated.length,
    withRecipientCode: annotated.filter((r) => r.hasRecipient).length,
    withoutRecipientCode: annotated.filter((r) => !r.hasRecipient).length,
    withCipherText: annotated.filter((r) => r.hasCipher).length,
    decryptable: annotated.filter((r) => r.decryptable).length,
    nonDecryptable: annotated.filter((r) => r.hasCipher && !r.decryptable).length,
    highRisk: annotated.filter((r) => r.highRisk).length,
    impactedUsers: new Set(annotated.filter((r) => r.highRisk).map((r) => r.user_id)).size,
  };

  printSummary(summary);

  // Breakdown by storage shape (base64 / bytea-hex / BufferJSON / etc.) — this
  // is the key diagnostic for "is production storing the cipher differently
  // from testing?" without ever printing the cipher value itself.
  const shapeCounts = {};
  annotated.forEach((r) => {
    const shape = r.shapeInfo?.shape || "no-cipher";
    shapeCounts[shape] = shapeCounts[shape] || { total: 0, decryptable: 0 };
    shapeCounts[shape].total += 1;
    if (r.decryptable) shapeCounts[shape].decryptable += 1;
  });
  console.log("\nCipher storage shape breakdown:");
  Object.entries(shapeCounts).forEach(([shape, counts]) => {
    console.log(`- ${shape}: ${counts.total} rows (${counts.decryptable} decryptable)`);
  });

  printExamples(
    "High-risk rows",
    annotated.filter((r) => r.highRisk)
  );
  printExamples(
    "Rows without recipient_code but decryptable",
    annotated.filter((r) => !r.hasRecipient && r.decryptable)
  );

  console.log("\nAudit completed (read-only, no database writes).");
}

run().catch((error) => {
  console.error("Audit failed:", error?.message || error);
  process.exit(1);
});
