/**
 * kolekto-shared-financial — Financial Projection Engine (FPE)
 *
 * The single, dependency-free, pure-TypeScript source of truth for every
 * monetary computation in Kolekto. Imported by Node (Express) and Deno
 * (Supabase Edge); the Postgres `settlement_recompute_wallets()` function is a
 * mirror held equivalent by the golden-vector conformance suite.
 *
 * Source of truth = paid `contributions` + `withdrawals`. Everything the
 * engine returns (wallet balances, caps, totals) is a PROJECTION of those two
 * immutable streams — never an independent record.
 *
 * Layers:
 *   L0  constants.ts / types.ts  — canonical rates, caps, status sets, shapes
 *   L1  primitives.ts            — roundCurrency, calculateFees, deriveNet,
 *                                  normalize, cutoff, isSettled, allocate
 *   L2  projections.ts           — computeWallet + balances, totals, tiers,
 *                                  withdrawal eligibility
 *
 * The engine contains NO I/O, NO network, NO Supabase client, NO logging, and
 * NO hidden time dependency (time enters only via an injected `now`).
 *
 * See FINANCIAL_ENGINE_API.md for the full public contract.
 */
export { CONSTANTS, COLLECTION_TYPES, COMPLETED_WITHDRAWAL_STATUSES, FEE_BEARERS, GATEWAY_FEE_RATE, MAX_FEE_AMOUNT, ONE_DAY_MS, PENDING_WITHDRAWAL_STATUSES, PLATFORM_FEE_RATE_DEFAULT, PLATFORM_FEE_RATES, SETTLEMENT_HOUR_UTC, } from "./constants.ts";
export type { CollectionTotals, CollectionType, ContributionRow, FeeBearer, FeeBreakdown, TierAvailability, TierInput, WalletBalancesLegacy, WalletProjection, WithdrawalEligibility, WithdrawalRow, } from "./types.ts";
export { allocateAmounts, calculateFees, deriveNetContribution, getSettlementCutoff, isPaymentSettled, normalizeContribution, normalizeContributions, platformFeeRate, roundCurrency, } from "./primitives.ts";
export { buildTierAvailability, computeAvailableBalance, computeCollectionTotals, computeLedgerBalance, computeOrganizerBalance, computePendingBalance, computePendingWithdrawals, computeWallet, computeWalletBalances, computeWithdrawalEligibility, } from "./projections.ts";
