# Kolekto Backend (`kolekto-be-old`) — Engineering Rules

Node 22 **ESM** Express API. This service is the **single write authority** for all financial data in Kolekto. Full reference: `../kolekto-fe-old/KOLEKTO_ENGINEERING_STANDARDS.md`.

## Architecture (enforced)

```
Route (thin) → Controller (thin) → Service (business rules) → Repository (DB only) → Supabase
```

- **Controllers** validate request *shape*, call **one** service method, shape the response, `next(err)`. No business rules, no DB calls.
- **Services** (`services/`) own all business rules & validation, coordinate repositories, wrap money moves in a transaction, emit domain events. Never touch `req`/`res`.
- **Repositories** (`repositories/`) are the **only** place `supabase.from()` / Sequelize writes run. No business rules.
- A service may call another service; it must **never** touch another domain's tables/repository directly.

## The write-authority rule

- All financial writes (`collections`, `contributions`, `transactions`, `withdrawals`, wallet/balance columns, `payment_config`, `kyc_*`, `campaigns`) happen **here**, through a service → repository.
- Supabase **Edge Functions do not own financial writes** — they are edge-read / scheduled only. Migrate or retire any that write.
- Crons invoke a **service method** — never re-implement settlement in parallel.

## Domain ownership

Collections → `CollectionService` · Contributions → `ContributionService` · Payments → `PaymentService` · Wallets → `WalletService` (sole balance mutator) · Withdrawals → `WithdrawalService` · Profiles → `ProfileService` · KYC → `KycService` · Notifications → `NotificationService` · fees → `PricingService` (single fee source of truth).

## Phase 1 constraints (do not violate)

- **No breaking API changes. No behavior changes.** Backwards compatibility is mandatory.
- **No `workspace_id`, roles, permissions, or Workspace tables** — that is Phase 2.
- `user_id` ownership semantics stay exactly as today.
- Refactor **one domain at a time**; write characterization tests capturing current behavior *before* changing it.
- Real auth path is `utils/verifyToken.js` (local HS256 + remote fallback). `middleware/authMiddleware.js` was dead and has been removed.
- Diagnostics live in `scripts/`; historical incident write-ups live in `docs/`. Delete dead code, don't comment it out.
- Keep the `KNOWN_PROJECT_ENVIRONMENTS` startup guard green; never point tests at the prod Supabase project.

## Conventions

- Name files for their domain. (`deposit.js` currently owns payments — being split into `PaymentService`/`WalletService`/`ContributionService`.) No `.jsx` backend controllers.
- Financial amounts are `DECIMAL` — never floats.
- Webhook routes need the **raw body** (mounted before `express.json()` in `app.js`) for HMAC verification — preserve this.
