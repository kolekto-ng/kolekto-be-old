# Payout Encryption, Duplicate Recipient Code, and Local Collection Loading — Investigation & Fix

## TL;DR

Three separate, unrelated root causes, none of them a key mismatch:

1. **Payout decryption ("needs re-adding" on every new account):** the
   `account_number_cipher` Postgres column is `bytea`. When the backend sends
   a base64 *string* (the ciphertext) through Supabase-js, Postgres stores
   the **literal ASCII bytes of that string** rather than decoding it from
   base64 first. So every save round-trips into corrupted storage — not just
   legacy rows. **Proven empirically below**, not just inferred. Fixed by
   teaching the decrypt function to recognise and reverse this exact
   corruption. **A new `ACCOUNT_ENCRYPTION_KEY` would not have fixed this**
   (confirmed — see "Would a new key help?" below) and was correctly not
   attempted.
2. **Duplicate `recipient_code` on re-add:** `saveAccount`'s "is this the
   same account already saved?" check matched on `account_name` text, which
   can drift between verification calls. When it missed, the code fell
   through to an `INSERT`, and if Paystack returned a `recipient_code` that
   already existed on another row, Postgres's unique constraint rejected it
   with a raw DB error. Fixed by matching via decrypt-and-compare (the real
   account number) first, with the unique-violation now caught and turned
   into a clean message either way.
3. **Local Collection page / Overview not loading:** `CollectionDetailsPage`,
   `CollectionsPage`, etc. query Supabase **directly** (not through the
   backend API) for `collections`/`wallets`/`contributions`. That direct
   client is configured from `VITE_SUPABASE_URL`/`VITE_SUPABASE_PUBLISHABLE_KEY`,
   which point at a *different* Supabase project than the one the local
   backend actually uses. Login (which goes through the backend) mints a
   session for the backend's project; mirroring that session onto the
   frontend's own client for a different project silently fails RLS, so
   direct queries return nothing. Fixed with a local-only env override.
4. **Bonus catch, unrelated to the above but live and broken right now:**
   the committed (but gitignored, so not visible in `git status`) frontend
   `.env` had `VITE_API_URL` hand-edited to `http://localhost:3000/api`,
   with the production URL commented out above it. Since `.env` (unlike
   `.env.development.local`) applies to **every** Vite mode including
   production, this would have shipped a production build pointing at
   `localhost`. Reverted.

## A. Payout account encryption — proof, not inference

### What I checked
- `controllers/settings/profile.js` `saveAccount` → `encryptAccountNumber` (encrypt)
- `controllers/settings/profile.js` `getAccounts` → `isAccountCipherDecryptable` (decryptability flag)
- `controllers/withdrawal.js` `requestWithdrawal` → `decryptAccountNumber` (decrypt for payout)
- `scripts/auditPayoutAccounts.js` (read-only audit tool)

All four already imported from the single shared module
`utils/accountEncryption.js` (consolidated in the prior session) — **no
duplicate encryption/decryption implementations remain**. Confirmed by
grepping the whole backend for `createCipheriv`/`createDecipheriv`: every
hit is inside `accountEncryption.js`. `controllers/settings/kyc.js` has its
own AES routine, but that's for NIN, a completely separate field — not part
of this bug.

### Environment loading
- `ACCOUNT_ENCRYPTION_KEY` is present in `kolekto-be-old/.env`, 32
  characters, used directly as the AES-256 key (not hashed/hex-decoded).
- **Added startup logging** (`app.js`, right after `app.listen`):
  ```
  [startup] ACCOUNT_ENCRYPTION_KEY: present (length=32)
  ```
  Logs presence + length only, never the value. Verified locally:
  ```
  Server Running on port 3000
  [startup] ACCOUNT_ENCRYPTION_KEY: present (length=32)
  ```
  **Action for you:** after deploying this, run `pm2 restart kolekto-be
  --update-env` (plain `pm2 restart` does **not** reload `.env` — it keeps
  whatever environment PM2 captured when the process was first started or
  last given `--update-env`) and check `pm2 logs kolekto-be --lines 50` for
  this line. If the length differs from your local `.env`'s key length, *that*
  — a genuinely different key value, not a different encoding format — would
  be a real key mismatch. Compare lengths; never compare values in a log.

### Storage format — proven with a real round-trip test
I ran a direct test against the live `payout_accounts` table (the project
configured in `kolekto-be-old/.env`, service-role key, immediately deleted
afterward — no data left behind):

1. Encrypted a test value with the **current, unmodified** `encryptAccountNumber()`. Result: a 44-character base64 string.
2. Inserted it into `account_number_cipher` exactly as `saveAccount` does.
3. Read it straight back via `supabase.from("payout_accounts").select(...)`.

**Result:**
```
Encrypted (sent to Supabase): JTTQ7TiEjoss5oX... (base64, length=44)
Raw value read back: \x4a54... (90-char string = "\x" + 88 hex chars = 44 decoded bytes)
```
44 decoded bytes is exactly the length of the base64 *string* we sent — not
the 32 raw binary bytes (16-byte IV + 16-byte ciphertext) that string
decodes to. `0x4a, 0x54` = ASCII `'J'`, `'T'` — literally the first two
characters of the base64 string we sent. **Postgres stored the text's bytes,
not the bytes the text represents.** This is a well-known `bytea`-via-PostgREST
footgun: a JS string handed to a `bytea` column is written as raw
one-byte-per-character content unless it's already in Postgres's `\x`-hex
literal form.

This reproduces on **every single insert**, deterministically — which is
exactly why the user's report was "**all** newly added accounts," not just
old ones. It is not a key problem, not a Paystack problem, not an
intermittent/legacy-data problem.

I also confirmed all 5 pre-existing rows in this database are legacy
`{"type":"Buffer","data":[...]}`-shaped (from an even older bug, predating
this investigation entirely) — none of them exercised the current
`encryptAccountNumber` format, so they didn't actually prove anything about
the current code path on their own. The isolated round-trip test above is
what proves it.

### The fix
`utils/accountEncryption.js`: `decryptAccountNumber` now tries multiple
candidate interpretations of the stored value (previously it only tried one
or two and gave up). The new candidate that fixes this specific corruption:
when the value is `\x`-prefixed bytea-hex, hex-decode it, then check whether
the decoded bytes — read as UTF-8 text — look like a base64 string; if so,
base64-decode *that* to recover the real 32-byte `iv||ciphertext`. Verified
with a unit test covering: normal base64 string, the exact corruption above,
genuine binary bytea, and a wrong-key-must-fail case — all four passed.
Also re-ran the live round-trip test with the fix in place: the freshly
inserted+read-back row now decrypts correctly and `is_decryptable: true`.

This is a **read-side** fix — it doesn't change what gets written (still a
clean base64 string from `encryptAccountNumber`, unchanged), it just makes
the *read* path robust to how Postgres actually stored it. No need to
migrate existing rows written through the current code path; they'll just
start decrypting correctly the moment this ships.

### Would a new `ACCOUNT_ENCRYPTION_KEY` help?
**No — and you were right not to rotate it before proving the cause.** The
proof above shows the *exact bytes never reached AES* in a form that could
ever decrypt, regardless of which key was used — the stored value isn't a
valid ciphertext at all under the *intended* binary interpretation; it's a
container holding the right bytes in the wrong place. Rotating the key:
- would **not** fix anything, because the bug is at the storage/encoding
  layer, before the key is ever used to decrypt.
- **would actively break** any row that genuinely is correctly decryptable
  today (the 5 legacy rows in this DB, for instance) — those use whatever
  key encrypted them; a new key can never decrypt old ciphertext, full stop.

Key format reminder: the app accepts a 32-byte raw string (used directly,
which is what's configured now) or a 64-char hex string (decoded to 32
bytes); anything else is SHA-256'd to 32 bytes. If a rotation is ever
genuinely needed for unrelated reasons, it requires a migration that decrypts
every row with the old key and re-encrypts with the new one — never a bare
`.env` swap in production.

### Diagnostics added for production use
`scripts/auditPayoutAccounts.js` now prints:
- `ACCOUNT_ENCRYPTION_KEY: present (length=N)` up front.
- A **cipher storage shape breakdown** (`base64`, `bytea-hex(\x)`,
  `BufferJSON`, etc. with per-shape decryptable counts) — run it on
  production after deploying to see the current distribution.
- Two new flags for targeted checks, useful for "add one account, check it
  immediately" (exactly what was asked for):
  ```
  node scripts/auditPayoutAccounts.js --newest=3        # last 3 rows created
  node scripts/auditPayoutAccounts.js --account-id=<uuid>  # one specific row
  ```
  Both print shape + `decryptable` per row, never the cipher value itself.

Run this against production's env (`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`/
`ACCOUNT_ENCRYPTION_KEY` from the EC2 `.env`) — I don't have direct access to
the production database or the EC2 box, so I could only prove this against
the project configured in the local `.env`. Given production almost
certainly runs the same table schema (same `bytea` column type), I expect the
same result, but please confirm with this script before/after deploying.

## B. Duplicate `recipient_code`

### Root cause
`saveAccount`'s repair-vs-insert decision (`controllers/settings/profile.js`)
only matched an existing row by `bank_code` + `account_last4` +
`account_name` (exact string match). If a user's saved `account_name`
differs even slightly from a later Paystack verify response (case,
whitespace), the match misses, the code falls through to `INSERT`, and a
fresh `recipient_code` is requested from Paystack. If that collides with a
`recipient_code` already sitting on another row (the one the match should
have found), Postgres's unique constraint on `recipient_code` rejects the
insert with a raw `23505` error — which is what showed up in the logs as
`duplicate key value violates unique constraint
"user_payout_accounts_recipient_code_key"`. (The constraint's name reflects
an old table name from before a rename — Postgres doesn't rename constraints
when you rename a table — it is the same table as `payout_accounts` today,
not a second hidden table.)

### Delete behavior — already correct
`deletePayoutAccount` was already a **hard delete**
(`.delete().eq("id", account_id).eq("user_id", user_id)`), already
ownership-scoped to `req.user.id`, and already promotes the next decryptable
account to default if the deleted one was the default. No soft-delete, no
leftover row blocking re-adds, in the current code. (If this was still
happening in production, it's because production hadn't been redeployed with
this code yet — see the "What to deploy" section.)

### The fix
`controllers/settings/profile.js` `saveAccount`:
1. **New, more reliable match**: before the name-based fallback, decrypt
   every existing account on the same `bank_code` and compare the *real*
   account number (which we already have in plaintext from the request) —
   exact and unambiguous, immune to name-text drift. Rows whose cipher is
   itself broken (can't be decrypted) simply don't match here, which is
   correct — they fall through to the name-based fallback, which is exactly
   the path that repairs them in place.
2. **Defensive catch**: if the `INSERT` still hits the `recipient_code`
   unique violation (Postgres error `23505`) despite the improved matching,
   it's now caught specifically and returns:
   ```json
   { "error": "This bank account has already been added. You can select it for withdrawal or delete it before adding it again.", "code": "PAYOUT_DUPLICATE_ACCOUNT" }
   ```
   (HTTP 409) instead of a raw database error.
3. `deletePayoutAccount` now returns `"Bank account deleted successfully."`
   on success and `"We couldn't delete this bank account. Please try again."`
   on failure (raw error still logged server-side, never sent to the
   client).

The frontend already surfaces `error.response.data.error` directly in toasts
(`BankDetailsSection.tsx`), so these new message strings show up with no
frontend changes needed.

## C. Local Collection page / Collection Overview not loading

### Root cause
`CollectionDetailsPage.tsx`, `useCollectionStore.ts` (used by
`CollectionsPage.tsx`), and others query Supabase **directly** —
`supabase.from('collections')...`, `.from('wallets')...`,
`.from('contributions')...` — via the client in
`src/integrations/supabase/client.ts`, configured from
`VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY`.

Sign-in itself goes through the backend (`POST /api/auth/signin` in
`useAuthStore.ts`), which mints a session against **whichever Supabase
project the backend is configured for**. `useAuthStore` then calls
`supabase.auth.setSession(...)` to mirror that session onto the frontend's
own direct client, purely so direct `supabase.from(...)` calls are
authenticated too.

The committed `kolekto-fe-old/.env` points `VITE_SUPABASE_URL` at
`busfgcmbndleljklrcbd.supabase.co`. The local backend's `.env` is configured
for a **different** project, `lpeeckqsltxohppheucz.supabase.co`. When
developing locally against the local backend:
- Login succeeds (backend mints a valid token for *its* project).
- The mirror `setSession` call onto the frontend's `busfgcmbndleljklrcbd`-configured
  client effectively does nothing useful — the token isn't valid for that
  project.
- Every subsequent **direct** `supabase.from(...)` call (collections,
  wallets, contributions) goes out with an invalid/foreign token, RLS treats
  it as unauthenticated, and returns zero rows.
- `loadCollection()` does `.single()` on zero rows → Supabase errors
  (`PGRST116`-style "no rows") → caught → `toast.error('Failed to load
  collection')` → page never renders.

This matches "works on production" too: production's frontend
`VITE_SUPABASE_URL` and the deployed backend's `SUPABASE_URL` are presumably
the *same* project (that pairing isn't broken — only the local one is).

### The fix
Extended `kolekto-fe-old/.env.development.local` (gitignored, local-only,
already created in the previous session for `VITE_API_URL`) with the
matching Supabase project for the local backend:
```
VITE_SUPABASE_URL=https://lpeeckqsltxohppheucz.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<the anon key from kolekto-be-old/.env's active SUPABASE_ANON_KEY>
```
This only loads in `vite dev` (development mode); production/staging builds
are unaffected and keep using `.env`'s `busfgcmbndleljklrcbd` project. No
source code changes were needed — `useProfileStore.ts`'s own separate
`createClient(...)` call reads the same two env vars, so it's covered by the
same override automatically.

**I could not fully verify this end-to-end** (would require a real login +
browser session, which this environment doesn't have). To confirm: log in
locally, open DevTools → Network, and check that calls to
`*.supabase.co/rest/v1/collections` etc. return data (not empty arrays /
401s). If still empty, the most likely remaining culprit is RLS policies on
those tables expecting a specific claim shape — but the project-mismatch
above is the one concretely provable from the code as written.

### Bonus: live-broken committed `.env`
While testing the production build to verify no `localhost` leakage, I found
`kolekto-fe-old/.env` (gitignored, so invisible to `git status`/PRs, but the
one your local toolchain actually reads) had been hand-edited:
```diff
- # VITE_API_URL=https://api.kolekto.com.ng/api
- VITE_API_URL=http://localhost:3000/api
+ VITE_API_URL=https://api.kolekto.com.ng/api
```
Unlike `.env.development.local`, plain `.env` applies to **every** Vite
mode, including production. A `npm run build` from this checkout (and
anything deployed from it) would have shipped pointing at `localhost:3000`.
Reverted to the production URL. Verified via `vite.loadEnv("production",
...)` and by grepping the built `dist/assets/*.js` for both strings:
production build now contains `api.kolekto.com.ng` and zero occurrences of
`localhost:3000`.

**If your actual hosting deploy (Vercel/etc.) sources `VITE_API_URL` from its
own dashboard env vars rather than this file**, this particular mistake never
reached real users — but it would silently break any build run from this
checkout, including by anyone testing "does the production build still
work" locally. Worth checking which one your deploy pipeline actually uses.

## Files changed

**Backend (`kolekto-be-old`):**
- `utils/accountEncryption.js` — new bytea-corruption decode fallback (`cipherToBufferCandidates`, tries multiple candidates instead of one); new `describeCipherShape()` diagnostic export (shape/length/decryptable only, never the value).
- `controllers/settings/profile.js` — `saveAccount`: decrypt-compare matching added before the name-based fallback; `INSERT` now catches `recipient_code` unique-violation (`23505`) and returns a clean 409. `deletePayoutAccount`: clean success/failure messages.
- `scripts/auditPayoutAccounts.js` — now uses the shared `describeCipherShape`; prints key length + a per-shape decryptable breakdown; new `--newest=N` / `--account-id=UUID` flags.
- `app.js` — temporary startup log of `ACCOUNT_ENCRYPTION_KEY` presence/length (no value). Remove once the production fix is confirmed.

**Frontend (`kolekto-fe-old`):**
- `.env` — reverted an in-place edit that pointed `VITE_API_URL` at `localhost:3000` for *all* build modes including production.
- `.env.development.local` — added `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` overrides matching the local backend's actual Supabase project (gitignored, dev-mode-only).
- No frontend `.tsx`/`.ts` source changes were needed for A/B/C in this pass — `WithdrawForm.tsx`/`BankDetailsSection.tsx`'s `is_decryptable` handling and the duplicate-message surfacing were already correct from the prior session.

## What to deploy / do on production (EC2 + PM2)

1. Pull this branch onto `/home/ec2-user/kolekto-be` (the encryption-fix
   commit from the prior session plus this one — confirm both are present;
   if production never got the prior session's commit, none of this will be
   live either).
2. `pm2 restart kolekto-be --update-env` — **not** a plain `pm2 restart`.
   Confirm `pm2 logs kolekto-be --lines 20` shows the new
   `[startup] ACCOUNT_ENCRYPTION_KEY: present (length=N)` line with the
   length you expect.
3. Run `node scripts/auditPayoutAccounts.js` on the box (with production
   env) to get the real shape breakdown before telling users anything is
   fixed.
4. Add one real bank account in production, then
   `node scripts/auditPayoutAccounts.js --newest=1` to confirm it shows
   `decryptable: true` immediately.
5. Remove the temporary `app.js` startup log once confirmed (or leave it —
   it's harmless and logs no sensitive data — your call).

## Verification performed in this session

- Unit-style test of `decryptAccountNumber` against: normal base64, the
  exact bytea-corruption shape, genuine binary bytea, and wrong-key —
  4/4 correct.
- Live round-trip insert+read+delete against the real `payout_accounts`
  table (local `.env`'s Supabase project) — proved the corruption exists in
  this schema today, and proved the fix recovers it.
- `node --check` on every changed backend file; backend boots cleanly
  (`node app.js` → port 3000, startup log confirmed).
- `scripts/auditPayoutAccounts.js` runs cleanly end-to-end with the new
  flags and shape breakdown.
- `npm run build` (frontend) succeeds; confirmed via `vite.loadEnv()` that
  dev mode resolves to the local backend/Supabase project and production
  mode resolves to the deployed ones; confirmed via grep on the built
  `dist/assets/*.js` that the production bundle contains the deployed API
  URL and zero `localhost` strings.
- No changes made to wallet balance, collection totals, payment
  verification, dashboard balance, or withdrawal amount logic — confirmed by
  reviewing every diff before committing it conceptually (not yet
  `git commit`'d — left for you to review and commit).
