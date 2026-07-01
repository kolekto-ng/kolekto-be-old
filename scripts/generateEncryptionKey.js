// Generates a production-ready ACCOUNT_ENCRYPTION_KEY.
//
//   node scripts/generateEncryptionKey.js
//
// Output is a 64-character hex string = exactly 32 bytes when decoded, which is
// the unambiguous, recommended format for AES-256 (see ACCOUNT_ENCRYPTION_INVESTIGATION.md).
// Hex avoids the whitespace/length ambiguity that a raw passphrase can hit when
// pasted into a hosting dashboard.
//
// Set the printed value as ACCOUNT_ENCRYPTION_KEY in your production environment.
// Do NOT wrap it in quotes and do NOT add a trailing newline.

import crypto from "crypto";

const key = crypto.randomBytes(32).toString("hex");

console.log("\nACCOUNT_ENCRYPTION_KEY (64-char hex, 32 bytes):\n");
console.log(key);
console.log(
    "\nFormat: hex  |  Length: 64 chars / 32 bytes  |  Algorithm: AES-256-CBC"
);
console.log(
    "\nPaste the value EXACTLY (no surrounding quotes, no trailing newline).\n"
);
