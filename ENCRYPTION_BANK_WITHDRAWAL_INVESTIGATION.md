# Encryption — Bank Account & Withdrawal Investigation

_Investigated: 2026-06-22_

## Summary

Users saw an "encryption error" when **adding a bank account** (Profile → Bank
section) and when **requesting a withdrawal**. Bank account numbers are stored
encrypted at rest (`payout_accounts.account_number_cipher`, AES-256-CBC) and the
key is derived from the `ACCOUNT_ENCRYPTION_KEY` environment variable.

The encryption itself is sound. The failure was caused by **four independent,
copy-pasted copies of the key-derivation + cipher logic that could disagree**,
combined with **no sanitisation of the raw key value**, so the *same secret*
could resolve to *different key bytes* across environments — meaning data
encrypted by one path/environment could not be decrypted by another.

## Root cause

The AES key was derived in four separate places, each with subtle differences:

| File | Helper | Behaviour |
|------|--------|-----------|
| `controllers/settings/profile.js` | `getEncryptionKeyBuffer()` (encrypt) | raw-32 / hex-64 / SHA-256 |
| `controllers/withdrawal.js` | `getAccountEncryptionKey()` (decrypt) | raw-32 / hex-64 / SHA-256 |
| `controllers/settings/kyc.js` | `getKeyBuffer()` + **two inline `sha256(KEY)` blocks** | inconsistent with itself |
| `scripts/auditPayoutAccounts.js` | `toKeyBuffer()` | raw-32 / hex-64 only — **no SHA-256 fallback** |

Two concrete defects fell out of this:

1. **No key sanitisation.** The raw env value was fed straight into key
   derivation. The current key (`kolektoprojectghazaliandabdullah`) is *exactly*
   32 ASCII bytes, so locally it is used as raw AES-256 key bytes and everything
   works. But hosting dashboards / `.env` parsers / copy-paste frequently add
   **surrounding quotes or a trailing newline / carriage-return / space**. That
   makes the value 33+ bytes, which silently falls through to the **SHA-256
   branch** — a *completely different key*. Result:
   - Data encrypted in one environment cannot be decrypted in another.
   - If the env var's formatting ever changed, previously-saved accounts could
     no longer be decrypted → withdrawal returned the "older format / can no
     longer be decrypted" error.

2. **Audit script under-reported.** `auditPayoutAccounts.js` had no SHA-256
   fallback, so for any passphrase-style key it reported **every** row as
   non-decryptable, masking the real state of the data.

Two cosmetic-but-real UX defects on top:

3. The backend's "Server misconfiguration: account encryption unavailable"
   message was passed through to the user **raw** by the frontend.

4. The actionable "remove this bank and re-add it" message for unrecoverable
   legacy rows was **longer than 140 chars**, so the frontend's
   `toFriendlyErrorMessage` truncated it to a generic "try again" — the user
   never learned what to actually do.

## The fix

### New single source of truth — `utils/accountCrypto.js`

One module now owns key derivation, encryption, and decryption, so the encrypt
and decrypt sides can never drift again. Key properties:

- **`sanitizeRawKey()`** strips surrounding quotes and leading/trailing
  whitespace/newlines before deriving the key, so the *same secret* always
  derives the *same key* regardless of how the env var was pasted.
- **Tolerant, multi-key decryption.** `decryptAccountNumber()` tries the
  canonical (sanitised) key **first**, then the un-sanitised / trimmed-only
  variants as fallbacks. This means **ciphertext written before the fix (e.g.
  with a newline baked into the key) is still recovered**, while all *new* data
  is written with the canonical key. It also accepts every historical ciphertext
  shape (base64, `\x`/`0x` hex, raw Buffer, `{type:"Buffer",data:[...]}` JSON,
  and hex-encoded JSON). It **never throws** — returns `null` when unrecoverable.
- **`encryptAccountNumber()`** always writes base64 `iv||ciphertext` with the
  canonical key.
- **`getAccountEncryptionStatus()`** returns a *safe* (no key material) status
  object for startup logging / health checks.

### Wiring

- `controllers/settings/profile.js` (bank add) → imports `encryptAccountNumber`.
- `controllers/withdrawal.js` (withdrawal) → imports `decryptAccountNumber`.
- `scripts/auditPayoutAccounts.js` → uses the shared `decryptAccountNumber`, so
  its "decryptable" verdict now matches what the live app can actually read.
- `app.js` → logs a clear status line at boot (`verifyAccountEncryptionConfig`):
  errors loudly **in the logs** if the key is missing, warns if it had
  quotes/whitespace or is weak. The user UI never sees this.

### Frontend (`kolekto-fe-old/src/utils/errorMessages.ts`)

- "older format / can no longer be decrypted / unrecoverable" → a clean,
  actionable message: *"This saved bank account can't be used anymore. Please
  remove it in your bank settings and add it again, then try the withdrawal."*
  (placed before the generic bank/withdrawal mappings so it is not swallowed).
- "account encryption / encryption unavailable / misconfiguration" → a clean
  *"Bank features are temporarily unavailable…"* message, so the raw technical
  string is never shown.

### Security — unchanged / preserved

- AES-256-CBC at rest, random IV per record, key never logged.
- Encryption was **not** removed or weakened; the key is derived identically,
  just sanitised consistently. The multi-key decrypt fallback only ever *reads*
  existing data — new writes always use the single canonical key.

## Files inspected

**Backend (`kolekto-be-old`)**
- `controllers/settings/profile.js` — bank account create/update (`saveAccount`)
- `controllers/withdrawal.js` — `requestWithdrawal`, decryption usage
- `controllers/settings/kyc.js` — NIN/BVN encryption (separate data; noted, see below)
- `controllers/settings/security.js` — only uses the key as an OTP-pepper fallback (unrelated)
- `controllers/deposit.js` — no account-number crypto
- `scripts/auditPayoutAccounts.js` — audit tool
- `app.js` — server bootstrap
- `.env` / `.env.example` — env config

**Frontend (`kolekto-fe-old`)**
- `src/components/profile/BankDetailsSection.tsx` — add-bank UI
- `src/components/withdrawals/WithdrawFundsDialog.tsx` — withdrawal UI
- `src/store/useWithdrawalStore.ts` — `createWithdrawal`
- `src/utils/errorMessages.ts` — user-facing error mapping

## Files changed

- **Added** `utils/accountCrypto.js`
- `controllers/settings/profile.js` — use shared `encryptAccountNumber`
- `controllers/withdrawal.js` — use shared `decryptAccountNumber`
- `scripts/auditPayoutAccounts.js` — use shared decrypt (fixes false "non-decryptable")
- `app.js` — startup encryption-config check (logs only)
- `kolekto-fe-old/src/utils/errorMessages.ts` — clean, actionable error mapping

## Required environment variables

| Variable | Required | Notes |
|----------|----------|-------|
| `ACCOUNT_ENCRYPTION_KEY` | **Yes** | The secret used to encrypt bank account numbers. Accepts: a 32-byte raw string, a 64-char hex string, or any passphrase (widened via SHA-256). **Must be byte-for-byte identical in every environment that shares the same database.** Do **not** wrap it in quotes or leave a trailing newline in the hosting dashboard — the code now sanitises these, but keeping the raw value clean avoids relying on the fallback. |

Current local value is a 32-char passphrase (used directly as raw key bytes).
**Production must use the exact same value** as whatever encrypted the existing
`payout_accounts` rows, or those rows will be unrecoverable.

## How to test — bank account setup

1. Ensure `ACCOUNT_ENCRYPTION_KEY` is set; start the backend. Boot log should
   show `✅ Account encryption key configured`.
2. Frontend → Profile → Bank Accounts → **Add Account**.
3. Select a bank, enter a valid 10-digit number, **Verify Account** (name
   resolves), then **Save Account**.
4. Expect: `Bank account saved` toast; the account appears with masked last-4.
5. DB check: `payout_accounts.account_number_cipher` is a base64 string and
   `account_last4` matches the entered number.

## How to test — withdrawal request

1. Have a collection with a withdrawable balance and a saved bank account.
2. Dashboard → Withdraw → pick collection → choose the saved account → submit.
3. Expect: `Withdrawal request sent` toast; a `pending` row in `withdrawals`
   whose `destination_account.accountNumber` is the correct **decrypted** number.
4. No "encryption"/"older format" error.

## Negative tests

- **Invalid bank data:** wrong/short number → clean "Unable to verify that bank
  account." (no raw technical text).
- **Missing key:** unset `ACCOUNT_ENCRYPTION_KEY`, restart → boot log shows the
  red `❌ ACCOUNT_ENCRYPTION_KEY is NOT set…`. Adding a bank returns the
  friendly "Bank features are temporarily unavailable…" message (UI), while the
  server logs the real cause. No sensitive data logged.
- **Legacy unrecoverable row:** a row encrypted with a genuinely different key
  → withdrawal shows the actionable "remove it and add it again" message.

## Migration / cleanup for old encrypted records

1. **Audit first (read-only, no writes):**
   ```
   npm run audit:payout-accounts
   ```
   Reports total rows, how many are decryptable vs not, and "high-risk" rows
   (no `recipient_code` **and** non-decryptable). With the shared-decrypt fix
   this now reflects reality (passphrase keys are no longer mis-flagged).

2. **If the audit shows non-decryptable rows:**
   - First confirm `ACCOUNT_ENCRYPTION_KEY` in the audited environment matches
     the key those rows were encrypted with. A key mismatch is the usual cause —
     fixing the env var recovers the rows with no data change (the fallback
     decrypt + sanitisation handle quote/newline drift automatically).
   - Genuinely unrecoverable rows (encrypted under a lost/rotated key) cannot be
     decrypted by design. These users should **remove the affected bank account
     and re-add it** — the UI now tells them exactly this. Re-adding writes a
     fresh record with the current canonical key.
   - No bulk DB rewrite is required or recommended; do **not** attempt to
     re-encrypt rows you cannot first decrypt.

## Known follow-up (out of scope, noted)

`controllers/settings/kyc.js` encrypts **NIN/BVN** (separate columns, never
cross-decrypted with bank data) and still contains two inline `sha256(KEY)`
blocks that are inconsistent with its own top-level `getKeyBuffer()`. This does
not affect bank-account/withdrawal flows but should be aligned to the shared
util in a follow-up for the same robustness.

## Verification performed

- `utils/accountCrypto.js` unit checks: clean round-trip, legacy newline-key
  fallback decrypt, legacy `{type:"Buffer"}` JSON shape, missing-key behaviour —
  all pass.
- Backend controllers import cleanly.
- Frontend `npm run build` succeeds.
