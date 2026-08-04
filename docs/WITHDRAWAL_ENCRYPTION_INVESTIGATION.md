# Withdrawal Decryption Investigation

## TL;DR

**The encryption was never actually broken.** Saving (`profile.js`) and withdrawal
(`withdrawal.js`) used the same `ACCOUNT_ENCRYPTION_KEY`, the same key-derivation
rule, and the same AES-256-CBC + base64 cipher format. A freshly saved account was
always decryptable.

The real bug: **withdrawal was reading the wrong saved account.** The bank
settings page has no working "delete" feature and never promotes a newly added
account to default, so a user with one legacy/corrupted `payout_accounts` row
(`is_default = true`, undecryptable) could add a brand-new, perfectly valid
account and it would silently sit there as a *non*-default row. The withdrawal
form always auto-selects `is_default` first, so it kept sending the old broken
account's id and kept hitting the "older format" error — even after the new
account was added and saving "worked".

## Files inspected

- `controllers/settings/profile.js` — `saveAccount`, `getAccounts`, `setDefaultAccount` (bank account save/list/default controller)
- `controllers/withdrawal.js` — `requestWithdrawal` (decrypts `account_number_cipher` when given `payout_account_id`)
- `controllers/settings/kyc.js` — separate NIN encryption (unrelated to bank accounts, uses the same env var but a different cipher format — not touched)
- `controllers/settings/security.js` — password OTP (unrelated, only references `ACCOUNT_ENCRYPTION_KEY` as an OTP pepper fallback)
- `scripts/auditPayoutAccounts.js` — read-only audit script that already classified legacy ciphertext shapes
- `routes/settings/profile.js` — route wiring
- Frontend: `src/components/profile/BankDetailsSection.tsx`, `src/components/withdrawals/WithdrawForm.tsx`, `src/store/useSettings.ts`

## Answers to the investigation questions

**1. Same `ACCOUNT_ENCRYPTION_KEY` for save and decrypt?**
Yes. Both controllers read `process.env.ACCOUNT_ENCRYPTION_KEY` and derived the
key with byte-for-byte identical logic (32-byte raw string used directly /
64-hex decoded / anything else SHA-256'd to 32 bytes). The current production
value is a 32-character raw passphrase (confirmed via `.env`, length = 32), so it
was used directly as the AES key — consistently, on both sides.

**2. Different encryption vs decryption method?**
No. Save used AES-256-CBC, `Buffer.concat([iv, ciphertext]).toString('base64')`.
Withdrawal's decrypt reversed exactly that: base64-decode, split first 16 bytes
as IV, AES-256-CBC-decrypt the rest. They matched.

**3. Was withdrawal reading the wrong saved account record? — YES, this is the root cause.**
- `saveAccount` only sets `is_default = true` when `existingAccounts.length === 0`
  (i.e. only the very first account a user ever creates). Any account added
  afterward is inserted with `is_default = false`.
- The frontend `WithdrawForm.tsx` auto-selected the withdrawal account with
  `payoutAccounts.find(acc => acc.is_default) || payoutAccounts[0]` — it always
  preferred `is_default`.
- There is **no UI path that calls `setDefaultAccount`** (the store
  `useSettings.ts` never wrapped that endpoint), and **no delete endpoint
  existed at all** — the trash icon in `BankDetailsSection.tsx` set a
  `deleteConfirm` state but no confirmation dialog or API call was ever wired up.
- Net effect: a user with one broken legacy default account had no way to fix
  it (can't delete it, can't promote the new one) and withdrawal kept silently
  targeting the broken row.

**4. Is `account_number_cipher` stored in a legacy Postgres `bytea`/`\x...` format?**
For some historical rows, yes. An earlier version of the encrypt function
returned a raw Node `Buffer`, which Supabase-JS serialized as JSON
(`{"type":"Buffer","data":[...]}`) before that fix — and if the column was
`bytea`, PostgREST hex-encoded that JSON text, producing `\x7b2274...` values.
`withdrawal.js` already had fallback decoding for all of these shapes
(base64 / `\x` hex / raw Buffer / Buffer-JSON / hex-encoded Buffer-JSON), and
that logic is preserved (now centralized, see below). Current saves always
write clean base64 and are unaffected by this legacy shape.

**5. Root cause classification:**
Not a key mismatch. Not an encryption-method mismatch. Not a column-type
issue for new rows. It is **(a)** pre-existing legacy rows with genuinely
unrecoverable ciphertext from the old Buffer-serialization bug, combined with
**(b)** a default-account/UI bug that kept routing withdrawal to those legacy
rows even after a valid replacement account was saved, with **(c)** no way for
the user to delete the broken row themselves.

**6. Would generating a new `ACCOUNT_ENCRYPTION_KEY` fix it?**
No — and it would make things worse. Rotating the key would mean **every**
existing payout account (including the ones that decrypt fine today) becomes
undecryptable, because decryption depends on using the exact key that was
active at encryption time. There is no transparent key-rotation/re-encryption
step in this codebase. Generating a new key is only safe if you are certain
there are zero real saved accounts you need to preserve (e.g. fresh/staging
environment) — in production, where users already have valid saved accounts,
rotating the key turns a partial problem into a 100% problem.

If a key rotation is ever genuinely needed in production, it must be done via
a migration that decrypts every row with the old key and re-encrypts with the
new key, not just a `.env` swap.

## Key format

The app accepts either a 32-byte raw passphrase or a 64-character hex string
(decoded to 32 bytes); anything else is hashed with SHA-256 to derive 32 bytes.
The current production value is a 32-character raw string, used directly.
**Recommended production format:** a 64-character hex string generated with

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

This avoids any ambiguity about character encoding/length and is the
unambiguous "32 random bytes" representation. (Switching the *current* key's
format would itself be a rotation — see above — so only do this together with
a deliberate re-encryption migration, not as a casual swap.)

## What was fixed

### Backend

1. **`utils/accountEncryption.js` (new)** — single shared module exporting
   `encryptAccountNumber`, `decryptAccountNumber`, `getAccountEncryptionKey`,
   and `isAccountCipherDecryptable`. `controllers/settings/profile.js`,
   `controllers/withdrawal.js`, and `scripts/auditPayoutAccounts.js` all now
   import from here instead of each keeping its own copy — removes the risk of
   the two copies silently drifting apart in the future. All legacy-format
   fallback decoding (bytea hex, Buffer-JSON, hex-encoded Buffer-JSON) is
   preserved unchanged in this shared module.

2. **`controllers/settings/profile.js` — `saveAccount` self-heals the default.**
   When saving (inserting or repairing) an account, if the user's current
   default account is undecryptable with today's key, the saved/repaired
   account is automatically promoted to default (and the old default is
   cleared). This means simply adding a working replacement account now fixes
   withdrawal immediately, with no extra manual step.

3. **`controllers/settings/profile.js` — `getAccounts` now returns
   `is_decryptable` per account** (boolean only — never the cipher or
   plaintext), so the frontend can avoid offering a broken account at all.

4. **`controllers/settings/profile.js` — new `deletePayoutAccount` controller**,
   wired at `DELETE /settings/profile/payout-accounts/:id` (ownership-checked
   via `req.user.id`, same pattern as `setDefaultAccount`). If the deleted
   account was the default, the most-recently-created remaining decryptable
   account is promoted to default. This closes the gap where the withdrawal
   error message told users to "delete it in your bank settings" but no
   delete capability existed anywhere.

5. **`controllers/withdrawal.js`** — now imports `decryptAccountNumber` from
   the shared util (no behavior change to decryption itself) and logs which
   `payout_account_id` was successfully resolved on success
   (`[withdrawal] resolved payout account`, id + user id only — never the
   account number or cipher). The existing "unrecoverable cipher" error log
   and friendly 409 response (`PAYOUT_LEGACY_UNRECOVERABLE`) are unchanged.

No wallet balance, collection balance, dashboard total, payment, or withdrawal
amount logic was touched.

### Frontend

1. **`src/store/useSettings.ts`** — added `setDefaultPayoutAccount` and
   `deletePayoutAccount` actions (previously the backend `setDefaultAccount`
   endpoint existed but nothing in the frontend ever called it).
2. **`src/components/profile/BankDetailsSection.tsx`** — the trash-icon button
   now actually opens a confirmation dialog and calls `deletePayoutAccount`.
   Accounts with `is_decryptable === false` show a "Needs re-adding" badge
   instead of "Verified".
3. **`src/components/withdrawals/WithdrawForm.tsx`** — auto-selection now
   prefers a *decryptable* default over a blindly-default one; broken accounts
   are disabled in the dropdown and flagged "Needs re-adding"; submitting with
   a broken account shows a clear inline error instead of a generic backend
   failure.

## How to test on production

1. Add a bank account in Settings → Bank Accounts. Confirm it appears with a
   "Verified" badge (not "Needs re-adding").
2. Open the withdrawal dialog — the new account should be selectable (and
   auto-selected if it's the only usable one) and should not be disabled.
3. Submit a withdrawal request using that account; confirm it succeeds (no
   `PAYOUT_LEGACY_UNRECOVERABLE` error) and check the backend logs for
   `[withdrawal] resolved payout account` with the matching account id.
4. For any user with a pre-existing legacy account: confirm it now shows
   "Needs re-adding" in Bank Accounts; use the new trash icon to delete it (no
   more dead UI), then add the account again — it should become the default
   automatically with no manual default-setting required.
5. Run `node scripts/auditPayoutAccounts.js` against production env vars to
   get the current count of high-risk (non-decryptable, no recipient code)
   rows — useful for sizing how many users are still affected before this
   ships.
6. Confirm wallet `available_balance`, `pending_balance`, collection totals,
   and dashboard numbers are unchanged before/after a test withdrawal — only
   the bank-account selection/decryption path was touched.
