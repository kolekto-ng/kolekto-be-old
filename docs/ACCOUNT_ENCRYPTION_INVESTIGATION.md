# ACCOUNT_ENCRYPTION_KEY — Production Investigation

_Investigated: 2026-06-22 · Focus: why bank-account add + withdrawals fail in production but work in testing._

## 1. Root cause

Bank account numbers are encrypted at rest in `payout_accounts.account_number_cipher`
using **AES-256-CBC**, with the key derived from the `ACCOUNT_ENCRYPTION_KEY`
environment variable. The algorithm and code are correct — the failure is **a
production environment-variable problem**, not a code bug.

The key-derivation logic accepts the env value in three forms:

```
exactly 32 bytes (UTF-8)  → used directly as the AES-256 key
64-char hex string        → decoded to 32 bytes
anything else (passphrase)→ SHA-256(value) → 32 bytes
```

The **testing** key is `kolektoprojectghazaliandabdullah` — *exactly* 32 ASCII
characters, so it is used as **raw key bytes** and everything works.

In **production**, the same logical secret resolves to **different key bytes**,
so:

- **New bank account** → encryption either throws (key missing) or writes
  ciphertext that nothing else can read.
- **Withdrawal** → the saved cipher can't be decrypted → the user hits the
  "this account is from an older format / encryption error" path.

The reason production differs is one (or more) of these — all confirmed plausible
against the code and all now handled:

| # | Production condition | Effect before fix |
|---|----------------------|-------------------|
| 1 | `ACCOUNT_ENCRYPTION_KEY` **missing** on the prod server | `encryptAccountNumber` throws → "encryption unavailable"; decrypt returns null → withdrawal blocked |
| 2 | Value pasted **with surrounding quotes** (`"kolekto…"`) | 34 bytes → not 32 → falls to **SHA-256 branch** → different key than testing |
| 3 | Value has a **trailing newline / CR / space** (common in dashboards & Windows) | 33 bytes → SHA-256 branch → different key |
| 4 | Production set to a **genuinely different value** than testing | Different key → existing rows (encrypted with the testing key) unreadable |
| 5 | Env var **not loaded** (process started without `dotenv`/dashboard var) | Same as #1 |

The single underlying fragility: **the raw env value was fed into key derivation
without sanitising**, and a value that is *exactly* 32 bytes locally silently
changes derivation branch the moment any whitespace/quote is introduced.

## 2. Expected key format & length

| Property | Value |
|----------|-------|
| Algorithm | AES-256-CBC |
| Effective key size | **32 bytes** |
| **Recommended format** | **64-character hex string** (decodes to exactly 32 bytes) |
| Also accepted | exactly 32-byte UTF-8 string; or any passphrase (widened via SHA-256) |
| IV | 16 random bytes, prepended to ciphertext |
| Stored form | base64 of `iv‖ciphertext` |

**Use hex.** A 64-char hex value is unambiguous: it can't accidentally become a
"32-byte raw" vs "SHA-256 passphrase" depending on a stray space. Avoid relying
on a 32-char passphrase in production for exactly that reason.

## 3. Generate a secure production key

```
node scripts/generateEncryptionKey.js
# or equivalently:
openssl rand -hex 32
```

Produces a 64-char hex string, e.g.:

```
385f2b04bbb77aefb89b12f5d92c7058879bcf53c775e52eba8eb33d1c7d2a34
```

Set it in production **exactly** (no surrounding quotes, no trailing newline):

```
ACCOUNT_ENCRYPTION_KEY=385f2b04bbb77aefb89b12f5d92c7058879bcf53c775e52eba8eb33d1c7d2a34
```

Verified: this hex key encrypts and decrypts bank-account data round-trip
(see Testing results below).

> **Important decision point:** generating a *new* key only applies cleanly if
> production has **no existing decryptable bank records** (e.g. pre-launch). If
> production already holds bank accounts encrypted with the current key, do
> **not** swap to a brand-new key without the rotation in §4 — you would make
> those records unreadable.

## 4. Safe migration handling

The code now makes both recovery and rotation safe.

### Detection
```
npm run audit:payout-accounts
```
Read-only. Reports total rows, decryptable vs non-decryptable, and "high-risk"
rows. (This audit now uses the *same* decryption as the live app, so its verdict
is accurate — it previously mis-flagged passphrase-key rows.)

### Strategy A — production just has the wrong/missing key (most likely)
The existing rows were encrypted with the testing key. **Set production's
`ACCOUNT_ENCRYPTION_KEY` to the exact same value as testing**, cleaned of quotes
/ whitespace. Nothing else needed — the new sanitisation + fallback decrypt
recover everything, including rows written when the key had a stray newline.
**No data migration, no re-encryption.**

### Strategy B — rotate to the new strong key without data loss
Driven by a new env var, `ACCOUNT_ENCRYPTION_KEY_PREVIOUS`:

1. Set `ACCOUNT_ENCRYPTION_KEY` = **new** hex key.
2. Set `ACCOUNT_ENCRYPTION_KEY_PREVIOUS` = **old** key.
   - Reads try the new key first, then the old key → existing rows keep working.
   - Writes always use the new key.
3. (Optional but recommended) migrate all rows to the new key:
   ```
   npm run encryption:reencrypt            # dry run, no writes
   npm run encryption:reencrypt -- --apply # re-encrypt rows to the new key
   ```
   Each row is only rewritten if it decrypts *and* the new ciphertext verifies
   back to the same value; unrecoverable rows are skipped, never overwritten.
4. Once the re-encrypt reports all rows rewritten, **remove
   `ACCOUNT_ENCRYPTION_KEY_PREVIOUS`**.

### Strategy C — genuinely unrecoverable rows (lost/rotated key, no backup)
These cannot be decrypted by design. The affected user should **remove the bank
account and add it again** — the UI now shows that exact instruction. Re-adding
writes a fresh record with the current key. Never attempt to rewrite a row you
cannot first decrypt.

## 5. What was fixed (code)

- **`utils/accountCrypto.js` (new)** — single source of truth for key derivation,
  encryption, decryption. Sanitises the raw key (strips surrounding quotes /
  whitespace / newlines) so the *same secret always derives the same key*.
  Tolerant multi-key decryption tries the canonical key first, then
  un-sanitised/trimmed variants **and any `ACCOUNT_ENCRYPTION_KEY_PREVIOUS`
  keys**, so existing records never become unreadable across a key change. New
  writes always use the single canonical key. Never logs key material.
- **`controllers/settings/profile.js`** — bank add uses the shared `encryptAccountNumber`.
- **`controllers/withdrawal.js`** — withdrawal uses the shared `decryptAccountNumber`.
- **`scripts/auditPayoutAccounts.js`** — uses the shared decrypt (fixes false "non-decryptable").
- **`scripts/generateEncryptionKey.js` (new)** — secure key generator.
- **`scripts/reencryptPayoutAccounts.js` (new)** — safe, verify-before-write rotation migration.
- **`app.js`** — boot-time config check: logs a clear `❌`/`⚠️`/`✅` line for the
  encryption key. Misconfiguration is surfaced **in the logs, never in the user UI**.
- **`kolekto-fe-old/src/utils/errorMessages.ts`** — encryption/config errors map
  to clean, actionable user messages instead of raw technical text.
- **`.env.example` / `package.json`** — documented the var and added npm scripts.

## 6. Files inspected

**Backend (`kolekto-be-old`)**
- `controllers/settings/profile.js` — `saveAccount` (bank create/update + encrypt)
- `controllers/withdrawal.js` — `requestWithdrawal` (decrypt saved account)
- `controllers/settings/kyc.js` — separate NIN/BVN encryption (see follow-up)
- `controllers/settings/security.js` — uses the key only as an OTP-pepper fallback (unrelated)
- `controllers/deposit.js` — no account-number crypto
- `scripts/auditPayoutAccounts.js`
- `app.js`, `.env`, `.env.example`, `package.json`

**Frontend (`kolekto-fe-old`)**
- `src/components/profile/BankDetailsSection.tsx` — add-bank UI + save call
- `src/components/withdrawals/WithdrawFundsDialog.tsx`, `src/store/useWithdrawalStore.ts`
- `src/utils/errorMessages.ts`

## 7. Production environment requirements

| Variable | Required | Format | Notes |
|----------|----------|--------|-------|
| `ACCOUNT_ENCRYPTION_KEY` | **Yes** | 64-char hex (recommended) | 32 bytes. Identical across all envs sharing the DB. No quotes/newline. |
| `ACCOUNT_ENCRYPTION_KEY_PREVIOUS` | Only during rotation | old key value | Lets old records decrypt while migrating; comma-separated list supported. Remove after `reencrypt --apply`. |

Loading: the backend loads env via `import "dotenv/config"` in `app.js`. On a
PaaS (Render/Railway/Vercel/etc.) set the variable in the dashboard rather than a
committed `.env`. Confirm at boot via the new log line `✅ Account encryption key configured`.

## 8. Testing results

Automated crypto verification (run against `utils/accountCrypto.js`):

| Test | Result |
|------|--------|
| Round-trip with current 32-char testing key | ✅ PASS |
| Round-trip with generated 64-char **hex** production key | ✅ PASS |
| Legacy key contaminated with trailing newline → record still decrypts (fallback) | ✅ PASS |
| Legacy `{type:"Buffer",data:[...]}` ciphertext shape decrypts | ✅ PASS |
| Rotation: old record decrypts via `ACCOUNT_ENCRYPTION_KEY_PREVIOUS` | ✅ PASS |
| Rotation: new record decrypts under new key | ✅ PASS |
| Rotation: new record NOT readable by old key alone (confirms new key in use) | ✅ PASS |
| Missing key → `isAccountEncryptionConfigured()` false, decrypt returns null, encrypt throws cleanly | ✅ PASS |
| Backend controllers import cleanly | ✅ PASS |
| `scripts/generateEncryptionKey.js` runs, outputs valid 64-char hex | ✅ PASS |
| New/changed scripts pass `node --check` | ✅ PASS |
| Frontend `npm run build` | ✅ PASS |

### Manual end-to-end checklist (run in production after setting the key)
1. **Boot** — log shows `✅ Account encryption key configured`.
2. **Add bank account** — Profile → Bank → verify → save → `Bank account saved`;
   `account_number_cipher` is base64, `account_last4` correct.
3. **Edit/re-add** — re-saving the same account updates the existing row (no duplicate).
4. **Withdrawal request** — submit against a saved account → `pending` row with the
   correctly **decrypted** number in `destination_account.accountNumber`.
5. **Withdrawal processing** — admin approve/process flow reads the same readable
   destination details; no encryption error.
6. **Negative** — unset the key in a staging box → boot logs `❌`, and the bank-add
   UI shows the friendly "temporarily unavailable" message (no raw error, no
   sensitive data logged).

## 9. Confirmation

With `ACCOUNT_ENCRYPTION_KEY` set correctly in production (same value as testing
for Strategy A, or new hex key + rotation for Strategy B), bank account creation,
editing, and withdrawal request/processing all encrypt and decrypt reliably.
Existing records are preserved via the sanitisation + previous-key fallback;
genuinely unrecoverable records have a clear in-app remediation. The root cause
was the production env var (missing / quoted / whitespace / different value), now
both fixed and made resilient.

## 9a. Production data finding — withdrawal "older format" error (resolved)

After the key was set, **adding** a bank account worked but **withdrawal** still
showed *"This saved bank account is from an older format and can no longer be
decrypted…"*. Audited the live `payout_accounts` table (read-only): **5 of 6 rows
decrypted; 1 did not** — a Wema Bank account (`****2344`, created 2026-06-09)
belonging to the user testing withdrawals. That one row was what the withdrawal
hit.

**It was not a key mismatch — it was a storage double-encoding.** The row was
written while `account_number_cipher` was a `bytea` column, so the base64 cipher
*string* was stored as raw bytes and PostgREST returned it as
`\x<hex-of-the-base64-string>`. Decoding therefore needs **three** layers:
`\x` → hex-decode → a base64 string → base64-decode → the real `iv‖ciphertext`.
The decrypt path stopped one layer short, so the value looked unrecoverable even
though the **current key decrypts it perfectly** (verified: recovered last-4 `2344`
matches the stored `account_last4`).

**Fix:** `decryptAccountNumber` (in `utils/accountCrypto.js`) now also tries the
`\x → hex → utf8 → base64-decode` interpretation. Re-audit result:
**6 of 6 rows decryptable, 0 non-decryptable.** The withdrawal that was failing
now succeeds with no data change.

This affects any account saved while the column was `bytea`. No migration is
required (the decrypt tolerates the shape), but running
`npm run encryption:reencrypt -- --apply` will normalise all rows to the clean
base64 form if desired.

## 10. Known follow-up (out of scope)

`controllers/settings/kyc.js` encrypts **NIN/BVN** in separate columns (never
cross-decrypted with bank data) and still has two inline `sha256(KEY)` blocks
inconsistent with its own helper. It does not affect bank/withdrawal flows, but
should be migrated to `utils/accountCrypto.js` in a follow-up for the same
robustness.
