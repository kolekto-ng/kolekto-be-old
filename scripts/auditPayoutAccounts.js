import crypto from "crypto";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const ENCRYPTION_KEY = process.env.ACCOUNT_ENCRYPTION_KEY || "";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/SUPABASE_ANON_KEY in environment."
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function toBuffer(cipherValue) {
  if (!cipherValue) return null;
  if (Buffer.isBuffer(cipherValue)) return cipherValue;
  if (cipherValue instanceof Uint8Array) return Buffer.from(cipherValue);
  if (
    typeof cipherValue === "object" &&
    cipherValue.type === "Buffer" &&
    Array.isArray(cipherValue.data)
  ) {
    return Buffer.from(cipherValue.data);
  }
  if (typeof cipherValue === "string") {
    if (cipherValue.startsWith("\\x")) return Buffer.from(cipherValue.slice(2), "hex");
    if (cipherValue.startsWith("0x")) return Buffer.from(cipherValue.slice(2), "hex");
    return Buffer.from(cipherValue, "base64");
  }
  return null;
}

function toKeyBuffer(rawKey) {
  if (!rawKey) return null;
  let keyBuffer = Buffer.from(rawKey);
  if (keyBuffer.length !== 32 && /^[0-9a-fA-F]{64}$/.test(rawKey)) {
    keyBuffer = Buffer.from(rawKey, "hex");
  }
  return keyBuffer.length === 32 ? keyBuffer : null;
}

function canDecryptAccountNumber(cipherValue, keyBuffer) {
  try {
    const encryptedBuffer = toBuffer(cipherValue);
    if (!encryptedBuffer || encryptedBuffer.length <= 16 || !keyBuffer) {
      return false;
    }
    const iv = encryptedBuffer.subarray(0, 16);
    const cipherText = encryptedBuffer.subarray(16);
    const decipher = crypto.createDecipheriv("aes-256-cbc", keyBuffer, iv);
    const decrypted = Buffer.concat([decipher.update(cipherText), decipher.final()]);
    const plain = decrypted.toString("utf8").trim();
    return plain.length > 0;
  } catch {
    return false;
  }
}

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
  const keyBuffer = toKeyBuffer(ENCRYPTION_KEY);
  if (!keyBuffer) {
    console.warn(
      "Warning: ACCOUNT_ENCRYPTION_KEY is missing/invalid length. Decryptability checks will be reported as non-decryptable."
    );
  }

  const rows = await fetchAllPayoutAccounts();
  const annotated = rows.map((row) => {
    const hasCipher = !!row.account_number_cipher;
    const decryptable = hasCipher ? canDecryptAccountNumber(row.account_number_cipher, keyBuffer) : false;
    const hasRecipient = !!row.recipient_code;
    const highRisk = !hasRecipient && (!hasCipher || !decryptable);
    return {
      ...row,
      hasCipher,
      decryptable,
      hasRecipient,
      highRisk,
    };
  });

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
